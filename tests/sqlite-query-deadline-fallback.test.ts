import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// Force every query in this file through the in-process fallback (as if the compiled
// worker asset were missing) so its deadline behavior -- and its documented
// limitation -- can be exercised directly, without disturbing the worker-backed
// deadline tests in sqlite-query-bounds.test.ts.
vi.mock("../src/sqlite/rawQueryWorkerPool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sqlite/rawQueryWorkerPool.js")>();
  return {
    ...actual,
    resolveRawSqlQueryWorkerPath: () => {
      throw new Error("worker asset unavailable in this test");
    },
  };
});

import {
  SqliteQueryCancelledError,
  SqliteQueryDeadlineExceededError as PublicSqliteQueryDeadlineExceededError,
  SqliteQueryWorkerCleanupCapacityExceededError as PublicSqliteQueryWorkerCleanupCapacityExceededError,
} from "../src/sqlite.js";
import {
  SqliteQueryCancelledError as RootSqliteQueryCancelledError,
  SqliteQueryDeadlineExceededError as RootSqliteQueryDeadlineExceededError,
  SqliteQueryWorkerCleanupCapacityExceededError as RootSqliteQueryWorkerCleanupCapacityExceededError,
} from "../src/index.js";
import {
  queryGraphSqliteRaw,
  SqliteQueryDeadlineExceededError,
  SqliteQueryWorkerCleanupCapacityExceededError,
} from "../src/sqlite/query.js";

async function withTempDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sqlite-deadline-fallback-"));
  const dbPath = path.join(root, "graph.sqlite");
  try {
    await run(dbPath);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

describe("SQLite raw query in-process deadline fallback", () => {
  it("rejects invalid deadlineMs values before selecting the fallback execution path", async () => {
    for (const deadlineMs of [NaN, -1, 1.5, 2_147_483_648, Infinity]) {
      await expect(queryGraphSqliteRaw("missing.sqlite", "SELECT 1;", [], { deadlineMs })).rejects.toMatchObject({
        name: "RangeError",
        message: "SQLite query deadlineMs must be a non-negative integer no greater than 2147483647.",
      });
    }
  });

  it("still enforces the deadline between rows when the worker asset is unavailable", async () => {
    await withTempDb(async (dbPath) => {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE t (x INTEGER);");
      db.close();

      // Every outer row pays for a large nested recursive scan, so successive rows are
      // spaced far enough apart in wall-clock time that a short deadline is guaranteed
      // to trip between rows -- well before the query would otherwise finish.
      const perRowSlowSql =
        "WITH RECURSIVE outer_r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM outer_r WHERE x < 500) " +
        "SELECT x, (" +
        "  WITH RECURSIVE inner_r(y) AS (SELECT 1 UNION ALL SELECT y + 1 FROM inner_r WHERE y < 200000 + outer_r.x) " +
        "  SELECT count(*) FROM inner_r" +
        ") FROM outer_r;";

      await expect(queryGraphSqliteRaw(dbPath, perRowSlowSql, [], { deadlineMs: 20 })).rejects.toMatchObject({
        name: "SqliteQueryDeadlineExceededError",
        message: expect.stringMatching(/exceeded its 20ms execution budget/),
      });
    });
  });

  it("does not interrupt a single blocking call whose entire cost is before the first row", async () => {
    await withTempDb(async (dbPath) => {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE t (n INTEGER); INSERT INTO t (n) VALUES (1);");
      db.close();

      // The whole cost of this query is inside one synchronous native step: SQLite
      // must finish counting before it can return the single aggregate row. The
      // fallback's per-row check cannot fire until that call returns, so -- unlike the
      // worker-backed path -- this rejects only after running to completion, not
      // within the deadline. That gap is the documented, unavoidable limitation of the
      // fallback (see the doc comment on queryGraphSqliteRaw).
      const slowBeforeFirstRowSql =
        "WITH RECURSIVE spin(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM spin WHERE x < 8000000) " +
        "SELECT count(*) FROM spin;";

      const start = Date.now();
      await expect(queryGraphSqliteRaw(dbPath, slowBeforeFirstRowSql, [], { deadlineMs: 20 })).rejects.toMatchObject({
        name: "SqliteQueryDeadlineExceededError",
      });
      const elapsed = Date.now() - start;
      // A true execution deadline would reject close to 20ms; the fallback instead
      // blocks for close to the query's full running time before it can even check.
      expect(elapsed).toBeGreaterThan(200);
    });
  });

  it("rejects a zero-row query that completes after the fallback deadline", async () => {
    await withTempDb(async (dbPath) => {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE t (n INTEGER);");
      db.close();

      const slowEmptySql =
        "WITH RECURSIVE spin(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM spin WHERE x < 8000000) " +
        "SELECT x FROM spin WHERE x < 0;";

      const start = Date.now();
      await expect(queryGraphSqliteRaw(dbPath, slowEmptySql, [], { deadlineMs: 20 })).rejects.toMatchObject({
        name: "SqliteQueryDeadlineExceededError",
      });
      expect(Date.now() - start).toBeGreaterThan(200);
    });
  });

  it("still succeeds for an ordinary query that finishes comfortably inside its deadline", async () => {
    await withTempDb(async (dbPath) => {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE t (n INTEGER); INSERT INTO t (n) VALUES (7);");
      db.close();

      const result = await queryGraphSqliteRaw(dbPath, "SELECT n FROM t;", [], { deadlineMs: 5_000 });
      expect(result.rows).toEqual([[7]]);
      expect(result.truncated).toBeFalsy();
    });
  });

  it("exports named cancellation, deadline, and capacity errors from public library barrels", () => {
    expect(PublicSqliteQueryDeadlineExceededError).toBe(SqliteQueryDeadlineExceededError);
    expect(PublicSqliteQueryWorkerCleanupCapacityExceededError).toBe(SqliteQueryWorkerCleanupCapacityExceededError);
    expect(RootSqliteQueryDeadlineExceededError).toBe(SqliteQueryDeadlineExceededError);
    expect(RootSqliteQueryCancelledError).toBe(SqliteQueryCancelledError);
    expect(RootSqliteQueryWorkerCleanupCapacityExceededError).toBe(SqliteQueryWorkerCleanupCapacityExceededError);

    const deadline = new PublicSqliteQueryDeadlineExceededError(250);
    expect(deadline).toBeInstanceOf(Error);
    expect(deadline.name).toBe("SqliteQueryDeadlineExceededError");
    expect(deadline.message).toBe("SQLite query exceeded its 250ms execution budget.");
    expect(new SqliteQueryCancelledError().message).toBe("SQLite query was cancelled.");
    expect(new PublicSqliteQueryWorkerCleanupCapacityExceededError(2).message).toContain(
      "SQLite query worker capacity is exhausted",
    );
  });
});
