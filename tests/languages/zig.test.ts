import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "zig",
  samples: [
    {
      name: "chunks Zig source without parser crashes",
      sourceFile: "zig.sample.zig",
      exactChunks: [{ type: "misc", startLine: 1, endLine: 9 }],
    },
  ],
  parity: {
    sampleDir: "zig",
    exact: {
      dependencyGraph: [
        {
          from: "main.zig",
          to: { type: "external", name: "build_options" },
        },
        {
          from: "main.zig",
          to: { type: "external", name: "std" },
        },
        {
          from: "main.zig",
          to: { type: "file", path: "helpers.zig" },
        },
        {
          from: "main.zig",
          to: { type: "file", path: "math.zig" },
        },
      ],
      symbols: [
        {
          file: "helpers.zig",
          symbols: [{ name: "helper", kind: "function" }],
        },
        {
          file: "main.zig",
          symbols: [
            { name: "helpers", kind: "variable" },
            { name: "math", kind: "variable" },
            { name: "run", kind: "function" },
            { name: "value", kind: "variable" },
            { name: "_", kind: "variable" },
            { name: "value", kind: "variable" },
            { name: "std", kind: "variable" },
            { name: "build_options", kind: "variable" },
          ],
        },
        {
          file: "math.zig",
          symbols: [{ name: "Number", kind: "type" }],
        },
      ],
      references: [
        {
          name: "find references includes Zig imported helper member usage",
          file: "helpers.zig",
          line: 1,
          column: 8,
          references: [
            { file: "helpers.zig", line: 1 },
            { file: "main.zig", line: 5 },
          ],
        },
        {
          name: "find references includes Zig imported type member usage",
          file: "math.zig",
          line: 1,
          column: 11,
          references: [
            { file: "math.zig", line: 1 },
            { file: "main.zig", line: 5 },
          ],
        },
      ],
    },
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
  },
};

runLanguageTests(definition);
