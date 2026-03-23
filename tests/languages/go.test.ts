import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "go",
  samples: [
    {
      name: "chunks Go structures",
      sourceFile: "go.sample.go",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "type" && c.name === "MyStruct")).toBe(true);
        expect(chunks.some((c) => c.type === "method" && c.name === "Method")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "Function")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "go",
    dependencyGraph: [
      {
        from: "main.go",
        to: { type: "file", path: "utils.go" },
      },
      {
        from: "main.go",
        to: { type: "file", path: "helpers.go" },
      },
      {
        from: "aliased-imports.go",
        to: { type: "file", path: "utils.go" },
      },
      {
        from: "aliased-imports.go",
        to: { type: "file", path: "helpers.go" },
      },
    ],
    symbols: [
      {
        file: "contracts.go",
        includes: [
          { name: "Runner" },
          { name: "Service" },
          { name: "BuildService" },
        ],
      },
      {
        file: "utils.go",
        includes: [
          { name: "ReExportedHelper" },
          { name: "ConstantValue" },
        ],
      },
    ],
  },
};

runLanguageTests(definition);
