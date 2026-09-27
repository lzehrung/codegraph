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

import { bindingCoversUse, scopeNodesFor } from "../src/indexer/scope-nodes.js";

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

  it("keeps a PHP variable separate from a same-named class", async () => {
    const source = [
      "<?php",
      "class widget {}",
      "echo $widget;",
      "$widget = 1;",
      "echo $widget;",
      "new widget();",
      "",
    ].join("\n");
    await withFile("separate-namespaces.php", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const before = await goToDefinition(index, { file, line: 3, column: columnOf(source, 3, "$widget") });
      expect(before.status).toBe("not_found");
      const assigned = await goToDefinition(index, { file, line: 5, column: columnOf(source, 5, "$widget") });
      expect(assigned.status).toBe("ok");
      if (assigned.status === "ok") expect(assigned.definition.range.start.line).toBe(4);
      const variableRefs = await findReferences(index, { file, line: 4, column: columnOf(source, 4, "$widget") });
      expect(referenceLines(variableRefs)).toEqual([4, 5]);
      const classUse = await goToDefinition(index, { file, line: 6, column: columnOf(source, 6, "widget") });
      expect(classUse.status).toBe("ok");
      if (classUse.status === "ok") expect(classUse.definition.range.start.line).toBe(2);
      const classRefs = await findReferences(index, { file, line: 2, column: columnOf(source, 2, "widget") });
      expect(referenceLines(classRefs)).toEqual([2, 6]);
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

  it("does not give a SQL assignment whole-file forward coverage", () => {
    const source = "SELECT amount FROM ledger;\nUPDATE ledger SET amount = 1;";
    const before = source.indexOf("amount");
    const declaration = source.lastIndexOf("amount");
    const binding = {
      def: {
        start: { line: 2, column: 19, index: declaration },
        end: { line: 2, column: 25, index: declaration + "amount".length },
      },
    };
    expect(bindingCoversUse(scopeNodesFor("sql"), "module", binding, before)).toBe(false);
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
  it("skips Python class bindings from methods, nested classes, and comprehension elements", async () => {
    const source = [
      "x = 1",
      "class C:",
      "    x = 2",
      "    y = x",
      "    def m(self):",
      "        return x",
      "    class Inner:",
      "        y = x",
      "def enclosing():",
      "    hidden = 1",
      "    class Box:",
      "        hidden = 2",
      "        def m(self):",
      "            return hidden",
      "    return Box",
      "class G:",
      "    xs = [1]",
      "    ys = [v for v in xs]",
      "    zs = [xs for v in range(1)]",
      "",
    ].join("\n");
    await withFile("class-scope.py", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      for (const [line, token, target] of [
        [4, "x", 3],
        [6, "x", 1],
        [8, "x", 1],
        [14, "hidden", 10],
        [18, "xs", 17],
      ] as const) {
        const hit = await goToDefinition(index, { file, line, column: columnOf(source, line, token) });
        expect(hit.status).toBe("ok");
        if (hit.status === "ok") expect(hit.definition.range.start.line).toBe(target);
      }
      const missing = await goToDefinition(index, { file, line: 19, column: columnOf(source, 19, "xs") });
      expect(missing.status).toBe("not_found");
      for (const [line, name, expected] of [
        [1, "x", [1, 6, 8]],
        [3, "x", [3, 4]],
        [10, "hidden", [10, 14]],
        [17, "xs", [17, 18]],
      ] as const) {
        const refs = await findReferences(index, { file, line, column: columnOf(source, line, name) });
        expect(referenceLines(refs)).toEqual(expected);
        if (refs.status === "ok") expect(refs.referenceCoverage?.state).toBe("complete");
      }
    });
  });

  it("uses the outer Kotlin property before a later local declaration", async () => {
    const source = [
      'val outer = "file"',
      "fun shadowed(): String {",
      "    val value = outer",
      '    val outer = "local"',
      "    return value",
      "}",
      "class Box {",
      '    val field = "field"',
      "    fun read(): String {",
      "        val value = field",
      '        val field = "local"',
      "        return value",
      "    }",
      "}",
      "class Later {",
      "    fun before() = later",
      "    val later = 1",
      "}",
      "",
    ].join("\n");
    await withFile("outer.kt", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      for (const [line, token, target] of [
        [3, "outer", 1],
        [10, "field", 8],
        [16, "later", 17],
      ] as const) {
        const hit = await goToDefinition(index, { file, line, column: columnOf(source, line, token) });
        expect(hit.status).toBe("ok");
        if (hit.status === "ok") expect(hit.definition.range.start.line).toBe(target);
      }
      for (const [line, token, expected] of [
        [1, "outer", [1, 3]],
        [4, "outer", [4]],
        [8, "field", [8, 10]],
        [11, "field", [11]],
        [17, "later", [16, 17]],
      ] as const) {
        const refs = await findReferences(index, { file, line, column: columnOf(source, line, token) });
        expect(referenceLines(refs)).toEqual(expected);
        if (refs.status === "ok") expect(refs.referenceCoverage?.state).toBe("complete");
      }
    });
  });

  it("does not resolve a C# field through a later local that hides it for the block", async () => {
    const source = [
      "class Before {",
      "    static int outer = 1;",
      "    static int Shadowed() {",
      "        int value = outer;",
      "        int outer = 2;",
      "        return value;",
      "    }",
      "    static int Unshadowed() { return outer; }",
      "}",
      "",
    ].join("\n");
    await withFile("shadowed.cs", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      const earlier = await goToDefinition(index, { file, line: 4, column: columnOf(source, 4, "outer") });
      expect(earlier.status).toBe("not_found");
      const field = await goToDefinition(index, { file, line: 8, column: columnOf(source, 8, "outer") });
      expect(field.status).toBe("ok");
      if (field.status === "ok") expect(field.definition.range.start.line).toBe(2);
      for (const [line, expected] of [
        [2, [2, 8]],
        [5, [5]],
      ] as const) {
        const refs = await findReferences(index, { file, line, column: columnOf(source, line, "outer") });
        expect(referenceLines(refs)).toEqual(expected);
        if (refs.status === "ok") expect(refs.referenceCoverage?.state).toBe("complete");
      }
    });
  });

  it("keeps Go outer references before inner short declarations", async () => {
    const source = [
      "package scopego",
      "var Outer = 1",
      "func Shadowed() int {",
      "    value := Outer",
      "    Outer := 2",
      "    return value + Outer",
      "}",
      "func Block() int {",
      "    outer := 1",
      "    func() {",
      "        value := outer",
      "        outer := 2",
      "        _ = value + outer",
      "    }()",
      "    return outer",
      "}",
      "func Unshadowed() int { return Outer }",
      "",
    ].join("\n");
    await withFile("shadowed.go", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      for (const [line, token, target] of [
        [4, "Outer", 2],
        [11, "outer", 9],
      ] as const) {
        const hit = await goToDefinition(index, { file, line, column: columnOf(source, line, token) });
        expect(hit.status).toBe("ok");
        if (hit.status === "ok") expect(hit.definition.range.start.line).toBe(target);
      }
      for (const [line, token, expected] of [
        [2, "Outer", [2, 4, 17]],
        [5, "Outer", [5, 6]],
        [9, "outer", [9, 11, 15]],
        [12, "outer", [12, 13]],
      ] as const) {
        const refs = await findReferences(index, { file, line, column: columnOf(source, line, token) });
        expect(referenceLines(refs)).toEqual(expected);
        if (refs.status === "ok") expect(refs.referenceCoverage?.state).toBe("complete");
      }
    });
  });

  it("keeps parenthesized Ruby calls bound to methods despite a same-named local", async () => {
    const source = [
      "class Painter",
      "  def render(value = 0)",
      "    value",
      "  end",
      "  def explicit_call",
      "    render()",
      "    render = 1",
      "    render(1)",
      "    render",
      "  end",
      "end",
      "",
    ].join("\n");
    await withFile("explicit-call.rb", source, async (file) => {
      const index = await buildProjectIndex(path.dirname(file), { cache: "off" });
      for (const line of [6, 8]) {
        const hit = await goToDefinition(index, { file, line, column: columnOf(source, line, "render") });
        expect(hit.status).toBe("ok");
        if (hit.status === "ok") expect(hit.definition.range.start.line).toBe(2);
      }
      const bare = await goToDefinition(index, { file, line: 9, column: columnOf(source, 9, "render") });
      expect(bare.status).toBe("ok");
      if (bare.status === "ok") expect(bare.definition.range.start.line).toBe(7);
      for (const [line, expected] of [
        [2, [2, 6, 8]],
        [7, [7, 9]],
      ] as const) {
        const refs = await findReferences(index, { file, line, column: columnOf(source, line, "render") });
        expect(referenceLines(refs)).toEqual(expected);
        if (refs.status === "ok") expect(refs.referenceCoverage?.state).toBe("complete");
      }
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges.filter(
        (edge) =>
          edge.label === "calls" &&
          graph.nodes.get(edge.from)?.name === "explicit_call" &&
          graph.nodes.get(edge.to)?.name === "render",
      );
      expect(calls.map((edge) => edge.site?.range.start.line).sort()).toEqual([6, 8]);
      expect(calls.every((edge) => graph.nodes.get(edge.to)?.kind === "function")).toBe(true);
    });
  });
});
