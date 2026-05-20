import { isReadOnlySqliteError } from "../sqlite-driver.js";
import type { RawSqlResult } from "./types.js";
import { assertReadOnlyQueryStatement, withReadOnlySqliteDatabase } from "./database.js";

export { queryGraphSqlite } from "./canned-query.js";

export async function queryGraphSqliteRaw(
  outputPath: string,
  sql: string,
  params: Array<string | number | null> = [],
  options?: { maxRows?: number | undefined },
): Promise<RawSqlResult> {
  return await withReadOnlySqliteDatabase(outputPath, (db) => {
    try {
      const stmt = db.prepare(sql);
      assertReadOnlyQueryStatement(stmt);
      const columns = stmt.columns().map((col) => col.name);
      const rowLimit = options?.maxRows;
      if (rowLimit !== undefined) {
        const rows: Array<Array<unknown>> = [];
        let truncated = false;
        for (const row of stmt.raw().iterate(params) as Iterable<Array<unknown>>) {
          if (rows.length >= rowLimit) {
            truncated = true;
            break;
          }
          rows.push(row);
        }
        return {
          columns,
          rows,
          rowLimit,
          truncated,
        };
      }
      const rows = stmt.raw().all(params) as Array<Array<unknown>>;
      return { columns, rows };
    } catch (error) {
      if (isReadOnlySqliteError(error)) {
        throw new Error("Raw SQLite queries must be read-only result-producing statements such as SELECT or PRAGMA.");
      }
      throw error;
    }
  });
}
