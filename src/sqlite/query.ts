import { isReadOnlySqliteError } from "../sqlite-driver.js";
import type { RawSqlResult } from "./types.js";
import { assertReadOnlyQueryStatement, withReadOnlySqliteDatabase } from "./database.js";
import {
  collectBoundedRawSqlRows,
  DEFAULT_SQLITE_BYTE_LIMIT,
  MAX_SQLITE_CELL_BYTES,
  MAX_SQLITE_ROW_LIMIT,
} from "./rowBounds.js";

export { queryGraphSqlite } from "./canned-query.js";

export type QueryGraphSqliteRawOptions = {
  maxRows?: number | undefined;
  maxBytes?: number | undefined;
  maxCellBytes?: number | undefined;
};

export async function queryGraphSqliteRaw(
  outputPath: string,
  sql: string,
  params: Array<string | number | null> = [],
  options?: QueryGraphSqliteRawOptions,
): Promise<RawSqlResult> {
  return await withReadOnlySqliteDatabase(outputPath, (db) => {
    try {
      const stmt = db.prepare(sql);
      assertReadOnlyQueryStatement(stmt);
      const columns = stmt.columns().map((col) => col.name);
      const requestedRows = options?.maxRows;
      const maxRows =
        requestedRows === undefined
          ? MAX_SQLITE_ROW_LIMIT
          : Math.min(MAX_SQLITE_ROW_LIMIT, Math.max(0, Math.floor(requestedRows)));
      const maxBytes = options?.maxBytes ?? DEFAULT_SQLITE_BYTE_LIMIT;
      const maxCellBytes = options?.maxCellBytes ?? MAX_SQLITE_CELL_BYTES;

      // Always stream via iterate so per-cell and cumulative budgets apply before append.
      return collectBoundedRawSqlRows(columns, stmt.raw().iterate(params) as Iterable<Array<unknown>>, {
        maxRows,
        maxBytes,
        maxCellBytes,
      });
    } catch (error) {
      if (isReadOnlySqliteError(error)) {
        throw new Error("Raw SQLite queries must be read-only result-producing statements such as SELECT or PRAGMA.");
      }
      throw error;
    }
  });
}
