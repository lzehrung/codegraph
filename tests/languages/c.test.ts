import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runQuery } from "@lzehrung/codegraph-native";
import { C_SUPPORT } from "../../src/languages.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
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

describe("C native queries", () => {
  it("keeps erroneous macro includes from capturing a later preprocessor identifier", () => {
    const source = '#include MACRO("x.h")\n#define HAS_FOO 1\n';
    const imports = runQuery(source, "c", C_SUPPORT.queries.imports);
    expect(imports.matches.flatMap((match) => match.captures.filter((capture) => capture.name === "mod"))).toEqual([]);
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
});
