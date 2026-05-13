import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { collectGraph } from "../src/index.js";
import { buildSqlArtifactGraphFromFiles } from "../src/sql/index.js";
import { buildSqlFactCache, collectSqlEdgesForFile } from "../src/sql/sourceGraph.js";

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
});
