import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { expect, it } from "vitest";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../src/index.js";
import type { ProjectIndex } from "../src/index.js";
import { createAgentSession } from "../src/agent/session.js";
import { previewRenameWithSession } from "../src/agent/rename-preview.js";

const options = { cache: "off" as const, threads: 1, useNativeWorkers: false };
const MAIN = "fixture.rb";

type Fixture = {
  root: string;
  file: string;
  source: string;
  index: ProjectIndex;
  /** The 1-based position of the `occurrence`th `token` on `line` of the file `name` (default `fixture.rb`). */
  at(line: number, token: string, occurrence?: number, name?: string): { file: string; line: number; column: number };
  /** The line `goToDefinition` answers at a token, or `not_found`. */
  gotoLine(line: number, token: string, occurrence?: number): Promise<number | "not_found">;
  /** The `file:line` `goToDefinition` answers at a token, or `not_found`. */
  gotoSite(line: number, token: string, occurrence?: number): Promise<string>;
  /** Reference lines and coverage of the declaration at a token of the file `name`. */
  references(line: number, token: string, name?: string): Promise<{ lines: number[]; coverage: string }>;
  /** Whether the rename preview at a token of the file `name` is safe, and the lines it edits. */
  rename(line: number, token: string, name?: string): Promise<{ safe: boolean; lines: number[] }>;
};

// Every fixture below is a complete Ruby program run from `fixture.rb`; the comment beside each records its Ruby 3.3
// output.
async function withFixture(
  source: string,
  run: (fixture: Fixture) => Promise<void>,
  otherFiles: Readonly<Record<string, string>> = {},
): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-singleton-redefinition-"));
  const file = path.join(root, MAIN);
  const files: Readonly<Record<string, string>> = { ...otherFiles, [MAIN]: source };
  try {
    for (const [name, text] of Object.entries(files)) await fsp.writeFile(path.join(root, name), text);
    const index = await buildProjectIndex(root, options);
    const at = (line: number, token: string, occurrence = 1, name = MAIN) => {
      const text = files[name];
      if (text === undefined) throw new Error(`No fixture file ${name}`);
      const lineText = text.split("\n")[line - 1] ?? "";
      let column = -1;
      for (let found = 0; found < occurrence; found += 1) column = lineText.indexOf(token, column + 1);
      if (column < 0) throw new Error(`No ${token} #${occurrence} on ${name}:${line}`);
      return { file: path.join(root, name), line, column: column + 1 };
    };
    await run({
      root,
      file,
      source,
      index,
      at,
      async gotoLine(line, token, occurrence) {
        const answer = await goToDefinition(index, at(line, token, occurrence));
        return answer.status === "ok" ? answer.definition.range.start.line : "not_found";
      },
      async gotoSite(line, token, occurrence) {
        const answer = await goToDefinition(index, at(line, token, occurrence));
        if (answer.status !== "ok") return "not_found";
        return `${path.basename(answer.definition.file)}:${answer.definition.range.start.line}`;
      },
      async references(line, token, name) {
        const refs = await findReferences(index, at(line, token, 1, name));
        if (refs.status !== "ok") throw new Error(`No references at ${name ?? MAIN}:${line}:${token}`);
        return {
          lines: refs.references.map((ref) => ref.range.start.line),
          coverage: refs.referenceCoverage.state,
        };
      },
      async rename(line, token, name = MAIN) {
        const preview = await previewRenameWithSession(
          createAgentSession({ root, useConfig: false, buildOptions: options }),
          { root, handle: `${name}:${line}:${at(line, token, 1, name).column}`, newName: "renamed" },
        );
        return { safe: preview.safe, lines: preview.edits.map((edit) => edit.range.start.line) };
      },
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

it("keeps a constructor call on another constant away from the enclosing class's singleton new", async () => {
  // Ruby 3.3: [7, :class_result, :class_result, :class_result]
  const source = [
    "class Example",
    "  def self.new(*args); :class_result; end",
    "  def self.build",
    "    [DontCall.new(7).value, new(1), self.new(2), Example.new(3)]",
    "  end",
    "  class DontCall",
    "    def initialize(value); @value = value; end",
    "    def value; @value; end",
    "  end",
    "end",
    "p Example.build",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(4, "new", 1)).toBe("not_found");
    for (const occurrence of [2, 3, 4]) expect(await fixture.gotoLine(4, "new", occurrence)).toBe(2);
    const constructorCall = fixture.at(4, "new", 1).column;
    const refs = await findReferences(fixture.index, fixture.at(2, "new"));
    expect(refs.status === "ok" && refs.referenceCoverage.state).toBe("complete");
    expect(
      refs.status === "ok" && refs.references.map((ref) => `${ref.range.start.line}:${ref.range.start.column}`),
    ).toEqual([
      `2:${fixture.at(2, "new").column}`,
      `4:${fixture.at(4, "new", 2).column}`,
      `4:${fixture.at(4, "new", 3).column}`,
      `4:${fixture.at(4, "new", 4).column}`,
    ]);
    const preview = await previewRenameWithSession(
      createAgentSession({ root: fixture.root, useConfig: false, buildOptions: options }),
      { root: fixture.root, handle: `fixture.rb:2:${fixture.at(2, "new").column}`, newName: "make" },
    );
    expect(preview.safe).toBe(true);
    expect(preview.edits.some((edit) => edit.range.start.column === constructorCall)).toBe(false);
    const graph = await buildSymbolGraphDetailed(fixture.index);
    const constructorCallEdges = graph.edges.filter(
      (edge) =>
        edge.label === "calls" && edge.site?.range.start.line === 4 && edge.site.range.start.column === constructorCall,
    );
    expect(constructorCallEdges).toEqual([]);
  });
});

it("never resolves a member call on another constant to the enclosing module's singleton method", async () => {
  // Ruby 3.3: [:no_method, :example]
  const source = [
    "module Example",
    "  def self.calc; :example; end",
    "  def self.run; [(Other.calc rescue :no_method), calc]; end",
    "  module Other",
    "  end",
    "end",
    "p Example.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(3, "calc", 1)).toBe("not_found");
    expect(await fixture.gotoLine(3, "calc", 2)).toBe(2);
  });
});

