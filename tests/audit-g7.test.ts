import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../src/index.js";
import { fileIdentityKey } from "../src/util/paths.js";

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

describe("Rust impl methods own member_of edges and calls edges (G7)", () => {
  it("emits one calls edge per receiver call to Circle::area, member_of edges for impl methods, and never targets the same-named Square::area", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-g7-"));
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
        graph.edges.some(
          (edge) => edge.label === "member_of" && edge.from === circleAreaId && edge.to === circleId,
        ),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) => edge.label === "member_of" && edge.from === squareAreaId && edge.to === squareId,
        ),
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
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-g7-forms-"));
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

      expect(graph.edges.some((edge) => edge.label === "member_of" && edge.from === describeId && edge.to === shapeId)).toBe(true);
      expect(
        graph.edges.some((edge) => edge.label === "member_of" && edge.from === decoyDescribeId && edge.to === decoyTraitId),
      ).toBe(true);
      expect(
        graph.edges.some((edge) => edge.label === "member_of" && edge.from === circleAreaId && edge.to === circleId),
      ).toBe(true);
      expect(
        graph.edges.some((edge) => edge.label === "member_of" && edge.from === squareAreaId && edge.to === squareId),
      ).toBe(true);
      expect(graph.edges.some((edge) => edge.label === "member_of" && edge.from === getId && edge.to === wrapperId)).toBe(true);

      const totalCalls = graph.edges.filter((edge) => edge.label === "calls" && edge.from === totalId);
      expect(totalCalls.map((edge) => edge.to).sort()).toEqual([circleAreaId, describeId].sort());
      expect(graph.edges.some((edge) => edge.label === "calls" && edge.to === squareAreaId)).toBe(false);
      expect(graph.edges.some((edge) => edge.label === "calls" && edge.to === decoyDescribeId)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Rust workspace-inherited dependency (H15)", () => {
  it("resolves use crate_a::greet through workspace = true to the root [workspace.dependencies] path, excluding a decoy crate with the same function", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-h15-"));
    try {
      const a = 'pub fn greet() -> &\'static str { "hi" }\n';
      const c = 'pub fn greet() -> &\'static str { "decoy" }\n'; // decoy: same name, not a dependency of crate_b
      const b = 'use crate_a::greet;\nfn main() { println!("{}", greet()); }\n';
      await writeFixture(root, {
        "Cargo.toml":
          '[workspace]\nmembers = ["crate_a", "crate_b", "crate_c"]\n\n[workspace.dependencies]\ncrate_a = { path = "crate_a" }\n',
        "crate_a/Cargo.toml": '[package]\nname = "crate_a"\nversion = "0.1.0"\n',
        "crate_a/src/lib.rs": a,
        "crate_b/Cargo.toml":
          '[package]\nname = "crate_b"\nversion = "0.1.0"\n[dependencies]\ncrate_a = { workspace = true }\n',
        "crate_b/src/main.rs": b,
        "crate_c/Cargo.toml": '[package]\nname = "crate_c"\nversion = "0.1.0"\n',
        "crate_c/src/lib.rs": c,
      });
      const aFile = path.join(root, "crate_a/src/lib.rs");
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
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-h15-confine-"));
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
});
