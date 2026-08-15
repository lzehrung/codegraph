import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Piscina } from "piscina";
import { findPackageRoot } from "../util/packageInfo.js";
import type { RawSqlResult } from "./types.js";
import type { RawQueryWorkerTask } from "./rawQueryWorker.js";

export class SqliteQueryDeadlineExceededError extends Error {
  constructor(deadlineMs: number) {
    super(`SQLite query exceeded its ${deadlineMs}ms execution budget and was terminated.`);
    this.name = "SqliteQueryDeadlineExceededError";
  }
}

/** Resolves the compiled worker entry the same way `queryIndexWorker.js` is resolved:
 * a compiled sibling next to this module (production/standalone layouts, where the
 * whole `dist/` tree ships), falling back to the package-root-relative compiled path
 * (vitest running this module from `src/`, where only `dist/` is built). */
export function resolveRawSqlQueryWorkerPath(): string {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.resolve(selfDir, "rawQueryWorker.js");
  if (fs.existsSync(sibling)) return sibling;
  const packageRoot = findPackageRoot(selfDir);
  const compiled = path.join(packageRoot, "dist", "sqlite", "rawQueryWorker.js");
  if (fs.existsSync(compiled)) return compiled;
  throw new Error(`Raw SQLite query worker file not found: ${compiled}`);
}

/**
 * Runs a single bounded raw SQL read in a dedicated worker thread with a hard execution
 * deadline. A fresh single-thread pool is created per call and destroyed afterward —
 * matching the existing `prepareQueryIndexFilesInWorker` pattern — since `query_sqlite`
 * calls are interactive, not a hot loop, and a persistent pool would need a shutdown hook
 * this module has no access to register.
 *
 * On deadline expiry, Piscina's `signal` option force-terminates the worker thread
 * (`worker.terminate()`) and rejects immediately — the caller never waits longer than
 * `deadlineMs`, and the host event loop is never blocked by the query regardless of how
 * long it runs. Cancellation is real (no further JS runs on that thread and the query
 * can never touch this process's caller again), but it has one unavoidable limit shared
 * by every in-process cancellation mechanism: `terminate()` cannot preempt a single
 * already-in-flight synchronous native call. A query whose entire cost is inside one
 * `sqlite3_step()` — a recursive CTE, or a plan that must fully sort/scan before it can
 * produce a first row — keeps running on the orphaned worker thread in the background
 * until that native call returns naturally; only then does the thread actually exit.
 * We do not make the caller wait for that: `pool.destroy()` is fired and forgotten here,
 * not awaited, so a subsequent query (in its own fresh pool) is never delayed by it.
 * Concurrent read-only SQLite connections against the same file do not block each other,
 * so the lingering background reader does not stop that subsequent query from succeeding.
 * Verified directly: an aborted 200M-row recursive-CTE count rejects this call in
 * ~`deadlineMs`, and an immediately following query against the same file succeeds in
 * milliseconds. The one place the orphaned thread is still observable is process
 * shutdown: Node cannot fully tear a process down while one of its Worker threads is
 * blocked in native code, so a process exit racing a runaway query can itself be
 * delayed until that native call returns — a platform limit of `worker_threads`, not of
 * this module, and orthogonal to the per-call deadline this function guarantees.
 */
export async function runRawSqlQueryInWorker(task: RawQueryWorkerTask, deadlineMs: number): Promise<RawSqlResult> {
  const workerPath = resolveRawSqlQueryWorkerPath();
  const pool = new Piscina({
    filename: workerPath,
    minThreads: 1,
    maxThreads: 1,
    idleTimeout: 5_000,
  });
  try {
    return (await pool.run(task, { signal: AbortSignal.timeout(deadlineMs) })) as RawSqlResult;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new SqliteQueryDeadlineExceededError(deadlineMs);
    }
    throw error;
  } finally {
    void pool.destroy().catch(() => {});
  }
}
