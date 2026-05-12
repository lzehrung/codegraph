import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReviewReport } from "../src/index.js";

async function mkTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cg-sql-review-"));
}

async function writeFile(filePath: string, contents: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}

describe("SQL review context", () => {
  it("surfaces SQL candidates for changed code SQL literals", async () => {
    const root = await mkTmpDir();
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
  });

  it("includes changed SQL files without creating source dependency impact", async () => {
    const root = await mkTmpDir();
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
  });

  it("keeps seed SQL visible only when the seed file changes", async () => {
    const root = await mkTmpDir();
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
  });

  it("does not surface stale SQL for unrelated code-only reviews", async () => {
    const root = await mkTmpDir();
    await writeFile(path.join(root, "db", "migrations", "20190101000000_legacy.sql"), "CREATE TABLE legacy_users (id integer);\n");
    const code = await writeFile(path.join(root, "src", "app.ts"), "export const count = 1;\n");

    const report = await buildReviewReport(root, { files: [code] });

    expect(report.sqlContext?.entries ?? []).toEqual([]);
    expect(report.graphDelta).toEqual([]);
  });
});
