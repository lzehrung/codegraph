import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LANG_CONFIGS } from "../../src/bootstrap/treeSitterLanguages.js";
import { chunkFile } from "../../src/chunking/chunkFile.js";
import { buildProjectIndex, goToDefinition } from "../../src/index.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "rust",
  samples: [
    {
      name: "chunks Rust structures",
      sourceFile: "rust.sample.rs",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 2 },
        { type: "struct", name: "MyStruct", startLine: 3, endLine: 6 },
        { type: "impl", name: "MyStruct", startLine: 7, endLine: 15 },
        { type: "function", name: "new", startLine: 8, endLine: 10 },
        { type: "function", name: "method", startLine: 12, endLine: 14 },
        { type: "misc", startLine: 15, endLine: 16 },
        { type: "function", name: "function", startLine: 17, endLine: 20 },
        { type: "module", name: "my_mod", startLine: 21, endLine: 23 },
        { type: "function", name: "mod_function", startLine: 22, endLine: 22 },
        { type: "misc", startLine: 23, endLine: 24 },
      ],
    },
  ],
  parity: {
    sampleDir: "rust",
    exact: {
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
          from: "grouped-use.rs",
          to: { type: "file", path: "grouped_targets.rs" },
        },
        {
          from: "grouped-use-scoped.rs",
          to: { type: "file", path: "grouped_targets.rs" },
        },
        {
          from: "scoped-path-use.rs",
          to: { type: "file", path: "grouped_targets.rs" },
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
          symbols: [
            { name: "Runner", kind: "class" },
            { name: "Mode", kind: "type" },
            { name: "Fast", kind: "variable" },
            { name: "Slow", kind: "variable" },
            { name: "Engine", kind: "class" },
            { name: "run", kind: "function" },
          ],
        },
        {
          file: "reexports.rs",
          symbols: [{ name: "build_engine", kind: "function" }],
        },
        {
          file: "nested_service.rs",
          symbols: [
            { name: "NestedRunner", kind: "class" },
            { name: "run", kind: "function" },
          ],
        },
        {
          file: ".regressions/macros.rs",
          symbols: [
            { name: "make_answer", kind: "function" },
            { name: "invoke", kind: "function" },
          ],
        },
      ],
      references: [
        {
          name: "tracks aliased Rust import references",
          file: "utils.rs",
          line: 1,
          column: 8,
          references: [
            { file: "utils.rs", line: 1 },
            { file: "main.rs", line: 4 },
            { file: "main.rs", line: 8 },
            { file: "aliased-use.rs", line: 5 },
            { file: "aliased-use.rs", line: 9 },
            { file: "extern-crate.rs", line: 4 },
            { file: "extern-crate.rs", line: 7 },
          ],
        },
        {
          name: "finds Rust macro definition and invocation references",
          file: ".regressions/macros.rs",
          line: 1,
          column: 14,
          references: [
            { file: ".regressions/macros.rs", line: 1 },
            { file: ".regressions/macros.rs", line: 6 },
          ],
        },
      ],
    },
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

describe("Rust explicit method receivers", () => {
  it("resolves self and Self calls without lexically resolving a bare impl method", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-member-navigation-"));
    const file = path.join(root, "example.rs");
    const source = `struct Example;
impl Example {
    fn helper() {}
    fn run(&self) {
        self.helper();
        Self::helper();
        helper();
    }
}
`;

    try {
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });

      for (const [line, column] of [
        [5, 14],
        [6, 15],
      ]) {
        const result = await goToDefinition(index, { file, line, column });
        expect(result.status).toBe("ok");
        if (result.status === "ok") expect(result.definition.range.start.line).toBe(3);
      }

      const bareCall = await goToDefinition(index, { file, line: 7, column: 9 });
      expect(bareCall.status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
