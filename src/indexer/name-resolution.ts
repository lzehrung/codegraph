/**
 * One lookup order for a bare name at a use site, shared by go-to-definition, references (which
 * verify through go-to-definition), and the detailed call graph.
 *
 * `resolveBareName` is synchronous: it reads parsed files through a {@link ParsedFileProvider}
 * and never awaits. The few steps that need async member lookup return a `deferred` resolution
 * with the answer to use when that lookup finds nothing; {@link settleNameResolution} runs those
 * steps. Navigation settles immediately; the graph settles after its body walk.
 */
import { cTagRole } from "../languages/definitions/c.js";
import { getCallArgumentCount } from "../languages/callable-arity.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import type { FileId } from "../types.js";
import { rustTokenTreeNameFollowsSeparator } from "../util/member-access.js";
import { fileIdentityKey } from "../util/paths.js";
import { nodeInStaticMemberContext } from "../graphs/symbol-graph-detailed/receiver-calls.js";
import {
  AMBIGUOUS_CPP_OVERLOAD_REASON,
  AMBIGUOUS_CPP_USING_DECLARATION_REASON,
  AMBIGUOUS_CPP_USING_DIRECTIVE_REASON,
  AMBIGUOUS_STAR_IMPORT_REASON,
} from "./ambiguous-resolution.js";
import { cppBindingCallableShape } from "./cpp-callables.js";
import {
  cppUsingDeclarationTarget,
  resolveCppCollidingBinding,
  resolveCppUsingDirectiveName,
  resolveVisibleCppCallableName,
} from "./navigation-cpp.js";
import { resolveCppOutOfLineImplicitMember, resolveImplicitSelfMember } from "./navigation-goto.js";
import {
  csharpLookupName,
  findClosestBinding,
  findClosestScopeBinding,
  laterLocalShadowsUse,
  resolveNamedDefinition,
} from "./navigation-local.js";
import { findPhpImportAlias, inferPhpQualifiedReferenceImportType } from "./navigation-php.js";
import { okGoToResult } from "./navigation-provenance.js";
import { csharpAliasQualifiedLookupName } from "./navigation-goto.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import {
  phpClassReferenceMatchesDefinition,
  phpReferenceRoleMatchesKind,
  resolveIndexedPhpClassReference,
  resolvePhpExplicitImport,
  resolvePhpSameScopeRoleDefinition,
} from "./php-namespace-symbols.js";
import type { ScopeIndex } from "./scope.js";
import { scopeNodesFor } from "./scope-nodes.js";
import { typescriptOverloadImplementationAcceptsCount } from "./ts-callables.js";
import { type GoToResult, type ModuleIndex, type ProjectIndex, SymbolKind } from "./types.js";

/** Synchronous access to parsed files. A miss is recorded so an async caller can load and retry. */
export type ParsedFileProvider = {
  get(file: FileId): ParsedFileContext | null;
};

/** A provider that parses on demand between synchronous resolution passes. */
export type LoadingParsedFileProvider = ParsedFileProvider & {
  /** Files requested since the last call, which were not loaded. */
  takeMisses(): FileId[];
  load(files: readonly FileId[]): Promise<void>;
};

export function createLoadingParsedFileProvider(
  index: ProjectIndex,
  current: { file: FileId; parsed: ParsedFileContext },
): LoadingParsedFileProvider {
  const loaded = new Map<string, ParsedFileContext | null>([[fileIdentityKey(current.file), current.parsed]]);
  const misses = new Map<string, FileId>();
  return {
    get(file) {
      const key = fileIdentityKey(file);
      const hit = loaded.get(key);
      if (hit !== undefined) return hit;
      misses.set(key, file);
      return null;
    },
    takeMisses() {
      const files = [...misses.values()];
      misses.clear();
      return files;
    },
    async load(files) {
      for (const file of files) {
        const key = fileIdentityKey(file);
        if (loaded.has(key)) continue;
        try {
          loaded.set(key, await ensureParsedContext(file, index.parsed?.get(key), index.languageExtensions));
        } catch {
          // Reduced mode: a file that cannot be parsed stays unavailable, as before.
          loaded.set(key, null);
        }
      }
    },
  };
}

/** A lookup step that needs async member resolution before its answer is known. */
export type DeferredNameRequest =
  /** Inside an out-of-line C++ member body, a member of the owner hides a file-scope name. */
  | { kind: "cpp-out-of-line-member" }
  /** A member of the enclosing type, found through `this`/`self`. */
  | { kind: "implicit-self-member"; lookupName: string }
  /** Several included C/C++ declarations that may be one callable. */
  | { kind: "c-included-star"; lookupName: string; cNamespace: "tag" | "ordinary" | undefined };

