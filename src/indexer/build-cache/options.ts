import path from "node:path";
import type { GraphBuildOptions } from "../../graphs/types.js";
import { normalizePath, normalizeResolutionHints } from "../../util/paths.js";
import type { ProjectFileDiscoveryOptions } from "../../util/projectFiles.js";
import type { BuildOptions } from "../types.js";

export type ManifestBuildOptions = {
  cache?: BuildOptions["cache"];
  cacheStrict?: boolean;
  useBloomFilters?: boolean;
  preset?: BuildOptions["preset"];
  incrementalStrict?: boolean;
  discovery?: {
    includeGlobs?: string[];
    ignoreGlobs?: string[];
    globRoot?: string;
    gitignoreRoot?: string;
    useGitignore: boolean;
  };
  languageExtensions?: Record<string, string>;
};

function normalizeManifestBuildOptions(opts?: ManifestBuildOptions): ManifestBuildOptions {
  const languageExtensions = normalizeLanguageExtensions(opts?.languageExtensions);
  return {
    cache: opts?.cache ?? "off",
    cacheStrict: opts?.cacheStrict ?? true,
    useBloomFilters: opts?.useBloomFilters ?? true,
    preset: opts?.preset,
    incrementalStrict: opts?.incrementalStrict ?? false,
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

function normalizeLanguageExtensions(extensions?: Record<string, string>): Record<string, string> | undefined {
  const entries = Object.entries(extensions ?? {})
    .map(([key, value]) => [key.trim().toLowerCase(), value.trim()] as const)
    .filter(([key, value]) => key && value)
    .sort((left, right) => left[0].localeCompare(right[0]));
  if (!entries.length) return undefined;
  return Object.fromEntries(entries);
}

function normalizeBuildOptions(opts?: BuildOptions): ManifestBuildOptions {
  const discovery = normalizeDiscoveryOptions(opts?.discovery);
  const languageExtensions = normalizeLanguageExtensions(opts?.languageExtensions);
  return {
    cache: opts?.cache ?? "off",
    cacheStrict: opts?.cacheStrict ?? true,
    useBloomFilters: opts?.useBloomFilters ?? true,
    preset: opts?.preset,
    incrementalStrict: opts?.incrementalStrict ?? false,
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
  if (!manifestOpts) return [];
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
  if (normalizedManifest.preset !== normalizedCurrent.preset) diffs.push("preset");
  if (normalizedManifest.incrementalStrict !== normalizedCurrent.incrementalStrict) {
    diffs.push("incrementalStrict");
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
