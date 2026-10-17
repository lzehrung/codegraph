import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  analyzeImpactFromDiff,
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
  chunkFile,
  extractSqlFactsFromSource,
  findReferences,
  goToDefinition,
  listSymbols,
  supportForFile,
  type ProjectIndex,
} from "../../src/index.js";
import { previewRenameWithSession, type RenamePreviewResponse } from "../../src/agent/rename-preview.js";
import { createAgentSession } from "../../src/agent/session.js";
import { workspaceSymbolsWithSession } from "../../src/agent/workspace-symbols.js";
import { closeDiskCacheDatabase } from "../../src/indexer/build-cache/module-cache.js";
import { findRenameReferences, findUsageReferences } from "../../src/indexer/navigation.js";
import type { FindReferencesResult, GoToResult } from "../../src/indexer/types.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { LANG_CONFIGS } from "../../src/bootstrap/tree-sitter-languages.js";

it("registers SQL files as language support", () => {
  expect(supportForFile("schema.sql")?.id).toBe("sql");
  expect(LANG_CONFIGS.sql).toBeDefined();
});

it("chunks SQL at statement boundaries", () => {
  const config = LANG_CONFIGS.sql;
  expect(config).toBeDefined();

  const chunks = chunkFile({
    language: config,
    filePath: "schema.sql",
    source: [
      "CREATE TABLE users (",
      "  id integer primary key,",
      "  organization_id integer",
      ");",
      "",
      "CREATE INDEX users_org_idx ON users (organization_id);",
      "",
      "SELECT u.id, o.name",
      "FROM users u",
      "JOIN organizations o ON o.id = u.organization_id;",
    ].join("\n"),
    minTokens: 1,
    maxTokens: 100,
  });

  expect(chunks.map((chunk) => chunk.type)).toEqual(["create", "create", "select"]);
  expect(chunks[0]?.text).toContain("CREATE TABLE users");
  expect(chunks[1]?.text).toContain("CREATE INDEX users_org_idx");
  expect(chunks[2]?.text).toContain("JOIN organizations");
});

it("keeps T-SQL batches and nested CTE fixtures as SQL facts", async () => {
  const fixtureRoot = path.resolve(process.cwd(), "tests", "samples", "sql", "facts");
  const batchFile = path.join(fixtureRoot, "tsql_batches.sql");
  const nestedCteFile = path.join(fixtureRoot, "nested_ctes.sql");
  const [batchSource, nestedCteSource] = await Promise.all([
    fsp.readFile(batchFile, "utf8"),
    fsp.readFile(nestedCteFile, "utf8"),
  ]);

  const batchFacts = extractSqlFactsFromSource(batchFile, batchSource);
  const nestedCteFacts = extractSqlFactsFromSource(nestedCteFile, nestedCteSource);

  expect(new Set(batchFacts.map((fact) => fact.statementText)).size).toBe(3);
  expect(nestedCteFacts.map((fact) => fact.objectName)).toEqual(["accounts", "users"]);
});

it("indexes SQL object definitions as language symbols", async () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "sql", "graph");
  const schemaFile = path.join(samplePath, "001_create_users.sql").replace(/\\/g, "/");
  const index = await buildProjectIndexFromFiles(samplePath, [schemaFile]);

  expect(listSymbols(index, { file: schemaFile })).toContainEqual(
    expect.objectContaining({
      file: schemaFile,
      name: "users",
    }),
  );
});

