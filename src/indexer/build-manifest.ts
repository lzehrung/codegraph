import fsp from "node:fs/promises";
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
import { cacheRelativePath, pruneDiskModuleCache } from "./build-cache/module-cache.js";
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

function recordManifestTimingStep(timings: BuildReport["timings"] | undefined, name: string, startedAt: number): void {
  if (!timings) return;
  (timings.steps ??= []).push({ name, ms: Math.round(performance.now() - startedAt) });
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
  resolverEnvironmentFingerprint?: string;
  /** When present, used verbatim instead of hashing config files again. */
  configHash?: { hash: string; error?: string };
}): Promise<void> {
  const files = args.files instanceof Map ? Object.fromEntries(args.files) : args.files;
  if (!Object.keys(files).length && !args.allowEmpty) return;
  const writeManifestStart = performance.now();
  const gitHeadStartedAt = performance.now();
  const lastCommit = await getGitHead(args.projectRoot);
  recordManifestTimingStep(args.timings, "git-head", gitHeadStartedAt);
  const configHashStartedAt = performance.now();
  const configHashResult = args.configHash ?? (await computeConfigHash(args.projectRoot, args.opts?.logLevel));
  recordManifestTimingStep(args.timings, "config-hash", configHashStartedAt);
  const projectRootMtimeMs =
    args.symlinkDirectories !== undefined ? (await fsp.stat(args.projectRoot)).mtimeMs : undefined;
  const configHash = recordConfigHashResult(args.manifestReport, configHashResult, args.opts?.logLevel);
  const transformStartedAt = performance.now();
  const manifestData: IndexManifest = {
    version: MANIFEST_VERSION,
    projectRoot: path.resolve(args.projectRoot).replace(/\\/g, "/"),
    updatedAt: Date.now(),
    ...(lastCommit ? { lastCommit } : {}),
    ...(configHash ? { configHash } : {}),
    graphOptions: args.graphOptions,
    buildOptions: summarizeBuildOptions(args.opts),
    ...(args.resolverEnvironmentFingerprint
      ? { resolverEnvironmentFingerprint: args.resolverEnvironmentFingerprint }
      : {}),
    files: transformManifestEntries(args.projectRoot, files, true),
    transientFiles: (args.transientFiles ?? []).map((file) =>
      path.relative(args.projectRoot, file).replace(/\\/g, "/"),
    ),
    ...(args.symlinkDirectories !== undefined
      ? {
          symlinkDirectories: args.symlinkDirectories.map((directory) =>
            cacheRelativePath(args.projectRoot, directory),
          ),
          ...(projectRootMtimeMs !== undefined ? { symlinkDirectoriesRootMtimeMs: projectRootMtimeMs } : {}),
        }
      : {}),
  };
  recordManifestTimingStep(args.timings, "manifest-transform", transformStartedAt);
  const manifestWriteStartedAt = performance.now();
  const manifestWritten = await writeManifest(args.projectRoot, args.opts, manifestData);
  recordManifestTimingStep(args.timings, "manifest-write", manifestWriteStartedAt);
  if (manifestWritten) {
    // Time this only when pruning actually runs. A failed manifest write skips it, and a
    // recorded step would report work that never happened.
    const cachePruneStartedAt = performance.now();
    pruneDiskModuleCache(args.projectRoot, Object.keys(files), args.opts);
    recordManifestTimingStep(args.timings, "cache-prune", cachePruneStartedAt);
  }
  if (args.timings) {
    args.timings.writeManifestMs = Math.round(performance.now() - writeManifestStart);
  }
}
