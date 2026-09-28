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
import type { FileId } from "../types.js";

import { fileIdentityKey } from "../util/paths.js";

import { resolveCppOutOfLineImplicitMember, resolveImplicitSelfMember } from "./navigation-goto.js";
import {
  definitionForBinding,
  findClosestScopeBinding,
  laterLocalShadowsUse,
  resolveNamedDefinition,
} from "./navigation-local.js";

import { okGoToResult } from "./navigation-provenance.js";

import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";

import type { Binding, ScopeIndex } from "./scope.js";
import { nameLookupPolicyFor } from "./name-lookup-policies/index.js";

import { type GoToResult, type ImportBinding, type ModuleIndex, type ProjectIndex, type SymbolDef } from "./types.js";
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

/** What a lookup step knows about the use once the closest scope binding is found. */
export type NameLookupState = {
  use: BareNameUse;
  /** The name as scope and import tables spell it (C# drops alias qualifiers). */
  lookupName: string;
  closestBinding: Binding | null;
};

/**
 * One language's additions to the shared lookup order. Each hook returns a resolution to stop
 * the lookup, or `undefined` to continue; the skeleton in {@link resolveBareName} fixes the
 * order in which hooks run. A language without special rules has an empty policy.
 */
export type NameLookupPolicy = {
  lookupName?(use: BareNameUse): string;
  /** Before scope lookup: qualified names, role namespaces, unparsed macro input. */
  beforeLexical?(use: BareNameUse, lookupName: string): NameResolution | null | undefined;
  /** From the closest binding before anything else (a C++ `using` declaration). */
  fromClosestBinding?(state: NameLookupState): NameResolution | null | undefined;
  /** Wraps the rest of the lookup, for a deferred step whose fallback is that rest. */
  wrapRest?(state: NameLookupState, rest: () => NameResolution | null): NameResolution | null;
  /** Before the closest binding's definition is taken (C++ same-scope overload collisions). */
  beforeLocal?(state: NameLookupState): NameResolution | null | undefined;
  /** Adjusts a lexical hit (member precedence, role checks). */
  onLocal?(state: NameLookupState, local: SymbolDef): NameResolution | null | undefined;
  /** No lexical hit, before the shared later-local check. */
  onUnboundLocal?(state: NameLookupState): NameResolution | null | undefined;
  /** No lexical hit, before cross-module lookup (visible C++ callables, `using namespace`). */
  beforeCrossModule?(state: NameLookupState): NameResolution | null | undefined;
  /** Name for cross-module lookup (C# alias-qualified). */
  crossModuleName?(state: NameLookupState): string;
  /** C ordinary versus tag namespace. */
  cNamespace?(node: SyntaxNodeLike): "tag" | "ordinary" | undefined;
  /** Adjusts the cross-module result (arity, roles, member precedence, deferred recovery). */
  afterCrossModule?(state: NameLookupState, resolved: GoToResult | null): NameResolution | null | undefined;
  /** Files a synchronous consumer loads before resolving names in a module of this language. */
  preloadFiles?(index: ProjectIndex, mod: ModuleIndex): Iterable<FileId>;
};

/**
 * Resolves a bare (unqualified or C++-qualified) name at a use site. Returns `null` when no
 * lookup step answers; go-to-definition then tries a declaration at the position.
 *
 * Shared order: language pre-lexical steps, closest scope binding, its definition (with
 * overloads chosen by arity), a local declared later in the same scope, then cross-module
 * lookup (imports, compilation-unit peers, star imports) through {@link resolveNamedDefinition}.
 */
export function resolveBareName(use: BareNameUse): NameResolution | null {
  const { index, mod, file, parsed, scopeIndex, node } = use;
  const { sup, source, tree } = parsed;
  const policy = nameLookupPolicyFor(sup.id);
  const lookupName = policy.lookupName?.(use) ?? use.name;
  const early = policy.beforeLexical?.(use, lookupName);
  if (early !== undefined) return early;
  const state: NameLookupState = {
    use,
    lookupName,
    closestBinding: findClosestScopeBinding(scopeIndex, lookupName, node, sup),
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
    if (laterLocalShadowsUse(scopeIndex, lookupName, node, sup)) {
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
    );
    const adjusted = policy.afterCrossModule?.(state, resolved);
    return adjusted !== undefined ? adjusted : resolved;
  };
  return policy.wrapRest ? policy.wrapRest(state, rest) : rest();
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

/**
 * The definition a resolution names without running deferred member steps: a deferred step
 * contributes its fallback. For consumers that settle member lookups separately.
 */
export function definitionWithoutDeferredSteps(resolution: NameResolution | null): SymbolDef | null {
  let current = resolution;
  while (current?.status === "deferred") current = current.fallback;
  return current?.status === "ok" ? current.definition : null;
}
