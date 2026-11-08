import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getGitHeadOrEmptyTree, listChangedFileEntries, listFlaggedTrackedFiles } from "../util/git.js";
import { logWithLevel } from "../logging.js";
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
import {
  createDiscoveredFileMatcher,
  DEFAULT_PROJECT_PATTERNS,
  type ProjectDiscoveryContext,
} from "../util/project-files.js";
import { createRootPathMapper } from "../util/paths.js";
import { languageExtensionPatterns } from "../languages.js";
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

/**
 * Store the declared-container index with project-relative file paths, matching how manifest
 * file keys are stored, so a relocated project root does not invalidate the index. Names and
 * file lists are sorted for a stable serialized form.
 */
function serializeDeclaredContainers(
  projectRoot: string,
  index: Map<string, readonly string[]> | Record<string, readonly string[]>,
): Record<string, string[]> {
  const entries = index instanceof Map ? [...index] : Object.entries(index);
  const serialized: Record<string, string[]> = {};
  for (const [name, files] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    serialized[name] = files
      .map((file) => cacheRelativePath(projectRoot, file))
      .sort((left, right) => left.localeCompare(right));
  }
  return serialized;
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
  declaredContainers?: Map<string, readonly string[]> | Record<string, readonly string[]>;
  resolverEnvironmentFingerprint?: string;
  /** When present, used verbatim instead of hashing config files again. */
  configHash?: { hash: string; error?: string };
  /** When present, used for hashing instead of creating a standalone discovery context. */
  discoveryContext?: ProjectDiscoveryContext;
}): Promise<void> {
  const files = args.files instanceof Map ? Object.fromEntries(args.files) : args.files;
  if (!Object.keys(files).length && !args.allowEmpty) return;
  const writeManifestStart = performance.now();
  const gitHeadStartedAt = performance.now();
  const lastCommit = await getGitHeadOrEmptyTree(args.projectRoot, args.discoveryContext?.git);
  recordManifestTimingStep(args.timings, "git-head", gitHeadStartedAt);
  let gitDirtyFiles: string[] | undefined;
  let gitDirtySubmodules: string[] | undefined;
  let gitFlaggedFiles: string[] | undefined;
  if (lastCommit) {
    try {
      // Neither listing is shared with the update that precedes this write: an edit or a flag made while that update ran
      // must be recorded, or the next update would trust a state older than the one it indexed.
      const [changedResult, flaggedResult] = await Promise.allSettled([
        listChangedFileEntries(args.projectRoot, {
          base: lastCommit,
          head: "WORKTREE",
          includeRenameSources: true,
          includeHiddenSubmoduleChanges: true,
        }),
        listFlaggedTrackedFiles(args.projectRoot),
      ]);
      // A failed Git child must not leave the other holding the project directory open.
      if (changedResult.status === "rejected") throw changedResult.reason;
      if (flaggedResult.status === "rejected") throw flaggedResult.reason;
      const changed = changedResult.value;
      const matchesDiscovery = createDiscoveredFileMatcher(
        args.projectRoot,
        args.opts?.discovery?.globRoot ?? args.projectRoot,
        [...DEFAULT_PROJECT_PATTERNS, ...languageExtensionPatterns(args.opts?.languageExtensions)],
        args.opts?.discovery,
      );
      // A submodule is recorded as one directory; its own files are listed when the next update reconciles it.
      const gitlinks = new Set(changed.gitlinks);
      // A dirty file matters to the next update when it is indexed now, or could be once it changes back.
      const mayBeIndexed = (file: string): boolean => Object.hasOwn(files, file) || matchesDiscovery(file);
      gitDirtyFiles = changed.files.filter((file) => !gitlinks.has(file) && mayBeIndexed(file));
      gitDirtySubmodules = changed.gitlinks;
      // Every flagged file is recorded, indexed or not: clearing a flag can bring back a file the index never saw.
      gitFlaggedFiles = flaggedResult.value.map(createRootPathMapper(args.projectRoot).toRelative);
    } catch (error) {
      logWithLevel(
        args.opts?.logLevel,
        "warn",
        "Warning: Failed to record Git worktree changes; incremental updates will reconcile tracked blob ids.",
        error,
      );
    }
  }
  const configHashStartedAt = performance.now();
  const configHashResult =
    args.configHash ?? (await computeConfigHash(args.projectRoot, args.opts?.logLevel, args.discoveryContext));
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
    ...(gitDirtyFiles !== undefined
      ? { gitDirtyFiles: gitDirtyFiles.map((file) => cacheRelativePath(args.projectRoot, file)) }
      : {}),
    ...(gitDirtySubmodules !== undefined
      ? { gitDirtySubmodules: gitDirtySubmodules.map((directory) => cacheRelativePath(args.projectRoot, directory)) }
      : {}),
    ...(gitFlaggedFiles !== undefined ? { gitFlaggedFiles } : {}),
    ...(configHash ? { configHash } : {}),
    graphOptions: args.graphOptions,
    buildOptions: summarizeBuildOptions(args.opts),
    ...(args.resolverEnvironmentFingerprint
      ? { resolverEnvironmentFingerprint: args.resolverEnvironmentFingerprint }
      : {}),
    files: transformManifestEntries(args.projectRoot, files, true),
    ...(args.declaredContainers !== undefined
      ? { declaredContainers: serializeDeclaredContainers(args.projectRoot, args.declaredContainers) }
      : {}),
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
