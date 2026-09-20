import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runQuery } from "@lzehrung/codegraph-native";
import { findReferences, goToDefinition, listSymbols } from "../../src/index.js";
import { collectImportsForFile } from "../../src/indexer/imports.js";
import { TSX_SUPPORT } from "../../src/languages.js";
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

describe("TSX per-specifier type-only bindings", () => {
  it("records mixed inline type imports per specifier", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-tsx-type-only-"));
    try {
      await writeFile(path.join(root, "m.tsx"), "export type Inline = number;\nexport const b = 1;\n", "utf8");
      await writeFile(path.join(root, "consumer.tsx"), 'import { type Inline, b } from "./m";\n', "utf8");
      const source = 'import { type Inline, b } from "./m";\n';
      expect(
        runQuery(source, "tsx", TSX_SUPPORT.queries.importBindings).matches.map((match) => {
          const byName = Object.fromEntries(match.captures.map((capture) => [capture.name, capture.text]));
          return { iname: byName.iname, type_kw: byName.type_kw };
        }),
      ).toEqual(
        expect.arrayContaining([
          { iname: "Inline", type_kw: "type" },
          { iname: "b", type_kw: undefined },
        ]),
      );
      const bindings = await collectImportsForFile(path.join(root, "consumer.tsx"), root);
      expect(bindings.filter((binding) => binding.kind === "named")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ imported: "Inline", typeOnly: true }),
          expect.objectContaining({ imported: "b", typeOnly: false }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a default import named type as a runtime edge and binding", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-tsx-type-binding-"));
    const mod = path.join(root, "mod.tsx");
    const types = path.join(root, "types.tsx");
    const consumer = path.join(root, "consumer.tsx");
    try {
      await writeFile(mod, "export default 1;\n", "utf8");
      await writeFile(types, "export class Widget {}\n", "utf8");
      await writeFile(
        consumer,
        ['import type from "./mod";', 'import type { Widget } from "./types";', ""].join("\n"),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [mod, types, consumer]);
      const module = index.byFile.get(fileIdentityKey(consumer));
      const typeOnlyImports = (module?.imports ?? []).filter((binding) => binding.typeOnly);
      expect(typeOnlyImports).toEqual([expect.objectContaining({ from: "./types", typeOnly: true })]);
      expect((module?.imports ?? []).find((binding) => binding.from === "./mod")?.typeOnly).toBeFalsy();

      const fromConsumer = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(consumer));
      const typeOnlyTargets = fromConsumer
        .filter((edge) => edge.typeOnly)
        .map((edge) => (edge.to.type === "file" ? edge.to.path : edge.to.name));
      expect(typeOnlyTargets).toEqual([types.replace(/\\/g, "/")]);
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
      "NamespaceModule;",
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
      const namespaceModule = await goToDefinition(index, { file: consumerFile, line: 4, column: 1 });
      expect(namespaceModule.status).toBe("ok");
      if (namespaceModule.status === "ok") {
        expect(namespaceModule.definition.file).toBe(apiFile);
        expect(namespaceModule.definition.range.start.line).toBe(3);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("TSX named function expression self-binding", () => {
  it("binds the function expression name inside its own body only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-tsx-fn-expr-self-binding-"));
    const file = path.join(root, "scope.tsx").replace(/\\/g, "/");
    const source = [
      "export const visible = 1;",
      "const outer = function inner(value: number): number {",
      "  return value <= 0 ? 0 : inner(value - 1);",
      "};",
      "const sibling = inner;",
      "const anonymous = function () { return 1; };",
      "const arrow = () => 1;",
      "const scope: { refresh?: () => void } = {};",
      "scope.refresh = function refresh() {",
      "  refresh();",
      "};",
      "const counter = function* gen(value: number): number {",
      "  return yield* gen(value - 1);",
      "};",
      "const outsideGen = gen;",
      "",
    ].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const lines = source.split("\n");

      const recursiveInner = await goToDefinition(index, {
        file,
        line: 3,
        column: lines[2]!.indexOf("inner") + 1,
      });
      expect(recursiveInner.status).toBe("ok");
      if (recursiveInner.status === "ok") {
        expect(recursiveInner.definition.localName).toBe("inner");
        expect(recursiveInner.definition.kind).toBe("function");
        expect(recursiveInner.definition.range.start.line).toBe(2);
      }

      const siblingInner = await goToDefinition(index, {
        file,
        line: 5,
        column: lines[4]!.indexOf("inner") + 1,
      });
      expect(siblingInner.status).toBe("not_found");

      const recursiveRefresh = await goToDefinition(index, {
        file,
        line: 10,
        column: lines[9]!.indexOf("refresh") + 1,
      });
      expect(recursiveRefresh.status).toBe("ok");
      if (recursiveRefresh.status === "ok") {
        expect(recursiveRefresh.definition.localName).toBe("refresh");
        expect(recursiveRefresh.definition.range.start.line).toBe(9);
      }

      const recursiveGen = await goToDefinition(index, {
        file,
        line: 13,
        column: lines[12]!.indexOf("gen") + 1,
      });
      expect(recursiveGen.status).toBe("ok");
      if (recursiveGen.status === "ok") {
        expect(recursiveGen.definition.localName).toBe("gen");
        expect(recursiveGen.definition.range.start.line).toBe(12);
      }

      const siblingGen = await goToDefinition(index, {
        file,
        line: 15,
        column: lines[14]!.indexOf("gen") + 1,
      });
      expect(siblingGen.status).toBe("not_found");

      const references = await findReferences(index, {
        file,
        line: 2,
        column: lines[1]!.indexOf("inner") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(
          references.references.map((reference) => reference.range.start.line).sort((left, right) => left - right),
        ).toEqual([2, 3]);
      }

      const apiModule = index.byFile.get(fileIdentityKey(file));
      const exported = apiModule?.exports.flatMap((entry) => ("exportedAs" in entry ? [entry.exportedAs] : [])) ?? [];
      expect(exported).toContain("visible");
      expect(exported).not.toContain("inner");
      expect(exported).not.toContain("refresh");
      expect(exported).not.toContain("gen");

      const selfBindingNames = listSymbols(index, { file })
        .map((symbol) => symbol.name)
        .filter((name) => ["inner", "gen", "refresh", "anonymous", "arrow"].includes(name))
        .sort();
      expect(selfBindingNames).toEqual(["anonymous", "arrow", "gen", "inner", "refresh"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
