import fs from "node:fs";
import fsp from "node:fs/promises";
import {
  diffBuildOptions,
  loadManifest,
  sanitizeManifestEntriesForRoot,
  type ManifestFileEntry,
} from "./build-cache.js";
import type { BuildOptions, IncrementalBuildOptions } from "./types.js";
import { listChangedFiles, listUntrackedFiles } from "../util/git.js";
import { errorMessage } from "../util/errors.js";
import { fileIdentityKey } from "../util/paths.js";
import { mapLimit } from "../util/concurrency.js";
import {
  createDiscoveredFileMatcher,
  DEFAULT_PROJECT_PATTERNS,
  filterRealPathsWithinRoot,
  type ProjectFileDiscoveryOptions,
} from "../util/projectFiles.js";

export type IncrementalGitDiffOptions = {
  base?: string;
  head?: string;
  changedSince?: string;
};

export type TrackedManifestFilePlan = {
  trackedFileList: string[];
  trackedFiles: Set<string>;
  deletedTrackedFiles: Set<string>;
};

/** Bound concurrent existence probes so warm builds don't stall the event loop. */
export const PATH_EXISTS_PROBE_CONCURRENCY = 64;

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe unique paths once with bounded concurrency. Scaling: O(unique paths)
 * syscalls instead of O(call sites × paths).
 */
export async function probePathExistence(
  paths: readonly string[],
  concurrency: number = PATH_EXISTS_PROBE_CONCURRENCY,
): Promise<Map<string, boolean>> {
  const uniquePaths = Array.from(new Set(paths));
  const results = await mapLimit(uniquePaths, concurrency, async (filePath) => {
    return [filePath, await pathExists(filePath)] as const;
  });
  return new Map(results);
}

export function isMissingGitRevisionError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("Invalid revision range") ||
    message.includes("bad revision") ||
    // A single-revision diff against WORKTREE (git diff --end-of-options <base>) reports
    // a missing base commit as "bad object", not "bad revision" (that phrasing is
    // specific to two-dot/three-dot range syntax); both mean the same thing here.
    message.includes("bad object") ||
    message.includes("unknown revision") ||
    message.includes("ambiguous argument")
  );
}

export function buildIncrementalGitDiffOptions(opts: IncrementalBuildOptions | undefined): IncrementalGitDiffOptions {
  const gitOpts: IncrementalGitDiffOptions = {};
  if (opts?.gitBase) gitOpts.base = opts.gitBase;
  if (opts?.gitHead) gitOpts.head = opts.gitHead;
  if (!opts?.gitBase && opts?.changedSince) gitOpts.changedSince = opts.changedSince;
  return gitOpts;
}

export async function partitionTrackedManifestFiles(
  trackedEntries: Record<string, ManifestFileEntry>,
  concurrency: number = PATH_EXISTS_PROBE_CONCURRENCY,
): Promise<TrackedManifestFilePlan> {
  const trackedFileList = Object.keys(trackedEntries);
  const existence = await probePathExistence(trackedFileList, concurrency);
  const trackedFiles = new Set<string>();
  const deletedTrackedFiles = new Set<string>();
  for (const file of trackedFileList) {
    if (existence.get(file)) trackedFiles.add(file);
    else deletedTrackedFiles.add(file);
  }
  return {
    trackedFileList,
    trackedFiles,
    deletedTrackedFiles,
  };
}

export function collectDeletedTrackedFileDependents(
  trackedEntries: Record<string, ManifestFileEntry>,
  deletedTrackedFiles: ReadonlySet<string>,
): Set<string> {
  const dependents = new Set<string>();
  if (!deletedTrackedFiles.size) return dependents;
  const deletedFileKeys = new Set(Array.from(deletedTrackedFiles, fileIdentityKey));
  for (const [file, entry] of Object.entries(trackedEntries)) {
    if (deletedFileKeys.has(fileIdentityKey(file))) continue;
    if (entry.edges.some((edge) => edge.to.type === "file" && deletedFileKeys.has(fileIdentityKey(edge.to.path)))) {
      dependents.add(file);
    }
  }
  return dependents;
}

export function buildTrackedFileReverseDependencies(
  trackedEntries: Record<string, ManifestFileEntry>,
): Map<string, Set<string>> {
  const reverseDeps = new Map<string, Set<string>>();
  for (const [file, entry] of Object.entries(trackedEntries)) {
    for (const edge of entry.edges) {
      if (edge.to.type !== "file") continue;
      const importedFileKey = fileIdentityKey(edge.to.path);
      let bucket = reverseDeps.get(importedFileKey);
      if (!bucket) {
        bucket = new Set<string>();
        reverseDeps.set(importedFileKey, bucket);
      }
      bucket.add(file);
    }
  }
  return reverseDeps;
}

export function collectTrackedFileDependents(
  trackedEntries: Record<string, ManifestFileEntry>,
  changedFiles: ReadonlySet<string>,
  reverseDeps = buildTrackedFileReverseDependencies(trackedEntries),
): Set<string> {
  const dependents = new Set<string>();
  if (!changedFiles.size) return dependents;

  const enqueued = new Set(Array.from(changedFiles, fileIdentityKey));
  const queue = [...enqueued];
  let head = 0;
  while (head < queue.length) {
    const targetKey = queue[head]!;
    head += 1;
    for (const dependent of reverseDeps.get(targetKey) ?? []) {
      const dependentKey = fileIdentityKey(dependent);
      if (enqueued.has(dependentKey)) continue;
      enqueued.add(dependentKey);
      dependents.add(dependent);
      queue.push(dependentKey);
    }
  }

  return dependents;
}

