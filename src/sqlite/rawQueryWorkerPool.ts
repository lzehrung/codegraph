import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Piscina } from "piscina";
import { findPackageRoot } from "../util/packageInfo.js";
import type { RawSqlResult } from "./types.js";
import type { RawQueryWorkerTask } from "./rawQueryWorker.js";

export const MAX_RAW_SQL_QUERY_WORKERS = 2;

export type RawSqlQueryWorkerPool = {
  run(task: RawQueryWorkerTask, options: { signal: AbortSignal }): Promise<RawSqlResult>;
  destroy(): Promise<void>;
};

type RawSqlQueryWorkerPoolFactory = () => RawSqlQueryWorkerPool;

export type RawSqlQueryWorkerLifecycleState = {
  activeWorkers: number;
  maxWorkers: number;
};

export class SqliteQueryDeadlineExceededError extends Error {
  constructor(deadlineMs: number) {
    super(`SQLite query exceeded its ${deadlineMs}ms execution budget.`);
    this.name = "SqliteQueryDeadlineExceededError";
  }
}

export class SqliteQueryCancelledError extends Error {
  constructor() {
    super("SQLite query was cancelled.");
    this.name = "SqliteQueryCancelledError";
  }
}

export class SqliteQueryWorkerCleanupCapacityExceededError extends Error {
  constructor(maxWorkers: number) {
    super(
      `SQLite query worker capacity is exhausted: ${maxWorkers} active or cleaning-up worker${maxWorkers === 1 ? " is" : "s are"} using the available slots. Retry after a query completes or cleanup finishes.`,
    );
    this.name = "SqliteQueryWorkerCleanupCapacityExceededError";
  }
}

/**
 * Keeps raw-query worker cleanup bounded. A timed-out native SQLite call can delay
 * `Piscina.destroy()` until its current synchronous step returns, so each slot remains
 * reserved until that destroy promise settles instead of being forgotten in the background.
 */
export class RawSqlQueryWorkerLifecycle {
  private readonly activeWorkerSlots = new Set<symbol>();

  constructor(private readonly maxWorkers = MAX_RAW_SQL_QUERY_WORKERS) {}

  state(): RawSqlQueryWorkerLifecycleState {
    return { activeWorkers: this.activeWorkerSlots.size, maxWorkers: this.maxWorkers };
  }

  async run(
    task: RawQueryWorkerTask,
    deadlineMs: number,
    signal: AbortSignal | undefined,
    createPool: RawSqlQueryWorkerPoolFactory,
  ): Promise<RawSqlResult> {
    if (signal?.aborted) throw new SqliteQueryCancelledError();
    const deadlineSignal = AbortSignal.timeout(deadlineMs);
    const combinedSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
    if (this.activeWorkerSlots.size >= this.maxWorkers) {
      throw new SqliteQueryWorkerCleanupCapacityExceededError(this.maxWorkers);
    }

    const slot = Symbol("raw-sql-query-worker");
    this.activeWorkerSlots.add(slot);
    let pool: RawSqlQueryWorkerPool | undefined;
    let cleanupInBackground = false;

    try {
      pool = createPool();
      return await pool.run(task, { signal: combinedSignal });
    } catch (error) {
      if (combinedSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
        cleanupInBackground = true;
        if (signal?.aborted) throw new SqliteQueryCancelledError();
        throw new SqliteQueryDeadlineExceededError(deadlineMs);
      }
      throw error;
    } finally {
      if (!pool) {
        this.activeWorkerSlots.delete(slot);
      } else {
        const cleanup = pool.destroy();
        if (cleanupInBackground) {
          void cleanup.then(
            () => {
              this.activeWorkerSlots.delete(slot);
            },
            () => {
              this.activeWorkerSlots.delete(slot);
            },
          );
        } else {
          try {
            await cleanup;
          } finally {
            this.activeWorkerSlots.delete(slot);
          }
        }
      }
    }
  }
}

const rawSqlQueryWorkerLifecycle = new RawSqlQueryWorkerLifecycle();

export function getRawSqlQueryWorkerLifecycleState(): RawSqlQueryWorkerLifecycleState {
  return rawSqlQueryWorkerLifecycle.state();
}

/** Resolves the compiled worker entry the same way `queryIndexWorker.js` is resolved:
 * a compiled sibling next to this module (production/standalone layouts, where the
 * whole `dist/` tree ships), falling back to the package-root-relative compiled path
 * (vitest running this module from `src/`, where only `dist/` is built). */
export function resolveRawSqlQueryWorkerPath(): string {
  const selfDirectory = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.resolve(selfDirectory, "rawQueryWorker.js");
  if (fs.existsSync(sibling)) return sibling;
  const packageRoot = findPackageRoot(selfDirectory);
  const compiled = path.join(packageRoot, "dist", "sqlite", "rawQueryWorker.js");
  if (fs.existsSync(compiled)) return compiled;
  const bundled = path.join(packageRoot, "dist", "bin", "rawQueryWorker.js");
  if (fs.existsSync(bundled)) return bundled;
  throw new Error(`Raw SQLite query worker file not found: ${bundled}`);
}

/**
 * Runs a single bounded raw SQL read in a dedicated worker thread with a hard execution
 * deadline. A fresh single-thread pool is created per call and destroyed afterward -
 * matching the existing `prepareQueryIndexFilesInWorker` pattern - since `query_sqlite`
 * calls are interactive, not a hot loop, and a persistent pool would need a shutdown hook
 * this module has no access to register.
 *
 * On deadline expiry, Piscina rejects the caller after requesting worker termination, so
 * the caller never waits longer than `deadlineMs` and the host event loop is never
 * blocked by the query. A `terminate()` request cannot preempt a single already-in-flight
 * synchronous native call: a query whose entire cost is inside one `sqlite3_step()`, such
 * as a recursive CTE or a plan that must fully sort or scan before a first row, continues
 * on its orphaned worker thread until that native call returns naturally.
 *
 * The caller does not wait for cleanup, but the lifecycle retains its worker slot until
 * `pool.destroy()` settles. The bounded slot count makes delayed cleanup observable and
 * prevents repeated cancellation from accumulating an unbounded number of workers.
 * Concurrent read-only SQLite connections against the same file do not block each other,
 * so the lingering background reader does not stop that subsequent query from succeeding.
 * Process shutdown can still wait for a Worker blocked in native code, a `worker_threads`
 * platform limit that is orthogonal to this function's prompt caller deadline.
 */
export async function runRawSqlQueryInWorker(
  task: RawQueryWorkerTask,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<RawSqlResult> {
  const workerPath = resolveRawSqlQueryWorkerPath();
  return await rawSqlQueryWorkerLifecycle.run(
    task,
    deadlineMs,
    signal,
    () =>
      new Piscina<RawQueryWorkerTask, RawSqlResult>({
        filename: workerPath,
        minThreads: 1,
        maxThreads: 1,
        idleTimeout: 5_000,
      }),
  );
}
