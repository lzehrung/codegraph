import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../src/index.js";
import { mkTmpDir, normalizeTestPath } from "./helpers/filesystem.js";

/**
 * Regression coverage for the "declared-type receiver proof" audit items:
 * H2 (Kotlin companion-object factory), H3 (Kotlin extension function), H4 (C# member call
 * on a constructed nested/generic local), H5 (C# `using` alias to a concrete type), H6 (member
 * call on an explicitly typed parameter across Java/Kotlin/C#), and H7 (C++ member call on an
 * explicitly typed local/pointer). Each case asserts goToDefinition, findReferences (including
 * `referenceCoverage.state`), and a `buildSymbolGraphDetailed` `calls` edge, plus a decoy that
 * must NOT match.
 */

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(prefix: string, files: Record<string, string>) {
  const root = normalizeTestPath(await mkTmpDir(prefix));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
  const index = await buildProjectIndex(root, { cache: "off" });
  return { root, index, f: (rel: string) => normalizeTestPath(path.join(root, rel)) };
}

function locate(text: string, needle: string, occurrence = 0): { line: number; column: number } {
  let idx = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    idx = text.indexOf(needle, idx + 1);
    if (idx < 0) throw new Error(`needle "${needle}" occurrence ${occurrence} not found`);
  }
  const before = text.slice(0, idx);
  const lastNewline = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: idx - lastNewline };
}

