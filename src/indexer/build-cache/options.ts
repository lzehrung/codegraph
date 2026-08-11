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

export type ManifestBuildOptions = {
  cache?: BuildOptions["cache"];
  cacheStrict?: boolean;
  useBloomFilters?: boolean;
  incrementalStrict?: boolean;
  nativeRuntimeFingerprint?: string;
  implementationFingerprint?: string;
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
    grammar: string;
    classifyDefinition?: string;
    isDeclarationName?: string;
    createsBlockScope?: string;
    createsFunctionScope?: string;
    isTypeOnly?: string;
  };
};

let cachedImplementationFingerprint: string | undefined;

function functionSource(value: unknown): string | undefined {
  return typeof value === "function" ? Function.prototype.toString.call(value) : undefined;
}

function languageDefinitionFingerprintDescriptor(definition: LanguageDefinition): LanguageDefinitionFingerprintDescriptor {
  const native = definition.native;
  const nativeNormalizeQuery = functionSource(native?.normalizeQuery);
  const classifyDefinition = functionSource(definition.classifyDefinition);
  const isDeclarationName = functionSource(definition.isDeclarationName);
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
      grammar: functionSource(definition.grammar) ?? "",
      ...(classifyDefinition ? { classifyDefinition } : {}),
      ...(isDeclarationName ? { isDeclarationName } : {}),
      ...(createsBlockScope ? { createsBlockScope } : {}),
      ...(createsFunctionScope ? { createsFunctionScope } : {}),
      ...(isTypeOnly ? { isTypeOnly } : {}),
    },
  };
}

/**
 * Changes whenever this package version or a loaded language definition changes.
 * The descriptor is generated from the definitions and their Tree-sitter queries so
 * definition/query edits cannot silently outlive an on-disk index.
 */
export function getImplementationFingerprint(): string {
  if (cachedImplementationFingerprint) return cachedImplementationFingerprint;
  const definitions = getAllLanguages()
    .map(languageDefinitionFingerprintDescriptor)
    .sort((left, right) => left.id.localeCompare(right.id));
  const hash = crypto.createHash("sha256");
  hash.update("codegraph-implementation-fingerprint-v1");
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

export { normalizeLanguageExtensions } from "../../languages.js";

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
