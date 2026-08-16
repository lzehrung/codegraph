import { isReadOnlySqliteError } from "../sqlite-driver.js";
import type { RawSqlResult } from "./types.js";
import { assertReadOnlyQueryStatement, withReadOnlySqliteDatabase } from "./database.js";
import { collectBoundedRawSqlRows } from "./rowBounds.js";

export type RawQueryWorkerTask = {
  outputPath: string;
  sql: string;
  params: Array<string | number | null>;
  maxRows: number;
  maxBytes: number | undefined;
  maxCellBytes: number | undefined;
};

export default async function runRawQueryWorkerTask(task: RawQueryWorkerTask): Promise<RawSqlResult> {
  return await withReadOnlySqliteDatabase(task.outputPath, (db) => {
    try {
      const statement = db.prepare(task.sql);
      assertReadOnlyQueryStatement(statement);
      const columns = statement.columns().map((column) => column.name);
      return collectBoundedRawSqlRows(columns, statement.raw().iterate(task.params) as Iterable<Array<unknown>>, {
        maxRows: task.maxRows,
        maxBytes: task.maxBytes,
        maxCellBytes: task.maxCellBytes,
      });
    } catch (error) {
      if (isReadOnlySqliteError(error)) {
        throw new Error("Raw SQLite queries must be read-only result-producing statements such as SELECT or PRAGMA.");
      }
      throw error;
    }
  });
}
