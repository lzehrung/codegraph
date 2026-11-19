import {
  RUST_SELECTOR_NAMESPACE_SOURCES,
  RUST_QUALIFIED_ITEM_FIXTURE,
  RUST_RETURN_RECORD_FIXTURE,
  selectorSite,
  expectMemberSelectorGoto,
  expectRustSelectorNamespace,
  expectRustQualifiedItemGoto,
  expectMemberSelectorReferences,
  withMemberSelectorFixture,
} from "../helpers/member-selector-fixture.js";
import {
  eachIndexMode,
  expectGoto,
  expectReferences,
  placeOf,
  withBatch3Fixture,
} from "../helpers/csharp-java-batch3-fixture.js";
import { execFileSync } from "node:child_process";
import fsp, { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { describeTypeParameterReceiverRows } from "../helpers/type-parameter-receiver-fixture.js";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { collectImportsForFile } from "../../src/indexer/imports.js";
import { parseRustImportStatements } from "../../src/languages/import-statement-parsers.js";
import {
  extractRustModPathAttribute,
  resolveRustImportPath,
  takeTrailingRustAttributes,
} from "../../src/util/resolution/rust.js";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { isSymlinkUnavailable } from "../helpers/filesystem.js";
import { LANG_CONFIGS } from "../../src/bootstrap/tree-sitter-languages.js";
import { chunkFile } from "../../src/chunking/chunk-file.js";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { createAgentSession, type AgentSession } from "../../src/agent/session.js";
import { previewRenameWithSession } from "../../src/agent/rename-preview.js";
import { clearMemoryCache, closeDiskCacheDatabase } from "../../src/indexer/build-cache.js";
import {
  buildProjectIndex,
  collectGraph,
  findReferences,
  goToDefinition,
  resolveExport,
  type ProjectIndex,
} from "../../src/index.js";
import { collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { exportedNameOf } from "../helpers/narrow.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { expectUnicodeSymbolRangeIdentity } from "./unicode-symbol-range.js";

function canCreateRustFileSymlink(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cg-rust-path-symlink-probe-"));
  try {
    const target = path.join(dir, "target.rs");
    writeFileSync(target, "\n");
    symlinkSync(target, path.join(dir, "link.rs"), "file");
    return true;
  } catch (error) {
    if (isSymlinkUnavailable(error)) return false;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pathCaseFoldsOnFilesystem(filePath: string): Promise<boolean> {
  const base = path.basename(filePath);
  const flipped = [...base]
    .map((character) => (character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase()))
    .join("");
  if (flipped === base) return false;
  try {
    const original = await fsp.stat(filePath);
    const other = await fsp.stat(path.join(path.dirname(filePath), flipped));
    return original.dev === other.dev && original.ino === other.ino;
  } catch {
    return false;
  }
}

async function expectReachableRustPathOwner(options: {
  root: string;
  fromFile: string;
  ownerFile: string;
  imported: string;
  files: string[];
  excludedBasenames: string[];
}): Promise<void> {
  const owner = await resolveRustImportPath(options.root, options.fromFile, "super");
  expect(owner?.replace(/\\/g, "/")).toBe(options.ownerFile.replace(/\\/g, "/"));
  for (const excluded of options.excludedBasenames) {
    expect(path.basename(owner ?? "")).not.toBe(excluded);
  }

  const imports = await collectImportsForFile(options.fromFile, options.root);
  const namedImport = imports.find((entry) => entry.kind === "named" && entry.imported === options.imported);
  expect(namedImport).toBeDefined();
  expect(typeof namedImport?.resolved).toBe("string");
  if (typeof namedImport?.resolved === "string") {
    expect(namedImport.resolved.replace(/\\/g, "/")).toBe(options.ownerFile.replace(/\\/g, "/"));
  }

  const graph = await collectGraph(options.root, options.files);
  expect(
    graph.edges.some(
      (edge) =>
        path.basename(edge.from) === path.basename(options.fromFile) &&
        edge.raw === `super::${options.imported}` &&
        edge.to.type === "file" &&
        path.basename(edge.to.path) === path.basename(options.ownerFile),
    ),
  ).toBe(true);
  for (const excluded of options.excludedBasenames) {
    expect(
      graph.edges.some(
        (edge) =>
          path.basename(edge.from) === path.basename(options.fromFile) &&
          edge.to.type === "file" &&
          path.basename(edge.to.path) === excluded,
      ),
    ).toBe(false);
  }
}

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

  it("resolves a macro invocation to its macro_rules! declaration without a graph call edge", async () => {
    const source =
      "macro_rules! make_answer {\n    () => { 42 };\n}\n\npub fn invoke() -> i32 {\n    make_answer!()\n}\n";
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-macro-invoke-"));
    try {
      await writeFile(path.join(root, "lib.rs"), source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      // A macro invocation names the macro, not a function call: goto answers with the
      // macro_rules! declaration, and the detailed graph records no calls edge for it.
      const goto = await goToDefinition(index, {
        file: path.join(root, "lib.rs"),
        line: 6,
        column: source.split("\n")[5]!.indexOf("make_answer") + 1,
      });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(goto.definition.localName).toBe("make_answer");
        expect(goto.definition.range.start.line).toBe(1);
      }

      const references = await findReferences(index, {
        file: path.join(root, "lib.rs"),
        line: 1,
        column: source.split("\n")[0]!.indexOf("make_answer") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(
          references.references.some(
            (reference) =>
              fileIdentityKey(reference.file) === fileIdentityKey(path.join(root, "lib.rs")) &&
              reference.range.start.line === 6,
          ),
        ).toBe(true);
      }

      const graph = await buildSymbolGraphDetailed(index);
      const invoke = [...graph.nodes.values()].find((node) => node.name === "invoke");
      expect(invoke).toBeDefined();
      expect(graph.edges.filter((edge) => edge.label === "calls" && edge.from === invoke?.id)).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records calls only inside standard expression macros, not macro_rules! bodies or custom macro input", async () => {
    const source = [
      "fn helper() -> i32 { 1 }",
      "pub fn run() -> i32 {",
      "    macro_rules! local { () => { helper() }; }",
      "    my_dsl!(helper(x));",
      '    println!("{}", helper());',
      "    my_dsl::println!(helper(x));",
      '    std::println!("{}", helper());',
      "    0",
      "}",
      "",
    ].join("\n");
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-macro-token-trees-"));
    try {
      await writeFile(path.join(root, "lib.rs"), source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      const run = [...graph.nodes.values()].find((node) => node.name === "run");
      const lines = graph.edges
        .filter((edge) => edge.label === "calls" && edge.from === run?.id)
        .map((edge) => edge.site?.range.start.line);
      // A macro_rules! body and a custom macro's input are raw tokens until expansion, including a
      // custom macro that shares a standard macro's name.
      expect(lines).toEqual([5, 7]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps member and path calls with comments after the separator unresolved inside macro arguments", async () => {
    const source = [
      "pub fn bump() -> i32 { 1 }",
      "pub fn run() -> i32 { 2 }",
      "pub struct Counter;",
      "impl Counter { pub fn bump(&self) -> i32 { 3 } }",
      "pub mod m { pub fn run() -> i32 { 4 } }",
      "pub fn caller(counter: &Counter) {",
      '    println!("{} {} {}", counter./* note */bump(), m::/* note */run(), bump());',
      "}",
      "",
    ].join("\n");
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-macro-comment-separator-"));
    const file = path.join(root, "lib.rs");
    try {
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const line = source.split("\n")[6]!;
      // The raw tokens cannot prove `counter`'s type or the `m::` path, so neither may fall back
      // to the free `bump`/`run`; the bare `bump()` still resolves.
      const member = await goToDefinition(index, { file, line: 7, column: line.indexOf("bump") + 1 });
      expect(member.status).toBe("not_found");
      const pathCall = await goToDefinition(index, { file, line: 7, column: line.indexOf("run") + 1 });
      expect(pathCall.status).toBe("not_found");
      const bare = await goToDefinition(index, { file, line: 7, column: line.lastIndexOf("bump") + 1 });
      expect(bare.status).toBe("ok");
      if (bare.status === "ok") expect(bare.definition.range.start.line).toBe(1);

      const graph = await buildSymbolGraphDetailed(index);
      const caller = [...graph.nodes.values()].find((node) => node.name === "caller");
      const calls = graph.edges.filter((edge) => edge.label === "calls" && edge.from === caller?.id);
      expect(calls.map((edge) => edge.site?.range.start.column)).toEqual([line.lastIndexOf("bump") + 1]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Rust explicit method receivers", () => {
  it("resolves trait default methods after inherent implementations, not decoy methods", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-trait-default-"));
    const file = path.join(root, "main.rs");
    const source = [
      "trait Greet { fn run(&self) -> i32 { 1 } }",
      "struct Decoy; impl Decoy { fn run(&self) -> i32 { -1 } }",
      "struct Derived; impl Greet for Derived {}",
      "fn call_derived() -> i32 { let d = Derived; d.run() }",
      "fn main() {}",
    ].join("\n");
    try {
      await writeFile(file, source);
      const index = await buildProjectIndex(root, { cache: "off" });
      const result = await goToDefinition(index, { file, line: 4, column: source.split("\n")[3]!.indexOf("run") + 1 });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(file));
        expect(result.definition.range.start.line).toBe(1);
        expect(result.definition.range.start.line).not.toBe(2);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a qualified call through an imported module without selecting another module", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-module-call-"));
    const src = path.join(root, "src");
    const use = path.join(src, "consumer.rs");
    const calc = path.join(src, "calc.rs");
    const decoy = path.join(src, "decoy.rs");
    try {
      await mkdir(src, { recursive: true });
      await Promise.all([
        writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "module-call"\nversion = "0.1.0"\n'),
        writeFile(path.join(src, "main.rs"), "fn main() {}\n"),
        writeFile(path.join(src, "lib.rs"), "pub mod calc; pub mod decoy; pub mod consumer;\n"),
        writeFile(calc, "pub fn add(a: i32, b: i32) -> i32 { a + b }\n"),
        writeFile(decoy, "pub fn add(a: i32, b: i32) -> i32 { -1 }\n"),
        writeFile(use, "use crate::calc;\npub fn sum_pair() -> i32 { calc::add(1, 2) }\n"),
      ]);
      const index = await buildProjectIndex(root, { cache: "off" });
      const result = await goToDefinition(index, { file: use, line: 2, column: 35 });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(calc));
        expect(fileIdentityKey(result.definition.file)).not.toBe(fileIdentityKey(decoy));
      }
      const graph = await buildSymbolGraphDetailed(index);
      const caller = [...graph.nodes.values()].find(
        (node) => node.name === "sum_pair" && fileIdentityKey(node.file) === fileIdentityKey(use),
      );
      const targets = graph.edges
        .filter((edge) => edge.from === caller?.id && edge.label === "calls")
        .map((edge) => graph.nodes.get(edge.to));
      expect(
        targets.some((target) => target?.name === "add" && fileIdentityKey(target.file) === fileIdentityKey(calc)),
      ).toBe(true);
      expect(targets.some((target) => target && fileIdentityKey(target.file) === fileIdentityKey(decoy))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      { kind: "member", from: "crate::a::b", imported: "Thing", local: "Renamed", explicitAlias: true },
      { kind: "member", from: "crate::a", imported: "A", local: "A" },
    ]);
    expect(parseRustImportStatements("use crate::a::b::{self, *};")).toEqual([
      { kind: "module", from: "crate::a::b", local: "b", isExternCrate: false },
      { kind: "star", from: "crate::a::b::*" },
    ]);
  });

  it("keeps path attributes whose raw or quoted value contains a closing bracket", () => {
    const rawSource = ['#[path = r#"custom]file.rs"#]', "mod external;"].join("\n");
    expect(takeTrailingRustAttributes(rawSource, rawSource.indexOf("mod"))).toContain("custom]file.rs");
    expect(parseRustImportStatements(rawSource)).toEqual([
      {
        kind: "module",
        from: "external",
        local: "external",
        isExternCrate: false,
        pathAttribute: "custom]file.rs",
      },
    ]);
    const quotedSource = ['#[path = "custom]file.rs"]', "mod external;"].join("\n");
    expect(takeTrailingRustAttributes(quotedSource, quotedSource.indexOf("mod"))).toContain("custom]file.rs");
    expect(parseRustImportStatements(quotedSource)).toEqual([
      {
        kind: "module",
        from: "external",
        local: "external",
        isExternCrate: false,
        pathAttribute: "custom]file.rs",
      },
    ]);
  });

  it("does not let nested, function, or test-only path attributes own a root module name", () => {
    const source = [
      "mod external;",
      "mod nested {",
      '    #[path = "nested_decoy.rs"]',
      "    mod external;",
      "}",
      "fn hide() {",
      '    #[path = "fn_decoy.rs"]',
      "    mod external;",
      "}",
      "#[cfg(test)]",
      '#[path = "test_decoy.rs"]',
      "mod external;",
      '#[path = "real.rs"]',
      "mod other;",
      "",
    ].join("\n");
    expect(extractRustModPathAttribute(source, "external")).toBeUndefined();
    expect(extractRustModPathAttribute(source, "other")).toBe("real.rs");
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

  it("keeps distinct conditional path modules and ignores module tokens inside attributes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-conditional-paths-"));
    const src = path.join(root, "src");
    const lib = path.join(src, "lib.rs");
    const unix = path.join(src, "unix.rs");
    const windows = path.join(src, "windows.rs");
    try {
      await mkdir(src, { recursive: true });
      await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "conditional-paths"\nversion = "0.1.0"\n');
      await writeFile(
        lib,
        ['#[cfg(unix)] #[path = "unix.rs"] mod platform;', '#[cfg(windows)] #[path = "windows.rs"] mod platform;'].join(
          "\n",
        ),
      );
      await writeFile(unix, "pub const UNIX: bool = true;\n");
      await writeFile(windows, "pub const WINDOWS: bool = true;\n");

      const bindings = await collectImportsForFile(lib, root);
      expect(bindings.map((entry) => entry.resolved).sort()).toEqual(
        [unix, windows].map((file) => file.replace(/\\/g, "/")).sort(),
      );

      const graph = await collectGraph(root, [lib, unix, windows]);
      const targets = graph.edges
        .filter((edge) => edge.from === lib.replace(/\\/g, "/") && edge.to.type === "file")
        .map((edge) => path.basename(edge.to.type === "file" ? edge.to.path : ""))
        .sort();
      expect(targets).toEqual(["unix.rs", "windows.rs"]);

      await writeFile(lib, "#[my_attr(mod hidden;)] fn f() {}\n");
      expect(await collectImportsForFile(lib, root)).toEqual([]);
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

  it("resolves a parent-declared #[path] module from a sibling consumer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-parent-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-parent"\nversion = "0.1.0"\n');
    await writeFile(path.join(src, "lib.rs"), '#[path = "custom.rs"]\nmod external;\npub mod consumer;\n');
    await writeFile(path.join(src, "custom.rs"), "pub struct Thing;\n");
    await writeFile(path.join(src, "external.rs"), "pub struct Decoy;\n");
    await writeFile(path.join(src, "consumer.rs"), "use crate::external::Thing;\n");
    try {
      const imports = await collectImportsForFile(path.join(src, "consumer.rs"), root);
      const thing = imports.find((entry) => entry.kind === "named" && entry.imported === "Thing");
      expect(thing).toBeDefined();
      expect(thing?.from).toBe("crate::external");
      expect(typeof thing?.resolved).toBe("string");
      if (typeof thing?.resolved === "string") {
        expect(path.basename(thing.resolved)).toBe("custom.rs");
        expect(path.basename(thing.resolved)).not.toBe("external.rs");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a nested parent-declared #[path] module through crate prefixes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-nested-"));
    const src = path.join(root, "src");
    await mkdir(path.join(src, "a"), { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-nested"\nversion = "0.1.0"\n');
    await writeFile(path.join(src, "lib.rs"), "mod a;\n");
    await writeFile(path.join(src, "a.rs"), '#[path = "custom.rs"]\nmod external;\n');
    await writeFile(path.join(src, "custom.rs"), "pub struct Thing;\n");
    await writeFile(path.join(src, "a", "external.rs"), "pub struct Decoy;\n");
    await writeFile(path.join(src, "consumer.rs"), "use crate::a::external::Thing;\n");
    try {
      const imports = await collectImportsForFile(path.join(src, "consumer.rs"), root);
      const thing = imports.find((entry) => entry.kind === "named" && entry.imported === "Thing");
      expect(thing).toBeDefined();
      expect(thing?.from).toBe("crate::a::external");
      expect(typeof thing?.resolved).toBe("string");
      if (typeof thing?.resolved === "string") {
        expect(path.basename(thing.resolved)).toBe("custom.rs");
        expect(path.basename(thing.resolved)).not.toBe("external.rs");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let an importer #[path] override a crate or nested conventional module", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-importer-"));
    const src = path.join(root, "src");
    await mkdir(path.join(src, "a"), { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-importer"\nversion = "0.1.0"\n');
    await writeFile(path.join(src, "lib.rs"), "mod a;\npub mod consumer;\n");
    await writeFile(path.join(src, "a.rs"), "pub mod child;\n");
    await writeFile(path.join(src, "a", "child.rs"), "pub struct ChildThing;\n");
    await writeFile(path.join(src, "custom.rs"), "pub struct Thing;\n");
    await writeFile(path.join(src, "external.rs"), "pub struct Decoy;\n");
    await writeFile(
      path.join(src, "consumer.rs"),
      [
        "use crate::a::child::ChildThing;",
        '#[path = "custom.rs"]',
        "mod child;",
        '#[path = "custom.rs"]',
        "mod external;",
        "pub fn consume() {",
        "    let _c = ChildThing;",
        "}",
        "",
      ].join("\n"),
    );
    try {
      const consumer = path.join(src, "consumer.rs");
      const imports = await collectImportsForFile(consumer, root);
      const child = imports.find((entry) => entry.kind === "named" && entry.imported === "ChildThing");
      expect(child?.from).toBe("crate::a::child");
      expect(typeof child?.resolved).toBe("string");
      if (typeof child?.resolved === "string") {
        expect(path.basename(child.resolved)).toBe("child.rs");
        expect(path.basename(child.resolved)).not.toBe("custom.rs");
      }
      const index = await buildProjectIndex(root, { cache: "off" });
      const usage = "    let _c = ChildThing;";
      const gone = await goToDefinition(index, {
        file: consumer,
        line: 7,
        column: usage.indexOf("ChildThing") + 1,
      });
      expect(gone.status).toBe("ok");
      if (gone.status === "ok") {
        expect(path.basename(gone.definition.file)).toBe("child.rs");
        expect(path.basename(gone.definition.file)).not.toBe("custom.rs");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an inline nested #[path] module without leaking it to the crate root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-scope-"));
    const src = path.join(root, "src");
    await mkdir(path.join(src, "nested"), { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-scope"\nversion = "0.1.0"\n');
    await writeFile(
      path.join(src, "lib.rs"),
      [
        "mod nested {",
        '    #[path = "nested_external.rs"]',
        "    pub mod external;",
        "}",
        "use crate::nested::external::NestedThing;",
        "use crate::external::RootThing;",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(src, "nested", "nested_external.rs"), "pub struct NestedThing;\n");
    await writeFile(path.join(src, "nested_external.rs"), "pub struct Decoy;\n");
    await writeFile(path.join(src, "external.rs"), "pub struct RootThing;\n");
    try {
      const lib = path.join(src, "lib.rs");
      const imports = await collectImportsForFile(lib, root);
      const resolvedName = (resolved: unknown) =>
        typeof resolved === "string" ? path.basename(resolved) : JSON.stringify(resolved);
      const nested = imports.find((entry) => entry.from === "crate::nested::external");
      const rootUse = imports.find((entry) => entry.from === "crate::external");
      expect(nested?.resolved).toBe(path.join(src, "nested", "nested_external.rs").replace(/\\/g, "/"));
      expect(imports.find((entry) => entry.kind === "namespace" && entry.localNS === "external")?.resolved).toBe(
        nested?.resolved,
      );
      expect(resolvedName(rootUse?.resolved)).toBe("external.rs");
      expect(resolvedName(rootUse?.resolved)).not.toBe("nested_external.rs");

      const nestedExternal = path.join(src, "nested", "nested_external.rs");
      const files = [lib, nestedExternal, path.join(src, "nested_external.rs"), path.join(src, "external.rs")];
      const graph = await collectGraph(root, files);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "lib.rs" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "nested_external.rs" &&
            edge.to.path.replace(/\\/g, "/").endsWith("/nested/nested_external.rs"),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a parent-declared #[path] module through goto and references", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-nav-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-nav"\nversion = "0.1.0"\n');
    await writeFile(path.join(src, "lib.rs"), '#[path = "custom.rs"]\nmod external;\npub mod consumer;\n');
    await writeFile(path.join(src, "custom.rs"), "pub struct Thing;\n");
    await writeFile(path.join(src, "external.rs"), "pub struct Decoy;\n");
    await writeFile(
      path.join(src, "consumer.rs"),
      ["use crate::external::Thing;", "pub fn consume() {", "    let _t = Thing;", "}", ""].join("\n"),
    );
    try {
      const custom = path.join(src, "custom.rs");
      const consumer = path.join(src, "consumer.rs");
      const index = await buildProjectIndex(root, { cache: "off" });
      const usage = "    let _t = Thing;";
      const gone = await goToDefinition(index, {
        file: consumer,
        line: 3,
        column: usage.indexOf("Thing") + 1,
      });
      expect(gone.status).toBe("ok");
      if (gone.status === "ok") {
        expect(path.basename(gone.definition.file)).toBe("custom.rs");
        expect(path.basename(gone.definition.file)).not.toBe("external.rs");
        expect(gone.definition.localName).toBe("Thing");
      }
      const refs = await findReferences(index, { file: custom, line: 1, column: 12 });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references.some((reference) => path.basename(reference.file) === "consumer.rs")).toBe(true);
        expect(refs.references.some((reference) => path.basename(reference.file) === "external.rs")).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves #[path] modules whose raw string contains a closing bracket", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-bracket-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-bracket"\nversion = "0.1.0"\n');
    await writeFile(path.join(src, "lib.rs"), '#[path = r#"custom]file.rs"#]\nmod external;\n');
    await writeFile(path.join(src, "custom]file.rs"), "pub fn from_custom() {}\n");
    await writeFile(path.join(src, "external.rs"), "pub fn from_external() {}\n");
    try {
      const imports = await collectImportsForFile(path.join(src, "lib.rs"), root);
      const external = imports.find((entry) => entry.kind === "namespace" && entry.localNS === "external");
      expect(external).toBeDefined();
      expect(typeof external?.resolved).toBe("string");
      if (typeof external?.resolved === "string") {
        expect(path.basename(external.resolved)).toBe("custom]file.rs");
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
      [
        "mod production;",
        "#[cfg(test)]",
        "mod tests;",
        "#[cfg(test)]",
        "pub mod vis_tests;",
        "#[cfg(test)]",
        "pub(crate) use crate::production::Prod as TestProd;",
        "use crate::production::Prod;",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(src, "production.rs"), "pub struct Prod;\n");
    await writeFile(path.join(src, "tests.rs"), "pub fn t() {}\n");
    await writeFile(path.join(src, "vis_tests.rs"), "pub fn vis() {}\n");
    try {
      const imports = await collectImportsForFile(path.join(src, "lib.rs"), root);
      expect(imports.some((entry) => entry.kind === "namespace" && entry.from === "tests")).toBe(false);
      expect(imports.some((entry) => entry.kind === "namespace" && entry.from === "vis_tests")).toBe(false);
      expect(imports.some((entry) => entry.kind === "named" && entry.local === "TestProd")).toBe(false);
      expect(imports.some((entry) => entry.kind === "namespace" && entry.from === "production")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not bind use statements inside macro_rules or macro invocation bodies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-macro-import-"));
    const lib = path.join(root, "lib.rs");
    await writeFile(
      lib,
      [
        "macro_rules! shim {",
        "    () => {",
        "        use fake::Thing;",
        "        mod hidden;",
        "    };",
        "}",
        "shim! {",
        "    use also_fake::Other;",
        "}",
        "use live::Visible;",
        "",
      ].join("\n"),
    );
    try {
      const imports = await collectImportsForFile(lib, root);
      expect(imports.map((entry) => entry.from)).toEqual(["live"]);
      expect(
        imports.some((entry) => entry.from === "fake" || entry.from === "also_fake" || entry.from === "hidden"),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps #[cfg(test)] modules with a #[path] attribute from becoming import bindings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-cfg-path-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "cfg-path"\nversion = "0.1.0"\n');
    await writeFile(
      path.join(src, "cfg.rs"),
      [
        "mod production;",
        "#[cfg(test)]",
        '#[path = "mod.rs"]',
        "mod tests;",
        '#[path = "real.rs"]',
        "mod other;",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(src, "production.rs"), "pub struct Prod;\n");
    await writeFile(path.join(src, "real.rs"), "pub fn r() {}\n");
    await mkdir(path.join(src, "tests"), { recursive: true });
    await writeFile(path.join(src, "tests", "mod.rs"), "pub fn t() {}\n");
    try {
      const cfg = path.join(src, "cfg.rs");
      const imports = await collectImportsForFile(cfg, root);
      expect(imports.some((entry) => entry.kind === "namespace" && entry.from === "tests")).toBe(false);
      expect(imports.some((entry) => entry.kind === "namespace" && entry.from === "production")).toBe(true);
      const other = imports.find((entry) => entry.kind === "namespace" && entry.from === "other");
      expect(typeof other?.resolved).toBe("string");
      if (typeof other?.resolved === "string") {
        expect(path.basename(other.resolved)).toBe("real.rs");
      }

      const files = [
        cfg,
        path.join(src, "production.rs"),
        path.join(src, "real.rs"),
        path.join(src, "tests", "mod.rs"),
      ];
      const graph = await collectGraph(root, files);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "cfg.rs" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "mod.rs",
        ),
      ).toBe(false);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "cfg.rs" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "real.rs",
        ),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "cfg.rs" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "production.rs",
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves super from a #[path] module against the declaring module, not the crate root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-super-"));
    const src = path.join(root, "src");
    await mkdir(path.join(src, "a"), { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-super"\nversion = "0.1.0"\n');
    await writeFile(path.join(src, "lib.rs"), "mod a;\n");
    await writeFile(path.join(src, "a.rs"), '#[path = "custom.rs"]\nmod child;\npub mod sibling;\n');
    await writeFile(
      path.join(src, "custom.rs"),
      "use super::sibling;\nuse self::grandchild;\npub fn from_child() { sibling::from_sibling(); }\n",
    );
    await writeFile(path.join(src, "a", "sibling.rs"), "pub fn from_sibling() {}\n");
    await writeFile(path.join(src, "sibling.rs"), "pub fn from_root_sibling() {}\n");
    await writeFile(path.join(src, "grandchild.rs"), "pub fn from_grandchild() {}\n");
    await writeFile(path.join(src, "a", "grandchild.rs"), "pub fn from_wrong_grandchild() {}\n");
    try {
      const custom = path.join(src, "custom.rs");
      const sibling = path.join(src, "a", "sibling.rs");
      const decoy = path.join(src, "sibling.rs");
      const resolvedSuper = await resolveRustImportPath(root, custom, "super::sibling");
      const resolvedSelf = await resolveRustImportPath(root, custom, "self::grandchild");
      expect(resolvedSuper?.replace(/\\/g, "/")).toBe(sibling.replace(/\\/g, "/"));
      expect(resolvedSuper?.replace(/\\/g, "/")).not.toBe(decoy.replace(/\\/g, "/"));
      expect(resolvedSelf?.replace(/\\/g, "/")).toBe(path.join(src, "grandchild.rs").replace(/\\/g, "/"));
      expect(resolvedSelf?.replace(/\\/g, "/")).not.toBe(path.join(src, "a", "grandchild.rs").replace(/\\/g, "/"));

      const imports = await collectImportsForFile(custom, root);
      const siblingImport = imports.find((entry) => entry.kind === "named" && entry.imported === "sibling");
      expect(typeof siblingImport?.resolved).toBe("string");
      if (typeof siblingImport?.resolved === "string") {
        expect(siblingImport.resolved.replace(/\\/g, "/")).toBe(path.join(src, "a.rs").replace(/\\/g, "/"));
      }

      const files = [
        path.join(src, "lib.rs"),
        path.join(src, "a.rs"),
        custom,
        sibling,
        decoy,
        path.join(src, "grandchild.rs"),
        path.join(src, "a", "grandchild.rs"),
      ];
      const graph = await collectGraph(root, files);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "custom.rs" &&
            edge.raw === "super::sibling" &&
            edge.to.type === "file" &&
            edge.to.path.replace(/\\/g, "/").endsWith("/a/sibling.rs"),
        ),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "custom.rs" &&
            edge.to.type === "file" &&
            edge.to.path.replace(/\\/g, "/").endsWith("/src/sibling.rs"),
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not take a #[path] attribute from a commented or string mod declaration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-comment-mod-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "comment-mod"\nversion = "0.1.0"\n');
    await writeFile(
      path.join(src, "lib.rs"),
      [
        "/*",
        '#[path = "commented.rs"]',
        "mod external;",
        "*/",
        'const TEXT: &str = r#"',
        '#[path = "commented.rs"]',
        "mod external;",
        '"#;',
        "mod external;",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(src, "commented.rs"), "pub fn from_commented() {}\n");
    await writeFile(path.join(src, "external.rs"), "pub fn from_external() {}\n");
    try {
      const imports = await collectImportsForFile(path.join(src, "lib.rs"), root);
      const external = imports.find((entry) => entry.kind === "namespace" && entry.localNS === "external");
      expect(external).toBeDefined();
      expect(typeof external?.resolved).toBe("string");
      if (typeof external?.resolved === "string") {
        expect(path.basename(external.resolved)).toBe("external.rs");
        expect(path.basename(external.resolved)).not.toBe("commented.rs");
      }
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

  it("keeps a #[path] module outside the project root external", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-root-outside-"));
    const root = path.join(sandbox, "project");
    await mkdir(root, { recursive: true });
    const outside = path.join(sandbox, "outside.rs");
    await writeFile(outside, "pub fn leaked() {}\n");
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-outside"\nversion = "0.1.0"\n');
    const lib = path.join(root, "lib.rs");
    await writeFile(lib, '#[path = "../outside.rs"]\nmod leaked;\n');
    try {
      const imports = await collectImportsForFile(lib, root);
      const leaked = imports.find((entry) => entry.kind === "namespace" && entry.localNS === "leaked");
      const graph = await collectGraph(root, [lib]);
      const edgeTargets = graph.edges
        .filter((edge) => path.basename(edge.from) === "lib.rs")
        .map((edge) => (edge.to.type === "file" ? edge.to.path.replace(/\\/g, "/") : `external:${edge.to.name}`));
      const outsidePath = outside.replace(/\\/g, "/");

      expect(leaked).toBeDefined();
      expect(leaked?.resolved).toEqual({ external: "leaked" });
      if (typeof leaked?.resolved === "string") {
        expect(leaked.resolved.replace(/\\/g, "/")).not.toBe(outsidePath);
      }
      expect(edgeTargets).toContain("external:leaked");
      expect(edgeTargets).not.toContain(outsidePath);
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

  it("resolves #[path] modules when comments separate the attribute from the item", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-attr-comment-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-attr-comment"\nversion = "0.1.0"\n');
    await writeFile(
      path.join(src, "lib.rs"),
      [
        '#[path = "custom.rs"] // pick custom',
        "mod same_line;",
        "",
        '#[path = "custom.rs"]',
        "// pick custom",
        "mod own_line;",
        "",
        '#[path = "custom.rs"] /* outer /* inner */ still */',
        "mod nested;",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(src, "custom.rs"), "pub fn from_custom() {}\n");
    await writeFile(path.join(src, "same_line.rs"), "pub fn from_same_line() {}\n");
    await writeFile(path.join(src, "own_line.rs"), "pub fn from_own_line() {}\n");
    await writeFile(path.join(src, "nested.rs"), "pub fn from_nested() {}\n");
    try {
      const imports = await collectImportsForFile(path.join(src, "lib.rs"), root);
      for (const localNS of ["same_line", "own_line", "nested"]) {
        const binding = imports.find((entry) => entry.kind === "namespace" && entry.localNS === localNS);
        expect(binding).toBeDefined();
        expect(typeof binding?.resolved).toBe("string");
        if (typeof binding?.resolved === "string") {
          expect(path.basename(binding.resolved)).toBe("custom.rs");
          expect(path.basename(binding.resolved)).not.toBe(`${localNS}.rs`);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!canCreateRustFileSymlink())(
    "does not bind an in-root #[path] symlink whose real path escapes the project",
    async () => {
      const sandbox = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-attr-symlink-"));
      const root = path.join(sandbox, "project");
      const src = path.join(root, "src");
      await mkdir(src, { recursive: true });
      await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-attr-symlink"\nversion = "0.1.0"\n');
      const outside = path.join(sandbox, "outside.rs");
      const linked = path.join(src, "linked.rs");
      await writeFile(outside, "pub fn leaked() {}\n");
      await writeFile(path.join(src, "leaked.rs"), "pub fn conventional() {}\n");
      await writeFile(path.join(src, "lib.rs"), '#[path = "linked.rs"]\nmod leaked;\n');
      try {
        try {
          await symlink(outside, linked, "file");
        } catch (error) {
          if (isSymlinkUnavailable(error)) return;
          throw error;
        }
        const imports = await collectImportsForFile(path.join(src, "lib.rs"), root);
        const leaked = imports.find((entry) => entry.kind === "namespace" && entry.localNS === "leaked");
        expect(leaked).toBeDefined();
        expect(leaked?.resolved).toEqual({ external: "leaked" });
        if (typeof leaked?.resolved === "string") {
          expect(path.basename(leaked.resolved)).not.toBe("linked.rs");
          expect(path.basename(leaked.resolved)).not.toBe("leaked.rs");
          expect(leaked.resolved.replace(/\\/g, "/")).not.toContain("outside.rs");
        }
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    },
  );

  it("resolves super to the module that actually declares the #[path] target, not an undeclared decoy in the same directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-orphan-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-owner"\nversion = "0.1.0"\n');
    await writeFile(path.join(src, "lib.rs"), "mod real;\npub struct RootThing;\n");
    await writeFile(path.join(src, "real.rs"), '#[path = "shared.rs"]\nmod shared;\npub struct RealThing;\n');
    await writeFile(path.join(src, "aaa_orphan.rs"), '#[path = "shared.rs"]\nmod shared;\npub struct OrphanThing;\n');
    await writeFile(path.join(src, "shared.rs"), "use super::RealThing;\npub fn take(_v: RealThing) {}\n");
    try {
      const shared = path.join(src, "shared.rs");
      const real = path.join(src, "real.rs");
      const orphan = path.join(src, "aaa_orphan.rs");

      const owner = await resolveRustImportPath(root, shared, "super");
      expect(owner?.replace(/\\/g, "/")).toBe(real.replace(/\\/g, "/"));
      expect(owner?.replace(/\\/g, "/")).not.toBe(orphan.replace(/\\/g, "/"));

      const imports = await collectImportsForFile(shared, root);
      const realThingImport = imports.find((entry) => entry.kind === "named" && entry.imported === "RealThing");
      expect(realThingImport).toBeDefined();
      expect(typeof realThingImport?.resolved).toBe("string");
      if (typeof realThingImport?.resolved === "string") {
        expect(realThingImport.resolved.replace(/\\/g, "/")).toBe(real.replace(/\\/g, "/"));
        expect(realThingImport.resolved.replace(/\\/g, "/")).not.toBe(orphan.replace(/\\/g, "/"));
      }

      const files = [path.join(src, "lib.rs"), real, orphan, shared];
      const graph = await collectGraph(root, files);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.raw === "super::RealThing" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "real.rs",
        ),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.raw === "super::RealThing" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "aaa_orphan.rs",
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves super to a reachable ancestor owner over a nearer undeclared decoy in the target's own directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-ancestor-"));
    const src = path.join(root, "src");
    const nested = path.join(src, "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-owner-ancestor"\nversion = "0.1.0"\n');
    await writeFile(path.join(src, "lib.rs"), "mod outer;\n");
    await writeFile(path.join(src, "outer.rs"), '#[path = "nested/shared.rs"]\nmod shared;\npub struct OuterThing;\n');
    await writeFile(path.join(nested, "zz_decoy.rs"), '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
    await writeFile(path.join(nested, "shared.rs"), "use super::OuterThing;\npub fn take(_v: OuterThing) {}\n");
    try {
      const shared = path.join(nested, "shared.rs");
      const outer = path.join(src, "outer.rs");
      const decoy = path.join(nested, "zz_decoy.rs");

      const owner = await resolveRustImportPath(root, shared, "super");
      expect(owner?.replace(/\\/g, "/")).toBe(outer.replace(/\\/g, "/"));
      expect(owner?.replace(/\\/g, "/")).not.toBe(decoy.replace(/\\/g, "/"));

      const imports = await collectImportsForFile(shared, root);
      const outerThingImport = imports.find((entry) => entry.kind === "named" && entry.imported === "OuterThing");
      expect(outerThingImport).toBeDefined();
      expect(typeof outerThingImport?.resolved).toBe("string");
      if (typeof outerThingImport?.resolved === "string") {
        expect(outerThingImport.resolved.replace(/\\/g, "/")).toBe(outer.replace(/\\/g, "/"));
        expect(outerThingImport.resolved.replace(/\\/g, "/")).not.toBe(decoy.replace(/\\/g, "/"));
      }

      const files = [path.join(src, "lib.rs"), outer, decoy, shared];
      const graph = await collectGraph(root, files);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.raw === "super::OuterThing" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "outer.rs",
        ),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.raw === "super::OuterThing" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "zz_decoy.rs",
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves super to the reachable owner regardless of undeclared decoy directory-entry order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-order-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-owner-order"\nversion = "0.1.0"\n');
    await writeFile(path.join(src, "lib.rs"), "mod real;\npub struct RootThing;\n");
    await writeFile(path.join(src, "real.rs"), '#[path = "shared.rs"]\nmod shared;\npub struct RealThing;\n');
    await writeFile(path.join(src, "aaa_orphan.rs"), '#[path = "shared.rs"]\nmod shared;\npub struct OrphanThing;\n');
    await writeFile(
      path.join(src, "zzz_orphan.rs"),
      '#[path = "shared.rs"]\nmod shared;\npub struct OtherOrphanThing;\n',
    );
    await writeFile(path.join(src, "shared.rs"), "use super::RealThing;\npub fn take(_v: RealThing) {}\n");
    try {
      const shared = path.join(src, "shared.rs");
      const real = path.join(src, "real.rs");
      const aaaOrphan = path.join(src, "aaa_orphan.rs");
      const zzzOrphan = path.join(src, "zzz_orphan.rs");

      const owner = await resolveRustImportPath(root, shared, "super");
      expect(owner?.replace(/\\/g, "/")).toBe(real.replace(/\\/g, "/"));
      expect(owner?.replace(/\\/g, "/")).not.toBe(aaaOrphan.replace(/\\/g, "/"));
      expect(owner?.replace(/\\/g, "/")).not.toBe(zzzOrphan.replace(/\\/g, "/"));

      const imports = await collectImportsForFile(shared, root);
      const realThingImport = imports.find((entry) => entry.kind === "named" && entry.imported === "RealThing");
      expect(realThingImport).toBeDefined();
      expect(typeof realThingImport?.resolved).toBe("string");
      if (typeof realThingImport?.resolved === "string") {
        expect(realThingImport.resolved.replace(/\\/g, "/")).toBe(real.replace(/\\/g, "/"));
        expect(realThingImport.resolved.replace(/\\/g, "/")).not.toBe(aaaOrphan.replace(/\\/g, "/"));
        expect(realThingImport.resolved.replace(/\\/g, "/")).not.toBe(zzzOrphan.replace(/\\/g, "/"));
      }

      const files = [path.join(src, "lib.rs"), real, aaaOrphan, zzzOrphan, shared];
      const graph = await collectGraph(root, files);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.raw === "super::RealThing" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "real.rs",
        ),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.raw === "super::RealThing" &&
            edge.to.type === "file" &&
            (path.basename(edge.to.path) === "aaa_orphan.rs" || path.basename(edge.to.path) === "zzz_orphan.rs"),
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves super unresolved, not falling back to any parent, when two reachable modules declare the same #[path] target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-ambiguous-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-owner-ambiguous"\nversion = "0.1.0"\n');
    await writeFile(path.join(src, "lib.rs"), "mod one;\nmod two;\n");
    await writeFile(path.join(src, "one.rs"), '#[path = "shared.rs"]\nmod shared;\npub struct OneThing;\n');
    await writeFile(path.join(src, "two.rs"), '#[path = "shared.rs"]\nmod shared;\npub struct TwoThing;\n');
    await writeFile(path.join(src, "shared.rs"), "use super::OneThing;\npub fn take(_v: OneThing) {}\n");
    try {
      const shared = path.join(src, "shared.rs");
      const lib = path.join(src, "lib.rs");
      const one = path.join(src, "one.rs");
      const two = path.join(src, "two.rs");

      const owner = await resolveRustImportPath(root, shared, "super");
      expect(owner).toBeNull();

      const imports = await collectImportsForFile(shared, root);
      const oneThingImport = imports.find((entry) => entry.kind === "named" && entry.imported === "OneThing");
      expect(oneThingImport).toBeDefined();
      expect(oneThingImport?.resolved).toEqual({ external: "super" });

      const files = [lib, one, two, shared];
      const graph = await collectGraph(root, files);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" && edge.raw === "super::OneThing" && edge.to.type === "file",
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves super through a module only a binary target declares", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-bin-"));
    const src = path.join(root, "src");
    const bin = path.join(src, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-owner-bin"\nversion = "0.1.0"\n');
    await writeFile(
      path.join(bin, "tool.rs"),
      '#[path = "../shared.rs"]\nmod shared;\npub struct ToolThing;\nfn main() {}\n',
    );
    await writeFile(path.join(src, "aaa_decoy.rs"), '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
    await writeFile(path.join(src, "shared.rs"), "use super::ToolThing;\npub fn take(_v: ToolThing) {}\n");
    try {
      const shared = path.join(src, "shared.rs");
      const tool = path.join(bin, "tool.rs");
      const decoy = path.join(src, "aaa_decoy.rs");

      const owner = await resolveRustImportPath(root, shared, "super");
      expect(owner?.replace(/\\/g, "/")).toBe(tool.replace(/\\/g, "/"));

      const imports = await collectImportsForFile(shared, root);
      const toolImport = imports.find((entry) => entry.kind === "named" && entry.imported === "ToolThing");
      expect(typeof toolImport?.resolved).toBe("string");
      if (typeof toolImport?.resolved === "string") {
        expect(toolImport.resolved.replace(/\\/g, "/")).toBe(tool.replace(/\\/g, "/"));
      }

      const graph = await collectGraph(root, [tool, decoy, shared]);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "aaa_decoy.rs",
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves super from both cfg-gated #[path] modules to the declaring crate root, not an undeclared decoy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-platform-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-owner-platform"\nversion = "0.1.0"\n');
    await writeFile(
      path.join(src, "lib.rs"),
      [
        "#[cfg(unix)]",
        '#[path = "unix.rs"]',
        "mod platform;",
        "#[cfg(windows)]",
        '#[path = "windows.rs"]',
        "mod platform;",
        "pub struct RootThing;",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(src, "unix.rs"), "use super::RootThing;\n");
    await writeFile(path.join(src, "windows.rs"), "use super::RootThing;\n");
    await writeFile(path.join(src, "aaa_decoy.rs"), '#[path = "windows.rs"]\nmod platform;\npub struct DecoyThing;\n');
    try {
      const lib = path.join(src, "lib.rs");
      const unix = path.join(src, "unix.rs");
      const windows = path.join(src, "windows.rs");
      const decoy = path.join(src, "aaa_decoy.rs");

      const unixOwner = await resolveRustImportPath(root, unix, "super");
      expect(unixOwner?.replace(/\\/g, "/")).toBe(lib.replace(/\\/g, "/"));
      expect(unixOwner?.replace(/\\/g, "/")).not.toBe(decoy.replace(/\\/g, "/"));

      const windowsOwner = await resolveRustImportPath(root, windows, "super");
      expect(windowsOwner?.replace(/\\/g, "/")).toBe(lib.replace(/\\/g, "/"));
      expect(windowsOwner?.replace(/\\/g, "/")).not.toBe(decoy.replace(/\\/g, "/"));

      for (const file of [unix, windows]) {
        const imports = await collectImportsForFile(file, root);
        const rootThingImport = imports.find((entry) => entry.kind === "named" && entry.imported === "RootThing");
        expect(rootThingImport).toBeDefined();
        expect(typeof rootThingImport?.resolved).toBe("string");
        if (typeof rootThingImport?.resolved === "string") {
          expect(rootThingImport.resolved.replace(/\\/g, "/")).toBe(lib.replace(/\\/g, "/"));
          expect(rootThingImport.resolved.replace(/\\/g, "/")).not.toBe(decoy.replace(/\\/g, "/"));
        }
      }

      const graph = await collectGraph(root, [lib, unix, windows, decoy]);
      for (const fromFile of ["unix.rs", "windows.rs"]) {
        expect(
          graph.edges.some(
            (edge) =>
              path.basename(edge.from) === fromFile &&
              edge.raw === "super::RootThing" &&
              edge.to.type === "file" &&
              path.basename(edge.to.path) === "lib.rs",
          ),
        ).toBe(true);
        expect(
          graph.edges.some(
            (edge) =>
              path.basename(edge.from) === fromFile &&
              edge.to.type === "file" &&
              path.basename(edge.to.path) === "aaa_decoy.rs",
          ),
        ).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves super through a module only a build-script target declares", async () => {
    const runBuildScriptCase = async (options: {
      prefix: string;
      cargoToml: string;
      buildRelative: string;
      pathValue: string;
    }): Promise<void> => {
      const root = await mkdtemp(path.join(os.tmpdir(), options.prefix));
      const src = path.join(root, "src");
      const buildFile = path.join(root, options.buildRelative);
      await mkdir(src, { recursive: true });
      await mkdir(path.dirname(buildFile), { recursive: true });
      await writeFile(path.join(root, "Cargo.toml"), options.cargoToml);
      await writeFile(
        buildFile,
        `#[path = "${options.pathValue}"]\nmod generated;\npub struct BuildThing;\nfn main() {}\n`,
      );
      await writeFile(
        path.join(src, "aaa_decoy.rs"),
        '#[path = "generated.rs"]\nmod generated;\npub struct DecoyThing;\n',
      );
      await writeFile(path.join(src, "generated.rs"), "use super::BuildThing;\npub fn take(_v: BuildThing) {}\n");
      try {
        const generated = path.join(src, "generated.rs");
        const decoy = path.join(src, "aaa_decoy.rs");

        const owner = await resolveRustImportPath(root, generated, "super");
        expect(owner?.replace(/\\/g, "/")).toBe(buildFile.replace(/\\/g, "/"));
        expect(owner?.replace(/\\/g, "/")).not.toBe(decoy.replace(/\\/g, "/"));

        const imports = await collectImportsForFile(generated, root);
        const buildThingImport = imports.find((entry) => entry.kind === "named" && entry.imported === "BuildThing");
        expect(buildThingImport).toBeDefined();
        expect(typeof buildThingImport?.resolved).toBe("string");
        if (typeof buildThingImport?.resolved === "string") {
          expect(buildThingImport.resolved.replace(/\\/g, "/")).toBe(buildFile.replace(/\\/g, "/"));
          expect(buildThingImport.resolved.replace(/\\/g, "/")).not.toBe(decoy.replace(/\\/g, "/"));
        }

        const graph = await collectGraph(root, [buildFile, decoy, generated]);
        expect(
          graph.edges.some(
            (edge) =>
              path.basename(edge.from) === "generated.rs" &&
              edge.raw === "super::BuildThing" &&
              edge.to.type === "file" &&
              path.basename(edge.to.path) === path.basename(buildFile),
          ),
        ).toBe(true);
        expect(
          graph.edges.some(
            (edge) =>
              path.basename(edge.from) === "generated.rs" &&
              edge.to.type === "file" &&
              path.basename(edge.to.path) === "aaa_decoy.rs",
          ),
        ).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };

    await runBuildScriptCase({
      prefix: "cg-rust-path-owner-build-",
      cargoToml: '[package]\nname = "path-owner-build"\nversion = "0.1.0"\n',
      buildRelative: "build.rs",
      pathValue: "src/generated.rs",
    });
    await runBuildScriptCase({
      prefix: "cg-rust-path-owner-build-custom-",
      cargoToml: '[package]\nname = "path-owner-build-custom"\nversion = "0.1.0"\nbuild = "tools/build.rs"\n',
      buildRelative: path.join("tools", "build.rs"),
      pathValue: "../src/generated.rs",
    });
  });

  it("resolves super through a custom library path and ignores a stray src/lib.rs that Cargo does not build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-custom-lib-"));
    const src = path.join(root, "src");
    const customDir = path.join(root, "custom");
    await mkdir(src, { recursive: true });
    await mkdir(customDir, { recursive: true });
    await writeFile(
      path.join(root, "Cargo.toml"),
      '[package]\nname = "path-owner-custom-lib"\nversion = "0.1.0"\n\n[lib]\npath = "custom/root.rs"\n',
    );
    const customRoot = path.join(customDir, "root.rs");
    const strayLib = path.join(src, "lib.rs");
    const shared = path.join(src, "shared.rs");
    await writeFile(customRoot, '#[path = "../src/shared.rs"]\nmod shared;\npub struct CustomThing;\n');
    await writeFile(strayLib, '#[path = "shared.rs"]\nmod shared;\npub struct StrayThing;\n');
    await writeFile(shared, "use super::CustomThing;\npub fn take(_v: CustomThing) {}\n");
    try {
      const owner = await resolveRustImportPath(root, shared, "super");
      expect(owner?.replace(/\\/g, "/")).toBe(customRoot.replace(/\\/g, "/"));
      expect(owner?.replace(/\\/g, "/")).not.toBe(strayLib.replace(/\\/g, "/"));

      const imports = await collectImportsForFile(shared, root);
      const customThingImport = imports.find((entry) => entry.kind === "named" && entry.imported === "CustomThing");
      expect(customThingImport).toBeDefined();
      expect(typeof customThingImport?.resolved).toBe("string");
      if (typeof customThingImport?.resolved === "string") {
        expect(customThingImport.resolved.replace(/\\/g, "/")).toBe(customRoot.replace(/\\/g, "/"));
        expect(customThingImport.resolved.replace(/\\/g, "/")).not.toBe(strayLib.replace(/\\/g, "/"));
      }

      const graph = await collectGraph(root, [customRoot, strayLib, shared]);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.raw === "super::CustomThing" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "root.rs",
        ),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "lib.rs",
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves super without treating src/main.rs as a crate root when autobins is false", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-autobins-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(
      path.join(root, "Cargo.toml"),
      '[package]\nname = "path-owner-autobins"\nversion = "0.1.0"\nautobins = false\n',
    );
    await writeFile(path.join(src, "lib.rs"), "mod real;\n");
    const real = path.join(src, "real.rs");
    const main = path.join(src, "main.rs");
    const shared = path.join(src, "shared.rs");
    await writeFile(real, '#[path = "shared.rs"]\nmod shared;\npub struct RealThing;\n');
    await writeFile(main, '#[path = "shared.rs"]\nmod shared;\nfn main() {}\n');
    await writeFile(shared, "use super::RealThing;\npub fn take(_v: RealThing) {}\n");
    try {
      const owner = await resolveRustImportPath(root, shared, "super");
      expect(owner?.replace(/\\/g, "/")).toBe(real.replace(/\\/g, "/"));
      expect(owner?.replace(/\\/g, "/")).not.toBe(main.replace(/\\/g, "/"));

      const imports = await collectImportsForFile(shared, root);
      const realThingImport = imports.find((entry) => entry.kind === "named" && entry.imported === "RealThing");
      expect(realThingImport).toBeDefined();
      expect(typeof realThingImport?.resolved).toBe("string");
      if (typeof realThingImport?.resolved === "string") {
        expect(realThingImport.resolved.replace(/\\/g, "/")).toBe(real.replace(/\\/g, "/"));
      }

      const graph = await collectGraph(root, [path.join(src, "lib.rs"), real, main, shared]);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.raw === "super::RealThing" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "real.rs",
        ),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "main.rs",
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds the crate module tree after a missing explicit library root appears", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-late-root-"));
    const src = path.join(root, "src");
    const customDir = path.join(root, "custom");
    await mkdir(src, { recursive: true });
    await mkdir(customDir, { recursive: true });
    await writeFile(
      path.join(root, "Cargo.toml"),
      '[package]\nname = "path-owner-late-root"\nversion = "0.1.0"\n\n[lib]\npath = "custom/root.rs"\n',
    );
    const decoy = path.join(src, "aaa_decoy.rs");
    const shared = path.join(src, "shared.rs");
    const customRoot = path.join(customDir, "root.rs");
    await writeFile(decoy, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
    await writeFile(shared, "use super::CustomThing;\npub fn take(_v: CustomThing) {}\n");
    try {
      const firstOwner = await resolveRustImportPath(root, shared, "super");
      expect(firstOwner?.replace(/\\/g, "/")).toBe(decoy.replace(/\\/g, "/"));

      await writeFile(customRoot, '#[path = "../src/shared.rs"]\nmod shared;\npub struct CustomThing;\n');
      // Wait past RUST_MODULE_TREE_REVALIDATE_INTERVAL_MS (100) so probed missing-path signatures are re-stat'd.
      await delay(150);

      const secondOwner = await resolveRustImportPath(root, shared, "super");
      expect(secondOwner?.replace(/\\/g, "/")).toBe(customRoot.replace(/\\/g, "/"));
      expect(secondOwner?.replace(/\\/g, "/")).not.toBe(decoy.replace(/\\/g, "/"));

      const imports = await collectImportsForFile(shared, root);
      const customThingImport = imports.find((entry) => entry.kind === "named" && entry.imported === "CustomThing");
      expect(typeof customThingImport?.resolved).toBe("string");
      if (typeof customThingImport?.resolved === "string") {
        expect(customThingImport.resolved.replace(/\\/g, "/")).toBe(customRoot.replace(/\\/g, "/"));
      }

      const graph = await collectGraph(root, [customRoot, decoy, shared]);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.raw === "super::CustomThing" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "root.rs",
        ),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "aaa_decoy.rs",
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a #[path] owner after the attributed target appears without using a stale existence cache", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-late-target-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-owner-late-target"\nversion = "0.1.0"\n');
    const lib = path.join(src, "lib.rs");
    const decoy = path.join(src, "aaa_decoy.rs");
    const shared = path.join(src, "shared.rs");
    await writeFile(lib, '#[path = "shared.rs"]\nmod shared;\npub struct RootThing;\n');
    await writeFile(decoy, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
    try {
      // Prime the module tree and the process-wide fileExists cache while shared.rs is missing.
      await resolveRustImportPath(root, decoy, "super");

      await writeFile(shared, "use super::RootThing;\npub fn take(_v: RootThing) {}\n");
      // Wait past RUST_MODULE_TREE_REVALIDATE_INTERVAL_MS (100) so the missing-target signature is re-stat'd.
      await delay(150);

      const owner = await resolveRustImportPath(root, shared, "super");
      expect(owner?.replace(/\\/g, "/")).toBe(lib.replace(/\\/g, "/"));
      expect(owner?.replace(/\\/g, "/")).not.toBe(decoy.replace(/\\/g, "/"));

      const imports = await collectImportsForFile(shared, root);
      const rootThingImport = imports.find((entry) => entry.kind === "named" && entry.imported === "RootThing");
      expect(typeof rootThingImport?.resolved).toBe("string");
      if (typeof rootThingImport?.resolved === "string") {
        expect(rootThingImport.resolved.replace(/\\/g, "/")).toBe(lib.replace(/\\/g, "/"));
      }

      const graph = await collectGraph(root, [lib, decoy, shared]);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.raw === "super::RootThing" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "lib.rs",
        ),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" &&
            edge.to.type === "file" &&
            path.basename(edge.to.path) === "aaa_decoy.rs",
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves super through an explicit named bin without path when autobins is false", async () => {
    const cases = [
      {
        prefix: "cg-rust-path-owner-named-bin-",
        cargoToml:
          '[package]\nname = "named-bin"\nversion = "0.1.0"\nautobins = false\nautolib = false\n\n[[bin]]\nname = "tool"\n',
        ownerRelative: path.join("src", "bin", "tool.rs"),
        pathValue: "../shared.rs",
      },
      {
        prefix: "cg-rust-path-owner-named-bin-dir-",
        cargoToml:
          '[package]\nname = "named-bin-dir"\nversion = "0.1.0"\nautobins = false\nautolib = false\n\n[[bin]]\nname = "tool"\n',
        ownerRelative: path.join("src", "bin", "tool", "main.rs"),
        pathValue: "../../shared.rs",
      },
      {
        prefix: "cg-rust-path-owner-named-example-",
        cargoToml:
          '[package]\nname = "named-example"\nversion = "0.1.0"\nautoexamples = false\nautolib = false\n\n[[example]]\nname = "demo"\n',
        ownerRelative: path.join("examples", "demo.rs"),
        pathValue: "../src/shared.rs",
      },
    ] as const;
    for (const testCase of cases) {
      const root = await mkdtemp(path.join(os.tmpdir(), testCase.prefix));
      const src = path.join(root, "src");
      await mkdir(src, { recursive: true });
      await mkdir(path.dirname(path.join(root, testCase.ownerRelative)), { recursive: true });
      await writeFile(path.join(root, "Cargo.toml"), testCase.cargoToml);
      const ownerFile = path.join(root, testCase.ownerRelative);
      const decoy = path.join(src, "aaa_decoy.rs");
      const shared = path.join(src, "shared.rs");
      await writeFile(ownerFile, `#[path = "${testCase.pathValue}"]\nmod shared;\npub struct NamedThing;\n`);
      await writeFile(decoy, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
      await writeFile(shared, "use super::NamedThing;\npub fn take(_v: NamedThing) {}\n");
      try {
        await expectReachableRustPathOwner({
          root,
          fromFile: shared,
          ownerFile,
          imported: "NamedThing",
          files: [ownerFile, decoy, shared],
          excludedBasenames: ["aaa_decoy.rs", "lib.rs"],
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("resolves super through an explicit [lib] table when autolib is false", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-explicit-lib-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(
      path.join(root, "Cargo.toml"),
      '[package]\nname = "explicit-lib"\nversion = "0.1.0"\nautolib = false\n\n[lib]\n',
    );
    const lib = path.join(src, "lib.rs");
    const decoy = path.join(src, "aaa_decoy.rs");
    const shared = path.join(src, "shared.rs");
    await writeFile(lib, '#[path = "shared.rs"]\nmod shared;\npub struct LibThing;\n');
    await writeFile(decoy, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
    await writeFile(shared, "use super::LibThing;\npub fn take(_v: LibThing) {}\n");
    try {
      await expectReachableRustPathOwner({
        root,
        fromFile: shared,
        ownerFile: lib,
        imported: "LibThing",
        files: [lib, decoy, shared],
        excludedBasenames: ["aaa_decoy.rs"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves super through an explicit crate-root path that does not end in .rs", async () => {
    const cases = [
      {
        prefix: "cg-rust-path-owner-extless-lib-",
        cargoToml: '[package]\nname = "extless-lib"\nversion = "0.1.0"\n\n[lib]\npath = "custom/root"\n',
        ownerRelative: path.join("custom", "root"),
        pathValue: "../src/shared.rs",
      },
      {
        prefix: "cg-rust-path-owner-extless-bin-",
        cargoToml:
          '[package]\nname = "extless-bin"\nversion = "0.1.0"\nautolib = false\n\n[[bin]]\nname = "tool"\npath = "tools/tool"\n',
        ownerRelative: path.join("tools", "tool"),
        pathValue: "../src/shared.rs",
      },
    ] as const;
    for (const testCase of cases) {
      const root = await mkdtemp(path.join(os.tmpdir(), testCase.prefix));
      const src = path.join(root, "src");
      await mkdir(src, { recursive: true });
      await mkdir(path.dirname(path.join(root, testCase.ownerRelative)), { recursive: true });
      await writeFile(path.join(root, "Cargo.toml"), testCase.cargoToml);
      const ownerFile = path.join(root, testCase.ownerRelative);
      const decoy = path.join(src, "aaa_decoy.rs");
      const shared = path.join(src, "shared.rs");
      await writeFile(ownerFile, `#[path = "${testCase.pathValue}"]\nmod shared;\npub struct ExtlessThing;\n`);
      await writeFile(decoy, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
      await writeFile(shared, "use super::ExtlessThing;\npub fn take(_v: ExtlessThing) {}\n");
      try {
        await expectReachableRustPathOwner({
          root,
          fromFile: shared,
          ownerFile,
          imported: "ExtlessThing",
          files: [ownerFile, decoy, shared],
          excludedBasenames: ["aaa_decoy.rs", "lib.rs"],
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("does not treat a virtual workspace root as a package when resolving #[path] owners", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-virtual-ws-"));
    const src = path.join(root, "src");
    const pkgSrc = path.join(root, "pkg", "src");
    await mkdir(src, { recursive: true });
    await mkdir(pkgSrc, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[workspace]\nmembers = ["pkg"]\n');
    await writeFile(path.join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\nversion = "0.1.0"\n');
    await writeFile(path.join(pkgSrc, "lib.rs"), "");
    const strayBuild = path.join(root, "build.rs");
    const ownerFile = path.join(src, "aaa_owner.rs");
    const shared = path.join(src, "shared.rs");
    await writeFile(strayBuild, '#[path = "src/shared.rs"]\nmod shared;\npub struct WorkspaceThing;\n');
    await writeFile(ownerFile, '#[path = "shared.rs"]\nmod shared;\npub struct OwnerThing;\n');
    await writeFile(shared, "use super::OwnerThing;\npub fn take(_v: OwnerThing) {}\n");
    try {
      await expectReachableRustPathOwner({
        root,
        fromFile: shared,
        ownerFile,
        imported: "OwnerThing",
        files: [strayBuild, ownerFile, shared],
        excludedBasenames: ["build.rs"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves super through a conventional child of a custom crate-root filename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-custom-child-"));
    const src = path.join(root, "src");
    const customDir = path.join(root, "custom");
    await mkdir(src, { recursive: true });
    await mkdir(path.join(customDir, "root"), { recursive: true });
    await writeFile(
      path.join(root, "Cargo.toml"),
      '[package]\nname = "custom-child"\nversion = "0.1.0"\n\n[lib]\npath = "custom/root.rs"\n',
    );
    const customRoot = path.join(customDir, "root.rs");
    const ownerFile = path.join(customDir, "owner.rs");
    const nestedDecoy = path.join(customDir, "root", "owner.rs");
    const decoy = path.join(src, "aaa_decoy.rs");
    const shared = path.join(src, "shared.rs");
    await writeFile(customRoot, "mod owner;\n");
    await writeFile(ownerFile, '#[path = "../src/shared.rs"]\nmod shared;\npub struct OwnerThing;\n');
    await writeFile(nestedDecoy, '#[path = "../../src/shared.rs"]\nmod shared;\npub struct NestedThing;\n');
    await writeFile(decoy, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
    await writeFile(shared, "use super::OwnerThing;\npub fn take(_v: OwnerThing) {}\n");
    try {
      await expectReachableRustPathOwner({
        root,
        fromFile: shared,
        ownerFile,
        imported: "OwnerThing",
        files: [customRoot, ownerFile, nestedDecoy, decoy, shared],
        excludedBasenames: ["aaa_decoy.rs"],
      });
      const owner = await resolveRustImportPath(root, shared, "super");
      expect(owner?.replace(/\\/g, "/")).not.toBe(nestedDecoy.replace(/\\/g, "/"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves super through a raw-identifier conventional module", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-raw-ident-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "raw-ident"\nversion = "0.1.0"\n');
    const lib = path.join(src, "lib.rs");
    const typeFile = path.join(src, "type.rs");
    const decoy = path.join(src, "aaa_decoy.rs");
    const shared = path.join(src, "shared.rs");
    await writeFile(lib, "mod r#type;\n");
    await writeFile(typeFile, '#[path = "shared.rs"]\nmod shared;\npub struct TypeThing;\n');
    await writeFile(decoy, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
    await writeFile(shared, "use super::TypeThing;\npub fn take(_v: TypeThing) {}\n");
    try {
      await expectReachableRustPathOwner({
        root,
        fromFile: shared,
        ownerFile: typeFile,
        imported: "TypeThing",
        files: [lib, typeFile, decoy, shared],
        excludedBasenames: ["aaa_decoy.rs", "lib.rs"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!canCreateRustFileSymlink())(
    "does not walk a conventional module symlink whose real path escapes the project",
    async () => {
      const sandbox = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-mod-symlink-"));
      const root = path.join(sandbox, "project");
      const src = path.join(root, "src");
      await mkdir(src, { recursive: true });
      await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "mod-symlink"\nversion = "0.1.0"\n');
      const outside = path.join(sandbox, "escaped.rs");
      const linked = path.join(src, "escaped.rs");
      const lib = path.join(src, "lib.rs");
      const real = path.join(src, "real.rs");
      const decoy = path.join(src, "aaa_decoy.rs");
      const shared = path.join(src, "shared.rs");
      await writeFile(outside, '#[path = "shared.rs"]\nmod shared;\npub struct EscapedThing;\n');
      await writeFile(lib, "mod real;\nmod escaped;\n");
      await writeFile(real, '#[path = "shared.rs"]\nmod shared;\npub struct RealThing;\n');
      await writeFile(decoy, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
      await writeFile(shared, "use super::RealThing;\npub fn take(_v: RealThing) {}\n");
      try {
        try {
          await symlink(outside, linked, "file");
        } catch (error) {
          if (isSymlinkUnavailable(error)) return;
          throw error;
        }
        await expectReachableRustPathOwner({
          root,
          fromFile: shared,
          ownerFile: real,
          imported: "RealThing",
          files: [lib, real, linked, decoy, shared],
          excludedBasenames: ["aaa_decoy.rs", "escaped.rs"],
        });
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    },
  );

  it("resolves super when a reachable #[path] uses a differently cased spelling of the target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-case-fold-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-owner-case-fold"\nversion = "0.1.0"\n');
    const lib = path.join(src, "lib.rs");
    const decoy = path.join(src, "aaa_decoy.rs");
    const shared = path.join(src, "shared.rs");
    await writeFile(lib, '#[path = "SHARED.rs"]\nmod shared;\npub struct CaseThing;\n');
    await writeFile(decoy, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
    await writeFile(shared, "use super::CaseThing;\npub fn take(_v: CaseThing) {}\n");
    try {
      if (!(await pathCaseFoldsOnFilesystem(shared))) return;
      await expectReachableRustPathOwner({
        root,
        fromFile: shared,
        ownerFile: lib,
        imported: "CaseThing",
        files: [lib, decoy, shared],
        excludedBasenames: ["aaa_decoy.rs"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats differently cased #[path] spellings of the same file as one target when detecting ambiguity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-case-ambiguous-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(
      path.join(root, "Cargo.toml"),
      '[package]\nname = "path-owner-case-ambiguous"\nversion = "0.1.0"\n',
    );
    const lib = path.join(src, "lib.rs");
    const one = path.join(src, "one.rs");
    const two = path.join(src, "two.rs");
    const shared = path.join(src, "shared.rs");
    await writeFile(lib, "mod one;\nmod two;\n");
    await writeFile(one, '#[path = "shared.rs"]\nmod shared;\npub struct OneThing;\n');
    await writeFile(two, '#[path = "SHARED.rs"]\nmod shared;\npub struct TwoThing;\n');
    await writeFile(shared, "use super::OneThing;\npub fn take(_v: OneThing) {}\n");
    try {
      if (!(await pathCaseFoldsOnFilesystem(shared))) return;
      const owner = await resolveRustImportPath(root, shared, "super");
      expect(owner).toBeNull();
      const imports = await collectImportsForFile(shared, root);
      const oneThingImport = imports.find((entry) => entry.kind === "named" && entry.imported === "OneThing");
      expect(oneThingImport).toBeDefined();
      expect(oneThingImport?.resolved).toEqual({ external: "super" });
      const graph = await collectGraph(root, [lib, one, two, shared]);
      expect(
        graph.edges.some(
          (edge) =>
            path.basename(edge.from) === "shared.rs" && edge.raw === "super::OneThing" && edge.to.type === "file",
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes crate module-tree freshness checks so concurrent lookups share one stat sweep", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-freshness-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-owner-freshness"\nversion = "0.1.0"\n');
    const lib = path.join(src, "lib.rs");
    const shared = path.join(src, "shared.rs");
    await writeFile(lib, '#[path = "shared.rs"]\nmod shared;\npub struct FreshThing;\n');
    await writeFile(shared, "use super::FreshThing;\npub fn take(_v: FreshThing) {}\n");
    const spy = vi.spyOn(fsp, "stat");
    try {
      const owner = await resolveRustImportPath(root, shared, "super");
      expect(owner?.replace(/\\/g, "/")).toBe(lib.replace(/\\/g, "/"));
      await delay(150);
      spy.mockClear();
      await Promise.all(Array.from({ length: 8 }, () => resolveRustImportPath(root, shared, "super")));
      const examplesDir = path.resolve(root, "examples");
      const examplesStats = spy.mock.calls.filter(
        (call) => typeof call[0] === "string" && fileIdentityKey(call[0]) === fileIdentityKey(examplesDir),
      ).length;
      expect(examplesStats).toBe(1);
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

type RustToken = readonly [line: number, token: string, occurrence?: number];

const RUST_NAMESPACE_LINES = [
  "mod inner { pub const K: i32 = 1; }",
  "fn inner() -> i32 { 0 }",
  "fn use_inner() -> i32 {",
  "    let called = inner();",
  "    let value = inner;",
  "    let qualified = inner::K;",
  "    let crate_called = crate::inner();",
  "    let crate_qualified = crate::inner::K;",
  "    let _kept = value;",
  "    called + qualified + crate_called + crate_qualified",
  "}",
  "fn before() -> i32 {",
  "    let called = swapped();",
  "    let qualified = swapped::K;",
  "    let crate_called = crate::swapped();",
  "    let crate_qualified = crate::swapped::K;",
  "    called + qualified + crate_called + crate_qualified",
  "}",
  "fn swapped() -> i32 { 1 }",
  "mod swapped { pub const K: i32 = 2; }",
  "const shared: i32 = 5;",
  "mod shared { pub const K: i32 = 6; }",
  "fn use_item() -> i32 { shared + shared::K }",
  "struct Record { field: i32 }",
  "fn Record() -> i32 { 7 }",
  "fn use_record() -> i32 {",
  "    let _built = 1;",
  "    Record()",
  "}",
  "struct Tuple(i32);",
  "fn use_tuple() -> i32 {",
  "    let Tuple(value) = Tuple(4);",
  "    value",
  "}",
  "enum Choice { A }",
  "fn Choice() -> i32 { 3 }",
  "fn use_choice() -> i32 {",
  "    let _variant = Choice::A;",
  "    Choice()",
  "}",
  "trait Marker {}",
  "fn Marker() -> i32 { 4 }",
  "fn use_marker() -> i32 { Marker() }",
  "type Alias = i32;",
  "fn Alias() -> i32 { 8 }",
  "fn use_alias() -> i32 {",
  "    let _typed: Alias = 1;",
  "    Alias()",
  "}",
  "fn decoy() -> i32 { 9 }",
  "fn use_plain() -> i32 { decoy() }",
  "fn use_local() -> i32 {",
  "    let inner = 2;",
  "    inner + crate::inner::K",
  "}",
  "use inner::K as INNER_K;",
  "fn read_imported() -> i32 { INNER_K }",
  "struct Owner;",
  "impl Owner { fn decoy(&self) -> i32 { 11 } }",
  "fn LaterAlias() -> i32 { 9 }",
  "type LaterAlias = i32;",
  "fn use_later_alias() -> i32 { let _x: LaterAlias = 1; LaterAlias() }",
  "mod types { pub mod nested { pub struct Data; } }",
  "fn accept(_: crate::types::nested::Data) {}",
  "trait Capture {}",
  "struct CaptureOwner;",
  "impl Capture for CaptureOwner {}",
  "trait HasCapture { type Capture; }",
  "impl HasCapture for CaptureOwner { type Capture = i32; }",
  "fn use_nested() -> i32 {",
  "    fn same() -> i32 { 3 }",
  "    mod same { pub const K: i32 = 4; }",
  "    same() + same::K",
  "}",
];

function rustNamespaceSite(file: string, [line, token, occurrence = 0]: RustToken) {
  const text = RUST_NAMESPACE_LINES[line - 1] ?? "";
  let offset = -1;
  for (let count = 0; count <= occurrence; count += 1) offset = text.indexOf(token, offset + 1);
  if (offset < 0) throw new Error(`missing ${token} #${occurrence} on line ${line}`);
  return { file, line, column: offset + 1 };
}

function rustNamespacePositions(file: string, tokens: readonly RustToken[]) {
  return tokens
    .map((token) => {
      const site = rustNamespaceSite(file, token);
      return [site.line, site.column] as const;
    })
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

async function expectRustNamespaceGoto(index: ProjectIndex, file: string, token: RustToken, declaration: RustToken) {
  const answer = await goToDefinition(index, rustNamespaceSite(file, token));
  const label = `${token[0]}:${token[1]}#${token[2] ?? 0}`;
  expect(answer.status, label).toBe("ok");
  if (answer.status !== "ok") return;
  const target = rustNamespaceSite(file, declaration);
  expect([answer.definition.range.start.line, answer.definition.range.start.column], label).toEqual([
    target.line,
    target.column,
  ]);
}

async function expectRustNamespaceReferences(
  index: ProjectIndex,
  file: string,
  declaration: RustToken,
  reads: readonly RustToken[],
) {
  const refs = await findReferences(index, rustNamespaceSite(file, declaration));
  expect(refs.status, `${declaration[0]}:${declaration[1]}`).toBe("ok");
  if (refs.status !== "ok") return;
  expect(refs.referenceCoverage.state).toBe("complete");
  expect(
    refs.references
      .map((ref) => [ref.range.start.line, ref.range.start.column] as const)
      .sort((left, right) => left[0] - right[0] || left[1] - right[1]),
  ).toEqual(rustNamespacePositions(file, [declaration, ...reads]));
}

async function expectRustNamespaceRename(
  session: AgentSession,
  root: string,
  file: string,
  declaration: RustToken,
  reads: readonly RustToken[],
) {
  const origin = rustNamespaceSite(file, declaration);
  const preview = await previewRenameWithSession(session, {
    root,
    handle: `lib.rs:${origin.line}:${origin.column}`,
    newName: "renamed",
  });
  expect(preview.safe, `${declaration[0]}:${declaration[1]}`).toBe(true);
  expect(preview.unsafeSites).toEqual([]);
  expect(
    preview.edits
      .map((edit) => [edit.range.start.line, edit.range.start.column] as const)
      .sort((left, right) => left[0] - right[0] || left[1] - right[1]),
  ).toEqual(rustNamespacePositions(file, [declaration, ...reads]));
}

async function withRustReviewFixture(
  lines: readonly string[],
  run: (args: {
    root: string;
    file: string;
    index: ProjectIndex;
    session: AgentSession;
    site: (token: RustToken) => { file: string; line: number; column: number };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-review-"));
  const file = path.join(root, "lib.rs");
  const source = `${lines.join("\n")}\n`;
  const site = ([line, token, occurrence = 0]: RustToken) => {
    const text = lines[line - 1] ?? "";
    let offset = -1;
    for (let count = 0; count <= occurrence; count += 1) offset = text.indexOf(token, offset + 1);
    if (offset < 0) throw new Error(`missing ${token} #${occurrence} on line ${line}`);
    return { file, line, column: offset + 1 };
  };
  try {
    await writeFile(file, source);
    const session = createAgentSession({ root, buildOptions: { cache: "off", threads: 1 } });
    try {
      const { index } = await session.loadProject();
      expect(index.byFile.get(fileIdentityKey(file))?.nativeOutcome).toBe("used");
      await run({ root, file, index, session, site });
    } finally {
      session.invalidate();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectRustReviewRenameCompiles(args: {
  root: string;
  file: string;
  session: AgentSession;
  declaration: { line: number; column: number };
  expected: readonly { line: number; column: number }[];
}): Promise<void> {
  const { root, file, session, declaration, expected } = args;
  const preview = await previewRenameWithSession(session, {
    root,
    handle: `lib.rs:${declaration.line}:${declaration.column}`,
    newName: "Renamed",
  });
  expect(preview.safe).toBe(true);
  expect(preview.unsafeSites).toEqual([]);
  const positions = preview.edits
    .map((edit) => [edit.range.start.line, edit.range.start.column] as const)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  expect(positions).toEqual(
    expected
      .map((position) => [position.line, position.column] as const)
      .sort((left, right) => left[0] - right[0] || left[1] - right[1]),
  );
  let renamed = await readFile(file, "utf8");
  for (const edit of [...preview.edits].sort((left, right) => right.range.start.index! - left.range.start.index!)) {
    expect(fileIdentityKey(path.resolve(root, edit.file))).toBe(fileIdentityKey(file));
    renamed = renamed.slice(0, edit.range.start.index) + edit.newText + renamed.slice(edit.range.end.index);
  }
  const oracle = await mkdtemp(path.join(os.tmpdir(), "cg-rust-rename-oracle-"));
  try {
    const sourceFile = path.join(oracle, "lib.rs");
    await writeFile(sourceFile, renamed);
    execFileSync(
      "rustc",
      [
        "--edition=2021",
        "--crate-type=lib",
        "--emit=metadata",
        "-A",
        "warnings",
        "-o",
        path.join(oracle, "renamed.rmeta"),
        sourceFile,
      ],
      { windowsHide: true },
    );
  } finally {
    await rm(oracle, { recursive: true, force: true });
  }
}

describe("Rust function-local items and re-export aliases", () => {
  it("keeps return and record renames valid beside same-named functions", async () => {
    await withMemberSelectorFixture(RUST_RETURN_RECORD_FIXTURE, async (index, file, session, root) => {
      await expectMemberSelectorGoto(index, RUST_RETURN_RECORD_FIXTURE, file);
      await expectMemberSelectorReferences(index, RUST_RETURN_RECORD_FIXTURE, file);
      for (const target of RUST_RETURN_RECORD_FIXTURE.targets) {
        const declaration = selectorSite(RUST_RETURN_RECORD_FIXTURE, file, target.declaration);
        const reads = target.reads.map((token) => selectorSite(RUST_RETURN_RECORD_FIXTURE, file, token));
        await expectRustReviewRenameCompiles({ root, file, session, declaration, expected: [declaration, ...reads] });
      }
    });
  });

  it("does not add generic return types to same-named outer type references", async () => {
    const fixture = {
      language: "rust",
      file: "lib.rs",
      lines: [
        "#![allow(dead_code)]",
        "struct T;",
        "fn generic<T>(value: T) -> T { value }",
        "fn concrete() -> T { T }",
        "struct Wrap<T>(T);",
        "impl<T> Wrap<T> { fn get(&self) -> T { panic!() } }",
        "trait Factory<T> { fn get(&self) -> T { panic!() } }",
        "struct Caf\u00e9;",
        "fn unicode<Cafe\u0301>() -> Caf\u00e9 { panic!() }",
        "fn concrete_unicode() -> Caf\u00e9 { Caf\u00e9 }",
        "struct Widget;",
        "fn other<U>(_: U) -> Widget { Widget }",
      ],
      targets: [],
      members: [],
    } as const;
    await withMemberSelectorFixture(fixture, async (index, file, session, root) => {
      const site = (token: RustToken) => selectorSite(fixture, file, token);
      for (const token of [
        [3, "T", 2],
        [6, "T", 2],
        [7, "T", 1],
        [9, "Caf\u00e9"],
      ] as const) {
        const answer = await goToDefinition(index, site(token));
        expect(answer.status, `${token[0]}:${token[1]}`).toBe("not_found");
      }
      for (const [declaration, excluded, included] of [
        [
          [2, "T"],
          [
            [3, "T", 2],
            [6, "T", 2],
            [7, "T", 1],
          ],
          [4, "T"],
        ],
        [[8, "Caf\u00e9"], [[9, "Caf\u00e9"]], [10, "Caf\u00e9"]],
      ] as const) {
        const refs = await findReferences(index, site(declaration));
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") continue;
        const positions = refs.references.map((ref) => [ref.range.start.line, ref.range.start.column]);
        for (const token of excluded) {
          const at = site(token);
          expect(positions).not.toContainEqual([at.line, at.column]);
        }
        const at = site(included);
        expect(positions).toContainEqual([at.line, at.column]);
      }
      const declaration = site([11, "Widget"]);
      const reads = [site([12, "Widget"]), site([12, "Widget", 1])];
      await expectRustReviewRenameCompiles({ root, file, session, declaration, expected: [declaration, ...reads] });
    });
  });

  it("keeps qualified types, associated types, and type parameters out of alias renames", async () => {
    const lines = [
      "#![allow(dead_code, unused_variables, non_camel_case_types)]",
      "use std::{fmt, io};",
      "type Result<T, E = io::Error> = std::result::Result<T, E>;",
      "fn std_result() -> std::result::Result<(), io::Error> { Ok(()) }",
      "fn io_result() -> io::Result<()> { Ok(()) }",
      "fn fmt_result() -> fmt::Result { Ok(()) }",
      "type Output = u8;",
      "trait Shape { type Output; fn get(&self) -> Self::Output; }",
      "struct Object;",
      "impl Shape for Object { type Output = u16; fn get(&self) -> <Self as Shape>::Output { 1 } }",
      "fn output<T: Shape>(value: T) -> T::Output { value.get() }",
      "fn qualified<T: Shape>(value: T) -> <T as Shape>::Output { value.get() }",
      "type T = u8;",
      "fn generic<T>(value: T) -> T { value }",
    ];
    await withRustReviewFixture(lines, async ({ root, file, index, session, site }) => {
      for (const [declaration, uses] of [
        [
          [3, "Result"],
          [
            [3, "Result", 1],
            [4, "Result"],
            [5, "Result"],
            [6, "Result"],
          ],
        ],
        [
          [7, "Output"],
          [
            [8, "Output"],
            [8, "Output", 1],
            [10, "Output"],
            [10, "Output", 1],
            [11, "Output"],
            [12, "Output"],
          ],
        ],
        [
          [13, "T"],
          [
            [14, "T"],
            [14, "T", 1],
            [14, "T", 2],
          ],
        ],
      ] as const) {
        const origin = site(declaration);
        for (const token of uses) {
          const answer = await goToDefinition(index, site(token));
          if (answer.status === "ok") {
            expect([answer.definition.range.start.line, answer.definition.range.start.column]).not.toEqual([
              origin.line,
              origin.column,
            ]);
          }
        }
        const refs = await findReferences(index, origin);
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") continue;
        expect(refs.referenceCoverage.state).toBe("complete");
        expect(refs.references.map((ref) => ref.range.start.line)).toEqual([origin.line]);
        await expectRustReviewRenameCompiles({ root, file, session, declaration: origin, expected: [origin] });
      }
    });
  });

  it("keeps imported record return types and literals on their declaration across caches", async () => {
    const sources = {
      "Cargo.toml": '[package]\nname = "rust_return_witness"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": "#![allow(dead_code, non_snake_case)]\nmod api;\nmod caller;\nmod decoy;\n",
      "src/api.rs": "pub struct Widget { pub value: u8 }\n",
      "src/caller.rs": "use crate::api::Widget;\npub fn build() -> Widget { Widget { value: 1 } }\n",
      "src/decoy.rs": "pub fn Widget() -> u8 { 2 }\n",
    };
    await withBatch3Fixture("cg-rust-return-import-", sources, async (fixture) => {
      const declaration = { file: "src/api.rs", token: "Widget", line: 1 };
      const uses = [
        { file: "src/caller.rs", token: "Widget", line: 1 },
        { file: "src/caller.rs", token: "Widget", line: 2, nth: 1 },
        { file: "src/caller.rs", token: "Widget", line: 2, nth: 2 },
      ];
      try {
        for (const cache of ["off", "disk", "disk"] as const) {
          clearMemoryCache();
          closeDiskCacheDatabase(fixture.root);
          const session = createAgentSession({ root: fixture.root, buildOptions: { cache, threads: 1 } });
          try {
            const { index } = await session.loadProject();
            expect(index.byFile.get(fileIdentityKey(fixture.files["src/caller.rs"]!))?.nativeOutcome).toBe("used");
            for (const use of uses) await expectGoto(fixture, index, use, declaration);
            await expectReferences(fixture, index, declaration, [declaration, ...uses], "complete");
            const graph = await buildSymbolGraphDetailed(index);
            const literal = placeOf(sources, uses[2]!);
            const edge = graph.edges.find(
              (item) =>
                item.label === "instantiates" &&
                item.site?.range.start.line === literal.line &&
                item.site.range.start.column === literal.column,
            );
            expect(edge).toBeDefined();
            expect(fileIdentityKey(graph.nodes.get(edge!.to)!.file)).toBe(
              fileIdentityKey(fixture.files["src/api.rs"]!),
            );
            const preview = await previewRenameWithSession(session, {
              root: fixture.root,
              handle: "src/api.rs:1:12",
              newName: "Renamed",
            });
            expect(preview.safe).toBe(true);
            expect(preview.edits.map((edit) => [edit.file, edit.range.start.line, edit.range.start.column])).toEqual([
              ["src/api.rs", 1, 12],
              ["src/caller.rs", 1, 17],
              ["src/caller.rs", 2, 19],
              ["src/caller.rs", 2, 28],
            ]);
          } finally {
            session.invalidate();
          }
        }
      } finally {
        closeDiskCacheDatabase(fixture.root);
      }
    });
  });

  it("keeps a forward module qualifier in a type path", async () => {
    const lines = [
      "mod options { pub struct Options { pub subcommand: super::subcommands::SubCommand } }",
      "mod subcommands { pub struct SubCommand; }",
    ];
    await withRustReviewFixture(lines, async ({ index, site }) => {
      const answer = await goToDefinition(index, site([1, "subcommands"]));
      expect(answer).toMatchObject({ status: "ok", definition: { range: { start: { line: 2 } } } });
    });
  });

  it("keeps enum path qualifiers and tuple variants out of same-named references", async () => {
    const sources = {
      "Cargo.toml": '[package]\nname = "rust_witness"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "lib.rs"\n',
      "lib.rs": "#![allow(dead_code, unused_variables)]\nmod hir;\nmod print;\n",
      "hir.rs": [
        "pub enum HirKind {",
        "    Look(Look),",
        "    Other,",
        "}",
        "pub enum Look { Start }",
        "pub struct Numeric { pub value: u8 }",
        "pub enum ParsedOffsetKind { Numeric(Numeric) }",
        "pub fn numeric_pattern(kind: ParsedOffsetKind) -> u8 {",
        "    let ParsedOffsetKind::Numeric(numeric) = &kind;",
        "    numeric.value",
        "}",
      ].join("\n"),
      "print.rs": [
        "use crate::hir::{self, HirKind, Look};",
        "pub fn show(hir: &Look, kind: &HirKind) -> u8 {",
        "    let _ = hir::Look::Start;",
        "    let _ = Look::Start;",
        "    match kind { HirKind::Look(_) => 1, HirKind::Other => 2 }",
        "}",
      ].join("\n"),
    };
    await withBatch3Fixture("cg-rust-qualified-enum-", sources, async (fixture) => {
      try {
        for (const cache of ["off", "disk", "disk"] as const) {
          clearMemoryCache();
          closeDiskCacheDatabase(fixture.root);
          const index = await buildProjectIndex(fixture.root, { cache, threads: 1 });
          expect(index.byFile.get(fileIdentityKey(fixture.files["hir.rs"]!))?.nativeOutcome).toBe("used");
          const lookVariant = { file: "hir.rs", token: "Look", line: 2 };
          const variantUse = { file: "print.rs", token: "Look", line: 5 };
          const numericType = { file: "hir.rs", token: "Numeric", line: 6 };
          const numericVariant = { file: "hir.rs", token: "Numeric", line: 7 };
          const numericPattern = { file: "hir.rs", token: "Numeric", line: 9 };
          await expectGoto(fixture, index, variantUse, lookVariant);
          await expectGoto(fixture, index, { file: "print.rs", token: "Look", line: 3 }, "not_found");
          await expectGoto(fixture, index, { file: "print.rs", token: "Look", line: 4 }, "not_found");
          await expectReferences(fixture, index, lookVariant, [lookVariant, variantUse], "partial");
          await expectGoto(fixture, index, numericPattern, numericVariant);
          await expectReferences(
            fixture,
            index,
            numericType,
            [numericType, { file: "hir.rs", token: "Numeric", line: 7, nth: 2 }],
            "complete",
          );
          await expectReferences(fixture, index, numericVariant, [numericVariant, numericPattern], "complete");
        }
      } finally {
        closeDiskCacheDatabase(fixture.root);
      }
    });
  });

  it("keeps qualified struct-variant patterns apart from same-named variants", async () => {
    const sources = {
      "Cargo.toml": '[package]\nname = "pattern_witness"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": [
        "#![allow(dead_code)]",
        "pub mod flags;",
        "pub mod usage;",
        "pub enum Mangling { Coff { tag: u8 }, Other }",
      ].join("\n"),
      "src/flags.rs": "pub enum SectionFlags { Coff { characteristics: u8 }, Other }\n",
      "src/usage.rs": [
        "use crate::flags::SectionFlags;",
        "use crate::Mangling;",
        "pub fn via_let(value: SectionFlags) -> u8 {",
        "    let SectionFlags::Coff { characteristics } = value else { return 0; };",
        "    characteristics",
        "}",
        "pub fn via_match(value: SectionFlags) -> u8 {",
        "    match value { SectionFlags::Coff { characteristics } => characteristics, _ => 0 }",
        "}",
        "pub fn expression() -> Mangling { Mangling::Coff { tag: 1 } }",
      ].join("\n"),
    };
    await withBatch3Fixture("cg-rust-struct-variant-", sources, async (fixture) => {
      try {
        for (const cache of ["off", "disk", "disk"] as const) {
          clearMemoryCache();
          closeDiskCacheDatabase(fixture.root);
          const index = await buildProjectIndex(fixture.root, { cache, threads: 1 });
          expect(index.byFile.get(fileIdentityKey(fixture.files["src/usage.rs"]!))?.nativeOutcome).toBe("used");
          const letPattern = { file: "src/usage.rs", token: "Coff", line: 4 };
          const matchPattern = { file: "src/usage.rs", token: "Coff", line: 8 };
          const expression = { file: "src/usage.rs", token: "Coff", line: 10 };
          const sectionVariant = { file: "src/flags.rs", token: "Coff", line: 1 };
          const manglingVariant = { file: "src/lib.rs", token: "Coff", line: 4 };
          await expectGoto(fixture, index, letPattern, letPattern);
          await expectGoto(fixture, index, matchPattern, sectionVariant);
          await expectGoto(fixture, index, expression, manglingVariant);
          await expectReferences(fixture, index, sectionVariant, [sectionVariant, matchPattern], "complete");
          await expectReferences(fixture, index, manglingVariant, [manglingVariant, expression], "complete");
        }
      } finally {
        closeDiskCacheDatabase(fixture.root);
      }
    });
  });

  it("does not resolve primitive type qualifiers to same-named functions", async () => {
    const lines = [
      "#![allow(dead_code)]",
      "fn usize(_: u8) -> u8 { 0 }",
      "fn u64(_: u8) -> u8 { 0 }",
      "fn f32(_: u8) -> u8 { 0 }",
      "fn run() {",
      "    let _ = usize::MAX;",
      "    let _ = u64::MAX;",
      "    let _ = f32::from_bits(0);",
      "}",
    ];
    await withRustReviewFixture(lines, async ({ index, site }) => {
      for (const [name, declarationLine, useLine] of [
        ["usize", 2, 6],
        ["u64", 3, 7],
        ["f32", 4, 8],
      ] as const) {
        const answer = await goToDefinition(index, site([useLine, name]));
        expect(answer.status, name).toBe("not_found");
        const refs = await findReferences(index, site([declarationLine, name]));
        expect(refs.status, name).toBe("ok");
        if (refs.status !== "ok") continue;
        expect(refs.referenceCoverage.state, name).toBe("complete");
        expect(
          refs.references.map((ref) => ref.range.start.line),
          name,
        ).toEqual([declarationLine]);
      }
    });
  });

  it("keeps an associated call out of a same-named free function's references", async () => {
    const lines = [
      "mod gitignore {}",
      "struct Receiver;",
      "impl Receiver { fn gitignore() -> u8 { 0 } }",
      "fn run() -> u8 { Receiver::gitignore() }",
      "fn gitignore() -> u8 { 1 }",
    ];
    await withRustReviewFixture(lines, async ({ root, file, index, session, site }) => {
      const associated = await goToDefinition(index, site([4, "gitignore"]));
      expect(associated).toMatchObject({ status: "ok", definition: { range: { start: { line: 3 } } } });
      const declaration = site([5, "gitignore"]);
      const refs = await findReferences(index, declaration);
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage.state).toBe("complete");
      expect(refs.references.map((ref) => ref.range.start.line)).toEqual([5]);
      await expectRustReviewRenameCompiles({ root, file, session, declaration, expected: [declaration] });
    });
  });

  it("keeps type uses in macro repetitions when a struct is renamed", async () => {
    const lines = [
      "#![allow(dead_code)]",
      "struct Rec { value: u8 }",
      "macro_rules! define {",
      "    ($($name:ident),*) => { $(",
      "        fn $name() -> Rec { Rec { value: 1 } }",
      "    )* };",
      "}",
      "define!(first, second);",
      "fn own(_: Rec) {}",
    ];
    await withRustReviewFixture(lines, async ({ root, file, index, session, site }) => {
      const declaration = site([2, "Rec"]);
      const uses = [site([5, "Rec"]), site([5, "Rec", 1]), site([9, "Rec"])];
      for (const use of uses) {
        const result = await goToDefinition(index, use);
        expect(result).toMatchObject({ status: "ok", definition: { range: { start: { line: 2 } } } });
      }
      const refs = await findReferences(index, declaration);
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage.state).toBe("complete");
      expect(refs.references.map((ref) => ref.range.start.line)).toEqual([2, 5, 5, 9]);
      await expectRustReviewRenameCompiles({ root, file, session, declaration, expected: [declaration, ...uses] });
    });
  });

  it("keeps const references inside generic argument lists", async () => {
    const lines = [
      "#![allow(dead_code)]",
      "const N: usize = 4;",
      "struct Buf<const M: usize>([u8; M]);",
      "fn make<const K: usize>() -> Buf<K> { Buf([0; K]) }",
      "struct Wrap<T, const L: usize>(T);",
      "fn first(_: Buf<N>) { let _ = make::<N>(); }",
      "fn second(_: Wrap<u8, N>) {}",
    ];
    await withRustReviewFixture(lines, async ({ root, file, index, session, site }) => {
      const declaration = site([2, "N"]);
      const uses = [site([6, "N"]), site([6, "N", 1]), site([7, "N"])];
      for (const use of uses) {
        const result = await goToDefinition(index, use);
        expect(result).toMatchObject({ status: "ok", definition: { range: { start: { line: 2 } } } });
      }
      const refs = await findReferences(index, declaration);
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage.state).toBe("complete");
      expect(refs.references.map((ref) => ref.range.start.line)).toEqual([2, 6, 6, 7]);
      await expectRustReviewRenameCompiles({ root, file, session, declaration, expected: [declaration, ...uses] });
    });
  });

  it("preserves function, const, and static items throughout qualified value paths", async () => {
    await withMemberSelectorFixture(RUST_QUALIFIED_ITEM_FIXTURE, async (index, file) => {
      await expectRustQualifiedItemGoto(index, file);
      await expectMemberSelectorReferences(index, RUST_QUALIFIED_ITEM_FIXTURE, file);
    });
  });

  it("preserves namespace roots and aliased import sources beside member selector exclusions", async () => {
    await withBatch3Fixture(
      "cg-rust-selector-namespaces-language-",
      RUST_SELECTOR_NAMESPACE_SOURCES,
      async (fixture) => {
        await eachIndexMode(fixture, async (index) => {
          await expectRustSelectorNamespace(index, fixture.files);
        });
      },
    );
  });

  it("does not export block-local types while keeping nested module items", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-local-type-"));
    const file = path.join(root, "example.rs");
    await writeFile(
      file,
      [
        "fn outer() {",
        "    type Hidden = u8;",
        "    struct LocalStruct;",
        "}",
        "pub fn kept_fn() {}",
        "pub type Kept = u16;",
        "pub mod nested {",
        "    pub struct Deep;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const parsed = await parseFile(file);
      const mod = collectLocalsAndExportsFromSource(file, parsed.source, parsed.sup, [], {
        ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
      });
      const exportedNames = mod.exports.map(exportedNameOf);

      expect(mod.locals.map((entry) => entry.localName)).toEqual(
        expect.arrayContaining(["outer", "Hidden", "LocalStruct", "kept_fn", "Kept", "Deep"]),
      );
      // Unmarked Rust items stay file-local. The non-pub fn outer is not a module export
      // (another module cannot use it), while the pub fn sibling and the pub mod nested
      // item remain exported.
      expect(exportedNames).toEqual(expect.arrayContaining(["kept_fn", "Kept", "Deep"]));
      expect(exportedNames).not.toContain("outer");
      expect(exportedNames).not.toContain("Hidden");
      expect(exportedNames).not.toContain("LocalStruct");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the original member as the source of an aliased pub-use re-export", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-reexport-alias-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    const apiFile = path.join(src, "api.rs");
    const barrelFile = path.join(src, "barrel.rs");
    const consumerFile = path.join(src, "consumer.rs");
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "reexport-alias"\nversion = "0.1.0"\n', "utf8");
    await writeFile(path.join(src, "lib.rs"), "pub mod api;\npub mod barrel;\npub mod consumer;\n", "utf8");
    await writeFile(apiFile, "pub struct Bar;\npub struct Qux;\npub struct Direct;\n", "utf8");
    await writeFile(
      barrelFile,
      "pub use crate::api::{Bar as Baz, Qux};\npub use crate::api::Direct as Renamed;\n",
      "utf8",
    );
    await writeFile(consumerFile, "use crate::barrel::Baz;\n", "utf8");
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const reexports = (index.byFile.get(fileIdentityKey(barrelFile))?.exports ?? []).filter(
        (entry) => entry.type === "reexport",
      );
      expect(reexports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ exportedAs: "Baz", sourceSpecifier: "Bar" }),
          expect.objectContaining({ exportedAs: "Qux", sourceSpecifier: "Qux" }),
          expect.objectContaining({ exportedAs: "Renamed", sourceSpecifier: "Direct" }),
        ]),
      );
      const consumerImports = index.byFile.get(fileIdentityKey(consumerFile))?.imports ?? [];
      expect(consumerImports).toEqual([expect.objectContaining({ imported: "Baz", from: "crate::barrel" })]);
      expect(fileIdentityKey(String(consumerImports[0]?.resolved))).toBe(fileIdentityKey(barrelFile));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a value apart from a same-named module, enum, trait, or record struct", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-namespace-"));
    const file = path.join(root, "lib.rs");
    const innerReads: RustToken[] = [
      [4, "inner"],
      [5, "inner"],
      [7, "inner"],
    ];
    const innerPaths: RustToken[] = [
      [6, "inner"],
      [8, "inner"],
      [54, "inner", 1],
      [56, "inner"],
    ];
    const swappedReads: RustToken[] = [
      [13, "swapped"],
      [15, "swapped"],
    ];
    try {
      await writeFile(
        path.join(root, "Cargo.toml"),
        '[package]\nname = "namespace_probe"\nversion = "0.1.0"\n[lib]\npath = "lib.rs"\n',
      );
      await writeFile(file, `${RUST_NAMESPACE_LINES.join("\n")}\n`);
      for (const cache of ["off", "disk", "disk"] as const) {
        clearMemoryCache();
        closeDiskCacheDatabase(root);
        const session = createAgentSession({ root, buildOptions: { cache, threads: 1 } });
        try {
          const { index } = await session.loadProject();
          expect(index.byFile.get(fileIdentityKey(file))?.nativeOutcome).toBe("used");

          await expectRustNamespaceGoto(index, file, [4, "inner"], [2, "inner"]);
          await expectRustNamespaceGoto(index, file, [5, "inner"], [2, "inner"]);
          await expectRustNamespaceGoto(index, file, [7, "inner"], [2, "inner"]);
          await expectRustNamespaceGoto(index, file, [6, "inner"], [1, "inner"]);
          await expectRustNamespaceGoto(index, file, [8, "inner"], [1, "inner"]);
          await expectRustNamespaceGoto(index, file, [1, "inner"], [1, "inner"]);
          await expectRustNamespaceGoto(index, file, [2, "inner"], [2, "inner"]);
          await expectRustNamespaceGoto(index, file, [13, "swapped"], [19, "swapped"]);
          await expectRustNamespaceGoto(index, file, [15, "swapped"], [19, "swapped"]);
          await expectRustNamespaceGoto(index, file, [14, "swapped"], [20, "swapped"]);
          await expectRustNamespaceGoto(index, file, [16, "swapped"], [20, "swapped"]);
          await expectRustNamespaceGoto(index, file, [23, "shared"], [21, "shared"]);
          await expectRustNamespaceGoto(index, file, [23, "shared", 1], [22, "shared"]);
          await expectRustNamespaceGoto(index, file, [28, "Record"], [25, "Record"]);
          await expectRustNamespaceGoto(index, file, [32, "Tuple"], [30, "Tuple"]);
          await expectRustNamespaceGoto(index, file, [32, "Tuple", 1], [30, "Tuple"]);
          await expectRustNamespaceGoto(index, file, [38, "Choice"], [35, "Choice"]);
          await expectRustNamespaceGoto(index, file, [39, "Choice"], [36, "Choice"]);
          await expectRustNamespaceGoto(index, file, [43, "Marker"], [42, "Marker"]);
          await expectRustNamespaceGoto(index, file, [51, "decoy"], [50, "decoy"]);
          await expectRustNamespaceGoto(index, file, [54, "inner"], [53, "inner"]);
          await expectRustNamespaceGoto(index, file, [54, "inner", 1], [1, "inner"]);
          await expectRustNamespaceGoto(index, file, [56, "inner"], [1, "inner"]);
          await expectRustNamespaceGoto(index, file, [73, "same"], [71, "same"]);
          await expectRustNamespaceGoto(index, file, [73, "same", 1], [72, "same"]);

          await expectRustNamespaceReferences(index, file, [2, "inner"], innerReads);
          await expectRustNamespaceReferences(index, file, [1, "inner"], innerPaths);
          await expectRustNamespaceReferences(index, file, [19, "swapped"], swappedReads);
          await expectRustNamespaceReferences(index, file, [20, "swapped"], []);
          await expectRustNamespaceReferences(index, file, [21, "shared"], [[23, "shared"]]);
          await expectRustNamespaceReferences(index, file, [22, "shared"], [[23, "shared", 1]]);
          await expectRustNamespaceReferences(index, file, [24, "Record"], []);
          await expectRustNamespaceReferences(index, file, [25, "Record"], [[28, "Record"]]);
          await expectRustNamespaceReferences(
            index,
            file,
            [30, "Tuple"],
            [
              [32, "Tuple"],
              [32, "Tuple", 1],
            ],
          );
          await expectRustNamespaceReferences(index, file, [35, "Choice"], [[38, "Choice"]]);
          await expectRustNamespaceReferences(index, file, [36, "Choice"], [[39, "Choice"]]);
          await expectRustNamespaceReferences(index, file, [41, "Marker"], []);
          await expectRustNamespaceReferences(index, file, [42, "Marker"], [[43, "Marker"]]);
          await expectRustNamespaceReferences(index, file, [50, "decoy"], [[51, "decoy"]]);
          await expectRustNamespaceReferences(index, file, [53, "inner"], [[54, "inner"]]);
          await expectRustNamespaceReferences(index, file, [71, "same"], [[73, "same"]]);
          await expectRustNamespaceReferences(index, file, [72, "same"], [[73, "same", 1]]);

          const graph = await buildSymbolGraphDetailed(index);
          const definitionLine = (nodeId: string | undefined): number | undefined => {
            if (!nodeId) return undefined;
            for (const module of index.byFile.values()) {
              for (const local of module.locals) {
                if (nodeId.endsWith(`::${local.localName}::${local.range.start.index ?? 0}`)) {
                  return local.range.start.line;
                }
              }
            }
            return undefined;
          };
          const callTarget = (callerName: string, siteLine: number): number | undefined => {
            const caller = [...graph.nodes.values()].find((node) => node.name === callerName);
            const edge = graph.edges.find(
              (item) => item.label === "calls" && item.from === caller?.id && item.site?.range.start.line === siteLine,
            );
            return definitionLine(edge ? graph.nodes.get(edge.to)?.id : undefined);
          };
          expect(callTarget("use_inner", 4)).toBe(2);
          expect(callTarget("use_inner", 7)).toBe(2);
          expect(callTarget("before", 13)).toBe(19);
          expect(callTarget("before", 15)).toBe(19);
          expect(callTarget("use_record", 28)).toBe(25);
          expect(callTarget("use_choice", 39)).toBe(36);
          expect(callTarget("use_marker", 43)).toBe(42);
          expect(callTarget("use_plain", 51)).toBe(50);
          expect(callTarget("use_tuple", 32)).toBe(30);
          expect(callTarget("use_nested", 73)).toBe(71);
          const callLines = new Set(
            graph.edges.filter((edge) => edge.label === "calls").map((edge) => edge.site?.range.start.line),
          );
          for (const line of [6, 8, 14, 16, 27]) expect(callLines.has(line), `call on ${line}`).toBe(false);

          await expectRustNamespaceRename(session, root, file, [2, "inner"], innerReads);
          await expectRustNamespaceRename(session, root, file, [19, "swapped"], swappedReads);
          await expectRustNamespaceRename(session, root, file, [71, "same"], [[73, "same"]]);
          await expect(
            previewRenameWithSession(session, { root, handle: "lib.rs:1:5", newName: "renamed" }),
          ).rejects.toThrow('Symbol target "lib.rs:1:5" was not found');
          await expectRustNamespaceRename(session, root, file, [53, "inner"], [[54, "inner"]]);
          await expectRustNamespaceRename(session, root, file, [25, "Record"], [[28, "Record"]]);
          await expectRustNamespaceRename(session, root, file, [24, "Record"], []);
        } finally {
          session.invalidate();
        }
      }
    } finally {
      closeDiskCacheDatabase(root);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Rust restricted visibility forms", () => {
  it("lets an importer bind pub(in crate) while pub(self) stays unresolved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-rust-vis-restricted-"));
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    const visFile = path.join(src, "vis.rs").replace(/\\/g, "/");
    const consumerFile = path.join(src, "consumer.rs").replace(/\\/g, "/");
    const visInPathDef = "pub(in crate) fn in_path_vis() {}";
    const visSelfDef = "pub(self) fn self_vis() {}";
    const visSpacedSelfDef = "pub ( self ) fn spaced_self() {}";
    const consumerInPath = "    in_path_vis();";
    const consumerSelf = "    self_vis();";
    await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "rust-vis-restricted"\nversion = "0.1.0"\n');
    await writeFile(path.join(src, "lib.rs"), "mod vis;\npub mod consumer;\n");
    await writeFile(visFile, [visInPathDef, visSelfDef, visSpacedSelfDef, ""].join("\n"));
    await writeFile(
      consumerFile,
      [
        "use crate::vis::in_path_vis;",
        "use crate::vis::self_vis;",
        "use crate::vis::spaced_self;",
        "",
        "fn run() {",
        consumerInPath,
        consumerSelf,
        "}",
        "",
      ].join("\n"),
    );
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const visMod = index.byFile.get(fileIdentityKey(visFile));
      const exported = (visMod?.exports ?? []).flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []));
      expect(exported).toContain("in_path_vis");
      expect(exported).not.toContain("self_vis");
      expect(exported).not.toContain("spaced_self");
      expect(resolveExport(index, visFile, "in_path_vis", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, visFile, "self_vis")).toBeNull();
      expect(resolveExport(index, visFile, "spaced_self")).toBeNull();

      const inPath = await goToDefinition(index, {
        file: consumerFile,
        line: 6,
        column: consumerInPath.indexOf("in_path_vis") + 1,
      });
      expect(inPath.status).toBe("ok");
      if (inPath.status === "ok") {
        expect(fileIdentityKey(inPath.definition.file)).toBe(fileIdentityKey(visFile));
        expect(inPath.definition.range.start.line).toBe(1);
      }

      const hidden = await goToDefinition(index, {
        file: consumerFile,
        line: 7,
        column: consumerSelf.indexOf("self_vis") + 1,
      });
      expect(hidden.status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describeTypeParameterReceiverRows("rust", "Rust type parameter beside a same-named struct");
