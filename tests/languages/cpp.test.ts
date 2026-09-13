import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/agent/session.js";
import { listCandidateTestFiles } from "../../src/impact/context.js";
import { normalizePath } from "../../src/util/paths.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { expectUnicodeSymbolRangeIdentity } from "./unicode-symbol-range.js";
import { collectLocalsAndExportsFromSource } from "../../src/indexer/locals-and-exports.js";
import { C_SUPPORT, CPP_SUPPORT, supportForFile, type LanguageSupport } from "../../src/languages.js";
import { getNativeQueryExecution } from "../../src/native/tree-sitter-native.js";
import { findReferences, goToDefinition, listSymbols } from "../../src/index.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { parseSyntaxTree, runQuery } from "@lzehrung/codegraph-native";

function collectCppNames(file: string, source: string, support: LanguageSupport = CPP_SUPPORT) {
  const nativeQueries = getNativeQueryExecution(source, support).results;
  const module = collectLocalsAndExportsFromSource(file, source, support, [], { nativeQueries });
  return {
    exports: module.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : [])),
    locals: module.locals.map((entry) => entry.localName),
  };
}

const definition: LanguageTestDefinition = {
  id: "cpp",
  samples: [
    {
      name: "chunks C++ structures",
      sourceFile: "cpp.sample.cpp",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 2 },
        { type: "namespace", name: "demo", startLine: 3, endLine: 17 },
        { type: "class", name: "MyClass", startLine: 4, endLine: 7 },
        { type: "function", name: "method", startLine: 6, endLine: 6 },
        { type: "struct", name: "MyStruct", startLine: 9, endLine: 11 },
        { type: "enum", name: "MyMode", startLine: 13, endLine: 16 },
        { type: "misc", startLine: 17, endLine: 19 },
        { type: "function", name: "add", startLine: 20, endLine: 22 },
      ],
    },
  ],
  parity: {
    sampleDir: "cpp",
    exact: {
      dependencyGraph: [
        {
          from: "main.cpp",
          to: { type: "file", path: "helpers.hpp" },
        },
        {
          from: "main.cpp",
          to: { type: "file", path: "utils.hpp" },
        },
        {
          from: "namespace-usage.cpp",
          to: { type: "file", path: "namespaces.hpp" },
        },
      ],
      symbols: [
        {
          file: "advanced.hpp",
          symbols: [
            { name: "demo", kind: "class" },
            { name: "Mode", kind: "type" },
            { name: "Fast", kind: "variable" },
            { name: "Slow", kind: "variable" },
            { name: "Count", kind: "type" },
            { name: "Engine", kind: "class" },
            { name: "run", kind: "function" },
            { name: "combine", kind: "function" },
            { name: "left", kind: "variable" },
            { name: "right", kind: "variable" },
          ],
        },
        {
          file: "namespaces.hpp",
          symbols: [
            { name: "toolkit", kind: "class" },
            { name: "Widget", kind: "class" },
            { name: "buildWidget", kind: "function" },
            { name: "aliases", kind: "class" },
          ],
        },
        {
          file: "templates.hpp",
          symbols: [
            { name: "Holder", kind: "class" },
            { name: "Holder", kind: "function" },
            { name: "value", kind: "variable" },
            { name: "get", kind: "function" },
            { name: "value_", kind: "variable" },
            { name: "compute", kind: "function" },
            { name: "value", kind: "variable" },
            { name: "compute", kind: "function" },
            { name: "value", kind: "variable" },
          ],
        },
      ],
      references: [
        {
          name: "find references for Widget includes namespace alias usage",
          file: "namespaces.hpp",
          line: 4,
          column: 7,
          references: [
            { file: "namespaces.hpp", line: 4 },
            { file: "namespace-usage.cpp", line: 4 },
          ],
        },
      ],
    },
    absentDependencyGraph: [{ from: "module-import.cpp", to: { type: "external", name: "foo" } }],
    goToDefinition: [
      {
        name: "go to definition resolves namespace-qualified Widget alias target",
        file: "namespace-usage.cpp",
        line: 4,
        column: 12,
        expectedDefinition: { file: "namespaces.hpp", line: 4 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("C++ language boundaries", () => {
  it("identifies .h headers with C++ syntax", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-header-language-"));
    const cppHeader = path.join(root, "widget.h");
    const cHeader = path.join(root, "widget_c.h");
    try {
      await fs.writeFile(cppHeader, "namespace widgets { class Widget {}; }\n", "utf8");
      await fs.writeFile(cHeader, "struct Widget { int value; };\n", "utf8");

      expect(supportForFile(cppHeader)).toBe(CPP_SUPPORT);
      expect(supportForFile(cHeader)).toBe(C_SUPPORT);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("documents the C++20 module grammar limitation without exporting pseudo-declarations", () => {
    const source = "export module foo;\nimport foo;\n";
    const tree = parseSyntaxTree(source, "cpp");
    // The interned kind table is exactly the set of node kinds the projection produced.
    expect(tree.kinds).not.toContain("module_declaration");
    expect(tree.kinds).not.toContain("import_declaration");

    const exports = runQuery(source, "cpp", CPP_SUPPORT.queries.exports);
    const names = exports.matches.flatMap((match) =>
      match.captures.filter((capture) => capture.name === "name").map((capture) => capture.text),
    );
    expect(names).not.toContain("module");
    expect(names).not.toContain("foo");
  });
});

describe("C++ native queries", () => {
  it("captures qualified and in-class members without publishing module syntax", () => {
    const source = `
      #define FOO(x) (x)
      namespace outer::inner {}
      union U { int value; };
      class A { void f(); ~A(); A& operator+=(const A&); };
      void A::f() {}
      A::~A() {}
      A& A::operator+=(const A&) { return *this; }
      export module foo;
      import std;
      void g() { int sum = 0; }
    `;
    const names = collectCppNames("probe.cpp", source);

    expect(names.exports).toEqual(expect.arrayContaining(["FOO", "outer", "inner", "U", "f", "~A", "operator+="]));
    expect(names.exports).not.toContain("module");
    expect(names.exports).not.toContain("std");
    expect(names.exports).not.toContain("foo");
    expect(names.exports).not.toContain("sum");
    expect(names.locals).toEqual(expect.arrayContaining(["sum"]));
  });
  it("exports file-scope declarations without leaking function-local types or static variables", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-static-storage-"));
    const file = path.join(root, "exports.cpp");
    const source = [
      "static int helper;",
      "int static_count = 1;",
      "int ready() { static int once = 0; class Local {}; enum Hidden { Secret }; return once; }",
    ].join("\n");
    try {
      await fs.writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const module = index.byFile.get(fileIdentityKey(file));
      const exportedNames = module?.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []));

      expect(exportedNames?.sort()).toEqual(["ready", "static_count"]);
      expect(module?.locals.map((entry) => entry.localName)).toEqual(
        expect.arrayContaining(["Local", "Hidden", "Secret"]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("exports namespace, nested-namespace, and template declarations without leaking function-local names", () => {
    const namespaced = collectCppNames(
      "probe.cpp",
      [
        "namespace api {",
        "void nsDefined() {}",
        "void nsPrototype();",
        "int nsCounter;",
        "struct NsPair { int a; };",
        "class Widget { public: void method(); };",
        "static int hiddenHelper;",
        "namespace inner { void nestedFn(); }",
        "}",
        "namespace outer::leaf { void nestedFn17(); }",
        "template <class T> void tmplPrototype(T value);",
        "template <class T> void tmplDefined(T value) {}",
        "namespace api { template <class T> void nsTmpl(T value) {} }",
        "void container() { class Local { public: void hidden() {} }; enum Flags { HiddenFlag }; }",
      ].join("\n"),
    );

    expect(namespaced.exports).toEqual(
      expect.arrayContaining([
        "api",
        "nsDefined",
        "nsPrototype",
        "nsCounter",
        "NsPair",
        "Widget",
        "method",
        "nestedFn",
        "outer",
        "leaf",
        "nestedFn17",
        "tmplPrototype",
        "tmplDefined",
        "nsTmpl",
        "container",
      ]),
    );
    expect(namespaced.exports).not.toContain("hiddenHelper");
    expect(namespaced.exports).not.toContain("Local");
    expect(namespaced.exports).not.toContain("hidden");
    expect(namespaced.exports).not.toContain("Flags");
    expect(namespaced.exports).not.toContain("HiddenFlag");

    expect(namespaced.locals).toEqual(
      expect.arrayContaining([
        "nsDefined",
        "nsPrototype",
        "nestedFn",
        "nestedFn17",
        "tmplPrototype",
        "tmplDefined",
        "nsTmpl",
        "Local",
        "hidden",
        "Flags",
        "HiddenFlag",
      ]),
    );

    const functionLocal = collectCppNames(
      "probe.cpp",
      "void outer() { class Local { public: void hidden() {} }; enum Flags { HiddenFlag }; }",
    );
    expect(functionLocal.exports).toEqual(["outer"]);
    expect(functionLocal.locals).toEqual(expect.arrayContaining(["outer", "Local", "hidden", "Flags", "HiddenFlag"]));
    expect(functionLocal.exports).not.toContain("Local");
    expect(functionLocal.exports).not.toContain("hidden");
    expect(functionLocal.exports).not.toContain("Flags");
    expect(functionLocal.exports).not.toContain("HiddenFlag");
  });

  it("exports include-guarded declarations", () => {
    const source = "struct Pair { int a; };\nenum Mode { ON };\n#ifndef GUARD_H\nint guarded;\n#endif";
    const names = collectCppNames("probe.hpp", source);

    expect(names.exports).toEqual(expect.arrayContaining(["Pair", "Mode", "ON", "guarded"]));
    expect(names.exports.filter((name) => name === "guarded")).toEqual(["guarded"]);
    expect(names.locals).toEqual(expect.arrayContaining(["Pair", "Mode", "ON", "guarded"]));
    expect(names.exports).not.toContain("a");
  });

  it("exports a C++ enum name once", () => {
    const names = collectCppNames("probe.hpp", "enum Mode { ON };");

    expect(names.exports.filter((name) => name === "Mode")).toEqual(["Mode"]);
    expect(names.exports).toEqual(expect.arrayContaining(["Mode", "ON"]));
    expect(names.locals).toEqual(expect.arrayContaining(["Mode", "ON"]));
  });
});

describe("C++ classification and same-file navigation", () => {
  it("classifies nested namespaces and unions, and resolves concepts and macros", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-classify-"));
    const file = path.join(root, "probe.cpp");
    const source = [
      "namespace outer::leaf {}",
      "union U { int a; };",
      "template<typename T>",
      "concept Sortable = true;",
      "template<Sortable T>",
      "void sort(T);",
      "#define FOO 1",
      "int x = FOO;",
      "// FOO comment",
      "int y = 0;",
      "#define BAR(x) (x)",
      "int z = BAR(1);",
      "U value;",
      "",
    ].join("\n");
    try {
      await fs.writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const symbols = listSymbols(index, { file });
      const symbolAt = (name: string, line: number) =>
        symbols.find((symbol) => symbol.name === name && symbol.range?.start.line === line);

      expect(symbolAt("outer", 1)?.kind).toBe("class");
      expect(symbolAt("leaf", 1)?.kind).toBe("class");
      expect(symbolAt("U", 2)?.kind).toBe("class");
      expect(symbols.filter((symbol) => symbol.name === "FOO" && symbol.range?.start.line === 9)).toEqual([]);

      const conceptGoto = await goToDefinition(index, { file, line: 5, column: 10 });
      expect(conceptGoto.status).toBe("ok");
      if (conceptGoto.status === "ok") {
        expect(conceptGoto.definition.range.start.line).toBe(4);
        expect(conceptGoto.definition.range.start.column).toBe(9);
      }

      const conceptRefs = await findReferences(index, { file, line: 5, column: 10 });
      expect(conceptRefs.status).toBe("ok");
      if (conceptRefs.status === "ok") {
        expect(
          conceptRefs.references.map((reference) => ({
            line: reference.range.start.line,
            column: reference.range.start.column,
          })),
        ).toEqual(
          expect.arrayContaining([
            { line: 4, column: 9 },
            { line: 5, column: 10 },
          ]),
        );
      }

      const macroGoto = await goToDefinition(index, { file, line: 8, column: 9 });
      expect(macroGoto.status).toBe("ok");
      if (macroGoto.status === "ok") {
        expect(macroGoto.definition.range.start.line).toBe(7);
        expect(macroGoto.definition.range.start.column).toBe(9);
      }

      const functionMacroGoto = await goToDefinition(index, { file, line: 12, column: 9 });
      expect(functionMacroGoto.status).toBe("ok");
      if (functionMacroGoto.status === "ok") {
        expect(functionMacroGoto.definition.range.start.line).toBe(11);
        expect(functionMacroGoto.definition.range.start.column).toBe(9);
      }

      const commentGoto = await goToDefinition(index, { file, line: 9, column: 4 });
      expect(commentGoto.status).toBe("not_found");

      const macroRefs = await findReferences(index, { file, line: 8, column: 9 });
      expect(macroRefs.status).toBe("ok");
      if (macroRefs.status === "ok") {
        const sites = macroRefs.references.map((reference) => ({
          line: reference.range.start.line,
          column: reference.range.start.column,
        }));
        expect(sites).toEqual(
          expect.arrayContaining([
            { line: 7, column: 9 },
            { line: 8, column: 9 },
          ]),
        );
        expect(sites.some((site) => site.line === 9)).toBe(false);
      }

      const unionGoto = await goToDefinition(index, { file, line: 13, column: 1 });
      expect(unionGoto.status).toBe("ok");
      if (unionGoto.status === "ok") {
        expect(unionGoto.definition.range.start.line).toBe(2);
        expect(unionGoto.definition.range.start.column).toBe(7);
      }

      const unionRefs = await findReferences(index, { file, line: 13, column: 1 });
      expect(unionRefs.status).toBe("ok");
      if (unionRefs.status === "ok") {
        expect(
          unionRefs.references.map((reference) => ({
            line: reference.range.start.line,
            column: reference.range.start.column,
          })),
        ).toEqual(
          expect.arrayContaining([
            { line: 2, column: 7 },
            { line: 13, column: 1 },
          ]),
        );
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("C++ configured include roots", () => {
  it("loads Gunship-shaped resolution hints and ranks linked and changed tests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-gunship-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-outside-"));
    const privateRoot = path.join(root, "Source", "Gunship", "Private");
    const model = path.join(privateRoot, "Damage", "Simulation", "GunshipDamageModel.h");
    const test = path.join(privateRoot, "Damage", "Tests", "DamageModelTests.cpp");
    const escapingTest = path.join(privateRoot, "Damage", "Tests", "EscapingHintTests.cpp");
    const outsideHeader = path.join(outside, "Secret.h");
    try {
      await fs.mkdir(path.dirname(model), { recursive: true });
      await fs.mkdir(path.dirname(test), { recursive: true });
      await fs.writeFile(model, "class GunshipDamageModel {};\n", "utf8");
      await fs.writeFile(test, '#include "Damage/Simulation/GunshipDamageModel.h"\nGunshipDamageModel model;\n');
      await fs.writeFile(escapingTest, '#include "Secret.h"\n', "utf8");
      await fs.writeFile(outsideHeader, "class Secret {};\n", "utf8");
      await fs.writeFile(
        path.join(root, "codegraph.config.json"),
        JSON.stringify({
          graph: {
            resolutionHints: ["Source/Gunship/Private", `../${path.basename(outside)}`],
          },
        }),
        "utf8",
      );

      const snapshot = await createAgentSession({
        root,
        buildOptions: { cache: "memory" },
      }).loadProject({ symbolGraph: "skip" });
      const normalizedModel = normalizePath(model);
      const normalizedTest = normalizePath(test);
      const normalizedOutside = normalizePath(outsideHeader);

      expect(snapshot.fileGraph.edges).toContainEqual(
        expect.objectContaining({
          from: normalizedTest,
          to: { type: "file", path: normalizedModel },
        }),
      );
      expect(
        snapshot.fileGraph.edges.some((edge) => edge.to.type === "file" && edge.to.path === normalizedOutside),
      ).toBe(false);

      expect(listCandidateTestFiles(snapshot.index, [normalizedTest], [], { projectRoot: root })).toContainEqual({
        file: normalizedTest,
        confidence: "high",
        reason: "changedTest",
      });
      expect(
        listCandidateTestFiles(snapshot.index, [normalizedModel], [`${normalizedModel}::GunshipDamageModel::0`], {
          projectRoot: root,
        }),
      ).toContainEqual({
        file: normalizedTest,
        confidence: "high",
        reason: "importsChanged",
      });

      // Drop the cached adjacency along with the edges; keeping it would let the
      // full-graph adjacency answer queries this sparse index is meant to lack.
      const { graphAdjacency: _graphAdjacency, ...baseIndex } = snapshot.index;
      const sparseIndex = {
        ...baseIndex,
        graph: { ...snapshot.index.graph, edges: [] },
      };
      expect(
        listCandidateTestFiles(sparseIndex, [normalizedModel], [`${normalizedModel}::GunshipDamageModel::0`], {
          projectRoot: root,
        }),
      ).toContainEqual({
        file: normalizedTest,
        confidence: "high",
        reason: "symbolReference",
      });
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});

describe("C++ Unicode symbol ranges (C11)", () => {
  it("publishes a UTF-16 string index for a function name preceded by multibyte text", async () => {
    await expectUnicodeSymbolRangeIdentity({
      fileName: "widget.cpp",
      source: "// café ☕ prüfung\n/* über */ int créer() {\n\treturn 1;\n}\n",
      symbolName: "créer",
    });
  });
});
