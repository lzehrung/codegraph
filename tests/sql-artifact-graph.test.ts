import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { collectGraph } from "../src/index.js";
import { buildSqlArtifactGraphFromFiles } from "../src/sql/index.js";
import { buildSqlFactCache, buildSqlModuleIndex, collectSqlEdgesForFile } from "../src/sql/sourceGraph.js";
import { SymbolKind } from "../src/indexer/types.js";
import { computeFileSymbolHashes } from "../src/util/symbolHash.js";

const fixtureRoot = path.resolve(process.cwd(), "tests", "samples", "sql", "graph");
const sqlFiles = ["001_create_users.sql", "002_alter_users.sql", "report.sql"].map((file) =>
  path.join(fixtureRoot, file),
);

describe("SQL artifact graph", () => {
  it("groups repeated object mentions into SQL candidates without current schema nodes", async () => {
    const graph = await buildSqlArtifactGraphFromFiles(sqlFiles);
    const usersCandidates = graph.nodes.filter((node) => node.kind === "sql_table_candidate" && node.name === "users");

    expect(usersCandidates).toHaveLength(1);
    expect(usersCandidates[0]).toMatchObject({
      namespace: "sql",
      truthTier: "sql_schema_candidate",
    });
    expect(graph.nodes.some((node) => node.kind === "sql_current_schema")).toBe(false);
    expect(graph.edges.some((edge) => edge.kind === "sql_statement_defines")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "sql_statement_alters")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "sql_statement_reads")).toBe(true);
  });

  it("adds SQL-to-SQL object edges to the source dependency graph without linking app code", async () => {
    const sourceGraph = await collectGraph(fixtureRoot, [...sqlFiles, path.join(fixtureRoot, "app.ts")]);
    const createUsers = path.join(fixtureRoot, "001_create_users.sql").replace(/\\/g, "/");
    const report = path.join(fixtureRoot, "report.sql").replace(/\\/g, "/");
    const app = path.join(fixtureRoot, "app.ts").replace(/\\/g, "/");

    expect(sourceGraph.edges).toContainEqual(
      expect.objectContaining({
        from: report,
        raw: "sql:reads_from:users",
        to: { type: "file", path: createUsers },
      }),
    );
    expect(sourceGraph.edges.some((edge) => edge.from === app || (edge.to.type === "file" && edge.to.path === app))).toBe(
      false,
    );
  });

  it("adds SQL-to-SQL edges for read dependencies inside write statements", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-dml-graph-"));
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      const pipelineFile = path.join(root, "pipeline.sql").replace(/\\/g, "/");
      await fsp.writeFile(
        schemaFile,
        [
          "CREATE TABLE public.users (id integer, organization_id integer);",
          "CREATE TABLE public.organizations (id integer, name text);",
          "CREATE TABLE public.audit_users (id integer);",
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(
        pipelineFile,
        [
          "INSERT INTO public.audit_users SELECT id FROM public.users;",
          "UPDATE public.users SET organization_name = o.name FROM public.organizations o WHERE o.id = organization_id;",
          "DELETE FROM public.audit_users USING public.users WHERE audit_users.id = users.id;",
        ].join("\n"),
        "utf8",
      );

      const sourceGraph = await collectGraph(root, [schemaFile, pipelineFile]);

      expect(sourceGraph.edges).toContainEqual(
        expect.objectContaining({
          from: pipelineFile,
          raw: "sql:reads_from:public.users",
          to: { type: "file", path: schemaFile },
        }),
      );
      expect(sourceGraph.edges).toContainEqual(
        expect.objectContaining({
          from: pipelineFile,
          raw: "sql:reads_from:public.organizations",
          to: { type: "file", path: schemaFile },
        }),
      );
      expect(sourceGraph.edges).toContainEqual(
        expect.objectContaining({
          from: pipelineFile,
          raw: "sql:writes_to:public.audit_users",
          to: { type: "file", path: schemaFile },
        }),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("links schema-qualified SQL references to unqualified object definitions", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-qualified-edge-"));
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      const publicSchemaFile = path.join(root, "public_schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
      await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\nCREATE TABLE accounts (id integer);\n", "utf8");
      await fsp.writeFile(publicSchemaFile, "CREATE TABLE public.accounts (id integer);\n", "utf8");
      await fsp.writeFile(reportFile, "SELECT id FROM public.users;\nSELECT id FROM public.accounts;\n", "utf8");

      const sourceGraph = await collectGraph(root, [schemaFile, publicSchemaFile, reportFile]);

      expect(sourceGraph.edges).toContainEqual(
        expect.objectContaining({
          from: reportFile,
          raw: "sql:reads_from:public.users",
          to: { type: "file", path: schemaFile },
        }),
      );
      expect(sourceGraph.edges).toContainEqual(
        expect.objectContaining({
          from: reportFile,
          raw: "sql:reads_from:public.accounts",
          to: { type: "file", path: publicSchemaFile },
        }),
      );
      expect(
        sourceGraph.edges.some(
          (edge) =>
            edge.from === reportFile &&
            edge.raw === "sql:reads_from:public.accounts" &&
            edge.to.type === "file" &&
            edge.to.path === schemaFile,
        ),
      ).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not emit SQL dependency self-edges inside a single SQL file", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-self-edge-"));
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\nSELECT id FROM users;\n", "utf8");

      const sourceGraph = await collectGraph(root, [schemaFile]);

      expect(
        sourceGraph.edges.some(
          (edge) => edge.from === schemaFile && edge.to.type === "file" && edge.to.path === schemaFile,
        ),
      ).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not index foreign-key constraint facts as duplicate table-named SQL definitions", () => {
    const moduleIndex = buildSqlModuleIndex(
      "schema.sql",
      "CREATE TABLE users (id integer, organization_id integer REFERENCES organizations(id));\n",
    );

    expect(moduleIndex.locals.filter((local) => local.localName === "users")).toEqual([
      expect.objectContaining({ kind: SymbolKind.Table }),
    ]);
    expect(moduleIndex.locals.some((local) => local.kind === SymbolKind.Constraint)).toBe(false);
  });

  it("hashes SQL symbols from statement ranges instead of whole files", () => {
    const beforeSource = "CREATE TABLE users (id integer);\nCREATE TABLE accounts (id integer);\n";
    const afterSource = "CREATE TABLE users (id integer);\nCREATE TABLE accounts (id integer, active boolean);\n";
    const beforeIndex = buildSqlModuleIndex("schema.sql", beforeSource);
    const afterIndex = buildSqlModuleIndex("schema.sql", afterSource);

    const firstStatementEnd = beforeSource.indexOf(";");
    const usersSymbol = beforeIndex.locals.find((local) => local.localName === "users");
    expect(usersSymbol?.range).toMatchObject({
      start: { line: 1, column: 1, index: 0 },
      end: { line: 1, column: firstStatementEnd + 1, index: firstStatementEnd },
    });

    const beforeHashes = computeFileSymbolHashes(beforeIndex.locals, beforeIndex.exports, beforeSource);
    const afterHashes = computeFileSymbolHashes(afterIndex.locals, afterIndex.exports, afterSource);
    const hashById = new Map(beforeHashes.map((hash) => [hash.id, hash.hash]));

    expect(afterHashes.find((hash) => hash.id.startsWith("users::table::"))?.hash).toBe(
      hashById.get("users::table::0"),
    );
    expect(afterHashes.find((hash) => hash.id.startsWith("accounts::table::"))?.hash).not.toBe(
      hashById.get("accounts::table::33"),
    );
  });

  it("includes related SQL objects in artifact graph candidate mentions", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-related-artifacts-"));
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      await fsp.writeFile(
        schemaFile,
        [
          "CREATE TABLE organizations (id integer primary key);",
          "CREATE TABLE users (id integer, organization_id integer REFERENCES organizations(id));",
          "CREATE INDEX idx_users_org ON users (organization_id);",
        ].join("\n"),
        "utf8",
      );

      const graph = await buildSqlArtifactGraphFromFiles([schemaFile]);

      expect(graph.nodes).toContainEqual(
        expect.objectContaining({
          kind: "sql_table_candidate",
          name: "organizations",
        }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          kind: "sql_statement_references",
          to: "sql:candidate:sql_table_candidate:organizations",
        }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          kind: "sql_statement_references",
          to: "sql:candidate:sql_table_candidate:users",
        }),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reuses SQL facts across per-file edge collection", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-cache-"));
    const files: string[] = [];
    try {
      for (let index = 0; index < 12; index += 1) {
        const file = path.join(root, `migration_${index}.sql`).replace(/\\/g, "/");
        const source =
          index === 0
            ? "CREATE TABLE users (id integer);\n"
            : `SELECT id FROM users WHERE id = ${index};\n`;
        await fsp.writeFile(file, source, "utf8");
        files.push(file);
      }

      const originalReadFile = fsp.readFile.bind(fsp);
      const readSpy = vi.spyOn(fsp, "readFile").mockImplementation(originalReadFile);
      const cache = await buildSqlFactCache(files);
      await Promise.all(files.map(async (file) => collectSqlEdgesForFile(file, files, cache)));

      const sqlReads = readSpy.mock.calls.filter((call) => String(call[0]).endsWith(".sql"));
      expect(sqlReads).toHaveLength(files.length);
    } finally {
      vi.restoreAllMocks();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("recomputes unchanged SQL query edges when changed SQL definitions add targets", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-incremental-add-"));
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
      const files = [schemaFile, reportFile];
      await fsp.writeFile(schemaFile, "CREATE TABLE accounts (id integer);\n", "utf8");
      await fsp.writeFile(reportFile, "SELECT id FROM users;\n", "utf8");

      const initialGraph = await collectGraph(root, files, { allFiles: files });
      expect(
        initialGraph.edges.some(
          (edge) => edge.from === reportFile && edge.raw === "sql:reads_from:users" && edge.to.type === "file",
        ),
      ).toBe(false);

      await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\n", "utf8");
      const incrementalGraph = await collectGraph(root, [schemaFile], {
        allFiles: files,
        baseGraph: initialGraph,
        replaceFiles: new Set([schemaFile]),
      });

      expect(incrementalGraph.edges).toContainEqual(
        expect.objectContaining({
          from: reportFile,
          raw: "sql:reads_from:users",
          to: { type: "file", path: schemaFile },
        }),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("removes unchanged SQL query edges when changed SQL definitions drop targets", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-incremental-remove-"));
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
      const files = [schemaFile, reportFile];
      await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\n", "utf8");
      await fsp.writeFile(reportFile, "SELECT id FROM users;\n", "utf8");

      const initialGraph = await collectGraph(root, files, { allFiles: files });
      expect(initialGraph.edges).toContainEqual(
        expect.objectContaining({
          from: reportFile,
          raw: "sql:reads_from:users",
          to: { type: "file", path: schemaFile },
        }),
      );

      await fsp.writeFile(schemaFile, "CREATE TABLE accounts (id integer);\n", "utf8");
      const incrementalGraph = await collectGraph(root, [schemaFile], {
        allFiles: files,
        baseGraph: initialGraph,
        replaceFiles: new Set([schemaFile]),
      });

      expect(
        incrementalGraph.edges.some(
          (edge) =>
            edge.from === reportFile &&
            edge.raw === "sql:reads_from:users" &&
            edge.to.type === "file" &&
            edge.to.path === schemaFile,
        ),
      ).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
