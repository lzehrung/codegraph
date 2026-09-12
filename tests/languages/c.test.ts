import { describe, expect, it } from "vitest";
import { runQuery } from "@lzehrung/codegraph-native";
import { C_SUPPORT, CPP_SUPPORT, KOTLIN_SUPPORT, type LanguageSupport } from "../../src/languages.js";
import { collectLocalsAndExportsFromSource } from "../../src/indexer/locals-and-exports.js";
import { getNativeQueryExecution } from "../../src/native/tree-sitter-native.js";

import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

function moduleFromSource(file: string, source: string, support: LanguageSupport) {
  const native = getNativeQueryExecution(source, support);
  return collectLocalsAndExportsFromSource(file, source, support, [], { nativeQueries: native.results });
}

function localIdentity(source: string, support: LanguageSupport): string[] {
  return moduleFromSource("probe.c", source, support)
    .locals.map((local) => `${local.kind}:${local.localName}:${local.range.start.index}:${local.range.end.index}`)
    .sort();
}
const definition: LanguageTestDefinition = {
  id: "c",
  samples: [
    {
      name: "chunks C structures",
      sourceFile: "c.sample.c",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 2 },
        { type: "type", name: "MyStruct", startLine: 3, endLine: 5 },
        { type: "struct", name: "MyStruct", startLine: 3, endLine: 5 },
        { type: "misc", startLine: 5, endLine: 6 },
        { type: "enum", name: "Status", startLine: 7, endLine: 11 },
        { type: "function", name: "add", startLine: 12, endLine: 15 },
        { type: "macro", name: "MAX_VALUE", startLine: 16, endLine: 17 },
      ],
    },
  ],
  parity: {
    sampleDir: "c",
    exact: {
      dependencyGraph: [
        {
          from: "advanced-use.c",
          to: { type: "file", path: "function-pointers.h" },
        },
        {
          from: "main.c",
          to: { type: "file", path: "helpers.h" },
        },
        {
          from: "main.c",
          to: { type: "file", path: "utils.h" },
        },
      ],
      symbols: [
        {
          file: "advanced.h",
          symbols: [
            { name: "DEFAULT_COUNT", kind: "variable" },
            // Query-driven locals (aligned with C++) index the struct tag and the typedef name.
            { name: "AdvancedOptions", kind: "class" },
            { name: "AdvancedOptions", kind: "type" },
            { name: "count", kind: "variable" },
            { name: "Mode", kind: "type" },
            { name: "MODE_FAST", kind: "variable" },
            { name: "MODE_SLOW", kind: "variable" },
            { name: "run_advanced", kind: "function" },
            { name: "options", kind: "variable" },
          ],
        },
        {
          file: "function-pointers.h",
          symbols: [
            // A function-pointer typedef name is a `type`: the name sits inside a declarator chain,
            // so it used to be classified as a variable by the scope walk.
            { name: "Comparator", kind: "type" },
            { name: "left", kind: "variable" },
            { name: "right", kind: "variable" },
            { name: "AdvancedState", kind: "type" },
            { name: "STATE_READY", kind: "variable" },
            { name: "STATE_DONE", kind: "variable" },
            { name: "compare_values", kind: "function" },
            { name: "left", kind: "variable" },
            { name: "right", kind: "variable" },
          ],
        },
      ],
      references: [
        {
          name: "find references for function-pointer typedef",
          file: "function-pointers.h",
          line: 3,
          column: 15,
          references: [
            { file: "function-pointers.h", line: 3 },
            { file: "advanced-use.c", line: 4 },
          ],
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition resolves function-pointer typedef",
        file: "advanced-use.c",
        line: 4,
        column: 3,
        expectedDefinition: { file: "function-pointers.h", line: 3 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("C native queries", () => {
  it("keeps erroneous macro includes from capturing a later preprocessor identifier", () => {
    const source = '#include MACRO("x.h")\n#define HAS_FOO 1\n';
    const imports = runQuery(source, "c", C_SUPPORT.queries.imports);
    expect(imports.matches.flatMap((match) => match.captures.filter((capture) => capture.name === "mod"))).toEqual([]);
  });

  it("exports only external non-static file-scope declarations", () => {
    // The exports query is intentionally unanchored so include-guarded headers still match; the
    // function-body filter is `exportScopeBlockers`, so this has to be asserted end to end.
    const source = [
      "#ifndef DEMO_H",
      "#define DEMO_H",
      "static int helper;",
      "int top;",
      "int f() { int sum = 0; return sum; }",
      "int static_count = 1;",
      "int ready(void) { static int once = 0; return once; }",
      "#endif",
      "",
    ].join("\n");
    const exported = moduleFromSource("probe.c", source, C_SUPPORT)
      .exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []))
      .sort();

    expect(exported).toEqual(["DEMO_H", "f", "ready", "static_count", "top"]);
  });
});

describe("C export de-duplication", () => {
  it("exports typedef struct X {} X once", () => {
    const source = "typedef struct X { int v; } X;\n";
    const exports = moduleFromSource("once.c", source, C_SUPPORT).exports.filter(
      (entry) => entry.type === "local" && entry.exportedAs === "X",
    );
    expect(exports).toHaveLength(1);
  });

  it("collapses struct tag and typedef export rows that resolve to the same local", () => {
    const source = "struct Quad { int a; };\ntypedef struct Quad Quad;\n";
    const exports = moduleFromSource("dup.c", source, C_SUPPORT).exports.filter(
      (entry) => entry.type === "local" && entry.exportedAs === "Quad",
    );
    expect(exports).toHaveLength(1);
  });
});

describe("C vs C++ query-driven locals", () => {
  it("indexes the same locals for a representative C translation unit parsed as C or C++", () => {
    const source = [
      "#define MAX 8",
      "#define ADD(a, b) ((a) + (b))",
      "typedef struct Point { int x; int y; } Point;",
      "enum Color { RED, GREEN };",
      "int global_count;",
      "int add(int left, int right) { int sum = left + right; return sum; }",
    ].join("\n");
    expect(localIdentity(source, C_SUPPORT)).toEqual(localIdentity(source, CPP_SUPPORT));
  });
});

describe("export de-duplication for shadowed Kotlin vals", () => {
  it("keeps one export row when two patterns resolve to the same local", () => {
    const source = [
      "class Holder {",
      "    val name = 1",
      "    fun f() {",
      "        val name = 2",
      "    }",
      "}",
      "",
    ].join("\n");
    const exports = moduleFromSource("shadow.kt", source, KOTLIN_SUPPORT).exports.filter(
      (entry) => entry.type === "local" && entry.exportedAs === "name",
    );
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ type: "local", exportedAs: "name" });
    if (exports[0]?.type === "local") {
      expect(exports[0].target.range.start.line).toBe(2);
    }
  });
});
