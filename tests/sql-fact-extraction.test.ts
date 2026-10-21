import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resetSqlTriviaClassificationShape, sqlTriviaClassificationShape } from "../src/sql/lex.js";
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

  /** The distinct statement texts of a file, in order. */
  function statementTexts(file: string, lines: readonly string[]): string[] {
    return Array.from(new Set(extractSqlFactsFromSource(file, lines.join("\n")).map((fact) => fact.statementText)));
  }

  it.each([
    [
      "a statement inside a nested comment",
      ["/* outer /* inner */ SELECT 1 FROM hidden; */", "SELECT 2 FROM shown;"],
      ["SELECT 2 FROM shown"],
    ],
    ["a glob in a comment", ["/* files: src/**/*.sql */", "SELECT 2 FROM shown;"], ["SELECT 2 FROM shown"]],
    [
      "a quote inside a nested comment",
      ["/* outer /* inner */ it's hidden; */", "SELECT 2 FROM shown;"],
      ["SELECT 2 FROM shown"],
    ],
    [
      "a GO line inside a nested comment",
      ["SELECT 1 FROM before;", "/* outer /* inner */", "GO", "SELECT 2 FROM hidden; */", "SELECT 3 FROM shown;"],
      ["SELECT 1 FROM before", "SELECT 3 FROM shown"],
    ],
  ])("reads no statement from %s", (_label, lines, expected) => {
    expect(statementTexts("nested.sql", lines)).toEqual(expected);
  });

  it("keeps the position of a statement after a nested comment", () => {
    const facts = extractSqlFactsFromSource(
      "nested.sql",
      ["/* outer", "   /* inner */", "   still a comment */", "SELECT 2 FROM shown;"].join("\n"),
    );

    expect(facts).toEqual([
      expect.objectContaining({ kind: "reads_from", objectName: "shown", startLine: 4, startColumn: 1 }),
    ]);
  });

  it("ends a comment at its first closing delimiter when nesting would leave it open, as MySQL and SQLite do", () => {
    expect(statementTexts("mysql.sql", ["/* see /* below */ SELECT 1 FROM one;", "SELECT 2 FROM two;"])).toEqual([
      "SELECT 1 FROM one",
      "SELECT 2 FROM two",
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

  it("records nested EXISTS relation reads without inventing a string source", () => {
    const facts = extractSqlFactsFromSource(
      "nested.sql",
      "SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM accounts a) AND 'FROM decoy' <> '';",
    );
    expect(facts.map((fact) => [fact.kind, fact.objectName])).toEqual([
      ["reads_from", "users"],
      ["reads_from", "accounts"],
    ]);
  });

  it("bounds a nested FROM at its closing parenthesis instead of reading outer columns as sources", () => {
    const facts = extractSqlFactsFromSource("nested.sql", "SELECT (SELECT id FROM users), email FROM accounts;");
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "users",
      "accounts",
    ]);
  });

  it("keeps escaped E-string text out of relation facts after statement splitting", () => {
    const source = [String.raw`SELECT E'can\'t; FROM hidden';`, "SELECT id FROM users;"].join("\n");
    const facts = extractSqlFactsFromSource("literal.sql", source);
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual(["users"]);
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

  it("reads relations named by the statements inside a BEGIN/END routine body", () => {
    const filePath = path.join(fixtureRoot, "reports", "procedure.sql");
    const facts = extractSqlFactsFromSource(
      filePath,
      [
        "CREATE PROCEDURE p AS BEGIN SELECT u.id FROM users u; SELECT g.id FROM get_users() g; END;",
        "CREATE PROCEDURE q(begin integer) AS BEGIN IF 1 THEN SELECT id FROM accounts; END IF; END;",
        "CREATE FUNCTION f() RETURNS integer AS $$ BEGIN SELECT id FROM hidden; END $$ LANGUAGE sql;",
      ].join("\n"),
    );

    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "users",
      "get_users",
      "accounts",
    ]);
  });

  it("relates each JOIN to the first source of its own query", () => {
    const facts = extractSqlFactsFromSource(
      path.join(fixtureRoot, "reports", "nested-join.sql"),
      [
        "SELECT * FROM users JOIN orgs ON orgs.id = users.org_id",
        "WHERE EXISTS (SELECT 1 FROM accounts a JOIN roles r ON r.id = a.role_id);",
      ].join("\n"),
    );

    expect(
      facts.filter((fact) => fact.kind === "joins").map((fact) => [fact.objectName, fact.relatedObjectName]),
    ).toEqual([
      ["orgs", "users"],
      ["roles", "accounts"],
    ]);
  });

  it("keeps relation reads when CASE, IF, and LOOP end inside a BEGIN/END body", () => {
    const facts = extractSqlFactsFromSource(
      path.join(fixtureRoot, "reports", "case-end.sql"),
      [
        "CREATE PROCEDURE p AS BEGIN SELECT CASE WHEN id = 1 THEN 1 ELSE 0 END AS flag FROM users; END;",
        "CREATE PROCEDURE q AS BEGIN IF 1 THEN SELECT id FROM accounts; END IF; SELECT id FROM roles; END;",
        "CREATE PROCEDURE r AS BEGIN LOOP SELECT id FROM orgs; END LOOP; SELECT id FROM teams; END;",
        "CREATE PROCEDURE s AS BEGIN BEGIN SELECT id FROM projects; END; SELECT id FROM tasks; END;",
      ].join("\n"),
    );

    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "users",
      "accounts",
      "roles",
      "orgs",
      "teams",
      "projects",
      "tasks",
    ]);
    const bodyOf = (name: string): string =>
      facts.find((fact) => fact.kind === "defines_routine" && fact.objectName === name)?.statementText ?? "";
    expect(bodyOf("p")).toContain("FROM users");
    expect(bodyOf("q")).toContain("FROM roles");
    expect(bodyOf("r")).toContain("FROM teams");
    expect(bodyOf("s")).toContain("FROM tasks");
  });
  it("records a JOIN inside a CTE body once", () => {
    const facts = extractSqlFactsFromSource(
      "cte-join.sql",
      "WITH c AS (SELECT * FROM users JOIN accounts ON accounts.id = users.id) SELECT * FROM c",
    );

    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual(["users"]);
    expect(
      facts.filter((fact) => fact.kind === "joins").map((fact) => [fact.objectName, fact.relatedObjectName]),
    ).toEqual([["accounts", "users"]]);
  });

  it("splits GO after consecutive T-SQL IF blocks", () => {
    const facts = extractSqlFactsFromSource(
      "if-go.sql",
      [
        "CREATE PROCEDURE p AS",
        "BEGIN",
        "  IF 1 = 1",
        "  BEGIN",
        "    SELECT 1",
        "  END",
        "  IF 1 = 1",
        "  BEGIN",
        "    SELECT 2",
        "  END",
        "END",
        "GO",
        "CREATE PROCEDURE q AS",
        "BEGIN",
        "  SELECT 1",
        "END",
      ].join("\n"),
    );

    expect(facts.filter((fact) => fact.kind === "defines_routine").map((fact) => fact.objectName)).toEqual(["p", "q"]);
  });

  it("does not treat a variable or qualified case as a CASE block", () => {
    const facts = extractSqlFactsFromSource(
      "case-word.sql",
      [
        "CREATE TABLE users (id integer);",
        "CREATE PROCEDURE p @case int AS",
        "BEGIN",
        '  SELECT id FROM users WHERE t.case = :case AND $case = "case" AND [case] = @case;',
        "END",
        "GO",
        "CREATE PROCEDURE q AS",
        "BEGIN",
        "  SELECT 1;",
        "END",
      ].join("\n"),
    );

    expect(facts.filter((fact) => fact.kind === "defines_routine").map((fact) => fact.objectName)).toEqual(["p", "q"]);
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual(["users"]);
  });

  it("keeps both procedures and the table read when case is qualified across space or a comment", () => {
    const facts = extractSqlFactsFromSource(
      "case-qualified.sql",
      [
        "CREATE PROCEDURE p AS",
        "BEGIN",
        "  SELECT t . case FROM users t;",
        "END",
        "GO",
        "CREATE PROCEDURE q AS",
        "BEGIN",
        "  SELECT t. /* note */ case FROM accounts t;",
        "END",
        "GO",
        "CREATE PROCEDURE r AS",
        "BEGIN",
        "  SELECT t. -- note",
        "    case FROM roles t;",
        "END",
      ].join("\n"),
    );

    expect(facts.filter((fact) => fact.kind === "defines_routine").map((fact) => fact.objectName)).toEqual([
      "p",
      "q",
      "r",
    ]);
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "users",
      "accounts",
      "roles",
    ]);
  });

  it("does not let a column or parameter named loop or repeat swallow the next statement", () => {
    const tables = extractSqlFactsFromSource(
      "loop-column.sql",
      [
        "CREATE TABLE a (repeat integer);",
        "CREATE TABLE b (id integer);",
        "CREATE TABLE c (loop integer);",
        "CREATE TABLE d (id integer, repeat integer, loop integer);",
      ].join("\n"),
    );
    expect(tables.filter((fact) => fact.kind === "defines_table").map((fact) => fact.objectName)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);

    const routines = extractSqlFactsFromSource(
      "loop-param.sql",
      [
        "CREATE PROCEDURE p(repeat integer, loop integer) AS",
        "BEGIN",
        "  SELECT id FROM users;",
        "END",
        "GO",
        "CREATE PROCEDURE q AS",
        "BEGIN",
        "  SELECT t . loop FROM accounts;",
        "  SELECT t. /* note */ repeat FROM roles;",
        "END",
      ].join("\n"),
    );
    expect(routines.filter((fact) => fact.kind === "defines_routine").map((fact) => fact.objectName)).toEqual([
      "p",
      "q",
    ]);
    expect(routines.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "users",
      "accounts",
      "roles",
    ]);
    const body =
      routines.find((fact) => fact.kind === "defines_routine" && fact.objectName === "q")?.statementText ?? "";
    expect(body).toContain("FROM roles");
  });

  it("keeps LOOP, REPEAT, and labeled loop bodies inside the routine", () => {
    const facts = extractSqlFactsFromSource(
      "loop-body.sql",
      [
        "CREATE PROCEDURE p AS BEGIN",
        "  LOOP",
        "    SELECT id FROM orgs;",
        "  END LOOP;",
        "  SELECT id FROM teams;",
        "END;",
        "CREATE PROCEDURE q AS BEGIN",
        "  REPEAT",
        "    SELECT id FROM users;",
        "  UNTIL 1 = 1",
        "  END REPEAT;",
        "  SELECT id FROM accounts;",
        "END;",
        "CREATE PROCEDURE s AS BEGIN",
        "  lbl: LOOP",
        "    SELECT id FROM roles;",
        "  END LOOP lbl;",
        "  SELECT id FROM projects;",
        "END;",
        "CREATE PROCEDURE w AS BEGIN",
        "  WHILE id < 10 LOOP",
        "    SELECT id FROM tasks;",
        "  END LOOP;",
        "  SELECT id FROM logs;",
        "END;",
        "CREATE PROCEDURE f AS BEGIN",
        "  FOR i IN 1..10 LOOP",
        "    SELECT id FROM events;",
        "  END LOOP;",
        "  SELECT id FROM seats;",
        "END;",
        "CREATE PROCEDURE e AS BEGIN",
        "  SELECT CASE WHEN id = 1 THEN loop ELSE 0 END AS flag FROM flags;",
        "  SELECT id FROM marks;",
        "END;",
      ].join("\n"),
    );

    const bodyOf = (name: string): string =>
      facts.find((fact) => fact.kind === "defines_routine" && fact.objectName === name)?.statementText ?? "";
    expect(facts.filter((fact) => fact.kind === "defines_routine").map((fact) => fact.objectName)).toEqual([
      "p",
      "q",
      "s",
      "w",
      "f",
      "e",
    ]);
    expect(bodyOf("p")).toContain("FROM teams");
    expect(bodyOf("q")).toContain("FROM accounts");
    expect(bodyOf("s")).toContain("FROM projects");
    expect(bodyOf("w")).toContain("FROM logs");
    expect(bodyOf("f")).toContain("FROM seats");
    expect(bodyOf("e")).toContain("FROM marks");
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "orgs",
      "teams",
      "users",
      "accounts",
      "roles",
      "projects",
      "tasks",
      "logs",
      "events",
      "seats",
      "flags",
      "marks",
    ]);
  });

  it("keeps both procedures when while is qualified across space or a comment", () => {
    const facts = extractSqlFactsFromSource(
      "while-qualified.sql",
      [
        "CREATE PROCEDURE p AS",
        "BEGIN",
        "  SELECT t . while, loop FROM users t;",
        "END",
        "GO",
        "CREATE PROCEDURE q AS",
        "BEGIN",
        "  SELECT t. /* x */ while, loop FROM accounts t;",
        "END",
        "GO",
        "CREATE PROCEDURE r AS",
        "BEGIN",
        "  SELECT id FROM roles;",
        "END",
      ].join("\n"),
    );

    expect(facts.filter((fact) => fact.kind === "defines_routine").map((fact) => fact.objectName)).toEqual([
      "p",
      "q",
      "r",
    ]);
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "users",
      "accounts",
      "roles",
    ]);
  });

  it("keeps both reads when a string holds a line-comment marker before LOOP", () => {
    const facts = extractSqlFactsFromSource(
      "string-comment-loop.sql",
      "CREATE PROCEDURE p AS BEGIN SELECT '--'; LOOP SELECT id FROM users; END LOOP; SELECT id FROM accounts; END",
    );

    const body = facts.find((fact) => fact.kind === "defines_routine" && fact.objectName === "p")?.statementText ?? "";
    expect(body).toContain("FROM users");
    expect(body).toContain("FROM accounts");
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "users",
      "accounts",
    ]);
  });

  it("keeps the read after a procedural CASE that contains LOOP or REPEAT", () => {
    const facts = extractSqlFactsFromSource(
      "case-stmt.sql",
      [
        "CREATE PROCEDURE p AS BEGIN",
        "  CASE 1 WHEN 1 THEN LOOP SELECT id FROM users; END LOOP; END CASE;",
        "  SELECT id FROM tail_users;",
        "END;",
        "CREATE PROCEDURE q AS BEGIN",
        "  CASE 1 WHEN 1 THEN REPEAT SELECT id FROM accounts; UNTIL 1 = 1 END REPEAT; END CASE;",
        "  SELECT id FROM tail_accounts;",
        "END;",
        "CREATE PROCEDURE e AS BEGIN",
        "  SELECT CASE WHEN loop = 1 THEN 1 END FROM flags;",
        "  SELECT id FROM marks;",
        "END;",
      ].join("\n"),
    );

    const bodyOf = (name: string): string =>
      facts.find((fact) => fact.kind === "defines_routine" && fact.objectName === name)?.statementText ?? "";
    expect(facts.filter((fact) => fact.kind === "defines_routine").map((fact) => fact.objectName)).toEqual([
      "p",
      "q",
      "e",
    ]);
    expect(bodyOf("p")).toContain("FROM tail_users");
    expect(bodyOf("q")).toContain("FROM tail_accounts");
    expect(bodyOf("e")).toContain("FROM marks");
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "users",
      "tail_users",
      "accounts",
      "tail_accounts",
      "flags",
      "marks",
    ]);
  });

  it("keeps the routine body when CASE is followed by a decimal literal", () => {
    const facts = extractSqlFactsFromSource(
      "case-decimal.sql",
      "CREATE PROCEDURE p AS BEGIN SELECT CASE .5 WHEN .5 THEN 1 ELSE 0 END AS flag FROM users; END",
    );

    const body = facts.find((fact) => fact.kind === "defines_routine" && fact.objectName === "p")?.statementText ?? "";
    expect(body).toContain("CASE .5");
    expect(body).toContain("FROM users");
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual(["users"]);
  });

  it("keeps the routine and its trailing read after a PL/pgSQL or quoted loop label", () => {
    const plpgsql = "BEGIN <<retry>> LOOP NULL; END LOOP retry; SELECT id FROM users; END";
    const mysql = "BEGIN `retry`: LOOP NULL; END LOOP `retry`; SELECT id FROM accounts; END";
    const facts = extractSqlFactsFromSource(
      "loop-label.sql",
      [`CREATE PROCEDURE p AS ${plpgsql};`, `CREATE PROCEDURE q AS ${mysql};`].join("\n"),
    );

    const bodyOf = (name: string): string =>
      facts.find((fact) => fact.kind === "defines_routine" && fact.objectName === name)?.statementText ?? "";
    expect(facts.filter((fact) => fact.kind === "defines_routine").map((fact) => fact.objectName)).toEqual(["p", "q"]);
    expect(bodyOf("p")).toContain(plpgsql);
    expect(bodyOf("q")).toContain(mysql);
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "users",
      "accounts",
    ]);
  });

  it("keeps the tail read when CASE is inside a WHILE condition", () => {
    const facts = extractSqlFactsFromSource(
      "while-case.sql",
      [
        "CREATE PROCEDURE p AS BEGIN",
        "  WHILE CASE WHEN 1 = 1 THEN 1 ELSE 0 END = 1 LOOP",
        "    SELECT id FROM inner_users;",
        "  END LOOP;",
        "  SELECT id FROM tail_users;",
        "END;",
      ].join("\n"),
    );

    const body = facts.find((fact) => fact.kind === "defines_routine" && fact.objectName === "p")?.statementText ?? "";
    expect(body).toContain("FROM tail_users");
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "inner_users",
      "tail_users",
    ]);
  });

  it("indexes both tables after a BEGIN that selects columns named while and loop", () => {
    const facts = extractSqlFactsFromSource(
      "while-column.sql",
      [
        "BEGIN",
        "  SELECT while, loop FROM users;",
        "END;",
        "CREATE TABLE a (id integer);",
        "CREATE TABLE b (id integer);",
      ].join("\n"),
    );

    expect(facts.filter((fact) => fact.kind === "defines_table").map((fact) => fact.objectName)).toEqual(["a", "b"]);
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual(["users"]);
  });

  it("indexes both procedures when repeat is an operand in a loop condition", () => {
    const facts = extractSqlFactsFromSource(
      "repeat-operand.sql",
      [
        "CREATE PROCEDURE p AS BEGIN",
        "  WHILE repeat < 10 LOOP",
        "    SELECT id FROM users;",
        "  END LOOP;",
        "END;",
        "CREATE PROCEDURE q AS BEGIN",
        "  SELECT id FROM accounts;",
        "END;",
      ].join("\n"),
    );

    expect(facts.filter((fact) => fact.kind === "defines_routine").map((fact) => fact.objectName)).toEqual(["p", "q"]);
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "users",
      "accounts",
    ]);
  });

  it("keeps both procedures and the read after MySQL DO CASE", () => {
    const facts = extractSqlFactsFromSource(
      "do-case.sql",
      [
        "CREATE PROCEDURE p() BEGIN",
        "  DO CASE WHEN 1 THEN 1 ELSE 0 END;",
        "  SELECT id FROM users;",
        "END;",
        "CREATE PROCEDURE q() BEGIN",
        "  SELECT id FROM accounts;",
        "END;",
      ].join("\n"),
    );

    const body = facts.find((fact) => fact.kind === "defines_routine" && fact.objectName === "p")?.statementText ?? "";
    expect(facts.filter((fact) => fact.kind === "defines_routine").map((fact) => fact.objectName)).toEqual(["p", "q"]);
    expect(body).toContain("FROM users");
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "users",
      "accounts",
    ]);
  });

  it("treats T-SQL END IF without a semicolon as a plain END", () => {
    const facts = extractSqlFactsFromSource(
      "end-if-var.sql",
      [
        "BEGIN",
        "  SELECT id FROM kept;",
        "END IF @x = 1",
        "BEGIN",
        "  SELECT id FROM users;",
        "END;",
        "CREATE TABLE accounts (id integer);",
        "CREATE TABLE roles (id integer);",
      ].join("\n"),
    );

    expect(facts.filter((fact) => fact.kind === "defines_table").map((fact) => fact.objectName)).toEqual([
      "accounts",
      "roles",
    ]);
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "kept",
      "users",
    ]);
  });

  it("ends the batch at GO while a BEGIN is still open", () => {
    const facts = extractSqlFactsFromSource(
      "open-go.sql",
      ["BEGIN", "  SELECT id FROM users", "GO", "CREATE TABLE accounts (id integer);"].join("\n"),
    );

    expect(facts.filter((fact) => fact.kind === "defines_table").map((fact) => fact.objectName)).toEqual(["accounts"]);
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual(["users"]);
  });

  it("indexes the next table when a trigger CASE ends with the alias loop, while, or for", () => {
    for (const alias of ["loop", "while", "for"]) {
      const facts = extractSqlFactsFromSource(
        "trigger-case-alias.sql",
        [
          `CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN NEW.id = 1 THEN 1 ELSE 0 END ${alias}; END;`,
          "CREATE TABLE b (id integer);",
        ].join("\n"),
      );

      expect(facts.filter((fact) => fact.kind === "defines_routine").map((fact) => fact.objectName)).toEqual(["t"]);
      expect(facts.filter((fact) => fact.kind === "defines_table").map((fact) => fact.objectName)).toEqual(["b"]);
      expect(facts.find((fact) => fact.kind === "defines_table")).toMatchObject({
        statementText: "CREATE TABLE b (id integer)",
        startLine: 2,
      });
    }
  });

  it("keeps the read after ORDER BY CASE ends at FOR UPDATE or FOR SHARE", () => {
    for (const clause of ["FOR UPDATE", "FOR SHARE"]) {
      const facts = extractSqlFactsFromSource(
        "case-for-update.sql",
        [
          "CREATE PROCEDURE p AS BEGIN",
          `  SELECT id FROM users ORDER BY CASE WHEN id = 1 THEN 0 ELSE 1 END ${clause};`,
          "  SELECT id FROM accounts;",
          "END;",
          "CREATE PROCEDURE q AS BEGIN",
          "  SELECT id FROM roles;",
          "END;",
        ].join("\n"),
      );

      expect(facts.filter((fact) => fact.kind === "defines_routine").map((fact) => fact.objectName)).toEqual([
        "p",
        "q",
      ]);
      expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
        "users",
        "accounts",
        "roles",
      ]);
    }
  });

  it("leaves a BEGIN open when END LOOP is the compound terminator", () => {
    const facts = extractSqlFactsFromSource(
      "end-loop-begin.sql",
      [
        "CREATE PROCEDURE p AS BEGIN",
        "  LOOP",
        "    SELECT id FROM users;",
        "  END LOOP;",
        "  SELECT id FROM accounts;",
        "END;",
        "CREATE TABLE b (id integer);",
      ].join("\n"),
    );

    const body = facts.find((fact) => fact.kind === "defines_routine" && fact.objectName === "p")?.statementText ?? "";
    expect(body).toContain("END LOOP");
    expect(body).toContain("FROM accounts");
    expect(body).not.toContain("CREATE TABLE b");
    expect(facts.filter((fact) => fact.kind === "defines_table").map((fact) => fact.objectName)).toEqual(["b"]);
    expect(facts.filter((fact) => fact.kind === "reads_from").map((fact) => fact.objectName)).toEqual([
      "users",
      "accounts",
    ]);
  });

  it("classifies qualified keywords from one trivia table per scan", () => {
    const statements = 20_000;
    const reads = Array.from({ length: statements }, (_, index) => `  SELECT t. /* x */ case FROM t${index};`);
    const source = ["CREATE PROCEDURE p AS BEGIN", ...reads, "  SELECT id FROM users;", "END"].join("\n");
    resetSqlTriviaClassificationShape();
    const facts = extractSqlFactsFromSource("wide-case.sql", source);
    const shape = sqlTriviaClassificationShape();
    const body = facts.find((fact) => fact.kind === "defines_routine" && fact.objectName === "p")?.statementText ?? "";

    expect(shape.uncachedSkips).toBe(0);
    // One table for the file, one for the routine body, one for its split, then one per inner statement.
    expect(shape.builds).toBeLessThanOrEqual(statements + 32);
    expect(body).toContain("t. /* x */ case");
    expect(body).toContain("FROM users");
    expect(facts.some((fact) => fact.kind === "reads_from" && fact.objectName === "users")).toBe(true);
  }, 60_000);
});