it("still resolves a type-name call to a reopened body and to an extended module", async () => {
  // Ruby 3.3: [:helper, :mixed]
  const source = [
    "module Mixin",
    "  def mixed; :mixed; end",
    "end",
    "class Foo",
    "  def self.base; :base; end",
    "end",
    "class Foo",
    "  extend Mixin",
    "  def self.helper; :helper; end",
    "end",
    "class Runner",
    "  def run; [Foo.helper, Foo.mixed]; end",
    "end",
    "p Runner.new.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(12, "helper")).toBe(9);
    expect(await fixture.gotoLine(12, "mixed")).toBe(2);
    expect(await fixture.references(2, "mixed")).toEqual({ lines: [2, 12], coverage: "complete" });
  });
});

it("keeps calls in a class << self body off the class's own singleton methods", async () => {
  // Ruby 3.3: :not_defined, :not_defined, :meta, 11
  const source = [
    "class Example",
    "  def self.calc; 11; end",
    "  class << self",
    "    p((calc rescue :not_defined))",
    "    [1].each { p((calc rescue :not_defined)) }",
    "    def self.meta; :meta; end",
    "    p meta",
    "    def run; calc; end",
    "  end",
    "end",
    "p Example.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(4, "calc")).toBe("not_found");
    expect(await fixture.gotoLine(5, "calc")).toBe("not_found");
    expect(await fixture.gotoLine(7, "meta")).toBe(6);
    expect(await fixture.gotoLine(8, "calc")).toBe(2);
    expect(await fixture.references(2, "calc")).toEqual({ lines: [2, 8], coverage: "complete" });
    expect(await fixture.rename(2, "calc")).toEqual({ safe: true, lines: [2, 8] });
    expect(await fixture.references(6, "meta")).toEqual({ lines: [6, 7], coverage: "complete" });
    const graph = await buildSymbolGraphDetailed(fixture.index);
    const calls = graph.edges.filter((edge) => edge.label === "calls");
    expect(calls.map((edge) => edge.site?.range.start.line)).toEqual([8]);
  });
});

it("keeps a top-level method unproven where a class << self body call may reach it", async () => {
  // Ruby 3.3: :top
  const source = [
    "def calc; :top; end",
    "class Example",
    "  def self.calc; 11; end",
    "  class << self",
    "    p calc",
    "  end",
    "end",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(5, "calc")).toBe("not_found");
    expect(await fixture.references(1, "calc")).toEqual({ lines: [1], coverage: "partial" });
    expect((await fixture.rename(1, "calc")).safe).toBe(false);
    expect(await fixture.references(3, "calc")).toEqual({ lines: [3], coverage: "complete" });
    expect(await fixture.rename(3, "calc")).toEqual({ safe: true, lines: [3] });
  });
});

