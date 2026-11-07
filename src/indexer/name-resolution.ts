/**
 * One lookup order for a bare name at a use site, shared by go-to-definition, references (which
 * verify through go-to-definition), and the detailed call graph.
 *
 * `resolveBareName` is synchronous: it reads parsed files through a {@link ParsedFileProvider}
 * and never awaits. The few steps that need async member lookup return a `deferred` resolution
 * with the answer to use when that lookup finds nothing; {@link settleNameResolution} runs those
 * steps. Navigation settles immediately; the graph settles after its body walk.
 */

import type { SyntaxNodeLike } from "../languages/types.js";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import type { FileId } from "../types.js";

import { sliceText } from "../util/ast.js";
import { normalizeKotlinIdentifier } from "../util/identifiers.js";
import {
  collectMemberAccessChain,
  isReceiverNameNode,
  isQualifiedTypeSuffix,
  jvmQualifiedTypeSegments,
  kotlinQualifiedExpression,
} from "../util/member-access.js";
import { fileIdentityKey } from "../util/paths.js";
import {
  isAmbiguousResolutionReason,
  AMBIGUOUS_CSHARP_ALIAS_MEMBER_REASON,
  UNPROVEN_CSHARP_ALIAS_MEMBER_REASON,
  UNRESOLVED_QUALIFIED_TYPE_REASON,
} from "./ambiguous-resolution.js";
import { getPackageDeclarationName } from "./compilation-units.js";
import { isJvmPackageSymbolVisible } from "./declaration-visibility.js";
import { isJvmTypeWildcardMember } from "./expand-star-imports.js";
import { declaresMembers } from "../graphs/symbol-graph-detailed/receiver-calls.js";

import {
  csharpAliasMemberLookup,
  memberAcceptsCallAt,
  resolveCppOutOfLineImplicitMember,
  resolveImplicitSelfMember,
  resolveJvmPackageSymbol,
} from "./navigation-goto.js";
import {
  definitionForBinding,
  findClosestScopeBinding,
  laterLocalShadowsUse,
  resolveNamedDefinition,
} from "./navigation-local.js";

import { okGoToResult } from "./navigation-provenance.js";

import type { ParsedFileContext } from "./parse-context.js";
import { ensureParsedContextForIndex, rethrowStaleQuerySource } from "./parsed-cache.js";

import { nameLookupPolicyFor } from "./name-lookup-policies/index.js";
import type {
  BareNameUse,
  JvmTypeNameResolver,
  LoadingParsedFileProvider,
  NameLookupState,
  NameResolution,
} from "./name-resolution-types.js";

export type {
  BareNameUse,
  DeferredNameRequest,
  LoadingParsedFileProvider,
  NameLookupPolicy,
  NameLookupState,
  NameResolution,
  ParsedFileProvider,
} from "./name-resolution-types.js";

import { type GoToResult, type ImportBinding, type ModuleIndex, type ProjectIndex, type SymbolDef } from "./types.js";
import { fileBindingIsUnshadowed } from "./scope.js";

import { importBindingReferenceSites } from "./navigation-references.js";

import { rangeContains } from "./reference-context.js";

/** PHP import role (class, function, or const) of the import that covers a 0-based position. */
export function phpImportTypeAtPosition(
  imports: readonly ImportBinding[],
  line: number,
  column: number,
): "class" | "function" | "const" | undefined {
  for (const imp of imports) {
    if (imp.kind !== "named" || imp.mechanism !== "php") continue;
    if (
      importBindingReferenceSites(imp).some((site) => rangeContains(site.range, { row: line + 1, column: column + 1 }))
    ) {
      return imp.phpImportType ?? "class";
    }
  }
  return undefined;
}

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
          loaded.set(key, await ensureParsedContextForIndex(index, file));
        } catch (error) {
          rethrowStaleQuerySource(error);
          // Reduced mode: a file that cannot be parsed stays unavailable, as before.
          loaded.set(key, null);
        }
      }
    },
  };
}

/** Load-and-retry passes for a lookup that reads files it has not parsed yet. */
const MAX_NAME_RESOLUTION_LOADS = 4;

