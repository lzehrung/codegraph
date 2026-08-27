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
/**
 * Bump whenever a language behavior hook changes. Hook source text is deliberately
 * not fingerprinted because bundling rewrites it; this epoch invalidates caches
 * consistently across the CLI and library build shapes.
 */
export const LANGUAGE_BEHAVIOR_EPOCH = 1;

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
      membersAreImplicitlyInScope: definition.membersAreImplicitlyInScope ?? true,
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
