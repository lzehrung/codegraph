import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectModuleSpecifiersFromSource } from "../../src/graphs.js";
import { collectImportsForFile } from "../../src/indexer.js";
import { collectLocalsAndExportsFromSource } from "../../src/indexer/locals-and-exports.js";
import { C_SUPPORT, CPP_SUPPORT, type LanguageSupport } from "../../src/languages.js";
import { getNativeQueryExecution } from "../../src/native/tree-sitter-native.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

function collectCFamilyNames(file: string, source: string, support: LanguageSupport) {
  const nativeQueries = getNativeQueryExecution(source, support).results;
  const module = collectLocalsAndExportsFromSource(file, source, support, [], { nativeQueries });
  return {
    exports: module.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : [])),
    locals: module.locals.map((entry) => entry.localName),
  };
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
            { name: "Comparator", kind: "variable" },
            { name: "left", kind: "variable" },
            { name: "right", kind: "variable" },
            { name: "AdvancedState", kind: "type" },
            { name: "STATE_READY", kind: "variable" },
            { name: "STATE_DONE", kind: "variable" },
            { name: "compare_values", kind: "function" },
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

function cFamilyIncludeCaptureTexts(source: string, support: LanguageSupport, name: "mod" | "from"): string[] {
  const results = getNativeQueryExecution(source, support).results;
  const matches = name === "mod" ? results?.imports : results?.importBindings;
  return (matches ?? []).flatMap((match) =>
    match.captures.filter((capture) => capture.name === name).map((capture) => capture.text),
  );
}

describe("C native queries", () => {
  it("keeps literal and identifier includes and rejects function-like include macros", async () => {
    const isolatedMacro = '#include MACRO("x.h")\n#define HAS_FOO 1\n';
    expect(cFamilyIncludeCaptureTexts(isolatedMacro, C_SUPPORT, "mod")).toEqual([]);
    expect(cFamilyIncludeCaptureTexts(isolatedMacro, C_SUPPORT, "from")).toEqual([]);

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
      const mods = cFamilyIncludeCaptureTexts(source, support, "mod");
      const froms = cFamilyIncludeCaptureTexts(source, support, "from");
      expect(mods).toEqual(expectedCaptures);
      expect(froms).toEqual(expectedCaptures);
      expect(mods).not.toContain("keep(void)");
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

  it("publishes non-static declarations whose names or bodies contain static", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-c-static-storage-"));
    const file = path.join(root, "exports.c");
    const source = [
      "static int helper;",
      "int static_count = 1;",
      "int ready(void) { static int once = 0; return once; }",
    ].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const module = index.byFile.get(fileIdentityKey(file));
      const exportedNames = module?.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []));

      expect(exportedNames).toEqual(expect.arrayContaining(["static_count", "ready"]));
      expect(exportedNames).not.toContain("helper");
    } finally {
      await rm(root, { recursive: true, force: true });
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
});
