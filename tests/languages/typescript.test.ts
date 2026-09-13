import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { goToDefinition, listSymbols } from "../../src/index.js";
import { chunkFile } from "../../src/chunking/chunk-file.js";
import { LANG_CONFIGS } from "../../src/bootstrap/tree-sitter-languages.js";
import { createTestIndex, createTestIndexFromFiles } from "../test-utils.js";
import { fileIdentityKey } from "../../src/util/paths.js";
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

  it("resolves exported declaration-only functions and namespaces from a consumer import", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-ts-declaration-exports-"));
    const apiFile = path.join(root, "api.d.ts").replace(/\\/g, "/");
    const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
    const apiSource = [
      "export declare function overloaded(value: string): string;",
      "export function bareSig(value: number): number;",
      "export namespace Toolkit {}",
      "export module NamespaceModule {}",
      "export declare namespace ExportedNS {}",
      'declare module "ambient" {}',
      'export declare module "ambient-export" {}',
    ].join("\n");
    const consumerSource = [
      'import { overloaded, bareSig, Toolkit, NamespaceModule, ExportedNS } from "./api";',
      "overloaded;",
      "bareSig;",
      "Toolkit;",
      "NamespaceModule;",
      "ExportedNS;",
    ].join("\n");
    try {
      await writeFile(apiFile, apiSource, "utf8");
      await writeFile(consumerFile, consumerSource, "utf8");
      const index = await createTestIndexFromFiles(root, [apiFile, consumerFile]);
      const api = index.byFile.get(fileIdentityKey(apiFile));
      const exported = api?.exports.flatMap((entry) => ("exportedAs" in entry ? [entry.exportedAs] : [])) ?? [];

      expect(exported).toEqual(
        expect.arrayContaining(["overloaded", "bareSig", "Toolkit", "NamespaceModule", "ExportedNS"]),
      );
      expect(exported).not.toContain("ambient");
      expect(exported).not.toContain("ambient-export");
      expect(exported).not.toContain('"ambient"');
      expect(exported).not.toContain('"ambient-export"');

      const cases = [
        { line: 2, name: "overloaded", expectedLine: 1 },
        { line: 3, name: "bareSig", expectedLine: 2 },
        { line: 4, name: "Toolkit", expectedLine: 3 },
        { line: 5, name: "NamespaceModule", expectedLine: 4 },
        { line: 6, name: "ExportedNS", expectedLine: 5 },
      ];
      for (const testCase of cases) {
        const result = await goToDefinition(index, { file: consumerFile, line: testCase.line, column: 1 });
        expect(result.status, testCase.name).toBe("ok");
        if (result.status === "ok") {
          expect(result.definition.file).toBe(apiFile);
          expect(result.definition.range.start.line).toBe(testCase.expectedLine);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
