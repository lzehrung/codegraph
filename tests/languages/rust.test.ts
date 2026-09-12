import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { collectImportsForFile } from "../../src/indexer/imports.js";
import { parseRustImportStatements } from "../../src/languages/import-statement-parsers.js";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LANG_CONFIGS } from "../../src/bootstrap/tree-sitter-languages.js";
import { chunkFile } from "../../src/chunking/chunk-file.js";
import { buildProjectIndex, collectGraph, goToDefinition } from "../../src/index.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { expectUnicodeSymbolRangeIdentity } from "./unicode-symbol-range.js";

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
        {
          from: ".regressions/unicode_consumer.rs",
          to: { type: "file", path: ".regressions/unicode_def.rs" },
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

describe("Rust type aliases, associated types, and trait signatures", () => {
  it("indexes pub type aliases, associated types, and declaration-only trait methods", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-missing-decls-"));
    const file = path.join(root, "example.rs");
    const source = `pub type Alias = Vec<u8>;
pub trait Runner {
    type Assoc;
    fn required(&self) -> u32;
    fn defaulted(&self) -> u32 { 1 }
}
`;
    try {
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const mod = [...index.byFile.values()][0]!;
      const locals = mod.locals.map((local) => `${local.kind}:${local.localName}`);
      const exports = mod.exports.flatMap((entry) =>
        entry.type === "local" ? [`${entry.target.kind}:${entry.exportedAs}`] : [],
      );
      expect(locals).toEqual(
        expect.arrayContaining(["type:Alias", "class:Runner", "type:Assoc", "function:required", "function:defaulted"]),
      );
      expect(exports).toEqual(
        expect.arrayContaining(["type:Alias", "class:Runner", "type:Assoc", "function:required", "function:defaulted"]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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

describe("Rust Unicode symbol ranges (C11)", () => {
  it("publishes a UTF-16 string index for a function name preceded by multibyte text", async () => {
    await expectUnicodeSymbolRangeIdentity({
      fileName: "widget.rs",
      source: "// café ☕ prüfung\n/* über */ fn créer() -> i32 {\n\t1\n}\n",
      symbolName: "créer",
    });
  });
});

describe("Rust nested grouped use and path attributes", () => {
  it("flattens nested scoped_use_list members to their full paths", () => {
    expect(parseRustImportStatements("use crate::a::{b::{Thing as Renamed}, A};")).toEqual([
      { kind: "member", from: "crate::a::b", imported: "Thing", local: "Renamed" },
      { kind: "member", from: "crate::a", imported: "A", local: "A" },
    ]);
    expect(parseRustImportStatements("use crate::a::b::{self, *};")).toEqual([
      { kind: "module", from: "crate::a::b", local: "b", isExternCrate: false },
      { kind: "star", from: "crate::a::b::*" },
    ]);
  });

  it("binds nested grouped use members, self, and star to the nested module file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-nested-use-"));
    const src = path.join(root, "src");
    await mkdir(path.join(src, "a"), { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "nested-use"\nversion = "0.1.0"\n');
    await writeFile(
      path.join(src, "lib.rs"),
      [
        "mod a;",
        "",
        "use crate::a::{b::{Thing as Renamed}, A};",
        "use crate::a::b::{self, *};",
        "",
        "pub fn consume() -> i32 {",
        "    let _t = Renamed;",
        "    let _a = A;",
        "    let _m = b::Thing;",
        "    star_item()",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(src, "a.rs"), "pub struct A;\n\npub mod b;\n");
    await writeFile(path.join(src, "a", "b.rs"), "pub struct Thing;\n\npub fn star_item() -> i32 {\n    1\n}\n");
    try {
      const lib = path.join(src, "lib.rs");
      const imports = await collectImportsForFile(lib, root);
      const resolvedName = (resolved: unknown) =>
        typeof resolved === "string" ? path.basename(resolved) : JSON.stringify(resolved);
      expect(imports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "named", local: "Renamed", imported: "Thing", from: "crate::a::b" }),
          expect.objectContaining({ kind: "named", local: "A", imported: "A", from: "crate::a" }),
          expect.objectContaining({ kind: "namespace", localNS: "b", from: "crate::a::b" }),
          expect.objectContaining({ kind: "star", from: "crate::a::b::*" }),
        ]),
      );
      expect(resolvedName(imports.find((entry) => entry.kind === "named" && entry.local === "Renamed")?.resolved)).toBe(
        "b.rs",
      );
      expect(resolvedName(imports.find((entry) => entry.kind === "named" && entry.local === "A")?.resolved)).toBe(
        "a.rs",
      );
      expect(resolvedName(imports.find((entry) => entry.kind === "star")?.resolved)).toBe("b.rs");

      const index = await buildProjectIndex(root, { cache: "off" });
      const renamed = await goToDefinition(index, { file: lib, line: 7, column: 14 });
      expect(renamed.status).toBe("ok");
      if (renamed.status === "ok") {
        expect(renamed.definition.localName).toBe("Thing");
        expect(path.basename(renamed.definition.file)).toBe("b.rs");
      }
      const star = await goToDefinition(index, { file: lib, line: 10, column: 5 });
      expect(star.status).toBe("ok");
      if (star.status === "ok") {
        expect(star.definition.localName).toBe("star_item");
        expect(path.basename(star.definition.file)).toBe("b.rs");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves #[path] modules to the attributed file instead of the conventional name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-attr-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-attr"\nversion = "0.1.0"\n');
    await writeFile(
      path.join(src, "lib.rs"),
      '#[path = "custom.rs"]\nmod external;\n\npub fn consume() {\n    external::from_custom();\n}\n',
    );
    await writeFile(path.join(src, "custom.rs"), "pub fn from_custom() {}\n");
    await writeFile(path.join(src, "external.rs"), "pub fn from_external() {}\n");
    try {
      const imports = await collectImportsForFile(path.join(src, "lib.rs"), root);
      const external = imports.find((entry) => entry.kind === "namespace" && entry.localNS === "external");
      expect(external).toBeDefined();
      expect(typeof external?.resolved).toBe("string");
      if (typeof external?.resolved === "string") {
        expect(path.basename(external.resolved)).toBe("custom.rs");
        expect(path.basename(external.resolved)).not.toBe("external.rs");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps #[cfg(test)] module statements from becoming import bindings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-cfg-test-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "cfg-test"\nversion = "0.1.0"\n');
    await writeFile(
      path.join(src, "lib.rs"),
      "mod production;\n#[cfg(test)]\nmod tests;\nuse crate::production::Prod;\n",
    );
    await writeFile(path.join(src, "production.rs"), "pub struct Prod;\n");
    await writeFile(path.join(src, "tests.rs"), "pub fn t() {}\n");
    try {
      const imports = await collectImportsForFile(path.join(src, "lib.rs"), root);
      expect(imports.some((entry) => entry.kind === "namespace" && entry.from === "tests")).toBe(false);
      expect(imports.some((entry) => entry.kind === "namespace" && entry.from === "production")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores line and nested block comments inside grouped use trees", () => {
    expect(
      parseRustImportStatements(`use crate::{
    a::Thing, // keep
    b::Other,
};`),
    ).toEqual([
      { kind: "member", from: "crate::a", imported: "Thing", local: "Thing" },
      { kind: "member", from: "crate::b", imported: "Other", local: "Other" },
    ]);
    expect(
      parseRustImportStatements(`use crate::{
    a::Thing, /* outer /* inner */ still */
    b::Other,
};`),
    ).toEqual([
      { kind: "member", from: "crate::a", imported: "Thing", local: "Thing" },
      { kind: "member", from: "crate::b", imported: "Other", local: "Other" },
    ]);
  });

  it("binds grouped use members after interior comments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-group-comments-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "group-comments"\nversion = "0.1.0"\n');
    const lib = path.join(src, "lib.rs");
    await writeFile(
      lib,
      [
        "mod a;",
        "mod b;",
        "use crate::{",
        "    a::Thing, // keep",
        "    b::Other, /* outer /* inner */ still */",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(src, "a.rs"), "pub struct Thing;\n");
    await writeFile(path.join(src, "b.rs"), "pub struct Other;\n");
    try {
      const imports = await collectImportsForFile(lib, root);
      expect(imports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "named", local: "Thing", imported: "Thing", from: "crate::a" }),
          expect.objectContaining({ kind: "named", local: "Other", imported: "Other", from: "crate::b" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records nested grouped-use module edges without a sibling self or star use", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-nested-graph-"));
    const src = path.join(root, "src");
    await mkdir(path.join(src, "a"), { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "nested-graph"\nversion = "0.1.0"\n');
    const lib = path.join(src, "lib.rs");
    const aFile = path.join(src, "a.rs");
    const bFile = path.join(src, "a", "b.rs");
    await writeFile(lib, "mod a;\n\nuse crate::a::{b::{Thing\tas\nRenamed}, A};\n");
    await writeFile(aFile, "pub struct A;\n\npub mod b;\n");
    await writeFile(bFile, "pub struct Thing;\n");
    try {
      const files = [lib, aFile, bFile];
      const graph = await collectGraph(root, files);
      const fromLib = graph.edges.filter((edge) => path.basename(edge.from) === "lib.rs");
      const basenames = fromLib.flatMap((edge) => (edge.to.type === "file" ? [path.basename(edge.to.path)] : []));
      expect(basenames).toEqual(expect.arrayContaining(["a.rs", "b.rs"]));

      const imports = await collectImportsForFile(lib, root);
      expect(imports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "named", local: "Renamed", imported: "Thing", from: "crate::a::b" }),
          expect.objectContaining({ kind: "named", local: "A", imported: "A", from: "crate::a" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores fallback import text inside block comments and raw strings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-import-trivia-"));
    const lib = path.join(root, "lib.rs");
    await writeFile(
      lib,
      [
        "/* outer",
        "use fake::Comment;",
        "/* nested */",
        "mod hidden;",
        "*/",
        'const TEXT: &str = r##"',
        "use fake::Literal;",
        '"##;',
        "use live::Visible;",
      ].join("\n"),
    );
    try {
      const imports = await collectImportsForFile(lib, root);
      expect(imports.map((entry) => entry.from)).toEqual(["live"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not bind an out-of-root #[path] module as a project import", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-outside-"));
    const root = path.join(sandbox, "project");
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-outside"\nversion = "0.1.0"\n');
    const outside = path.join(sandbox, "outside.rs");
    await writeFile(outside, "pub fn leaked() {}\n");
    await writeFile(path.join(src, "lib.rs"), '#[path = "../../outside.rs"]\nmod leaked;\n');
    try {
      const imports = await collectImportsForFile(path.join(src, "lib.rs"), root);
      const leaked = imports.find((entry) => entry.kind === "namespace" && entry.localNS === "leaked");
      expect(leaked).toBeDefined();
      expect(leaked?.resolved).toEqual({ external: "leaked" });
      if (typeof leaked?.resolved === "string") {
        expect(leaked.resolved.replace(/\\/g, "/")).not.toContain("outside.rs");
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("does not fall back to a conventional sibling when an explicit #[path] file is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-missing-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-missing"\nversion = "0.1.0"\n');
    await writeFile(
      path.join(src, "lib.rs"),
      '#[path = "missing.rs"]\nmod external;\n\npub fn consume() {\n    external::from_external();\n}\n',
    );
    await writeFile(path.join(src, "external.rs"), "pub fn from_external() {}\n");
    try {
      const lib = path.join(src, "lib.rs");
      const imports = await collectImportsForFile(lib, root);
      const external = imports.find((entry) => entry.kind === "namespace" && entry.localNS === "external");
      expect(external).toBeDefined();
      expect(external?.resolved).toEqual({ external: "external" });
      if (typeof external?.resolved === "string") {
        expect(path.basename(external.resolved)).not.toBe("external.rs");
      }

      const graph = await collectGraph(root, [lib, path.join(src, "external.rs")]);
      const fromLib = graph.edges.filter((edge) => path.basename(edge.from) === "lib.rs");
      expect(fromLib.some((edge) => edge.to.type === "file" && path.basename(edge.to.path) === "external.rs")).toBe(
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
