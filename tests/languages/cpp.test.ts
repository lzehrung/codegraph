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
import { defNodeId } from "../../src/graphs/symbol-graph.js";
import { parseSyntaxTree, runQuery } from "@lzehrung/codegraph-native";
import { closeDiskCacheDatabase } from "../../src/indexer/build-cache/module-cache.js";
import { cppSelectCallableBinding } from "../../src/indexer/cpp-callables.js";
import { collectLocalsAndExportsFromSource } from "../../src/indexer/locals-and-exports.js";
import { ProjectedSyntaxTree } from "../../src/native/projected-tree.js";
import { getNativeQueryExecution, getNativeSyntaxTreeExecution } from "../../src/native/tree-sitter-native.js";
import type { LanguageSupport } from "../../src/languages.js";
import {
  buildProjectIndex,
  type BuildReport,
  buildProjectIndexIncremental,
  buildScopeIndexFromSource,
  buildSymbolGraph,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  goToDefinitionById,
  listSymbols,
  queryWorkspaceSymbols,
} from "../../src/index.js";
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
      expect.arrayContaining(["FOO", "outer", "outer::inner", "U", "A::f", "A::~A", "A::operator+=", "foo"]),
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
      "namespace tools { int scoped_run(); }",
      "void local_alias() { using tools::scoped_run; }",
    ].join("\n");
    try {
      await fs.writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const module = index.byFile.get(fileIdentityKey(file));
      const exportedNames = module?.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []));

      expect(exportedNames?.sort()).toEqual(["local_alias", "ready", "static_count", "tools", "tools::scoped_run"]);
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
        "api::nsDefined",
        "api::nsPrototype",
        "api::nsCounter",
        "api::NsPair",
        "api::Widget",
        "api::inner::nestedFn",
        "outer",
        "outer::leaf",
        "outer::leaf::nestedFn17",
        "tmplPrototype",
        "tmplDefined",
        "api::nsTmpl",
        "container",
      ]),
    );
    expect(
      namespaced.exports.filter((name) => ["nsDefined", "nsPrototype", "nestedFn", "nestedFn17"].includes(name)),
    ).toEqual([]);
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
    expect(namespaced.exports).toEqual(
      expect.arrayContaining(["api", "api::nsFn", "api::Widget", "Holder", "compute", "Outer"]),
    );
    expect(namespaced.exports).not.toContain("method");
    expect(namespaced.exports).not.toContain("get");
    expect(namespaced.exports).not.toContain("Inner");
    expect(namespaced.exports).not.toContain("x");
    expect(namespaced.locals).toEqual(expect.arrayContaining(["method", "get", "Inner", "x"]));

    const outlined = collectCppNames("probe.cpp", "class Widget { void method(); };\nvoid Widget::method() {}\n");
    expect(outlined.exports).toEqual(expect.arrayContaining(["Widget", "Widget::method"]));
    expect(outlined.locals).toEqual(expect.arrayContaining(["Widget", "method"]));
  });
});

