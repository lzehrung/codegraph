import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "rust",
  samples: [
    {
      name: "chunks Rust structures",
      sourceFile: "rust.sample.rs",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "struct" && c.name === "MyStruct")).toBe(true);
        expect(chunks.some((c) => c.type === "impl" && c.name === "MyStruct")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "function")).toBe(true);
        expect(chunks.some((c) => c.type === "module" && c.name === "my_mod")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "rust",
    dependencyGraph: [
      {
        from: "main.rs",
        to: { type: "file", path: "utils.rs" },
      },
      {
        from: "main.rs",
        to: { type: "file", path: "helpers.rs" },
      },
      {
        from: "aliased-use.rs",
        to: { type: "file", path: "utils.rs" },
      },
      {
        from: "aliased-use.rs",
        to: { type: "file", path: "helpers.rs" },
      },
      {
        from: "reexports.rs",
        to: { type: "file", path: "utils.rs" },
      },
      {
        from: "reexports.rs",
        to: { type: "file", path: "helpers.rs" },
      },
      {
        from: "nested.rs",
        to: { type: "file", path: "nested_service.rs" },
      },
      {
        from: "extern-crate.rs",
        to: { type: "file", path: "utils.rs" },
      },
      {
        from: "extern-crate.rs",
        to: { type: "external", name: "serde" },
      },
    ],
    symbols: [
      {
        file: "models.rs",
        includes: [{ name: "Runner" }, { name: "Engine" }, { name: "run" }],
      },
      {
        file: "reexports.rs",
        includes: [{ name: "build_engine" }],
      },
      {
        file: "nested_service.rs",
        includes: [{ name: "NestedRunner" }, { name: "run" }],
      },
    ],
    goToDefinition: [
      {
        name: "resolves aliased Rust imports",
        file: "aliased-use.rs",
        line: 9,
        column: 5,
        expectedDefinition: {
          file: "utils.rs",
          line: 1,
        },
      },
    ],
    references: [
      {
        name: "tracks aliased Rust import references",
        file: "utils.rs",
        line: 1,
        column: 8,
        minimumCount: 3,
      },
    ],
  },
};

runLanguageTests(definition);
