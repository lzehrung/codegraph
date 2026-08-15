import path from "node:path";
import { performance } from "node:perf_hooks";
import { getGitHead } from "../util/git.js";
import {
  computeConfigHash,
  MANIFEST_VERSION,
  recordConfigHashResult,
  summarizeBuildOptions,
  transformManifestEntries,
  writeManifest,
  type IndexManifest,
  type ManifestFileEntry,
} from "./build-cache.js";
import { pruneDiskModuleCache } from "./build-cache/module-cache.js";
import type { GraphCacheEntry, GraphBuildOptions } from "../graphs/types.js";
import type { BuildOptions, BuildReport, ManifestReport } from "./types.js";

export function toManifestFileEntry(entry: GraphCacheEntry): ManifestFileEntry | undefined {
  if (!entry.sig) return undefined;
  return {
    sig: entry.sig,
    ...(entry.gitSig ? { gitSig: entry.gitSig } : {}),
    ...(entry.sqlCorpusSig ? { sqlCorpusSig: entry.sqlCorpusSig } : {}),
    edges: entry.edges,
  };
}

export async function writeIndexManifestSnapshot(args: {
  projectRoot: string;
  opts: BuildOptions | undefined;
  graphOptions: GraphBuildOptions;
  files: Map<string, ManifestFileEntry> | Record<string, ManifestFileEntry>;
  timings: BuildReport["timings"] | undefined;
  manifestReport: ManifestReport | undefined;
  allowEmpty?: boolean;
  transientFiles?: string[];
  symlinkDirectories?: string[];
}): Promise<void> {
  const files = args.files instanceof Map ? Object.fromEntries(args.files) : args.files;
  if (!Object.keys(files).length && !args.allowEmpty) return;
  const writeManifestStart = performance.now();
  const lastCommit = await getGitHead(args.projectRoot);
  const configHashResult = await computeConfigHash(args.projectRoot, args.opts?.logLevel);
  const configHash = recordConfigHashResult(args.manifestReport, configHashResult, args.opts?.logLevel);
  const manifestData: IndexManifest = {
    version: MANIFEST_VERSION,
    projectRoot: path.resolve(args.projectRoot).replace(/\\/g, "/"),
    updatedAt: Date.now(),
    ...(lastCommit ? { lastCommit } : {}),
    ...(configHash ? { configHash } : {}),
    graphOptions: args.graphOptions,
    buildOptions: summarizeBuildOptions(args.opts),
    files: transformManifestEntries(args.projectRoot, files, true),
    transientFiles: (args.transientFiles ?? []).map((file) => path.relative(args.projectRoot, file).replace(/\\/g, "/")),
    ...(args.symlinkDirectories !== undefined ? { symlinkDirectories: args.symlinkDirectories } : {}),
  };
  const manifestWritten = await writeManifest(args.projectRoot, args.opts, manifestData);
  if (manifestWritten) pruneDiskModuleCache(args.projectRoot, Object.keys(files), args.opts);
  if (args.timings) {
    args.timings.writeManifestMs = Math.round(performance.now() - writeManifestStart);
  }
}