describe("C++ classification and same-file navigation", () => {
  it("does not confuse an included overload declaration with a same-span call in another file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-cross-file-callable-"));
    const header = path.join(root, "api.hpp");
    const file = path.join(root, "use.cpp");
    const callLine = "int caller() { return pick(1); }";
    const useBase = [`#include "api.hpp"`, callLine, ""].join("\n");
    const headerPrefix = " ".repeat(useBase.indexOf("pick") - "int ".length);
    const headerSource = [`${headerPrefix}int pick(int, int);`, "int pick(int);", ""].join("\n");
    const useSource = useBase.padEnd(headerSource.length, " ");
    const callOffset = useSource.indexOf("pick");
    expect(callOffset).toBe(headerSource.indexOf("pick"));
    expect(useSource.length).toBe(headerSource.length);
    try {
      await fs.writeFile(header, headerSource, "utf8");
      await fs.writeFile(file, useSource, "utf8");
      const bindings = buildScopeIndexFromSource(header, headerSource, CPP_SUPPORT).all.filter(
        (binding) => binding.kind === "function" && binding.name === "pick",
      );
      const parsed = getNativeSyntaxTreeExecution(useSource, CPP_SUPPORT, "on");
      if (!parsed.tree) throw new Error("Expected a native C++ syntax tree");
      const call = new ProjectedSyntaxTree(useSource, parsed.tree).rootNode.descendantForIndex(
        callOffset,
        callOffset + "pick".length,
      );
      expect(call.text).toBe("pick");
      expect(cppSelectCallableBinding(bindings, call, useSource, file, header)?.def?.start.line).toBe(2);

      const index = await createTestIndexFromFiles(root, [header, file]);
      const navigation = await goToDefinition(index, { file, line: 2, column: callLine.indexOf("pick") + 1 });
      expect(navigation.status).toBe("ok");
      if (navigation.status !== "ok") throw new Error("Expected the one-argument overload");
      expect(navigation.definition.range.start.line).toBe(2);
      expect(fileIdentityKey(navigation.definition.file)).toBe(fileIdentityKey(header));
      const references = await findReferences(index, { file: header, line: 2, column: 5 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.references.map((ref) => [fileIdentityKey(ref.file), ref.range.start.line])).toEqual([
          [fileIdentityKey(header), 2],
          [fileIdentityKey(file), 2],
        ]);
      }
      const otherReferences = await findReferences(index, { file: header, line: 1, column: headerPrefix.length + 5 });
      expect(otherReferences.status).toBe("ok");
      if (otherReferences.status === "ok") {
        expect(otherReferences.references.map((ref) => [fileIdentityKey(ref.file), ref.range.start.line])).toEqual([
          [fileIdentityKey(header), 1],
        ]);
      }
      const graph = await buildSymbolGraphDetailed(index);
      expect(
        graph.edges
          .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "caller")
          .map((edge) => edge.to),
      ).toEqual([defNodeId(navigation.definition)]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps callable identity consistent across navigation, references, and calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-callable-identity-"));
    const file = path.join(root, "probe.cpp");
    const lines = [
      "int pointer(int*);",
      "int pointer(int* value) { return 1; }",
      "int use_pointer() { return pointer(nullptr); }",
      "int reference(int& value);",
      "int reference(int&& value);",
      "int use_reference(int& value) { return reference(value); }",
      "namespace tools { int run(); int run() { return 1; } }",
      "namespace alias { using tools::run; }",
      "int via_alias() { return alias::run(); }",
    ];
    try {
      await fs.writeFile(file, lines.join("\n"), "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const pointer = await goToDefinition(index, {
        file,
        line: 3,
        column: lines[2]!.lastIndexOf("pointer") + 1,
      });
      expect(pointer.status).toBe("ok");
      if (pointer.status !== "ok") throw new Error("Expected the pointer function definition");
      expect(pointer.definition.range.start.line).toBe(2);
      for (const [line, expectedLines] of [
        [1, [1, 2, 3]],
        [4, [4]],
        [5, [5]],
      ] as const) {
        const refs = await findReferences(index, { file, line, column: 5 });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") throw new Error("Expected C++ declaration references");
        expect(refs.references.map((reference) => reference.range.start.line)).toEqual(expectedLines);
      }
      const alias = await goToDefinition(index, { file, line: 9, column: lines[8]!.indexOf("run") + 1 });
      expect(alias.status).toBe("ok");
      if (alias.status !== "ok") throw new Error("Expected the aliased callable definition");
      expect(alias.definition.range.start.line).toBe(7);
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      expect(nodes.filter((node) => node.name === "pointer")).toHaveLength(1);
      expect(nodes.filter((node) => node.name === "reference")).toHaveLength(2);
      expect(
        graph.edges
          .filter((edge) => edge.label === "calls")
          .map((edge) => [graph.nodes.get(edge.from)?.name, graph.nodes.get(edge.to)?.name]),
      ).toEqual([
        ["use_pointer", "pointer"],
        ["via_alias", "run"],
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("keeps internal-linkage callable keys file-local and external declarations equivalent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-internal-keys-"));
    const movedRoot = `${root}-moved`;
    const sources = {
      "api.hpp": "int run();\n",
      "a.cpp": [
        '#include "api.hpp"',
        "int run() { return 1; }",
        "static int local() { return 2; }",
        "namespace { int hidden() { return 3; } }",
        "namespace tools { namespace { int nested() { return 4; } } }",
        "namespace tools { static int scoped() { return 5; } }",
      ].join("\n"),
      "b.cpp": [
        "static int run() { return 10; }",
        "static int local() { return 20; }",
        "namespace { int hidden() { return 30; } }",
        "namespace tools { namespace { int nested() { return 40; } } }",
        "namespace tools { static int scoped() { return 50; } }",
      ].join("\n"),
    };
    try {
      for (const [name, source] of Object.entries(sources)) {
        await fs.writeFile(path.join(root, name), source, "utf8");
      }
      const index = await buildProjectIndex(root, { cache: "disk", native: "on" });
      const key = (name: keyof typeof sources, symbol: string, projectIndex = index, projectRoot = root): string => {
        const callable = projectIndex.byFile
          .get(fileIdentityKey(path.join(projectRoot, name)))
          ?.locals.find((local) => local.localName === symbol && local.callable?.signature)?.callable;
        expect(callable).toBeDefined();
        return callable!.key;
      };
      expect(key("api.hpp", "run")).toBe(key("a.cpp", "run"));
      expect(key("api.hpp", "run")).not.toBe(key("b.cpp", "run"));
      for (const name of ["local", "hidden", "nested", "scoped"] as const) {
        expect(key("a.cpp", name)).not.toBe(key("b.cpp", name));
      }
      closeDiskCacheDatabase(root, { cache: "disk" });
      await fs.cp(root, movedRoot, { recursive: true });
      const report: BuildReport = { timings: {} };
      const warm = await buildProjectIndexIncremental(movedRoot, { cache: "disk", native: "on", report });
      expect(report.cache?.misses ?? 0).toBe(0);
      expect(key("api.hpp", "run", warm, movedRoot)).toBe(key("a.cpp", "run", warm, movedRoot));
      for (const name of ["run", "local", "hidden", "nested", "scoped"] as const) {
        const warmKey = key("b.cpp", name, warm, movedRoot);
        expect(warmKey).not.toBe(key("a.cpp", name, warm, movedRoot));
        expect(warmKey).not.toContain(normalizePath(root) + "/");
      }
    } finally {
      closeDiskCacheDatabase(root, { cache: "disk" });
      closeDiskCacheDatabase(movedRoot, { cache: "disk" });
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(movedRoot, { recursive: true, force: true });
    }
  });

  it("keeps a static prototype and its definition without static as one internal callable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-static-prototype-"));
    const lines = ["static int run();", "int run() { return 1; }", "int use() { return run(); }"];
    const decoy = "int run() { return 2; }\n";
    try {
      const file = path.join(root, "a.cpp");
      await fs.writeFile(file, lines.join("\n"), "utf8");
      await fs.writeFile(path.join(root, "b.cpp"), decoy, "utf8");
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const keys = (name: string) =>
        index.byFile
          .get(fileIdentityKey(path.join(root, name)))
          ?.locals.filter((local) => local.localName === "run" && local.callable?.signature)
          .map((local) => local.callable!.key) ?? [];
      const [prototypeKey, definitionKey] = keys("a.cpp");
      expect(keys("a.cpp")).toHaveLength(2);
      expect(prototypeKey).toBe(definitionKey);
      expect(keys("b.cpp")).not.toContain(prototypeKey);

      // References first: the scope it caches must carry the same propagated keys navigation uses.
      const references = await findReferences(index, { file, line: 1, column: lines[0]!.indexOf("run") + 1 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.references.map((ref) => [path.basename(ref.file), ref.range.start.line])).toEqual([
          ["a.cpp", 1],
          ["a.cpp", 2],
          ["a.cpp", 3],
        ]);
      }
      const navigation = await goToDefinition(index, { file, line: 3, column: lines[2]!.lastIndexOf("run") + 1 });
      expect(navigation.status).toBe("ok");
      if (navigation.status !== "ok") throw new Error("Expected the internal definition");
      expect([fileIdentityKey(navigation.definition.file), navigation.definition.range.start.line]).toEqual([
        fileIdentityKey(file),
        2,
      ]);
      // Equivalent declarations share one graph node: the prototype, which the definition aliases.
      const graph = await buildSymbolGraphDetailed(index);
      const runNodes = [...graph.nodes.values()].filter(
        (node) => node.name === "run" && fileIdentityKey(node.file) === fileIdentityKey(file),
      );
      expect(runNodes).toHaveLength(1);
      expect(runNodes[0]!.id.endsWith(`::run::${lines[0]!.indexOf("run")}`)).toBe(true);
      expect(
        graph.edges
          .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "use")
          .map((edge) => edge.to),
      ).toEqual([runNodes[0]!.id]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps adjusted parameter shapes on one C++ callable identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-adjusted-identity-"));
    const file = path.join(root, "probe.cpp");
    const lines = [
      "int pick(int values[]);",
      "int pick(int* values) { return values ? 1 : 0; }",
      "int relay(void handler(int));",
      "int relay(void (*handler)(int)) { return handler ? 1 : 0; }",
      "int total(const int sum);",
      "int total(int sum) { return sum; }",
      "int exact(const int* values);",
      "int exact(int* values) { return values ? 1 : 0; }",
      "int bind(int& value);",
      "int bind(int* value) { return value ? 1 : 0; }",
      "void paint(int tiles[][3]);",
      "void paint(int* tiles) { }",
      "int use_pick(int* buf) { return pick(buf); }",
      "int use_relay() { return relay(nullptr); }",
      "int use_total() { return total(3); }",
      "int use_exact(int* buf) { return exact(buf); }",
      "int use_bind(int boxed) { return bind(boxed); }",
      "int use_paint() { paint(nullptr); return 0; }",
      "int empty(int callback(void));",
      "int empty(int (*callback)()) { return callback ? 1 : 0; }",
      "int use_empty() { return empty(nullptr); }",
      "int grid(int tiles[][3]);",
      "int grid(int (*tiles)[3]) { return tiles ? 1 : 0; }",
      "int use_grid() { return grid(nullptr); }",
      "int hold(int* const value);",
      "int hold(int* value) { return value ? 1 : 0; }",
      "int use_hold() { return hold(nullptr); }",
      "using Alias = int[3];",
      "int opaque(const Alias value);",
      "int opaque(Alias value) { return value ? 1 : 0; }",
      "int use_opaque() { return opaque(nullptr); }",
    ];
    try {
      await fs.writeFile(file, lines.join("\n"), "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      for (const [callLine, callText, definitionLine] of [
        [13, "pick", 2],
        [14, "relay", 4],
        [15, "total", 6],
        [21, "empty", 20],
        [24, "grid", 23],
        [27, "hold", 26],
      ] as const) {
        const resolved = await goToDefinition(index, {
          file,
          line: callLine,
          column: lines[callLine - 1]!.lastIndexOf(callText) + 1,
        });
        expect(resolved.status).toBe("ok");
        if (resolved.status !== "ok") throw new Error("Expected the adjusted callable definition");
        expect(resolved.definition.range.start.line).toBe(definitionLine);
      }
      for (const [line, name, expectedLines] of [
        [2, "pick", [1, 2, 13]],
        [4, "relay", [3, 4, 14]],
        [6, "total", [5, 6, 15]],
        [20, "empty", [19, 20, 21]],
        [23, "grid", [22, 23, 24]],
        [26, "hold", [25, 26, 27]],
      ] as const) {
        const refs = await findReferences(index, {
          file,
          line,
          column: lines[line - 1]!.indexOf(name) + 1,
        });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") throw new Error("Expected adjusted callable references");
        expect(refs.references.map((reference) => reference.range.start.line)).toEqual(expectedLines);
      }
      for (const [line, name, callLine] of [
        [7, "exact", 16],
        [9, "bind", 17],
        [11, "paint", 18],
        [29, "opaque", 31],
      ] as const) {
        const prototypeRefs = await findReferences(index, {
          file,
          line,
          column: lines[line - 1]!.indexOf(name) + 1,
        });
        expect(prototypeRefs.status).toBe("ok");
        if (prototypeRefs.status !== "ok") throw new Error("Expected a distinct overload declaration");
        expect(prototypeRefs.references.map((reference) => reference.range.start.line)).toEqual([line]);
        expect(
          await goToDefinition(index, {
            file,
            line: callLine,
            column: lines[callLine - 1]!.lastIndexOf(name) + 1,
          }),
        ).toMatchObject({ status: "not_found" });
      }
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      for (const merged of ["pick", "relay", "total", "empty", "grid", "hold"]) {
        expect(nodes.filter((node) => node.name === merged)).toHaveLength(1);
      }
      for (const split of ["exact", "bind", "paint", "opaque"]) {
        expect(nodes.filter((node) => node.name === split)).toHaveLength(2);
      }
      expect(
        graph.edges
          .filter((edge) => edge.label === "calls")
          .map((edge) => [graph.nodes.get(edge.from)?.name, graph.nodes.get(edge.to)?.name])
          .sort(),
      ).toEqual([
        ["use_empty", "empty"],
        ["use_grid", "grid"],
        ["use_hold", "hold"],
        ["use_pick", "pick"],
        ["use_relay", "relay"],
        ["use_total", "total"],
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("selects included using-alias overloads and rejects invalid C++ arity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-included-alias-arity-"));
    const header = path.join(root, "api.hpp");
    const file = path.join(root, "use.cpp");
    const headerLines = [
      "namespace left {",
      "int run(int*);",
      "int pick();",
      "int pick(int);",
      "}",
      "namespace alias { inline namespace v1 { using left::pick; } }",
    ];
    const lines = [
      '#include "api.hpp"',
      "int invalid_zero() { return left::run(); }",
      "int invalid_two() { return left::run(nullptr, nullptr); }",
      "int zero() { return alias::pick(); }",
      "int one() { return alias::pick(1); }",
      "int too_many() { return alias::pick(1, 2); }",
      "using left::pick;",
      "int direct_zero() { return pick(); }",
      "int direct_one() { return pick(1); }",
      "int direct_invalid() { return pick(1, 2); }",
      "int shadow(int pick) { return pick; }",
      "namespace imported { using left::pick; }",
      "int qualified() { return imported::pick(1); }",
    ];
    try {
      await fs.writeFile(header, headerLines.join("\n"), "utf8");
      await fs.writeFile(file, lines.join("\n"), "utf8");
      for (const cache of ["off", "disk", "disk"] as const) {
        const index = await buildProjectIndexIncremental(root, { cache });
        const zero = await goToDefinition(index, { file, line: 4, column: lines[3]!.lastIndexOf("pick") + 1 });
        const one = await goToDefinition(index, { file, line: 5, column: lines[4]!.lastIndexOf("pick") + 1 });
        const tooMany = await goToDefinition(index, { file, line: 6, column: lines[5]!.lastIndexOf("pick") + 1 });
        const invalidZero = await goToDefinition(index, { file, line: 2, column: lines[1]!.lastIndexOf("run") + 1 });
        expect(zero.status).toBe("ok");
        if (zero.status === "ok") expect(zero.definition.range.start.line).toBe(3);
        expect(one.status).toBe("ok");
        if (one.status === "ok") expect(one.definition.range.start.line).toBe(4);
        expect(tooMany.status).toBe("not_found");
        expect(invalidZero.status).toBe("not_found");
        for (const [line, targetLine] of [
          [8, 3],
          [9, 4],
          [13, 4],
        ] as const) {
          const result = await goToDefinition(index, { file, line, column: lines[line - 1]!.lastIndexOf("pick") + 1 });
          expect(result.status).toBe("ok");
          if (result.status === "ok") {
            expect(normalizePath(result.definition.file)).toBe(normalizePath(header));
            expect(result.definition.range.start.line).toBe(targetLine);
          }
        }
        expect(
          await goToDefinition(index, { file, line: 10, column: lines[9]!.lastIndexOf("pick") + 1 }),
        ).toMatchObject({ status: "not_found" });
        expect(
          await goToDefinition(index, { file, line: 11, column: lines[10]!.lastIndexOf("pick") + 1 }),
        ).toMatchObject({ status: "ok", definition: { range: { start: { line: 11 } } } });
        const graph = await buildSymbolGraphDetailed(index);
        const callerTargets = (name: string) =>
          graph.edges
            .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === name)
            .map((edge) => graph.nodes.get(edge.to)?.name);
        expect(callerTargets("zero")).toEqual(["pick"]);
        expect(callerTargets("one")).toEqual(["pick"]);
        expect(callerTargets("too_many")).toEqual([]);
        expect(callerTargets("invalid_zero")).toEqual([]);
        expect(callerTargets("invalid_two")).toEqual([]);
        expect(callerTargets("direct_zero")).toEqual(["pick"]);
        expect(callerTargets("direct_one")).toEqual(["pick"]);
        expect(callerTargets("direct_invalid")).toEqual([]);
        expect(callerTargets("shadow")).toEqual([]);
        expect(callerTargets("qualified")).toEqual(["pick"]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves qualified bases through included headers and inherited calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-qualified-base-"));
    const header = path.join(root, "base.hpp");
    const file = path.join(root, "main.cpp");
    const call = "struct Derived : public ns::Base { int relay() { return this->run(); } };";
    try {
      await fs.writeFile(header, "namespace ns { struct Base { int run() { return 1; } }; }\n");
      await fs.writeFile(file, `#include "base.hpp"\n${call}\n`);
      const index = await createTestIndexFromFiles(root, [header, file]);
      const target = await goToDefinition(index, { file, line: 2, column: call.indexOf("run()") + 1 });
      expect(target.status).toBe("ok");
      if (target.status !== "ok") throw new Error("Expected the qualified base member");
      expect(normalizePath(target.definition.file)).toBe(normalizePath(header));
      const graph = await buildSymbolGraphDetailed(index);
      expect(
        graph.edges
          .filter((edge) => edge.label === "extends")
          .map((edge) => [graph.nodes.get(edge.from)?.name, graph.nodes.get(edge.to)?.name]),
      ).toEqual([["Derived", "Base"]]);
      expect(
        graph.edges
          .filter((edge) => edge.label === "calls")
          .map((edge) => [graph.nodes.get(edge.from)?.name, graph.nodes.get(edge.to)?.name]),
      ).toEqual([["relay", "run"]]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a C++ parameter pack that binds no trailing arguments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-parameter-pack-"));
    const file = path.join(root, "probe.cpp");
    const lines = [
      "template<class T, class... Ts> int pack(T first, Ts... rest);",
      "template<class T, class... Ts> int pack(T first, Ts... rest) { return first; }",
      "int pick(int, int);",
      "int pick(int, ...);",
      "int use_pack_one() { return pack(1); }",
      "int use_pack_two() { return pack(1, 2); }",
      "int use_pack_zero() { return pack(); }",
      "int use_pick_one() { return pick(1); }",
      "int use_pick_two() { return pick(1, 2); }",
      "int use_pick_zero() { return pick(); }",
      "void arity(int);",
      "void arity(int, ...);",
      "void callbacks(void (*fn)(void));",
      "void callbacks(void (*fn)(...));",
    ];
    try {
      await fs.writeFile(file, lines.join("\n"), "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      // A pack may bind zero arguments, so only its fixed parameter sets the minimum.
      const one = await goToDefinition(index, { file, line: 5, column: lines[4]!.lastIndexOf("pack") + 1 });
      expect(one.status).toBe("ok");
      if (one.status !== "ok") throw new Error("Expected the pack definition for one fixed argument");
      expect(one.definition.range.start.line).toBe(2);
      const two = await goToDefinition(index, { file, line: 6, column: lines[5]!.lastIndexOf("pack") + 1 });
      expect(two.status).toBe("ok");
      if (two.status !== "ok") throw new Error("Expected the pack definition for extra arguments");
      expect(two.definition.range.start.line).toBe(2);
      // The fixed parameter is still required.
      expect(await goToDefinition(index, { file, line: 7, column: lines[6]!.lastIndexOf("pack") + 1 })).toMatchObject({
        status: "not_found",
      });
      // A bare ellipsis already accepts the fixed minimum and keeps its overload separate.
      const ellipsisOne = await goToDefinition(index, { file, line: 8, column: lines[7]!.lastIndexOf("pick") + 1 });
      expect(ellipsisOne.status).toBe("ok");
      if (ellipsisOne.status !== "ok") throw new Error("Expected the variadic overload for one argument");
      expect(ellipsisOne.definition.range.start.line).toBe(4);
      expect(await goToDefinition(index, { file, line: 9, column: lines[8]!.lastIndexOf("pick") + 1 })).toMatchObject({
        status: "not_found",
      });
      expect(await goToDefinition(index, { file, line: 10, column: lines[9]!.lastIndexOf("pick") + 1 })).toMatchObject({
        status: "not_found",
      });
      const references = await findReferences(index, { file, line: 1, column: lines[0]!.indexOf("pack") + 1 });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected parameter pack references");
      expect(references.references.map((reference) => reference.range.start.line)).toEqual([1, 2, 5, 6]);
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      expect(nodes.filter((node) => node.name === "pack")).toHaveLength(1);
      expect(nodes.filter((node) => node.name === "pick")).toHaveLength(2);
      expect(nodes.filter((node) => node.name === "arity")).toHaveLength(2);
      expect(nodes.filter((node) => node.name === "callbacks")).toHaveLength(2);
      expect(
        graph.edges
          .filter((edge) => edge.label === "calls")
          .map((edge) => [graph.nodes.get(edge.from)?.name, graph.nodes.get(edge.to)?.name]),
      ).toEqual([
        ["use_pack_one", "pack"],
        ["use_pack_two", "pack"],
        ["use_pick_one", "pick"],
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps same-signature functions from different namespaces ambiguous under one alias", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-alias-namespace-identity-"));
    const file = path.join(root, "probe.cpp");
    const lines = [
      "namespace a { int pick(int); }",
      "namespace b { int pick(int); }",
      "namespace alias { using a::pick; using b::pick; }",
      "int ambiguous() { return alias::pick(1); }",
      "int direct() { return a::pick(1); }",
    ];
    try {
      await fs.writeFile(file, lines.join("\n"), "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const ambiguous = await goToDefinition(index, {
        file,
        line: 4,
        column: lines[3]!.indexOf("pick") + 1,
      });
      expect(ambiguous.status).toBe("not_found");
      const direct = await goToDefinition(index, {
        file,
        line: 5,
        column: lines[4]!.indexOf("pick") + 1,
      });
      expect(direct.status).toBe("ok");
      if (direct.status !== "ok") throw new Error("Expected the qualified namespace function");
      expect(direct.definition.range.start.line).toBe(1);
      const references = await findReferences(index, {
        file,
        line: 1,
        column: lines[0]!.indexOf("pick") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected qualified namespace references");
      const referenceLines = references.references.map((reference) => reference.range.start.line);
      expect(referenceLines).toContain(5);
      expect(referenceLines).not.toContain(4);
      const graph = await buildSymbolGraphDetailed(index);
      const callers = graph.edges
        .filter((edge) => edge.label === "calls")
        .map((edge) => graph.nodes.get(edge.from)?.name);
      expect(callers).toEqual(["direct"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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

  it("does not resolve an identifier include macro to a sibling decoy file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-include-macro-decoy-"));
    const decoy = path.join(root, "HEADER");
    const file = path.join(root, "main.cpp");
    const source = ['#define HEADER "x.h"', "#include HEADER", "int main() { return 0; }", ""].join("\n");
    try {
      await fs.writeFile(decoy, "int decoy();\n", "utf8");
      await fs.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const imports = index.byFile.get(fileIdentityKey(file))?.imports ?? [];
      expect(imports.map((entry) => entry.from)).toEqual(["HEADER"]);
      expect(imports.map((entry) => entry.resolved)).toEqual([{ external: "HEADER" }]);
      expect(imports.map((entry) => entry.resolved)).not.toContain(normalizePath(decoy));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a quoted and a macro include of the same text per occurrence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-include-form-per-occurrence-"));
    const header = path.join(root, "HEADER");
    const file = path.join(root, "main.cpp");
    const source = ['#include "HEADER"', "#include HEADER", "int main() { return 0; }", ""].join("\n");
    try {
      await fs.writeFile(header, "int decoy();\n", "utf8");
      await fs.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const imports = index.byFile.get(fileIdentityKey(file))?.imports ?? [];
      expect(imports.map((entry) => entry.from)).toEqual(["HEADER", "HEADER"]);
      expect(imports.map((entry) => entry.resolved)).toEqual([normalizePath(header), { external: "HEADER" }]);

      const fileEdges = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file));
      expect(fileEdges).toContainEqual(expect.objectContaining({ to: { type: "file", path: normalizePath(header) } }));
      expect(fileEdges).toContainEqual(expect.objectContaining({ to: { type: "external", name: "HEADER" } }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an angle include through resolution hints and keeps it external without them", async () => {
    const hintRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-angle-hints-"));
    const plainRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-angle-no-hints-"));
    try {
      const hintDir = path.join(hintRoot, "include");
      const hintHeader = path.join(hintDir, "lib.h");
      const hintFile = path.join(hintRoot, "main.cpp");
      const source = "#include <lib.h>\nint main() { return helper(1); }\n";
      await fs.mkdir(hintDir, { recursive: true });
      await fs.writeFile(hintHeader, "int helper(int a);\n", "utf8");
      await fs.writeFile(hintFile, source, "utf8");

      const index = await buildProjectIndex(hintRoot, { cache: "off", graph: { resolutionHints: ["include"] } });
      expect(index.byFile.get(fileIdentityKey(hintFile))?.imports[0]?.resolved).toBe(normalizePath(hintHeader));
      expect(
        index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(hintFile)),
      ).toContainEqual(expect.objectContaining({ to: { type: "file", path: normalizePath(hintHeader) } }));

      const callColumn = source.split("\n")[1]!.indexOf("helper") + 1;
      const gotoResult = await goToDefinition(index, { file: hintFile, line: 2, column: callColumn });
      expect(gotoResult.status).toBe("ok");
      if (gotoResult.status === "ok") {
        expect(gotoResult.definition.file).toBe(normalizePath(hintHeader));
      }
      const refs = await findReferences(index, { file: hintHeader, line: 1, column: 5 });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references.map((reference) => normalizePath(reference.file))).toEqual(
          expect.arrayContaining([normalizePath(hintHeader), normalizePath(hintFile)]),
        );
      }

      const plainFile = path.join(plainRoot, "main.cpp");
      await fs.writeFile(plainFile, source, "utf8");
      const plainIndex = await buildProjectIndex(plainRoot, { cache: "off" });
      expect(plainIndex.byFile.get(fileIdentityKey(plainFile))?.imports[0]?.resolved).toEqual({ external: "<lib.h>" });
      expect(
        plainIndex.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(plainFile)),
      ).toContainEqual(expect.objectContaining({ to: { type: "external", name: "<lib.h>" } }));
    } finally {
      await fs.rm(hintRoot, { recursive: true, force: true });
      await fs.rm(plainRoot, { recursive: true, force: true });
    }
  });

  it("resolves a quoted extensionless include to the exact sibling file and not a same-stem script", async () => {
    const hitRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-quoted-config-hit-"));
    const missRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-quoted-config-miss-"));
    try {
      const configFile = path.join(hitRoot, "config");
      const hitFile = path.join(hitRoot, "main.cpp");
      await fs.writeFile(configFile, "int cfg();\n", "utf8");
      await fs.writeFile(hitFile, '#include "config"\nint main() { return 0; }\n', "utf8");
      const hitIndex = await buildProjectIndex(hitRoot, { cache: "off" });
      expect(hitIndex.byFile.get(fileIdentityKey(hitFile))?.imports[0]?.resolved).toBe(normalizePath(configFile));

      const missFile = path.join(missRoot, "main.cpp");
      const tsDecoy = path.join(missRoot, "config.ts");
      const jsDecoy = path.join(missRoot, "config.js");
      await fs.writeFile(tsDecoy, "export const decoy = 1;\n", "utf8");
      await fs.writeFile(jsDecoy, "export const decoy = 2;\n", "utf8");
      await fs.writeFile(missFile, '#include "config"\nint main() { return 0; }\n', "utf8");
      const missIndex = await buildProjectIndex(missRoot, { cache: "off" });
      const resolved = missIndex.byFile.get(fileIdentityKey(missFile))?.imports[0]?.resolved;
      expect(resolved).toEqual({ external: "config" });
      expect(resolved).not.toBe(normalizePath(tsDecoy));
      expect(resolved).not.toBe(normalizePath(jsDecoy));
    } finally {
      await fs.rm(hitRoot, { recursive: true, force: true });
      await fs.rm(missRoot, { recursive: true, force: true });
    }
  });

  it("keeps an unresolved quoted include external when hints, workspace, and node_modules could bind decoys", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-quoted-config-decoys-"));
    try {
      const file = path.join(root, "main.cpp");
      await fs.writeFile(file, '#include "config"\nint main() { return 0; }\n', "utf8");
      await fs.writeFile(path.join(root, "config.ts"), "export const decoy = 1;\n", "utf8");
      await fs.mkdir(path.join(root, "config"), { recursive: true });
      await fs.writeFile(path.join(root, "config", "index.ts"), "export const decoy = 2;\n", "utf8");
      await fs.mkdir(path.join(root, "node_modules", "config"), { recursive: true });
      await fs.writeFile(
        path.join(root, "node_modules", "config", "package.json"),
        JSON.stringify({ name: "config", main: "index.ts" }),
        "utf8",
      );
      await fs.writeFile(path.join(root, "node_modules", "config", "index.ts"), "export const decoy = 3;\n", "utf8");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ private: true, workspaces: ["packages/*"] }),
        "utf8",
      );
      await fs.mkdir(path.join(root, "packages", "config"), { recursive: true });
      await fs.writeFile(
        path.join(root, "packages", "config", "package.json"),
        JSON.stringify({ name: "config", main: "index.ts" }),
        "utf8",
      );
      await fs.writeFile(path.join(root, "packages", "config", "index.ts"), "export const decoy = 4;\n", "utf8");

      const index = await buildProjectIndex(root, {
        cache: "off",
        graph: { resolutionHints: ["."], resolveNodeModules: true },
      });
      const resolved = index.byFile.get(fileIdentityKey(file))?.imports[0]?.resolved;
      expect(resolved).toEqual({ external: "config" });
      const fileEdges = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file));
      expect(fileEdges).toContainEqual(expect.objectContaining({ to: { type: "external", name: "config" } }));
      expect(fileEdges.some((edge) => edge.to.type === "file")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a quoted include through an exact file in a configured include root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-quoted-config-hint-"));
    try {
      const includeDir = path.join(root, "include");
      const hintFile = path.join(includeDir, "config");
      const file = path.join(root, "main.cpp");
      await fs.mkdir(includeDir, { recursive: true });
      await fs.writeFile(hintFile, "int cfg();\n", "utf8");
      await fs.writeFile(file, '#include "config"\nint main() { return 0; }\n', "utf8");

      const index = await buildProjectIndex(root, { cache: "off", graph: { resolutionHints: ["include"] } });
      expect(index.byFile.get(fileIdentityKey(file))?.imports[0]?.resolved).toBe(normalizePath(hintFile));
      const fileEdges = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file));
      expect(fileEdges).toContainEqual(
        expect.objectContaining({ to: { type: "file", path: normalizePath(hintFile) } }),
      );
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
        functionBindings.filter((binding) => binding.def?.start.index === source.indexOf("A::f") + "A::".length),
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
        expect(outOfLineRefs.references.map((reference) => reference.range.start.line)).toEqual(
          expect.arrayContaining([10, 11]),
        );
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps qualified out-of-line members out of free-function scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-out-of-line-scope-"));
    const file = path.join(root, "main.cpp");
    const lines = [
      "int f() { return 1; }",
      "class A { public: static int f(); };",
      "int A::f() { return 2; }",
      "int use_free() { return f(); }",
      "int use_member() { return A::f(); }",
      "",
    ];
    try {
      await fs.writeFile(file, lines.join("\n"), "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });

      const freeCall = await goToDefinition(index, {
        file,
        line: 4,
        column: lines[3]!.indexOf("f()") + 1,
      });
      expect(freeCall.status).toBe("ok");
      if (freeCall.status === "ok") {
        expect(freeCall.definition.range.start.line).toBe(1);
      }

      const memberCall = await goToDefinition(index, {
        file,
        line: 5,
        column: lines[4]!.lastIndexOf("f()") + 1,
      });
      expect(memberCall.status).toBe("ok");
      if (memberCall.status === "ok") {
        expect(memberCall.definition.range.start.line).toBe(2);
      }

      const freeReferences = await findReferences(index, { file, line: 1, column: lines[0]!.indexOf("f()") + 1 });
      expect(freeReferences.status).toBe("ok");
      if (freeReferences.status === "ok") {
        expect(freeReferences.references.map((reference) => reference.range.start.line)).toEqual([1, 4]);
      }

      const memberReferences = await findReferences(index, {
        file,
        line: 3,
        column: lines[2]!.lastIndexOf("f()") + 1,
      });
      expect(memberReferences.status).toBe("ok");
      if (memberReferences.status === "ok") {
        expect(memberReferences.references.map((reference) => reference.range.start.line)).toEqual(
          expect.arrayContaining([3, 5]),
        );
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("C++ header include identity", () => {
  it("keeps a C++ .h include out of the C tag namespace across cache modes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-header-include-namespace-"));
    const header = normalizePath(path.join(root, "api.h"));
    const consumer = normalizePath(path.join(root, "main.cpp"));
    // The extractor recognizes C++ syntax, but a filename-only `.h` lookup would choose C.
    const headerLines = [
      "namespace widgets {",
      "class Widget {",
      "public:",
      "  int value;",
      "};",
      "}",
      "",
      "int run(int amount) { return amount; }",
      "",
      "struct Point {",
      "  int x;",
      "};",
      "",
    ];
    const lines = [
      '#include "api.h"',
      "int main() {",
      "  widgets::Widget widget;",
      "  Point point;",
      "  return run(1);",
      "}",
      "",
    ];
    try {
      await fs.writeFile(header, headerLines.join("\n"), "utf8");
      await fs.writeFile(consumer, lines.join("\n"), "utf8");
      const callColumn = lines[4]!.indexOf("run(1)") + 1;
      const runDefinitionColumn = headerLines[7]!.indexOf("run(") + 1;
      for (const cache of ["off", "disk", "disk"] as const) {
        const index = await buildProjectIndexIncremental(root, { cache });
        const expectedNames = new Set(["widgets::Widget", "run", "Point"]);
        const expectedImportIds = [...expectedNames].map((name) => `${consumer}::${name}::import`).sort();
        expect(
          listSymbols(index, { file: consumer, includeImports: true })
            .filter((symbol) => symbol.kind === "import" && expectedNames.has(symbol.name))
            .map((symbol) => symbol.id)
            .sort(),
        ).toEqual(expectedImportIds);
        expect(
          [...(await buildSymbolGraph(index)).nodes.values()]
            .filter((node) => node.kind === "import" && node.file === consumer && expectedNames.has(node.name))
            .map((node) => node.id)
            .sort(),
        ).toEqual(expectedImportIds);
        for (const [name, line] of [
          ["widgets::Widget", 2],
          ["run", 8],
          ["Point", 10],
        ] as const) {
          expect(goToDefinitionById(index, `${consumer}::${name}::import`)).toMatchObject({
            status: "ok",
            definition: { file: header, range: { start: { line } } },
          });
        }

        const workspaceImportIds = (await queryWorkspaceSymbols(index, { query: "run", includeImports: true })).symbols
          .filter((symbol) => symbol.imported)
          .map((symbol) => symbol.id);
        expect(workspaceImportIds).toHaveLength(1);
        expect(workspaceImportIds[0]!.endsWith("::run::import")).toBe(true);

        const call = await goToDefinition(index, { file: consumer, line: 5, column: callColumn });
        expect(call.status).toBe("ok");
        if (call.status !== "ok") throw new Error("Expected the included C++ callable");
        expect(normalizePath(call.definition.file)).toBe(header);
        expect(call.definition.range.start.line).toBe(8);

        const references = await findReferences(index, {
          file: header,
          line: 8,
          column: runDefinitionColumn,
        });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("Expected references for the included callable");
        expect(
          references.references.map((reference) => [normalizePath(reference.file), reference.range.start.line]),
        ).toContainEqual([consumer, 5]);

        const detailed = await buildSymbolGraphDetailed(index);
        expect(
          detailed.edges
            .filter((edge) => edge.label === "calls" && detailed.nodes.get(edge.from)?.name === "main")
            .map((edge) => detailed.nodes.get(edge.to)?.name),
        ).toEqual(["run"]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("C++ reference-returning free functions", () => {
  it("resolves a sibling call to a free function with a reference return type", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-ref-return-free-"));
    const file = path.join(root, "main.cpp");
    const source = [
      "int& free_ref() { static int value = 1; return value; }",
      "int use_value() { return free_ref(); }",
      "",
    ].join("\n");
    try {
      await fs.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const defColumn = source.split("\n")[0]!.indexOf("free_ref") + 1;
      const callColumn = source.split("\n")[1]!.indexOf("free_ref") + 1;
      const gotoResult = await goToDefinition(index, { file, line: 2, column: callColumn });
      expect(gotoResult.status).toBe("ok");
      if (gotoResult.status === "ok") {
        expect(fileIdentityKey(gotoResult.definition.file)).toBe(fileIdentityKey(file));
        expect(gotoResult.definition.range.start.line).toBe(1);
        expect(gotoResult.definition.range.start.column).toBe(defColumn);
      }
      const refs = await findReferences(index, { file, line: 1, column: defColumn });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(
          refs.references.map((reference) => ({
            line: reference.range.start.line,
            column: reference.range.start.column,
          })),
        ).toEqual([
          { line: 1, column: defColumn },
          { line: 2, column: callColumn },
        ]);
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

describe("C++ implicit this in qualified and bare member calls", () => {
  it("navigates from an out-of-line definition's own name to that definition, including template owners", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-definition-name-"));
    try {
      const file = path.join(root, "c.cpp").replace(/\\/g, "/");
      const lines = [
        "template <class T> struct Box { int f(); };",
        "template <class T> int Box<T>::f() { return 0; }",
        "struct Plain { int g(); };",
        "int Plain::g() { return 1; }",
        "",
      ];
      await fs.writeFile(file, lines.join("\n"), "utf8");
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      for (const [line, name] of [
        [2, "::f"],
        [4, "::g"],
      ] as const) {
        const column = lines[line - 1]!.indexOf(name) + 3;
        const goto = await goToDefinition(index, { file, line, column });
        // The declarator names the definition itself; it is not a member call needing `this`.
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(goto.definition.range.start).toMatchObject({ line, column });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("gives namespace-qualified and pointer-returning out-of-line definitions their own member identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-nested-qualified-"));
    try {
      const file = path.join(root, "c.cpp").replace(/\\/g, "/");
      const lines = [
        "int one() { return 1; }",
        "int two() { return 2; }",
        "namespace a { struct C { int run(); int* make(); }; }",
        "namespace b { struct C { int run(); }; }",
        "int a::C::run() { return one(); }",
        "int b::C::run() { return two(); }",
        "int* a::C::make() { static int v = one(); return &v; }",
        "",
      ];
      await fs.writeFile(file, lines.join("\n"), "utf8");
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const graph = await buildSymbolGraphDetailed(index);
      const label = (id: string): string => {
        const node = graph.nodes.get(id);
        const start = Number(id.slice(id.lastIndexOf("::") + 2));
        const line = lines.join("\n").slice(0, start).split("\n").length;
        return `${node?.name}@${line}`;
      };
      const edges = graph.edges
        .filter((edge) => edge.label === "calls" || edge.label === "member_of")
        .map((edge) => `${edge.label} ${label(edge.from)} -> ${label(edge.to)}`)
        .sort();
      // Each definition folds into its own class's declaration; neither borrows the other's.
      expect(edges).toEqual([
        "calls make@3 -> one@1",
        "calls run@3 -> one@1",
        "calls run@4 -> two@2",
        "member_of make@3 -> C@3",
        "member_of run@3 -> C@3",
        "member_of run@4 -> C@4",
      ]);
      const references = await findReferences(index, { file, line: 3, column: lines[2]!.indexOf("run") + 1 });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected a::C::run references");
      expect(references.references.map((reference) => reference.range.start.line).sort((l, r) => l - r)).toEqual([
        3, 5,
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("lets an owner member hide a same-named global in out-of-line bodies across goto, references, and calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-member-hides-global-"));
    try {
      const file = path.join(root, "c.cpp").replace(/\\/g, "/");
      const lines = [
        "int helper(int x) { return x; }",
        "struct Box {",
        "  int helper();",
        "  int run();",
        "  int ok();",
        "  static int shared();",
        "};",
        "int Box::helper() { return 0; }",
        "int Box::run() { return helper(1); }",
        "int Box::ok() { return helper(); }",
        "int outside() { return helper(2); }",
        "int Box::shared() { return helper(3); }",
        "",
      ];
      await fs.writeFile(file, lines.join("\n"), "utf8");
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const gotoAt = (line: number) =>
        goToDefinition(index, { file, line, column: lines[line - 1]!.indexOf("helper(") + 1 });
      for (const line of [9, 10]) {
        const goto = await gotoAt(line);
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(3);
      }
      // A static member has no `this`, but the instance member still hides the global.
      expect((await gotoAt(12)).status).toBe("not_found");
      const free = await findReferences(index, { file, line: 1, column: 5 });
      expect(free.status).toBe("ok");
      if (free.status !== "ok") throw new Error("Expected free-function references");
      expect(free.references.map((reference) => reference.range.start.line).sort((a, b) => a - b)).toEqual([1, 11]);
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges
        .filter((edge) => edge.label === "calls")
        .map(
          (edge) =>
            `${graph.nodes.get(edge.from)?.name}->${edge.to.endsWith("::4") ? "free" : "member"}:${edge.site?.range.start.line}`,
        )
        .sort();
      // `helper(1)` names the zero-parameter member, so it has no edge and no free-function fallback.
      expect(calls).toEqual(["ok->member:10", "outside->free:11"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies qualified owners by full path and reaches instance members only through the caller's own class or bases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-qualified-owner-"));
    const file = normalizePath(path.join(root, "q.cpp"));
    const source = [
      "namespace a { struct C { static int f(); }; }",
      "namespace b { namespace C { int f(); } }",
      "int a::C::f() { return 1; }",
      "int b::C::f() { return 2; }",
      "int free_call() { return b::C::f() + a::C::f(); }",
      "struct Base { int helper(); };",
      "int Base::helper() { return 3; }",
      "struct Derived : Base { int run(); };",
      "struct D { int instance(); };",
      "int D::instance() { return 4; }",
      "int Derived::run() { return Base::helper() + D::instance(); }",
      "",
    ].join("\n");
    try {
      await fs.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const lines = source.split("\n");
      const targetLine = async (line: number, qualified: string) => {
        const column = lines[line - 1]!.indexOf(qualified) + qualified.lastIndexOf(":") + 2;
        const result = await goToDefinition(index, { file, line, column });
        return result.status === "ok" ? result.definition.range.start.line : null;
      };
      // `b::C` is a namespace even though a class `a::C` is also reachable. A class member resolves
      // to its in-class declaration, as `Base::helper` does below.
      expect(await targetLine(5, "b::C::f")).toBe(4);
      expect(await targetLine(5, "a::C::f")).toBe(1);
      // A base-qualified call reaches the base's instance member; an unrelated class's does not.
      expect(await targetLine(11, "Base::helper")).toBe(6);
      expect(await targetLine(11, "D::instance")).toBeNull();

      const graph = await buildSymbolGraphDetailed(index);
      const callTargets = (caller: string) =>
        graph.edges
          .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === caller)
          .map((edge) => graph.nodes.get(edge.to)?.name)
          .sort();
      expect(callTargets("free_call")).toEqual(["f", "f"]);
      expect(callTargets("run")).toEqual(["helper"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves instance members only from non-static member functions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-static-context-"));
    const file = normalizePath(path.join(root, "c.cpp"));
    const source = [
      "struct C {",
      "  int instance();",
      "  static int shared();",
      "  static int s();",
      "  int m();",
      "};",
      "int C::instance() { return 1; }",
      "int C::shared() { return 2; }",
      "int C::s() { return C::instance() + instance() + shared(); }",
      "int C::m() { return C::instance() + instance() + shared(); }",
      "namespace ns { int f(); }",
      "int ns::f() { return C::instance(); }",
      "",
    ].join("\n");
    try {
      await fs.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const lines = source.split("\n");
      const gotoLine = async (line: number, column: number) =>
        await goToDefinition(index, { file, line, column: column + 1 });
      // A static member function and a namespace-qualified free function have no `this`.
      expect((await gotoLine(9, lines[8]!.indexOf("C::instance") + 3)).status).toBe("not_found");
      expect((await gotoLine(9, lines[8]!.lastIndexOf("instance"))).status).toBe("not_found");
      expect((await gotoLine(12, lines[11]!.indexOf("C::instance") + 3)).status).toBe("not_found");
      const staticCall = await gotoLine(9, lines[8]!.indexOf("shared"));
      expect(staticCall.status === "ok" && staticCall.definition.range.start.line).toBe(3);
      // A non-static member function reaches instance members either way.
      for (const column of [lines[9]!.indexOf("C::instance") + 3, lines[9]!.lastIndexOf("instance")]) {
        const call = await gotoLine(10, column);
        expect(call.status === "ok" && call.definition.range.start.line).toBe(2);
      }

      const graph = await buildSymbolGraphDetailed(index);
      const callees = (caller: string) =>
        graph.edges
          .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === caller)
          .map((edge) => graph.nodes.get(edge.to)?.name)
          .sort();
      expect(callees("s")).toEqual(["shared"]);
      expect(callees("m")).toEqual(["instance", "instance", "shared"]);
      expect(callees("f")).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("C++ namespace aliases", () => {
  it("prefers the visible namespace or type prefix over an unrelated global namespace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-namespace-prefix-"));
    const file = path.join(root, "probe.cpp");
    const lines = [
      "namespace target { int add() { return 1; } }",
      "namespace dm { int add() { return 2; } int onlyGlobal() { return 3; } }",
      "namespace client { namespace dm = target; int f() { return dm::add(); } int bad() { return dm::onlyGlobal(); } }",
      "int g() { return dm::add(); }",
      "namespace outer { namespace dm { int add() { return 4; } } namespace inner { int nested() { return dm::add(); } int nestedBad() { return dm::onlyGlobal(); } } }",
      "namespace types { struct dm { static int add() { return 5; } }; namespace inner { int typed() { return dm::add(); } int typeBad() { return dm::onlyGlobal(); } } }",
      "namespace client { int explicitGlobal() { return ::dm::add(); } }",
    ];
    try {
      await fs.writeFile(file, lines.join("\n") + "\n");
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const at = async (line: number, name: string, use = false) => {
        const source = lines[line - 1]!;
        const column = (use ? source.lastIndexOf(name) : source.indexOf(name)) + 1;
        return goToDefinition(index, { file, line, column });
      };
      const target = await at(1, "add");
      const global = await at(2, "add");
      const nested = await at(5, "add");
      const typed = await at(6, "add");
      for (const result of [target, global, nested, typed]) expect(result.status).toBe("ok");
      if (target.status !== "ok" || global.status !== "ok" || nested.status !== "ok" || typed.status !== "ok") {
        throw new Error("expected C++ declarations");
      }
      for (const [line, expected] of [
        [3, 1],
        [4, 2],
        [5, 5],
        [6, 6],
        [7, 2],
      ] as const) {
        const result = await at(line, "add", true);
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error("expected qualified C++ call");
        expect(result.definition.range.start.line).toBe(expected);
      }
      expect((await at(3, "onlyGlobal", true)).status).toBe("not_found");
      expect((await at(5, "onlyGlobal", true)).status).toBe("not_found");
      expect((await at(6, "onlyGlobal", true)).status).toBe("not_found");

      const referencesAt = async (line: number) => {
        const refs = await findReferences(index, { file, line, column: lines[line - 1]!.indexOf("add") + 1 });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") throw new Error("expected C++ references");
        return refs.references.map((ref) => ref.range.start.line);
      };
      expect(await referencesAt(1)).toContain(3);
      expect(await referencesAt(1)).not.toContain(4);
      expect(await referencesAt(1)).not.toContain(7);
      expect(await referencesAt(2)).toContain(4);
      expect(await referencesAt(2)).toContain(7);
      expect(await referencesAt(2)).not.toContain(3);
      expect(await referencesAt(2)).not.toContain(5);
      expect(await referencesAt(5)).toContain(5);
      expect(await referencesAt(6)).toContain(6);

      const graph = await buildSymbolGraphDetailed(index);
      const callsFrom = (name: string) =>
        graph.edges
          .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === name)
          .map((edge) => edge.to);
      expect(callsFrom("f")).toEqual([defNodeId(target.definition)]);
      expect(callsFrom("f")).not.toContain(defNodeId(global.definition));
      expect(callsFrom("g")).toEqual([defNodeId(global.definition)]);
      expect(callsFrom("explicitGlobal")).toEqual([defNodeId(global.definition)]);
      expect(callsFrom("nested")).toEqual([defNodeId(nested.definition)]);
      expect(callsFrom("typed")).toEqual([defNodeId(typed.definition)]);
      expect(callsFrom("bad")).toEqual([]);
      expect(callsFrom("nestedBad")).toEqual([]);
      expect(callsFrom("typeBad")).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("follows a namespace alias in goto, references, and calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-namespace-alias-"));
    const header = path.join(root, "math.hpp");
    const file = path.join(root, "use.cpp");
    const headerLines = [
      "namespace detailed_math {",
      "  int add(int a, int b) { return a + b; }",
      "}",
      "namespace a {",
      "  namespace b {",
      "    int add(int a, int b) { return a + b; }",
      "  }",
      "}",
      "namespace decoy_ns {",
      "  int add(int a, int b) { return -1; }",
      "}",
    ];
    const lines = [
      '#include "math.hpp"',
      "namespace dm = decoy_ns;",
      "namespace nested = a::b;",
      "namespace outer {",
      "  namespace dm = detailed_math;",
      "  int inside() { return dm::add(1, 2); }",
      "}",
      "int nestedSum() { return nested::add(1, 2); }",
      "int fileScope() { return dm::add(1, 2); }",
      "int qualifiedAlias() { return outer::dm::add(1, 2); }",
    ];
    const columnOf = (sourceLines: string[], line: number): number => sourceLines[line - 1]!.lastIndexOf("add") + 1;
    try {
      await fs.writeFile(header, headerLines.join("\n") + "\n");
      await fs.writeFile(file, lines.join("\n") + "\n");
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const at = async (target: string, sourceLines: string[], line: number) =>
        goToDefinition(index, { file: target, line, column: columnOf(sourceLines, line) });
      const inside = await at(file, lines, 6);
      const nestedSum = await at(file, lines, 8);
      const fileScope = await at(file, lines, 9);
      const qualifiedAlias = await at(file, lines, 10);
      const decoy = await at(header, headerLines, 10);
      for (const result of [inside, nestedSum, fileScope, qualifiedAlias, decoy]) {
        expect(result.status).toBe("ok");
      }
      if (
        inside.status !== "ok" ||
        nestedSum.status !== "ok" ||
        fileScope.status !== "ok" ||
        qualifiedAlias.status !== "ok" ||
        decoy.status !== "ok"
      ) {
        throw new Error("expected namespace alias targets");
      }
      expect(normalizePath(inside.definition.file)).toBe(normalizePath(header));
      expect(inside.definition.range.start.line).toBe(2);
      expect(nestedSum.definition.range.start.line).toBe(6);
      expect(qualifiedAlias.definition.range.start.line).toBe(2);
      expect(fileScope.definition.range.start.line).toBe(10);
      expect(inside.definition.range.start.line).not.toBe(decoy.definition.range.start.line);
      expect(nestedSum.definition.range.start.line).not.toBe(decoy.definition.range.start.line);

      const useLines = async (target: string, sourceLines: string[], line: number) => {
        const refs = await findReferences(index, { file: target, line, column: columnOf(sourceLines, line) });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") throw new Error("expected references");
        return refs.references
          .filter((ref) => fileIdentityKey(ref.file) === fileIdentityKey(file))
          .map((ref) => ref.range.start.line);
      };
      const detailedRefs = await useLines(header, headerLines, 2);
      const nestedRefs = await useLines(header, headerLines, 6);
      const decoyRefs = await useLines(header, headerLines, 10);
      expect(detailedRefs).toEqual(expect.arrayContaining([6, 10]));
      expect(detailedRefs).not.toContain(8);
      expect(detailedRefs).not.toContain(9);
      expect(nestedRefs).toContain(8);
      expect(nestedRefs).not.toContain(6);
      expect(decoyRefs).toContain(9);
      expect(decoyRefs).not.toContain(6);
      expect(decoyRefs).not.toContain(8);
      expect(decoyRefs).not.toContain(10);

      const graph = await buildSymbolGraphDetailed(index);
      const callsFrom = (name: string) =>
        graph.edges
          .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === name)
          .map((edge) => edge.to);
      expect(callsFrom("inside")).toEqual([defNodeId(inside.definition)]);
      expect(callsFrom("nestedSum")).toEqual([defNodeId(nestedSum.definition)]);
      expect(callsFrom("qualifiedAlias")).toEqual([defNodeId(qualifiedAlias.definition)]);
      expect(callsFrom("fileScope")).toEqual([defNodeId(fileScope.definition)]);
      expect(callsFrom("inside")).not.toContain(defNodeId(decoy.definition));
      expect(callsFrom("nestedSum")).not.toContain(defNodeId(decoy.definition));
      expect(callsFrom("qualifiedAlias")).not.toContain(defNodeId(decoy.definition));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("C++ qualified base calls", () => {
  it("resolves Base::run inside an overriding run to the base and not Decoy", async () => {
    // The temp fixture sits outside the indexed root; only shapes.hpp is a source.
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-base-call-"));
    const root = path.join(fixture, "indexed");
    const file = normalizePath(path.join(root, "shapes.hpp"));
    const lines = [
      "class Base {",
      "public:",
      "  virtual int run() { return 1; }",
      "};",
      "class Decoy {",
      "public:",
      "  int run() { return -1; }",
      "};",
      "class Derived : public Base {",
      "public:",
      "  int run() override { return Base::run() + 1; }",
      "};",
      "",
    ];
    const callLine = 11;
    const baseLine = 3;
    const decoyLine = 7;
    try {
      await fs.mkdir(root);
      await fs.writeFile(file, lines.join("\n"), "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const callColumn = lines[callLine - 1]!.indexOf("Base::run") + "Base::".length + 1;
      const baseColumn = lines[baseLine - 1]!.indexOf("run") + 1;
      const decoyColumn = lines[decoyLine - 1]!.indexOf("run") + 1;
      const derivedColumn = lines[callLine - 1]!.indexOf("run") + 1;

      const use = await goToDefinition(index, { file, line: callLine, column: callColumn });
      expect(use.status).toBe("ok");
      if (use.status !== "ok") throw new Error("Expected Base::run");
      expect(normalizePath(use.definition.file)).toBe(file);
      expect(use.definition.range.start.line).toBe(baseLine);

      const baseRefs = await findReferences(index, { file, line: baseLine, column: baseColumn });
      expect(baseRefs.status).toBe("ok");
      if (baseRefs.status !== "ok") throw new Error("Expected Base::run references");
      const baseRefLines = baseRefs.references.map((ref) => ref.range.start.line);
      expect(baseRefLines).toContain(callLine);
      expect(baseRefLines).not.toContain(decoyLine);

      const decoyRefs = await findReferences(index, { file, line: decoyLine, column: decoyColumn });
      expect(decoyRefs.status).toBe("ok");
      if (decoyRefs.status !== "ok") throw new Error("Expected Decoy::run references");
      expect(decoyRefs.references.map((ref) => ref.range.start.line)).not.toContain(callLine);

      const derived = await goToDefinition(index, { file, line: callLine, column: derivedColumn });
      expect(derived.status).toBe("ok");
      if (derived.status !== "ok") throw new Error("Expected Derived::run");
      expect(derived.definition.range.start.line).toBe(callLine);
      const decoy = await goToDefinition(index, { file, line: decoyLine, column: decoyColumn });
      expect(decoy.status).toBe("ok");
      if (decoy.status !== "ok") throw new Error("Expected Decoy::run");

      const graph = await buildSymbolGraphDetailed(index);
      const baseId = defNodeId(use.definition);
      const decoyId = defNodeId(decoy.definition);
      const callsFromDerived = graph.edges.filter(
        (edge) => edge.label === "calls" && edge.from === defNodeId(derived.definition),
      );
      expect(callsFromDerived.map((edge) => edge.to)).toEqual([baseId]);
      expect(graph.edges.some((edge) => edge.label === "calls" && edge.to === decoyId)).toBe(false);
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });
});