export type NameResolution =
  | GoToResult
  | {
      status: "deferred";
      request: DeferredNameRequest;
      /** The answer when the deferred lookup finds nothing; `null` means no answer. */
      fallback: NameResolution | null;
      /** The answer when the lookup proves a hiding member that is not a valid target. */
      hidden?: GoToResult;
    };

export type BareNameUse = {
  index: ProjectIndex;
  mod: ModuleIndex;
  file: FileId;
  parsed: ParsedFileContext;
  scopeIndex: ScopeIndex;
  files: ParsedFileProvider;
  node: SyntaxNodeLike;
  name: string;
  /** PHP import role at the use, when the caller knows it. */
  phpImportType?: "class" | "function" | "const";
};

/**
 * Resolves a bare (unqualified or C++-qualified) name at a use site. Returns `null` when no
 * lookup step answers; go-to-definition then tries a declaration at the position.
 */
export function resolveBareName(use: BareNameUse): NameResolution | null {
  const { index, mod, file, parsed, scopeIndex, files, node, name } = use;
  const { sup, source, tree } = parsed;
  const loadParsed = (target: string): ParsedFileContext | null => files.get(target);
  // Rust macro arguments stay unparsed token trees. A name preceded by `.` or `::` there is
  // a member or path receiver the raw tokens cannot prove, so bare-name resolution would
  // answer with an unrelated same-named free function; stay conservative instead.
  if (sup.id === "rust" && rustTokenTreeNameFollowsSeparator(node)) {
    return { status: "not_found", reason: "No resolvable receiver inside a Rust macro token tree" };
  }
  const lookupName = sup.id === "csharp" ? csharpLookupName(node, source, name) : name;
  const csharpExportName =
    sup.id === "csharp" ? csharpAliasQualifiedLookupName(node, source, lookupName, mod.imports) : lookupName;
  const phpVariableTypes = sup.id === "php" ? scopeNodesFor(sup.id).assignmentIdentifierTypes : undefined;
  if (phpVariableTypes?.has(node.type) || (node.parent && phpVariableTypes?.has(node.parent.type))) {
    const variable = findClosestBinding(scopeIndex, file, lookupName, node, sup, source, tree);
    if (!variable) return { status: "not_found", reason: "No matching PHP variable definition" };
    return okGoToResult(index, variable, { resolution: "exact", confidence: "high" });
  }

  const phpImportType = use.phpImportType;
  if (sup.id === "php") {
    // A declaration names itself even when an unrelated namespace uses the same spelling.
    const declaration = mod.locals.find(
      (local) => local.range.start.index === node.startIndex && local.range.end.index === node.endIndex,
    );
    if (declaration) return okGoToResult(index, declaration, { resolution: "exact", confidence: "high" });
    const role = phpImportType ?? "const";
    const binding = findPhpImportAlias(mod.imports, name, role);
    const alias = binding ? resolvePhpExplicitImport(index, binding, role) : null;
    if (alias) {
      return okGoToResult(index, alias, {
        via: { importedFrom: alias.file, exportedName: alias.localName },
        resolution: "import",
        confidence: "high",
      });
    }
  }
  // A PHP class-reference form cannot bind a same-named function in the lexical scope.
  const phpClassReference = sup.id === "php" && inferPhpQualifiedReferenceImportType(node) === "class";
  if (phpClassReference) {
    const phpClass = resolveIndexedPhpClassReference(index, source, tree, node, lookupName, mod.imports);
    if (phpClass) {
      return okGoToResult(index, phpClass, {
        via: { exportedName: phpClass.localName },
        resolution: "php-qualified",
        confidence: "high",
      });
    }
    // Some import graphs resolve through scope/export lookup rather than the namespace index.
    // Those fallbacks may only name this exact PHP class, never a same-named function.
  }
  const closestBinding = findClosestScopeBinding(scopeIndex, lookupName, node, sup);
  const usingTarget =
    sup.id === "cpp" && closestBinding ? cppUsingDeclarationTarget(closestBinding, source) : undefined;
  if (usingTarget) {
    const visible = resolveVisibleCppCallableName(index, mod, usingTarget, node, source, loadParsed);
    if (visible) return okGoToResult(index, visible, { resolution: "import", confidence: "high" });
    if (visible === undefined) {
      const target = resolveNamedDefinition(index, mod, file, sup, usingTarget);
      if (target) return target;
    }
    return { status: "not_found", reason: AMBIGUOUS_CPP_USING_DECLARATION_REASON };
  }

  const afterOutOfLineMember = (): NameResolution | null => {
    const cppCollision =
      sup.id === "cpp" && closestBinding ? resolveCppCollidingBinding(file, closestBinding, node, source) : undefined;
    if (cppCollision !== undefined) {
      if (!cppCollision) return { status: "not_found", reason: AMBIGUOUS_CPP_OVERLOAD_REASON };
      return okGoToResult(index, cppCollision, { resolution: "exact", confidence: "high" });
    }
    const local = findClosestBinding(scopeIndex, file, lookupName, node, sup, source, tree);
    if (
      sup.id === "swift" &&
      local &&
      closestBinding &&
      scopeIndex.allScopes[0]?.map.get(closestBinding.canonicalName) === closestBinding
    ) {
      // Method-local bindings still win; only module-level names yield to proven members.
      return {
        status: "deferred",
        request: { kind: "implicit-self-member", lookupName },
        fallback: okGoToResult(index, local, { resolution: "exact", confidence: "high" }),
      };
    }
    if (
      local &&
      phpClassReference &&
      !phpClassReferenceMatchesDefinition(index, source, tree, node, lookupName, mod.imports, local)
    ) {
      return { status: "not_found", reason: "No matching PHP class" };
    }
    if (sup.id === "php" && local && !phpReferenceRoleMatchesKind(node, local.kind)) {
      const sameScope = closestBinding
        ? resolvePhpSameScopeRoleDefinition(index, mod, source, tree, node, lookupName, closestBinding)
        : null;
      if (sameScope) return okGoToResult(index, sameScope, { resolution: "exact", confidence: "high" });
      return { status: "not_found", reason: "No matching PHP symbol role" };
    }
    const staticMemberCall =
      sup.id === "csharp" &&
      !!local &&
      closestBinding?.kind === "function" &&
      closestBinding.node?.parent?.type !== "local_function_statement" &&
      node.parent?.type === "invocation_expression" &&
      nodeInStaticMemberContext(node, source);
    if (staticMemberCall) {
      return {
        status: "deferred",
        request: { kind: "implicit-self-member", lookupName },
        fallback: { status: "not_found", reason: "No matching C# static member definition" },
      };
    }
    if (local) return okGoToResult(index, local, { resolution: "exact", confidence: "high" });
    if (
      (sup.id === "ts" || sup.id === "tsx") &&
      closestBinding?.kind === "function" &&
      node.parent?.type === "call_expression"
    ) {
      return { status: "not_found", reason: "No matching TypeScript overload signature" };
    }
    if (laterLocalShadowsUse(scopeIndex, lookupName, node, sup)) {
      return { status: "not_found", reason: "Local is not in scope before its declaration" };
    }
    if (sup.id === "cpp" && closestBinding?.kind === "function" && cppBindingCallableShape(closestBinding)) {
      return { status: "not_found", reason: AMBIGUOUS_CPP_OVERLOAD_REASON };
    }

    if (sup.id === "cpp") {
      const visible = resolveVisibleCppCallableName(index, mod, name, node, source, loadParsed);
      if (visible !== undefined) {
        if (!visible) return { status: "not_found", reason: AMBIGUOUS_CPP_OVERLOAD_REASON };
        return okGoToResult(index, visible, { resolution: "exact", confidence: "high" });
      }
      const directed = resolveCppUsingDirectiveName(index, mod, name, node, source, loadParsed);
      if (directed !== undefined) {
        if (!directed) return { status: "not_found", reason: AMBIGUOUS_CPP_USING_DIRECTIVE_REASON };
        return okGoToResult(index, directed, { resolution: "import", confidence: "high" });
      }
    }

    if (!sup.supportsCrossModuleSymbols) return null;
    let cNamespace: "tag" | "ordinary" | undefined;
    if (sup.id === "c") cNamespace = cTagRole(node) ? "tag" : "ordinary";
    const resolvedName = resolveNamedDefinition(
      index,
      mod,
      file,
      sup,
      sup.id === "csharp" ? csharpExportName : lookupName,
      cNamespace,
      node.startIndex,
    );
    const afterStarRecovery = (): NameResolution | null => {
      if (sup.id === "swift" || sup.id === "csharp") {
        // Inside a type, a proven member takes precedence over a same-named module name. C#
        // partial members declared in another file reach this path only as invocation callees.
        const memberOnlyName = sup.id === "swift" && resolvedName?.status === "ok" && resolvedName.definition.isMember;
        return {
          status: "deferred",
          request: { kind: "implicit-self-member", lookupName },
          fallback: memberOnlyName
            ? { status: "not_found", reason: "No matching Swift member definition" }
            : resolvedName,
        };
      }
      if (
        phpClassReference &&
        resolvedName?.status === "ok" &&
        !phpClassReferenceMatchesDefinition(index, source, tree, node, lookupName, mod.imports, resolvedName.definition)
      ) {
        return { status: "not_found", reason: "No matching PHP class" };
      }
      if (
        sup.id === "php" &&
        resolvedName?.status === "ok" &&
        !phpReferenceRoleMatchesKind(node, resolvedName.definition.kind)
      ) {
        return { status: "not_found", reason: "No matching PHP symbol role" };
      }
      if (
        (sup.id === "ts" || sup.id === "tsx") &&
        node.parent?.type === "call_expression" &&
        resolvedName?.status === "ok" &&
        resolvedName.definition.kind === SymbolKind.Function
      ) {
        const argumentCount = getCallArgumentCount({ languageId: sup.id, source, call: node.parent });
        const target = resolvedName.definition;
        const targetModule = index.byFile.get(fileIdentityKey(target.file));
        const targetContext = argumentCount !== null && targetModule ? files.get(target.file) : null;
        if (
          targetContext &&
          targetModule &&
          argumentCount !== null &&
          (targetContext.sup.id === "ts" || targetContext.sup.id === "tsx") &&
          !typescriptOverloadImplementationAcceptsCount({
            implementation: target,
            locals: targetModule.locals,
            tree: targetContext.tree,
            source: targetContext.source,
            languageId: targetContext.sup.id,
            argumentCount,
          })
        ) {
          return { status: "not_found", reason: "No matching TypeScript overload signature" };
        }
      }
      if (
        sup.id === "python" &&
        node.parent?.type === "call" &&
        resolvedName?.status === "ok" &&
        resolvedName.provenance?.resolution === "namespace"
      ) {
        // A namespace binding holds a module object, and a module is not callable: the call
        // is an error, not a call to the module's first export.
        return { status: "not_found", reason: "No callable definition for a Python module binding" };
      }
      return resolvedName;
    };
    if (
      (sup.id === "c" || sup.id === "cpp") &&
      resolvedName?.status === "not_found" &&
      resolvedName.reason === AMBIGUOUS_STAR_IMPORT_REASON
    ) {
      return {
        status: "deferred",
        request: { kind: "c-included-star", lookupName, cNamespace },
        fallback: afterStarRecovery(),
      };
    }
    return afterStarRecovery();
  };

  // Inside an out-of-line member definition, a member of the owner class (or its bases) hides a
  // same-named file-scope name; parameters and function locals still win.
  const fileScopeOrUnbound =
    !closestBinding || scopeIndex.allScopes[0]?.map.get(closestBinding.canonicalName) === closestBinding;
  if (sup.id === "cpp" && fileScopeOrUnbound && node.parent?.type === "call_expression") {
    return {
      status: "deferred",
      request: { kind: "cpp-out-of-line-member" },
      fallback: afterOutOfLineMember(),
      hidden: { status: "not_found", reason: "No matching C++ static member definition" },
    };
  }
  return afterOutOfLineMember();
}

