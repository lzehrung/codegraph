import crypto from "node:crypto";
import path from "node:path";
import { normalizeLanguageExtensions, type LanguageExtensionMap } from "../../languages.js";
import { getAllLanguages } from "../../languages/registry.js";
import type { LanguageDefinition } from "../../languages/types.js";
import type { GraphBuildOptions } from "../../graphs/types.js";
import { normalizePath, normalizeResolutionHints } from "../../util/paths.js";
import { getCodegraphVersion } from "../../util/packageInfo.js";
import { type ProjectFileDiscoveryOptions } from "../../util/projectFiles.js";
import { getNativeRuntimeFingerprint } from "../../native/treeSitterNative.js";
import type { BuildOptions } from "../types.js";
export { normalizeLanguageExtensions } from "../../languages.js";

export const CORE_ALGORITHM_EPOCH = 2;

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
    normalizeQuery?: string;
  };
  behavior: {
    classifyDefinition?: string;
    isDeclarationName?: string;
    scopeDeclarationNames?: string;
    normalizeIdentifier?: string;
    createsBlockScope?: string;
    createsFunctionScope?: string;
    usesQueryDrivenLocals: boolean;
    membersAreImplicitlyInScope: boolean;
    isTypeOnly?: string;
  };
};

let cachedImplementationFingerprint: string | undefined;

function functionSource(value: unknown): string | undefined {
  return typeof value === "function" ? Function.prototype.toString.call(value) : undefined;
}

function languageDefinitionFingerprintDescriptor(
  definition: LanguageDefinition,
): LanguageDefinitionFingerprintDescriptor {
  const native = definition.native;
  const nativeNormalizeQuery = functionSource(native?.normalizeQuery);
  const classifyDefinition = functionSource(definition.classifyDefinition);
  const isDeclarationName = functionSource(definition.isDeclarationName);
  const scopeDeclarationNames =
    definition.scopeDeclarationNames === "all" ? "all" : functionSource(definition.scopeDeclarationNames);
  const normalizeIdentifier = functionSource(definition.normalizeIdentifier);
  const createsBlockScope = functionSource(definition.createsBlockScope);
  const createsFunctionScope = functionSource(definition.createsFunctionScope);
  const isTypeOnly = functionSource(definition.isTypeOnly);
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
            ...(nativeNormalizeQuery ? { normalizeQuery: nativeNormalizeQuery } : {}),
          },
        }
      : {}),
    behavior: {
      // Booleans serialize under the same defaults adaptDefinition applies, so the
      // fingerprint tracks effective behavior rather than incidental optionality.
      usesQueryDrivenLocals: definition.usesQueryDrivenLocals ?? false,
      membersAreImplicitlyInScope: definition.membersAreImplicitlyInScope ?? true,
      ...(classifyDefinition ? { classifyDefinition } : {}),
      ...(isDeclarationName ? { isDeclarationName } : {}),
      ...(scopeDeclarationNames ? { scopeDeclarationNames } : {}),
      ...(normalizeIdentifier ? { normalizeIdentifier } : {}),
      ...(createsBlockScope ? { createsBlockScope } : {}),
      ...(createsFunctionScope ? { createsFunctionScope } : {}),
      ...(isTypeOnly ? { isTypeOnly } : {}),
    },
  };
}

/**
 * Structural guard against fingerprint drift: every LanguageDefinition key must be
 * covered by languageDefinitionFingerprintDescriptor above. Record exhaustiveness
 * makes adding a field to LanguageDefinition without descriptor coverage a
 * typecheck error, and the runtime check in tests/cache-invalidation.test.ts
 * rejects definition objects carrying keys outside this set. Coverage here means
 * the field participates in the fingerprint; if a future field genuinely cannot
 * affect indexing results, serialize a stable placeholder for it in the
 * descriptor and keep its entry below.
 */
export const languageDefinitionFingerprintCoverage: Readonly<Record<keyof LanguageDefinition, true>> = {
  id: true,
  extensions: true,
  structure: true,
  graph: true,
  usesQueryDrivenLocals: true,
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
 * Changes whenever this package version or a loaded language definition changes.
 * The descriptor serializes every LanguageDefinition field (guarded by
 * languageDefinitionFingerprintCoverage): structure and graph queries, plus the
 * source text of every behavior hook, so editing a definition or its queries
 * cannot silently outlive an on-disk index. Changes to the code that interprets
 * definitions — the import resolver, the chunker, scope construction — are NOT
 * covered by this descriptor; they invalidate only via the package-version
 * component, so same-version installs and dev iteration must bump the version or
 * clear the cache for those to take effect.
 */
export function getImplementationFingerprint(): string {
  if (cachedImplementationFingerprint) return cachedImplementationFingerprint;
  const definitions = getAllLanguages()
    .map(languageDefinitionFingerprintDescriptor)
    .sort((left, right) => left.id.localeCompare(right.id));
  const hash = crypto.createHash("sha256");
  hash.update("codegraph-implementation-fingerprint-v2");
  hash.update("\0");
  hash.update(String(CORE_ALGORITHM_EPOCH));
  hash.update("\0");
  hash.update(getCodegraphVersion());
  hash.update("\0");
  hash.update(JSON.stringify(definitions));
  cachedImplementationFingerprint = hash.digest("hex");
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
