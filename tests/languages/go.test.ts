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
      {
        from: "aliased-types.go",
        to: { type: "file", path: "utils.go" },
      },
      {
        from: "aliased-types.go",
        to: { type: "file", path: "helpers.go" },
      },
      {
        from: "dot-imports.go",
        to: { type: "file", path: "utils.go" },
      },
      {
        from: "dot-imports.go",
        to: { type: "file", path: "helpers.go" },
      },
      {
        from: "interfaces.go",
        to: { type: "file", path: "utils.go" },
      },
    ],
    symbols: [
      {
        file: "contracts.go",
        includes: [{ name: "Runner" }, { name: "Service" }, { name: "BuildService" }],
      },
      {
        file: "utils.go",
        includes: [{ name: "ReExportedHelper" }, { name: "ConstantValue" }],
      },
      {
        file: "interfaces.go",
        includes: [{ name: "ValueReader" }, { name: "useValueReader" }],
      },
    ],
    goToDefinition: [
      {
        name: "go to definition resolves aliased UtilityClass type",
        file: "aliased-types.go",
        line: 9,
        column: 24,
        expectedDefinition: { file: "utils.go", line: 9 },
      },
      {
        name: "go to definition resolves dot-imported constructor",
        file: "dot-imports.go",
        line: 9,
        column: 15,
        expectedDefinition: { file: "utils.go", line: 13 },
      },
      {
        name: "go to definition resolves a promoted method through struct embedding",
        file: "embedding.go",
        line: 23,
        column: 8,
        expectedDefinition: { file: "embedding.go", line: 7 },
      },
      {
        name: "go to definition resolves a value-receiver method",
        file: "embedding.go",
        line: 24,
        column: 11,
        expectedDefinition: { file: "embedding.go", line: 16 },
      },
      {
        name: "go to definition resolves a promoted struct field through embedding",
        file: "embedding.go",
        line: 22,
        column: 8,
        expectedDefinition: { file: "embedding.go", line: 4 },
      },
    ],
    references: [
      {
        name: "find references for UtilityClass includes aliased type use",
        file: "utils.go",
        line: 9,
        column: 6,
        minimumCount: 4,
      },
      {
        name: "find references for an embedded struct field includes promoted use",
        file: "embedding.go",
        line: 4,
        column: 2,
        minimumCount: 4,
      },
    ],
  },
};

runLanguageTests(definition);