/** Runs a synchronous lookup step, parsing any file it missed and rerunning it. */
export async function withParsedFiles<T>(files: LoadingParsedFileProvider, step: () => T): Promise<T> {
  let result = step();
  for (let attempt = 0; attempt < MAX_NAME_RESOLUTION_LOADS; attempt += 1) {
    const missing = files.takeMisses();
    if (!missing.length) break;
    await files.load(missing);
    result = step();
  }
  return result;
}

/** Resolve JVM type syntax using the same on-demand parsed files as positioned navigation. */
export const resolveJvmTypeName: JvmTypeNameResolver = (index, mod, parsed, scopeIndex, node) => {
  const files = createLoadingParsedFileProvider(index, { file: mod.file, parsed });
  const use: BareNameUse = {
    index,
    mod,
    file: mod.file,
    parsed,
    scopeIndex,
    files,
    node,
    name: sliceText(node, parsed.source),
  };
  return withParsedFiles(files, () => resolveBareName(use));
};

/** File import aliases yield to closer lexical bindings unless a language policy says otherwise. */
export function moduleAliasIsUnshadowed(use: BareNameUse, aliasFrom?: string): boolean {
  const policy = nameLookupPolicyFor(use.parsed.sup.id);
  if (policy.shadowsModuleAlias?.(use)) return false;
  const closestBinding = findClosestScopeBinding(use.scopeIndex, use.name, use.node, use.parsed.sup);
  if (policy.moduleAliasIsUnshadowed) {
    return policy.moduleAliasIsUnshadowed({ use, lookupName: use.name, closestBinding });
  }
  return fileBindingIsUnshadowed(use.scopeIndex, closestBinding, aliasFrom);
}

/** A nested classifier is proven only by its recorded direct owner and visible declaration. */
function jvmNestedType(use: BareNameUse, owner: SymbolDef, name: string): SymbolDef | undefined {
  const module = use.index.byFile.get(fileIdentityKey(owner.file));
  const support = supportForFileWithoutHeaderSample(owner.file, use.index.languageExtensions);
  const ownerStart = owner.range.start.index;
  if (!module || ownerStart === undefined || (support?.id !== "java" && support?.id !== "kotlin")) return undefined;
  const consumerLanguage = use.parsed.sup.id === "java" ? "java" : "kotlin";
  const samePackage =
    getPackageDeclarationName(use.index, owner.file, support.id) ===
    getPackageDeclarationName(use.index, use.file, consumerLanguage);
  const normalized = support.normalizeIdentifier(normalizeKotlinIdentifier(name));
  let result: SymbolDef | undefined;
  for (const entry of module.exports) {
    if (entry.type !== "local" || support.normalizeIdentifier(entry.exportedAs) !== normalized) continue;
    if (!isJvmTypeWildcardMember(entry.target, ownerStart, support.id)) continue;
    if (!isJvmPackageSymbolVisible(entry.target, support.id, consumerLanguage, samePackage)) continue;
    if (result && result.range.start.index !== entry.target.range.start.index) return undefined;
    result = entry.target;
  }
  return result;
}

function jvmNestedPath(use: BareNameUse, owner: SymbolDef, parts: readonly string[], start: number): SymbolDef | null {
  let current = owner;
  for (let index = start; index < parts.length; index += 1) {
    const nested = jvmNestedType(use, current, parts[index]!);
    if (!nested) return null;
    current = nested;
  }
  return current;
}

