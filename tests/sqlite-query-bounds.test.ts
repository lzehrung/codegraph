import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import {
  collectBoundedRawSqlRows,
  MAX_SQLITE_CELL_BYTES,
  MAX_SQLITE_ROW_LIMIT,
  SQLITE_TRUNCATED_MARKER,
} from "../src/mcp/sqliteGuard.js";
import { queryGraphSqliteRaw, SqliteQueryDeadlineExceededError } from "../src/sqlite/query.js";

async function withTempDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sqlite-bounds-"));
  const dbPath = path.join(root, "graph.sqlite");
  try {
    await run(dbPath);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
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
      if (error.code !== "EBUSY" && error.code !== "ENOTEMPTY") throw error;
      if (Date.now() > deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe("SQLite query byte/cell bounds during iterate", () => {
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
  it("terminates an over-budget query without delaying a following query", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sqlite-deadline-"));
    const dbPath = path.join(root, "graph.sqlite");
    try {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE values_table (n INTEGER);");
      db.prepare("INSERT INTO values_table (n) VALUES (?)").run(42);
      db.close();

      const slowSql =
        "WITH RECURSIVE spin(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM spin WHERE x < 8000000) " +
        "SELECT count(*) FROM spin;";
      const startedAt = Date.now();
      await expect(queryGraphSqliteRaw(dbPath, slowSql, [], { deadlineMs: 100 })).rejects.toMatchObject({
        name: "SqliteQueryDeadlineExceededError",
        message: expect.stringMatching(/exceeded its 100ms execution budget/),
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      const result = await queryGraphSqliteRaw(dbPath, "SELECT n FROM values_table;", [], { deadlineMs: 5_000 });
      expect(result.rows).toEqual([[42]]);
      expect(result.truncated).toBeFalsy();
    } finally {
      await removeWithRetry(root);
    }
  });

  it("exports a named deadline error for callers", () => {
    const error = new SqliteQueryDeadlineExceededError(250);
    expect(error.name).toBe("SqliteQueryDeadlineExceededError");
    expect(error.message).toBe("SQLite query exceeded its 250ms execution budget and was terminated.");
  });
});
