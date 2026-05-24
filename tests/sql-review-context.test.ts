import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildReviewReport } from "../src/index.js";
import { collectSqlReviewContext } from "../src/sql/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";

async function rmTmpDir(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

async function writeFile(filePath: string, contents: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}

describe("SQL review context", () => {
  it("surfaces SQL candidates for changed code SQL literals", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      const schema = await writeFile(path.join(root, "db", "schema.sql"), "CREATE TABLE users (id integer);\n");
      const repo = await writeFile(
        path.join(root, "src", "userRepo.ts"),
        "export const query = `SELECT id FROM users WHERE id = ?`;\n",
      );

      const report = await buildReviewReport(root, { files: [repo] });

      expect(report.sqlContext?.entries).toEqual([
        expect.objectContaining({
          reason: "changed_sql_literal",
          objectName: "users",
          fact: expect.objectContaining({ filePath: schema.replace(/\\/g, "/"), kind: "defines_table" }),
        }),
      ]);
    } finally {
      await rmTmpDir(root);
    }
  });

  it("includes changed SQL files without creating source dependency impact", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      const migration = await writeFile(
        path.join(root, "db", "migrations", "20190101000000_legacy.sql"),
        "CREATE TABLE legacy_users (id integer);\n",
      );
      await writeFile(path.join(root, "src", "app.ts"), "export const ok = true;\n");

      const report = await buildReviewReport(root, { files: [migration] });

      expect(report.graphDelta).toEqual([]);
      expect(report.sqlContext?.entries).toEqual([
        expect.objectContaining({
          reason: "changed_sql_file",
          objectName: "legacy_users",
          fact: expect.objectContaining({ role: "migration" }),
        }),
      ]);
    } finally {
      await rmTmpDir(root);
    }
  });

  it("keeps seed SQL visible only when the seed file changes", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      const seed = await writeFile(path.join(root, "db", "seeds", "users.sql"), "INSERT INTO users (id) VALUES (1);\n");
      const code = await writeFile(path.join(root, "src", "app.ts"), "export const ok = true;\n");

      const seedReport = await buildReviewReport(root, { files: [seed] });
      const codeReport = await buildReviewReport(root, { files: [code] });

      expect(seedReport.sqlContext?.entries).toEqual([
        expect.objectContaining({
          reason: "changed_sql_file",
          objectName: "users",
          fact: expect.objectContaining({ role: "seed", kind: "writes_to" }),
        }),
      ]);
      expect(codeReport.sqlContext?.entries ?? []).toEqual([]);
    } finally {
      await rmTmpDir(root);
    }
  });

  it("does not surface stale SQL for unrelated code-only reviews", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      await writeFile(
        path.join(root, "db", "migrations", "20190101000000_legacy.sql"),
        "CREATE TABLE legacy_users (id integer);\n",
      );
      const code = await writeFile(path.join(root, "src", "app.ts"), "export const count = 1;\n");

      const report = await buildReviewReport(root, { files: [code] });

      expect(report.sqlContext?.entries ?? []).toEqual([]);
      expect(report.graphDelta).toEqual([]);
    } finally {
      await rmTmpDir(root);
    }
  });

  it("skips the SQL corpus when changed code has no SQL-like text", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      await writeFile(path.join(root, "db", "schema.sql"), "CREATE TABLE users (id integer);\n");
      const code = await writeFile(path.join(root, "src", "app.ts"), "export const count = 1;\n");
      const originalReadFile = fs.readFile.bind(fs);
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(originalReadFile);

      const context = await collectSqlReviewContext(root, { changedFiles: [code] });

      expect(context).toBeUndefined();
      expect(readSpy.mock.calls.some((call) => String(call[0]).endsWith(".sql"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await rmTmpDir(root);
    }
  });

  it("does not treat ES module imports as SQL literal hints", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      await writeFile(path.join(root, "db", "schema.sql"), "CREATE TABLE users (id integer);\n");
      const code = await writeFile(path.join(root, "src", "app.ts"), 'import users from "./users";\n');
      const originalReadFile = fs.readFile.bind(fs);
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(originalReadFile);

      const context = await collectSqlReviewContext(root, { changedFiles: [code] });

      expect(context).toBeUndefined();
      expect(readSpy.mock.calls.some((call) => String(call[0]).endsWith(".sql"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await rmTmpDir(root);
    }
  });

  it("does not treat a bare with token as a SQL literal hint", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      await writeFile(path.join(root, "db", "schema.sql"), "CREATE TABLE users (id integer);\n");
      const code = await writeFile(path.join(root, "src", "app.ts"), 'export const label = "created with care";\n');
      const originalReadFile = fs.readFile.bind(fs);
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(originalReadFile);

      const context = await collectSqlReviewContext(root, { changedFiles: [code] });

      expect(context).toBeUndefined();
      expect(readSpy.mock.calls.some((call) => String(call[0]).endsWith(".sql"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await rmTmpDir(root);
    }
  });

  it("does not treat a bare update phrase as a SQL literal hint", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      await writeFile(path.join(root, "db", "schema.sql"), "CREATE TABLE users (id integer);\n");
      const code = await writeFile(path.join(root, "src", "app.ts"), 'export const label = "update x";\n');
      const originalReadFile = fs.readFile.bind(fs);
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(originalReadFile);

      const context = await collectSqlReviewContext(root, { changedFiles: [code] });

      expect(context).toBeUndefined();
      expect(readSpy.mock.calls.some((call) => String(call[0]).endsWith(".sql"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await rmTmpDir(root);
    }
  });

  it("does not treat a bare select identifier as a SQL literal hint", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      await writeFile(path.join(root, "db", "schema.sql"), "CREATE TABLE users (id integer);\n");
      const code = await writeFile(
        path.join(root, "src", "app.ts"),
        "export function select(value: string) { return value; }\n",
      );
      const originalReadFile = fs.readFile.bind(fs);
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(originalReadFile);

      const context = await collectSqlReviewContext(root, { changedFiles: [code] });

      expect(context).toBeUndefined();
      expect(readSpy.mock.calls.some((call) => String(call[0]).endsWith(".sql"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await rmTmpDir(root);
    }
  });

  it("uses provided project files when matching code SQL literals", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      await writeFile(path.join(root, "db", "schema.sql"), "CREATE TABLE users (id integer);\n");
      const code = await writeFile(path.join(root, "src", "userRepo.ts"), "export const query = `SELECT * FROM users`;\n");
      const options = { changedFiles: [code], projectFiles: [] as string[] };

      const context = await collectSqlReviewContext(root, options);

      expect(context).toBeUndefined();
    } finally {
      await rmTmpDir(root);
    }
  });

  it("keeps full SQL discovery for sparse reviews that include a changed SQL file", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      const schema = await writeFile(path.join(root, "db", "schema.sql"), "CREATE TABLE users (id integer);\n");
      const migration = await writeFile(path.join(root, "db", "migrations", "20260513000000_orders.sql"), [
        "CREATE TABLE orders (id integer);",
        "",
      ].join("\n"));
      const code = await writeFile(path.join(root, "src", "userRepo.ts"), "export const query = `SELECT * FROM users`;\n");

      const report = await buildReviewReport(root, { files: [code, migration] });

      expect(report.sqlContext?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: "changed_sql_literal",
            objectName: "users",
            fact: expect.objectContaining({ filePath: schema.replace(/\\/g, "/"), kind: "defines_table" }),
          }),
          expect.objectContaining({
            reason: "changed_sql_file",
            objectName: "orders",
            fact: expect.objectContaining({ filePath: migration.replace(/\\/g, "/"), kind: "defines_table" }),
          }),
        ]),
      );
    } finally {
      await rmTmpDir(root);
    }
  });

  it("bounds concurrent SQL fact reads when matching changed code literals", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      for (let index = 0; index < 40; index += 1) {
        await writeFile(path.join(root, "db", `schema_${index}.sql`), `CREATE TABLE table_${index} (id integer);\n`);
      }
      const code = await writeFile(path.join(root, "src", "repo.ts"), "export const query = `SELECT * FROM table_1`;\n");
      const originalReadFile = fs.readFile.bind(fs);
      let activeSqlReads = 0;
      let maxActiveSqlReads = 0;
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
        const isSqlRead = String(filePath).endsWith(".sql");
        if (isSqlRead) {
          activeSqlReads += 1;
          maxActiveSqlReads = Math.max(maxActiveSqlReads, activeSqlReads);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        try {
          return await originalReadFile(filePath, options);
        } finally {
          if (isSqlRead) activeSqlReads -= 1;
        }
      });

      const context = await collectSqlReviewContext(root, { changedFiles: [code] });

      expect(readSpy).toHaveBeenCalled();
      expect(context?.entries).toContainEqual(
        expect.objectContaining({
          reason: "changed_sql_literal",
          objectName: "table_1",
        }),
      );
      expect(maxActiveSqlReads).toBeLessThanOrEqual(32);
    } finally {
      vi.restoreAllMocks();
      await rmTmpDir(root);
    }
  });

  it("surfaces SQL candidates for changed code update literals", async () => {
    const root = await mkTmpDir("cg-sql-review-");
    try {
      const schema = await writeFile(path.join(root, "db", "schema.sql"), "CREATE TABLE users (id integer);\n");
      const code = await writeFile(
        path.join(root, "src", "userRepo.ts"),
        "export const query = `UPDATE users SET id = ? WHERE id = ?`;\n",
      );

      const context = await collectSqlReviewContext(root, { changedFiles: [code] });

      expect(context?.entries).toEqual([
        expect.objectContaining({
          reason: "changed_sql_literal",
          objectName: "users",
          fact: expect.objectContaining({ filePath: schema.replace(/\\/g, "/"), kind: "defines_table" }),
        }),
      ]);
    } finally {
      await rmTmpDir(root);
    }
  });
});
