import crypto from "node:crypto";
import path from "node:path";
import { normalizeLanguageExtensions, type LanguageExtensionMap } from "../../languages.js";
import { getAllLanguages } from "../../languages/registry.js";
import type { LanguageDefinition } from "../../languages/types.js";
import type { GraphBuildOptions } from "../../graphs/types.js";
import { normalizePath, normalizeResolutionHints } from "../../util/paths.js";
import { getCodegraphVersion } from "../../util/package-info.js";
import { type ProjectFileDiscoveryOptions } from "../../util/project-files.js";
import { getNativeRuntimeFingerprint } from "../../native/tree-sitter-native.js";
import type { BuildOptions } from "../types.js";
export { normalizeLanguageExtensions } from "../../languages.js";

/**
 * Bump whenever indexing or graph construction changes what a cached artifact would
 * contain. Epoch 3 added resolved call edges. Epoch 4 discards snapshots whose
 * import bindings could disagree with graph edges after resolution hints changed,
 * plus inheritance edges that treated generic arguments or enclosing-type
 * qualifiers as direct bases. Epoch 5 invalidates modules whose TypeScript or
 * workspace resolution inputs were not fingerprinted, including removed configs.
 * Epoch 6 refreshes declaration exports, language discovery, and declaration-file resolution.
 * Epoch 7 refreshes import resolution, grouped import bindings, and typedef names.
 * Epoch 9 refreshes scoped Rust paths, type-only edges, and capture-only symbols.
 * Epoch 10 refreshes lexical scope construction, standard-library classification,
 * Rust graph module scope, and Python module-level import detection.
 * Epoch 11 refreshes document-link extraction and fallback diagnostics.
 * Epoch 12 refreshes Rust `#[path]` module owner resolution.
 * Epoch 13 adds exact import-binding token ranges to cached modules.
 * Epoch 14 extends exact import-binding token ranges across native and reduced-mode
 * language paths, fixes repeated-name attribution, and refreshes Zig lexical scope bindings.
 * Epoch 15 preserves explicit same-spelling aliases, multiline Python imports,
 * CommonJS destructuring defaults, and corrected declaration captures.
 * Epoch 16 handles balanced CommonJS destructuring defaults and corrected bounded references.
 * Epoch 17 corrects rename bounds, static member lookup, and aliased re-export coverage.
 * Epoch 18 refreshes direct namespace-member resolution.
 * Epoch 19 adds Go and Python receiver member resolution, C# namespace-to-file
 * resolution, SCSS declaration navigation, and object-level SQL impact mapping.
 * Epoch 20 covers the cross-language consolidation: C++20 module imports bind to
 * first-party declarations without hints, Kotlin `.ktm` and PHP `.phtml`/`.php4`/`.php8`
 * containers are indexed, per-language declaration visibility filters module exports and
 * refuses cross-module binds for hidden names, first-party hits are realpath-confined,
 * JVM/C#/PHP/Python symbol indexes are scoped to the nearest language manifest,
 * a directory hit becomes a file edge only for real module directories (Python
 * `__init__` packages, PEP 420 namespace directories, and Go package directories),
 * a leading BOM no longer discards tsconfig path mappings, lone-CR sources report
 * real line numbers, and cached modules persist `declaredContainers` so a consumer
 * whose declaring file changed elsewhere is re-resolved on an incremental build.
 * Epoch 21 resolves C and C++ quoted includes relative to the including file, routes C through
 * the graph edge resolver, registers C-family function names in the enclosing scope through the
 * declarator chain so same-file call sites become references, and resolves keyword and supertype
 * receiver members for every language that declares receiver keywords.
 * Epoch 22 resolves a keyword receiver through direct members and declared ancestors, and
 * binds a quoted C/C++ include to the exact includer-relative file only.
 * Epoch 23 derives keyword receiver scope from static context, preserves Kotlin's superclass
 * relation, and filters overloaded keyword receiver members by known call arity.
 * Epoch 24 preserves reduced-mode C-family include forms per occurrence, registers C++ functions
 * with reference return types in their enclosing scope, rejects JavaScript and TypeScript `this`
 * across dynamic function boundaries, and stops an ambiguous shallow ancestor lookup instead of
 * selecting a shared grandparent.
 * Epoch 25 shares C function occurrences between a file-scope prototype and its definition.
 * Epoch 26 preserves distinct C++ redeclarations and marks their name-only occurrence sets partial.
 * Epoch 27 preserves receiver boundaries and static scope across goto, references, and call
 * edges; rejects computed heritage expressions; and validates deferred calls against exact edges.
 * Epoch 28 restricts PHP global-namespace reference candidates to PHP files and stores PHP
 * bloom-filter identifiers in both their original and ASCII-case-folded spelling so
 * case-insensitive PHP references are narrowed correctly.
 * Epoch 29 uses exact configured-root matching for C-family angle includes and applies PHP
 * method-name case folding to receiver call edges.
 * Epoch 30 restores reduced-mode C-family include bindings when native import capture is unavailable
 * and shares one ancestry model across keyword-receiver navigation and detailed graph edges.
 * Epoch 31 distinguishes imported Kotlin interfaces from constructor-invoked classes, preserves
 * static PHP keyword scope, and resolves members through imported interface and type-alias bases.
 * Epoch 32 resolves reduced-mode C++ header-unit imports and keeps PHP class, function, and
 * constant imports in their separate symbol namespaces during navigation and reference scans.
 * Epoch 33 keeps C++ class members in member scope and classifies PHP type-position aliases before
 * selecting among separate import namespaces.
 * Epoch 34 links C++ out-of-line definitions to their in-class declarations for ownership,
 * calls, and references, and indexes JavaScript and TypeScript function-valued fields as
 * callable members independently of file order.
 * Epoch 35 requires a parsed class, struct, or union before assigning C++ out-of-line member
 * ownership and stops ancestor lookup when shallow overloads reject a known call arity.
 * Epoch 36 resolves PHP class-namespace imports across class, interface, trait, and enum definitions.
 * Epoch 37 rejects incomplete C++ overload occurrence bindings when reporting references.
 * Epoch 38 preserves C++ overload groups and resolves qualified namespace/type paths exactly.
 * Epoch 39 treats a sole C/C++ void parameter as zero arity and resolves PHP class-like and
 * function exports with PHP's ASCII case-insensitive name rules.
 * Epoch 40 preserves PHP import roles in dependency extraction and groups C++ callable
 * redeclarations by signature for overload resolution and reference ownership.
 * Epoch 41 resolves extensionless relative imports whose basenames contain dots.
 * Epoch 42 preserves C++ signature tokens and qualified exports, merges member arity ranges,
 * and keeps PHP import roles and member-name case rules consistent across consumers.
 * Epoch 43 applies C++ call arity to single entities and overloaded using aliases.
 */