it("gives each def token its own definition and each call the definition it runs", async () => {
  // Ruby 3.3: [2, :c1, :c2]. The second instance `def` replaces the first before any code runs, so only the class
  // methods, which `FIRST = calc` runs between, can each be called and keep partial references.
  const source = [
    "class Example",
    "  def calc; 1; end",
    "  def calc; 2; end",
    "  def self.calc; :c1; end",
    "  FIRST = calc",
    "  def self.calc; :c2; end",
    "  def run; calc; end",
    "end",
    "p [Example.new.run, Example::FIRST, Example.calc]",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    for (const line of [2, 3, 4, 6]) expect(await fixture.gotoLine(line, "calc")).toBe(line);
    expect(await fixture.gotoLine(5, "calc")).toBe(4);
    expect(await fixture.gotoLine(7, "calc")).toBe(3);
    expect(await fixture.gotoLine(9, "calc")).toBe(6);
    expect(await fixture.references(2, "calc")).toEqual({ lines: [2], coverage: "complete" });
    expect(await fixture.references(3, "calc")).toEqual({ lines: [3, 7], coverage: "complete" });
    expect(await fixture.references(4, "calc")).toEqual({ lines: [4, 5], coverage: "partial" });
    expect(await fixture.references(6, "calc")).toEqual({ lines: [6, 9], coverage: "partial" });
    const graph = await buildSymbolGraphDetailed(fixture.index);
    const runCall = graph.edges.find((edge) => edge.label === "calls" && edge.site?.range.start.line === 7);
    expect(runCall?.to.split("::").at(-1)).toBe(String(fixture.source.indexOf("calc; 2")));
  });
});

it("binds a top-level call between two definitions to the one defined before it", async () => {
  // Ruby 3.3: 1, 2. Code runs while each definition is the latest, so a call in a method body could reach either.
  const source = ["def calc; 1; end", "p calc", "def calc; 2; end", "p calc"].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(2, "calc")).toBe(1);
    expect(await fixture.gotoLine(4, "calc")).toBe(3);
    expect(await fixture.references(1, "calc")).toEqual({ lines: [1, 2], coverage: "partial" });
    expect((await fixture.rename(1, "calc")).safe).toBe(false);
    expect(await fixture.references(3, "calc")).toEqual({ lines: [3, 4], coverage: "partial" });
    expect((await fixture.rename(3, "calc")).safe).toBe(false);
  });
});

it("keeps both definitions partial where a method-body call may run between them", async () => {
  // Ruby 3.3: 1, 2
  const source = ["def calc; 1; end", "def run; calc; end", "p run", "def calc; 2; end", "p run"].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(1, "calc")).toBe(1);
    expect(await fixture.gotoLine(4, "calc")).toBe(4);
    expect((await fixture.references(1, "calc")).coverage).toBe("partial");
    expect((await fixture.rename(1, "calc")).safe).toBe(false);
    expect((await fixture.references(4, "calc")).coverage).toBe("partial");
    expect((await fixture.rename(4, "calc")).safe).toBe(false);
  });
});

it("binds a call in a method body to a method of the same self level", async () => {
  // Ruby 3.3: [[:i, 1], :c, :no_method]
  const source = [
    "class Example",
    "  def calc(a); [:i, a]; end",
    "  def self.calc; :c; end",
    "  def run; calc(1); end",
    "  def self.run; calc; end",
    "  def self.only; :only; end",
    "  def missing; (only rescue :no_method); end",
    "end",
    "p [Example.new.run, Example.run, Example.new.missing]",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(4, "calc")).toBe(2);
    expect(await fixture.gotoLine(5, "calc")).toBe(3);
    expect(await fixture.gotoLine(7, "only")).toBe("not_found");
    expect(await fixture.references(2, "calc")).toEqual({ lines: [2, 4], coverage: "complete" });
    expect(await fixture.rename(2, "calc")).toEqual({ safe: true, lines: [2, 4] });
    expect(await fixture.references(6, "only")).toEqual({ lines: [6], coverage: "complete" });
    const graph = await buildSymbolGraphDetailed(fixture.index);
    const instanceCall = graph.edges.find((edge) => edge.label === "calls" && edge.site?.range.start.line === 4);
    expect(instanceCall?.to.split("::").at(-1)).toBe(String(fixture.source.indexOf("calc(a)")));
  });
});

