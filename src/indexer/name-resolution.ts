/**
 * One lookup order for a bare name at a use site, shared by go-to-definition, references (which
 * verify through go-to-definition), and the detailed call graph.
 *
 * `resolveBareName` is synchronous: it reads parsed files through a {@link ParsedFileProvider}
 * and never awaits. The few steps that need async member lookup return a `deferred` resolution
 * with the answer to use when that lookup finds nothing; {@link settleNameResolution} runs those
 * steps. Navigation settles immediately; the graph settles after its body walk.
 */

import type { FileId } from "../types.js";

import { fileIdentityKey } from "../util/paths.js";

import {
  memberAcceptsCallAt,
  resolveCppOutOfLineImplicitMember,
  resolveImplicitSelfMember,
} from "./navigation-goto.js";
import {
  definitionForBinding,
  findClosestScopeBinding,
  laterLocalShadowsUse,
  resolveNamedDefinition,
} from "./navigation-local.js";

import { okGoToResult } from "./navigation-provenance.js";

import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";

import { nameLookupPolicyFor } from "./name-lookup-policies/index.js";
import type {
  BareNameUse,
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
import type { Binding, ScopeIndex } from "./scope.js";

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
          loaded.set(key, await ensureParsedContext(file, index.parsed?.get(key), index.languageExtensions));
        } catch {
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

/** A closer lexical binding hides an imported file alias. */
export function fileBindingIsUnshadowed(scopeIndex: ScopeIndex, binding: Binding | null): boolean {
  return !binding || scopeIndex.allScopes[0]?.map.get(binding.canonicalName) === binding;
}

/** File import aliases yield to closer lexical bindings unless a language policy says otherwise. */
export function moduleAliasIsUnshadowed(use: BareNameUse): boolean {
  const policy = nameLookupPolicyFor(use.parsed.sup.id);
  const closestBinding = findClosestScopeBinding(use.scopeIndex, use.name, use.node, use.parsed.sup);
  if (policy.moduleAliasIsUnshadowed) {
    return policy.moduleAliasIsUnshadowed({ use, lookupName: use.name, closestBinding });
  }
  return fileBindingIsUnshadowed(use.scopeIndex, closestBinding);
}
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
  const found = findClosestScopeBinding(scopeIndex, lookupName, node, sup);
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
      { node, source },
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