/** Resolves a qualified JVM name through a visible type owner or a declared package, never a bare suffix. */
function resolveQualifiedJvmName(
  use: BareNameUse,
  root: SyntaxNodeLike,
  parts: readonly string[],
  typeOnly: boolean,
): SymbolDef | null {
  const { index, file, parsed, scopeIndex } = use;
  const languageId = parsed.sup.id === "java" ? "java" : "kotlin";
  const rootName = parts[0]!;
  let rootResult = resolveBareName({ ...use, node: root, name: rootName }, typeOnly);
  while (rootResult?.status === "deferred") rootResult = rootResult.fallback;
  const definition = rootResult?.status === "ok" ? rootResult.definition : null;
  const rootDefinition = typeOnly && definition && !declaresMembers(definition) ? null : definition;
  const rootBinding = findClosestScopeBinding(scopeIndex, rootName, root, parsed.sup, typeOnly);
  if (rootDefinition || rootBinding) {
    if (!rootDefinition || !declaresMembers(rootDefinition)) return null;
    return jvmNestedPath(use, rootDefinition, parts, 1);
  }
  if (rootResult?.status === "not_found" && isAmbiguousResolutionReason(rootResult.reason)) return null;

  let target: SymbolDef | null = null;
  let packageName = normalizeKotlinIdentifier(rootName);
  for (let position = 1; position < parts.length; position += 1) {
    const name = parts[position]!;
    const hasNestedSuffix = position + 1 < parts.length;
    const owner = resolveJvmPackageSymbol(index, packageName, name, languageId, file, typeOnly || hasNestedSuffix);
    if (owner === null) return null;
    const resolved = owner ? jvmNestedPath(use, owner, parts, position + 1) : null;
    if (owner && !resolved) return null;
    if (resolved) {
      if (
        target &&
        (fileIdentityKey(target.file) !== fileIdentityKey(resolved.file) ||
          target.range.start.index !== resolved.range.start.index)
      )
        return null;
      target = resolved;
    }
    packageName += `.${normalizeKotlinIdentifier(name)}`;
  }
  return target;
}
/**
 * Resolves a bare (unqualified or C++-qualified) name at a use site. Returns `null` when no
 * lookup step answers; go-to-definition then tries a declaration at the position.
 *
 * Shared order: language pre-lexical steps, closest scope binding, its definition (with
 * overloads chosen by arity), a local declared later in the same scope, then cross-module
 * lookup (imports, compilation-unit peers, star imports) through {@link resolveNamedDefinition}.
 */