it("keeps both levels open in a module that extends itself", async () => {
  // Ruby 3.3: [:c, :inst]
  const source = [
    "module Tools",
    "  extend self",
    "  def self.helper; :c; end",
    "  def run; helper; end",
    "  def b; :inst; end",
    "  def self.a; b; end",
    "end",
    "p [Tools.run, Tools.a]",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(4, "helper")).toBe(3);
    expect(await fixture.gotoLine(6, "b")).toBe(5);
  });
});

it("keeps initialize references partial because new calls it without naming it", async () => {
  // Ruby 3.3: [3, :origin, :p]
  const source = [
    "class Point",
    "  def initialize(x); @x = x; end",
    "  def label; :p; end",
    "  def show; label; end",
    "end",
    "class Origin",
    "  def self.new; :origin; end",
    "end",
    "p [Point.new(3).instance_variable_get(:@x), Origin.new, Point.new(1).show]",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.references(2, "initialize")).toEqual({ lines: [2], coverage: "partial" });
    expect((await fixture.rename(2, "initialize")).safe).toBe(false);
    expect(await fixture.gotoLine(9, "new", 1)).toBe("not_found");
    expect(await fixture.gotoLine(9, "new", 2)).toBe(7);
    expect(await fixture.references(3, "label")).toEqual({ lines: [3, 4], coverage: "complete" });
    expect(await fixture.rename(3, "label")).toEqual({ safe: true, lines: [3, 4] });
  });
});

it("resolves a type-name call to a singleton method defined on the constant outside its body", async () => {
  // Ruby 3.3: [:bar, :baz, :qux, :none, :only]
  const source = [
    "class Foo; end",
    "class Other; end",
    "def Foo.bar; :bar; end",
    "class << Foo",
    "  def baz; :baz; end",
    "end",
    "Foo.singleton_class.class_eval do",
    "  def qux; :qux; end",
    "end",
    "def Other.only; :only; end",
    "class Client",
    "  def self.run",
    "    [Foo.bar, Foo.baz, Foo.qux,",
    "     (Foo.only rescue :none),",
    "     Other.only]",
    "  end",
    "end",
    "p Client.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(13, "bar")).toBe(3);
    expect(await fixture.gotoLine(13, "baz")).toBe(5);
    expect(await fixture.gotoLine(13, "qux")).toBe(8);
    expect(await fixture.gotoLine(14, "only")).toBe("not_found");
    expect(await fixture.gotoLine(15, "only")).toBe(10);
    expect(await fixture.references(5, "baz")).toEqual({ lines: [5, 13], coverage: "complete" });
    expect(await fixture.rename(5, "baz")).toEqual({ safe: true, lines: [5, 13] });
    expect(await fixture.references(8, "qux")).toEqual({ lines: [8, 13], coverage: "complete" });
  });
});

it("resolves a type-name call to another file's singleton methods on the constant", async () => {
  // Ruby 3.3: [:bar, :baz]
  const constantFile = ["class Foo; end", "def Foo.bar; :bar; end", "class << Foo", "  def baz; :baz; end", "end"];
  const source = [
    'require_relative "a"',
    "class Client",
    "  def go",
    "    [Foo.bar,",
    "     Foo.baz]",
    "  end",
    "end",
    "p Client.new.go",
  ].join("\n");
  await withFixture(
    source,
    async (fixture) => {
      expect(await fixture.gotoSite(4, "bar")).toBe("a.rb:2");
      expect(await fixture.gotoSite(5, "baz")).toBe("a.rb:4");
      expect(await fixture.references(4, "baz", "a.rb")).toEqual({ lines: [4, 5], coverage: "complete" });
    },
    { "a.rb": constantFile.join("\n") },
  );
});

