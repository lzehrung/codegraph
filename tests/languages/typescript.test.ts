import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runQuery } from "@lzehrung/codegraph-native";
import { listSymbols } from "../../src/index.js";
import { chunkFile } from "../../src/chunking/chunk-file.js";
import { LANG_CONFIGS } from "../../src/bootstrap/tree-sitter-languages.js";
import { collectLocalsAndExportsFromSource } from "../../src/indexer/locals-and-exports.js";
import { collectImportsForFile } from "../../src/indexer/imports.js";
import { getNativeQueryExecution } from "../../src/native/tree-sitter-native.js";
import { TS_SUPPORT } from "../../src/languages.js";
import { createTestIndex, createTestIndexFromFiles } from "../test-utils.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "typescript",
  samples: [
    {
      name: "chunks basic TypeScript structures",
      sourceFile: "typescript.sample.ts",
      exactChunks: [
        { type: "imports", startLine: 1, endLine: 2 },
        { type: "interface", name: "User", startLine: 3, endLine: 7 },
        { type: "enum", name: "Role", startLine: 8, endLine: 12 },
        { type: "type_alias", name: "UserId", startLine: 13, endLine: 14 },
        { type: "class", name: "Service", startLine: 15, endLine: 21 },
        { type: "method", name: "constructor", startLine: 16, endLine: 16 },
        { type: "method", name: "getRole", startLine: 18, endLine: 20 },
        { type: "misc", startLine: 21, endLine: 22 },
        { type: "function", name: "helper", startLine: 23, endLine: 25 },
      ],
    },
  ],
  parity: {
    sampleDir: "typescript",
    exact: {
      dependencyGraph: [
        {
          from: "dynamic-import.ts",
          to: { type: "file", path: "helpers.ts" },
        },
        {
          from: "triple-slash-reference.ts",
          to: { type: "file", path: "triple-slash-globals.d.ts" },
          typeOnly: true,
        },
        {
          from: "main.ts",
          to: { type: "file", path: "utils.ts" },
        },
        {
          from: "utils.ts",
          to: { type: "file", path: "helpers.ts" },
        },
      ],
      symbols: [
        {
          file: "abstract-implementation.ts",
          symbols: [
            { name: "AbstractJob", kind: "class" },
            { name: "ConcreteJob", kind: "class" },
            { name: "execute", kind: "function" },
            { name: "execute", kind: "function" },
          ],
        },
      ],
      references: [
        {
          name: "find references for UtilityClass resolves namespace and named import constructions",
          file: "utils.ts",
          line: 5,
          column: 14,
          references: [
            { file: "main.ts", line: 8 },
            { file: "main.ts", line: 12 },
            { file: "utils.ts", line: 5 },
          ],
        },
        {
          name: "find references for UtilityClass.getValue resolves through the receiver",
          file: "utils.ts",
          line: 12,
          column: 3,
          references: [
            { file: "main.ts", line: 13 },
            { file: "utils.ts", line: 12 },
          ],
        },
      ],
    },
  },
};

runLanguageTests(definition);

describe("TypeScript symbol extraction", () => {
  it("extracts type aliases with the type kind", async () => {
    const index = await createTestIndex("typescript");
    const file = path.resolve(process.cwd(), "tests", "samples", "typescript", "utils.ts");
    const utilityType = listSymbols(index, { file }).find((symbol) => symbol.name === "UtilityType");

    expect(utilityType).toMatchObject({ name: "UtilityType", kind: "type" });
  });
});

describe("TypeScript declaration-only symbols", () => {
  it("indexes function signatures and namespace declarations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-ts-declaration-symbols-"));
    const file = path.join(root, "api.d.ts");
    const source = [
      "declare function overloaded(value: string): string;",
      "declare namespace Toolkit {}",
      "declare module NamespaceModule {}",
      'declare module "ambient" {}',
    ].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const symbols = listSymbols(index, { file });
      const chunks = chunkFile({
        language: LANG_CONFIGS.typescript!,
        source,
        filePath: file,
        minTokens: 1,
      });

      expect(symbols).toContainEqual(expect.objectContaining({ name: "overloaded", kind: "function" }));
      expect(symbols).toContainEqual(expect.objectContaining({ name: "Toolkit", kind: "type" }));
      expect(symbols).toContainEqual(expect.objectContaining({ name: "NamespaceModule", kind: "type" }));
      expect(chunks).toContainEqual(expect.objectContaining({ type: "namespace", name: '"ambient"' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("TypeScript per-specifier type-only bindings", () => {
  it("captures the inline type token on mixed named imports", () => {
    const source = 'import { type Inline, b } from "./m";\n';
    const matches = runQuery(source, "ts", TS_SUPPORT.queries.importBindings).matches.map((match) => {
      const byName = Object.fromEntries(match.captures.map((capture) => [capture.name, capture.text]));
      return { iname: byName.iname, type_kw: byName.type_kw };
    });
    expect(matches).toEqual(
      expect.arrayContaining([
        { iname: "Inline", type_kw: "type" },
        { iname: "b", type_kw: undefined },
      ]),
    );
  });

  it("records mixed inline type imports per specifier and keeps import type on the statement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-ts-type-only-"));
    try {
      await writeFile(path.join(root, "m.ts"), "export type Inline = number;\nexport const b = 1;\n", "utf8");
      await writeFile(
        path.join(root, "consumer.ts"),
        [
          'import { type Inline, b } from "./m";',
          'import type { Inline as Whole } from "./m";',
          'export { type Inline, b } from "./m";',
        ].join("\n"),
        "utf8",
      );
      const bindings = await collectImportsForFile(path.join(root, "consumer.ts"), root);
      const named = bindings.filter((binding) => binding.kind === "named");
      expect(named).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ imported: "Inline", local: "Inline", typeOnly: true }),
          expect.objectContaining({ imported: "b", local: "b", typeOnly: false }),
          expect.objectContaining({ imported: "Inline", local: "Whole", typeOnly: true }),
        ]),
      );

      const source = [
        'import { type Inline, b } from "./m";',
        'import type { Inline as Whole } from "./m";',
        'export { type Inline, b } from "./m";',
      ].join("\n");
      const native = getNativeQueryExecution(source, TS_SUPPORT);
      const mod = collectLocalsAndExportsFromSource(path.join(root, "consumer.ts"), source, TS_SUPPORT, [], {
        nativeQueries: native.results,
      });
      const reexports = mod.exports.filter((entry) => entry.type === "reexport");
      expect(reexports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ exportedAs: "Inline", typeOnly: true }),
          expect.objectContaining({ exportedAs: "b", typeOnly: false }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
