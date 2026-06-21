import fs from "node:fs";
import type { ManifestFileEntry } from "./build-cache.js";
import type { IncrementalBuildOptions } from "./types.js";

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
