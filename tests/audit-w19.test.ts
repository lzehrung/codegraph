import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndex, findReferences, goToDefinition, type FindReferencesResult } from "../src/index.js";

function columnOf(source: string, line: number, token: string, occurrence = 0): number {
  const text = source.split("\n")[line - 1] ?? "";
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = text.indexOf(token, from);
    if (found < 0) throw new Error(`missing ${JSON.stringify(token)} on line ${line}: ${text}`);
    if (index === occurrence) return found + 1;
    from = found + token.length;
  }
  throw new Error(`missing ${JSON.stringify(token)} on line ${line}`);
}

function referenceLines(result: FindReferencesResult): number[] {
  if (result.status !== "ok") throw new Error(`findReferences status ${result.status}`);
  return result.references.map((reference) => reference.range.start.line).sort((left, right) => left - right);
}

async function withFile(name: string, source: string, run: (file: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-audit-w19-"));
  const file = path.join(root, name);
  await writeFile(file, source);
  try {
    await run(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("forward references (W19)", () => {
  it("finds a TypeScript call to a function declared later, and not the nested decoy", async () => {
    const source = [
      "function a() {",
      "  return b();",
      "}",
      "function b() {",
      "  return 1;",
      "}",
      "function decoy() {",
      "  function b() {",
      "    return 2;",
      "  }",
      "  return b();",
      "}",
      "",
    ].join("\n");
    await withFile("forward.ts", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const defined = await goToDefinition(index, { file, line: 2, column: columnOf(source, 2, "b") });
      expect(defined.status).toBe("ok");
      if (defined.status === "ok") expect(defined.definition.range.start.line).toBe(4);

      const refs = await findReferences(index, { file, line: 4, column: columnOf(source, 4, "b") });
      expect(referenceLines(refs)).toEqual([2, 4]);
      if (refs.status === "ok") expect(refs.referenceCoverage?.state).toBe("complete");
    });
  });

  it("names a later const from inside the block, and not a const in a nested block", async () => {
    const source = [
      "const x = 1;",
      "function f() {",
      "  console.log(x);",
      "  const x = 2;",
      "}",
      "function outer() {",
      "  console.log(x);",
      "  {",
      "    const x = 3;",
      "  }",
      "}",
      "",
    ].join("\n");
    await withFile("tdz.ts", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const inner = await findReferences(index, { file, line: 4, column: columnOf(source, 4, "x") });
      expect(referenceLines(inner)).toEqual([3, 4]);
      if (inner.status === "ok") expect(inner.referenceCoverage?.state).toBe("complete");

      const outer = await findReferences(index, { file, line: 1, column: columnOf(source, 1, "x") });
      expect(referenceLines(outer)).toEqual([1, 7]);
      if (outer.status === "ok") expect(outer.referenceCoverage?.state).toBe("complete");
    });
  });

  it("finds a Python call to a function declared later, and not the nested decoy", async () => {
    const source = [
      "def a():",
      "    return b()",
      "def b():",
      "    return 1",
      "def decoy():",
      "    def b():",
      "        return 2",
      "    return b()",
      "",
    ].join("\n");
    await withFile("forward.py", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const defined = await goToDefinition(index, { file, line: 2, column: columnOf(source, 2, "b") });
      expect(defined.status).toBe("ok");
      if (defined.status === "ok") expect(defined.definition.range.start.line).toBe(3);

      const refs = await findReferences(index, { file, line: 3, column: columnOf(source, 3, "b") });
      expect(referenceLines(refs)).toEqual([2, 3]);
      if (refs.status === "ok") expect(refs.referenceCoverage?.state).toBe("complete");
    });
  });

  it("makes a Python assignment local to the whole function, including a nested block", async () => {
    const source = [
      "x = 1",
      "def f():",
      "    print(x)",
      "    if True:",
      "        x = 2",
      "def decoy():",
      "    print(x)",
      "",
    ].join("\n");
    await withFile("local.py", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const local = await findReferences(index, { file, line: 5, column: columnOf(source, 5, "x") });
      expect(referenceLines(local)).toEqual([3, 5]);
      if (local.status === "ok") expect(local.referenceCoverage?.state).toBe("complete");

      const globalName = await findReferences(index, { file, line: 1, column: columnOf(source, 1, "x") });
      expect(referenceLines(globalName)).toEqual([1, 7]);
      if (globalName.status === "ok") expect(globalName.referenceCoverage?.state).toBe("complete");
    });
  });

  it("finds a Rust call to a function declared later, and not the nested decoy", async () => {
    const source = ["fn a() { b(); }", "fn b() {}", "fn decoy() {", "    fn b() {}", "    b();", "}", ""].join("\n");
    await withFile("forward.rs", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const defined = await goToDefinition(index, { file, line: 1, column: columnOf(source, 1, "b") });
      expect(defined.status).toBe("ok");
      if (defined.status === "ok") expect(defined.definition.range.start.line).toBe(2);

      const refs = await findReferences(index, { file, line: 2, column: columnOf(source, 2, "b") });
      expect(referenceLines(refs)).toEqual([1, 2]);
      if (refs.status === "ok") expect(refs.referenceCoverage?.state).toBe("complete");
    });
  });

  it("finds a Go call to a function declared later, and not the shadowed local", async () => {
    const source = [
      "package p",
      "",
      "func a() int { return b() }",
      "func b() int { return 1 }",
      "func decoy() int {",
      "\tbefore := b()",
      "\tb := func() int { return 2 }",
      "\treturn b() + before",
      "}",
      "",
    ].join("\n");
    await withFile("forward.go", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const defined = await goToDefinition(index, { file, line: 3, column: columnOf(source, 3, "b") });
      expect(defined.status).toBe("ok");
      if (defined.status === "ok") expect(defined.definition.range.start.line).toBe(4);

      const refs = await findReferences(index, { file, line: 4, column: columnOf(source, 4, "b") });
      expect(referenceLines(refs)).toEqual([3, 4, 6]);
      if (refs.status === "ok") expect(refs.referenceCoverage?.state).toBe("complete");

      const local = await findReferences(index, { file, line: 7, column: columnOf(source, 7, "b") });
      expect(referenceLines(local)).toEqual([7, 8]);
      if (local.status === "ok") expect(local.referenceCoverage?.state).toBe("complete");
    });
  });

  it("does not let a later C declaration capture an earlier use in the same block", async () => {
    const source = [
      "int x = 1;",
      "void f(void) {",
      "  use(x);",
      "  int x = 2;",
      "}",
      "void decoy(void) {",
      "  int x = 3;",
      "  use(x);",
      "}",
      "",
    ].join("\n");
    await withFile("block.c", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const earlier = await goToDefinition(index, { file, line: 3, column: columnOf(source, 3, "x") });
      expect(earlier.status).toBe("ok");
      if (earlier.status === "ok") expect(earlier.definition.range.start.line).toBe(1);

      const outer = await findReferences(index, { file, line: 1, column: columnOf(source, 1, "x") });
      expect(referenceLines(outer)).toEqual([1, 3]);
      if (outer.status === "ok") expect(outer.referenceCoverage?.state).toBe("complete");

      const later = await findReferences(index, { file, line: 4, column: columnOf(source, 4, "x") });
      expect(referenceLines(later)).toEqual([4]);
      if (later.status === "ok") expect(later.referenceCoverage?.state).toBe("complete");

      const decoy = await findReferences(index, { file, line: 7, column: columnOf(source, 7, "x") });
      expect(referenceLines(decoy)).toEqual([7, 8]);
      if (decoy.status === "ok") expect(decoy.referenceCoverage?.state).toBe("complete");
    });
  });
});
