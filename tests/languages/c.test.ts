import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "c",
  samples: [
    {
      name: "chunks C structures",
      sourceFile: "c.sample.c",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "function" && c.name === "add")).toBe(true);
        expect(chunks.some((c) => c.type === "struct" && c.name === "MyStruct")).toBe(true);
        expect(chunks.some((c) => c.type === "enum" && c.name === "Status")).toBe(true);
        expect(chunks.some((c) => c.type === "macro" && c.name === "MAX_VALUE")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "c",
    dependencyGraph: [
      { from: "main.c", to: { type: "file", path: "utils.h" } },
      { from: "main.c", to: { type: "file", path: "helpers.h" } },
      { from: "advanced-use.c", to: { type: "file", path: "function-pointers.h" } },
    ],
    symbols: [
      {
        file: "advanced.h",
        includes: [{ name: "DEFAULT_COUNT" }, { name: "AdvancedOptions" }, { name: "Mode" }, { name: "run_advanced" }],
      },
      {
        file: "function-pointers.h",
        includes: [{ name: "Comparator" }, { name: "AdvancedState" }, { name: "compare_values" }],
      },
    ],
    goToDefinition: [
      {
        name: "go to definition resolves function-pointer typedef",
        file: "advanced-use.c",
        line: 4,
        column: 3,
        expectedDefinition: { file: "function-pointers.h", line: 3 },
      },
    ],
    references: [
      {
        name: "find references for function-pointer typedef",
        file: "function-pointers.h",
        line: 3,
        column: 15,
        minimumCount: 2,
      },
    ],
  },
};

runLanguageTests(definition);
