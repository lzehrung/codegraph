import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

import {
  collectBoundedRawSqlRows,
  MAX_SQLITE_CELL_BYTES,
  MAX_SQLITE_ROW_LIMIT,
  SQLITE_TRUNCATED_MARKER,
} from "../src/mcp/sqliteGuard.js";
import { queryGraphSqliteRaw, SqliteQueryDeadlineExceededError } from "../src/sqlite/query.js";

// A deadline-exceeded query requests worker termination but, if it was blocked
// inside a single synchronous native SQLite call, keeps running that call in the
// background until it returns naturally (see rawQueryWorkerPool.ts). On Windows this can
// hold the temp db file open for a short window after the deadline test's assertions
// already ran. This is a real platform race (an actual lingering OS file lock, not
// simulated timing logic), so it is retried against the real clock instead of being
// modeled with fake timers.

async function withTempDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sqlite-bounds-"));
  const dbPath = path.join(root, "graph.sqlite");
  try {
    await run(dbPath);
  } finally {
    await removeWithRetry(root);
  }
}

async function removeWithRetry(root: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await fsp.rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      if (error.code !== "EBUSY" && error.code !== "ENOTEMPTY" && error.code !== "EPERM") throw error;
      if (Date.now() > deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe("SQLite query byte/cell bounds during iterate", () => {
  it("retries Windows-style EPERM cleanup races", async () => {
    const removeSpy = vi.spyOn(fsp, "rm").mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EPERM" }));
    try {
      await withTempDb(async () => {});
      expect(removeSpy).toHaveBeenCalledTimes(2);
    } finally {
      removeSpy.mockRestore();
    }
  });
  it("applies per-cell and cumulative caps before appending huge existing TEXT cells", async () => {
    await withTempDb(async (dbPath) => {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE payloads (id INTEGER PRIMARY KEY, body TEXT);");
      const huge = "x".repeat(250_000);
      db.prepare("INSERT INTO payloads (id, body) VALUES (?, ?)").run(1, huge);
      db.prepare("INSERT INTO payloads (id, body) VALUES (?, ?)").run(2, "y".repeat(250_000));
      db.close();

      const result = await queryGraphSqliteRaw(dbPath, "SELECT id, body FROM payloads ORDER BY id;", [], {
        maxRows: 10,
        maxBytes: 50_000,
        maxCellBytes: MAX_SQLITE_CELL_BYTES,
      });

      expect(result.truncated).toBe(true);
      expect(result.byteLimit).toBe(50_000);
      expect(result.rowLimit).toBe(10);
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
      expect(result.rows.length).toBeLessThan(3);

      const firstBody = String(result.rows[0]?.[1] ?? "");
      expect(firstBody.endsWith(SQLITE_TRUNCATED_MARKER)).toBe(true);
      expect(Buffer.byteLength(firstBody, "utf8")).toBeLessThanOrEqual(MAX_SQLITE_CELL_BYTES);
      expect(firstBody.includes("x".repeat(MAX_SQLITE_CELL_BYTES))).toBe(false);
      expect(result.bytes ?? 0).toBeLessThanOrEqual(50_000);
    });
  });

  it("exposes hard row-limit truncation without silently dropping the signal", async () => {
    await withTempDb(async (dbPath) => {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE nums (n INTEGER);");
      const insert = db.prepare("INSERT INTO nums (n) VALUES (?);");
      for (let i = 0; i < 20; i += 1) insert.run(i);
      db.close();

      const result = await queryGraphSqliteRaw(dbPath, "SELECT n FROM nums ORDER BY n;", [], {
        maxRows: 5,
        maxBytes: 200_000,
      });

      expect(result.rows).toHaveLength(5);
      expect(result.truncated).toBe(true);
      expect(result.rowLimit).toBe(5);
      expect(result.rows.map((row) => row[0])).toEqual([0, 1, 2, 3, 4]);
    });
  });

  it("keeps ordinary small queries intact under default hard caps", async () => {
    await withTempDb(async (dbPath) => {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE tiny (name TEXT);");
      db.prepare("INSERT INTO tiny (name) VALUES (?)").run("alpha");
      db.prepare("INSERT INTO tiny (name) VALUES (?)").run("beta");
      db.close();

      const result = await queryGraphSqliteRaw(dbPath, "SELECT name FROM tiny ORDER BY name;");
      expect(result.truncated).toBeFalsy();
      expect(result.rowLimit).toBe(MAX_SQLITE_ROW_LIMIT);
      expect(result.rows.map((row) => row[0])).toEqual(["alpha", "beta"]);
    });
  });

  it("collector refuses to append a row once the cumulative byte budget is exhausted", () => {
    const columns = ["body"];
    const rows = [["a".repeat(100)], ["b".repeat(100)], ["c".repeat(100)]];
    const result = collectBoundedRawSqlRows(columns, rows, {
      maxRows: 10,
      maxBytes: 180,
      maxCellBytes: 50,
    });
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeLessThan(3);
    for (const row of result.rows) {
      expect(String(row[0]).endsWith(SQLITE_TRUNCATED_MARKER)).toBe(true);
    }
  });
});

describe("SQLite raw query execution deadline", () => {
  it("terminates an over-budget query with a bounded error while a subsequent query on the same file still succeeds", async () => {
    await withTempDb(async (dbPath) => {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE t (n INTEGER);");
      db.prepare("INSERT INTO t (n) VALUES (?)").run(42);
      db.close();

      // The whole cost of this query is inside one synchronous native step (see
      // rawQueryWorkerPool.ts): SQLite must finish counting before it can return the
      // single aggregate row, so this reliably runs well past a short deadline without
      // depending on machine speed for a *count* of loop iterations.
      const slowSql =
        "WITH RECURSIVE spin(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM spin WHERE x < 8000000) " +
        "SELECT count(*) FROM spin;";

      const start = Date.now();
      await expect(queryGraphSqliteRaw(dbPath, slowSql, [], { deadlineMs: 100 })).rejects.toMatchObject({
        name: "SqliteQueryDeadlineExceededError",
        message: expect.stringMatching(/exceeded its 100ms execution budget/),
      });
      const elapsed = Date.now() - start;
      // The caller is bounded by the deadline, not by how long the runaway query
      // actually takes to finish in the background (calibrated well above 100ms).
      expect(elapsed).toBeLessThan(2_000);

      const result = await queryGraphSqliteRaw(dbPath, "SELECT n FROM t;", [], { deadlineMs: 5_000 });
      expect(result.rows).toEqual([[42]]);
      expect(result.truncated).toBeFalsy();
    });
  });

  it("does not reject an ordinary query that finishes comfortably inside its deadline", async () => {
    await withTempDb(async (dbPath) => {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE t (n INTEGER);");
      db.prepare("INSERT INTO t (n) VALUES (?)").run(7);
      db.close();

      const result = await queryGraphSqliteRaw(dbPath, "SELECT n FROM t;", [], { deadlineMs: 5_000 });
      expect(result.rows).toEqual([[7]]);
    });
  });

  it("exposes SqliteQueryDeadlineExceededError as a named export for callers to distinguish deadline failures", () => {
    const error = new SqliteQueryDeadlineExceededError(250);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SqliteQueryDeadlineExceededError");
    expect(error.message).toBe("SQLite query exceeded its 250ms execution budget; termination was requested.");
  });
});
