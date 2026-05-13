import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifySqlFile, extractSqlFactsFromSource } from "../src/sql/index.js";

const fixtureRoot = path.resolve(process.cwd(), "tests", "samples", "sql", "facts");

async function readFixture(name: string): Promise<string> {
  return await fs.readFile(path.join(fixtureRoot, name), "utf8");
}

describe("SQL fact extraction", () => {
  it("extracts schema snapshot definitions without claiming current schema", async () => {
    const filePath = path.join(fixtureRoot, "schema.sql");
    const facts = extractSqlFactsFromSource(filePath, await readFixture("schema.sql"));

    expect(facts.map((fact) => fact.kind)).toEqual([
      "defines_table",
      "defines_constraint",
      "defines_view",
      "reads_from",
      "defines_index",
    ]);
    expect(facts.map((fact) => fact.truthTier)).toEqual(facts.map(() => "sql_statement_fact"));
    expect(facts[0]).toMatchObject({
      objectName: "users",
      role: "schema_snapshot",
      startLine: 1,
      endLine: 4,
    });
    expect(facts[1]).toMatchObject({
      kind: "defines_constraint",
      objectName: "users",
      relatedObjectName: "organizations",
    });
    expect(facts[2]).toMatchObject({
      objectName: "active_users",
    });
    expect(facts[3]).toMatchObject({
      kind: "reads_from",
      objectName: "users",
    });
    expect(facts[4]).toMatchObject({
      objectName: "users_org_idx",
      relatedObjectName: "users",
    });
  });

  it("extracts migration changes without creating current schema facts", async () => {
    const filePath = path.join(fixtureRoot, "migrations", "20240510120000_users.sql");
    const facts = extractSqlFactsFromSource(filePath, await readFixture("migration.sql"));

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "alters_table",
        objectName: "users",
        role: "migration",
        truthTier: "sql_statement_fact",
      }),
      expect.objectContaining({
        kind: "drops_object",
        objectName: "legacy_users",
        role: "migration",
        truthTier: "sql_statement_fact",
      }),
    ]);
  });

  it("classifies seeds, queries, and dumps while preserving facts", async () => {
    const seedFacts = extractSqlFactsFromSource(
      path.join(fixtureRoot, "seeds", "users.sql"),
      await readFixture("seed.sql"),
    );
    const queryFacts = extractSqlFactsFromSource(
      path.join(fixtureRoot, "reports", "active_users.sql"),
      await readFixture("query.sql"),
    );
    const dumpFacts = extractSqlFactsFromSource(
      path.join(fixtureRoot, "backup", "legacy_dump.sql"),
      await readFixture("dump.sql"),
    );

    expect(seedFacts).toEqual([
      expect.objectContaining({ kind: "writes_to", objectName: "users", role: "seed" }),
    ]);
    expect(queryFacts).toEqual([
      expect.objectContaining({ kind: "reads_from", objectName: "users", role: "query" }),
      expect.objectContaining({ kind: "joins", objectName: "organizations", relatedObjectName: "users" }),
    ]);
    expect(dumpFacts).toEqual([
      expect.objectContaining({ kind: "writes_to", objectName: "archived_users", role: "dump" }),
    ]);
  });

  it("uses unknown for unsupported SQL statements with provenance", () => {
    const filePath = path.join(fixtureRoot, "misc.sql");
    const facts = extractSqlFactsFromSource(filePath, "VACUUM;\n");

    expect(classifySqlFile(filePath, "VACUUM;\n")).toBe("unknown");
    expect(facts).toEqual([
      expect.objectContaining({
        kind: "unknown_statement",
        objectName: null,
        relatedObjectName: null,
        startLine: 1,
        endLine: 1,
        statementText: "VACUUM",
      }),
    ]);
  });

  it("tracks statement starts after separators, comments, blank lines, and string semicolons", () => {
    const filePath = path.join(fixtureRoot, "schema.sql");
    const facts = extractSqlFactsFromSource(
      filePath,
      [
        "CREATE TABLE accounts (id integer);",
        "",
        "-- report table",
        "/* audit metadata",
        "   kept with migration */",
        "CREATE TABLE users (id integer);",
        "SELECT 'literal; not a statement boundary' AS value FROM users;",
      ].join("\n"),
    );

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "defines_table",
        objectName: "accounts",
        startLine: 1,
        endLine: 1,
      }),
      expect.objectContaining({
        kind: "defines_table",
        objectName: "users",
        startLine: 6,
        endLine: 6,
      }),
      expect.objectContaining({
        kind: "reads_from",
        objectName: "users",
        startLine: 7,
        endLine: 7,
      }),
    ]);
  });
});
