import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "zig",
  samples: [
    {
      name: "chunks Zig source without parser crashes",
      sourceFile: "zig.sample.zig",
      expectedChunks: (chunks) => {
        expect(chunks.length).toBeGreaterThan(0);
      },
    },
  ],
  parity: {
    sampleDir: "zig",
    dependencyGraph: [],
    symbols: [
      { file: "helpers.zig", includes: [{ name: "helper" }] },
      { file: "main.zig", includes: [{ name: "run" }] },
    ],
    goToDefinition: [
      {
        name: "go to definition remains conservative for Zig imported module alias",
        file: "main.zig",
        line: 5,
        column: 18,
        expectedDefinition: { file: "main.zig", line: 2 },
      },
      {
        name: "go to definition remains conservative for Zig imported helper symbol usage",
        file: "main.zig",
        line: 5,
        column: 39,
        expectedDefinition: { file: "main.zig", line: 1 },
      },
    ],
    references: [
      {
        name: "find references includes Zig helper declaration",
        file: "helpers.zig",
        line: 1,
        column: 8,
        minimumCount: 1,
      },
    ],
  },
};

runLanguageTests(definition);
