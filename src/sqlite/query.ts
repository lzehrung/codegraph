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

export const DEFAULT_SQLITE_QUERY_DEADLINE_MS = 10_000;

export type QueryGraphSqliteRawOptions = {
  maxRows?: number | undefined;
  maxBytes?: number | undefined;
  maxCellBytes?: number | undefined;
  deadlineMs?: number | undefined;
};

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
    });
  }

  return await runRawSqlQueryInWorker({ outputPath, sql, params, maxRows, maxBytes, maxCellBytes }, deadlineMs);
}

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

function* withPerRowDeadline<T>(rows: Iterable<T>, deadlineAt: number, deadlineMs: number): Generator<T> {
  for (const row of rows) {
    if (Date.now() > deadlineAt) throw new SqliteQueryDeadlineExceededError(deadlineMs);
    yield row;
  }
}
