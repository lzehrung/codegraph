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
    dependencyGraph: [
      { from: "main.zig", to: { type: "file", path: "helpers.zig" } },
      { from: "main.zig", to: { type: "file", path: "math.zig" } },
      { from: "main.zig", to: { type: "external", name: "std" } },
      { from: "main.zig", to: { type: "external", name: "build_options" } },
    ],
    symbols: [
      { file: "helpers.zig", includes: [{ name: "helper", kind: "function" }] },
      { file: "main.zig", includes: [{ name: "run", kind: "function" }] },
      { file: "math.zig", includes: [{ name: "Number", kind: "type" }] },
    ],
    goToDefinition: [
      {
        name: "go to definition resolves Zig imported type members",
        file: "main.zig",
        line: 5,
        column: 23,
        expectedDefinition: { file: "math.zig", line: 1 },
      },
      {
        name: "go to definition resolves Zig imported function members",
        file: "main.zig",
        line: 5,
        column: 43,
        expectedDefinition: { file: "helpers.zig", line: 1 },
      },
    ],
    references: [
      {
        name: "find references includes Zig imported helper member usage",
        file: "helpers.zig",
        line: 1,
        column: 8,
        minimumCount: 2,
      },
      {
        name: "find references includes Zig imported type member usage",
        file: "math.zig",
        line: 1,
        column: 11,
        minimumCount: 2,
      },
    ],
  },
};

runLanguageTests(definition);
