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

/** Hard wall-clock budget for a single raw `query_sqlite` execution. */
export const DEFAULT_SQLITE_QUERY_DEADLINE_MS = 10_000;

export type QueryGraphSqliteRawOptions = {
  maxRows?: number | undefined;
  maxBytes?: number | undefined;
  maxCellBytes?: number | undefined;
  deadlineMs?: number | undefined;
  signal?: AbortSignal | undefined;
};

/**
 * Runs a bounded read-only raw SQL query.
 *
 * Preferred path: the query executes in a dedicated worker thread with a hard
 * `deadlineMs` budget (`rawQueryWorkerPool.ts`). On expiry the worker thread is
 * terminated outright, which stops the query even while it is blocked inside a single
 * synchronous `DatabaseSync` call — a client disconnect or a slow non-recursive
 * statement (large join, `ORDER BY random()`, ...) can no longer hold the host event
 * loop hostage indefinitely.
 *
 * Degraded fallback: if the compiled worker asset cannot be located (a corrupted or
 * partial install — the normal build/publish/standalone pipelines all ship it), the
 * query instead runs in-process under a *per-row* elapsed-time budget. That fallback is
 * strictly weaker: the budget is only checked between rows the native iterator has
 * already produced, so a statement that is slow to produce its very first row (for
 * example a full-table scan with no matching rows) is not bounded by it. It exists to
 * keep the common case usable in a degraded install, not as a substitute for the worker
 * deadline.
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

/** Throws once the wall-clock deadline has passed between two already-produced rows. See
 * the fallback caveat on `queryGraphSqliteRaw`: a slow-before-first-row query is not
 * caught here, only slow-*between*-rows iteration is. */
function* withPerRowDeadline<T>(
  rows: Iterable<T>,
  deadlineAt: number,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Generator<T> {
  for (const row of rows) {
    if (signal?.aborted) throw new SqliteQueryCancelledError();
    if (Date.now() > deadlineAt) {
      throw new SqliteQueryDeadlineExceededError(deadlineMs);
    }
    yield row;
  }
}
