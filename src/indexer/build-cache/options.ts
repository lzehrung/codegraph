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
import { compareStrings } from "../../util/strings.js";
import { callableIdentityPolicyFor } from "../callable-identity-policies/index.js";
import type { CallableIdentityPolicy } from "../callable-identity-policy-types.js";
import { CORE_ALGORITHM_EPOCH, LANGUAGE_BEHAVIOR_EPOCH } from "./epochs.generated.js";
export { CORE_ALGORITHM_EPOCH, LANGUAGE_BEHAVIOR_EPOCH } from "./epochs.generated.js";
export { normalizeLanguageExtensions } from "../../languages.js";

export type ManifestBuildOptions = {
  cache?: BuildOptions["cache"];
  cacheStrict?: boolean;
  useBloomFilters?: boolean;
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
    callableKeyShape?: CallableIdentityPolicy["keyShape"];
    exportedNamePattern?: string;
    capturesDocstrings: boolean;
    bloomUnprobeableIdentifiers: boolean;
    renameMatchesNormalizedIdentifiers: boolean;
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
      callableKeyShape: callableIdentityPolicyFor(definition.id).keyShape,
      ...(definition.exportedNamePattern ? { exportedNamePattern: definition.exportedNamePattern.toString() } : {}),
      capturesDocstrings: definition.capturesDocstrings ?? false,
      bloomUnprobeableIdentifiers: definition.bloomUnprobeableIdentifiers ?? false,
      renameMatchesNormalizedIdentifiers: definition.renameMatchesNormalizedIdentifiers ?? false,
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
 * source text; add an epochs/language/ entry with every hook behavior change.
 * Dormant hook contracts do not affect indexed data yet. A slice activating one
 * must add any indexed data to the descriptor or update the applicable epoch.
 */
export const languageDefinitionFingerprintCoverage: Readonly<Record<keyof LanguageDefinition, true>> = {
  id: true,
  extensions: true,
  structure: true,
  graph: true,
  identifierValidation: true, // Query-only rename validation.
  exportedNamePattern: true, // Included in the declarative fingerprint for detailed graph visibility.
  bloomAlternateKey: true, // Function-valued Bloom behavior is covered by LANGUAGE_BEHAVIOR_EPOCH.
  bloomSourceTokens: true, // Function-valued Bloom behavior is covered by LANGUAGE_BEHAVIOR_EPOCH.
  capturesDocstrings: true, // Included in the declarative fingerprint.
  referenceBlockPriorities: true, // Query-only reference context.
  impactDefinitionTypes: true, // Query-only impact classification.
  usesQueryDrivenLocals: true,
  supportsExportFromReferences: true,
  exportScopeBlockers: true,
  classifyDefinition: true,
  isDeclarationName: true,
  scopeDeclarationNames: true,
  normalizeIdentifier: true,
  renameMatchesNormalizedIdentifiers: true,
  createsBlockScope: true,
  createsFunctionScope: true,
  membersAreImplicitlyInScope: true,
  supportsCrossModuleSymbols: true,
  isTypeOnly: true,
  nodeTypes: true,
  native: true,
  generatedMembers: true,
  generatedMembersMarker: true,
  generatedMemberVisibleAt: true,
  methodVisibleAt: true,
  siteCallsMemberPair: true,
  selfIsInstanceAt: true,
  invokedMemberName: true,
  useSiteMemberName: true,
  isDeclarationSpelling: true,
  referenceSpelling: true, // Query-only reference candidates; no extracted, Bloom, or persisted detailed-graph data.
  referenceRange: true, // Function-valued reference edit ranges are covered by the language behavior epoch.
  bloomProbeName: true,
  bloomUnprobeableIdentifiers: true,
  alternateUseNames: true,
};

/**
 * Changes whenever this package version, a declarative language definition field,
 * or the generated language epoch changes. Behavior-hook edits add an entry under epochs/language/.
 *
 * The explicit epoch parameter exists for regression coverage of this declared
 * cache-invalidation contract.
 */
export function getImplementationFingerprintForEpoch(languageBehaviorEpoch: number): string {
  const definitions = getAllLanguages()
    .map(languageDefinitionFingerprintDescriptor)
    .sort((left, right) => compareStrings(left.id, right.id));
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
    nativeRuntimeFingerprint: getNativeRuntimeFingerprint(),
    implementationFingerprint: getImplementationFingerprint(),
    coreAlgorithmEpoch: CORE_ALGORITHM_EPOCH,
    ...(discovery ? { discovery } : {}),
    ...(languageExtensions ? { languageExtensions } : {}),
  };
}

export function summarizeBuildOptions(opts?: BuildOptions): ManifestBuildOptions {
  return normalizeBuildOptions(opts);
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
  if (!manifestOpts) return ["manifest"];
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
  return {
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
  if (!!normalizedA.resolveNodeModules !== !!normalizedB.resolveNodeModules) {
    return false;
  }
  if (!!normalizedA.dynamicImportHeuristics !== !!normalizedB.dynamicImportHeuristics) {
    return false;
  }
  if (!orderedListsEqual(normalizedA.resolutionHints ?? [], normalizedB.resolutionHints ?? [])) {
    return false;
  }
  return true;
}