/** How a consumer settles deferred steps. */
export type SettleNameOptions = {
  /** The graph records no edge when the hiding member cannot accept the call's argument count. */
  requireAcceptedArity?: boolean;
  /** Resolves included C/C++ star candidates; navigation owns this recovery. */
  recoverIncludedStar?: (lookupName: string, cNamespace: "tag" | "ordinary" | undefined) => Promise<GoToResult | null>;
};

/** Runs the async member steps a {@link resolveBareName} result deferred. */
export async function settleNameResolution(
  use: BareNameUse,
  resolution: NameResolution | null,
  options: SettleNameOptions = {},
): Promise<GoToResult | null> {
  let current = resolution;
  while (current?.status === "deferred") {
    const { request, fallback, hidden } = current;
    const { index, mod, node, name, parsed } = use;
    if (request.kind === "cpp-out-of-line-member") {
      const member = await resolveCppOutOfLineImplicitMember(
        index,
        mod,
        node,
        name,
        parsed.source,
        parsed.sup,
        options.requireAcceptedArity,
      );
      if (member) return okGoToResult(index, member, { resolution: "member-access", confidence: "high" });
      if (member === null) return hidden ?? null;
    } else if (request.kind === "implicit-self-member") {
      const member = await resolveImplicitSelfMember(
        index,
        mod,
        node,
        request.lookupName,
        parsed.source,
        parsed.sup.id,
      );
      if (member) return okGoToResult(index, member, { resolution: "member-access", confidence: "medium" });
    } else {
      const recovered = await options.recoverIncludedStar?.(request.lookupName, request.cNamespace);
      if (recovered) return recovered;
    }
    current = fallback;
  }
  return current;
}
