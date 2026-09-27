import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  type FindReferencesResult,
} from "../src/index.js";

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

  it("does not attach an earlier Python module-level read to a later assignment", async () => {
    const source = ["print(value)", "value = 1", "print(value)", ""].join("\n");
    await withFile("module-order.py", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const earlier = await goToDefinition(index, { file, line: 1, column: columnOf(source, 1, "value") });
      expect(earlier.status).toBe("not_found");
      const later = await goToDefinition(index, { file, line: 3, column: columnOf(source, 3, "value") });
      expect(later.status).toBe("ok");
      if (later.status === "ok") expect(later.definition.range.start.line).toBe(2);
      const refs = await findReferences(index, { file, line: 2, column: columnOf(source, 2, "value") });
      expect(referenceLines(refs)).toEqual([2, 3]);
    });
  });

  it("does not attach a Python module-level call before its function is defined", async () => {
    const source = ["later()", "def read():", "    return later()", "def later():", "    return 1", "later()", ""].join(
      "\n",
    );
    await withFile("module-function-order.py", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const earlier = await goToDefinition(index, { file, line: 1, column: columnOf(source, 1, "later") });
      expect(earlier.status).toBe("not_found");
      const deferred = await goToDefinition(index, { file, line: 3, column: columnOf(source, 3, "later") });
      expect(deferred.status).toBe("ok");
      if (deferred.status === "ok") expect(deferred.definition.range.start.line).toBe(4);
      const refs = await findReferences(index, { file, line: 4, column: columnOf(source, 4, "later") });
      expect(referenceLines(refs)).toEqual([3, 4, 6]);
      const graph = await buildSymbolGraphDetailed(index);
      const callers = graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "later")
        .map((edge) => graph.nodes.get(edge.from)?.name);
      expect(callers).toEqual(["read"]);
    });
  });

  it("does not attach an earlier PHP variable read to a later assignment, but sees a later function", async () => {
    const source = [
      "<?php",
      "echo $value;",
      "$value = 1;",
      "echo $value;",
      "echo later();",
      "function later() { return 1; }",
      "",
    ].join("\n");
    await withFile("variable-order.php", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const earlier = await goToDefinition(index, { file, line: 2, column: columnOf(source, 2, "$value") });
      expect(earlier.status).toBe("not_found");
      const later = await goToDefinition(index, { file, line: 4, column: columnOf(source, 4, "$value") });
      expect(later.status).toBe("ok");
      if (later.status === "ok") expect(later.definition.range.start.line).toBe(3);
      const refs = await findReferences(index, { file, line: 3, column: columnOf(source, 3, "$value") });
      expect(referenceLines(refs)).toEqual([3, 4]);
      if (refs.status === "ok") expect(refs.references.map((ref) => ref.range.start.column)).toEqual([1, 6]);
      const functionUse = await goToDefinition(index, { file, line: 5, column: columnOf(source, 5, "later") });
      expect(functionUse.status).toBe("ok");
      if (functionUse.status === "ok") expect(functionUse.definition.range.start.line).toBe(6);
    });
  });

  it("does not attach an earlier Ruby local read to a later assignment, but sees a later method", async () => {
    const source = [
      "puts value",
      "value = 1",
      "puts value",
      "class Widget",
      "  def first",
      "    later",
      "  end",
      "  def later",
      "    1",
      "  end",
      "end",
      "",
    ].join("\n");
    await withFile("variable-order.rb", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const earlier = await goToDefinition(index, { file, line: 1, column: columnOf(source, 1, "value") });
      expect(earlier.status).toBe("not_found");
      const later = await goToDefinition(index, { file, line: 3, column: columnOf(source, 3, "value") });
      expect(later.status).toBe("ok");
      if (later.status === "ok") expect(later.definition.range.start.line).toBe(2);
      const refs = await findReferences(index, { file, line: 2, column: columnOf(source, 2, "value") });
      expect(referenceLines(refs)).toEqual([2, 3]);
      const method = await goToDefinition(index, { file, line: 6, column: columnOf(source, 6, "later") });
      expect(method.status).toBe("ok");
      if (method.status === "ok") expect(method.definition.range.start.line).toBe(8);
    });
  });
  it("does not invent a C# top-level local before its declaration", async () => {
    const source = ["System.Console.WriteLine(value);", "int value = 1;", "System.Console.WriteLine(value);", ""].join(
      "\n",
    );
    await withFile("statement-order.cs", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const earlier = await goToDefinition(index, { file, line: 1, column: columnOf(source, 1, "value") });
      expect(earlier.status).toBe("not_found");
      const later = await goToDefinition(index, { file, line: 3, column: columnOf(source, 3, "value") });
      expect(later.status).toBe("ok");
      if (later.status === "ok") expect(later.definition.range.start.line).toBe(2);
      const refs = await findReferences(index, { file, line: 2, column: columnOf(source, 2, "value") });
      expect(referenceLines(refs)).toEqual([2, 3]);
    });
  });

  it("does not invent a Kotlin declaration from an assignment", async () => {
    const source = "println(value)\nvalue = 1\n";
    await withFile("assignment-order.kts", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const earlier = await goToDefinition(index, { file, line: 1, column: columnOf(source, 1, "value") });
      expect(earlier.status).toBe("not_found");
      const later = await goToDefinition(index, { file, line: 2, column: columnOf(source, 2, "value") });
      expect(later.status).toBe("not_found");
    });
    const declared = ["var value = 0", "fun update() { value = 1 }", "fun read() = value", ""].join("\n");
    await withFile("property-order.kt", declared, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const write = await goToDefinition(index, { file, line: 2, column: columnOf(declared, 2, "value") });
      expect(write.status).toBe("ok");
      if (write.status === "ok") expect(write.definition.range.start.line).toBe(1);
      const read = await goToDefinition(index, { file, line: 3, column: columnOf(declared, 3, "value") });
      expect(read.status).toBe("ok");
      if (read.status === "ok") expect(read.definition.range.start.line).toBe(1);
      const refs = await findReferences(index, { file, line: 1, column: columnOf(declared, 1, "value") });
      expect(referenceLines(refs)).toEqual([1, 2, 3]);
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

  it.each([
    ["C", "c"],
    ["C++", "cpp"],
  ])("does not resolve a %s file-scope variable before its declaration", async (_language, extension) => {
    const source = [
      "int before(void) { return value; }",
      "int value = 1;",
      "int after(void) { return value; }",
      "",
    ].join("\n");
    await withFile(`forward.${extension}`, source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const earlier = await goToDefinition(index, { file, line: 1, column: columnOf(source, 1, "value") });
      expect(earlier.status).toBe("not_found");

      const later = await goToDefinition(index, { file, line: 3, column: columnOf(source, 3, "value") });
      expect(later.status).toBe("ok");
      if (later.status === "ok") expect(later.definition.range.start.line).toBe(2);

      const refs = await findReferences(index, { file, line: 2, column: columnOf(source, 2, "value") });
      expect(referenceLines(refs)).toEqual([2, 3]);
      if (refs.status === "ok") expect(refs.referenceCoverage?.state).toBe("complete");
    });
  });

  it.each([
    ["C", "c"],
    ["C++", "cpp"],
  ])("omits a %s call before its declaration from the graph", async (_language, extension) => {
    const source = [
      "int before(void) { return later(); }",
      "int later(void) { return 1; }",
      "int after(void) { return later(); }",
      "",
    ].join("\n");
    await withFile(`call-forward.${extension}`, source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      const callers = graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "later")
        .map((edge) => graph.nodes.get(edge.from)?.name);
      expect(callers).toEqual(["after"]);

      const earlier = await goToDefinition(index, { file, line: 1, column: columnOf(source, 1, "later") });
      expect(earlier.status).toBe("not_found");
      const later = await goToDefinition(index, { file, line: 3, column: columnOf(source, 3, "later") });
      expect(later.status).toBe("ok");
      if (later.status === "ok") expect(later.definition.range.start.line).toBe(2);
      const refs = await findReferences(index, { file, line: 2, column: columnOf(source, 2, "later") });
      expect(referenceLines(refs)).toEqual([2, 3]);
    });
  });

  it("keeps a C++ forward prototype visible before its later definition", async () => {
    const source = [
      "int later(void);",
      "int before(void) { return later(); }",
      "int later(void) { return 1; }",
      "int after(void) { return later(); }",
      "",
    ].join("\n");
    await withFile("prototype.cpp", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const before = await goToDefinition(index, { file, line: 2, column: columnOf(source, 2, "later") });
      expect(before.status).toBe("ok");
      if (before.status === "ok") expect(before.definition.range.start.line).toBe(3);
      const refs = await findReferences(index, { file, line: 1, column: columnOf(source, 1, "later") });
      expect(referenceLines(refs)).toEqual([1, 2, 3, 4]);

      const graph = await buildSymbolGraphDetailed(index);
      const callers = graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "later")
        .map((edge) => graph.nodes.get(edge.from)?.name)
        .sort();
      expect(callers).toEqual(["after", "before"]);
    });
  });

  it("resolves a C++ class member declared after its use in an earlier member function", async () => {
    const source = [
      "int value = 99;",
      "struct Widget {",
      "  int read() { return value; }",
      "  int value;",
      "};",
      "",
    ].join("\n");
    await withFile("member.cpp", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const memberUse = await goToDefinition(index, { file, line: 3, column: columnOf(source, 3, "value") });
      expect(memberUse.status).toBe("ok");
      if (memberUse.status === "ok") expect(memberUse.definition.range.start.line).toBe(4);

      const member = await findReferences(index, { file, line: 4, column: columnOf(source, 4, "value") });
      expect(referenceLines(member)).toEqual([3, 4]);
      if (member.status === "ok") expect(member.referenceCoverage?.state).toBe("complete");

      const global = await findReferences(index, { file, line: 1, column: columnOf(source, 1, "value") });
      expect(referenceLines(global)).toEqual([1]);
    });
  });
});