it("keeps both levels open in a class the file shows answering any call", async () => {
  // Ruby 3.3: [:hi, :lifted, :chained, :sent, :none]
  const source = [
    "module Delegating",
    "  def method_missing(name, *args); new.send(name, *args); end",
    "  def respond_to_missing?(*); true; end",
    "end",
    "class Base",
    "  def self.method_missing(name, *args); new.send(name, *args); end",
    "  def self.respond_to_missing?(*); true; end",
    "end",
    "class Proxy < Base",
    "  def hello; :hi; end",
    "  def self.run; hello; end",
    "end",
    "class Lifted",
    "  def lifted; :lifted; end",
    "  def self.run; lifted; end",
    "  class << self",
    "    include Delegating",
    "  end",
    "end",
    "class Chained",
    "  def chained; :chained; end",
    "  def self.run; chained; end",
    "end",
    "Chained.singleton_class.include(Delegating)",
    "class Sent",
    "  def sent; :sent; end",
    "  def self.run; sent; end",
    "end",
    "Sent.send(:extend, Delegating)",
    "class Plain",
    "  def plain_helper; :plain; end",
    "  def self.run; (plain_helper rescue :none); end",
    "end",
    "p [Proxy.run, Lifted.run, Chained.run, Sent.run, Plain.run]",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(11, "hello")).toBe(10);
    expect(await fixture.gotoLine(15, "lifted")).toBe(14);
    expect(await fixture.gotoLine(22, "chained")).toBe(21);
    expect(await fixture.gotoLine(27, "sent")).toBe(26);
    expect(await fixture.gotoLine(32, "plain_helper")).toBe("not_found");
    expect(await fixture.references(10, "hello")).toEqual({ lines: [10, 11], coverage: "complete" });
    expect(await fixture.rename(10, "hello")).toEqual({ safe: true, lines: [10, 11] });
    expect(await fixture.references(21, "chained")).toEqual({ lines: [21, 22], coverage: "complete" });
    expect(await fixture.references(26, "sent")).toEqual({ lines: [26, 27], coverage: "complete" });
    expect(await fixture.references(31, "plain_helper")).toEqual({ lines: [31], coverage: "complete" });
    expect(await fixture.rename(31, "plain_helper")).toEqual({ safe: true, lines: [31] });
  });
});

it("keeps every class open where the file hands a module to a receiver it does not name", async () => {
  // Ruby 3.3: :looped
  const source = [
    "module Delegating",
    "  def method_missing(name, *args); new.send(name, *args); end",
    "  def respond_to_missing?(*); true; end",
    "end",
    "class Looped",
    "  def looped; :looped; end",
    "  def self.run; looped; end",
    "end",
    "[Looped].each { |klass| klass.extend(Delegating) }",
    "p Looped.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(7, "looped")).toBe(6);
    expect(await fixture.references(6, "looped")).toEqual({ lines: [6, 7], coverage: "complete" });
  });
});

it("keeps the closest method where another file may share a module's or class's levels", async () => {
  // Ruby 3.3: [:h, :hi, :greet, :none]
  const delegate = [
    "  def self.method_missing(name, *args); new.send(name, *args); end",
    "  def self.respond_to_missing?(*); true; end",
  ];
  const source = [
    'require_relative "base"',
    "module Tools",
    "  def helper; :h; end",
    "  def self.run; helper; end",
    "end",
    "class Proxy < Base",
    "  def hello; :hi; end",
    "  def self.run; hello; end",
    "end",
    "class Reopened",
    "  def greet; :greet; end",
    "  def self.run; greet; end",
    "end",
    "class Closed",
    "  def shut; :shut; end",
    "  def self.run; (shut rescue :none); end",
    "end",
    'require_relative "ext"',
    'require_relative "reopen"',
    "p [Tools.run, Proxy.run, Reopened.run, Closed.run]",
  ].join("\n");
  await withFixture(
    source,
    async (fixture) => {
      // `Tools.extend(Tools)` in ext.rb, `Base.method_missing` in base.rb, `Reopened.method_missing` in reopen.rb.
      expect(await fixture.gotoLine(4, "helper")).toBe(3);
      expect(await fixture.gotoLine(8, "hello")).toBe(7);
      expect(await fixture.gotoLine(12, "greet")).toBe(11);
      expect(await fixture.gotoLine(16, "shut")).toBe("not_found");
      expect(await fixture.references(3, "helper")).toEqual({ lines: [3, 4], coverage: "complete" });
      expect(await fixture.rename(3, "helper")).toEqual({ safe: true, lines: [3, 4] });
      expect(await fixture.references(7, "hello")).toEqual({ lines: [7, 8], coverage: "complete" });
      expect(await fixture.references(11, "greet")).toEqual({ lines: [11, 12], coverage: "complete" });
      expect(await fixture.references(15, "shut")).toEqual({ lines: [15], coverage: "complete" });
    },
    {
      "base.rb": ["class Base", ...delegate, "end"].join("\n"),
      "ext.rb": "Tools.extend(Tools)\n",
      "reopen.rb": ["class Reopened", ...delegate, "end"].join("\n"),
    },
  );
});

