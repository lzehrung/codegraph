import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  chunkFile,
  listSymbols,
  supportForFile,
} from "../../src/index.js";
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

describe("native-only SQL support", () => {
  it("indexes SQL without the JS fallback parser when native parsing is unavailable", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-native-only-"));
    const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
    await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\n", "utf8");

    const parseSpy = vi.fn(() => {
      throw new Error(
        "JS Tree-sitter fallback is unavailable for grammar loading. Install @lzehrung/codegraph-js-fallback to enable it",
      );
    });

    vi.resetModules();
    vi.doMock("../../src/jsFallback.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/jsFallback.js")>("../../src/jsFallback.js");
      return {
        ...actual,
        isJsFallbackAvailable: () => false,
        parseWithJsLanguage: parseSpy,
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
      vi.doUnmock("../../src/jsFallback.js");
      vi.doUnmock("../../src/native/treeSitterNative.js");
      vi.resetModules();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
