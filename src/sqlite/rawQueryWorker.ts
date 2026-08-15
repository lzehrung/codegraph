import { isReadOnlySqliteError } from "../sqlite-driver.js";
import type { RawSqlResult } from "./types.js";
import { assertReadOnlyQueryStatement, withReadOnlySqliteDatabase } from "./database.js";
import { collectBoundedRawSqlRows } from "./rowBounds.js";

/**
 * Task payload for a single bounded raw SQL read, executed inside a dedicated worker
 * thread (see `rawQueryWorkerPool.ts`). Every field must be structured-clone safe.
 */
export type RawQueryWorkerTask = {
  outputPath: string;
  sql: string;
  params: Array<string | number | null>;
  maxRows: number;
  maxBytes: number | undefined;
  maxCellBytes: number | undefined;
};

/**
 * Worker entry point. Mirrors the previous in-process body of `queryGraphSqliteRaw`
 * exactly: open the database read-only, assert the statement is read-only, and stream
 * rows through the shared row/byte-bounded collector. Running this inside a worker
 * thread lets the pool enforce a hard execution deadline by terminating the thread —
 * which works even mid-synchronous-iteration, since thread termination does not need
 * the blocked thread's cooperation.
 */
export default async function runRawQueryWorkerTask(task: RawQueryWorkerTask): Promise<RawSqlResult> {
  return await withReadOnlySqliteDatabase(task.outputPath, (db) => {
    try {
      const stmt = db.prepare(task.sql);
      assertReadOnlyQueryStatement(stmt);
      const columns = stmt.columns().map((col) => col.name);
      return collectBoundedRawSqlRows(columns, stmt.raw().iterate(task.params) as Iterable<Array<unknown>>, {
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