it("keeps self unproven in a block of a self-keeping name that the file defines to evaluate its block", async () => {
  // Ruby 3.3: [:v, :c]
  const source = [
    "class Builder",
    "  def value; :v; end",
    "  def self.tap(&blk); new.instance_eval(&blk); end",
    "  def self.run; tap { value }; end",
    "end",
    "class Plain",
    "  def self.value; :c; end",
    "  def value; :i; end",
    "  def self.run; loop { break value }; end",
    "end",
    "p [Builder.run, Plain.run]",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(4, "value")).toBe(2);
    expect(await fixture.references(2, "value")).toEqual({ lines: [2, 4], coverage: "complete" });
    // `loop`, which the file does not define, keeps the class as `self`.
    expect(await fixture.gotoLine(9, "value")).toBe(7);
    expect(await fixture.references(8, "value")).toEqual({ lines: [8], coverage: "complete" });
  });
});

it("keeps both levels open in modules that use module_function", async () => {
  // Ruby 3.3: [:h, :a]
  const source = [
    "module Tools",
    "  def helper; :h; end",
    "  def self.run; helper; end",
    "end",
    "module Tools",
    "  module_function :helper",
    "end",
    "module Later",
    "  module_function",
    "  def assist; :a; end",
    "  def self.run; assist; end",
    "end",
    "p [Tools.run, Later.run]",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(3, "helper")).toBe(2);
    expect(await fixture.gotoLine(11, "assist")).toBe(10);
    // `module_function :helper` in the reopened body names the method the first body declares.
    expect((await fixture.references(2, "helper")).lines).toEqual([2, 3, 6]);
    expect(await fixture.references(10, "assist")).toEqual({ lines: [10, 11], coverage: "complete" });
  });
});

it("names the writer from the token of def name= beside a reader of the same name", async () => {
  // Ruby 3.3: [20, 3, true]
  const source = [
    "class Svc",
    "  def v=(x); @v = x * 10; end",
    "  def v; @v; end",
    "  def run; self.v = 2; v; end",
    "end",
    "class Twice",
    "  def w=(x); @w = x + 1; end",
    "  def w=(x); @w = x + 2; end",
    "  def w; @w; end",
    "  def run; self.w = 1; w; end",
    "end",
    "class Pt",
    "  def ==(other); true; end",
    "end",
    "p [Svc.new.run, Twice.new.run, Pt.new == Pt.new]",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(2, "v")).toBe(2);
    expect(await fixture.gotoLine(3, "v")).toBe(3);
    for (const line of [7, 8, 9]) expect(await fixture.gotoLine(line, "w")).toBe(line);
    expect(await fixture.references(3, "v")).toEqual({ lines: [3, 4], coverage: "complete" });
    // `self.w = 1` stays unresolved between two writers, so neither writer's references are complete.
    expect(await fixture.references(7, "w")).toEqual({ lines: [7], coverage: "partial" });
    expect((await fixture.references(8, "w")).coverage).toBe("partial");
    // A documented limit: an operator method's own name is no identifier the lookup reads.
    expect(await fixture.gotoLine(13, "==")).toBe("not_found");
  });
});

