import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { collectGraph } from "../src/index.js";
import { buildSqlArtifactGraphFromFiles } from "../src/sql/index.js";
import { buildSqlFactCache, buildSqlModuleIndex, collectSqlEdgesForFile } from "../src/sql/source-graph.js";
import { SymbolKind } from "../src/indexer/types.js";
import { computeFileSymbolHashes } from "../src/util/symbol-hash.js";
import type { GraphCacheEntry } from "../src/graphs/types.js";
import type { Graph } from "../src/types.js";
import { mkTmpDir } from "./helpers/filesystem.js";

const fixtureRoot = path.resolve(process.cwd(), "tests", "samples", "sql", "graph");
const sqlFiles = ["001_create_users.sql", "002_alter_users.sql", "report.sql"].map((file) =>
  path.join(fixtureRoot, file),
);

describe("SQL artifact graph", () => {
  it("groups repeated object mentions into SQL candidates with defines, alters, and reads edges", async () => {
    const graph = await buildSqlArtifactGraphFromFiles(sqlFiles);
    const usersCandidates = graph.nodes.filter((node) => node.kind === "sql_table_candidate" && node.name === "users");

    expect(usersCandidates).toHaveLength(1);
    expect(usersCandidates[0]).toMatchObject({
      namespace: "sql",
      truthTier: "sql_schema_candidate",
    });
    expect([...new Set(graph.nodes.map((node) => node.kind))].sort()).toEqual([
      "sql_file",
      "sql_object_candidate",
      "sql_statement",
      "sql_table_candidate",
    ]);
    expect([...new Set(graph.edges.map((edge) => edge.kind))].sort()).toEqual([
      "sql_candidate_mentions",
      "sql_contains_statement",
      "sql_statement_alters",
      "sql_statement_defines",
      "sql_statement_reads",
    ]);
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
    expect(
      sourceGraph.edges.some((edge) => edge.from === app || (edge.to.type === "file" && edge.to.path === app)),
    ).toBe(false);
  });

  it("adds SQL-to-SQL edges for read dependencies inside write statements", async () => {
    const root = await mkTmpDir("cg-sql-dml-graph-");
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
    const root = await mkTmpDir("cg-sql-qualified-edge-");
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      const publicSchemaFile = path.join(root, "public_schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
      await fsp.writeFile(
        schemaFile,
        "CREATE TABLE users (id integer);\nCREATE TABLE accounts (id integer);\n",
        "utf8",
      );
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

  it("emits heuristic SQL edges for basename fallback matches", async () => {
    const root = await mkTmpDir("cg-sql-fallback-edge-");
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
      await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\n", "utf8");
      await fsp.writeFile(reportFile, "SELECT id FROM public.users;\n", "utf8");

      const sourceGraph = await collectGraph(root, [schemaFile, reportFile]);

      expect(sourceGraph.edges).toContainEqual(
        expect.objectContaining({
          from: reportFile,
          raw: "sql:reads_from:public.users",
          to: { type: "file", path: schemaFile },
          resolved: "heuristic",
          confidence: 0.7,
        }),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("links unqualified SQL references to a single schema-qualified object definition", async () => {
    const root = await mkTmpDir("cg-sql-unqualified-qualified-edge-");
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
      await fsp.writeFile(schemaFile, "CREATE TABLE public.users (id integer);\n", "utf8");
      await fsp.writeFile(reportFile, "SELECT id FROM users;\n", "utf8");

      const sourceGraph = await collectGraph(root, [schemaFile, reportFile]);

      expect(sourceGraph.edges).toContainEqual(
        expect.objectContaining({
          from: reportFile,
          raw: "sql:reads_from:users",
          to: { type: "file", path: schemaFile },
          resolved: "heuristic",
          confidence: 0.7,
        }),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not guess ambiguous SQL edges from unqualified references to schema-qualified definitions", async () => {
    const root = await mkTmpDir("cg-sql-ambiguous-unqualified-edge-");
    try {
      const publicSchemaFile = path.join(root, "public_schema.sql").replace(/\\/g, "/");
      const archiveSchemaFile = path.join(root, "archive_schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
      await fsp.writeFile(publicSchemaFile, "CREATE TABLE public.users (id integer);\n", "utf8");
      await fsp.writeFile(archiveSchemaFile, "CREATE TABLE archive.users (id integer);\n", "utf8");
      await fsp.writeFile(reportFile, "SELECT id FROM users;\n", "utf8");

      const sourceGraph = await collectGraph(root, [publicSchemaFile, archiveSchemaFile, reportFile]);

      expect(
        sourceGraph.edges.some(
          (edge) => edge.from === reportFile && edge.raw === "sql:reads_from:users" && edge.to.type === "file",
        ),
      ).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not emit duplicate join edges for the primary FROM object", async () => {
    const root = await mkTmpDir("cg-sql-join-primary-edge-");
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
      await fsp.writeFile(
        schemaFile,
        ["CREATE TABLE users (id integer);", "CREATE TABLE organizations (id integer);"].join("\n"),
        "utf8",
      );
      await fsp.writeFile(
        reportFile,
        "SELECT * FROM users JOIN organizations ON organizations.id = users.id;\n",
        "utf8",
      );

      const sourceGraph = await collectGraph(root, [schemaFile, reportFile]);

      expect(sourceGraph.edges).toContainEqual(
        expect.objectContaining({
          from: reportFile,
          raw: "sql:reads_from:users",
          to: { type: "file", path: schemaFile },
        }),
      );
      expect(sourceGraph.edges).toContainEqual(
        expect.objectContaining({
          from: reportFile,
          raw: "sql:joins:organizations",
          to: { type: "file", path: schemaFile },
        }),
      );
      expect(
        sourceGraph.edges.some(
          (edge) => edge.from === reportFile && edge.raw === "sql:joins:users" && edge.to.type === "file",
        ),
      ).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not emit SQL dependency self-edges inside a single SQL file", async () => {
    const root = await mkTmpDir("cg-sql-self-edge-");
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

  it("links SQL rename statements to the source definition without targeting the new name", async () => {
    const root = await mkTmpDir("cg-sql-rename-edge-");
    try {
      const oldSchemaFile = path.join(root, "old_schema.sql").replace(/\\/g, "/");
      const unrelatedNewSchemaFile = path.join(root, "unrelated_new_schema.sql").replace(/\\/g, "/");
      const migrationFile = path.join(root, "migration.sql").replace(/\\/g, "/");
      await fsp.writeFile(oldSchemaFile, "CREATE TABLE old_users (id integer);\n", "utf8");
      await fsp.writeFile(unrelatedNewSchemaFile, "CREATE TABLE users (id integer);\n", "utf8");
      await fsp.writeFile(migrationFile, "ALTER TABLE old_users RENAME TO users;\n", "utf8");

      const sourceGraph = await collectGraph(root, [oldSchemaFile, unrelatedNewSchemaFile, migrationFile]);

      expect(sourceGraph.edges).toContainEqual(
        expect.objectContaining({
          from: migrationFile,
          raw: "sql:renames_object:old_users",
          to: { type: "file", path: oldSchemaFile },
        }),
      );
      expect(
        sourceGraph.edges.some(
          (edge) =>
            edge.from === migrationFile &&
            edge.raw === "sql:renames_object:users" &&
            edge.to.type === "file" &&
            edge.to.path === unrelatedNewSchemaFile,
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
    const root = await mkTmpDir("cg-sql-related-artifacts-");
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

  it("preserves identifier case when building candidate node ids", async () => {
    const root = await mkTmpDir("cg-sql-case-artifacts-");
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      await fsp.writeFile(
        schemaFile,
        ["CREATE TABLE `MyTable` (id integer primary key);", "CREATE TABLE mytable (id integer primary key);"].join(
          "\n",
        ),
        "utf8",
      );

      const graph = await buildSqlArtifactGraphFromFiles([schemaFile]);
      const tableCandidateIds = graph.nodes
        .filter((node) => node.kind === "sql_table_candidate")
        .map((node) => node.id);

      expect(tableCandidateIds).toContain("sql:candidate:sql_table_candidate:MyTable");
      expect(tableCandidateIds).toContain("sql:candidate:sql_table_candidate:mytable");
      expect(new Set(tableCandidateIds).size).toBe(tableCandidateIds.length);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reuses SQL facts across per-file edge collection", async () => {
    const root = await mkTmpDir("cg-sql-cache-");
    const files: string[] = [];
    try {
      for (let index = 0; index < 12; index += 1) {
        const file = path.join(root, `migration_${index}.sql`).replace(/\\/g, "/");
        const source =
          index === 0 ? "CREATE TABLE users (id integer);\n" : `SELECT id FROM users WHERE id = ${index};\n`;
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

  it("bounds concurrent SQL fact reads when building the corpus cache", async () => {
    const root = await mkTmpDir("cg-sql-cache-concurrency-");
    const files: string[] = [];
    try {
      for (let index = 0; index < 40; index += 1) {
        const file = path.join(root, `schema_${index}.sql`).replace(/\\/g, "/");
        await fsp.writeFile(file, `CREATE TABLE table_${index} (id integer);\n`, "utf8");
        files.push(file);
      }

      const originalReadFile = fsp.readFile.bind(fsp);
      let activeSqlReads = 0;
      let maxActiveSqlReads = 0;
      const readSpy = vi.spyOn(fsp, "readFile").mockImplementation(async (filePath, options) => {
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

      await buildSqlFactCache(files);

      expect(readSpy).toHaveBeenCalled();
      expect(maxActiveSqlReads).toBeLessThanOrEqual(32);
    } finally {
      vi.restoreAllMocks();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reuses SQL edge cache entries when the SQL corpus signature is unchanged", async () => {
    const root = await mkTmpDir("cg-sql-edge-cache-reuse-");
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
      const files = [schemaFile, reportFile];
      await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\n", "utf8");
      await fsp.writeFile(reportFile, "SELECT id FROM users;\n", "utf8");
      const fileSignatures = new Map([
        [schemaFile, { sig: "schema-v1", cacheSig: "schema-v1" }],
        [reportFile, { sig: "report-v1", cacheSig: "report-v1" }],
      ]);
      const cachedEntries = new Map<string, GraphCacheEntry>();
      await collectGraph(root, files, {
        allFiles: files,
        fileSignatures,
        onFileEdges: (file, entry) => cachedEntries.set(file, entry),
      });
      const reportEntry = cachedEntries.get(reportFile);
      expect(reportEntry?.sqlCorpusSig).toEqual(expect.any(String));
      expect(reportEntry?.edges).toContainEqual(
        expect.objectContaining({
          from: reportFile,
          raw: "sql:reads_from:users",
          to: { type: "file", path: schemaFile },
        }),
      );
      const cachedReportEntry = reportEntry
        ? {
            ...reportEntry,
            edges: reportEntry.edges.map((edge) =>
              edge.raw === "sql:reads_from:users" ? { ...edge, raw: "sql:cached:reads_from:users" } : edge,
            ),
          }
        : undefined;
      const cachedFileEdges =
        cachedReportEntry === undefined ? cachedEntries : new Map([...cachedEntries, [reportFile, cachedReportEntry]]);
      const originalReadFile = fsp.readFile.bind(fsp);
      const readSpy = vi.spyOn(fsp, "readFile").mockImplementation(originalReadFile);

      const cachedGraph = await collectGraph(root, files, {
        allFiles: files,
        fileSignatures,
        cachedFileEdges,
      });

      expect(cachedGraph.edges).toContainEqual(
        expect.objectContaining({
          from: reportFile,
          raw: "sql:cached:reads_from:users",
          to: { type: "file", path: schemaFile },
        }),
      );
      expect(readSpy.mock.calls.filter((call) => String(call[0]).endsWith(".sql"))).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects stale SQL edge cache entries when another SQL file changes", async () => {
    const root = await mkTmpDir("cg-sql-edge-cache-invalidate-");
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
      const files = [schemaFile, reportFile];
      await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\n", "utf8");
      await fsp.writeFile(reportFile, "SELECT id FROM users;\n", "utf8");
      const initialSignatures = new Map([
        [schemaFile, { sig: "schema-v1", cacheSig: "schema-v1" }],
        [reportFile, { sig: "report-v1", cacheSig: "report-v1" }],
      ]);
      const cachedEntries = new Map<string, GraphCacheEntry>();
      await collectGraph(root, files, {
        allFiles: files,
        fileSignatures: initialSignatures,
        onFileEdges: (file, entry) => cachedEntries.set(file, entry),
      });

      await fsp.writeFile(schemaFile, "CREATE TABLE accounts (id integer);\n", "utf8");
      const changedSignatures = new Map([
        [schemaFile, { sig: "schema-v2", cacheSig: "schema-v2" }],
        [reportFile, { sig: "report-v1", cacheSig: "report-v1" }],
      ]);
      const graph = await collectGraph(root, files, {
        allFiles: files,
        fileSignatures: changedSignatures,
        cachedFileEdges: cachedEntries,
      });

      expect(
        graph.edges.some(
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

  it("recomputes unchanged SQL query edges when changed SQL definitions add targets", async () => {
    const root = await mkTmpDir("cg-sql-incremental-add-");
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
    const root = await mkTmpDir("cg-sql-incremental-remove-");
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

  it("links routine calls to routine definitions only and skips ambiguous names", async () => {
    const root = await mkTmpDir("cg-sql-routine-edge-");
    try {
      const sqlFile = (name: string): string => path.join(root, name).replace(/\\/g, "/");
      const routinesFile = sqlFile("routines.sql");
      const tablesFile = sqlFile("tables.sql");
      const archiveFile = sqlFile("archive.sql");
      const callerFile = sqlFile("caller.sql");
      const readerFile = sqlFile("reader.sql");
      const adminFile = sqlFile("admin.sql");
      const files = [routinesFile, tablesFile, archiveFile, callerFile, readerFile, adminFile];
      await fsp.writeFile(
        routinesFile,
        [
          "CREATE FUNCTION normalize_email(e text) RETURNS text AS $$ SELECT lower(e) $$ LANGUAGE sql;",
          "CREATE FUNCTION app.shared_name() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;",
          "",
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(tablesFile, "CREATE TABLE normalize_email (id integer);\n", "utf8");
      await fsp.writeFile(
        archiveFile,
        "CREATE FUNCTION archive.shared_name() RETURNS integer AS $$ SELECT 2 $$ LANGUAGE sql;\n",
        "utf8",
      );
      await fsp.writeFile(
        callerFile,
        "SELECT normalize_email(a), public.normalize_email(a), lower(a), shared_name(), app.shared_name() FROM t;\n",
        "utf8",
      );
      await fsp.writeFile(readerFile, "SELECT id FROM normalize_email;\n", "utf8");
      await fsp.writeFile(
        adminFile,
        "ALTER FUNCTION normalize_email(text) OWNER TO app;\nDROP FUNCTION normalize_email(text);\n",
        "utf8",
      );

      const sourceGraph = await collectGraph(root, files);
      const edgesBetween = (from: string, to: string) =>
        sourceGraph.edges.filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === to);
      const rawBetween = (from: string, to: string): string[] =>
        edgesBetween(from, to)
          .map((edge) => edge.raw)
          .sort();

      expect(rawBetween(callerFile, routinesFile)).toEqual([
        "sql:reads_from:callable:app.shared_name",
        "sql:reads_from:callable:normalize_email",
        "sql:reads_from:callable:public.normalize_email",
      ]);
      expect(edgesBetween(callerFile, routinesFile)).toContainEqual(
        expect.objectContaining({ raw: "sql:reads_from:callable:normalize_email", resolved: "precise", confidence: 1 }),
      );
      expect(edgesBetween(callerFile, routinesFile)).toContainEqual(
        expect.objectContaining({
          raw: "sql:reads_from:callable:public.normalize_email",
          resolved: "heuristic",
          confidence: 0.7,
        }),
      );
      // A call never names a table, and the unqualified `shared_name()` fits two schemas, so it links to neither.
      expect(rawBetween(callerFile, tablesFile)).toEqual([]);
      expect(rawBetween(callerFile, archiveFile)).toEqual([]);
      // A table read never names a routine.
      expect(rawBetween(readerFile, tablesFile)).toEqual(["sql:reads_from:normalize_email"]);
      expect(rawBetween(readerFile, routinesFile)).toEqual([]);
      // ALTER and DROP statements follow the table convention: they are references.
      expect(rawBetween(adminFile, routinesFile)).toEqual([
        "sql:drops_object:callable:normalize_email",
        "sql:references_object:callable:normalize_email",
      ]);
      expect(rawBetween(adminFile, tablesFile)).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("links computed-column calls but not column types or call-shaped SQL clauses", async () => {
    const root = await mkTmpDir("cg-sql-computed-clause-edge-");
    try {
      const file = (name: string): string => path.join(root, name).replace(/\\/g, "/");
      const schema = file("routines.sql");
      const computed = file("computed.sql");
      const clauses = file("clauses.sql");
      const calls = file("calls.sql");
      await fsp.writeFile(
        schema,
        [
          "CREATE FUNCTION dbo.normalize_email(e text) RETURNS text AS $$ SELECT e $$ LANGUAGE sql;",
          "CREATE FUNCTION varchar(n integer) RETURNS integer AS $$ SELECT n $$ LANGUAGE sql;",
          "CREATE FUNCTION conflict(n integer) RETURNS integer AS $$ SELECT n $$ LANGUAGE sql;",
          "CREATE FUNCTION over(n integer) RETURNS integer AS $$ SELECT n $$ LANGUAGE sql;",
          "CREATE FUNCTION group(n integer) RETURNS integer AS $$ SELECT n $$ LANGUAGE sql;",
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(
        computed,
        "CREATE TABLE users (email varchar(100), normalized_email AS dbo.normalize_email(email));\n",
        "utf8",
      );
      await fsp.writeFile(
        clauses,
        [
          "INSERT INTO users (id) VALUES (1) ON CONFLICT (id) DO NOTHING;",
          "SELECT count(*) OVER (PARTITION BY id) FROM users;",
          "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY id) FROM users;",
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(
        calls,
        "SELECT dbo.normalize_email(email), conflict(id), over(id), group(id) FROM users;\n",
        "utf8",
      );
      const graph = await collectGraph(root, [schema, computed, clauses, calls]);
      const routineEdges = (from: string): string[] =>
        graph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();
      expect(routineEdges(computed)).toEqual(["sql:reads_from:callable:dbo.normalize_email"]);
      expect(routineEdges(clauses)).toEqual([]);
      expect(routineEdges(calls)).toEqual([
        "sql:reads_from:callable:conflict",
        "sql:reads_from:callable:dbo.normalize_email",
        "sql:reads_from:callable:group",
        "sql:reads_from:callable:over",
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("recomputes unchanged SQL call edges when a routine definition is added and removed", async () => {
    const root = await mkTmpDir("cg-sql-routine-incremental-");
    try {
      const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
      const callerFile = path.join(root, "caller.sql").replace(/\\/g, "/");
      const files = [schemaFile, callerFile];
      const hasCallEdge = (graph: Graph): boolean =>
        graph.edges.some(
          (edge) =>
            edge.from === callerFile &&
            edge.raw === "sql:reads_from:callable:normalize_email" &&
            edge.to.type === "file" &&
            edge.to.path === schemaFile,
        );
      await fsp.writeFile(schemaFile, "CREATE TABLE accounts (id integer);\n", "utf8");
      await fsp.writeFile(callerFile, "SELECT normalize_email(a) FROM accounts;\n", "utf8");

      const initialGraph = await collectGraph(root, files, { allFiles: files });
      expect(hasCallEdge(initialGraph)).toBe(false);

      await fsp.writeFile(
        schemaFile,
        "CREATE FUNCTION normalize_email(e text) RETURNS text AS $$ SELECT lower(e) $$ LANGUAGE sql;\n",
        "utf8",
      );
      const withRoutine = await collectGraph(root, [schemaFile], {
        allFiles: files,
        baseGraph: initialGraph,
        replaceFiles: new Set([schemaFile]),
      });
      expect(hasCallEdge(withRoutine)).toBe(true);

      await fsp.writeFile(schemaFile, "CREATE TABLE accounts (id integer);\n", "utf8");
      const withoutRoutine = await collectGraph(root, [schemaFile], {
        allFiles: files,
        baseGraph: withRoutine,
        replaceFiles: new Set([schemaFile]),
      });
      expect(hasCallEdge(withoutRoutine)).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not emit a routine edge when two files define the same name", async () => {
    const root = await mkTmpDir("cg-sql-ambiguous-routine-");
    try {
      const first = path.join(root, "001_first.sql").replace(/\\/g, "/");
      const second = path.join(root, "002_second.sql").replace(/\\/g, "/");
      const caller = path.join(root, "caller.sql").replace(/\\/g, "/");
      await fsp.writeFile(first, "CREATE FUNCTION refresh() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;\n", "utf8");
      await fsp.writeFile(
        second,
        "CREATE OR REPLACE FUNCTION refresh() RETURNS integer AS $$ SELECT 2 $$ LANGUAGE sql;\n",
        "utf8",
      );
      await fsp.writeFile(caller, "SELECT refresh();\n", "utf8");

      const sourceGraph = await collectGraph(root, [first, second, caller]);

      expect(sourceGraph.edges.some((edge) => edge.from === caller && edge.raw.includes("refresh"))).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a same-named table read and routine call in separate namespaces", async () => {
    const root = await mkTmpDir("cg-sql-same-name-namespace-");
    try {
      const schema = path.join(root, "schema.sql").replace(/\\/g, "/");
      const caller = path.join(root, "caller.sql").replace(/\\/g, "/");
      const reader = path.join(root, "reader.sql").replace(/\\/g, "/");
      await fsp.writeFile(
        schema,
        [
          "CREATE TABLE audit_trail (id integer);",
          "CREATE FUNCTION audit_trail() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;",
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(caller, "SELECT audit_trail();\n", "utf8");
      await fsp.writeFile(reader, "SELECT id FROM audit_trail;\n", "utf8");

      const sourceGraph = await collectGraph(root, [schema, caller, reader]);
      const rawBetween = (from: string): string[] =>
        sourceGraph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();

      expect(rawBetween(caller)).toEqual(["sql:reads_from:callable:audit_trail"]);
      expect(rawBetween(reader)).toEqual(["sql:reads_from:audit_trail"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not link an outer projection to an indexed table after a nested FROM", async () => {
    const root = await mkTmpDir("cg-sql-nested-from-boundary-");
    try {
      const schema = path.join(root, "schema.sql").replace(/\\/g, "/");
      const query = path.join(root, "query.sql").replace(/\\/g, "/");
      await fsp.writeFile(
        schema,
        "CREATE TABLE users (id integer);\nCREATE TABLE accounts (id integer);\nCREATE TABLE email (id integer);\n",
        "utf8",
      );
      await fsp.writeFile(query, "SELECT (SELECT id FROM users), email FROM accounts;\n", "utf8");
      const graph = await collectGraph(root, [schema, query]);
      expect(
        graph.edges
          .filter((edge) => edge.from === query && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort(),
      ).toEqual(["sql:reads_from:accounts", "sql:reads_from:users"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("excludes nested routine sources from table edges but keeps real reads in the same statement", async () => {
    const root = await mkTmpDir("cg-sql-nested-routine-source-");
    try {
      const schema = path.join(root, "schema.sql").replace(/\\/g, "/");
      const query = path.join(root, "query.sql").replace(/\\/g, "/");
      await fsp.writeFile(
        schema,
        "CREATE TABLE get_users (id integer);\nCREATE FUNCTION get_users() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;\nCREATE TABLE accounts (id integer);\n",
        "utf8",
      );
      await fsp.writeFile(query, "SELECT a.id FROM accounts a WHERE EXISTS (SELECT * FROM get_users());\n", "utf8");
      const graph = await collectGraph(root, [schema, query]);
      expect(
        graph.edges
          .filter((edge) => edge.from === query && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort(),
      ).toEqual(["sql:reads_from:accounts", "sql:reads_from:callable:get_users"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not add a table edge for a routine call in FROM and keeps other reads", async () => {
    const root = await mkTmpDir("cg-sql-from-call-");
    try {
      const schema = path.join(root, "schema.sql").replace(/\\/g, "/");
      const query = path.join(root, "query.sql").replace(/\\/g, "/");
      await fsp.writeFile(
        schema,
        [
          "CREATE TABLE get_users (id integer);",
          "CREATE FUNCTION get_users() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;",
          "CREATE TABLE accounts (id integer);",
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(
        query,
        [
          "SELECT * FROM get_users();",
          "SELECT * FROM get_users() g JOIN accounts ON accounts.id = g.id;",
          "SELECT get_users(1) FROM accounts;",
        ].join("\n"),
        "utf8",
      );

      const sourceGraph = await collectGraph(root, [schema, query]);
      const raws = sourceGraph.edges
        .filter((edge) => edge.from === query && edge.to.type === "file" && edge.to.path === schema)
        .map((edge) => edge.raw)
        .sort();

      expect(raws).toEqual(["sql:joins:accounts", "sql:reads_from:accounts", "sql:reads_from:callable:get_users"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the table write edge when a write statement also calls a routine of the same name", async () => {
    const root = await mkTmpDir("cg-sql-write-call-");
    try {
      const file = (name: string): string => path.join(root, name).replace(/\\/g, "/");
      const schema = file("schema.sql");
      const statements: Record<string, string> = {
        "insert.sql": "INSERT INTO get_users (id) SELECT id FROM get_users();",
        "update.sql": "UPDATE get_users SET id = g.id FROM get_users() g;",
        "merge.sql": "MERGE INTO get_users t USING get_users() s ON t.id = s.id WHEN MATCHED THEN DELETE;",
        "delete.sql": "DELETE FROM get_users USING get_users() g WHERE get_users.id = g.id;",
      };
      await fsp.writeFile(
        schema,
        [
          "CREATE TABLE get_users (id integer);",
          "CREATE FUNCTION get_users() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;",
        ].join("\n"),
        "utf8",
      );
      for (const [name, statement] of Object.entries(statements)) {
        await fsp.writeFile(file(name), `${statement}\n`, "utf8");
      }

      const sourceGraph = await collectGraph(root, [schema, ...Object.keys(statements).map(file)]);
      const rawBetween = (from: string): string[] =>
        sourceGraph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();

      // The routine call is a read of the function. The write target is still the table.
      for (const name of Object.keys(statements)) {
        expect(rawBetween(file(name))).toEqual(["sql:reads_from:callable:get_users", "sql:writes_to:get_users"]);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat an index target or CTE declaration as a routine call", async () => {
    const root = await mkTmpDir("cg-sql-index-cte-");
    try {
      const schema = path.join(root, "schema.sql").replace(/\\/g, "/");
      const indexTarget = path.join(root, "index_target.sql").replace(/\\/g, "/");
      const indexExpr = path.join(root, "index_expr.sql").replace(/\\/g, "/");
      const cteDecl = path.join(root, "cte_decl.sql").replace(/\\/g, "/");
      const cteBody = path.join(root, "cte_body.sql").replace(/\\/g, "/");
      await fsp.writeFile(
        schema,
        [
          "CREATE TABLE norm (id integer);",
          "CREATE FUNCTION norm(id integer) RETURNS integer AS $$ SELECT id $$ LANGUAGE sql;",
          "CREATE TABLE accounts (id integer);",
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(indexTarget, "CREATE INDEX ix ON norm (id);\n", "utf8");
      await fsp.writeFile(indexExpr, "CREATE INDEX iy ON accounts (norm(id));\n", "utf8");
      await fsp.writeFile(cteDecl, "WITH norm(x) AS (SELECT 1) SELECT x FROM norm;\n", "utf8");
      await fsp.writeFile(cteBody, "WITH c AS (SELECT norm(1)) SELECT 1;\n", "utf8");

      const sourceGraph = await collectGraph(root, [schema, indexTarget, indexExpr, cteDecl, cteBody]);
      const rawBetween = (from: string): string[] =>
        sourceGraph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();

      expect(rawBetween(indexTarget)).toEqual(["sql:defines_index:norm"]);
      expect(rawBetween(indexExpr)).toEqual(["sql:defines_index:accounts", "sql:reads_from:callable:norm"]);
      expect(rawBetween(cteDecl)).toEqual([]);
      expect(rawBetween(cteBody)).toEqual(["sql:reads_from:callable:norm"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each<[string, string[]]>([
    ["a project without routines", []],
    [
      "a project with an unrelated routine",
      ["CREATE FUNCTION other() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;"],
    ],
    [
      "a project with a routine named like the table",
      ["CREATE FUNCTION users() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;"],
    ],
  ])("keeps the table edge of a T-SQL table hint in %s", async (_label, routines) => {
    const root = await mkTmpDir("cg-sql-table-hint-");
    try {
      const schema = path.join(root, "schema.sql").replace(/\\/g, "/");
      const hint = path.join(root, "hint.sql").replace(/\\/g, "/");
      const withHint = path.join(root, "with_hint.sql").replace(/\\/g, "/");
      await fsp.writeFile(
        schema,
        ["CREATE TABLE users (id integer);", "CREATE TABLE orders (uid integer);", ...routines].join("\n"),
        "utf8",
      );
      await fsp.writeFile(
        hint,
        "SELECT * FROM users (NOLOCK) JOIN orders (NOLOCK) ON orders.uid = users.id;\n",
        "utf8",
      );
      await fsp.writeFile(withHint, "SELECT * FROM users u WITH (NOLOCK);\n", "utf8");

      const sourceGraph = await collectGraph(root, [schema, hint, withHint]);
      const rawBetween = (from: string): string[] =>
        sourceGraph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();

      // A hint list is no argument list: the statement reads the table and calls nothing.
      expect(rawBetween(hint)).toEqual(["sql:joins:orders", "sql:reads_from:users"]);
      expect(rawBetween(withHint)).toEqual(["sql:reads_from:users"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not link a source alias with a column list to a routine of the same name", async () => {
    const root = await mkTmpDir("cg-sql-alias-list-");
    try {
      const schema = path.join(root, "schema.sql").replace(/\\/g, "/");
      const withAs = path.join(root, "with_as.sql").replace(/\\/g, "/");
      const withoutAs = path.join(root, "without_as.sql").replace(/\\/g, "/");
      const call = path.join(root, "call.sql").replace(/\\/g, "/");
      await fsp.writeFile(
        schema,
        ["CREATE FUNCTION norm(x integer) RETURNS integer AS $$ SELECT x $$ LANGUAGE sql;"].join("\n"),
        "utf8",
      );
      await fsp.writeFile(withAs, "SELECT * FROM generate_series(1, 3) AS norm(i);\n", "utf8");
      await fsp.writeFile(withoutAs, "SELECT * FROM generate_series(1, 3) norm(i);\n", "utf8");
      await fsp.writeFile(call, "SELECT * FROM generate_series(1, norm(3)) g(i);\n", "utf8");

      const sourceGraph = await collectGraph(root, [schema, withAs, withoutAs, call]);
      const rawBetween = (from: string): string[] =>
        sourceGraph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();

      expect(rawBetween(withAs)).toEqual([]);
      expect(rawBetween(withoutAs)).toEqual([]);
      // A call in the arguments of the source is still a call.
      expect(rawBetween(call)).toEqual(["sql:reads_from:callable:norm"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not link an alias column list after a join predicate to a routine of the same name", async () => {
    const root = await mkTmpDir("cg-sql-join-alias-list-");
    try {
      const file = (name: string): string => path.join(root, name).replace(/\\/g, "/");
      const schema = file("schema.sql");
      const alias = file("alias.sql");
      const predicate = file("predicate.sql");
      const argument = file("argument.sql");
      await fsp.writeFile(
        schema,
        "CREATE FUNCTION norm(x integer) RETURNS integer AS $$ SELECT x $$ LANGUAGE sql;\n",
        "utf8",
      );
      await fsp.writeFile(alias, "SELECT * FROM a JOIN b ON a.id = b.id, generate_series(1, 3) norm(i);\n", "utf8");
      await fsp.writeFile(predicate, "SELECT * FROM a JOIN b ON norm(a.id) = b.id;\n", "utf8");
      await fsp.writeFile(
        argument,
        "SELECT * FROM a JOIN b ON a.id = b.id, generate_series(1, norm(3)) g(i);\n",
        "utf8",
      );

      const sourceGraph = await collectGraph(root, [schema, alias, predicate, argument]);
      const rawBetween = (from: string): string[] =>
        sourceGraph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();

      expect(rawBetween(alias)).toEqual([]);
      expect(rawBetween(predicate)).toEqual(["sql:reads_from:callable:norm"]);
      expect(rawBetween(argument)).toEqual(["sql:reads_from:callable:norm"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not link the command variable of a PL/pgSQL EXECUTE to a routine of the same name", async () => {
    const root = await mkTmpDir("cg-sql-dynamic-execute-");
    try {
      const file = (name: string): string => path.join(root, name).replace(/\\/g, "/");
      const schema = file("schema.sql");
      const variable = file("variable.sql");
      const built = file("built.sql");
      await fsp.writeFile(
        schema,
        "CREATE FUNCTION norm(x integer) RETURNS integer AS $$ SELECT x $$ LANGUAGE sql;\n",
        "utf8",
      );
      await fsp.writeFile(
        variable,
        "CREATE FUNCTION run_it() RETURNS void AS $$ DECLARE norm text := 'SELECT 1'; BEGIN EXECUTE norm; END $$ LANGUAGE plpgsql;\n",
        "utf8",
      );
      await fsp.writeFile(
        built,
        "CREATE FUNCTION run_built() RETURNS void AS $$ BEGIN EXECUTE format('SELECT %s', norm(1)); END $$ LANGUAGE plpgsql;\n",
        "utf8",
      );

      const sourceGraph = await collectGraph(root, [schema, variable, built]);
      const rawBetween = (from: string): string[] =>
        sourceGraph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();

      expect(rawBetween(variable)).toEqual([]);
      // A call in the expression that builds the command is still a call.
      expect(rawBetween(built)).toEqual(["sql:reads_from:callable:norm"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not link a table without INTO or a COPY column list to a routine of the same name", async () => {
    const root = await mkTmpDir("cg-sql-into-less-");
    try {
      const file = (name: string): string => path.join(root, name).replace(/\\/g, "/");
      const schema = file("schema.sql");
      const insert = file("insert.sql");
      const copy = file("copy.sql");
      const call = file("call.sql");
      await fsp.writeFile(
        schema,
        [
          "CREATE TABLE norm (id integer);",
          "CREATE FUNCTION norm(x integer) RETURNS integer AS $$ SELECT x $$ LANGUAGE sql;",
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(insert, "INSERT dbo.norm (id) VALUES (1);\n", "utf8");
      await fsp.writeFile(copy, "COPY public.norm (id) FROM stdin;\n", "utf8");
      await fsp.writeFile(call, "INSERT dbo.norm (id) SELECT norm(1);\n", "utf8");

      const sourceGraph = await collectGraph(root, [schema, insert, copy, call]);
      const rawBetween = (from: string): string[] =>
        sourceGraph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();

      expect(rawBetween(insert)).not.toContain("sql:reads_from:callable:dbo.norm");
      expect(rawBetween(copy)).not.toContain("sql:reads_from:callable:public.norm");
      // The call in the query of the same INSERT is a call.
      expect(rawBetween(call)).toEqual(["sql:reads_from:callable:norm"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["a block comment", "DROP /* note */ FUNCTION IF EXISTS norm(integer);"],
    ["a line comment", "DROP -- note\nFUNCTION IF EXISTS norm(integer);"],
  ])("does not link a DROP FUNCTION with %s inside to the table of the same name", async (_label, statement) => {
    const root = await mkTmpDir("cg-sql-commented-drop-");
    try {
      const file = (name: string): string => path.join(root, name).replace(/\\/g, "/");
      const schema = file("schema.sql");
      const admin = file("admin.sql");
      await fsp.writeFile(
        schema,
        [
          "CREATE TABLE norm (id integer);",
          "CREATE FUNCTION norm(x integer) RETURNS integer AS $$ SELECT x $$ LANGUAGE sql;",
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(admin, `${statement}\n`, "utf8");

      const sourceGraph = await collectGraph(root, [schema, admin]);
      const raws = sourceGraph.edges
        .filter((edge) => edge.from === admin && edge.to.type === "file" && edge.to.path === schema)
        .map((edge) => edge.raw)
        .sort();

      expect(raws).toEqual(["sql:drops_object:callable:norm"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("links every routine in a DROP or GRANT target list, not only the first", async () => {
    const root = await mkTmpDir("cg-sql-target-list-");
    try {
      const file = (name: string): string => path.join(root, name).replace(/\\/g, "/");
      const schema = file("schema.sql");
      const statements: Record<string, string> = {
        "bare.sql": "DROP FUNCTION f, g;",
        "signatures.sql": "DROP FUNCTION IF EXISTS f(integer), g(text);",
        "grant.sql": "GRANT EXECUTE ON FUNCTION f(integer), g(text) TO app;",
      };
      await fsp.writeFile(
        schema,
        [
          "CREATE FUNCTION f(a integer) RETURNS integer AS $$ SELECT a $$ LANGUAGE sql;",
          "CREATE FUNCTION g(a text) RETURNS text AS $$ SELECT a $$ LANGUAGE sql;",
          "CREATE TABLE g (id integer);",
        ].join("\n"),
        "utf8",
      );
      for (const [name, statement] of Object.entries(statements))
        await fsp.writeFile(file(name), `${statement}\n`, "utf8");

      const sourceGraph = await collectGraph(root, [schema, ...Object.keys(statements).map(file)]);
      const rawBetween = (from: string): string[] =>
        sourceGraph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();

      // Both names are routine statements of the same kind. The table `g` is neither dropped nor read.
      expect(rawBetween(file("bare.sql"))).toEqual(["sql:drops_object:callable:f", "sql:drops_object:callable:g"]);
      expect(rawBetween(file("signatures.sql"))).toEqual([
        "sql:drops_object:callable:f",
        "sql:drops_object:callable:g",
      ]);
      expect(rawBetween(file("grant.sql"))).toEqual([
        "sql:references_object:callable:f",
        "sql:references_object:callable:g",
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not link the table of an INSERT after a modifier to a routine of the same name", async () => {
    const root = await mkTmpDir("cg-sql-insert-modifier-");
    try {
      const file = (name: string): string => path.join(root, name).replace(/\\/g, "/");
      const schema = file("schema.sql");
      const statements: Record<string, string> = {
        "ignore.sql": "INSERT IGNORE norm (id) VALUES (1);",
        "top.sql": "INSERT TOP (1) dbo.norm (id) VALUES (1);",
        "query.sql": "INSERT IGNORE norm (id) SELECT norm(1);",
      };
      await fsp.writeFile(
        schema,
        [
          "CREATE TABLE norm (id integer);",
          "CREATE FUNCTION norm(x integer) RETURNS integer AS $$ SELECT x $$ LANGUAGE sql;",
        ].join("\n"),
        "utf8",
      );
      for (const [name, statement] of Object.entries(statements))
        await fsp.writeFile(file(name), `${statement}\n`, "utf8");

      const sourceGraph = await collectGraph(root, [schema, ...Object.keys(statements).map(file)]);
      const rawBetween = (from: string): string[] =>
        sourceGraph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();

      expect(rawBetween(file("ignore.sql"))).not.toContain("sql:reads_from:callable:norm");
      expect(rawBetween(file("top.sql")).filter((raw) => raw.includes("callable"))).toEqual([]);
      // The call in the query of the same INSERT is a call.
      expect(rawBetween(file("query.sql"))).toContain("sql:reads_from:callable:norm");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not link a column named like CALL to the routine that aliases it", async () => {
    const root = await mkTmpDir("cg-sql-call-column-");
    try {
      const file = (name: string): string => path.join(root, name).replace(/\\/g, "/");
      const schema = file("schema.sql");
      const column = file("column.sql");
      const commented = file("commented.sql");
      const call = file("call.sql");
      await fsp.writeFile(
        schema,
        [
          "CREATE TABLE contacts (id integer, call integer);",
          "CREATE FUNCTION audit_user() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;",
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(column, "SELECT id, call audit_user FROM contacts;\n", "utf8");
      await fsp.writeFile(
        commented,
        [
          "SELECT /* note */ call audit_user FROM contacts;",
          "SELECT id, -- note",
          "  call audit_user FROM contacts;",
          "",
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(call, "CALL audit_user();\n", "utf8");

      const sourceGraph = await collectGraph(root, [schema, column, commented, call]);
      const rawBetween = (from: string): string[] =>
        sourceGraph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();

      expect(rawBetween(column)).toEqual(["sql:reads_from:contacts"]);
      // A comment between the keyword and the token before it does not make the column a call.
      expect(rawBetween(commented)).toEqual(["sql:reads_from:contacts"]);
      expect(rawBetween(call)).toEqual(["sql:reads_from:callable:audit_user"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not link a call inside a nested block comment, and links the call after the comment", async () => {
    const root = await mkTmpDir("cg-sql-nested-comment-");
    try {
      const file = (name: string): string => path.join(root, name).replace(/\\/g, "/");
      const schema = file("schema.sql");
      const hidden = file("hidden.sql");
      const visible = file("visible.sql");
      await fsp.writeFile(
        schema,
        "CREATE FUNCTION norm(x integer) RETURNS integer AS $$ SELECT x $$ LANGUAGE sql;\n",
        "utf8",
      );
      await fsp.writeFile(hidden, "/* outer /* inner */ SELECT norm(1); */\n", "utf8");
      await fsp.writeFile(visible, "/* outer /* inner */ SELECT norm(1); */\nSELECT norm(2);\n", "utf8");

      const sourceGraph = await collectGraph(root, [schema, hidden, visible]);
      const rawBetween = (from: string): string[] =>
        sourceGraph.edges
          .filter((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === schema)
          .map((edge) => edge.raw)
          .sort();

      expect(rawBetween(hidden)).toEqual([]);
      expect(rawBetween(visible)).toEqual(["sql:reads_from:callable:norm"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("links a table read that follows CASE or END LOOP inside a procedure", async () => {
    const root = await mkTmpDir("cg-sql-case-end-");
    try {
      const file = (name: string): string => path.join(root, name).replace(/\\/g, "/");
      const schema = file("schema.sql");
      const body = file("body.sql");
      await fsp.writeFile(schema, "CREATE TABLE users (id integer);\nCREATE TABLE accounts (id integer);\n", "utf8");
      await fsp.writeFile(
        body,
        [
          "CREATE PROCEDURE p AS BEGIN SELECT CASE WHEN id = 1 THEN 1 ELSE 0 END AS flag FROM users; END;",
          "CREATE PROCEDURE q AS BEGIN LOOP SELECT id FROM accounts; END LOOP; END;",
          "",
        ].join("\n"),
        "utf8",
      );

      const sourceGraph = await collectGraph(root, [schema, body]);
      const raw = sourceGraph.edges
        .filter((edge) => edge.from === body && edge.to.type === "file" && edge.to.path === schema)
        .map((edge) => edge.raw)
        .sort();

      expect(raw).toEqual(["sql:reads_from:accounts", "sql:reads_from:users"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
