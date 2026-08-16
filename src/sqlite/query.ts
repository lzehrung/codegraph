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
  SqliteQueryDeadlineExceededError,
} from "./rawQueryWorkerPool.js";

export { queryGraphSqlite } from "./canned-query.js";
export { SqliteQueryDeadlineExceededError };

/** Hard wall-clock budget for a single raw `query_sqlite` execution — see the caveat on
 * `queryGraphSqliteRaw` about when this is actually enforceable. */
export const DEFAULT_SQLITE_QUERY_DEADLINE_MS = 10_000;

export type QueryGraphSqliteRawOptions = {
  maxRows?: number | undefined;
  maxBytes?: number | undefined;
  maxCellBytes?: number | undefined;
  deadlineMs?: number | undefined;
};

let loggedInProcessDeadlineFallback = false;

/**
 * Runs a bounded read-only raw SQL query.
 *
 * Preferred path: the query executes in a dedicated worker thread with a hard
 * `deadlineMs` budget (`rawQueryWorkerPool.ts`). On expiry the worker thread is
 * terminated outright, which stops the query even while it is blocked inside a single
 * synchronous `DatabaseSync` call — a slow non-recursive statement (large join,
 * `ORDER BY random()`, a recursive CTE, ...) cannot hold the deadline hostage.
 *
 * Degraded fallback: if the compiled worker asset cannot be located (a corrupted or
 * partial install — the normal build/publish/standalone pipelines all ship it), the
 * query instead runs in-process under a *per-row* elapsed-time budget. `node:sqlite`'s
 * `DatabaseSync` exposes no interrupt/cancellation API, so once execution is inside a
 * single synchronous native call there is nothing in-process that can preempt it —
 * true enforcement genuinely requires the separate worker thread this fallback exists
 * because it could not find. The per-row check is therefore strictly weaker, not just a
 * smaller budget: it is only evaluated between rows the native iterator has already
 * produced, so a statement that is slow to produce its very first row (a full scan
 * before any match, an aggregate over a large recursive CTE, ...) blocks for its full
 * cost before the deadline is ever checked. This fallback exists to keep the common
 * case usable in a degraded install, not as a substitute for the worker deadline; a
 * warning is logged once per process when it activates so a degraded install is
 * observable rather than silently under-enforcing its documented time budget.
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
    });
  }

  return await runRawSqlQueryInWorker({ outputPath, sql, params, maxRows, maxBytes, maxCellBytes }, deadlineMs);
}

/** Degraded fallback for `queryGraphSqliteRaw` — see its doc comment for the enforcement
 * caveat this path cannot avoid. */
async function queryGraphSqliteRawInProcessBounded(
  outputPath: string,
  sql: string,
  params: Array<string | number | null>,
  bounds: { maxRows: number; maxBytes: number; maxCellBytes: number; deadlineMs: number },
): Promise<RawSqlResult> {
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
      );
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

/** Throws once the wall-clock deadline has passed between two already-produced rows.
 * See the fallback caveat on `queryGraphSqliteRaw`: a statement slow to produce its
 * first row is not bounded here — only slow-*between*-rows iteration is caught. */
function* withPerRowDeadline<T>(rows: Iterable<T>, deadlineAt: number, deadlineMs: number): Generator<T> {
  for (const row of rows) {
    if (Date.now() > deadlineAt) throw new SqliteQueryDeadlineExceededError(deadlineMs);
    yield row;
  }
}