it("applies the self level rule only in blocks that surely keep self", async () => {
  // Ruby 3.3: [[:cls], [:inst], :cls, [[3], [4]]]
  const source = [
    "class Report",
    "  def line; :inst; end",
    "  def self.line; :cls; end",
    "  def self.mapped; [1].map { line }; end",
    "  def mapped; [1].map { line }; end",
    "  def self.looped; loop { break line }; end",
    "end",
    "class Builder",
    "  def self.build(&blk)",
    "    b = new",
    "    b.instance_eval(&blk)",
    "    b",
    "  end",
    "  def value(v)",
    "    (@v ||= []) << v",
    "    self",
    "  end",
    "  def configure(&blk); instance_eval(&blk); self; end",
    "  def self.setup",
    "    a = Builder.build do",
    "      value 3",
    "    end",
    "    b = new.configure do",
    "      value 4",
    "    end",
    "    [a, b]",
    "  end",
    "  def inspect; @v.inspect; end",
    "end",
    "p [Report.mapped, Report.new.mapped, Report.looped, Builder.setup]",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(4, "line")).toBe(3);
    expect(await fixture.gotoLine(5, "line")).toBe(2);
    expect(await fixture.gotoLine(6, "line")).toBe(3);
    expect(await fixture.references(2, "line")).toEqual({ lines: [2, 5], coverage: "complete" });
    expect(await fixture.references(3, "line")).toEqual({ lines: [3, 4, 6], coverage: "complete" });
    // A block on a constant, or of a method the file shows to evaluate its block, may run with another `self`.
    expect(await fixture.gotoLine(21, "value")).toBe(14);
    expect(await fixture.gotoLine(24, "value")).toBe(14);
    expect(await fixture.references(14, "value")).toEqual({ lines: [14, 21, 24], coverage: "complete" });
  });
});

it("binds a type-name call that runs in the class body to the definition before it", async () => {
  // Ruby 3.3: [1, 2]
  const source = [
    "class Config",
    "  def self.calc; 1; end",
    "  FIRST = Config.calc",
    "  def self.calc; 2; end",
    "end",
    "p [Config::FIRST, Config.calc]",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(3, "calc")).toBe(2);
    expect(await fixture.gotoLine(6, "calc")).toBe(4);
    expect(await fixture.references(2, "calc")).toEqual({ lines: [2, 3], coverage: "partial" });
    expect(await fixture.references(4, "calc")).toEqual({ lines: [4, 6], coverage: "partial" });
  });
});

it("reaches a type-name call through the file's superclasses and registered modules only", async () => {
  // Ruby 3.3: [:mixed, :assist, :none]
  const source = [
    "module Mixin",
    "  def mixed; :mixed; end",
    "end",
    "module Helpers",
    "  def assist; :assist; end",
    "end",
    "class Base",
    "  extend Mixin",
    "  def self.register(mod); extend mod; end",
    "end",
    "class Child < Base",
    "  register Helpers",
    "end",
    "class Unrelated; end",
    "class Runner",
    "  def run",
    "    [Child.mixed,",
    "     Child.assist,",
    "     (Unrelated.mixed rescue :none)]",
    "  end",
    "end",
    "p Runner.new.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(17, "mixed")).toBe(2);
    expect(await fixture.gotoLine(18, "assist")).toBe(5);
    expect(await fixture.gotoLine(19, "mixed")).toBe("not_found");
    expect(await fixture.references(2, "mixed")).toEqual({ lines: [2, 17], coverage: "complete" });
    expect(await fixture.references(5, "assist")).toEqual({ lines: [5, 18], coverage: "complete" });
  });
});

it("keeps another file's base or extended module method partial where a class-body call may reach it", async () => {
  // Ruby 3.3: :base, :macro, :none
  const baseFile = [
    "class Base",
    "  def self.setting; :base; end",
    "end",
    "module Macros",
    "  def macro; :macro; end",
    "end",
    "class Unrelated",
    "  def self.choice; :unrelated; end",
    "end",
  ];
  const source = [
    'require_relative "base"',
    "class Example < Base",
    "  extend Macros",
    "  def setting; :inst; end",
    "  def macro; :inst_macro; end",
    "  def choice; :inst_choice; end",
    "  p setting",
    "  p macro",
    "  p((choice rescue :none))",
    "end",
  ].join("\n");
  await withFixture(
    source,
    async (fixture) => {
      for (const [line, token] of [
        [7, "setting"],
        [8, "macro"],
        [9, "choice"],
      ] as const) {
        expect(await fixture.gotoLine(line, token)).toBe("not_found");
      }
      expect((await fixture.references(2, "setting", "base.rb")).coverage).toBe("partial");
      expect((await fixture.rename(2, "setting", "base.rb")).safe).toBe(false);
      expect((await fixture.references(5, "macro", "base.rb")).coverage).toBe("partial");
      expect((await fixture.rename(5, "macro", "base.rb")).safe).toBe(false);
      expect(await fixture.references(8, "choice", "base.rb")).toEqual({ lines: [8], coverage: "complete" });
      expect(await fixture.references(4, "setting")).toEqual({ lines: [4], coverage: "complete" });
    },
    { "base.rb": baseFile.join("\n") },
  );
});
