import fs from "node:fs";
import {
  diffBuildOptions,
  loadManifest,
  sanitizeManifestEntriesForRoot,
  type ManifestFileEntry,
} from "./build-cache.js";
import type { BuildOptions, IncrementalBuildOptions } from "./types.js";
import { getGitHead, isGitRepo, listChangedFiles, listUntrackedFiles } from "../util/git.js";
import {
  createDiscoveredFileMatcher,
  DEFAULT_PROJECT_PATTERNS,
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

export function isMissingGitRevisionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Invalid revision range") ||
    message.includes("bad revision") ||
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

export function partitionTrackedManifestFiles(
  trackedEntries: Record<string, ManifestFileEntry>,
): TrackedManifestFilePlan {
  const trackedFileList = Object.keys(trackedEntries);
  return {
    trackedFileList,
    trackedFiles: new Set(trackedFileList.filter((file) => fs.existsSync(file))),
    deletedTrackedFiles: new Set(trackedFileList.filter((file) => !fs.existsSync(file))),
  };
}

export function collectDeletedTrackedFileDependents(
  trackedEntries: Record<string, ManifestFileEntry>,
  deletedTrackedFiles: ReadonlySet<string>,
): Set<string> {
  const dependents = new Set<string>();
  if (!deletedTrackedFiles.size) return dependents;
  for (const [file, entry] of Object.entries(trackedEntries)) {
    if (deletedTrackedFiles.has(file)) continue;
    if (entry.edges.some((edge) => edge.to.type === "file" && deletedTrackedFiles.has(edge.to.path))) {
      dependents.add(file);
    }
  }
  return dependents;
}

export function collectTrackedFileDependents(
  trackedEntries: Record<string, ManifestFileEntry>,
  changedFiles: ReadonlySet<string>,
): Set<string> {
  const dependents = new Set<string>();
  if (!changedFiles.size) return dependents;

  const reverseDeps = new Map<string, Set<string>>();
  for (const [file, entry] of Object.entries(trackedEntries)) {
    for (const edge of entry.edges) {
      if (edge.to.type !== "file") continue;
      const importedFile = edge.to.path;
      let bucket = reverseDeps.get(importedFile);
      if (!bucket) {
        bucket = new Set<string>();
        reverseDeps.set(importedFile, bucket);
      }
      bucket.add(file);
    }
  }

  const enqueued = new Set<string>(changedFiles);
  const queue = [...changedFiles];
  let head = 0;
  while (head < queue.length) {
    const target = queue[head]!;
    head += 1;
    for (const dependent of reverseDeps.get(target) ?? []) {
      if (enqueued.has(dependent)) continue;
      enqueued.add(dependent);
      dependents.add(dependent);
      queue.push(dependent);
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
 */
export async function listUntrackedProjectFiles(
  projectRoot: string,
  discovery: ProjectFileDiscoveryOptions | undefined,
  gitAvailable: boolean,
): Promise<string[]> {
  if (!gitAvailable || discovery?.useGitignore === false) return [];
  const candidates = await listUntrackedFiles(projectRoot, { gitAvailable, respectGitignore: true });
  if (!candidates.length) return [];
  const globRoot = discovery?.globRoot ?? projectRoot;
  const isDiscoveredFile = createDiscoveredFileMatcher(projectRoot, globRoot, DEFAULT_PROJECT_PATTERNS, discovery);
  return candidates.filter(isDiscoveredFile);
}

/**
 * Whether the cheap manifest-plus-git discovery path can stand in for a full recursive
 * scan. Requires a Git repository (the only source of untracked-file detection this
 * fast path has), a discovery config that still wants gitignore-aware filtering (Git's
 * own `--exclude-standard` is the only gitignore handling this path performs), and no
 * `--cache-strict` request (an explicit ask for maximum certainty over speed).
 */
export function canUseIncrementalDiscoveryFastPath(
  gitAvailable: boolean,
  discovery: ProjectFileDiscoveryOptions | undefined,
  cacheStrict: boolean | undefined,
): boolean {
  return gitAvailable && discovery?.useGitignore !== false && !cacheStrict;
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
export async function resolveIncrementalFileList(
  projectRoot: string,
  opts: BuildOptions | undefined,
): Promise<string[] | null> {
  const manifest = await loadManifest(projectRoot, opts);
  if (!manifest) return null;
  if (diffBuildOptions(manifest.buildOptions, opts).includes("discovery")) return null;

  const gitAvailable = await isGitRepo(projectRoot);
  if (!canUseIncrementalDiscoveryFastPath(gitAvailable, opts?.discovery, opts?.cacheStrict)) return null;

  try {
    const trackedEntries = sanitizeManifestEntriesForRoot(projectRoot, manifest.files);
    const { trackedFiles } = partitionTrackedManifestFiles(trackedEntries);

    const currentHead = await getGitHead(projectRoot);
    let manifestDiffFiles: string[] = [];
    if (manifest.lastCommit && currentHead && manifest.lastCommit !== currentHead) {
      manifestDiffFiles = await listChangedFiles(projectRoot, { base: manifest.lastCommit, head: currentHead });
    }
    const untrackedFiles = await listUntrackedProjectFiles(projectRoot, opts?.discovery, gitAvailable);

    const files = new Set<string>(trackedFiles);
    for (const file of manifestDiffFiles) if (fs.existsSync(file)) files.add(file);
    for (const file of untrackedFiles) if (fs.existsSync(file)) files.add(file);
    return Array.from(files).sort();
  } catch {
    // Any failure here (stale/missing manifest commit, transient Git error, ...) means
    // the fast path cannot be trusted. Fall back to a full scan rather than risk an
    // incomplete or stale file list.
    return null;
  }
}
