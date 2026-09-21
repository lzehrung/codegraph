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
import { C_SUPPORT, CPP_SUPPORT, supportForFile, supportForFileWithSource } from "../../src/languages.js";
import { parseSyntaxTree, runQuery } from "@lzehrung/codegraph-native";
import { collectLocalsAndExportsFromSource } from "../../src/indexer/locals-and-exports.js";
import { getNativeQueryExecution } from "../../src/native/tree-sitter-native.js";
import type { LanguageSupport } from "../../src/languages.js";
import { buildProjectIndex, buildScopeIndexFromSource, findReferences, goToDefinition, listSymbols } from "../../src/index.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { fileIdentityKey } from "../../src/util/paths.js";

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
        {
          from: "module-import.cpp",
          to: { type: "file", path: "module-import.cpp" },
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
    const commentHeader = path.join(root, "comment.h");
    const usingHeader = path.join(root, "using.h");
    try {
      await fs.writeFile(cppHeader, "namespace widgets { class Widget {}; }\n", "utf8");
      await fs.writeFile(cHeader, "struct Widget { int value; };\n", "utf8");
      await fs.writeFile(
        commentHeader,
        "/* This is a template for the audio driver. */ struct S { int x; };\n",
        "utf8",
      );
      await fs.writeFile(usingHeader, "using Foo = int;\n", "utf8");

      expect(supportForFile(cppHeader)).toBe(CPP_SUPPORT);
      expect(supportForFile(cHeader)).toBe(C_SUPPORT);
      expect(supportForFile(commentHeader)).toBe(C_SUPPORT);
      expect(supportForFile(usingHeader)).toBe(CPP_SUPPORT);
      expect(supportForFileWithSource("qualified.h", "void Widget::bar();\n")).toBe(CPP_SUPPORT);
      expect(supportForFileWithSource("constexpr.h", "constexpr int k = 1;\n")).toBe(CPP_SUPPORT);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("indexes C++20 module declarations without exporting the module keyword", () => {
    const source = "export module foo;\nimport foo;\n";
    const tree = parseSyntaxTree(source, "cpp");
    // The interned kind table is exactly the set of node kinds the projection produced.
    expect(tree.kinds).toContain("module_declaration");
    expect(tree.kinds).toContain("import_declaration");

    const exports = runQuery(source, "cpp", CPP_SUPPORT.queries.exports);
    const names = exports.matches.flatMap((match) =>
      match.captures.filter((capture) => capture.name === "name").map((capture) => capture.text),
    );
    expect(names).toContain("foo");
    expect(names).not.toContain("module");
  });
});