export const CORE_ALGORITHM_EPOCH = 43;
/**
 * Bump whenever a language behavior hook changes. Hook source text is deliberately
 * not fingerprinted because bundling rewrites it; this epoch invalidates caches
 * consistently across the CLI and library build shapes.
 * Epoch 4 distinguishes TypeScript variable names from initializer references.
 * Epoch 5 applies the same declaration-name boundary to JavaScript, Python, PHP, and Zig.
 * Epoch 6 adds field and enum-member declarations and tightens PHP and Zig declarations.
 * Epoch 7 adds SCSS declaration scope, TypeScript named function expression self-binding,
 * and C# positional record component locals.
 * Epoch 8 makes implicit member scope opt-in per language, adds C# method and constructor
 * parameter locals, Java constructor and spread-parameter declaration names, PHP block
 * scope, Ruby query-driven locals, JavaScript type-only imports, and Ruby and PHP
 * dynamic-import heuristics.
 * Epoch 9 classifies a PHP trait as `class` so it reaches SymbolKind.Class and matches Rust. It
 * also classifies JavaScript and TypeScript method declarations, private properties, and static
 * blocks for receiver-aware member resolution, and records Python and Ruby keyword receiver
 * members in the owning class scope.
 * Epoch 10 classifies C++ class, struct, and union declarations as receiver members.
 */
export const LANGUAGE_BEHAVIOR_EPOCH = 10;

export type ManifestBuildOptions = {
  cache?: BuildOptions["cache"];
  cacheStrict?: boolean;
  useBloomFilters?: boolean;
  incrementalStrict?: boolean;
  nativeRuntimeFingerprint?: string;
  implementationFingerprint?: string;
  coreAlgorithmEpoch?: number;
  discovery?: {
    includeGlobs?: string[];
    ignoreGlobs?: string[];
    globRoot?: string;
    gitignoreRoot?: string;
    useGitignore: boolean;
  };
  languageExtensions?: LanguageExtensionMap;
};