/**
 * List new, untracked files that Git sees but the manifest does not yet know about,
 * filtered to the same discovery patterns/ignores a full scan would apply.
 *
 * This is the one piece a manifest-plus-git-diff reconciliation cannot otherwise cover:
 * modified and deleted tracked files are already detected cheaply via git diff and
 * per-file signature checks, but a file that was just created and never committed or
 * staged has no tracked entry and no diff record. Errors are not swallowed here;
 * callers decide whether a failure should fall back to a full scan or be treated as a
 * best-effort miss.
 *
 * When `discovery.useGitignore` is `false`, Git's `--exclude-standard` is dropped too:
 * that mode explicitly wants gitignored files included, so filtering untracked
 * candidates through `.gitignore` here would be exactly backwards. The default
 * project-file ignores (`node_modules`, `.git`, build output, ...) still apply via
 * `createDiscoveredFileMatcher()` below regardless of this setting.
 */
export async function listUntrackedProjectFiles(
  projectRoot: string,
  discovery: ProjectFileDiscoveryOptions | undefined,
  gitAvailable: boolean,
): Promise<string[]> {
  if (!gitAvailable) return [];
  const respectGitignore = discovery?.useGitignore !== false;
  const candidates = await listUntrackedFiles(projectRoot, { gitAvailable, respectGitignore });
  if (!candidates.length) return [];
  const globRoot = discovery?.globRoot ?? projectRoot;
  const isDiscoveredFile = createDiscoveredFileMatcher(projectRoot, globRoot, DEFAULT_PROJECT_PATTERNS, discovery);
  const matchingCandidates = candidates.filter(isDiscoveredFile);
  if (!matchingCandidates.length) return [];
  const realRoot = await fs.promises.realpath(projectRoot);
  return filterRealPathsWithinRoot(matchingCandidates, realRoot);
}

/**
 * Whether the cheap manifest-plus-git discovery path can stand in for a full recursive
 * scan. Requires a Git repository (the only source of untracked-file detection this
 * fast path has) and no `--cache-strict` request (an explicit ask for maximum
 * certainty over speed). `useGitignore: false` no longer disqualifies the fast path:
 * `listUntrackedProjectFiles()` drops `--exclude-standard` in that mode instead of
 * giving up, so it stays correct either way.
 */
export function canUseIncrementalDiscoveryFastPath(gitAvailable: boolean, cacheStrict: boolean | undefined): boolean {
  return gitAvailable && !cacheStrict;
}

/**
 * Resolve the current project file list from the on-disk manifest plus a cheap Git
 * reconciliation, without building or parsing anything. Returns `null` whenever the
 * fast path cannot be trusted to be complete: no manifest yet, a discovery-option
 * change since the manifest was written, no Git repository, `--cache-strict`, or a
 * Git command failure (most commonly a manifest commit that no longer exists, e.g.
 * after a rebase or shallow-clone gc). Callers must fall back to a full
 * `listProjectFiles()` scan when this returns `null`.
 */
export type IncrementalFilePlan = {
  files: string[];
  manifestUpdatedAt: number;
  workingTreeDiffFiles: string[];
  untrackedFiles: string[];
};

export async function resolveIncrementalFilePlan(
  projectRoot: string,
  opts: BuildOptions | undefined,
): Promise<IncrementalFilePlan | null> {
  const manifest = await loadManifest(projectRoot, opts);
  if (!manifest) return null;
  if (!manifest.buildOptions) return null;
  if (diffBuildOptions(manifest.buildOptions, opts).includes("discovery")) return null;

  if (opts?.cacheStrict) return null;

  try {
    const trackedEntries = sanitizeManifestEntriesForRoot(projectRoot, manifest.files);
    const { trackedFiles } = await partitionTrackedManifestFiles(trackedEntries);

    // Diff against the working tree, not just the current commit: a file that was
    // `git add`ed but never committed is neither in the manifest (not yet indexed) nor
    // reported by `git ls-files --others` (it is no longer "untracked" once staged), so
    // a commit-only diff would miss it entirely whenever HEAD hasn't moved. Diffing the
    // last-indexed commit against WORKTREE catches staged and unstaged tracked-file
    // changes together, including new commits made since (working tree reflects those
    // too when clean), so this replaces the narrower commit-to-commit comparison.
    const [workingTreeDiffFiles, untrackedFiles] = await Promise.all([
      manifest.lastCommit ? listChangedFiles(projectRoot, { base: manifest.lastCommit, head: "WORKTREE" }) : [],
      listUntrackedProjectFiles(projectRoot, opts?.discovery, true),
    ]);

    const candidatePaths = [...workingTreeDiffFiles, ...untrackedFiles];
    const existence = candidatePaths.length ? await probePathExistence(candidatePaths) : new Map<string, boolean>();
    const files = new Set<string>(trackedFiles);
    for (const file of workingTreeDiffFiles) if (existence.get(file)) files.add(file);
    for (const file of untrackedFiles) if (existence.get(file)) files.add(file);
    return {
      files: Array.from(files).sort(),
      manifestUpdatedAt: manifest.updatedAt,
      workingTreeDiffFiles,
      untrackedFiles,
    };
  } catch {
    // Any failure here (stale/missing manifest commit, transient Git error, ...) means
    // the fast path cannot be trusted. Fall back to a full scan rather than risk an
    // incomplete or stale file list.
    return null;
  }
}
export async function resolveIncrementalFileList(
  projectRoot: string,
  opts: BuildOptions | undefined,
): Promise<string[] | null> {
  const plan = await resolveIncrementalFilePlan(projectRoot, opts);
  return plan?.files ?? null;
}