describe("audit: declared-type receiver proof (H2-H7)", () => {
  describe("H6: member call on an explicitly typed parameter", () => {
    it("resolves Java void use(Greeter g) { g.hello(); } across files with an import", async () => {
      const declText = 'package a;\npublic class Greeter {\n  public String hello() { return "hi"; }\n}\n';
      const useText =
        "package b;\nimport a.Greeter;\npublic class User {\n  public String use(Greeter g) { return g.hello(); }\n}\n";
      const p = await fixture("cg-h6-java-", { "a/Greeter.java": declText, "b/User.java": useText });

      const goto = await goToDefinition(p.index, { file: p.f("b/User.java"), ...locate(useText, "hello", 0) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(goto.definition.localName).toBe("hello");
        expect(goto.definition.range.start.line).toBe(3);
      }

      const refs = await findReferences(p.index, { file: p.f("a/Greeter.java"), ...locate(declText, "hello", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references).toHaveLength(2);
        expect(refs.referenceCoverage.state).toBe("complete");
      }

      const graph = await buildSymbolGraphDetailed(p.index);
      const calls = graph.edges.filter(
        (edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "hello",
      );
      expect(calls).toHaveLength(1);
    });

    it("resolves C# member calls through a using-imported typed parameter", async () => {
      const declText = 'namespace A;\npublic class Greeter {\n  public string Hello() { return "hi"; }\n}\n';
      const useText =
        "using A;\nnamespace B;\npublic class User {\n  public string Use(Greeter g) { return g.Hello(); }\n}\n";
      const p = await fixture("cg-h6-csharp-", { "a/Greeter.cs": declText, "b/User.cs": useText });

      const goto = await goToDefinition(p.index, { file: p.f("b/User.cs"), ...locate(useText, "Hello", 0) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(3);

      const refs = await findReferences(p.index, { file: p.f("a/Greeter.cs"), ...locate(declText, "Hello", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references).toHaveLength(2);
        expect(refs.referenceCoverage.state).toBe("complete");
      }
    });

    it("resolves Kotlin member calls through an imported typed parameter", async () => {
      const declText = 'package a\nclass Greeter {\n  fun hello(): String = "hi"\n}\n';
      const useText = "package b\nimport a.Greeter\nfun use(g: Greeter): String { return g.hello() }\n";
      const p = await fixture("cg-h6-kotlin-", { "a/Greeter.kt": declText, "b/User.kt": useText });

      const goto = await goToDefinition(p.index, { file: p.f("b/User.kt"), ...locate(useText, "hello", 0) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(3);

      const refs = await findReferences(p.index, { file: p.f("a/Greeter.kt"), ...locate(declText, "hello", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") expect(refs.references).toHaveLength(2);
    });

    it("decoy: a variable reassigned after a typed local declaration is left unresolved, not misresolved", async () => {
      // Greeter and Other both declare hello(); g is declared Greeter, then reassigned before use.
      // A plausible bug would either wrongly bind to Other.hello() or keep trusting the stale
      // proof; the correct, honest answer is not_found once the binding becomes ambiguous.
      const text = [
        "public class P {",
        '  static class Greeter { String hello() { return "hi"; } }',
        '  static class Other { String hello() { return "nope"; } }',
        "  static String use(Object raw) {",
        "    Greeter g = (Greeter) raw;",
        "    g = null;",
        "    return g.hello();",
        "  }",
        "}",
        "",
      ].join("\n");
      const p = await fixture("cg-h6-decoy-", { "P.java": text });
      const goto = await goToDefinition(p.index, { file: p.f("P.java"), ...locate(text, "hello", 2) });
      expect(goto.status).toBe("not_found");
    });

    it("decoy: a generic type parameter T is not a proven receiver type", async () => {
      const text = [
        "public class Box<T> {",
        "  static class Other { String hello() { return \"nope\"; } }",
        "  String use(T item) {",
        "    return item.hello();",
        "  }",
        "}",
        "",
      ].join("\n");
      const p = await fixture("cg-h6-generic-decoy-", { "Box.java": text });
      const goto = await goToDefinition(p.index, { file: p.f("Box.java"), ...locate(text, "hello", 1) });
      expect(goto.status).toBe("not_found");
    });
  });

  describe("H7: C++ member call on an explicitly typed local/pointer", () => {
    it("resolves a stack-local receiver (Box b; b.run();)", async () => {
      const hpp = "class Box {\npublic:\n  int run();\n};\n";
      const cpp = '#include "box.hpp"\nint Box::run() { return 1; }\n';
      const use = '#include "box.hpp"\nint callWithLocal() {\n  Box b;\n  return b.run();\n}\n';
      const p = await fixture("cg-h7-local-", { "box.hpp": hpp, "box.cpp": cpp, "use.cpp": use });

      const goto = await goToDefinition(p.index, { file: p.f("use.cpp"), ...locate(use, "run", 0) });
      expect(goto.status).toBe("ok");
      // C++ goToDefinition targets the class-body prototype (box.hpp), not the out-of-line
      // definition in box.cpp.
      if (goto.status === "ok") {
        expect(goto.definition.range.start.line).toBe(3);
        expect(path.basename(goto.definition.file)).toBe("box.hpp");
      }

      const refs = await findReferences(p.index, { file: p.f("box.cpp"), ...locate(cpp, "run", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references.length).toBeGreaterThanOrEqual(3);
        expect(refs.referenceCoverage.state).toBe("complete");
      }

      const graph = await buildSymbolGraphDetailed(p.index);
      const calls = graph.edges.filter(
        (edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "run",
      );
      expect(calls).toHaveLength(1);
    });

    it("resolves a pointer receiver (Box* p = raw; p->run();)", async () => {
      const hpp = "class Box {\npublic:\n  int run();\n};\n";
      const cpp = '#include "box.hpp"\nint Box::run() { return 1; }\n';
      const use = '#include "box.hpp"\nint callWithPointer(Box* raw) {\n  Box* p = raw;\n  return p->run();\n}\n';
      const p = await fixture("cg-h7-pointer-", { "box.hpp": hpp, "box.cpp": cpp, "use.cpp": use });

      const goto = await goToDefinition(p.index, { file: p.f("use.cpp"), ...locate(use, "run", 0) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(goto.definition.range.start.line).toBe(3);
        expect(path.basename(goto.definition.file)).toBe("box.hpp");
      }
    });

    it("decoy: an auto-deduced local from a factory method is not a proven receiver type", async () => {
      const hpp = "class Box {\npublic:\n  int run();\n  static Box make();\n};\n";
      const cpp = '#include "box.hpp"\nint Box::run() { return 1; }\nBox Box::make() { return Box(); }\n';
      const use = '#include "box.hpp"\nint callWithAuto() {\n  auto b = Box::make();\n  return b.run();\n}\n';
      const p = await fixture("cg-h7-auto-decoy-", { "box.hpp": hpp, "box.cpp": cpp, "use.cpp": use });
      const goto = await goToDefinition(p.index, { file: p.f("use.cpp"), ...locate(use, "run", 0) });
      expect(goto.status).toBe("not_found");
    });

    it("decoy: a same-named method on an unrelated type does not match a typed local of a different type", async () => {
      const text = [
        "class Box {",
        "public:",
        "  int run();",
        "};",
        "class Widget {",
        "public:",
        "  int run();",
        "};",
        "int Box::run() { return 1; }",
        "int Widget::run() { return 2; }",
        "int use() {",
        "  Box b;",
        "  return b.run();",
        "}",
        "",
      ].join("\n");
      const p = await fixture("cg-h7-type-decoy-", { "use.cpp": text });
      const goto = await goToDefinition(p.index, { file: p.f("use.cpp"), ...locate(text, "run", 4) });
      expect(goto.status).toBe("ok");
      // Resolves to Box's own prototype (line 3), never Widget's (line 7) or either
      // out-of-line definition (lines 9-10).
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(3);
    });
  });

  describe("H2: Kotlin companion-object factory", () => {
    it("resolves Widget.create() to the companion-object member", async () => {
      const text =
        'class Widget(val id: Int) {\n  companion object {\n    fun create(): Widget = Widget(0)\n  }\n}\nfun use(): Widget = Widget.create()\n';
      const p = await fixture("cg-h2-companion-", { "w.kt": text });

      const goto = await goToDefinition(p.index, { file: p.f("w.kt"), ...locate(text, "create", 1) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(3);

      const refs = await findReferences(p.index, { file: p.f("w.kt"), ...locate(text, "create", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references).toHaveLength(2);
        expect(refs.referenceCoverage.state).toBe("complete");
      }

      const graph = await buildSymbolGraphDetailed(p.index);
      const calls = graph.edges.filter(
        (edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "create",
      );
      expect(calls).toHaveLength(1);
    });

    it("decoy: a same-named instance member on another type is not the companion factory", async () => {
      const text = [
        "class Widget(val id: Int) {",
        "  companion object {",
        "    fun create(): Widget = Widget(0)",
        "  }",
        "}",
        "class Gadget(val id: Int) {",
        "  fun create(): Gadget = this",
        "}",
        "fun use(g: Gadget): Gadget = g.create()",
        "",
      ].join("\n");
      const p = await fixture("cg-h2-decoy-", { "w.kt": text });
      const goto = await goToDefinition(p.index, { file: p.f("w.kt"), ...locate(text, "create", 2) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(7);
    });
  });

  describe("H3: Kotlin extension function", () => {
    it("resolves w.describe() to fun Widget.describe() through a proven receiver", async () => {
      const text =
        'class Widget(val id: Int)\nfun Widget.describe(): String = "widget"\nfun use(): String {\n  val w = Widget(0)\n  return w.describe()\n}\n';
      const p = await fixture("cg-h3-extension-", { "w.kt": text });

      const goto = await goToDefinition(p.index, { file: p.f("w.kt"), ...locate(text, "describe", 1) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(2);

      const refs = await findReferences(p.index, { file: p.f("w.kt"), ...locate(text, "describe", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") expect(refs.references).toHaveLength(2);

      const graph = await buildSymbolGraphDetailed(p.index);
      const calls = graph.edges.filter(
        (edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "describe",
      );
      expect(calls).toHaveLength(1);
    });

    it("decoy: a receiver of an unrelated type with its own same-named member is not the extension function", async () => {
      const text = [
        "class Widget(val id: Int)",
        "class Gadget(val id: Int) {",
        '  fun describe(): String = "gadget"',
        "}",
        'fun Widget.describe(): String = "widget"',
        "fun use(): String {",
        "  val g = Gadget(0)",
        "  return g.describe()",
        "}",
        "",
      ].join("\n");
      const p = await fixture("cg-h3-decoy-", { "w.kt": text });
      const goto = await goToDefinition(p.index, { file: p.f("w.kt"), ...locate(text, "describe", 2) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(3);
    });
  });

  describe("H4: C# member call on a constructed nested/generic local", () => {
    it("resolves i.Value() for var i = new Outer.Inner();", async () => {
      const text =
        "public class Outer {\n  public class Inner {\n    public int Value() => 42;\n  }\n}\npublic class User {\n  public int Use() {\n    var i = new Outer.Inner();\n    return i.Value();\n  }\n}\n";
      const p = await fixture("cg-h4-nested-", { "n.cs": text });

      const goto = await goToDefinition(p.index, { file: p.f("n.cs"), ...locate(text, "Value", 1) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(3);

      const refs = await findReferences(p.index, { file: p.f("n.cs"), ...locate(text, "Value", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references).toHaveLength(2);
        expect(refs.referenceCoverage.state).toBe("complete");
      }

      const graph = await buildSymbolGraphDetailed(p.index);
      const calls = graph.edges.filter(
        (edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "Value",
      );
      expect(calls).toHaveLength(1);
    });

    it("resolves b.Get() for var b = new Box<int>();", async () => {
      const text =
        "public class Box<T> {\n  public T Item = default!;\n  public T Get() => Item;\n}\npublic class User {\n  public int Use() {\n    var b = new Box<int>();\n    return b.Get();\n  }\n}\n";
      const p = await fixture("cg-h4-generic-", { "g.cs": text });

      const goto = await goToDefinition(p.index, { file: p.f("g.cs"), ...locate(text, "Get", 1) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(3);
    });

    it("decoy: a same-named member on an unrelated nested type does not match", async () => {
      const text = [
        "public class Outer {",
        "  public class Inner {",
        "    public int Value() => 42;",
        "  }",
        "}",
        "public class Other {",
        "  public class Nested {",
        "    public int Value() => 99;",
        "  }",
        "}",
        "public class User {",
        "  public int Use() {",
        "    var i = new Outer.Inner();",
        "    return i.Value();",
        "  }",
        "}",
        "",
      ].join("\n");
      const p = await fixture("cg-h4-decoy-", { "n.cs": text });
      const goto = await goToDefinition(p.index, { file: p.f("n.cs"), ...locate(text, "Value", 2) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(3);
    });
  });

  describe("H5: C# using alias to a concrete type", () => {
    it("resolves p.Sum() for PT p = new PT(); given using PT = N.Point;", async () => {
      const text =
        "using PT = N.Point;\nnamespace N {\n  public class Point {\n    public int Sum() => 1;\n  }\n}\nnamespace N {\n  public class User {\n    public int Use() {\n      PT p = new PT();\n      return p.Sum();\n    }\n  }\n}\n";
      const p = await fixture("cg-h5-alias-", { "pt.cs": text });

      const goto = await goToDefinition(p.index, { file: p.f("pt.cs"), ...locate(text, "Sum", 1) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(4);

      const refs = await findReferences(p.index, { file: p.f("pt.cs"), ...locate(text, "Sum", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references).toHaveLength(2);
        expect(refs.referenceCoverage.state).toBe("complete");
      }

      const graph = await buildSymbolGraphDetailed(p.index);
      const calls = graph.edges.filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "Sum");
      expect(calls).toHaveLength(1);
    });

    it("control: a using namespace alias (using NS = N;) still resolves NS.Point", async () => {
      const text =
        "namespace N {\n  public class Point {\n    public int Sum() => 1;\n  }\n}\nusing NS = N;\nnamespace M {\n  public class User {\n    public int Use() {\n      NS.Point p = new NS.Point();\n      return p.Sum();\n    }\n  }\n}\n";
      const p = await fixture("cg-h5-control-", { "pt.cs": text });
      const goto = await goToDefinition(p.index, { file: p.f("pt.cs"), ...locate(text, "Sum", 1) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(3);
    });

    it("decoy: a same-named member on an unrelated type is not the aliased type", async () => {
      const text = [
        "namespace N {",
        "  public class Point {",
        "    public int Sum() => 1;",
        "  }",
        "}",
        "namespace N2 {",
        "  public class Other {",
        "    public int Sum() => 2;",
        "  }",
        "}",
        "using PT = N.Point;",
        "namespace N {",
        "  public class User {",
        "    public int Use() {",
        "      PT p = new PT();",
        "      return p.Sum();",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n");
      const p = await fixture("cg-h5-decoy-", { "pt.cs": text });
      const goto = await goToDefinition(p.index, { file: p.f("pt.cs"), ...locate(text, "Sum", 2) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(3);
    });
  });
});