type LanguageDefinitionFingerprintDescriptor = {
  id: string;
  extensions: string[];
  structure: LanguageDefinition["structure"];
  graph: LanguageDefinition["graph"];
  nodeTypes?: LanguageDefinition["nodeTypes"];
  supportsCrossModuleSymbols: boolean;
  native?: {
    authoritativeKinds: string[];
    notes: string[];
  };
  behavior: {
    scopeDeclarationNames?: "all";
    usesQueryDrivenLocals: boolean;
    membersAreImplicitlyInScope: boolean;
    supportsExportFromReferences: boolean;
    exportScopeBlockers: string[];
  };
};

let cachedImplementationFingerprint: string | undefined;

function languageDefinitionFingerprintDescriptor(
  definition: LanguageDefinition,
): LanguageDefinitionFingerprintDescriptor {
  const native = definition.native;
  const scopeDeclarationNames = definition.scopeDeclarationNames === "all" ? "all" : undefined;
  return {
    id: definition.id,
    extensions: [...definition.extensions].sort(),
    structure: definition.structure,
    graph: definition.graph,
    ...(definition.nodeTypes ? { nodeTypes: definition.nodeTypes } : {}),
    supportsCrossModuleSymbols: definition.supportsCrossModuleSymbols ?? false,
    ...(native
      ? {
          native: {
            authoritativeKinds: [...(native.authoritativeKinds ?? [])].sort(),
            notes: [...(native.notes ?? [])],
          },
        }
      : {}),
    behavior: {
      // Function-valued behavior fields are covered by LANGUAGE_BEHAVIOR_EPOCH.
      // Bundlers rewrite their source text, so hashing it would make equivalent
      // CLI and library builds invalidate one another's caches.
      usesQueryDrivenLocals: definition.usesQueryDrivenLocals ?? false,
      membersAreImplicitlyInScope: definition.membersAreImplicitlyInScope ?? false,
      supportsExportFromReferences: definition.supportsExportFromReferences ?? false,
      exportScopeBlockers: [...(definition.exportScopeBlockers ?? [])].sort(),
      ...(scopeDeclarationNames ? { scopeDeclarationNames } : {}),
    },
  };
}

/**
 * Structural guard against fingerprint drift: every LanguageDefinition key must be
 * covered by languageDefinitionFingerprintDescriptor above. Record exhaustiveness
 * makes adding a field to LanguageDefinition without descriptor coverage a
 * typecheck error, and the runtime check in tests/cache-invalidation.test.ts
 * rejects definition objects carrying keys outside this set. Function-valued
 * behavior fields are intentionally covered by LANGUAGE_BEHAVIOR_EPOCH instead of
 * source text; bump that epoch with every hook behavior change.
 */
export const languageDefinitionFingerprintCoverage: Readonly<Record<keyof LanguageDefinition, true>> = {
  id: true,
  extensions: true,
  structure: true,
  graph: true,
  usesQueryDrivenLocals: true,
  supportsExportFromReferences: true,
  exportScopeBlockers: true,
  classifyDefinition: true,
  isDeclarationName: true,
  scopeDeclarationNames: true,
  normalizeIdentifier: true,
  createsBlockScope: true,
  createsFunctionScope: true,
  membersAreImplicitlyInScope: true,
  supportsCrossModuleSymbols: true,
  isTypeOnly: true,
  nodeTypes: true,
  native: true,
};

/**
 * Changes whenever this package version, a declarative language definition field,
 * or LANGUAGE_BEHAVIOR_EPOCH changes. Behavior-hook edits must bump that epoch.
 *
 * The optional epoch parameter exists for regression coverage of this declared
 * cache-invalidation contract.
 */
export function getImplementationFingerprintForEpoch(languageBehaviorEpoch: number): string {
  const definitions = getAllLanguages()
    .map(languageDefinitionFingerprintDescriptor)
    .sort((left, right) => left.id.localeCompare(right.id));
  const hash = crypto.createHash("sha256");
  hash.update("codegraph-implementation-fingerprint-v3");
  hash.update("\0");
  hash.update(String(CORE_ALGORITHM_EPOCH));
  hash.update("\0");
  hash.update(String(languageBehaviorEpoch));
  hash.update("\0");
  hash.update(getCodegraphVersion());
  hash.update("\0");
  hash.update(JSON.stringify(definitions));
  return hash.digest("hex");
}

