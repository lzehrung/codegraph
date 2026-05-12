import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectGraph } from "../src/index.js";
import { buildSqlArtifactGraphFromFiles } from "../src/sql/index.js";

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

  it("keeps SQL artifact edges out of the source dependency graph", async () => {
    const sourceGraph = await collectGraph(fixtureRoot, [...sqlFiles, path.join(fixtureRoot, "app.ts")]);

    expect(sourceGraph.edges).toEqual([]);
  });
});
