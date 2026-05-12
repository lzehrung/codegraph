import { expect, it } from "vitest";
import path from "node:path";
import { buildProjectIndex, buildProjectIndexFromFiles, chunkFile, listSymbols, supportForFile } from "../../src/index.js";
import { LANG_CONFIGS } from "../../src/bootstrap/treeSitterLanguages.js";

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

it("includes discovered SQL files in the normal repository index", async () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "sql", "graph");
  const schemaFile = path.join(samplePath, "001_create_users.sql").replace(/\\/g, "/");
  const reportFile = path.join(samplePath, "report.sql").replace(/\\/g, "/");
  const index = await buildProjectIndex(samplePath);

  expect(index.byFile.has(schemaFile)).toBe(true);
  expect(index.byFile.has(reportFile)).toBe(true);
  expect(index.graph.edges).toContainEqual(
    expect.objectContaining({
      from: reportFile,
      raw: "sql:reads_from:users",
      to: { type: "file", path: schemaFile },
    }),
  );
});