export function getImplementationFingerprint(): string {
  if (cachedImplementationFingerprint) return cachedImplementationFingerprint;
  cachedImplementationFingerprint = getImplementationFingerprintForEpoch(LANGUAGE_BEHAVIOR_EPOCH);
  return cachedImplementationFingerprint;
}

export function clearImplementationFingerprintCache(): void {
  cachedImplementationFingerprint = undefined;
}

function normalizeManifestBuildOptions(opts?: ManifestBuildOptions): ManifestBuildOptions {
  const languageExtensions = normalizeLanguageExtensions(opts?.languageExtensions);
  return {
    cache: opts?.cache ?? "off",
    cacheStrict: opts?.cacheStrict ?? true,
    useBloomFilters: opts?.useBloomFilters ?? true,
    incrementalStrict: opts?.incrementalStrict ?? false,
    ...(opts?.nativeRuntimeFingerprint ? { nativeRuntimeFingerprint: opts.nativeRuntimeFingerprint } : {}),
    ...(opts?.implementationFingerprint ? { implementationFingerprint: opts.implementationFingerprint } : {}),
    coreAlgorithmEpoch: opts?.coreAlgorithmEpoch ?? 1,
    ...(opts?.discovery ? { discovery: opts.discovery } : {}),
    ...(languageExtensions ? { languageExtensions } : {}),
  };
}

function normalizeDiscoveryOptions(discovery?: ProjectFileDiscoveryOptions): ManifestBuildOptions["discovery"] {
  if (!discovery) return undefined;
  const normalizeGlob = (glob: string) => glob.trim().replace(/\\/g, "/");
  const includeGlobs = Array.from(new Set((discovery.includeGlobs ?? []).map(normalizeGlob).filter(Boolean))).sort();
  const ignoreGlobs = Array.from(new Set((discovery.ignoreGlobs ?? []).map(normalizeGlob).filter(Boolean))).sort();
  const globRoot = discovery.globRoot ? normalizePath(path.resolve(discovery.globRoot)) : undefined;
  const gitignoreRoot = discovery.gitignoreRoot ? normalizePath(path.resolve(discovery.gitignoreRoot)) : undefined;
  const useGitignore = discovery.useGitignore ?? true;
  if (!includeGlobs.length && !ignoreGlobs.length && !globRoot && !gitignoreRoot && useGitignore) {
    return undefined;
  }
  return {
    ...(includeGlobs.length ? { includeGlobs } : {}),
    ...(ignoreGlobs.length ? { ignoreGlobs } : {}),
    ...(globRoot ? { globRoot } : {}),
    ...(gitignoreRoot ? { gitignoreRoot } : {}),
    useGitignore,
  };
}

function normalizeBuildOptions(opts?: BuildOptions): ManifestBuildOptions {
  const discovery = normalizeDiscoveryOptions(opts?.discovery);
  const languageExtensions = normalizeLanguageExtensions(opts?.languageExtensions);
  return {
    cache: opts?.cache ?? "off",
    cacheStrict: opts?.cacheStrict ?? true,
    useBloomFilters: opts?.useBloomFilters ?? true,
    incrementalStrict: opts?.incrementalStrict ?? false,
    nativeRuntimeFingerprint: getNativeRuntimeFingerprint(opts?.native),
    implementationFingerprint: getImplementationFingerprint(),
    coreAlgorithmEpoch: CORE_ALGORITHM_EPOCH,
    ...(discovery ? { discovery } : {}),
    ...(languageExtensions ? { languageExtensions } : {}),
  };
}

export function summarizeBuildOptions(opts?: BuildOptions): ManifestBuildOptions {
  return normalizeBuildOptions(opts);
}

function normalizeLanguageList(list?: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of list ?? []) {
    const normalized = entry.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  out.sort();
  return out;
}

function orderedListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function normalizedDiscoveryOptionsEqual(
  a: ManifestBuildOptions["discovery"],
  b: ManifestBuildOptions["discovery"],
): boolean {
  const normalizedA = a ?? { useGitignore: true };
  const normalizedB = b ?? { useGitignore: true };
  if (normalizedA.useGitignore !== normalizedB.useGitignore) return false;
  if (normalizedA.globRoot !== normalizedB.globRoot) return false;
  if (normalizedA.gitignoreRoot !== normalizedB.gitignoreRoot) return false;
  if (!orderedListsEqual(normalizedA.includeGlobs ?? [], normalizedB.includeGlobs ?? [])) return false;
  if (!orderedListsEqual(normalizedA.ignoreGlobs ?? [], normalizedB.ignoreGlobs ?? [])) return false;
  return true;
}

function normalizedLanguageExtensionsEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const normalizedA = normalizeLanguageExtensions(a) ?? {};
  const normalizedB = normalizeLanguageExtensions(b) ?? {};
  const keys = Array.from(new Set([...Object.keys(normalizedA), ...Object.keys(normalizedB)])).sort();
  for (const key of keys) {
    if (normalizedA[key] !== normalizedB[key]) return false;
  }
  return true;
}

export function diffBuildOptions(
  manifestOpts: ManifestBuildOptions | undefined,
  currentOpts: BuildOptions | undefined,
): string[] {
  if (!manifestOpts) return ["native"];
  const normalizedManifest = normalizeManifestBuildOptions(manifestOpts);
  const normalizedCurrent = normalizeBuildOptions(currentOpts);
  const diffs: string[] = [];
  if (normalizedManifest.cache !== normalizedCurrent.cache) diffs.push("cache");
  if (normalizedManifest.cacheStrict !== normalizedCurrent.cacheStrict) {
    diffs.push("cacheStrict");
  }
  if (normalizedManifest.useBloomFilters !== normalizedCurrent.useBloomFilters) {
    diffs.push("useBloomFilters");
  }
  if (normalizedManifest.incrementalStrict !== normalizedCurrent.incrementalStrict) {
    diffs.push("incrementalStrict");
  }
  if (normalizedManifest.nativeRuntimeFingerprint !== normalizedCurrent.nativeRuntimeFingerprint) {
    diffs.push("native");
  }
  if ((normalizedManifest.coreAlgorithmEpoch ?? 1) !== (normalizedCurrent.coreAlgorithmEpoch ?? CORE_ALGORITHM_EPOCH)) {
    diffs.push("coreAlgorithm");
  }
  if (normalizedManifest.implementationFingerprint !== normalizedCurrent.implementationFingerprint) {
    diffs.push("implementation");
  }
  if (!normalizedDiscoveryOptionsEqual(normalizedManifest.discovery, normalizedCurrent.discovery)) {
    diffs.push("discovery");
  }
  if (!normalizedLanguageExtensionsEqual(normalizedManifest.languageExtensions, normalizedCurrent.languageExtensions)) {
    diffs.push("languageExtensions");
  }
  return diffs;
}

export function normalizeGraphOptions(opts?: GraphBuildOptions): GraphBuildOptions {
  const resolutionHints = normalizeResolutionHints(opts?.resolutionHints);
  const fastRegexDisabledLanguages = normalizeLanguageList(opts?.fastRegexDisabledLanguages);
  return {
    fast: !!opts?.fast,
    ...(fastRegexDisabledLanguages.length ? { fastRegexDisabledLanguages } : {}),
    resolveNodeModules: !!opts?.resolveNodeModules,
    dynamicImportHeuristics: !!opts?.dynamicImportHeuristics,
    ...(resolutionHints.length ? { resolutionHints } : {}),
  };
}

export function graphOptionsEqual(a?: GraphBuildOptions, b?: GraphBuildOptions): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const normalizedA = normalizeGraphOptions(a);
  const normalizedB = normalizeGraphOptions(b);
  if (!!normalizedA.fast !== !!normalizedB.fast) return false;
  if (!!normalizedA.resolveNodeModules !== !!normalizedB.resolveNodeModules) {
    return false;
  }
  if (!!normalizedA.dynamicImportHeuristics !== !!normalizedB.dynamicImportHeuristics) {
    return false;
  }
  if (!orderedListsEqual(normalizedA.fastRegexDisabledLanguages ?? [], normalizedB.fastRegexDisabledLanguages ?? [])) {
    return false;
  }
  if (!orderedListsEqual(normalizedA.resolutionHints ?? [], normalizedB.resolutionHints ?? [])) {
    return false;
  }
  return true;
}