it("reports SQL definition lines from each statement's actual start", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-statement-lines-"));
  try {
    const schemaFile = path.join(root, "multi_statement_schema.sql").replace(/\\/g, "/");
    await fsp.writeFile(
      schemaFile,
      ["CREATE TABLE accounts (id integer);", "CREATE TABLE users (id integer);", "SELECT id FROM users;"].join("\n"),
      "utf8",
    );

    const index = await buildProjectIndexFromFiles(root, [schemaFile]);
    const symbols = listSymbols(index, { file: schemaFile });

    expect(symbols).toContainEqual(
      expect.objectContaining({
        name: "accounts",
        range: expect.objectContaining({ start: expect.objectContaining({ line: 1, column: 1 }) }),
      }),
    );
    expect(symbols).toContainEqual(
      expect.objectContaining({
        name: "users",
        range: expect.objectContaining({ start: expect.objectContaining({ line: 2, column: 1 }) }),
      }),
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("includes discovered SQL files in the normal repository index", async () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "sql", "graph");
  const schemaFile = path.join(samplePath, "001_create_users.sql").replace(/\\/g, "/");
  const reportFile = path.join(samplePath, "report.sql").replace(/\\/g, "/");
  const index = await buildProjectIndex(samplePath);

  expect(index.byFile.has(fileIdentityKey(schemaFile))).toBe(true);
  expect(index.byFile.has(fileIdentityKey(reportFile))).toBe(true);
  expect(index.graph.edges).toContainEqual(
    expect.objectContaining({
      from: reportFile,
      raw: "sql:reads_from:users",
      to: { type: "file", path: schemaFile },
    }),
  );
});

describe("native-only SQL support", () => {
  it("indexes SQL without a non-native parser when native parsing is unavailable", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-native-only-"));
    const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
    await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\n", "utf8");

    const parseSpy = vi.fn(() => {
      throw new Error(
        "Non-native Tree-sitter parser is unavailable for grammar loading; native parser is the only grammar backend",
      );
    });

    vi.resetModules();
    vi.doMock("../../src/native/tree-sitter-native.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/native/tree-sitter-native.js")>(
        "../../src/native/tree-sitter-native.js",
      );
      return {
        ...actual,
        getNativeQueryExecution: vi.fn(() => ({
          results: null,
          fallbackReason: "unavailable",
        })),
        getNativeSyntaxTreeExecution: vi.fn(() => ({
          tree: null,
          fallbackReason: "unavailable",
        })),
      };
    });

    try {
      const { buildProjectIndex, listSymbols } = await import("../../src/index.js");
      const index = await buildProjectIndex(root);

      expect(listSymbols(index, { file: schemaFile })).toContainEqual(
        expect.objectContaining({
          name: "users",
          kind: "table",
        }),
      );
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../../src/native/tree-sitter-native.js");
      vi.resetModules();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("SQL routine symbols", () => {
  it("indexes a CREATE FUNCTION routine and navigates a call site to it", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-routine-"));
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
      const routine = "CREATE FUNCTION compute_total(amount integer) RETURNS integer AS $$ SELECT amount $$;\n";
      const query = "SELECT compute_total(id) FROM users;\n";
      await fsp.writeFile(schemaFile, routine, "utf8");
      await fsp.writeFile(reportFile, query, "utf8");
      const index = await buildProjectIndexFromFiles(root, [schemaFile, reportFile]);

      const routineSymbols = listSymbols(index, { file: schemaFile }).filter(
        (symbol) => symbol.name === "compute_total",
      );
      expect(routineSymbols.map((symbol) => symbol.kind)).toEqual(["routine"]);

      const result = await goToDefinition(index, {
        file: reportFile,
        line: 1,
        column: query.indexOf("compute_total") + 1,
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.definition.file).toBe(schemaFile);
      expect(result.definition.range.start.line).toBe(1);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("SQL routine call sites", () => {
  type SqlProject = { root: string; file: (name: string) => string; index: ProjectIndex };

  async function withSqlProject(
    files: Record<string, readonly string[]>,
    run: (project: SqlProject) => Promise<void>,
  ): Promise<void> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-routine-calls-"));
    try {
      for (const [name, lines] of Object.entries(files)) {
        await fsp.writeFile(path.join(root, name), [...lines, ""].join("\n"), "utf8");
      }
      const index = await buildProjectIndex(root, { cache: "memory" });
      await run({ root, file: (name) => path.join(root, name).replace(/\\/g, "/"), index });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }

  function tokenColumn(line: string, token: string, occurrence = 0): number {
    let fromIndex = 0;
    for (let found = 0; found <= occurrence; found += 1) {
      const index = line.indexOf(token, fromIndex);
      if (index < 0) throw new Error(`Expected ${token} in ${line}`);
      if (found === occurrence) return index + 1;
      fromIndex = index + token.length;
    }
    throw new Error(`Expected ${token} in ${line}`);
  }

  /** `file:line:column` of a token, the form `referenceSites` reports. */
  function siteAt(file: string, lines: readonly string[], line: number, token: string, occurrence = 0): string {
    return `${file}:${line}:${tokenColumn(lines[line - 1] ?? "", token, occurrence)}`;
  }

  function okReferences(result: FindReferencesResult): Extract<FindReferencesResult, { status: "ok" }> {
    if (result.status !== "ok") throw new Error(`Expected references, got ${result.reason}`);
    return result;
  }

  function referenceSites(root: string, result: FindReferencesResult): string[] {
    return okReferences(result)
      .references.map((reference) => {
        const file = path.relative(root, reference.file).replace(/\\/g, "/");
        return `${file}:${reference.range.start.line}:${reference.range.start.column}`;
      })
      .sort();
  }

  function gotoTarget(root: string, result: GoToResult): string {
    if (result.status !== "ok") return "not_found";
    return `${path.relative(root, result.definition.file).replace(/\\/g, "/")}:${result.definition.range.start.line}`;
  }

  async function referencesAt(
    project: SqlProject,
    file: string,
    lines: readonly string[],
    line: number,
    token: string,
    occurrence = 0,
  ): Promise<FindReferencesResult> {
    const column = tokenColumn(lines[line - 1] ?? "", token, occurrence);
    return await findReferences(project.index, { file: project.file(file), line, column });
  }

  async function gotoAt(
    project: SqlProject,
    file: string,
    lines: readonly string[],
    line: number,
    token: string,
    occurrence = 0,
  ): Promise<string> {
    const column = tokenColumn(lines[line - 1] ?? "", token, occurrence);
    return gotoTarget(project.root, await goToDefinition(project.index, { file: project.file(file), line, column }));
  }

  /**
   * The files impact reports besides the changed file. A declaration counts as a reference to itself,
   * as in other languages, so the changed file is reported too.
   */
  function dependentFiles(impact: { impacted: readonly { file: string }[] }, changedFile: string): string[] {
    return impact.impacted
      .map((item) => item.file)
      .filter((file) => file !== changedFile)
      .sort();
  }

  /** Previews renaming the symbol called `name`. A schema-qualified symbol is found by its last part. */
  async function previewRenameOf(project: SqlProject, name: string, newName: string): Promise<RenamePreviewResponse> {
    const session = createAgentSession({ root: project.root, freshness: { policy: "check" } });
    try {
      const query = name.split(".").pop() ?? name;
      const symbols = await workspaceSymbolsWithSession(session, { root: project.root, query });
      const target = symbols.symbols.find((symbol) => symbol.name === name);
      if (!target) throw new Error(`Expected the symbol ${name}`);
      return await previewRenameWithSession(session, { root: project.root, handle: target.handle, newName });
    } finally {
      session.invalidate();
    }
  }

  /** `file:line:column` of each edit in a rename preview, the form `siteAt` reports. */
  function editSites(preview: RenamePreviewResponse): string[] {
    return preview.edits.map((edit) => `${edit.file}:${edit.range.start.line}:${edit.range.start.column}`).sort();
  }

  /** `file:line:column` of each site a rename preview cannot edit safely. */
  function unsafeRenameSites(preview: RenamePreviewResponse): string[] {
    return preview.unsafeSites
      .map((site) => `${site.location.file}:${site.location.range.start.line}:${site.location.range.start.column}`)
      .sort();
  }

  it("finds a routine call in a SELECT with complete coverage and goes from the call to the routine", async () => {
    const schema = ["CREATE FUNCTION normalize_email(e text) RETURNS text AS $$ SELECT lower(e) $$ LANGUAGE sql;"];
    const report = ["SELECT normalize_email(email) FROM users;"];
    await withSqlProject({ "schema.sql": schema, "report.sql": report }, async (project) => {
      const result = await referencesAt(project, "schema.sql", schema, 1, "normalize_email");

      expect(referenceSites(project.root, result)).toEqual(
        [siteAt("schema.sql", schema, 1, "normalize_email"), siteAt("report.sql", report, 1, "normalize_email")].sort(),
      );
      expect(okReferences(result).referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      expect(await gotoAt(project, "report.sql", report, 1, "normalize_email")).toBe("schema.sql:1");
    });
  });

  it("finds CALL, T-SQL EXEC and EXECUTE, and trigger EXECUTE FUNCTION calls", async () => {
    const defs = [
      "CREATE PROCEDURE audit_user(id integer) LANGUAGE sql AS $$ SELECT 1 $$;",
      "CREATE FUNCTION touch_updated() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;",
    ];
    const tsql = ["CREATE PROCEDURE dbo.refresh_totals @account_id int AS BEGIN SELECT 1; END;"];
    const use = [
      "CALL audit_user(1);",
      "CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated();",
      "EXEC dbo.refresh_totals @account_id = 7;",
      "EXECUTE dbo.refresh_totals 8;",
      "EXEC @status = dbo.refresh_totals 9;",
      "EXEC ('SELECT 1');",
      "GRANT EXECUTE TO app;",
    ];
    await withSqlProject({ "defs.sql": defs, "tsql.sql": tsql, "use.sql": use }, async (project) => {
      const procedure = await referencesAt(project, "defs.sql", defs, 1, "audit_user");
      const triggerFunction = await referencesAt(project, "defs.sql", defs, 2, "touch_updated");
      const tsqlProcedure = await referencesAt(project, "tsql.sql", tsql, 1, "dbo.refresh_totals");

      expect(referenceSites(project.root, procedure)).toEqual(
        [siteAt("defs.sql", defs, 1, "audit_user"), siteAt("use.sql", use, 1, "audit_user")].sort(),
      );
      expect(referenceSites(project.root, triggerFunction)).toEqual(
        [siteAt("defs.sql", defs, 2, "touch_updated"), siteAt("use.sql", use, 2, "touch_updated")].sort(),
      );
      expect(referenceSites(project.root, tsqlProcedure)).toEqual(
        [
          siteAt("tsql.sql", tsql, 1, "dbo.refresh_totals"),
          siteAt("use.sql", use, 3, "dbo.refresh_totals"),
          siteAt("use.sql", use, 4, "dbo.refresh_totals"),
          siteAt("use.sql", use, 5, "dbo.refresh_totals"),
        ].sort(),
      );
      expect(await gotoAt(project, "use.sql", use, 1, "audit_user")).toBe("defs.sql:1");
      expect(await gotoAt(project, "use.sql", use, 2, "touch_updated")).toBe("defs.sql:2");
      expect(await gotoAt(project, "use.sql", use, 3, "dbo.refresh_totals")).toBe("tsql.sql:1");
      expect(await gotoAt(project, "use.sql", use, 5, "dbo.refresh_totals")).toBe("tsql.sql:1");
    });
  });

  it("finds a call inside a $$ body and inside a BEGIN and END body", async () => {
    const defs = [
      "CREATE FUNCTION normalize_email(e text) RETURNS text AS $$ SELECT lower(e) $$ LANGUAGE sql;",
      "CREATE FUNCTION wrap_email(e text) RETURNS text AS $body$",
      "BEGIN",
      "  RETURN normalize_email(e);",
      "END",
      "$body$ LANGUAGE plpgsql;",
    ];
    const tsql = [
      "CREATE PROCEDURE dbo.inner_proc AS BEGIN SELECT 1; END;",
      "GO",
      "CREATE PROCEDURE dbo.outer_proc AS",
      "BEGIN",
      "  EXEC dbo.inner_proc;",
      "END;",
    ];
    await withSqlProject({ "defs.sql": defs, "tsql.sql": tsql }, async (project) => {
      const plpgsql = await referencesAt(project, "defs.sql", defs, 1, "normalize_email");
      const inner = await referencesAt(project, "tsql.sql", tsql, 1, "dbo.inner_proc");

      expect(referenceSites(project.root, plpgsql)).toEqual(
        [siteAt("defs.sql", defs, 1, "normalize_email"), siteAt("defs.sql", defs, 4, "normalize_email")].sort(),
      );
      expect(referenceSites(project.root, inner)).toEqual(
        [siteAt("tsql.sql", tsql, 1, "dbo.inner_proc"), siteAt("tsql.sql", tsql, 5, "dbo.inner_proc")].sort(),
      );
      expect(await gotoAt(project, "defs.sql", defs, 4, "normalize_email")).toBe("defs.sql:1");
      expect(await gotoAt(project, "tsql.sql", tsql, 5, "dbo.inner_proc")).toBe("tsql.sql:1");
    });
  });

  it("does not treat built-ins, same-named columns, strings, comments, or other-language bodies as calls", async () => {
    const schema = ["CREATE FUNCTION normalize_email(e text) RETURNS text AS $$ SELECT lower(e) $$ LANGUAGE sql;"];
    const decoys = [
      "SELECT lower(email), normalize_email FROM users;",
      "SELECT 'normalize_email(email)' AS label FROM users;",
      "SELECT 1; -- normalize_email(email)",
      "SELECT /* normalize_email(email) */ 2;",
      "SELECT $$normalize_email(email)$$;",
      "CREATE TABLE contacts (normalize_email text);",
      "CREATE FUNCTION wrap_python(e text) RETURNS text AS $$ return normalize_email(e) $$ LANGUAGE plpython3u;",
      "SELECT normalize_email(email) FROM users;",
    ];
    await withSqlProject({ "schema.sql": schema, "decoys.sql": decoys }, async (project) => {
      const result = await referencesAt(project, "schema.sql", schema, 1, "normalize_email");

      expect(referenceSites(project.root, result)).toEqual(
        [siteAt("schema.sql", schema, 1, "normalize_email"), siteAt("decoys.sql", decoys, 8, "normalize_email")].sort(),
      );
      expect(await gotoAt(project, "decoys.sql", decoys, 1, "normalize_email")).toBe("not_found");
      expect(await gotoAt(project, "decoys.sql", decoys, 1, "lower")).toBe("not_found");
      expect(await gotoAt(project, "decoys.sql", decoys, 2, "normalize_email")).toBe("not_found");
      expect(await gotoAt(project, "decoys.sql", decoys, 6, "normalize_email")).toBe("not_found");
      expect(await gotoAt(project, "decoys.sql", decoys, 8, "normalize_email")).toBe("schema.sql:1");
    });
  });

  it("keeps a table and a routine with the same name apart", async () => {
    const schema = [
      "CREATE TABLE audit_trail (id integer);",
      "CREATE FUNCTION audit_trail() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;",
    ];
    const use = ["SELECT id FROM audit_trail;", "SELECT audit_trail();", "INSERT INTO audit_trail (id) VALUES (1);"];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      const table = await referencesAt(project, "schema.sql", schema, 1, "audit_trail");
      const routine = await referencesAt(project, "schema.sql", schema, 2, "audit_trail");

      expect(referenceSites(project.root, table)).toEqual(
        [
          siteAt("schema.sql", schema, 1, "audit_trail"),
          siteAt("use.sql", use, 1, "audit_trail"),
          siteAt("use.sql", use, 3, "audit_trail"),
        ].sort(),
      );
      expect(referenceSites(project.root, routine)).toEqual(
        [siteAt("schema.sql", schema, 2, "audit_trail"), siteAt("use.sql", use, 2, "audit_trail")].sort(),
      );
      expect(await gotoAt(project, "use.sql", use, 1, "audit_trail")).toBe("schema.sql:1");
      expect(await gotoAt(project, "use.sql", use, 2, "audit_trail")).toBe("schema.sql:2");
      expect(await gotoAt(project, "use.sql", use, 3, "audit_trail")).toBe("schema.sql:1");
    });
  });

  it("resolves schema-qualified calls and keeps other schemas, quoted names, and cases apart", async () => {
    const schema = [
      "CREATE FUNCTION app.norm(x text) RETURNS text AS $$ SELECT x $$ LANGUAGE sql;",
      "CREATE FUNCTION plain(x text) RETURNS text AS $$ SELECT x $$ LANGUAGE sql;",
    ];
    const use = [
      "SELECT app.norm(a), norm(a), other.norm(a) FROM t;",
      'SELECT public.plain(a), plain(a), "Plain"(a), PLAIN(a) FROM t;',
    ];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      const qualified = await referencesAt(project, "schema.sql", schema, 1, "app.norm");
      const unqualified = await referencesAt(project, "schema.sql", schema, 2, "plain");

      expect(referenceSites(project.root, qualified)).toEqual(
        [
          siteAt("schema.sql", schema, 1, "app.norm"),
          siteAt("use.sql", use, 1, "app.norm"),
          siteAt("use.sql", use, 1, "norm(a)", 1),
        ].sort(),
      );
      expect(referenceSites(project.root, unqualified)).toEqual(
        [
          siteAt("schema.sql", schema, 2, "plain"),
          siteAt("use.sql", use, 2, "public.plain"),
          siteAt("use.sql", use, 2, "plain(a)", 1),
          siteAt("use.sql", use, 2, "PLAIN"),
        ].sort(),
      );
      expect(await gotoAt(project, "use.sql", use, 1, "other.norm")).toBe("not_found");
      expect(await gotoAt(project, "use.sql", use, 2, '"Plain"')).toBe("not_found");
    });
  });

  it("reports partial coverage and no definition for an overloaded routine name", async () => {
    const defs = [
      "CREATE FUNCTION pick(a integer) RETURNS integer AS $$ SELECT a $$ LANGUAGE sql;",
      "CREATE FUNCTION pick(a text) RETURNS text AS $$ SELECT a $$ LANGUAGE sql;",
      "CREATE FUNCTION unique_pick(a integer) RETURNS integer AS $$ SELECT a $$ LANGUAGE sql;",
    ];
    const use = ["SELECT pick(1);", "SELECT unique_pick(2);"];
    await withSqlProject({ "defs.sql": defs, "use.sql": use }, async (project) => {
      const integerOverload = await referencesAt(project, "defs.sql", defs, 1, "pick");
      const textOverload = await referencesAt(project, "defs.sql", defs, 2, "pick");
      const uniqueRoutine = await referencesAt(project, "defs.sql", defs, 3, "unique_pick");

      expect(referenceSites(project.root, integerOverload)).toEqual([siteAt("defs.sql", defs, 1, "pick")]);
      expect(referenceSites(project.root, textOverload)).toEqual([siteAt("defs.sql", defs, 2, "pick")]);
      for (const overload of [integerOverload, textOverload]) {
        expect(okReferences(overload).referenceCoverage).toEqual({
          scope: "indexed_candidates",
          state: "partial",
          reasons: ["strategy_unavailable"],
          affectedFiles: [project.file("use.sql")],
        });
      }
      expect(await gotoAt(project, "use.sql", use, 1, "pick")).toBe("not_found");
      expect(await gotoAt(project, "defs.sql", defs, 1, "pick")).toBe("defs.sql:1");
      expect(await gotoAt(project, "defs.sql", defs, 2, "pick")).toBe("defs.sql:2");
      expect(referenceSites(project.root, uniqueRoutine)).toEqual(
        [siteAt("defs.sql", defs, 3, "unique_pick"), siteAt("use.sql", use, 2, "unique_pick")].sort(),
      );
      expect(okReferences(uniqueRoutine).referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    });
  });

  it("reports partial coverage for a routine that two files define", async () => {
    const first = ["CREATE FUNCTION refresh() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;"];
    const second = ["CREATE OR REPLACE FUNCTION refresh() RETURNS integer AS $$ SELECT 2 $$ LANGUAGE sql;"];
    const use = ["SELECT refresh();"];
    await withSqlProject({ "001_first.sql": first, "002_second.sql": second, "use.sql": use }, async (project) => {
      const result = await referencesAt(project, "001_first.sql", first, 1, "refresh");

      expect(referenceSites(project.root, result)).toEqual([siteAt("001_first.sql", first, 1, "refresh")]);
      expect(okReferences(result).referenceCoverage.state).toBe("partial");
      expect(await gotoAt(project, "use.sql", use, 1, "refresh")).toBe("not_found");
      expect(await gotoAt(project, "002_second.sql", second, 1, "refresh")).toBe("002_second.sql:1");
    });
  });

  it("keeps a trigger and the function it runs apart when they share a name", async () => {
    const schema = [
      "CREATE FUNCTION set_updated_at() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;",
      "CREATE TRIGGER set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();",
      "CREATE TRIGGER set_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();",
      "DROP TRIGGER set_updated_at ON users;",
    ];
    await withSqlProject({ "schema.sql": schema }, async (project) => {
      const routine = await referencesAt(project, "schema.sql", schema, 1, "set_updated_at");
      const trigger = await referencesAt(project, "schema.sql", schema, 2, "set_updated_at");

      expect(referenceSites(project.root, routine)).toEqual(
        [
          siteAt("schema.sql", schema, 1, "set_updated_at"),
          siteAt("schema.sql", schema, 2, "set_updated_at", 1),
          siteAt("schema.sql", schema, 3, "set_updated_at", 1),
        ].sort(),
      );
      expect(okReferences(routine).referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      expect(await gotoAt(project, "schema.sql", schema, 2, "set_updated_at", 1)).toBe("schema.sql:1");
      expect(await gotoAt(project, "schema.sql", schema, 3, "set_updated_at")).toBe("schema.sql:3");
      // Two triggers carry the name, so `DROP TRIGGER set_updated_at` cannot be tied to one of them.
      expect(await gotoAt(project, "schema.sql", schema, 4, "set_updated_at")).toBe("not_found");
      expect(referenceSites(project.root, trigger)).toEqual([siteAt("schema.sql", schema, 2, "set_updated_at")]);
      expect(okReferences(trigger).referenceCoverage.state).toBe("partial");
    });
  });

  it("counts ALTER, COMMENT ON, GRANT, and DROP statements that name a routine as references", async () => {
    const schema = ["CREATE FUNCTION normalize_email(e text) RETURNS text AS $$ SELECT lower(e) $$ LANGUAGE sql;"];
    const admin = [
      "ALTER FUNCTION normalize_email(text) OWNER TO app;",
      "COMMENT ON FUNCTION normalize_email(text) IS 'Lowercases an address.';",
      "GRANT EXECUTE ON FUNCTION normalize_email(text) TO app;",
      "DROP FUNCTION IF EXISTS normalize_email(text);",
      "-- ALTER FUNCTION normalize_email(text) RENAME TO other_name;",
    ];
    await withSqlProject({ "schema.sql": schema, "admin.sql": admin }, async (project) => {
      const result = await referencesAt(project, "schema.sql", schema, 1, "normalize_email");

      expect(referenceSites(project.root, result)).toEqual(
        [
          siteAt("schema.sql", schema, 1, "normalize_email"),
          siteAt("admin.sql", admin, 1, "normalize_email"),
          siteAt("admin.sql", admin, 2, "normalize_email"),
          siteAt("admin.sql", admin, 3, "normalize_email"),
          siteAt("admin.sql", admin, 4, "normalize_email"),
        ].sort(),
      );
      expect(await gotoAt(project, "admin.sql", admin, 3, "normalize_email")).toBe("schema.sql:1");
    });
  });

  it("finds calls when several statements share a line and the file uses CRLF line endings", async () => {
    const schema = ["CREATE FUNCTION fn_one(a integer) RETURNS integer AS $$ SELECT a $$ LANGUAGE sql;"];
    const use = ["SELECT 1; SELECT fn_one(1);", "  SELECT", "    fn_one (2)", "  FROM t;"];
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-routine-crlf-"));
    try {
      await fsp.writeFile(path.join(root, "schema.sql"), `${schema.join("\r\n")}\r\n`, "utf8");
      await fsp.writeFile(path.join(root, "use.sql"), `${use.join("\r\n")}\r\n`, "utf8");
      const index = await buildProjectIndex(root, { cache: "memory" });
      const project: SqlProject = { root, index, file: (name) => path.join(root, name).replace(/\\/g, "/") };

      const result = await referencesAt(project, "schema.sql", schema, 1, "fn_one");

      expect(referenceSites(root, result)).toEqual(
        [
          siteAt("schema.sql", schema, 1, "fn_one"),
          siteAt("use.sql", use, 1, "fn_one"),
          siteAt("use.sql", use, 3, "fn_one"),
        ].sort(),
      );
      expect(await gotoAt(project, "use.sql", use, 1, "fn_one")).toBe("schema.sql:1");
      expect(await gotoAt(project, "use.sql", use, 3, "fn_one")).toBe("schema.sql:1");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reaches a calling file in impact, not a file that only reads the table or mentions the name", async () => {
    const schema = [
      "CREATE TABLE users (id integer, email text);",
      "CREATE FUNCTION normalize_email(e text) RETURNS text AS $$",
      "  SELECT lower(e)",
      "$$ LANGUAGE sql;",
    ];
    const caller = ["SELECT normalize_email('A@B.C');"];
    const reader = ["SELECT id FROM users;", "SELECT lower('x');"];
    const lookalike = [
      "SELECT normalize_email FROM contacts;",
      "-- normalize_email(x)",
      "SELECT 'normalize_email(x)';",
    ];
    const diff = (hunk: readonly string[]): string =>
      ["diff --git a/schema.sql b/schema.sql", "--- a/schema.sql", "+++ b/schema.sql", ...hunk, ""].join("\n");
    const files = { "schema.sql": schema, "caller.sql": caller, "reader.sql": reader, "lookalike.sql": lookalike };
    await withSqlProject(files, async ({ root, index }) => {
      const routineChange = await analyzeImpactFromDiff(root, index, {
        provider: "raw",
        diffText: diff(["@@ -3,1 +3,1 @@", "-  SELECT lower(e)", "+  SELECT lower(trim(e))"]),
        includeTests: true,
      });
      const tableChange = await analyzeImpactFromDiff(root, index, {
        provider: "raw",
        diffText: diff([
          "@@ -1,1 +1,1 @@",
          "-CREATE TABLE users (id integer, email text);",
          "+CREATE TABLE users (id bigint, email text);",
        ]),
        includeTests: true,
      });
      if ("files" in routineChange || "files" in tableChange) throw new Error("Expected full impact reports");

      expect(routineChange.changedSymbols.map((symbol) => symbol.name)).toEqual(["normalize_email"]);
      expect(dependentFiles(routineChange, "schema.sql")).toEqual(["caller.sql"]);
      expect(routineChange.impacted.find((item) => item.file === "caller.sql")).toMatchObject({
        symbols: ["normalize_email"],
        reasons: expect.arrayContaining(["directRef"]),
      });
      expect(tableChange.changedSymbols.map((symbol) => symbol.name)).toEqual(["users"]);
      expect(dependentFiles(tableChange, "schema.sql")).toEqual(["reader.sql"]);
    });
  });

  it("edits routine call sites in a rename preview and leaves same-named lookalikes alone", async () => {
    const schema = ["CREATE FUNCTION normalize_email(e text) RETURNS text AS $$ SELECT lower(e) $$ LANGUAGE sql;"];
    const report = [
      "SELECT normalize_email(email) FROM users;",
      "SELECT normalize_email FROM contacts;",
      "SELECT 'normalize_email(x)';",
    ];
    await withSqlProject({ "schema.sql": schema, "report.sql": report }, async ({ root }) => {
      const session = createAgentSession({ root, freshness: { policy: "check" } });
      try {
        const symbols = await workspaceSymbolsWithSession(session, { root, query: "normalize_email" });
        const target = symbols.symbols.find((symbol) => symbol.name === "normalize_email");
        if (!target) throw new Error("Expected the routine symbol");

        const preview = await previewRenameWithSession(session, {
          root,
          handle: target.handle,
          newName: "normalize_address",
        });

        expect(
          preview.edits.map((edit) => `${edit.file}:${edit.range.start.line}:${edit.range.start.column}`).sort(),
        ).toEqual(
          [
            siteAt("schema.sql", schema, 1, "normalize_email"),
            siteAt("report.sql", report, 1, "normalize_email"),
          ].sort(),
        );
      } finally {
        session.invalidate();
      }
    });
  });

  it("resolves refs at a call inside a trigger or routine body to the callee, not the enclosing definition", async () => {
    const schema = [
      "CREATE FUNCTION normalize_email(e text) RETURNS text AS $$ SELECT lower(e) $$ LANGUAGE sql;",
      "CREATE FUNCTION touch_updated() RETURNS trigger AS $$ BEGIN NEW.e = normalize_email(NEW.e); RETURN NEW; END $$ LANGUAGE plpgsql;",
      "CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated();",
    ];
    await withSqlProject({ "schema.sql": schema }, async (project) => {
      const triggerCallee = await referencesAt(project, "schema.sql", schema, 3, "touch_updated");
      const bodyCallee = await referencesAt(project, "schema.sql", schema, 2, "normalize_email");
      const triggerItself = await referencesAt(project, "schema.sql", schema, 3, "users_touch");

      expect(okReferences(triggerCallee).definition.localName).toBe("touch_updated");
      expect(referenceSites(project.root, triggerCallee)).toEqual(
        [siteAt("schema.sql", schema, 2, "touch_updated"), siteAt("schema.sql", schema, 3, "touch_updated")].sort(),
      );
      expect(okReferences(bodyCallee).definition.localName).toBe("normalize_email");
      expect(referenceSites(project.root, bodyCallee)).toEqual(
        [siteAt("schema.sql", schema, 1, "normalize_email"), siteAt("schema.sql", schema, 2, "normalize_email")].sort(),
      );
      // The trigger's own name still finds the trigger.
      expect(okReferences(triggerItself).definition.localName).toBe("users_touch");
      expect(referenceSites(project.root, triggerItself)).toEqual([siteAt("schema.sql", schema, 3, "users_touch")]);
    });
  });

  it("resolves refs at a table inside a view to the table, and keeps the enclosing definition for other positions", async () => {
    const schema = [
      "CREATE TABLE users (id integer, email text);",
      "CREATE VIEW user_emails AS SELECT id, email FROM users;",
    ];
    const use = ["SELECT id FROM users;"];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      const tableInView = await referencesAt(project, "schema.sql", schema, 2, "users");
      const column = await referencesAt(project, "schema.sql", schema, 1, "email");
      const viewItself = await referencesAt(project, "schema.sql", schema, 2, "user_emails");
      const tableSites = [
        siteAt("schema.sql", schema, 1, "users"),
        siteAt("schema.sql", schema, 2, "users"),
        siteAt("use.sql", use, 1, "users"),
      ].sort();

      expect(okReferences(tableInView).definition.localName).toBe("users");
      expect(referenceSites(project.root, tableInView)).toEqual(tableSites);
      // A column name resolves to no object, so the position keeps the table that holds it.
      expect(okReferences(column).definition.localName).toBe("users");
      expect(referenceSites(project.root, column)).toEqual(tableSites);
      // The view's own name still finds the view, without the table's references.
      expect(okReferences(viewItself).definition.localName).toBe("user_emails");
      expect(referenceSites(project.root, viewItself)).toEqual([siteAt("schema.sql", schema, 2, "user_emails")]);
    });
  });

  it("keeps refs at a column on the enclosing definition when that name is also a table", async () => {
    const schema = [
      "CREATE TABLE users (id integer);",
      "CREATE TABLE orders (users integer);",
      "CREATE VIEW user_dir AS SELECT users FROM users;",
    ];
    await withSqlProject({ "schema.sql": schema }, async (project) => {
      const column = await referencesAt(project, "schema.sql", schema, 2, "users");
      const columnInView = await referencesAt(project, "schema.sql", schema, 3, "users", 0);
      const tableInView = await referencesAt(project, "schema.sql", schema, 3, "users", 1);

      expect(okReferences(column).definition.localName).toBe("orders");
      expect(referenceSites(project.root, column)).toEqual([siteAt("schema.sql", schema, 2, "orders")]);
      expect(okReferences(columnInView).definition.localName).toBe("user_dir");
      expect(okReferences(tableInView).definition.localName).toBe("users");
    });
  });

  it("reaches only callers of the changed name when a table and a routine share it", async () => {
    const schema = [
      "CREATE TABLE audit_trail (id integer);",
      "CREATE FUNCTION audit_trail() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;",
    ];
    const caller = ["SELECT audit_trail();"];
    const reader = ["SELECT id FROM audit_trail;"];
    const diff = (hunk: readonly string[]): string =>
      ["diff --git a/schema.sql b/schema.sql", "--- a/schema.sql", "+++ b/schema.sql", ...hunk, ""].join("\n");
    await withSqlProject(
      { "schema.sql": schema, "caller.sql": caller, "reader.sql": reader },
      async ({ root, index }) => {
        const routineChange = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText: diff([
            "@@ -2,1 +2,1 @@",
            "-CREATE FUNCTION audit_trail() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;",
            "+CREATE FUNCTION audit_trail() RETURNS integer AS $$ SELECT 2 $$ LANGUAGE sql;",
          ]),
          includeTests: true,
        });
        const tableChange = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText: diff([
            "@@ -1,1 +1,1 @@",
            "-CREATE TABLE audit_trail (id integer);",
            "+CREATE TABLE audit_trail (id bigint);",
          ]),
          includeTests: true,
        });
        if ("files" in routineChange || "files" in tableChange) throw new Error("Expected full impact reports");

        expect(routineChange.changedSymbols.map((symbol) => symbol.name)).toEqual(["audit_trail"]);
        expect(dependentFiles(routineChange, "schema.sql")).toEqual(["caller.sql"]);
        expect(tableChange.changedSymbols.map((symbol) => symbol.name)).toEqual(["audit_trail"]);
        expect(dependentFiles(tableChange, "schema.sql")).toEqual(["reader.sql"]);
      },
    );
  });

  it.each<[string, string[]]>([
    ["the project snapshot", []],
    ["per-file cache entries", ["extra.sql"]],
  ])(
    "keeps a trigger apart from a same-named function in impact after a disk-cache reload from %s",
    async (_label, added) => {
      const schema = [
        "CREATE FUNCTION audit() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;",
        "CREATE TRIGGER audit BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION audit();",
      ];
      const files = {
        "schema.sql": schema,
        "caller.sql": ["SELECT audit();"],
        "admin.sql": ["ALTER TABLE users ENABLE TRIGGER audit;"],
      };
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-impact-reload-"));
      const movedRoot = `${root}-moved`;
      try {
        for (const [name, lines] of Object.entries(files)) {
          await fsp.writeFile(path.join(root, name), [...lines, ""].join("\n"), "utf8");
        }
        await buildProjectIndex(root, { cache: "disk", threads: 1 });
        closeDiskCacheDatabase(root, { cache: "disk" });
        // An index restored from the cache never reads these statements again. A copy at a new path
        // reaches that state in this process: no earlier build here indexed the copy's files. An added
        // file invalidates the project snapshot, so the unchanged files come from per-file entries.
        await fsp.cp(root, movedRoot, { recursive: true });
        for (const name of added) await fsp.writeFile(path.join(movedRoot, name), "SELECT 1;\n", "utf8");
        const warm = await buildProjectIndexIncremental(movedRoot, { cache: "disk", threads: 1 });

        const impactedBy = async (hunk: readonly string[]): Promise<string[]> => {
          const diffText = [
            "diff --git a/schema.sql b/schema.sql",
            "--- a/schema.sql",
            "+++ b/schema.sql",
            ...hunk,
            "",
          ];
          const impact = await analyzeImpactFromDiff(movedRoot, warm, {
            provider: "raw",
            diffText: diffText.join("\n"),
            includeTests: true,
          });
          if ("files" in impact) throw new Error("Expected a full impact report");
          return dependentFiles(impact, "schema.sql");
        };

        // `ENABLE TRIGGER audit` names the trigger. `SELECT audit()` names the function.
        expect(
          await impactedBy([
            "@@ -2,1 +2,1 @@",
            `-${schema[1]}`,
            "+CREATE TRIGGER audit BEFORE UPDATE OR INSERT ON users FOR EACH ROW EXECUTE FUNCTION audit();",
          ]),
        ).toEqual(["admin.sql"]);
        expect(
          await impactedBy([
            "@@ -1,1 +1,1 @@",
            `-${schema[0]}`,
            "+CREATE FUNCTION audit() RETURNS trigger AS $$ BEGIN RETURN OLD; END $$ LANGUAGE plpgsql;",
          ]),
        ).toEqual(["caller.sql"]);
      } finally {
        closeDiskCacheDatabase(root, { cache: "disk" });
        closeDiskCacheDatabase(movedRoot, { cache: "disk" });
        await fsp.rm(root, { recursive: true, force: true });
        await fsp.rm(movedRoot, { recursive: true, force: true });
      }
    },
  );

  it("returns not_found for a call or table it cannot resolve, not the references of the definition around it", async () => {
    const schema = [
      "CREATE FUNCTION pick(a integer) RETURNS integer AS $$ SELECT a $$ LANGUAGE sql;",
      "CREATE FUNCTION pick(a text) RETURNS text AS $$ SELECT a $$ LANGUAGE sql;",
      "CREATE FUNCTION wrap(a integer) RETURNS integer AS $$ SELECT pick(a) $$ LANGUAGE sql;",
      "CREATE TRIGGER pick_trg BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION pick();",
      "CREATE VIEW ext_view AS SELECT id, email FROM external_table;",
      "CREATE TABLE users (id integer);",
      "CREATE TABLE users (id integer);",
    ];
    await withSqlProject({ "schema.sql": schema }, async (project) => {
      const overloadedInBody = await referencesAt(project, "schema.sql", schema, 3, "pick(a)");
      const overloadedInTrigger = await referencesAt(project, "schema.sql", schema, 4, "pick()");
      const unknownTable = await referencesAt(project, "schema.sql", schema, 5, "external_table");

      expect(overloadedInBody.status).toBe("not_found");
      expect(overloadedInTrigger.status).toBe("not_found");
      expect(unknownTable.status).toBe("not_found");

      // A column is no object name, so it keeps the view that holds it.
      const column = await referencesAt(project, "schema.sql", schema, 5, "email");
      expect(okReferences(column).definition.localName).toBe("ext_view");
      // A definition's own name finds that definition, even when other definitions share the name.
      const overload = await referencesAt(project, "schema.sql", schema, 2, "pick(a text)");
      const secondUsers = await referencesAt(project, "schema.sql", schema, 7, "users");
      expect(okReferences(overload).definition.range.start.line).toBe(2);
      expect(okReferences(secondUsers).definition.range.start.line).toBe(7);
    });
  });

  it("finds every call when identical statements share one line", async () => {
    const schema = ["CREATE FUNCTION f(a integer) RETURNS integer AS $$ SELECT a $$ LANGUAGE sql;"];
    const use = ["SELECT f(1); SELECT f(1);", "SELECT f(2); SELECT f(2); SELECT f(2);"];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      const result = await referencesAt(project, "schema.sql", schema, 1, "f(a integer)");
      const calls = [
        siteAt("use.sql", use, 1, "f(1)", 0),
        siteAt("use.sql", use, 1, "f(1)", 1),
        siteAt("use.sql", use, 2, "f(2)", 0),
        siteAt("use.sql", use, 2, "f(2)", 1),
        siteAt("use.sql", use, 2, "f(2)", 2),
      ];

      expect(referenceSites(project.root, result)).toEqual(
        [siteAt("schema.sql", schema, 1, "f(a integer)"), ...calls].sort(),
      );
      expect(okReferences(result).referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      expect(await gotoAt(project, "use.sql", use, 1, "f(1)", 0)).toBe("schema.sql:1");
      expect(await gotoAt(project, "use.sql", use, 1, "f(1)", 1)).toBe("schema.sql:1");
      expect(await gotoAt(project, "use.sql", use, 2, "f(2)", 2)).toBe("schema.sql:1");
    });
  });

  it("leaves the declaration out of usage references and keeps it for references and rename", async () => {
    const schema = [
      "CREATE FUNCTION normalize_email(e text) RETURNS text AS $$ SELECT lower(e) $$ LANGUAGE sql;",
      "CREATE TABLE users (id integer, email text);",
    ];
    const use = ["SELECT normalize_email(email) FROM users;"];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      for (const [line, token] of [
        [1, "normalize_email"],
        [2, "users"],
      ] as const) {
        const { definition } = okReferences(await referencesAt(project, "schema.sql", schema, line, token));
        const declaration = siteAt("schema.sql", schema, line, token);
        const usage = siteAt("use.sql", use, 1, token);

        expect(referenceSites(project.root, await findReferences(project.index, { def: definition }))).toEqual(
          [declaration, usage].sort(),
        );
        expect(referenceSites(project.root, await findUsageReferences(project.index, { def: definition }))).toEqual([
          usage,
        ]);
        // A SQL definition spans its whole statement, so rename edits the declaration's name from here.
        expect(referenceSites(project.root, await findRenameReferences(project.index, definition))).toEqual(
          [declaration, usage].sort(),
        );
      }
    });
  });

  it("keeps two overloads that share a line apart", async () => {
    const defs = [
      "CREATE FUNCTION pick(a integer) RETURNS integer AS $$ SELECT a $$ LANGUAGE sql; CREATE FUNCTION pick(a text) RETURNS text AS $$ SELECT a $$ LANGUAGE sql;",
    ];
    const use = ["SELECT pick(1);"];
    await withSqlProject({ "defs.sql": defs, "use.sql": use }, async (project) => {
      const symbols = listSymbols(project.index, { file: project.file("defs.sql") });
      const integerOverload = await referencesAt(project, "defs.sql", defs, 1, "pick(a integer)");
      const textOverload = await referencesAt(project, "defs.sql", defs, 1, "pick(a text)");

      expect(symbols.map((symbol) => symbol.name)).toEqual(["pick", "pick"]);
      // The call fits both, so it resolves to neither.
      expect(await gotoAt(project, "use.sql", use, 1, "pick")).toBe("not_found");
      expect(referenceSites(project.root, integerOverload)).toEqual([siteAt("defs.sql", defs, 1, "pick(a integer)")]);
      expect(referenceSites(project.root, textOverload)).toEqual([siteAt("defs.sql", defs, 1, "pick(a text)")]);
      for (const overload of [integerOverload, textOverload]) {
        expect(okReferences(overload).referenceCoverage).toEqual({
          scope: "indexed_candidates",
          state: "partial",
          reasons: ["strategy_unavailable"],
          affectedFiles: [project.file("use.sql")],
        });
      }
    });
  });

  it("finds the references of a copy of an indexed definition, and none for a definition that is not indexed", async () => {
    const schema = [
      "CREATE FUNCTION normalize_email(e text) RETURNS text AS $$ SELECT lower(e) $$ LANGUAGE sql;",
      "CREATE TABLE users (id integer, email text);",
      "CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION normalize_email();",
    ];
    const use = ["SELECT normalize_email(email) FROM users;"];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      const expected: Array<[number, string, string[]]> = [
        [
          1,
          "normalize_email",
          [
            siteAt("schema.sql", schema, 1, "normalize_email"),
            siteAt("schema.sql", schema, 3, "normalize_email"),
            siteAt("use.sql", use, 1, "normalize_email"),
          ],
        ],
        [2, "users", [siteAt("schema.sql", schema, 2, "users"), siteAt("use.sql", use, 1, "users")]],
        [3, "users_touch", [siteAt("schema.sql", schema, 3, "users_touch")]],
      ];
      for (const [line, token, sites] of expected) {
        const { definition } = okReferences(await referencesAt(project, "schema.sql", schema, line, token));
        // Impact analysis builds the definition it looks up from a changed symbol, so it is no indexed object.
        const copy = {
          ...definition,
          range: { start: { ...definition.range.start }, end: { ...definition.range.end } },
        };
        const result = await findReferences(project.index, { def: copy });

        expect(referenceSites(project.root, result)).toEqual(sites.sort());
        expect(okReferences(result).referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });

        // A definition at a site nothing is declared at cannot be looked up, so it reports no scan at all.
        const elsewhere = { ...copy, range: { start: { line: 99, column: 1 }, end: { line: 99, column: 5 } } };
        expect((await findReferences(project.index, { def: elsewhere })).status).toBe("not_found");
      }
    });
  });

  it("counts a T-SQL table hint as a table reference, not as a call of a routine with the same name", async () => {
    const schema = [
      "CREATE TABLE users (id integer);",
      "CREATE FUNCTION users() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;",
    ];
    const use = ["SELECT * FROM users (NOLOCK);", "SELECT * FROM users();", "SELECT * FROM users WITH (NOLOCK);"];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      const table = await referencesAt(project, "schema.sql", schema, 1, "users");
      const routine = await referencesAt(project, "schema.sql", schema, 2, "users");

      expect(referenceSites(project.root, table)).toEqual(
        [
          siteAt("schema.sql", schema, 1, "users"),
          siteAt("use.sql", use, 1, "users"),
          siteAt("use.sql", use, 3, "users"),
        ].sort(),
      );
      expect(referenceSites(project.root, routine)).toEqual(
        [siteAt("schema.sql", schema, 2, "users"), siteAt("use.sql", use, 2, "users")].sort(),
      );
      expect(await gotoAt(project, "use.sql", use, 1, "users")).toBe("schema.sql:1");
      expect(await gotoAt(project, "use.sql", use, 2, "users")).toBe("schema.sql:2");
    });
  });

  it("renames the name in a schema-qualified reference, keeps the qualifier, and keeps every edit of a file", async () => {
    const schema = [
      "CREATE FUNCTION normalize_email(e text) RETURNS text AS $$ SELECT lower(e) $$ LANGUAGE sql;",
      "CREATE TABLE users (id integer, email text);",
    ];
    const use = [
      "SELECT public.normalize_email(email), normalize_email(email), db.public.normalize_email(email) FROM public.users;",
      "SELECT public . normalize_email(email) FROM users;",
      "ALTER FUNCTION public.normalize_email(text) OWNER TO app;",
    ];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      const routine = await previewRenameOf(project, "normalize_email", "normalize_email_v2");
      const table = await previewRenameOf(project, "users", "users_v2");

      // Each edit replaces the name itself. A qualifier in front of it stays.
      expect(editSites(routine)).toEqual(
        [
          siteAt("schema.sql", schema, 1, "normalize_email"),
          siteAt("use.sql", use, 1, "normalize_email", 0),
          siteAt("use.sql", use, 1, "normalize_email", 1),
          siteAt("use.sql", use, 1, "normalize_email", 2),
          siteAt("use.sql", use, 2, "normalize_email"),
          siteAt("use.sql", use, 3, "normalize_email"),
        ].sort(),
      );
      expect(editSites(table)).toEqual(
        [
          siteAt("schema.sql", schema, 2, "users"),
          siteAt("use.sql", use, 1, "users"),
          siteAt("use.sql", use, 2, "users"),
        ].sort(),
      );
      expect(new Set(routine.edits.map((edit) => edit.oldText))).toEqual(new Set(["normalize_email"]));
      expect(new Set(table.edits.map((edit) => edit.oldText))).toEqual(new Set(["users"]));
      for (const preview of [routine, table]) {
        expect(unsafeRenameSites(preview).filter((site) => site.startsWith("use.sql:"))).toEqual([]);
      }

      // References keep the whole qualified name. Only rename narrows it.
      const references = await referencesAt(project, "schema.sql", schema, 1, "normalize_email");
      expect(referenceSites(project.root, references)).toContain(siteAt("use.sql", use, 1, "public.normalize_email"));
      expect(referenceSites(project.root, references)).not.toContain(siteAt("use.sql", use, 1, "normalize_email", 0));
    });
  });

  it("reports a call without the schema of a schema-qualified definition as an unsafe rename site, not as an edit", async () => {
    const schema = ["CREATE FUNCTION app.normalize_email(e text) RETURNS text AS $$ SELECT lower(e) $$ LANGUAGE sql;"];
    const use = ["SELECT app.normalize_email(email), normalize_email(email);"];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      const preview = await previewRenameOf(project, "app.normalize_email", "app.normalize_address");
      const qualifiedCall = siteAt("use.sql", use, 1, "app.normalize_email");
      const bareCall = siteAt("use.sql", use, 1, "normalize_email", 1);

      // The qualified call is renamed whole, as the definition is. The bare call cannot take a qualified name.
      expect(editSites(preview)).toContain(qualifiedCall);
      expect(editSites(preview)).not.toContain(bareCall);
      expect(unsafeRenameSites(preview)).toContain(bareCall);
    });
  });

  it("does not count the command variable of a PL/pgSQL EXECUTE as a call of a routine with the same name", async () => {
    const schema = ["CREATE FUNCTION norm(x integer) RETURNS integer AS $$ SELECT x $$ LANGUAGE sql;"];
    const use = [
      "CREATE FUNCTION run_it() RETURNS void AS $$ DECLARE norm text := 'SELECT 1'; BEGIN EXECUTE norm; END $$ LANGUAGE plpgsql;",
      "CREATE FUNCTION run_built() RETURNS void AS $$ BEGIN EXECUTE format('SELECT %s', norm(1)); END $$ LANGUAGE plpgsql;",
    ];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      const result = await referencesAt(project, "schema.sql", schema, 1, "norm");

      expect(referenceSites(project.root, result)).toEqual(
        [siteAt("schema.sql", schema, 1, "norm"), siteAt("use.sql", use, 2, "norm(1)")].sort(),
      );
      expect(await gotoAt(project, "use.sql", use, 1, "norm", 1)).toBe("not_found");
      expect(await gotoAt(project, "use.sql", use, 2, "norm(1)")).toBe("schema.sql:1");
    });
  });

  it("does not count the name in a DROP FUNCTION with a comment inside as a reference to a table", async () => {
    const schema = ["CREATE TABLE norm (id integer);"];
    const use = ["DROP /* note */ FUNCTION IF EXISTS norm(integer);", "SELECT id FROM norm;"];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      const table = await referencesAt(project, "schema.sql", schema, 1, "norm");

      expect(referenceSites(project.root, table)).toEqual(
        [siteAt("schema.sql", schema, 1, "norm"), siteAt("use.sql", use, 2, "norm")].sort(),
      );
    });
  });

  it.each<[string, string[]]>([
    ["no routine in the project", []],
    [
      "an unrelated routine in the project",
      ["CREATE FUNCTION other() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;"],
    ],
  ])(
    "does not resolve a routine that DROP, ALTER, CALL, or EXEC names to a table of the same name with %s",
    async (_label, routines) => {
      const schema = ["CREATE TABLE norm (id integer);", ...routines];
      const routineSyntax = [
        "DROP FUNCTION norm(integer);",
        "DROP PROCEDURE IF EXISTS norm(integer);",
        "CALL norm();",
        "ALTER FUNCTION norm(integer) OWNER TO app;",
        "COMMENT ON FUNCTION norm(integer) IS 'x';",
        "GRANT EXECUTE ON FUNCTION norm(text) TO app;",
        "EXEC norm;",
        "DROP TRIGGER norm ON users;",
      ];
      const use = [...routineSyntax, "SELECT * FROM norm;", "INSERT INTO norm (id) VALUES (1);"];
      await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
        for (const [index, statement] of routineSyntax.entries()) {
          expect(await gotoAt(project, "use.sql", use, index + 1, "norm"), statement).toBe("not_found");
          expect((await referencesAt(project, "use.sql", use, index + 1, "norm")).status, statement).toBe("not_found");
        }
        // A plain table read and an INSERT target still resolve to the table.
        expect(await gotoAt(project, "use.sql", use, routineSyntax.length + 1, "norm")).toBe("schema.sql:1");
        expect(await gotoAt(project, "use.sql", use, routineSyntax.length + 2, "norm")).toBe("schema.sql:1");
      });
    },
  );

  it("finds every routine in a DROP or GRANT target list, and goes from each name to its routine", async () => {
    const schema = [
      "CREATE FUNCTION f(a integer) RETURNS integer AS $$ SELECT a $$ LANGUAGE sql;",
      "CREATE FUNCTION g(a text) RETURNS text AS $$ SELECT a $$ LANGUAGE sql;",
      "CREATE TABLE g (id integer);",
    ];
    const admin = [
      "DROP FUNCTION f, g;",
      "DROP FUNCTION IF EXISTS f(integer), g(text);",
      "GRANT EXECUTE ON FUNCTION f(integer), g(text) TO app;",
    ];
    await withSqlProject({ "schema.sql": schema, "admin.sql": admin }, async (project) => {
      const routine = await referencesAt(project, "schema.sql", schema, 2, "g(a text)");
      const table = await referencesAt(project, "schema.sql", schema, 3, "g (id");

      expect(referenceSites(project.root, routine)).toEqual(
        [
          siteAt("schema.sql", schema, 2, "g(a text)"),
          siteAt("admin.sql", admin, 1, "g;"),
          siteAt("admin.sql", admin, 2, "g(text)"),
          siteAt("admin.sql", admin, 3, "g(text)"),
        ].sort(),
      );
      // The table that shares the name is neither dropped nor granted on.
      expect(referenceSites(project.root, table)).toEqual([siteAt("schema.sql", schema, 3, "g (id")]);
      expect(await gotoAt(project, "admin.sql", admin, 1, "g;")).toBe("schema.sql:2");
      expect(await gotoAt(project, "admin.sql", admin, 2, "g(text)")).toBe("schema.sql:2");
      expect(await gotoAt(project, "admin.sql", admin, 3, "g(text)")).toBe("schema.sql:2");
    });
  });

  it("does not count the table of an INSERT after a modifier or a column aliased like a CALL as calls", async () => {
    const schema = [
      "CREATE FUNCTION norm(x integer) RETURNS integer AS $$ SELECT x $$ LANGUAGE sql;",
      "CREATE FUNCTION audit_user() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;",
    ];
    const use = [
      "INSERT IGNORE norm (id) VALUES (1);",
      "INSERT TOP (1) dbo.norm (id) VALUES (norm(2));",
      "SELECT call audit_user FROM contacts;",
      "SELECT audit_user();",
    ];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      const norm = await referencesAt(project, "schema.sql", schema, 1, "norm(x integer)");
      const audit = await referencesAt(project, "schema.sql", schema, 2, "audit_user()");

      // Only the call in the VALUES list is a call of `norm`.
      expect(referenceSites(project.root, norm)).toEqual(
        [siteAt("schema.sql", schema, 1, "norm(x integer)"), siteAt("use.sql", use, 2, "norm(2)")].sort(),
      );
      expect(referenceSites(project.root, audit)).toEqual(
        [siteAt("schema.sql", schema, 2, "audit_user()"), siteAt("use.sql", use, 4, "audit_user()")].sort(),
      );
      // `audit_user` there is a column alias. It names no routine, so goto has nothing to resolve.
      expect(await gotoAt(project, "use.sql", use, 3, "audit_user")).toBe("not_found");
    });
  });

  it("does not resolve a qualifier that names a routine in a FROM list to a table of the same name", async () => {
    const schema = [
      "CREATE TABLE get_users (id integer);",
      "CREATE FUNCTION get_users() RETURNS TABLE (id integer) AS $$ SELECT 1 $$ LANGUAGE sql;",
      "CREATE TABLE u (id integer);",
    ];
    const use = [
      "SELECT get_users.id FROM get_users();",
      "SELECT get_users.id FROM get_users;",
      "SELECT get_users.id FROM get_users, get_users() g;",
      "SELECT get_users.id FROM get_users() , get_users g2;",
      "SELECT u.id FROM get_users() u;",
      "SELECT u.id FROM u;",
    ];
    await withSqlProject({ "schema.sql": schema, "use.sql": use }, async (project) => {
      const table = await referencesAt(project, "schema.sql", schema, 1, "get_users");
      const routine = await referencesAt(project, "schema.sql", schema, 2, "get_users");
      const tableNamedLikeAnAlias = await referencesAt(project, "schema.sql", schema, 3, "u");

      // The qualifier names the routine's result on lines 1 and 4, and the table on lines 2 and 3.
      expect(referenceSites(project.root, table)).toEqual(
        [
          siteAt("schema.sql", schema, 1, "get_users"),
          siteAt("use.sql", use, 2, "get_users", 0),
          siteAt("use.sql", use, 2, "get_users", 1),
          siteAt("use.sql", use, 3, "get_users", 0),
          siteAt("use.sql", use, 3, "get_users", 1),
          siteAt("use.sql", use, 4, "get_users", 2),
        ].sort(),
      );
      expect(referenceSites(project.root, routine)).toEqual(
        [
          siteAt("schema.sql", schema, 2, "get_users"),
          siteAt("use.sql", use, 1, "get_users", 1),
          siteAt("use.sql", use, 3, "get_users", 2),
          siteAt("use.sql", use, 4, "get_users", 1),
          siteAt("use.sql", use, 5, "get_users"),
        ].sort(),
      );
      // `u` is the alias of a routine on line 5 and the table itself on line 6.
      expect(referenceSites(project.root, tableNamedLikeAnAlias)).toEqual(
        [
          siteAt("schema.sql", schema, 3, "u"),
          siteAt("use.sql", use, 6, "u.id"),
          siteAt("use.sql", use, 6, "u;"),
        ].sort(),
      );
      expect(await gotoAt(project, "use.sql", use, 1, "get_users.id")).toBe("not_found");
      expect(await gotoAt(project, "use.sql", use, 2, "get_users.id")).toBe("schema.sql:1");
      expect(await gotoAt(project, "use.sql", use, 3, "get_users.id")).toBe("schema.sql:1");
      expect(await gotoAt(project, "use.sql", use, 4, "get_users.id")).toBe("not_found");
      expect(await gotoAt(project, "use.sql", use, 5, "u.id")).toBe("not_found");
      expect(await gotoAt(project, "use.sql", use, 6, "u.id")).toBe("schema.sql:3");
    });
  });

  it("reads a nested block comment as one comment, so a call inside it is no call", async () => {
    const schema = ["CREATE FUNCTION norm(x integer) RETURNS integer AS $$ SELECT x $$ LANGUAGE sql;"];
    const use = [
      "/* outer /* inner */ SELECT norm(1); */",
      "SELECT norm(2);",
      "/* files: src/**/*.sql */",
      "SELECT norm(3);",
      "/* outer /* inner */ it's SELECT norm(4); */",
      "SELECT norm(5);",
    ];
    // Nesting would leave this comment open, so it is a MySQL or SQLite comment that ends at its first closing delimiter.
    const mysql = ["/* see /* below */ SELECT norm(6);", "SELECT norm(7);"];
    await withSqlProject({ "schema.sql": schema, "use.sql": use, "mysql.sql": mysql }, async (project) => {
      const result = await referencesAt(project, "schema.sql", schema, 1, "norm");

      expect(referenceSites(project.root, result)).toEqual(
        [
          siteAt("schema.sql", schema, 1, "norm"),
          siteAt("use.sql", use, 2, "norm"),
          siteAt("use.sql", use, 4, "norm"),
          siteAt("use.sql", use, 6, "norm"),
          siteAt("mysql.sql", mysql, 1, "norm"),
          siteAt("mysql.sql", mysql, 2, "norm"),
        ].sort(),
      );
      expect(okReferences(result).referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      expect(await gotoAt(project, "use.sql", use, 6, "norm")).toBe("schema.sql:1");
    });
  });
});
