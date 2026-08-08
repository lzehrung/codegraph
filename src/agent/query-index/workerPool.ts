import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Piscina } from "piscina";
import { findPackageRoot } from "../../cli/packageInfo.js";
import { prepareQueryIndexFile, type PreparedQueryIndexFile } from "./content.js";
import { resolveQueryIndexSourcePath } from "./paths.js";
import { resolveWorkerThreadCount } from "../../util/workerThreads.js";
import type { QueryIndexWorkerTask } from "./queryIndexWorker.js";

const QUERY_INDEX_MAX_THREADS = 4;

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
async function prepareQueryIndexFilesInProcess(
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
