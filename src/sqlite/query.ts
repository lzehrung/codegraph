import { isReadOnlySqliteError } from "../sqlite-driver.js";
import type { RawSqlResult } from "./types.js";
import { assertReadOnlyQueryStatement, withReadOnlySqliteDatabase } from "./database.js";
import {
  collectBoundedRawSqlRows,
  DEFAULT_SQLITE_BYTE_LIMIT,
  MAX_SQLITE_CELL_BYTES,
  MAX_SQLITE_ROW_LIMIT,
  normalizeSqliteRowLimit,
} from "./rowBounds.js";
import {
  resolveRawSqlQueryWorkerPath,
  runRawSqlQueryInWorker,
  SqliteQueryCancelledError,
  SqliteQueryDeadlineExceededError,
} from "./rawQueryWorkerPool.js";

export { queryGraphSqlite } from "./canned-query.js";
export { SqliteQueryCancelledError, SqliteQueryDeadlineExceededError };

/** Hard wall-clock budget for a single raw `query_sqlite` execution - see the caveat on
 * `queryGraphSqliteRaw` about when this is actually enforceable. */
export const DEFAULT_SQLITE_QUERY_DEADLINE_MS = 10_000;

export type QueryGraphSqliteRawOptions = {
  maxRows?: number | undefined;
  maxBytes?: number | undefined;
  maxCellBytes?: number | undefined;
  deadlineMs?: number | undefined;
  signal?: AbortSignal | undefined;
};

let loggedInProcessDeadlineFallback = false;
/**
 * Runs a bounded read-only raw SQL query.
 *
 * Preferred path: the query executes in a dedicated worker thread with a hard
 * `deadlineMs` budget (`rawQueryWorkerPool.ts`). At expiry the caller receives a
 * deadline error and the pool requests worker termination. A synchronous
 * `DatabaseSync` call already inside SQLite may continue until that native step returns,
 * but the lifecycle retains a bounded cleanup slot and the host event loop stays free.
 *
 * Degraded fallback: if the compiled worker asset cannot be located (a corrupted or
 * partial install - the normal build/publish/standalone pipelines all ship it), the
 * query instead runs in-process under a *per-row* elapsed-time budget. `node:sqlite`'s
 * `DatabaseSync` exposes no interrupt/cancellation API, so once execution is inside a
 * single synchronous native call there is nothing in-process that can preempt it.
 *
 * The fallback checks only after each native iterator step returns, including a terminal
 * empty result. A statement that is slow to produce its first row or discover that it
 * has no rows still blocks for its full cost before the deadline can be observed. This
 * fallback exists to keep a degraded install usable, not as a substitute for the worker
 * deadline; a one-time process warning makes the weakened guarantee observable.
 */
export async function queryGraphSqliteRaw(
  outputPath: string,
  sql: string,
  params: Array<string | number | null> = [],
  options?: QueryGraphSqliteRawOptions,
): Promise<RawSqlResult> {
  const maxRows = normalizeSqliteRowLimit(options?.maxRows ?? MAX_SQLITE_ROW_LIMIT);
  const maxBytes = options?.maxBytes ?? DEFAULT_SQLITE_BYTE_LIMIT;
  const maxCellBytes = options?.maxCellBytes ?? MAX_SQLITE_CELL_BYTES;
  const deadlineMs = options?.deadlineMs ?? DEFAULT_SQLITE_QUERY_DEADLINE_MS;

  try {
    resolveRawSqlQueryWorkerPath();
  } catch {
    if (!loggedInProcessDeadlineFallback) {
      loggedInProcessDeadlineFallback = true;
      console.error(
        "[codegraph] Raw SQLite query worker asset is unavailable; falling back to an in-process " +
          "execution deadline that is only checked between produced rows and cannot interrupt a " +
          "single blocking native call. Reinstall to restore the enforced worker-thread deadline.",
      );
    }
    return await queryGraphSqliteRawInProcessBounded(outputPath, sql, params, {
      maxRows,
      maxBytes,
      maxCellBytes,
      deadlineMs,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  return await runRawSqlQueryInWorker(
    { outputPath, sql, params, maxRows, maxBytes, maxCellBytes },
    deadlineMs,
    options?.signal,
  );
}

/** Degraded fallback for `queryGraphSqliteRaw` - see its doc comment for the enforcement
 * caveat this path cannot avoid. */
async function queryGraphSqliteRawInProcessBounded(
  outputPath: string,
  sql: string,
  params: Array<string | number | null>,
  bounds: { maxRows: number; maxBytes: number; maxCellBytes: number; deadlineMs: number; signal?: AbortSignal },
): Promise<RawSqlResult> {
  if (bounds.signal?.aborted) throw new SqliteQueryCancelledError();
  return await withReadOnlySqliteDatabase(outputPath, (db) => {
    try {
      const stmt = db.prepare(sql);
      assertReadOnlyQueryStatement(stmt);
      const columns = stmt.columns().map((col) => col.name);
      const deadlineAt = Date.now() + bounds.deadlineMs;
      const rows = withPerRowDeadline(
        stmt.raw().iterate(params) as Iterable<Array<unknown>>,
        deadlineAt,
        bounds.deadlineMs,
        bounds.signal,
      );
      // Always stream via iterate so per-cell and cumulative budgets apply before append.
      return collectBoundedRawSqlRows(columns, rows, {
        maxRows: bounds.maxRows,
        maxBytes: bounds.maxBytes,
        maxCellBytes: bounds.maxCellBytes,
      });
    } catch (error) {
      if (isReadOnlySqliteError(error)) {
        throw new Error("Raw SQLite queries must be read-only result-producing statements such as SELECT or PRAGMA.");
      }
      throw error;
    }
  });
}

/** Throws once the wall-clock deadline has passed after a native iterator step returns.
 * See the fallback caveat on `queryGraphSqliteRaw`: a slow-before-first-row query is not
 * interrupted here, only detected after that synchronous iteration step completes. */
function* withPerRowDeadline<T>(
  rows: Iterable<T>,
  deadlineAt: number,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Generator<T> {
  const iterator = rows[Symbol.iterator]();
  while (true) {
    if (signal?.aborted) throw new SqliteQueryCancelledError();
    const next = iterator.next();
    if (Date.now() > deadlineAt) {
      throw new SqliteQueryDeadlineExceededError(deadlineMs);
    }
    if (next.done) return;
    yield next.value;
  }
}
