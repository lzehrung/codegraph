import { expect, it } from "vitest";
import { chunkFile, supportForFile } from "../../src/index.js";
import { LANG_CONFIGS } from "../../src/bootstrap/treeSitterLanguages.js";

it("registers SQL files as artifact language support", () => {
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
