import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Piscina } from "piscina";
import { findPackageRoot } from "../../util/packageInfo.js";
import { prepareQueryIndexFile, type PreparedQueryIndexFile } from "./content.js";
import { resolveQueryIndexSourcePath } from "./paths.js";
import { resolveWorkerThreadCount } from "../../util/workerThreads.js";
import { markWindowsProcessDrainRequired } from "../../util/windowsProcessDrain.js";
import type { QueryIndexWorkerTask } from "./queryIndexWorker.js";

const QUERY_INDEX_MAX_THREADS = 4;

/**
 * Every worker thread imports the language registry before it can prepare its first file, so a
 * pool costs a fixed few hundred milliseconds of startup no matter how small the batch is.
 * Measured against in-process preparation, the pool only pulls ahead from around this many
 * files; below it the pool adds latency and worker-thread churn and nothing else.
 */
export const QUERY_INDEX_WORKER_MIN_FILES = 512;

/**
 * A batch is worth a pool only when it is large enough to amortize thread startup and there is
 * more than one worker to spread it across. A single worker cannot parallelize anything, so it
 * pays the startup cost and the per-task structured clone to run the same work serially:
 * measured at roughly 1.5x the in-process time at every batch size. Hosts with one or two
 * available CPUs resolve to exactly one worker, so they always prepare in-process.
 */
export function shouldPrepareQueryIndexFilesInWorker(fileCount: number, threadCount = resolveWorkerThreads()): boolean {
  return threadCount > 1 && fileCount >= QUERY_INDEX_WORKER_MIN_FILES;
}

function resolveWorkerThreads(): number {
  return resolveWorkerThreadCount({ max: QUERY_INDEX_MAX_THREADS });
}

export function resolveQueryIndexWorkerPath(): string {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.resolve(selfDir, "queryIndexWorker.js");
  if (fs.existsSync(sibling)) return sibling;
  const packageRoot = findPackageRoot(selfDir);
  const compiled = path.join(packageRoot, "dist", "agent", "query-index", "queryIndexWorker.js");
  if (fs.existsSync(compiled)) return compiled;
  const bundled = path.join(packageRoot, "dist", "bin", "queryIndexWorker.js");
  if (fs.existsSync(bundled)) return bundled;
  throw new Error(`Query index worker file not found: ${bundled}`);
}
export async function prepareQueryIndexFilesInProcess(
  projectRoot: string,
  files: readonly Pick<QueryIndexWorkerTask, "relativePath" | "sourceIdentity">[],
): Promise<PreparedQueryIndexFile[] | null> {
  const prepared = await Promise.all(
    files.map(async (file) => {
      const absolutePath = resolveQueryIndexSourcePath(projectRoot, file.relativePath);
      return await prepareQueryIndexFile({
        absolutePath,
        path: file.relativePath,
        sourceIdentity: file.sourceIdentity,
      });
    }),
  );
  const usable = prepared.flatMap((file) => (file ? [file] : []));
  if (!usable.length) return null;
  return usable;
}

export async function prepareQueryIndexFilesInWorker(
  projectRoot: string,
  files: readonly Pick<QueryIndexWorkerTask, "relativePath" | "sourceIdentity">[],
): Promise<PreparedQueryIndexFile[] | null> {
  if (!files.length) return [];
  const threads = Math.min(resolveWorkerThreads(), files.length);

  let workerPath: string;
  try {
    workerPath = resolveQueryIndexWorkerPath();
  } catch {
    return await prepareQueryIndexFilesInProcess(projectRoot, files);
  }

  markWindowsProcessDrainRequired();
  const pool = new Piscina({
    filename: workerPath,
    minThreads: 1,
    maxThreads: threads,
    maxQueue: Math.max(threads * 4, files.length),
    idleTimeout: 10_000,
  });
  try {
    const prepared = await Promise.all(
      files.map(
        (file) =>
          pool.run({
            projectRoot,
            relativePath: file.relativePath,
            sourceIdentity: file.sourceIdentity,
          } satisfies QueryIndexWorkerTask) as Promise<PreparedQueryIndexFile | null>,
      ),
    );
    const usable = prepared.flatMap((file) => (file ? [file] : []));
    // A file that cannot be prepared (removed mid-scan, or a transient EMFILE/ENOMEM on a
    // loaded machine) must not discard the whole batch: indexing the remaining files keeps
    // the sidecar usable and self-heals on the next run, because the stored source
    // identities will not match the current snapshot. Only a batch that produced nothing
    // is treated as a real preparation failure worth degrading to the in-memory matcher.
    if (!usable.length) return null;
    return usable;
  } catch {
    return await prepareQueryIndexFilesInProcess(projectRoot, files);
  } finally {
    await pool.destroy();
  }
}

/**
 * Prepares an indexing batch on whichever path is cheaper for its size. Both paths share the
 * partial-batch contract: files that cannot be prepared are dropped, and only a batch that
 * produced nothing at all reports a preparation failure.
 */
export async function prepareQueryIndexFiles(
  projectRoot: string,
  files: readonly Pick<QueryIndexWorkerTask, "relativePath" | "sourceIdentity">[],
): Promise<PreparedQueryIndexFile[] | null> {
  if (!files.length) return [];
  if (!shouldPrepareQueryIndexFilesInWorker(files.length)) {
    return await prepareQueryIndexFilesInProcess(projectRoot, files);
  }
  return await prepareQueryIndexFilesInWorker(projectRoot, files);
}
