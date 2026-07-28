import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Piscina } from "piscina";
import { findPackageRoot } from "../../cli/packageInfo.js";
import type { PreparedQueryIndexFile } from "./content.js";
import type { QueryIndexWorkerTask } from "./queryIndexWorker.js";

const QUERY_INDEX_MAX_THREADS = 4;

function resolveWorkerThreads(): number {
  return Math.min(Math.max(os.availableParallelism() - 1, 1), QUERY_INDEX_MAX_THREADS);
}

export function resolveQueryIndexWorkerPath(): string {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.resolve(selfDir, "queryIndexWorker.js");
  if (fs.existsSync(sibling)) return sibling;
  const packageRoot = findPackageRoot(selfDir);
  const compiled = path.join(packageRoot, "dist", "agent", "query-index", "queryIndexWorker.js");
  if (fs.existsSync(compiled)) return compiled;
  throw new Error(`Query index worker file not found: ${compiled}`);
}

export async function prepareQueryIndexFilesInWorker(
  projectRoot: string,
  files: readonly Pick<QueryIndexWorkerTask, "relativePath" | "sourceIdentity">[],
): Promise<PreparedQueryIndexFile[] | null> {
  if (!files.length) return [];
  const threads = Math.min(resolveWorkerThreads(), files.length);
  const pool = new Piscina({
    filename: resolveQueryIndexWorkerPath(),
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
    if (prepared.some((file) => !file)) return null;
    return prepared.flatMap((file) => (file ? [file] : []));
  } finally {
    await pool.destroy();
  }
}
