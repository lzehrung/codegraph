import { readFile } from "node:fs/promises";
import { LANG_CONFIGS } from "../../src/bootstrap/treeSitterLanguages.js";
import { chunkFile } from "../../src/chunking/chunkFile.js";
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
        includes: [
          { name: "Runner" },
          { name: "Mode", kind: "type" },
          { name: "Fast", kind: "variable" },
          { name: "Slow", kind: "variable" },
          { name: "Engine" },
          { name: "run" },
        ],
      },
      {
        file: "reexports.rs",
        includes: [{ name: "build_engine" }],
      },
      {
        file: "nested_service.rs",
        includes: [{ name: "NestedRunner" }, { name: "run" }],
      },
      {
        file: ".regressions/macros.rs",
        includes: [{ name: "make_answer", kind: "function" }],
      },
    ],
    goToDefinition: [
      {
        name: "resolves grouped Rust use imports",
        file: "grouped-use.rs",
        line: 6,
        column: 5,
        expectedDefinition: {
          file: "grouped_targets.rs",
          line: 1,
        },
      },
      {
        name: "resolves the second member of a grouped Rust use import",
        file: "grouped-use.rs",
        line: 6,
        column: 21,
        expectedDefinition: {
          file: "grouped_targets.rs",
          line: 5,
        },
      },
      {
        name: "resolves a grouped Rust use import with a scoped (self::) path",
        file: "grouped-use-scoped.rs",
        line: 4,
        column: 5,
        expectedDefinition: {
          file: "grouped_targets.rs",
          line: 1,
        },
      },
      {
        name: "resolves a non-grouped Rust use import with a multi-segment scoped path",
        file: "scoped-path-use.rs",
        line: 4,
        column: 5,
        expectedDefinition: {
          file: "grouped_targets.rs",
          line: 1,
        },
      },
      {
        name: "resolves an aliased member inside a grouped Rust use import",
        file: "grouped-use-scoped.rs",
        line: 4,
        column: 21,
        expectedDefinition: {
          file: "grouped_targets.rs",
          line: 5,
        },
      },
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
      {
        name: "resolves a Rust macro invocation",
        file: ".regressions/macros.rs",
        line: 6,
        column: 5,
        expectedDefinition: {
          file: ".regressions/macros.rs",
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
      {
        name: "finds Rust macro definition and invocation references",
        file: ".regressions/macros.rs",
        line: 1,
        column: 14,
        minimumCount: 2,
      },
    ],
  },
};

runLanguageTests(definition);

describe("Rust macro_rules! structure", () => {
  it("chunks macro definitions from the dedicated fixture", async () => {
    const source = await readFile("tests/samples/rust/.regressions/macros.rs", "utf8");
    const chunks = chunkFile({
      language: LANG_CONFIGS.rust!,
      source,
      filePath: "macros.rs",
      minTokens: 1,
      maxTokens: 1_000,
      tokenizer: (text) => text.trim().split(/\s+/).filter(Boolean).length,
    });

    expect(chunks).toContainEqual(expect.objectContaining({ type: "macro", name: "make_answer" }));
  });
});
