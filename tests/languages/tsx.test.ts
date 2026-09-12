import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { goToDefinition } from "../../src/index.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "tsx",
  samples: [
    {
      name: "chunks basic TSX structures",
      sourceFile: "tsx.sample.tsx",
      exactChunks: [
        { type: "imports", startLine: 1, endLine: 1 },
        { type: "misc", startLine: 1, endLine: 3 },
        { type: "function", name: "Button", startLine: 3, endLine: 5 },
        { type: "jsx", startLine: 4, endLine: 4 },
        { type: "misc", startLine: 5, endLine: 9 },
        { type: "function", name: "Fragment", startLine: 9, endLine: 16 },
        { type: "jsx", startLine: 11, endLine: 14 },
        { type: "jsx", startLine: 12, endLine: 12 },
        { type: "jsx", startLine: 13, endLine: 13 },
        { type: "misc", startLine: 16, endLine: 16 },
      ],
    },
  ],
  parity: {
    sampleDir: "tsx",
    exact: {
      dependencyGraph: [
        {
          from: "App.tsx",
          to: { type: "file", path: "components/Button.tsx" },
        },
        {
          from: "App.tsx",
          to: { type: "file", path: "utils.ts" },
        },
        {
          from: "JsxImportApp.tsx",
          to: { type: "file", path: "components/Button.tsx" },
        },
        {
          from: "utils.ts",
          to: { type: "external", name: "lodash" },
        },
        {
          from: "reexport-barrel.tsx",
          to: { type: "file", path: "reexport-source.tsx" },
        },
        {
          from: "reexport-consumer.tsx",
          to: { type: "file", path: "reexport-barrel.tsx" },
        },
      ],
      references: [
        {
          name: "finds aliased TSX re-export references",
          file: "reexport-source.tsx",
          line: 1,
          column: 14,
          references: [
            { file: "reexport-source.tsx", line: 1 },
            // The barrel's own `export { ... } from` line is an API-surface use,
            // reported with `via.reexport` so executable-use consumers can filter it.
            { file: "reexport-barrel.tsx", line: 1 },
            { file: "reexport-consumer.tsx", line: 1 },
            { file: "reexport-consumer.tsx", line: 3 },
          ],
        },
      ],
    },
    goToDefinition: [
      {
        name: "resolves aliased TSX re-export",
        file: "reexport-consumer.tsx",
        line: 3,
        column: 25,
        expectedDefinition: { file: "reexport-source.tsx", line: 1 },
      },
      {
        name: "resolves star TSX re-export",
        file: "reexport-consumer.tsx",
        line: 4,
        column: 24,
        expectedDefinition: { file: "reexport-source.tsx", line: 2 },
      },
      {
        name: "resolves namespace TSX re-export",
        file: "reexport-consumer.tsx",
        line: 5,
        column: 45,
        expectedDefinition: { file: "reexport-source.tsx", line: 3 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("TSX class static-block scopes", () => {
  it("does not resolve static-block locals from sibling methods", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-tsx-static-block-scope-"));
    const file = path.join(root, "scope.tsx");
    const source = "class C { static { let hidden = 1; } method() { return hidden; } }";
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);

      expect(await goToDefinition(index, { file, line: 1, column: source.lastIndexOf("hidden") + 1 })).toMatchObject({
        status: "not_found",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("TSX declaration-only exports", () => {
  it("resolves exported declaration-only functions and namespaces from a consumer import", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-tsx-declaration-exports-"));
    const apiFile = path.join(root, "api.tsx").replace(/\\/g, "/");
    const consumerFile = path.join(root, "consumer.tsx").replace(/\\/g, "/");
    const apiSource = [
      "export declare function overloaded(value: string): string;",
      "export namespace Toolkit {}",
      "export module NamespaceModule {}",
      'declare module "ambient" {}',
    ].join("\n");
    const consumerSource = [
      'import { overloaded, Toolkit, NamespaceModule } from "./api";',
      "overloaded;",
      "Toolkit;",
    ].join("\n");
    try {
      await writeFile(apiFile, apiSource, "utf8");
      await writeFile(consumerFile, consumerSource, "utf8");
      const index = await createTestIndexFromFiles(root, [apiFile, consumerFile]);
      const api = index.byFile.get(fileIdentityKey(apiFile));
      const exported = api?.exports.flatMap((entry) => ("exportedAs" in entry ? [entry.exportedAs] : [])) ?? [];

      expect(exported).toEqual(expect.arrayContaining(["overloaded", "Toolkit", "NamespaceModule"]));
      expect(exported).not.toContain("ambient");
      expect(exported).not.toContain('"ambient"');

      const overloaded = await goToDefinition(index, { file: consumerFile, line: 2, column: 1 });
      expect(overloaded.status).toBe("ok");
      if (overloaded.status === "ok") {
        expect(overloaded.definition.file).toBe(apiFile);
        expect(overloaded.definition.range.start.line).toBe(1);
      }
      const toolkit = await goToDefinition(index, { file: consumerFile, line: 3, column: 1 });
      expect(toolkit.status).toBe("ok");
      if (toolkit.status === "ok") {
        expect(toolkit.definition.file).toBe(apiFile);
        expect(toolkit.definition.range.start.line).toBe(2);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
