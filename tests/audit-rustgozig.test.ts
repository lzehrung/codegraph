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

describe("Rust super::Type wrong-target navigation (W7)", () => {
  it("resolves super::Circle to the parent module's struct, never to the use site, keeping an unrelated decoy declaration precise", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-w7-"));
    try {
      const lib = [
        "pub mod util {",
        "    struct Square;", // decoy: an unrelated declaration in the same module scope
        "    pub fn square_radius(c: &super::Circle) -> f64 { c.radius * c.radius }",
        "}",
        "pub struct Circle { pub radius: f64 }",
        "",
      ].join("\n");
      await writeFixture(root, {
        "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
        "src/lib.rs": lib,
      });
      const libFile = path.join(root, "src/lib.rs");
      const index = await buildProjectIndex(root, { cache: "off" });
      const lines = lib.split("\n");

      const useLine = 3;
      const useCol = columnOf(lines[useLine - 1]!, "Circle", true);
      const goto = await goToDefinition(index, { file: libFile, line: useLine, column: useCol });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(goto.definition.kind).toBe("class");
        expect(goto.definition.range.start.line).toBe(5);
        expect(goto.definition.range.start.line).not.toBe(useLine);
      }

      const decoyLine = 2;
      const decoyGoto = await goToDefinition(index, {
        file: libFile,
        line: decoyLine,
        column: columnOf(lines[decoyLine - 1]!, "Square"),
      });
      expect(decoyGoto.status).toBe("ok");
      if (decoyGoto.status === "ok") expect(decoyGoto.definition.range.start.line).toBe(decoyLine);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes the super:: use as a reference when the struct is declared before its use", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-w7-refs-"));
    try {
      const lib = [
        "pub struct Circle { pub radius: f64 }",
        "pub mod util {",
        "    pub fn square_radius(c: &super::Circle) -> f64 { c.radius * c.radius }",
        "}",
        "",
      ].join("\n");
      await writeFixture(root, {
        "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
        "src/lib.rs": lib,
      });
      const libFile = path.join(root, "src/lib.rs");
      const index = await buildProjectIndex(root, { cache: "off" });
      const lines = lib.split("\n");

      const refs = await findReferences(index, { file: libFile, line: 1, column: columnOf(lines[0]!, "Circle") });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.references.map((reference) => reference.range.start.line).sort()).toEqual([1, 3]);
      expect(refs.referenceCoverage?.state).toBe("complete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Rust workspace path dependency (W8)", () => {
  it("resolves use crate_a::greet from crate_b's Cargo.toml path dependency, excluding an unrelated crate_c with the same function name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-w8-"));
    try {
      const a = 'pub fn greet() -> &\'static str { "hi" }\n';
      const c = 'pub fn greet() -> &\'static str { "decoy" }\n'; // decoy: same name, not a dependency of crate_b
      const b = 'use crate_a::greet;\nfn main() { println!("{}", greet()); }\n';
      await writeFixture(root, {
        "Cargo.toml": '[workspace]\nmembers = ["crate_a", "crate_b", "crate_c"]\n',
        "crate_a/Cargo.toml": '[package]\nname = "crate_a"\nversion = "0.1.0"\n',
        "crate_a/src/lib.rs": a,
        "crate_b/Cargo.toml":
          '[package]\nname = "crate_b"\nversion = "0.1.0"\n[dependencies]\ncrate_a = { path = "../crate_a" }\n',
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
});

describe("Go unexported cross-package access (W11)", () => {
  it("rejects goto/references/calls-edge for an unexported cross-package selector while same-package peer and exported access keep working", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-w11-"));
    try {
      const util =
        "package util\n\nfunc Square(x float64) float64 { return x * x }\n\nfunc hidden() int { return 2 }\n";
      const util2 = "package util\n\nfunc callHiddenFromPeer() int {\n\treturn hidden()\n}\n";
      const main =
        'package main\n\nimport u "example.com/proj/util"\n\nfunc main() {\n\t_ = u.Square(3.0)\n\t_ = u.hidden()\n}\n';
      await writeFixture(root, {
        "go.mod": "module example.com/proj\n\ngo 1.22\n",
        "util/util.go": util,
        "util/util2.go": util2,
        "main/main.go": main,
      });
      const utilFile = path.join(root, "util/util.go");
      const util2File = path.join(root, "util/util2.go");
      const mainFile = path.join(root, "main/main.go");
      const index = await buildProjectIndex(root, { cache: "off" });
      const mainLines = main.split("\n");

      const hiddenGoto = await goToDefinition(index, {
        file: mainFile,
        line: 7,
        column: columnOf(mainLines[6]!, "hidden"),
      });
      expect(hiddenGoto.status).toBe("not_found");

      const hiddenRefs = await findReferences(index, {
        file: utilFile,
        line: 5,
        column: columnOf(util.split("\n")[4]!, "hidden"),
      });
      expect(hiddenRefs.status).toBe("ok");
      if (hiddenRefs.status !== "ok") return;
      const hiddenRefFiles = hiddenRefs.references.map((reference) => fileIdentityKey(reference.file));
      expect(hiddenRefFiles).not.toContain(fileIdentityKey(mainFile));
      expect(hiddenRefFiles.some((file) => file === fileIdentityKey(util2File))).toBe(true);
      expect(hiddenRefs.referenceCoverage?.state).toBe("complete");

      const graph = await buildSymbolGraphDetailed(index);
      const mainFnId = [...graph.nodes.entries()].find(
        ([, node]) => node.name === "main" && fileIdentityKey(node.file ?? "") === fileIdentityKey(mainFile),
      )?.[0];
      const hiddenId = [...graph.nodes.entries()].find(([, node]) => node.name === "hidden")?.[0];
      expect(mainFnId).toBeDefined();
      expect(hiddenId).toBeDefined();
      expect(graph.edges.some((edge) => edge.from === mainFnId && edge.to === hiddenId)).toBe(false);

      // Controls: exported cross-package access, and same-package peer unexported access, both still work.
      const squareGoto = await goToDefinition(index, {
        file: mainFile,
        line: 6,
        column: columnOf(mainLines[5]!, "Square"),
      });
      expect(squareGoto.status).toBe("ok");

      const peerGoto = await goToDefinition(index, {
        file: util2File,
        line: 4,
        column: columnOf(util2.split("\n")[3]!, "hidden"),
      });
      expect(peerGoto.status).toBe("ok");
      if (peerGoto.status === "ok") expect(fileIdentityKey(peerGoto.definition.file)).toBe(fileIdentityKey(utilFile));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Zig self.method() references (W16)", () => {
  it("includes a same-container self.method() call and a cross-file instance call in references, keeping a same-named method on another struct separate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-w16-"));
    try {
      const shapes =
        "pub const Circle = struct {\n" +
        "    radius: f64,\n" +
        "    pub fn area(self: Circle) f64 { return self.radius * self.radius; }\n" +
        "    pub fn describe(self: Circle) f64 { return self.area() * 2.0; }\n" +
        "};\n";
      const decoy =
        "pub const Square = struct {\n" +
        "    side: f64,\n" +
        "    pub fn area(self: Square) f64 { return self.side * self.side; }\n" +
        "};\n"; // decoy: a same-named method on an unrelated struct
      const usage =
        'const shapes = @import("shapes.zig");\n' +
        "pub fn main() void {\n" +
        "    var c = shapes.Circle{ .radius = 2.0 };\n" +
        "    const a = c.area();\n" +
        "    _ = a;\n" +
        "}\n";
      await writeFixture(root, { "shapes.zig": shapes, "decoy.zig": decoy, "usage.zig": usage });
      const shapesFile = path.join(root, "shapes.zig");
      const decoyFile = path.join(root, "decoy.zig");
      const usageFile = path.join(root, "usage.zig");
      const index = await buildProjectIndex(root, { cache: "off" });
      const shapesLines = shapes.split("\n");

      const selfGoto = await goToDefinition(index, {
        file: shapesFile,
        line: 4,
        column: columnOf(shapesLines[3]!, "area"),
      });
      expect(selfGoto.status).toBe("ok");
      if (selfGoto.status === "ok") expect(selfGoto.definition.range.start.line).toBe(3);

      const refs = await findReferences(index, {
        file: shapesFile,
        line: 3,
        column: columnOf(shapesLines[2]!, "area"),
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      const refSites = refs.references
        .map((reference) => `${fileIdentityKey(reference.file)}:${reference.range.start.line}`)
        .sort();
      expect(refSites).toEqual(
        [
          `${fileIdentityKey(shapesFile)}:3`,
          `${fileIdentityKey(shapesFile)}:4`,
          `${fileIdentityKey(usageFile)}:4`,
        ].sort(),
      );
      expect(refs.referenceCoverage?.state).toBe("complete");

      const graph = await buildSymbolGraphDetailed(index);
      const describeId = [...graph.nodes.entries()].find(([, node]) => node.name === "describe")?.[0];
      const circleAreaId = [...graph.nodes.entries()].find(
        ([, node]) => node.name === "area" && fileIdentityKey(node.file ?? "") === fileIdentityKey(shapesFile),
      )?.[0];
      expect(describeId).toBeDefined();
      expect(circleAreaId).toBeDefined();
      expect(
        graph.edges.some((edge) => edge.from === describeId && edge.to === circleAreaId && edge.label === "calls"),
      ).toBe(true);

      const decoyRefs = await findReferences(index, {
        file: decoyFile,
        line: 3,
        column: columnOf(decoy.split("\n")[2]!, "area"),
      });
      expect(decoyRefs.status).toBe("ok");
      if (decoyRefs.status !== "ok") return;
      expect(decoyRefs.references.map((reference) => fileIdentityKey(reference.file))).not.toContain(
        fileIdentityKey(shapesFile),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Rust/Zig honest fixes (H13)", () => {
  it("resolves a bare name through a glob import across a nested inline module, excluding an unrelated sibling module's same-named function", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-h13-glob-"));
    try {
      const geometry = "pub mod util {\n    pub fn square(x: f64) -> f64 { x * x }\n}\n";
      const decoy = "pub fn square(x: f64) -> f64 { x + x }\n"; // decoy: unrelated module, must not be conflated
      const consumer = "use crate::geometry::util::*;\npub fn run() -> f64 {\n    square(3.0)\n}\n";
      const lib = "pub mod geometry;\npub mod decoy;\npub mod consumer;\n";
      await writeFixture(root, {
        "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
        "src/lib.rs": lib,
        "src/geometry.rs": geometry,
        "src/decoy.rs": decoy,
        "src/consumer.rs": consumer,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const consumerFile = path.join(root, "src/consumer.rs");
      const geometryFile = path.join(root, "src/geometry.rs");

      const goto = await goToDefinition(index, {
        file: consumerFile,
        line: 3,
        column: columnOf(consumer.split("\n")[2]!, "square"),
      });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(geometryFile));
        expect(goto.definition.range.start.line).toBe(2);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a struct-literal receiver's method, excluding a same-named method on a different struct", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-h13-litrecv-"));
    try {
      const src = [
        "pub struct Circle { pub radius: f64 }",
        "impl Circle { pub fn area(&self) -> f64 { self.radius * self.radius } }",
        "pub struct Square { pub side: f64 }",
        "impl Square { pub fn area(&self) -> f64 { self.side * self.side } }",
        "pub fn run() -> f64 { Circle { radius: 2.0 }.area() }",
        "",
      ].join("\n");
      await writeFixture(root, { "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n', "src/lib.rs": src });
      const index = await buildProjectIndex(root, { cache: "off" });
      const libFile = path.join(root, "src/lib.rs");

      const goto = await goToDefinition(index, {
        file: libFile,
        line: 5,
        column: columnOf(src.split("\n")[4]!, "area"),
      });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(goto.definition.range.start.line).toBe(2);
        expect(goto.definition.range.start.line).not.toBe(4);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a bin target's own-crate-name import to its library crate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-h13-owncrate-"));
    try {
      const geometryRs =
        "pub struct Circle { pub radius: f64 }\n" +
        "impl Circle {\n" +
        "    pub fn new(radius: f64) -> Self { Circle { radius } }\n" +
        "    pub fn area(&self) -> f64 { self.radius * self.radius }\n" +
        "}\n";
      const toolRs =
        'use audit_single::geometry::Circle;\nfn main() {\n    let c = Circle::new(1.0);\n    println!("{}", c.area());\n}\n';
      await writeFixture(root, {
        "Cargo.toml": '[package]\nname = "audit_single"\nversion = "0.1.0"\n',
        "src/lib.rs": "pub mod geometry;\n",
        "src/geometry.rs": geometryRs,
        "src/bin/tool.rs": toolRs,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const toolFile = path.join(root, "src/bin/tool.rs");
      const geometryFile = path.join(root, "src/geometry.rs");

      const goto = await goToDefinition(index, {
        file: toolFile,
        line: 1,
        column: columnOf(toolRs.split("\n")[0]!, "Circle"),
      });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(geometryFile));
        expect(goto.definition.kind).toBe("class");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a qualified Zig struct-literal receiver's method, excluding a same-named method in another file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-h13-ziglit-"));
    try {
      const shapes =
        "pub const Circle = struct {\n" +
        "    radius: f64,\n" +
        "    pub fn area(self: Circle) f64 { return self.radius * self.radius; }\n" +
        "};\n";
      const decoy =
        "pub const Circle = struct {\n" +
        "    side: f64,\n" +
        "    pub fn area(self: Circle) f64 { return self.side; }\n" +
        "};\n"; // decoy: an unrelated module's own Circle with the same method name
      const main =
        'const shapes = @import("shapes.zig");\n' +
        "pub fn main() void {\n" +
        "    var c = shapes.Circle{ .radius = 2.0 };\n" +
        "    const a = c.area();\n" +
        "    _ = a;\n" +
        "}\n";
      await writeFixture(root, { "shapes.zig": shapes, "decoy.zig": decoy, "main.zig": main });
      const index = await buildProjectIndex(root, { cache: "off" });
      const mainFile = path.join(root, "main.zig");
      const shapesFile = path.join(root, "shapes.zig");

      const goto = await goToDefinition(index, {
        file: mainFile,
        line: 4,
        column: columnOf(main.split("\n")[3]!, "area"),
      });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(shapesFile));
        expect(goto.definition.range.start.line).toBe(3);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
