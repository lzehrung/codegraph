import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectImportsForFile } from "../src/indexer/imports.js";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
} from "../src/index.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { isSymlinkUnavailable } from "./helpers/filesystem.js";

/** File identity of an import target, or the external specifier when it did not resolve to a file. */
function resolvedFileKey(resolved: string | { external: string } | undefined): string | undefined {
  if (resolved === undefined) return undefined;
  return typeof resolved === "string" ? fileIdentityKey(resolved) : resolved.external;
}

async function writeFixture(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}

function columnOf(line: string, token: string, last = false): number {
  return (last ? line.lastIndexOf(token) : line.indexOf(token)) + 1;
}

/** Symbol node id the detailed graph derives from a declaration name token. */
function defNodeIdAt(file: string, source: string, name: string, occurrence: number): string {
  let index = -1;
  for (let seen = 0; seen <= occurrence; seen += 1) {
    index = source.indexOf(name, index + 1);
    if (index < 0) throw new Error(`missing occurrence ${occurrence} of ${name}`);
  }
  return `${file.replace(/\\/g, "/")}::${name}::${index}`;
}

describe("Rust Cargo manifests are resolution inputs for the warm cache", () => {
  it("drops a path dependency's resolution on a warm build after Cargo.toml removes it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-cargo-warm-"));
    try {
      const use = 'use crate_a::greet;\nfn main() { println!("{}", greet()); }\n';
      await writeFixture(root, {
        "a/Cargo.toml": '[package]\nname = "crate_a"\nversion = "0.1.0"\n',
        "a/src/lib.rs": 'pub fn greet() -> &\'static str { "hi" }\n',
        "b/Cargo.toml": '[package]\nname = "crate_b"\nversion = "0.1.0"\n[dependencies]\ncrate_a = { path = "../a" }\n',
        "b/src/main.rs": use,
      });
      const main = path.join(root, "b/src/main.rs");
      const request = { file: main, line: 2, column: columnOf(use.split("\n")[1]!, "greet") };
      const disk = { cache: "disk" as const };

      const first = await buildProjectIndexIncremental(root, disk);
      expect((await goToDefinition(first, request)).status).toBe("ok");

      await writeFile(path.join(root, "b/Cargo.toml"), '[package]\nname = "crate_b"\nversion = "0.1.0"\n');
      const warm = await buildProjectIndexIncremental(root, disk);
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect((await goToDefinition(cold, request)).status).toBe("not_found");
      expect((await goToDefinition(warm, request)).status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("revalidates [lib].path on a warm build without falling back to src/lib.rs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-cargo-libpath-warm-"));
    try {
      const use = "use crate_a::greet;\nfn main() { greet(); }\n";
      const manifest = (target: string): string =>
        '[package]\nname = "crate_a"\nversion = "0.1.0"\n[lib]\npath = "src/' + target + '.rs"\n';
      await writeFixture(root, {
        "a/Cargo.toml": manifest("core"),
        "a/src/core.rs": "pub fn greet() {}\n",
        "a/src/other.rs": "pub fn greet() {}\n",
        "a/src/lib.rs": "pub fn greet() {}\n",
        "b/Cargo.toml": '[package]\nname = "crate_b"\nversion = "0.1.0"\n[dependencies]\ncrate_a = { path = "../a" }\n',
        "b/src/main.rs": use,
      });
      const main = path.join(root, "b/src/main.rs");
      const request = { file: main, line: 2, column: columnOf(use.split("\n")[1]!, "greet") };
      const first = await buildProjectIndexIncremental(root, { cache: "disk" });
      const before = await goToDefinition(first, request);
      expect(before.status).toBe("ok");
      if (before.status === "ok") {
        expect(fileIdentityKey(before.definition.file)).toBe(fileIdentityKey(path.join(root, "a/src/core.rs")));
      }

      await writeFile(path.join(root, "a/Cargo.toml"), manifest("other"));
      const warm = await buildProjectIndexIncremental(root, { cache: "disk" });
      const cold = await buildProjectIndex(root, { cache: "off" });
      for (const index of [warm, cold]) {
        const goto = await goToDefinition(index, request);
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") {
          expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(path.join(root, "a/src/other.rs")));
        }
        const old = await findReferences(index, { file: path.join(root, "a/src/core.rs"), line: 1, column: 8 });
        expect(old.status).toBe("ok");
        if (old.status === "ok") {
          expect(old.references.map((ref) => fileIdentityKey(ref.file))).toEqual([
            fileIdentityKey(path.join(root, "a/src/core.rs")),
          ]);
        }
      }
      await writeFile(path.join(root, "a/Cargo.toml"), manifest("missing"));
      const missing = await buildProjectIndexIncremental(root, { cache: "disk" });
      expect((await goToDefinition(missing, request)).status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Rust path dependencies use the library target declared by Cargo", () => {
  it("resolves an explicit [lib].path instead of a same-named src/lib.rs decoy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-cargo-libpath-"));
    try {
      const core = 'pub fn greet() -> &\'static str { "real" }\n';
      const decoy = 'pub fn greet() -> &\'static str { "decoy" }\n';
      const use = "use crate_a::greet;\nfn main() { greet(); }\n";
      await writeFixture(root, {
        "a/Cargo.toml": '[package]\nname = "crate_a"\nversion = "0.1.0"\n[lib]\npath = "src/core.rs"\n',
        "a/src/core.rs": core,
        "a/src/lib.rs": decoy,
        "b/Cargo.toml": '[package]\nname = "crate_b"\nversion = "0.1.0"\n[dependencies]\ncrate_a = { path = "../a" }\n',
        "b/src/main.rs": use,
      });
      const coreFile = path.join(root, "a/src/core.rs");
      const decoyFile = path.join(root, "a/src/lib.rs");
      const mainFile = path.join(root, "b/src/main.rs");
      const imports = await collectImportsForFile(mainFile, root);
      const namedImport = imports.find((entry) => entry.kind === "named" && entry.imported === "greet");
      expect(resolvedFileKey(namedImport?.resolved)).toBe(fileIdentityKey(coreFile));
      expect(resolvedFileKey(namedImport?.resolved)).not.toBe(fileIdentityKey(decoyFile));

      const index = await buildProjectIndex(root, { cache: "off" });
      const goto = await goToDefinition(index, {
        file: mainFile,
        line: 2,
        column: columnOf(use.split("\n")[1]!, "greet"),
      });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(coreFile));

      const refs = await findReferences(index, { file: coreFile, line: 1, column: columnOf(core, "greet") });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        const targets = refs.references.map((reference) => [
          fileIdentityKey(reference.file),
          reference.range.start.line,
        ]);
        expect(targets).toEqual([
          [fileIdentityKey(coreFile), 1],
          [fileIdentityKey(mainFile), 1],
          [fileIdentityKey(mainFile), 2],
        ]);
      }
      const decoyRefs = await findReferences(index, { file: decoyFile, line: 1, column: columnOf(decoy, "greet") });
      expect(decoyRefs.status).toBe("ok");
      if (decoyRefs.status === "ok") {
        expect(decoyRefs.references.map((reference) => fileIdentityKey(reference.file))).toEqual([
          fileIdentityKey(decoyFile),
        ]);
      }
      const graph = await buildSymbolGraphDetailed(index);
      const mainId = defNodeIdAt(mainFile, use, "main", 0);
      const coreId = defNodeIdAt(coreFile, core, "greet", 0);
      const calls = graph.edges.filter((edge) => edge.label === "calls" && edge.from === mainId);
      expect(calls.map((edge) => edge.to)).toEqual([coreId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("walks #[path] modules from a custom library root for crate:: and path dependencies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-cargo-path-tree-"));
    try {
      const worker = "pub fn greet() {}\n";
      const consumer = "use crate::worker::greet;\npub fn run() { greet(); }\n";
      const main = "use crate_a::worker::greet;\nfn main() { greet(); }\n";
      await writeFixture(root, {
        "a/Cargo.toml": '[package]\nname = "crate_a"\nversion = "0.1.0"\n[lib]\npath = "src/core.rs"\n',
        "a/src/core.rs": '#[path = "modules/worker.rs"]\npub mod worker;\npub mod consumer;\n',
        "a/src/modules/worker.rs": worker,
        "a/src/consumer.rs": consumer,
        "a/src/lib.rs": "pub mod worker;\n",
        "a/src/worker.rs": worker,
        "b/Cargo.toml": '[package]\nname = "crate_b"\nversion = "0.1.0"\n[dependencies]\ncrate_a = { path = "../a" }\n',
        "b/src/main.rs": main,
      });
      const workerFile = path.join(root, "a/src/modules/worker.rs");
      const decoyFile = path.join(root, "a/src/worker.rs");
      const consumerFile = path.join(root, "a/src/consumer.rs");
      const mainFile = path.join(root, "b/src/main.rs");
      for (const file of [consumerFile, mainFile]) {
        const imports = await collectImportsForFile(file, root);
        const named = imports.find((entry) => entry.kind === "named" && entry.imported === "greet");
        expect(resolvedFileKey(named?.resolved)).toBe(fileIdentityKey(workerFile));
      }
      const index = await buildProjectIndex(root, { cache: "off" });
      for (const [file, text] of [
        [consumerFile, consumer],
        [mainFile, main],
      ] as const) {
        const goto = await goToDefinition(index, {
          file,
          line: 2,
          column: columnOf(text.split("\n")[1]!, "greet"),
        });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(workerFile));
      }
      const refs = await findReferences(index, { file: workerFile, line: 1, column: columnOf(worker, "greet") });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references.map((ref) => fileIdentityKey(ref.file)).sort()).toEqual(
          [
            fileIdentityKey(workerFile),
            fileIdentityKey(consumerFile),
            fileIdentityKey(consumerFile),
            fileIdentityKey(mainFile),
            fileIdentityKey(mainFile),
          ].sort(),
        );
        expect(refs.references.map((ref) => fileIdentityKey(ref.file))).not.toContain(fileIdentityKey(decoyFile));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps crate:: inside the binary module tree when a custom library coexists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-cargo-binary-root-"));
    try {
      const callLine = "pub fn run() { greet(); from_super(); }";
      const runner = ["use crate::only_bin::greet;", "use super::only_bin::greet as from_super;", callLine, ""].join(
        "\n",
      );
      await writeFixture(root, {
        "Cargo.toml": '[package]\nname = "pkg"\nversion = "0.1.0"\n[lib]\npath = "src/core.rs"\n',
        "src/core.rs": '#[path = "modules/only_bin.rs"]\npub mod only_bin;\n',
        "src/lib.rs": '#[path = "modules/only_bin.rs"]\npub mod only_bin;\n',
        "src/modules/only_bin.rs": "pub fn greet() {}\n",
        "src/main.rs": "mod runner;\nmod only_bin;\nfn main() { runner::run(); }\n",
        "src/runner.rs": runner,
        "src/only_bin.rs": "pub fn greet() {}\n",
      });
      const runnerFile = path.join(root, "src/runner.rs");
      const binaryFile = path.join(root, "src/only_bin.rs");
      const imports = await collectImportsForFile(runnerFile, root);
      const named = imports.find((entry) => entry.kind === "named" && entry.imported === "greet");
      expect(resolvedFileKey(named?.resolved)).toBe(fileIdentityKey(binaryFile));
      const superImport = imports.find((entry) => entry.kind === "named" && entry.local === "from_super");
      expect(resolvedFileKey(superImport?.resolved)).toBe(fileIdentityKey(binaryFile));
      const index = await buildProjectIndex(root, { cache: "off" });
      const goto = await goToDefinition(index, {
        file: runnerFile,
        line: 3,
        column: columnOf(callLine, "greet"),
      });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(binaryFile));
      const superGoto = await goToDefinition(index, {
        file: runnerFile,
        line: 3,
        column: columnOf(callLine, "from_super"),
      });
      expect(superGoto.status).toBe("ok");
      if (superGoto.status === "ok") {
        expect(fileIdentityKey(superGoto.definition.file)).toBe(fileIdentityKey(binaryFile));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Rust Cargo manifests are read only inside the project root", () => {
  it("ignores a symlinked Cargo.toml whose target lies outside the project", async (context) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "cg-cargo-outside-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-cargo-symlink-"));
    try {
      const use = 'use crate_a::greet;\nfn main() { println!("{}", greet()); }\n';
      await writeFixture(root, {
        "a/Cargo.toml": '[package]\nname = "crate_a"\nversion = "0.1.0"\n',
        "a/src/lib.rs": 'pub fn greet() -> &\'static str { "hi" }\n',
        "b/src/main.rs": use,
      });
      // The only manifest declaring the dependency lives outside the root.
      const external = path.join(outside, "Cargo.toml");
      await writeFile(
        external,
        '[package]\nname = "crate_b"\nversion = "0.1.0"\n[dependencies]\ncrate_a = { path = "../a" }\n',
      );
      try {
        await symlink(external, path.join(root, "b", "Cargo.toml"), "file");
      } catch (error) {
        if (isSymlinkUnavailable(error)) context.skip();
        throw error;
      }
      const index = await buildProjectIndex(root, { cache: "off" });
      const goto = await goToDefinition(index, {
        file: path.join(root, "b/src/main.rs"),
        line: 2,
        column: columnOf(use.split("\n")[1]!, "greet"),
      });
      expect(goto.status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("Rust binaries name their own library by [lib].name", () => {
  it("resolves `use custom::greet` and not the package name when [lib] renames the crate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-cargo-libname-"));
    try {
      const main = "use custom::greet;\nuse pkg::greet as wrong;\nfn main() { greet(); wrong(); }\n";
      await writeFixture(root, {
        "Cargo.toml": '[package]\nname = "pkg"\nversion = "0.1.0"\n\n[lib]\nname = "custom"\n',
        "src/lib.rs": "pub fn greet() {}\n",
        "src/main.rs": main,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const file = path.join(root, "src/main.rs");
      const lines = main.split("\n");
      const call = lines[2]!;
      const custom = await goToDefinition(index, { file, line: 3, column: columnOf(call, "greet") });
      expect(custom.status).toBe("ok");
      if (custom.status === "ok") {
        expect(fileIdentityKey(custom.definition.file)).toBe(fileIdentityKey(path.join(root, "src/lib.rs")));
      }
      // Cargo does not expose the library under the package name once [lib] renames it.
      expect((await goToDefinition(index, { file, line: 3, column: columnOf(call, "wrong") })).status).toBe(
        "not_found",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Rust own-library import target boundaries", () => {
  it("does not treat a different binary as the library when the package has no library target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-cargo-no-lib-"));
    try {
      const bin = "use pkg::greet;\nfn main() { greet(); }\n";
      await writeFixture(root, {
        "Cargo.toml": '[package]\nname = "pkg"\nversion = "0.1.0"\n',
        "src/main.rs": "pub fn greet() {}\nfn main() {}\n",
        "src/bin/cli.rs": bin,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const result = await goToDefinition(index, {
        file: path.join(root, "src/bin/cli.rs"),
        line: 2,
        column: columnOf(bin.split("\n")[1]!, "greet"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose a library to its own source under its package name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-cargo-lib-self-"));
    try {
      const lib = "pub fn greet() {}\nuse pkg::greet as called;\npub fn run() { called(); }\n";
      await writeFixture(root, {
        "Cargo.toml": '[package]\nname = "pkg"\nversion = "0.1.0"\n',
        "src/lib.rs": lib,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const result = await goToDefinition(index, {
        file: path.join(root, "src/lib.rs"),
        line: 3,
        column: columnOf(lib.split("\n")[2]!, "called"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves only binary targets into an explicit library root and its declared module tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-cargo-core-lib-"));
    try {
      const use = "use pkg::worker::greet;\nfn main() { greet(); }\n";
      await writeFixture(root, {
        "Cargo.toml":
          '[package]\nname = "pkg"\nversion = "0.1.0"\n[lib]\npath = "src/core.rs"\n[[bin]]\nname = "custom"\npath = "tools/custom.rs"\n',
        "src/core.rs": '#[path = "modules/worker.rs"]\npub mod worker;\n',
        "src/modules/worker.rs": "pub fn greet() {}\n",
        "src/main.rs": use,
        "src/bin/extra.rs": use,
        "tools/custom.rs": use,
        "src/unrelated.rs": use,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      for (const relative of ["src/main.rs", "src/bin/extra.rs", "tools/custom.rs"]) {
        const result = await goToDefinition(index, {
          file: path.join(root, relative),
          line: 2,
          column: columnOf(use.split("\n")[1]!, "greet"),
        });
        expect(result.status, relative).toBe("ok");
        if (result.status === "ok") {
          expect(fileIdentityKey(result.definition.file)).toBe(
            fileIdentityKey(path.join(root, "src/modules/worker.rs")),
          );
        }
      }
      const unrelated = await goToDefinition(index, {
        file: path.join(root, "src/unrelated.rs"),
        line: 2,
        column: columnOf(use.split("\n")[1]!, "greet"),
      });
      expect(unrelated.status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Rust impl methods own member_of edges and calls edges", () => {
  it("emits one calls edge per receiver call to Circle::area, member_of edges for impl methods, and never targets the same-named Square::area", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-"));
    try {
      const lib = [
        "pub struct Circle { pub radius: f64 }",
        "pub struct Square { pub side: f64 }",
        "",
        "impl Circle {",
        "    pub fn area(&self) -> f64 { self.radius * self.radius }",
        "}",
        "",
        "impl Square {",
        "    pub fn area(&self) -> f64 { self.side * self.side }",
        "}",
        "",
        "pub fn total(c: &Circle) -> f64 { c.area() }",
        "pub fn unit() -> f64 { Circle { radius: 1.0 }.area() }",
        "",
      ].join("\n");
      await writeFixture(root, {
        "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
        "src/lib.rs": lib,
      });
      const libFile = path.join(root, "src/lib.rs");
      const index = await buildProjectIndex(root, { cache: "off" });
      const lines = lib.split("\n");

      const paramGoto = await goToDefinition(index, {
        file: libFile,
        line: 12,
        column: columnOf(lines[11]!, "area"),
      });
      expect(paramGoto.status).toBe("ok");
      if (paramGoto.status === "ok") {
        expect(paramGoto.definition.range.start.line).toBe(5);
        expect(paramGoto.definition.range.start.line).not.toBe(9);
      }

      const literalGoto = await goToDefinition(index, {
        file: libFile,
        line: 13,
        column: columnOf(lines[12]!, "area"),
      });
      expect(literalGoto.status).toBe("ok");
      if (literalGoto.status === "ok") {
        expect(literalGoto.definition.range.start.line).toBe(5);
        expect(literalGoto.definition.range.start.line).not.toBe(9);
      }

      const refs = await findReferences(index, { file: libFile, line: 5, column: columnOf(lines[4]!, "area") });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.references.map((reference) => reference.range.start.line).sort((a, b) => a - b)).toEqual([5, 12, 13]);
      expect(refs.referenceCoverage?.state).toBe("complete");

      const decoyRefs = await findReferences(index, { file: libFile, line: 9, column: columnOf(lines[8]!, "area") });
      expect(decoyRefs.status).toBe("ok");
      if (decoyRefs.status !== "ok") return;
      expect(decoyRefs.references.map((reference) => reference.range.start.line)).toEqual([9]);
      expect(decoyRefs.referenceCoverage?.state).toBe("complete");

      const graph = await buildSymbolGraphDetailed(index);
      const circleId = defNodeIdAt(libFile, lib, "Circle", 0);
      const squareId = defNodeIdAt(libFile, lib, "Square", 0);
      const circleAreaId = defNodeIdAt(libFile, lib, "area", 0);
      const squareAreaId = defNodeIdAt(libFile, lib, "area", 1);
      const totalId = defNodeIdAt(libFile, lib, "total", 0);
      const unitId = defNodeIdAt(libFile, lib, "unit", 0);

      expect(graph.nodes.has(circleAreaId)).toBe(true);
      expect(graph.nodes.has(squareAreaId)).toBe(true);
      expect(
        graph.edges.some((edge) => edge.label === "member_of" && edge.from === circleAreaId && edge.to === circleId),
      ).toBe(true);
      expect(
        graph.edges.some((edge) => edge.label === "member_of" && edge.from === squareAreaId && edge.to === squareId),
      ).toBe(true);

      const totalCalls = graph.edges.filter((edge) => edge.label === "calls" && edge.from === totalId);
      expect(totalCalls.map((edge) => edge.to)).toEqual([circleAreaId]);
      const unitCalls = graph.edges.filter((edge) => edge.label === "calls" && edge.from === unitId);
      expect(unitCalls.map((edge) => edge.to)).toEqual([circleAreaId]);
      expect(graph.edges.some((edge) => edge.label === "calls" && edge.to === squareAreaId)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attributes trait-impl and generic impl methods to their self type and trait default methods to the trait", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-forms-"));
    try {
      const lib = [
        "pub trait Shape {",
        "    fn describe(&self) -> f64 { 1.0 }",
        "}",
        "",
        "pub struct Circle { pub radius: f64 }",
        "",
        "impl Shape for Circle {",
        "    pub fn area(&self) -> f64 { self.radius * self.radius }",
        "}",
        "",
        "pub struct Wrapper<T> { pub value: T }",
        "",
        "impl<T> Wrapper<T> {",
        "    pub fn get(&self) -> &T { &self.value }",
        "}",
        "",
        "pub trait Decoy {",
        "    fn describe(&self) -> f64 { 2.0 }",
        "}",
        "",
        "pub struct Square;",
        "",
        "impl Decoy for Square {",
        "    pub fn area(&self) -> f64 { 3.0 }",
        "}",
        "",
        "pub fn total(c: &Circle) -> f64 { c.describe() + c.area() }",
        "",
      ].join("\n");
      await writeFixture(root, {
        "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
        "src/lib.rs": lib,
      });
      const libFile = path.join(root, "src/lib.rs");
      const index = await buildProjectIndex(root, { cache: "off" });
      const lines = lib.split("\n");

      const paramGoto = await goToDefinition(index, {
        file: libFile,
        line: 27,
        column: columnOf(lines[26]!, "area"),
      });
      expect(paramGoto.status).toBe("ok");
      if (paramGoto.status === "ok") {
        expect(paramGoto.definition.range.start.line).toBe(8);
        expect(paramGoto.definition.range.start.line).not.toBe(24);
      }

      const refs = await findReferences(index, { file: libFile, line: 8, column: columnOf(lines[7]!, "area") });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.references.map((reference) => reference.range.start.line).sort((a, b) => a - b)).toEqual([8, 27]);
      expect(refs.referenceCoverage?.state).toBe("complete");

      const decoyRefs = await findReferences(index, { file: libFile, line: 24, column: columnOf(lines[23]!, "area") });
      expect(decoyRefs.status).toBe("ok");
      if (decoyRefs.status !== "ok") return;
      expect(decoyRefs.references.map((reference) => reference.range.start.line)).toEqual([24]);
      expect(decoyRefs.referenceCoverage?.state).toBe("complete");

      const graph = await buildSymbolGraphDetailed(index);
      const shapeId = defNodeIdAt(libFile, lib, "Shape", 0);
      const decoyTraitId = defNodeIdAt(libFile, lib, "Decoy", 0);
      const circleId = defNodeIdAt(libFile, lib, "Circle", 0);
      const wrapperId = defNodeIdAt(libFile, lib, "Wrapper", 0);
      const squareId = defNodeIdAt(libFile, lib, "Square", 0);
      const describeId = defNodeIdAt(libFile, lib, "describe", 0);
      const decoyDescribeId = defNodeIdAt(libFile, lib, "describe", 1);
      const circleAreaId = defNodeIdAt(libFile, lib, "area", 0);
      const squareAreaId = defNodeIdAt(libFile, lib, "area", 1);
      const getId = defNodeIdAt(libFile, lib, "get", 0);
      const totalId = defNodeIdAt(libFile, lib, "total", 0);

      expect(
        graph.edges.some((edge) => edge.label === "member_of" && edge.from === describeId && edge.to === shapeId),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) => edge.label === "member_of" && edge.from === decoyDescribeId && edge.to === decoyTraitId,
        ),
      ).toBe(true);
      expect(
        graph.edges.some((edge) => edge.label === "member_of" && edge.from === circleAreaId && edge.to === circleId),
      ).toBe(true);
      expect(
        graph.edges.some((edge) => edge.label === "member_of" && edge.from === squareAreaId && edge.to === squareId),
      ).toBe(true);
      expect(
        graph.edges.some((edge) => edge.label === "member_of" && edge.from === getId && edge.to === wrapperId),
      ).toBe(true);

      const totalCalls = graph.edges.filter((edge) => edge.label === "calls" && edge.from === totalId);
      expect(totalCalls.map((edge) => edge.to).sort()).toEqual([circleAreaId, describeId].sort());
      expect(graph.edges.some((edge) => edge.label === "calls" && edge.to === squareAreaId)).toBe(false);
      expect(graph.edges.some((edge) => edge.label === "calls" && edge.to === decoyDescribeId)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Rust workspace-inherited dependency", () => {
  it("resolves workspace = true into the dependency [lib].path, excluding same-named decoys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-"));
    try {
      const a = 'pub fn greet() -> &\'static str { "hi" }\n';
      const c = 'pub fn greet() -> &\'static str { "decoy" }\n'; // decoy: same name, not a dependency of crate_b
      const b = 'use crate_a::greet;\nfn main() { println!("{}", greet()); }\n';
      await writeFixture(root, {
        "Cargo.toml":
          '[workspace]\nmembers = ["crate_a", "crate_b", "crate_c"]\n\n[workspace.dependencies]\ncrate_a = { path = "crate_a" }\n',
        "crate_a/Cargo.toml": '[package]\nname = "crate_a"\nversion = "0.1.0"\n[lib]\npath = "src/core.rs"\n',
        "crate_a/src/core.rs": a,
        "crate_a/src/lib.rs": c,
        "crate_b/Cargo.toml":
          '[package]\nname = "crate_b"\nversion = "0.1.0"\n[dependencies]\ncrate_a = { workspace = true }\n',
        "crate_b/src/main.rs": b,
        "crate_c/Cargo.toml": '[package]\nname = "crate_c"\nversion = "0.1.0"\n',
        "crate_c/src/lib.rs": c,
      });
      const aFile = path.join(root, "crate_a/src/core.rs");
      const bFile = path.join(root, "crate_b/src/main.rs");
      const index = await buildProjectIndex(root, { cache: "off" });

      const goto = await goToDefinition(index, { file: bFile, line: 2, column: columnOf(b.split("\n")[1]!, "greet") });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(aFile));
        expect(goto.definition.range.start.line).toBe(1);
      }

      const refs = await findReferences(index, { file: aFile, line: 1, column: columnOf(a, "greet") });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      const refFiles = refs.references.map((reference) => fileIdentityKey(reference.file)).sort();
      expect(refFiles).toEqual([fileIdentityKey(aFile), fileIdentityKey(bFile), fileIdentityKey(bFile)].sort());
      expect(refFiles).not.toContain(fileIdentityKey(path.join(root, "crate_c/src/lib.rs")));
      expect(refFiles).not.toContain(fileIdentityKey(path.join(root, "crate_a/src/lib.rs")));
      expect(refs.referenceCoverage?.state).toBe("complete");

      const graph = await buildSymbolGraphDetailed(index);
      const mainId = [...graph.nodes.entries()].find(([, node]) => node.name === "main")?.[0];
      const greetId = [...graph.nodes.entries()].find(
        ([, node]) => node.name === "greet" && fileIdentityKey(node.file ?? "") === fileIdentityKey(aFile),
      )?.[0];
      expect(mainId).toBeDefined();
      expect(greetId).toBeDefined();
      expect(graph.edges.some((edge) => edge.from === mainId && edge.to === greetId)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never reads a workspace manifest outside the project root, keeping an outside-workspace decoy unresolved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-confine-"));
    try {
      const project = path.join(root, "project");
      const decoyGreet = 'pub fn greet() -> &\'static str { "decoy" }\n';
      const b = 'use crate_a::greet;\nfn main() { println!("{}", greet()); }\n';
      await writeFixture(root, {
        // Outside the indexed project root: must never be consulted for `workspace = true`.
        // Its `path` points back inside the project so a leaked manifest read would wrongly
        // resolve the decoy crate rather than fall to null.
        "Cargo.toml": '[workspace]\n[workspace.dependencies]\ncrate_a = { path = "project/crate_a" }\n',
        "project/crate_a/Cargo.toml": '[package]\nname = "crate_a"\nversion = "0.1.0"\n',
        "project/crate_a/src/lib.rs": decoyGreet,
        "project/crate_b/Cargo.toml":
          '[package]\nname = "crate_b"\nversion = "0.1.0"\n[dependencies]\ncrate_a = { workspace = true }\n',
        "project/crate_b/src/main.rs": b,
      });
      const bFile = path.join(project, "crate_b/src/main.rs");
      const index = await buildProjectIndex(project, { cache: "off" });

      const goto = await goToDefinition(index, { file: bFile, line: 2, column: columnOf(b.split("\n")[1]!, "greet") });
      expect(goto.status).toBe("not_found");

      // The imported name resolves to nothing inside the project root, so there is no
      // definition whose references could include the decoy crate.
      const refs = await findReferences(index, {
        file: bFile,
        line: 1,
        column: columnOf(b.split("\n")[0]!, "greet"),
      });
      expect(refs.status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a path dependency only into a directory whose Cargo.toml names that package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-manifest-"));
    try {
      const greet = 'pub fn greet() -> &\'static str { "hi" }\n';
      const use = (crate: string): string => `use ${crate}::greet;\nfn main() { println!("{}", greet()); }\n`;
      await writeFixture(root, {
        // No Cargo.toml: Cargo rejects this dependency, so it must stay unresolved.
        "loose/src/lib.rs": greet,
        "no_manifest/Cargo.toml":
          '[package]\nname = "no_manifest"\nversion = "0.1.0"\n[dependencies]\nloose = { path = "../loose" }\n',
        "no_manifest/src/main.rs": use("loose"),
        // A manifest for a different package: also rejected by Cargo.
        "other_pkg/Cargo.toml": '[package]\nname = "something_else"\nversion = "0.1.0"\n',
        "other_pkg/src/lib.rs": greet,
        "wrong_name/Cargo.toml":
          '[package]\nname = "wrong_name"\nversion = "0.1.0"\n[dependencies]\nother_pkg = { path = "../other_pkg" }\n',
        "wrong_name/src/main.rs": use("other_pkg"),
        // A `package = "..."` rename binds the local key to the real package name.
        "renamed/Cargo.toml":
          '[package]\nname = "renamed"\nversion = "0.1.0"\n[dependencies]\nalias = { path = "../other_pkg", package = "something_else" }\n',
        "renamed/src/main.rs": use("alias"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const gotoIn = async (crate: string, dir: string) =>
        await goToDefinition(index, {
          file: path.join(root, dir, "src/main.rs"),
          line: 2,
          column: columnOf(use(crate).split("\n")[1]!, "greet"),
        });

      expect((await gotoIn("loose", "no_manifest")).status).toBe("not_found");
      expect((await gotoIn("other_pkg", "wrong_name")).status).toBe("not_found");
      const renamed = await gotoIn("alias", "renamed");
      expect(renamed.status).toBe("ok");
      if (renamed.status === "ok") {
        expect(fileIdentityKey(renamed.definition.file)).toBe(fileIdentityKey(path.join(root, "other_pkg/src/lib.rs")));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
