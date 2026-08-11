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

  it("classifies multi-table files under migrations as migrations", () => {
    const filePath = path.join(fixtureRoot, "migrations", "20240510120500_multi.sql");
    const source = ["CREATE TABLE users (id integer);", "CREATE TABLE organizations (id integer);"].join("\n");
    const facts = extractSqlFactsFromSource(filePath, source);

    expect(classifySqlFile(filePath, source)).toBe("migration");
    expect(facts).toEqual([
      expect.objectContaining({
        kind: "defines_table",
        objectName: "users",
        role: "migration",
      }),
      expect.objectContaining({
        kind: "defines_table",
        objectName: "organizations",
        role: "migration",
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

    expect(seedFacts).toEqual([expect.objectContaining({ kind: "writes_to", objectName: "users", role: "seed" })]);
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

  it("splits T-SQL GO batches without splitting BEGIN and END bodies", async () => {
    const filePath = path.join(fixtureRoot, "tsql_batches.sql");
    const facts = extractSqlFactsFromSource(filePath, await readFixture("tsql_batches.sql"));
    const statementTexts = Array.from(new Set(facts.map((fact) => fact.statementText)));

    expect(statementTexts).toEqual([
      "CREATE TABLE source_users (id integer)",
      [
        "BEGIN",
        "  INSERT INTO audit_users (id) SELECT id FROM source_users;",
        "  SELECT id FROM source_users;",
        "END",
      ].join("\n"),
      "SELECT id FROM audit_users",
    ]);
    expect(facts).toContainEqual(expect.objectContaining({ kind: "writes_to", objectName: "audit_users" }));
    expect(facts).toContainEqual(expect.objectContaining({ kind: "reads_from", objectName: "source_users" }));
    expect(facts).toContainEqual(expect.objectContaining({ kind: "reads_from", objectName: "audit_users" }));
  });

  it("extracts reads from nested comma-separated CTEs", async () => {
    const filePath = path.join(fixtureRoot, "nested_ctes.sql");
    const facts = extractSqlFactsFromSource(filePath, await readFixture("nested_ctes.sql"));

    expect(facts).toEqual([
      expect.objectContaining({ kind: "reads_from", objectName: "accounts" }),
      expect.objectContaining({ kind: "reads_from", objectName: "users" }),
    ]);
  });

  it("handles PostgreSQL ONLY table modifiers as syntax instead of object names", () => {
    const filePath = path.join(fixtureRoot, "migrations", "20240510120100_only.sql");
    const facts = extractSqlFactsFromSource(
      filePath,
      [
        "ALTER TABLE ONLY public.users ADD COLUMN updated_at timestamptz;",
        "CREATE INDEX users_email_idx ON ONLY public.users (email);",
        "SELECT id FROM ONLY public.users;",
        "UPDATE ONLY public.users SET email = lower(email);",
        "DELETE FROM ONLY public.users WHERE id < 0;",
      ].join("\n"),
    );

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "alters_table",
        objectName: "public.users",
      }),
      expect.objectContaining({
        kind: "defines_index",
        objectName: "users_email_idx",
        relatedObjectName: "public.users",
      }),
      expect.objectContaining({
        kind: "reads_from",
        objectName: "public.users",
      }),
      expect.objectContaining({
        kind: "writes_to",
        objectName: "public.users",
      }),
      expect.objectContaining({
        kind: "writes_to",
        objectName: "public.users",
      }),
    ]);
  });

  it("extracts all read dependencies from multi-source queries and write statements", () => {
    const filePath = path.join(fixtureRoot, "reports", "data_flow.sql");
    const facts = extractSqlFactsFromSource(
      filePath,
      [
        "CREATE TABLE public.active_users AS SELECT id FROM public.users WHERE active = true;",
        "INSERT INTO public.audit_users SELECT id FROM public.active_users;",
        "UPDATE public.users SET organization_name = o.name FROM public.organizations o WHERE o.id = organization_id;",
        "DELETE FROM public.audit_users USING public.users WHERE audit_users.id = users.id;",
        "SELECT u.id, o.name FROM public.users u, public.organizations o WHERE o.id = u.organization_id;",
      ].join("\n"),
    );

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "defines_table",
        objectName: "public.active_users",
      }),
      expect.objectContaining({
        kind: "reads_from",
        objectName: "public.users",
      }),
      expect.objectContaining({
        kind: "writes_to",
        objectName: "public.audit_users",
      }),
      expect.objectContaining({
        kind: "reads_from",
        objectName: "public.active_users",
      }),
      expect.objectContaining({
        kind: "writes_to",
        objectName: "public.users",
      }),
      expect.objectContaining({
        kind: "reads_from",
        objectName: "public.organizations",
      }),
      expect.objectContaining({
        kind: "writes_to",
        objectName: "public.audit_users",
      }),
      expect.objectContaining({
        kind: "reads_from",
        objectName: "public.users",
      }),
      expect.objectContaining({
        kind: "reads_from",
        objectName: "public.users",
      }),
      expect.objectContaining({
        kind: "reads_from",
        objectName: "public.organizations",
      }),
    ]);
  });

  it("extracts rename, truncate, and merge statements", () => {
    const filePath = path.join(fixtureRoot, "migrations", "20240510120200_more_dml.sql");
    const facts = extractSqlFactsFromSource(
      filePath,
      [
        "ALTER TABLE public.users RENAME TO account_users;",
        "TRUNCATE TABLE ONLY public.audit_users RESTART IDENTITY;",
        "MERGE INTO public.users USING public.stage_users ON users.id = stage_users.id WHEN MATCHED THEN UPDATE SET active = true;",
      ].join("\n"),
    );

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "renames_object",
        objectName: "public.users",
        relatedObjectName: "account_users",
      }),
      expect.objectContaining({
        kind: "writes_to",
        objectName: "public.audit_users",
      }),
      expect.objectContaining({
        kind: "writes_to",
        objectName: "public.users",
      }),
      expect.objectContaining({
        kind: "reads_from",
        objectName: "public.stage_users",
      }),
    ]);
  });

  it("does not treat expression-level FROM keywords as table reads", () => {
    const filePath = path.join(fixtureRoot, "reports", "expression_from.sql");
    const facts = extractSqlFactsFromSource(
      filePath,
      "SELECT EXTRACT(EPOCH FROM created_at) AS created_epoch FROM public.users;",
    );

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "reads_from",
        objectName: "public.users",
      }),
    ]);
  });

  it("does not split table-valued function arguments as FROM objects", () => {
    const filePath = path.join(fixtureRoot, "reports", "function_from.sql");
    const facts = extractSqlFactsFromSource(
      filePath,
      "SELECT * FROM public.users u, jsonb_each_text(u.settings, public.defaults) setting;",
    );

    const objectNames = facts.map((fact) => fact.objectName);
    expect(objectNames).toContain("public.users");
    expect(objectNames).toContain("jsonb_each_text");
    expect(objectNames).not.toContain("public.defaults");
  });

  it("handles LATERAL source modifiers as syntax instead of object names", () => {
    const filePath = path.join(fixtureRoot, "reports", "lateral.sql");
    const facts = extractSqlFactsFromSource(
      filePath,
      "SELECT * FROM public.users u JOIN LATERAL jsonb_each_text(u.settings) setting ON true;",
    );

    const objectNames = facts.map((fact) => fact.objectName);
    expect(objectNames).toContain("public.users");
    expect(objectNames).toContain("jsonb_each_text");
    expect(objectNames).not.toContain("LATERAL");
  });

  it("records CTE body table reads without treating CTE aliases as schema objects", () => {
    const filePath = path.join(fixtureRoot, "reports", "cte.sql");
    const facts = extractSqlFactsFromSource(
      filePath,
      [
        "WITH recent_users AS (",
        "  SELECT id, organization_id FROM public.users WHERE created_at > now() - interval '7 days'",
        ")",
        "SELECT recent_users.id, organizations.name",
        "FROM recent_users",
        "JOIN public.organizations organizations ON organizations.id = recent_users.organization_id;",
      ].join("\n"),
    );

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "reads_from",
        objectName: "public.users",
      }),
      expect.objectContaining({
        kind: "joins",
        objectName: "public.organizations",
        relatedObjectName: null,
      }),
    ]);
  });

  it("extracts referenced objects from ALTER TABLE constraints", () => {
    const filePath = path.join(fixtureRoot, "migrations", "20240510120300_fk.sql");
    const facts = extractSqlFactsFromSource(
      filePath,
      [
        "ALTER TABLE public.orders",
        "  ADD CONSTRAINT orders_user_id_fkey",
        "  FOREIGN KEY (user_id) REFERENCES public.users(id);",
      ].join("\n"),
    );

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "alters_table",
        objectName: "public.orders",
      }),
      expect.objectContaining({
        kind: "defines_constraint",
        objectName: "public.orders",
        relatedObjectName: "public.users",
      }),
    ]);
  });

  it("extracts PostgreSQL drop modifiers for indexes and materialized views", () => {
    const filePath = path.join(fixtureRoot, "migrations", "20240510120400_drop.sql");
    const facts = extractSqlFactsFromSource(
      filePath,
      [
        "DROP INDEX CONCURRENTLY IF EXISTS public.users_email_idx;",
        "DROP MATERIALIZED VIEW IF EXISTS public.active_users;",
      ].join("\n"),
    );

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "drops_object",
        objectName: "public.users_email_idx",
      }),
      expect.objectContaining({
        kind: "drops_object",
        objectName: "public.active_users",
      }),
    ]);
  });

  it("extracts T-SQL local and global temp table facts", () => {
    const filePath = path.join(fixtureRoot, "migrations", "20240510120500_temp_table.sql");
    const facts = extractSqlFactsFromSource(
      filePath,
      [
        "CREATE TABLE #TempResults (id INT, name VARCHAR(50));",
        "INSERT INTO #TempResults (id, name) VALUES (1, 'a');",
        "SELECT * FROM #TempResults;",
        "CREATE TABLE ##GlobalTempResults (id INT);",
      ].join("\n"),
    );

    expect(facts).toEqual([
      expect.objectContaining({ kind: "defines_table", objectName: "#TempResults" }),
      expect.objectContaining({ kind: "writes_to", objectName: "#TempResults" }),
      expect.objectContaining({ kind: "reads_from", objectName: "#TempResults" }),
      expect.objectContaining({ kind: "defines_table", objectName: "##GlobalTempResults" }),
    ]);
  });
});