export function resolveBareName(
  use: BareNameUse,
  jvmTypeOnly = false,
  skipKotlinQualifiedExpression = false,
): NameResolution | null {
  const { index, mod, file, parsed, scopeIndex, node } = use;
  const { sup, source, tree } = parsed;
  if (sup.id === "java" || sup.id === "kotlin") {
    const qualifiedSuffix = isQualifiedTypeSuffix(sup, node);
    const qualifiedContainer = node.type === "user_type" || node.type === "scoped_type_identifier";
    const segments = qualifiedSuffix || qualifiedContainer ? jvmQualifiedTypeSegments(sup, node) : null;
    if (segments) {
      const parts = segments.map((segment) => sliceText(segment, source));
      const target = resolveQualifiedJvmName(use, segments[0]!, parts, true);
      return target
        ? okGoToResult(index, target, { resolution: "member-access", confidence: "medium" })
        : { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
    }
    if (qualifiedSuffix) {
      return { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
    }
    const expression = skipKotlinQualifiedExpression ? null : kotlinQualifiedExpression(sup, node);
    if (expression) {
      const chain = collectMemberAccessChain({ sup, source, chainNode: expression });
      if (!chain || !isReceiverNameNode(sup, chain.base.type)) {
        return { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
      }
      const parts = [sliceText(chain.base, source), ...chain.names.toReversed()];
      const target = resolveQualifiedJvmName(use, chain.base, parts, false);
      return target
        ? okGoToResult(index, target, { resolution: "member-access", confidence: "medium" })
        : { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
    }
  }
  const policy = nameLookupPolicyFor(sup.id);
  const lookupName = policy.lookupName?.(use) ?? use.name;
  const early = policy.beforeLexical?.(use, lookupName);
  if (early !== undefined) return early;
  const found = findClosestScopeBinding(scopeIndex, lookupName, node, sup, jvmTypeOnly);
  const state: NameLookupState = {
    use,
    lookupName,
    closestBinding: found && policy.ignoresBinding?.(use, found) ? null : found,
  };
  const fromBinding = policy.fromClosestBinding?.(state);
  if (fromBinding !== undefined) return fromBinding;
  const rest = (): NameResolution | null => {
    const beforeLocal = policy.beforeLocal?.(state);
    if (beforeLocal !== undefined) return beforeLocal;
    const { closestBinding } = state;
    const local = closestBinding ? definitionForBinding(closestBinding, file, node, sup, source, tree) : null;
    if (local) {
      const adjusted = policy.onLocal?.(state, local);
      if (adjusted !== undefined) return adjusted;
      return okGoToResult(index, local, { resolution: "exact", confidence: "high" });
    }
    const unbound = policy.onUnboundLocal?.(state);
    if (unbound !== undefined) return unbound;
    if (!jvmTypeOnly && laterLocalShadowsUse(scopeIndex, lookupName, node, sup)) {
      return { status: "not_found", reason: "Local is not in scope before its declaration" };
    }
    const beforeCrossModule = policy.beforeCrossModule?.(state);
    if (beforeCrossModule !== undefined) return beforeCrossModule;
    if (!sup.supportsCrossModuleSymbols) return null;
    const resolved = resolveNamedDefinition(
      index,
      mod,
      file,
      sup,
      policy.crossModuleName?.(state) ?? lookupName,
      policy.cNamespace?.(node),
      node.startIndex,
      { node, source },
      scopeIndex,
    );
    const adjusted = policy.afterCrossModule?.(state, resolved);
    return adjusted !== undefined ? adjusted : resolved;
  };
  return policy.wrapRest ? policy.wrapRest(state, rest) : rest();
}

/** How a consumer settles deferred steps. */
export type SettleNameOptions = {
  /** The graph records no edge when the member a call names cannot accept its argument count. */
  requireAcceptedArity?: boolean;
  /** Resolves included C/C++ star candidates; navigation owns this recovery. */
  recoverIncludedStar?: (lookupName: string, cNamespace: "tag" | "ordinary" | undefined) => Promise<GoToResult | null>;
};

/**
 * A C# name that a using alias also names: a member of an enclosing type binds it first (only a nested type in a type
 * position). Project bases and partial parts must be readable; members of external bases are not indexed.
 */
async function settleCsharpAliasMember(use: BareNameUse, lookupName: string): Promise<GoToResult | undefined> {
  const { index, mod, node } = use;
  const lookup = await csharpAliasMemberLookup(index, mod, node, lookupName);
  if (lookup.status === "none") return undefined;
  if (lookup.status === "unproven") return { status: "not_found", reason: UNPROVEN_CSHARP_ALIAS_MEMBER_REASON };
  if (!lookup.member) return { status: "not_found", reason: AMBIGUOUS_CSHARP_ALIAS_MEMBER_REASON };
  return okGoToResult(index, lookup.member, { resolution: "member-access", confidence: "medium" });
}

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
      // The graph records no edge for a call its target cannot accept, and does not fall back.
      if (
        member &&
        options.requireAcceptedArity &&
        !memberAcceptsCallAt(index, member, node, parsed.source, parsed.sup.id)
      ) {
        return null;
      }
      if (member) return okGoToResult(index, member, { resolution: "member-access", confidence: "medium" });
      // A member hides the name but none is a unique, reachable target (static context, ambiguity).
      if (member === null) return { status: "not_found", reason: "No unique member through the implicit receiver" };
    } else if (request.kind === "csharp-alias-member") {
      const settled = await settleCsharpAliasMember(use, request.lookupName);
      if (settled) return settled;
    } else {
      const recovered = await options.recoverIncludedStar?.(request.lookupName, request.cNamespace);
      if (recovered) return recovered;
    }
    current = fallback;
  }
  return current;
}

/**
 * Files a synchronous consumer must load before resolving names in `mod`: the file itself, its
 * resolved imports (TS/TSX overload checks read import targets), and for C++ the transitive
 * include closure. A lookup that reads any other file finds it missing and skips that check.
 */
export function nameResolutionPreloadFiles(index: ProjectIndex, mod: ModuleIndex, languageId: string): FileId[] {
  const files = new Map<string, FileId>([[fileIdentityKey(mod.file), mod.file]]);
  for (const file of nameLookupPolicyFor(languageId).preloadFiles?.(index, mod) ?? []) {
    files.set(fileIdentityKey(file), file);
  }
  return [...files.values()];
}
