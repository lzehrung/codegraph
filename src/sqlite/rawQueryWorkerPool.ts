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

/** Resolves the compiled worker entry: a compiled sibling next to this module
 * (production/standalone layouts, where the whole `dist/` tree ships), falling back to
 * the package-root-relative compiled path (running this module from `src/`, where only
 * `dist/` is built). Throwing here is the trigger `queryGraphSqliteRaw` uses to fall
 * back to the strictly weaker in-process per-row deadline check. */
export function resolveRawSqlQueryWorkerPath(): string {
  const selfDirectory = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.resolve(selfDirectory, "rawQueryWorker.js");
  if (fs.existsSync(sibling)) return sibling;
  const packageRoot = findPackageRoot(selfDirectory);
  const compiled = path.join(packageRoot, "dist", "sqlite", "rawQueryWorker.js");
  if (fs.existsSync(compiled)) return compiled;
  throw new Error(`Raw SQLite query worker file not found: ${compiled}`);
}

/**
 * Runs a single bounded raw SQL read in a dedicated worker thread with a hard execution
 * deadline. On expiry, Piscina's `signal` option force-terminates the worker thread and
 * rejects immediately — the caller never waits longer than `deadlineMs`, regardless of
 * how long the underlying query actually takes, because termination does not need the
 * blocked thread's cooperation. `pool.destroy()` is fire-and-forget rather than awaited,
 * so an orphaned worker still finishing one already-in-flight synchronous native call
 * never delays this call's rejection or a subsequent query against the same file
 * (concurrent read-only SQLite connections do not block each other).
 */
export async function runRawSqlQueryInWorker(task: RawQueryWorkerTask, deadlineMs: number): Promise<RawSqlResult> {
  const pool = new Piscina({
    filename: resolveRawSqlQueryWorkerPath(),
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
