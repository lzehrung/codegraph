import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runQuery } from "@lzehrung/codegraph-native";
import { buildProjectIndexFromFiles, findReferences, goToDefinition, listSymbols } from "../../src/index.js";
import { chunkFile } from "../../src/chunking/chunk-file.js";
import { LANG_CONFIGS } from "../../src/bootstrap/tree-sitter-languages.js";
import { collectLocalsAndExportsFromSource } from "../../src/indexer/locals-and-exports.js";
import { collectImportsForFile } from "../../src/indexer/imports.js";
import { getNativeQueryExecution } from "../../src/native/tree-sitter-native.js";
import { TS_SUPPORT } from "../../src/languages.js";
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
            { file: "main.ts", line: 1 },
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

describe("TypeScript enum and field member navigation", () => {
  it("resolves enum members and class fields without treating initializer reads as declarations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-ts-members-"));
    const apiFile = path.join(root, "api.model.ts").replace(/\\/g, "/");
    const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
    const apiSource = [
      "export enum Mode {",
      "  Light,",
      "  Heavy = Light,",
      "}",
      "export class Box {",
      "  static probe(): number { const value = 99; return value; }",
      "  static value = Mode.Light;",
      "  instanceValue = 1;",
      "  static create(): Box { return new Box(); }",
      "  instanceMethod(): number { return this.instanceValue; }",
      "}",
      "",
    ].join("\n");
    const consumerSource = [
      'import { Mode, Box } from "./api.model";',
      "const selected = Mode.Light;",
      "const copy = Box.value;",
      "const made = Box.create();",
      "const invalidField = Box.instanceValue;",
      "const invalidMethod = Box.instanceMethod();",
      "",
    ].join("\n");
    try {
      await Promise.all([writeFile(apiFile, apiSource, "utf8"), writeFile(consumerFile, consumerSource, "utf8")]);
      const index = await createTestIndexFromFiles(root, [apiFile, consumerFile]);

      const enumMember = await goToDefinition(index, {
        file: consumerFile,
        line: 2,
        column: consumerSource.split("\n")[1]!.indexOf("Light") + 1,
      });
      expect(enumMember.status).toBe("ok");
      if (enumMember.status === "ok") {
        expect(enumMember.definition.file).toBe(apiFile);
        expect(enumMember.definition.range.start.line).toBe(2);
      }

      const classField = await goToDefinition(index, {
        file: consumerFile,
        line: 3,
        column: consumerSource.split("\n")[2]!.indexOf("value") + 1,
      });
      expect(classField.status).toBe("ok");
      if (classField.status === "ok") {
        expect(classField.definition.file).toBe(apiFile);
        expect(classField.definition.range.start.line).toBe(7);
      }
      const staticMethod = await goToDefinition(index, {
        file: consumerFile,
        line: 4,
        column: consumerSource.split("\n")[3]!.indexOf("create") + 1,
      });
      expect(staticMethod.status).toBe("ok");
      if (staticMethod.status === "ok") {
        expect(staticMethod.definition.file).toBe(apiFile);
        expect(staticMethod.definition.range.start.line).toBe(9);
      }

      for (const testCase of [
        { line: 5, member: "instanceValue" },
        { line: 6, member: "instanceMethod" },
      ]) {
        const result = await goToDefinition(index, {
          file: consumerFile,
          line: testCase.line,
          column: consumerSource.split("\n")[testCase.line - 1]!.indexOf(testCase.member) + 1,
        });
        expect(result.status, testCase.member).toBe("not_found");
      }

      const references = await findReferences(index, { file: apiFile, line: 2, column: 3 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.references.map((reference) => [reference.file, reference.range.start.line])).toEqual(
          expect.arrayContaining([
            [apiFile, 3],
            [apiFile, 7],
            [consumerFile, 2],
          ]),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat ordinary type aliases as runtime member receivers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-ts-type-receiver-"));
    const file = path.join(root, "types.ts").replace(/\\/g, "/");
    const source = ["type Shape = { run(): void };", "Shape.run();", ""].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);

      const result = await goToDefinition(index, {
        file,
        line: 2,
        column: source.split("\n")[1]!.indexOf("run") + 1,
      });

      expect(result.status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves only direct namespace members", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-ts-namespace-members-"));
    const file = path.join(root, "namespace.ts").replace(/\\/g, "/");
    const source = [
      "namespace Tools {",
      "  export const visible = 1;",
      "  export function build() { const hidden = 2; return hidden; }",
      "}",
      "const valid = Tools.visible;",
      "const invalid = Tools.hidden;",
      "",
    ].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);

      const visible = await goToDefinition(index, {
        file,
        line: 5,
        column: source.split("\n")[4]!.indexOf("visible") + 1,
      });
      expect(visible.status).toBe("ok");
      if (visible.status === "ok") {
        expect(visible.definition.range.start.line).toBe(2);
      }

      const hidden = await goToDefinition(index, {
        file,
        line: 6,
        column: source.split("\n")[5]!.indexOf("hidden") + 1,
      });
      expect(hidden.status).toBe("not_found");
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
  it("records inline type and export type re-exports in native-off mode", () => {
    const source = [
      'export { type Inline, b } from "./m";',
      'export type { Whole } from "./m";',
      'export { Value } from "./m";',
      'export { type as alias } from "./m2";',
    ].join("\n");
    const mod = collectLocalsAndExportsFromSource("consumer.ts", source, TS_SUPPORT, [], { nativeMode: "off" });
    const reexports = mod.exports.filter((entry) => entry.type === "reexport");
    expect(reexports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exportedAs: "Inline", sourceSpecifier: "Inline", typeOnly: true }),
        expect.objectContaining({ exportedAs: "b", sourceSpecifier: "b", typeOnly: false }),
        expect.objectContaining({ exportedAs: "Whole", sourceSpecifier: "Whole", typeOnly: true }),
        expect.objectContaining({ exportedAs: "Value", sourceSpecifier: "Value", typeOnly: false }),
        // A specifier literally named `type` re-aliased with `as` is a normal (non-type-only)
        // export of the identifier `type`, not the `type` modifier followed by a dropped name.
        expect.objectContaining({ exportedAs: "alias", sourceSpecifier: "type", typeOnly: false }),
      ]),
    );
    expect(reexports).toHaveLength(5);
  });

  it("keeps a default import named type as a runtime edge and binding", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-ts-type-binding-"));
    const mod = path.join(root, "mod.ts");
    const types = path.join(root, "types.ts");
    const consumer = path.join(root, "consumer.ts");
    try {
      await writeFile(mod, "export default 1;\n", "utf8");
      await writeFile(types, "export class Widget {}\n", "utf8");
      await writeFile(
        consumer,
        [
          'import type from "./mod";',
          'import type { Widget } from "./types";',
          'import foo from "import type";',
          "",
        ].join("\n"),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [mod, types, consumer]);
      const module = index.byFile.get(fileIdentityKey(consumer));
      const typeOnlyImports = (module?.imports ?? []).filter((binding) => binding.typeOnly);
      expect(typeOnlyImports).toEqual([expect.objectContaining({ from: "./types", typeOnly: true })]);
      // Assert the binding exists and is runtime: `find(...)?.typeOnly` with `toBeFalsy` also
      // passes when the default binding is missing entirely.
      expect((module?.imports ?? []).filter((binding) => binding.from === "./mod")).toEqual([
        expect.objectContaining({ from: "./mod", kind: "default", local: "type", typeOnly: false }),
      ]);

      const fromConsumer = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(consumer));
      const typeOnlyTargets = fromConsumer
        .filter((edge) => edge.typeOnly)
        .map((edge) => (edge.to.type === "file" ? edge.to.path : edge.to.name));
      expect(typeOnlyTargets).toEqual([types.replace(/\\/g, "/")]);
      expect(
        fromConsumer.some(
          (edge) => !edge.typeOnly && edge.to.type === "file" && fileIdentityKey(edge.to.path) === fileIdentityKey(mod),
        ),
      ).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a default import named type as runtime without the native addon", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-ts-type-binding-reduced-"));
    const mod = path.join(root, "mod.ts");
    const types = path.join(root, "types.ts");
    const consumer = path.join(root, "consumer.ts");
    try {
      await writeFile(mod, "export default 1;\n", "utf8");
      await writeFile(types, "export class Widget {}\n", "utf8");
      await writeFile(
        consumer,
        [
          'import type from "./mod";',
          'import type { Widget } from "./types";',
          'import foo from "import type";',
          "",
        ].join("\n"),
        "utf8",
      );
      const index = await buildProjectIndexFromFiles(root, [mod, types, consumer], { native: "off" });
      const module = index.byFile.get(fileIdentityKey(consumer));
      expect((module?.imports ?? []).filter((binding) => binding.typeOnly)).toEqual([
        expect.objectContaining({ from: "./types", typeOnly: true }),
      ]);
      expect((module?.imports ?? []).filter((binding) => binding.from === "./mod")).toEqual([
        expect.objectContaining({ from: "./mod", kind: "default", local: "type", typeOnly: false }),
      ]);
      const fromConsumer = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(consumer));
      expect(
        fromConsumer.some(
          (edge) => !edge.typeOnly && edge.to.type === "file" && fileIdentityKey(edge.to.path) === fileIdentityKey(mod),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("TypeScript named function expression self-binding", () => {
  it("binds the function expression name inside its own body only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-ts-fn-expr-self-binding-"));
    const file = path.join(root, "scope.ts").replace(/\\/g, "/");
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
