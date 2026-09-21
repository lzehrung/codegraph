import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { C_SUPPORT, CPP_SUPPORT, KOTLIN_SUPPORT, type LanguageSupport } from "../../src/languages.js";
import { collectModuleSpecifiersFromSource } from "../../src/graphs.js";
import { collectImportsForFile } from "../../src/indexer.js";
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

function collectCFamilyNames(file: string, source: string, support: LanguageSupport) {
  const nativeQueries = getNativeQueryExecution(source, support).results;
  const module = collectLocalsAndExportsFromSource(file, source, support, [], { nativeQueries });
  return {
    exports: module.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : [])),
    locals: module.locals.map((entry) => entry.localName),
  };
}
function moduleFromNativeQueriesWithoutTree(file: string, source: string, support: LanguageSupport) {
  const nativeQueries = getNativeQueryExecution(source, support).results;
  return collectLocalsAndExportsFromSource(file, source, support, [], { nativeQueries, nativeMode: "off" });
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

function cFamilyIncludeCaptureTexts(
  source: string,
  support: LanguageSupport,
  kind: "imports" | "importBindings",
): string[] {
  const results = getNativeQueryExecution(source, support).results;
  const matches = kind === "imports" ? results?.imports : results?.importBindings;
  return (matches ?? []).flatMap((match) =>
    match.captures.filter((capture) => capture.name === "from").map((capture) => capture.text),
  );
}

describe("C native queries", () => {
  it("keeps literal and identifier includes and rejects function-like include macros", async () => {
    const isolatedMacro = '#include MACRO("x.h")\n#define HAS_FOO 1\n';
    expect(cFamilyIncludeCaptureTexts(isolatedMacro, C_SUPPORT, "imports")).toEqual([]);
    expect(cFamilyIncludeCaptureTexts(isolatedMacro, C_SUPPORT, "importBindings")).toEqual([]);

    const source = [
      '#include "x.h"',
      "#include <stdio.h>",
      "#include HEADER",
      '#include MACRO("x.h")',
      "int keep(void) { return 1; }",
      "",
    ].join("\n");
    const expectedCaptures = ['"x.h"', "<stdio.h>", "HEADER"];
    const expectedSpecs = ["x.h", "<stdio.h>", "HEADER"];

    for (const support of [C_SUPPORT, CPP_SUPPORT]) {
      const imports = cFamilyIncludeCaptureTexts(source, support, "imports");
      const froms = cFamilyIncludeCaptureTexts(source, support, "importBindings");
      expect(imports).toEqual(expectedCaptures);
      expect(froms).toEqual(expectedCaptures);
      expect(imports).not.toContain("keep(void)");
      expect(froms).not.toContain("keep(void)");
      expect(collectModuleSpecifiersFromSource(support, source).map((entry) => entry.spec)).toEqual(expectedSpecs);
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "cg-c-include-forms-"));
    const file = path.join(root, "probe.c");
    try {
      await writeFile(file, source, "utf8");
      const imports = await collectImportsForFile(file, root, { source, sup: C_SUPPORT });
      expect(imports.map((entry) => entry.from)).toEqual(expectedSpecs);
      expect(imports.map((entry) => entry.kind)).toEqual(["star", "star", "star"]);
      expect(imports.map((entry) => entry.from)).not.toContain("keep(void)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports only external non-static file-scope declarations", () => {
    // The exports query is intentionally unanchored so include-guarded headers still match; the
    // function-body filter is `exportScopeBlockers`, so this has to be asserted end to end.
    const source = [
      "#ifndef DEMO_H",
      "#define DEMO_H",
      "static int helper;",
      "static int helper_fn(void) { return 0; }",
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
    expect(exported).not.toContain("helper");
    expect(exported).not.toContain("helper_fn");
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

  it("follows nested typedef declarators without indexing parameter type uses", () => {
    const source = [
      "typedef int **PP;",
      "typedef int Vector[8];",
      "typedef int (*Handlers[])(int);",
      "typedef PP (*Factory)(Vector value);",
    ].join("\n");
    for (const support of [C_SUPPORT, CPP_SUPPORT]) {
      const mod = moduleFromSource("types.h", source, support);
      const aliases = mod.locals.filter((local) => local.kind === "type");
      expect(aliases.map((local) => local.localName).sort()).toEqual(["Factory", "Handlers", "PP", "Vector"]);
      expect(aliases.map((local) => source.slice(local.range.start.index, local.range.end.index))).toEqual(
        aliases.map((local) => local.localName),
      );
      expect(mod.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : [])).sort()).toEqual([
        "Factory",
        "Handlers",
        "PP",
        "Vector",
      ]);
    }
  });

  it("exports the same header prototypes, globals, and structs as C++", () => {
    const source = "void prototype(int value);\nint counter;\nstruct Pair { int a; };";
    const cNames = collectCFamilyNames("probe.h", source, C_SUPPORT);
    const cppNames = collectCFamilyNames("probe.hpp", source, CPP_SUPPORT);

    expect(cNames.exports).toEqual(expect.arrayContaining(["prototype", "counter", "Pair"]));
    expect(cppNames.exports).toEqual(expect.arrayContaining(["prototype", "counter", "Pair"]));
    expect(cNames.locals).toEqual(expect.arrayContaining(["prototype", "counter", "Pair"]));
    expect(cppNames.locals).toEqual(expect.arrayContaining(["prototype", "counter", "Pair"]));
    expect([...cNames.exports].sort()).toEqual([...cppNames.exports].sort());
  });

  it("exports include-guarded declarations", () => {
    const source = "struct Pair { int a; };\nenum Mode { ON };\n#ifndef GUARD_H\nint guarded;\n#endif";
    const names = collectCFamilyNames("probe.h", source, C_SUPPORT);

    expect(names.exports).toEqual(expect.arrayContaining(["Pair", "Mode", "ON", "guarded"]));
    expect(names.exports.filter((name) => name === "guarded")).toEqual(["guarded"]);
    expect(names.locals).toEqual(expect.arrayContaining(["Pair", "Mode", "ON", "guarded"]));
    expect(names.exports).not.toContain("a");
  });

  it("keeps nested struct tags local while the outer struct stays exported", () => {
    const names = collectCFamilyNames("probe.h", "struct Outer { struct Inner { int x; }; };", C_SUPPORT);
    expect(names.exports).toEqual(expect.arrayContaining(["Outer"]));
    expect(names.exports).not.toContain("Inner");
    expect(names.exports).not.toContain("x");
    expect(names.locals).toEqual(expect.arrayContaining(["Outer", "Inner", "x"]));
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

describe("C native queries without a projected tree", () => {
  it("keeps typedef and function-pointer typedef names from declarator captures", () => {
    const source = [
      "typedef int **PP;",
      "typedef int Vector[8];",
      "typedef int (*Handlers[])(int);",
      "typedef PP (*Factory)(Vector value);",
      "typedef int (*Comparator)(int, int);",
      "typedef int X;",
      "typedef int 名;",
      "typedef int (* /* note */ 回调)(int);",
    ].join("\n");
    const withTree = moduleFromSource("types.h", source, C_SUPPORT);
    const noTree = moduleFromNativeQueriesWithoutTree("types.h", source, C_SUPPORT);
    const typeNames = (mod: ReturnType<typeof moduleFromSource>) =>
      mod.locals
        .filter((local) => local.kind === "type")
        .map((local) => `${local.localName}:${local.range.start.index}:${local.range.end.index}`)
        .sort();
    expect(typeNames(noTree)).toEqual(typeNames(withTree));
    expect(typeNames(noTree)).toEqual([
      expect.stringMatching(/^Comparator:/),
      expect.stringMatching(/^Factory:/),
      expect.stringMatching(/^Handlers:/),
      expect.stringMatching(/^PP:/),
      expect.stringMatching(/^Vector:/),
      expect.stringMatching(/^X:/),
      expect.stringMatching(/^名:/),
      expect.stringMatching(/^回调:/),
    ]);
    expect(noTree.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : [])).sort()).toEqual(
      withTree.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : [])).sort(),
    );
    expect(
      source.slice(
        noTree.locals.find((local) => local.localName === "Comparator")!.range.start.index!,
        noTree.locals.find((local) => local.localName === "Comparator")!.range.end.index!,
      ),
    ).toBe("Comparator");
  });

  it("excludes function-local declarations while keeping include-guard and file-scope exports", () => {
    const source = [
      "#ifndef DEMO_H",
      "#define DEMO_H",
      "static int helper;",
      "static int helper_fn(void) { return 0; }",
      "int /* static is only a comment */ top;",
      "int f() { int hidden; struct Inner { int x; }; return hidden; }",
      "int static_count = 1;",
      "int ready(void) { static int once = 0; return once; }",
      "#endif",
      "",
    ].join("\n");
    const withTree = moduleFromSource("probe.c", source, C_SUPPORT)
      .exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []))
      .sort();
    const noTree = moduleFromNativeQueriesWithoutTree("probe.c", source, C_SUPPORT)
      .exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []))
      .sort();
    expect(noTree).toEqual(withTree);
    expect(noTree).toEqual(["DEMO_H", "f", "ready", "static_count", "top"]);
    expect(noTree).not.toContain("hidden");
    expect(noTree).not.toContain("Inner");
    expect(noTree).not.toContain("once");
    expect(noTree).not.toContain("helper");
    expect(noTree).not.toContain("helper_fn");
  });

  it("keeps C++ namespace members when the tree is absent", () => {
    const source =
      "namespace N { int ns_val; }\nint top;\nint f() { int hidden; return hidden; }\nauto run = []() { struct Local {}; int lambda_hidden; return 0; };\n";
    const noTree = moduleFromNativeQueriesWithoutTree("probe.hpp", source, CPP_SUPPORT)
      .exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []))
      .sort();
    expect(noTree).toEqual(expect.arrayContaining(["N", "ns_val", "top", "f"]));
    expect(noTree).not.toContain("hidden");
    expect(noTree).not.toContain("Local");
    expect(noTree).not.toContain("lambda_hidden");
    expect(noTree).toContain("run");
  });
});
