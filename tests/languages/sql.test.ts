import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  chunkFile,
  extractSqlFactsFromSource,
  listSymbols,
  supportForFile,
} from "../../src/index.js";
import { fileIdentityKey } from "../../src/util/paths.js";
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
    vi.doMock("../../src/parserBackend.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/parserBackend.js")>("../../src/parserBackend.js");
      return {
        ...actual,
        isNonNativeParserAvailable: () => false,
        parseWithLanguage: parseSpy,
      };
    });
    vi.doMock("../../src/native/treeSitterNative.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/native/treeSitterNative.js")>(
        "../../src/native/treeSitterNative.js",
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
      vi.doUnmock("../../src/parserBackend.js");
      vi.doUnmock("../../src/native/treeSitterNative.js");
      vi.resetModules();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