describe("C++ native queries", () => {
  it("captures qualified and in-class members and the module name without keyword tokens", () => {
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

    expect(names.exports).toEqual(
      expect.arrayContaining(["FOO", "outer", "inner", "U", "f", "~A", "operator+=", "foo"]),
    );
    expect(names.exports).not.toContain("module");
    expect(names.exports).not.toContain("std");
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

  it("exports class and struct types while hiding file-scope static functions and in-class members", () => {
    const names = collectCppNames(
      "probe.cpp",
      [
        "static int helper() { return 0; }",
        "int visible() { return 1; }",
        "class Foo { public: static int member; static int method(); };",
        "struct Bar { static int field; };",
      ].join("\n"),
    );

    expect(names.exports).toEqual(expect.arrayContaining(["visible", "Foo", "Bar"]));
    expect(names.exports).not.toContain("helper");
    expect(names.exports).not.toContain("method");
    expect(names.exports).not.toContain("member");
    expect(names.exports).not.toContain("field");
    expect(names.locals).toEqual(
      expect.arrayContaining(["helper", "visible", "Foo", "member", "method", "Bar", "field"]),
    );
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
    expect(namespaced.exports).not.toContain("method");
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

  it("keeps in-class members local while types, free functions, and out-of-line definitions stay exported", () => {
    const inClass = collectCppNames(
      "widget.cpp",
      ["class Widget { int field_; void method(); };", "void ready() { return; }", "struct Point { int x; };"].join(
        "\n",
      ),
    );
    expect(inClass.exports.sort()).toEqual(["Point", "Widget", "ready"]);
    expect(inClass.exports).not.toContain("field_");
    expect(inClass.exports).not.toContain("method");
    expect(inClass.exports).not.toContain("x");
    expect(inClass.locals).toEqual(expect.arrayContaining(["Widget", "field_", "method", "ready", "Point", "x"]));

    const namespaced = collectCppNames(
      "probe.cpp",
      [
        "namespace api { void nsFn(); class Widget { void method(); }; }",
        "template <class T> class Holder { void get(); };",
        "template <class T> void compute(T value) {}",
        "struct Outer { struct Inner { int x; }; };",
      ].join("\n"),
    );
    expect(namespaced.exports).toEqual(expect.arrayContaining(["api", "nsFn", "Widget", "Holder", "compute", "Outer"]));
    expect(namespaced.exports).not.toContain("method");
    expect(namespaced.exports).not.toContain("get");
    expect(namespaced.exports).not.toContain("Inner");
    expect(namespaced.exports).not.toContain("x");
    expect(namespaced.locals).toEqual(expect.arrayContaining(["method", "get", "Inner", "x"]));

    const outlined = collectCppNames("probe.cpp", "class Widget { void method(); };\nvoid Widget::method() {}\n");
    expect(outlined.exports).toEqual(expect.arrayContaining(["Widget", "method"]));
    expect(outlined.locals).toEqual(expect.arrayContaining(["Widget", "method"]));
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

describe("C++ quoted include resolution", () => {
  it("resolves bare and subdirectory quoted includes while preserving explicit and angle forms", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-quoted-includes-"));
    const siblingHeader = path.join(root, "lib.h");
    const nestedHeader = path.join(root, "inc", "lib.h");
    const bareFile = path.join(root, "main-bare.cpp");
    const nestedFile = path.join(root, "main-subdirectory.cpp");
    const relativeFile = path.join(root, "main-relative.cpp");
    const angleFile = path.join(root, "main-angle.cpp");
    const bareSource = '#include "lib.h"\nint main() { return helper(1); }\n';
    const nestedSource = '#include "inc/lib.h"\nint main() { return nested_helper(1); }\n';
    const relativeSource = '#include "./lib.h"\nint main() { return helper(1); }\n';
    try {
      await fs.mkdir(path.dirname(nestedHeader), { recursive: true });
      await Promise.all([
        fs.writeFile(siblingHeader, "int helper(int a);\n", "utf8"),
        fs.writeFile(nestedHeader, "int nested_helper(int a);\n", "utf8"),
        fs.writeFile(bareFile, bareSource, "utf8"),
        fs.writeFile(nestedFile, nestedSource, "utf8"),
        fs.writeFile(relativeFile, relativeSource, "utf8"),
        fs.writeFile(angleFile, "#include <lib.h>\nint main() { return 0; }\n", "utf8"),
      ]);

      const index = await buildProjectIndex(root, { cache: "off" });
      const importTarget = (file: string) => index.byFile.get(fileIdentityKey(file))?.imports[0]?.resolved;

      expect(importTarget(bareFile)).toBe(normalizePath(siblingHeader));
      expect(importTarget(nestedFile)).toBe(normalizePath(nestedHeader));
      expect(importTarget(relativeFile)).toBe(normalizePath(siblingHeader));
      expect(importTarget(angleFile)).toEqual({ external: "<lib.h>" });

      const bareCallColumn = bareSource.split("\n")[1]!.indexOf("helper") + 1;
      const bareGoto = await goToDefinition(index, { file: bareFile, line: 2, column: bareCallColumn });
      expect(bareGoto.status).toBe("ok");
      if (bareGoto.status === "ok") {
        expect(bareGoto.definition.file).toBe(normalizePath(siblingHeader));
        expect(bareGoto.definition.range.start.line).toBe(1);
      }

      const siblingRefs = await findReferences(index, { file: siblingHeader, line: 1, column: 5 });
      expect(siblingRefs.status).toBe("ok");
      if (siblingRefs.status === "ok") {
        expect(
          siblingRefs.references.map((reference) => ({
            file: normalizePath(reference.file),
            line: reference.range.start.line,
            column: reference.range.start.column,
          })),
        ).toEqual(
          expect.arrayContaining([
            { file: normalizePath(siblingHeader), line: 1, column: 5 },
            { file: normalizePath(bareFile), line: 2, column: bareCallColumn },
          ]),
        );
      }

      const nestedCallColumn = nestedSource.split("\n")[1]!.indexOf("nested_helper") + 1;
      const nestedGoto = await goToDefinition(index, { file: nestedFile, line: 2, column: nestedCallColumn });
      expect(nestedGoto.status).toBe("ok");
      if (nestedGoto.status === "ok") {
        expect(nestedGoto.definition.file).toBe(normalizePath(nestedHeader));
        expect(nestedGoto.definition.range.start.line).toBe(1);
      }

      const nestedRefs = await findReferences(index, { file: nestedHeader, line: 1, column: 5 });
      expect(nestedRefs.status).toBe("ok");
      if (nestedRefs.status === "ok") {
        expect(
          nestedRefs.references.map((reference) => ({
            file: normalizePath(reference.file),
            line: reference.range.start.line,
            column: reference.range.start.column,
          })),
        ).toEqual(
          expect.arrayContaining([
            { file: normalizePath(nestedHeader), line: 1, column: 5 },
            { file: normalizePath(nestedFile), line: 2, column: nestedCallColumn },
          ]),
        );
      }

      const relativeCallColumn = relativeSource.split("\n")[1]!.indexOf("helper") + 1;
      const relativeGoto = await goToDefinition(index, { file: relativeFile, line: 2, column: relativeCallColumn });
      expect(relativeGoto.status).toBe("ok");
      if (relativeGoto.status === "ok") {
        expect(relativeGoto.definition.file).toBe(normalizePath(siblingHeader));
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("attaches C++ free, in-class, and out-of-line member calls exactly once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-same-file-refs-"));
    const file = path.join(root, "main.cpp");
    const source = [
      "int free_helper() { return 1; }",
      "int use_free() { return free_helper(); }",
      "",
      "class A {",
      "public:",
      "  int member() { return 2; }",
      "  int use_member() { return this->member(); }",
      "  static void f();",
      "};",
      "void A::f() {}",
      "int use_f() { A::f(); return 0; }",
      "",
    ].join("\n");
    try {
      await fs.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const scope = buildScopeIndexFromSource(file, source, CPP_SUPPORT);
      const functionBindings = scope.all.filter((binding) => binding.kind === "function");
      const functionDefinitionIndexes = functionBindings.map((binding) => binding.def?.start.index);
      expect(
        functionDefinitionIndexes.filter(
          (definitionIndex, index) => functionDefinitionIndexes.indexOf(definitionIndex) !== index,
        ),
      ).toEqual([]);
      expect(
        functionBindings.filter(
          (binding) => binding.def?.start.index === source.indexOf("A::f") + "A::".length,
        ),
      ).toHaveLength(1);

      const freeCallColumn = source.split("\n")[1]!.indexOf("free_helper") + 1;
      const freeRefs = await findReferences(index, { file, line: 1, column: 5 });
      expect(freeRefs.status).toBe("ok");
      if (freeRefs.status === "ok") {
        expect(
          freeRefs.references.map((reference) => ({
            line: reference.range.start.line,
            column: reference.range.start.column,
          })),
        ).toEqual([
          { line: 1, column: 5 },
          { line: 2, column: freeCallColumn },
        ]);
      }

      const memberDefinition = source.split("\n")[5]!;
      const memberCallColumn = source.split("\n")[6]!.lastIndexOf("member") + 1;
      const memberRefs = await findReferences(index, {
        file,
        line: 6,
        column: memberDefinition.indexOf("member") + 1,
      });
      expect(memberRefs.status).toBe("ok");
      if (memberRefs.status === "ok") {
        expect(
          memberRefs.references.map((reference) => ({
            line: reference.range.start.line,
            column: reference.range.start.column,
          })),
        ).toEqual(
          expect.arrayContaining([
            { line: 6, column: memberDefinition.indexOf("member") + 1 },
            { line: 7, column: memberCallColumn },
          ]),
        );
      }

      const outOfLineDefinition = source.split("\n")[9]!;
      const outOfLineRefs = await findReferences(index, {
        file,
        line: 10,
        column: outOfLineDefinition.lastIndexOf("f") + 1,
      });
      expect(outOfLineRefs.status).toBe("ok");
      if (outOfLineRefs.status === "ok") {
        expect(
          outOfLineRefs.references.map((reference) => reference.range.start.line),
        ).toEqual(expect.arrayContaining([10, 11]));
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

describe("C++20 modules", () => {
  it("resolves import widget without resolutionHints and keeps import std external", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-modules-no-hints-"));
    const declaring = path.join(root, "widget.cpp");
    const importing = path.join(root, "main.cpp");
    try {
      await fs.writeFile(declaring, "export module widget;\n", "utf8");
      await fs.writeFile(importing, "import widget;\nimport std;\n", "utf8");

      const index = await createTestIndexFromFiles(root, [declaring, importing]);
      const fromMain = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(importing));

      expect(fromMain).toContainEqual(
        expect.objectContaining({
          from: importing.replace(/\\/g, "/"),
          to: { type: "file", path: declaring.replace(/\\/g, "/") },
        }),
      );
      expect(fromMain).toContainEqual(
        expect.objectContaining({
          from: importing.replace(/\\/g, "/"),
          to: { type: "external", name: "std" },
        }),
      );
      expect(fromMain.some((edge) => edge.to.type === "external" && edge.to.name === "widget")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("leaves a module declared in two files unresolved", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-modules-split-"));
    const first = path.join(root, "alpha.cpp");
    const second = path.join(root, "beta.cpp");
    const importing = path.join(root, "main.cpp");
    try {
      await fs.writeFile(first, "export module shared;\n", "utf8");
      await fs.writeFile(second, "export module shared;\n", "utf8");
      await fs.writeFile(importing, "import shared;\n", "utf8");

      const index = await createTestIndexFromFiles(root, [first, second, importing]);
      const fromMain = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(importing));

      expect(fromMain.map((edge) => edge.to)).toEqual([{ type: "external", name: "shared" }]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("indexes a module declaration and binds first-party imports without treating std as in-repo", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-modules-"));
    const declaring = path.join(root, "foo.cpp");
    const importing = path.join(root, "user.cpp");
    try {
      await fs.writeFile(declaring, "export module foo;\n", "utf8");
      await fs.writeFile(importing, "import foo;\nimport std;\n", "utf8");
      await fs.writeFile(
        path.join(root, "codegraph.config.json"),
        JSON.stringify({
          graph: {
            resolutionHints: ["."],
          },
        }),
        "utf8",
      );

      const snapshot = await createAgentSession({
        root,
        buildOptions: { cache: "memory" },
      }).loadProject();
      const normalizedDeclaring = normalizePath(declaring);
      const normalizedImporting = normalizePath(importing);
      const symbols = listSymbols(snapshot.index, { file: declaring });

      expect(symbols).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "foo",
            kind: "class",
          }),
        ]),
      );
      expect(snapshot.fileGraph.edges).toContainEqual(
        expect.objectContaining({
          from: normalizedImporting,
          to: { type: "file", path: normalizedDeclaring },
        }),
      );
      expect(snapshot.fileGraph.edges).toContainEqual(
        expect.objectContaining({
          from: normalizedImporting,
          to: { type: "external", name: "std" },
        }),
      );
      expect(snapshot.fileGraph.edges.some((edge) => edge.to.type === "external" && edge.to.name === "foo")).toBe(
        false,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a module declared in a module-interface file extension", async () => {
    for (const extension of [".cppm", ".ixx", ".mxx"]) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-modules-interface-ext-"));
      try {
        const declaring = path.join(root, `widget${extension}`);
        const importing = path.join(root, "main.cpp");
        await fs.writeFile(declaring, "export module widget;\n", "utf8");
        await fs.writeFile(importing, "import widget;\n", "utf8");

        const index = await createTestIndexFromFiles(root, [declaring, importing]);
        const fromMain = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(importing));

        expect(fromMain, extension).toContainEqual(
          expect.objectContaining({
            from: importing.replace(/\\/g, "/"),
            to: { type: "file", path: declaring.replace(/\\/g, "/") },
          }),
        );
        expect(
          fromMain.some((edge) => edge.to.type === "external" && edge.to.name === "widget"),
          extension,
        ).toBe(false);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("keeps a named module import external when only an unindexed extension declares it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-modules-unindexed-ext-"));
    const declaring = path.join(root, "widget.txt");
    const importing = path.join(root, "main.cpp");
    try {
      await fs.writeFile(declaring, "export module widget;\n", "utf8");
      await fs.writeFile(importing, "import widget;\n", "utf8");

      const index = await createTestIndexFromFiles(root, [declaring, importing]);
      const fromMain = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(importing));

      expect(fromMain.map((edge) => edge.to)).toEqual([{ type: "external", name: "widget" }]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
