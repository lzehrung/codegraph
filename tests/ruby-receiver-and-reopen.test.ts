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
  index: ProjectIndex;
  /** The 1-based position of the `occurrence`th `token` on `line` of the file `name` (default `fixture.rb`). */
  at(line: number, token: string, occurrence?: number, name?: string): { file: string; line: number; column: number };
  /** The line `goToDefinition` answers at a token, or `not_found`. */
  gotoLine(line: number, token: string, occurrence?: number, name?: string): Promise<number | "not_found">;
  /** Reference sites (`file:line`, the file only when it is not `fixture.rb`) and coverage of the declaration at a token. */
  references(line: number, token: string, name?: string): Promise<{ sites: string[]; coverage: string }>;
  /** Whether the rename preview at a token is safe. */
  renameIsSafe(line: number, token: string, name?: string): Promise<boolean>;
  /** How many `calls` edges have a site on `line` and a target declared on `targetLine`. */
  callEdges(line: number, targetLine: number): Promise<number>;
};

// Every fixture below is a complete Ruby program run from `fixture.rb`; the comment beside each records its Ruby 3.3
// output.
async function withFixture(
  source: string,
  run: (fixture: Fixture) => Promise<void>,
  otherFiles: Readonly<Record<string, string>> = {},
): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-receiver-reopen-"));
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
      index,
      at,
      async gotoLine(line, token, occurrence, name) {
        const answer = await goToDefinition(index, at(line, token, occurrence, name));
        return answer.status === "ok" ? answer.definition.range.start.line : "not_found";
      },
      async references(line, token, name) {
        const refs = await findReferences(index, at(line, token, 1, name));
        if (refs.status !== "ok") throw new Error(`No references at ${name ?? MAIN}:${line}:${token}`);
        return {
          sites: refs.references.map((ref) => {
            const file = path.basename(ref.file);
            return file === MAIN ? `${ref.range.start.line}` : `${file}:${ref.range.start.line}`;
          }),
          coverage: refs.referenceCoverage.state,
        };
      },
      async renameIsSafe(line, token, name = MAIN) {
        const preview = await previewRenameWithSession(
          createAgentSession({ root, useConfig: false, buildOptions: options }),
          { root, handle: `${name}:${line}:${at(line, token, 1, name).column}`, newName: "renamed" },
        );
        return preview.safe;
      },
      async callEdges(line, targetLine) {
        const graph = await buildSymbolGraphDetailed(index);
        return graph.edges.filter((edge) => {
          if (edge.label !== "calls" || edge.site?.range.start.line !== line) return false;
          const target = graph.nodes.get(edge.to);
          const text = target ? files[path.basename(target.file)] : undefined;
          // A node id ends with the start index of its declaration.
          const start = Number(edge.to.slice(edge.to.lastIndexOf("::") + 2));
          return text !== undefined && text.slice(0, start).split("\n").length === targetLine;
        }).length;
      },
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

it("finds the receiver calls of a method defined on a constant outside its body", async () => {
  // Ruby 3.3: [:foo, :bar], :foo
  const source = [
    "class Foo; end",
    "class Bar",
    "  def self.bar; :bar; end",
    "end",
    "def Foo.bar; :foo; end",
    "class Runner",
    "  def self.run",
    "    [Foo.bar, Bar.bar]",
    "  end",
    "end",
    "p Runner.run",
    "p Foo.bar",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(8, "bar", 1)).toBe(5);
    expect(await fixture.gotoLine(8, "bar", 2)).toBe(3);
    expect(await fixture.gotoLine(12, "bar")).toBe(5);
    expect(await fixture.references(5, "bar")).toEqual({ sites: ["5", "8", "12"], coverage: "complete" });
    expect(await fixture.renameIsSafe(5, "bar")).toBe(true);
    expect(await fixture.references(3, "bar")).toEqual({ sites: ["3", "8"], coverage: "complete" });
  });
});

it("follows a method defined on a constant into another file's receiver calls", async () => {
  // Ruby 3.3: :bar
  const declaring = ["class Foo; end", "def Foo.bar; :bar; end", ""].join("\n");
  const source = ['require_relative "foo"', "class Client", "  def go; Foo.bar; end", "end", "p Client.new.go"].join(
    "\n",
  );
  await withFixture(
    source,
    async (fixture) => {
      expect(await fixture.gotoLine(3, "bar")).toBe(2);
      const refs = await fixture.references(2, "bar", "foo.rb");
      expect(refs.sites.sort()).toEqual(["3", "foo.rb:2"]);
      expect(refs.coverage).toBe("complete");
    },
    { "foo.rb": declaring },
  );
});

it("finds or doubts the receiver calls of a method defined on an object that is no constant", async () => {
  // Ruby 3.3: :h, :hi
  const source = [
    "class Foo; end",
    "klass = Foo",
    "def klass.helper; :h; end",
    "o = Object.new",
    "def o.greet; :hi; end",
    "class Runner",
    "  def self.run; Foo.helper; end",
    "end",
    "p Runner.run",
    "p o.greet",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(7, "helper")).toBe(3);
    expect((await fixture.references(3, "helper")).sites).toEqual(["3", "7"]);
    // `o.greet` goes through a local the index does not type, so the call may be the method's.
    expect(await fixture.references(5, "greet")).toEqual({ sites: ["5"], coverage: "partial" });
    expect(await fixture.renameIsSafe(5, "greet")).toBe(false);
  });
});

it("keeps a method defined on a constant apart from the class's same-named instance method", async () => {
  // Ruby 3.3: :cls, :inst
  const source = [
    "class Foo",
    "  def bar; :inst; end",
    "end",
    "def Foo.bar; :cls; end",
    "p Foo.bar",
    "p Foo.new.bar",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(5, "bar")).toBe(4);
    expect(await fixture.gotoLine(6, "bar")).toBe(2);
    expect(await fixture.references(4, "bar")).toEqual({ sites: ["4", "5"], coverage: "complete" });
    expect(await fixture.references(2, "bar")).toEqual({ sites: ["2", "6"], coverage: "complete" });
    expect(await fixture.renameIsSafe(4, "bar")).toBe(true);
  });
});

it("leaves a class method that its constant redefines from outside the body partial", async () => {
  // Ruby 3.3: :body, :outside
  const source = [
    "class Foo",
    "  def self.bar; :body; end",
    "  def self.run; bar; end",
    "end",
    "p Foo.run",
    "def Foo.bar; :outside; end",
    "p Foo.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect((await fixture.references(2, "bar")).coverage).toBe("partial");
    expect((await fixture.references(6, "bar")).coverage).toBe("partial");
    expect(await fixture.renameIsSafe(2, "bar")).toBe(false);
    expect(await fixture.renameIsSafe(6, "bar")).toBe(false);
  });
});

it("resolves an instance call on a fresh constructor result beside a class method", async () => {
  // Ruby 3.3: :inst, :inst, :inst, :cls, :job
  const source = [
    "class Svc",
    "  def self.run; :cls; end",
    "  def run; :inst; end",
    "  def go; self.run; end",
    "end",
    "class Job",
    "  def run; :job; end",
    "end",
    "item = Svc.new",
    "p item.run",
    "p Svc.new.run",
    "p Svc.new.go",
    "p Svc.run",
    "p Job.new.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(10, "run")).toBe(3);
    expect(await fixture.gotoLine(11, "run")).toBe(3);
    expect(await fixture.gotoLine(4, "run")).toBe(3);
    expect(await fixture.gotoLine(13, "run")).toBe(2);
    expect(await fixture.gotoLine(14, "run")).toBe(7);
    expect(await fixture.references(3, "run")).toEqual({ sites: ["3", "4", "10", "11"], coverage: "complete" });
    expect(await fixture.references(7, "run")).toEqual({ sites: ["7", "14"], coverage: "complete" });
  });
});

it("renames an instance method called on a constructor result beside another class method", async () => {
  // Ruby 3.3: :run
  const source = ["class Svc", "  def self.other; :o; end", "  def run; :run; end", "end", "p Svc.new.run"].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(5, "run")).toBe(3);
    expect(await fixture.references(3, "run")).toEqual({ sites: ["3", "5"], coverage: "complete" });
    expect(await fixture.renameIsSafe(3, "run")).toBe(true);
  });
});

it("leaves a constructor call unproven where the file shows a new of the class's own", async () => {
  // Ruby 3.3: :job, :job
  const source = [
    "class Job",
    "  def run; :job; end",
    "end",
    "class Svc",
    "  def self.new(*); Job.allocate; end",
    "  def run; :svc; end",
    "end",
    "class Base",
    "  class << self",
    "    def new(*); Job.allocate; end",
    "  end",
    "end",
    "class Child < Base",
    "  def run; :child; end",
    "end",
    "p Svc.new.run",
    "p Child.new.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(16, "run")).toBe("not_found");
    expect(await fixture.gotoLine(17, "run")).toBe("not_found");
    for (const line of [2, 6, 14]) expect((await fixture.references(line, "run")).coverage).toBe("partial");
    expect(await fixture.renameIsSafe(2, "run")).toBe(false);
    expect(await fixture.renameIsSafe(6, "run")).toBe(false);
  });
});

it("detects a redefinition in a reopened body when code runs between the definitions", async () => {
  // Ruby 3.3: 1, 2
  const source = [
    "class Calc",
    "  def calc; 1; end",
    "  def run; calc; end",
    "end",
    "p Calc.new.run",
    "class Calc",
    "  def calc; 2; end",
    "end",
    "p Calc.new.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(3, "calc")).toBe(7);
    expect(await fixture.references(2, "calc")).toEqual({ sites: ["2"], coverage: "partial" });
    expect(await fixture.references(7, "calc")).toEqual({ sites: ["3", "7"], coverage: "partial" });
    expect(await fixture.renameIsSafe(2, "calc")).toBe(false);
    expect(await fixture.renameIsSafe(7, "calc")).toBe(false);
  });
});

it("binds a call to the reopened body's definition that replaces the first before any code runs", async () => {
  // Ruby 3.3: 2
  const source = [
    "class Calc",
    "  def calc; 1; end",
    "  def run; calc; end",
    "end",
    "class Calc",
    "  def calc; 2; end",
    "end",
    "class Other",
    "  def calc; 3; end",
    "end",
    "p Calc.new.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(3, "calc")).toBe(6);
    expect(await fixture.references(2, "calc")).toEqual({ sites: ["2"], coverage: "complete" });
    expect(await fixture.references(6, "calc")).toEqual({ sites: ["3", "6"], coverage: "complete" });
    expect(await fixture.renameIsSafe(6, "calc")).toBe(true);
    expect(await fixture.references(9, "calc")).toEqual({ sites: ["9"], coverage: "complete" });
  });
});

it("selects the method a type name reaches among same-named methods of one file", async () => {
  // Ruby 3.3: [:foo_baz, :bar_baz]
  const source = [
    "class Foo; end",
    "class << Foo",
    "  def baz; :foo_baz; end",
    "end",
    "class Bar",
    "  def self.baz; :bar_baz; end",
    "end",
    "class Runner",
    "  def self.run",
    "    a = Foo.baz",
    "    b = Bar.baz",
    "    [a, b]",
    "  end",
    "end",
    "p Runner.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(10, "baz")).toBe(3);
    expect(await fixture.gotoLine(11, "baz")).toBe(6);
    expect(await fixture.references(3, "baz")).toEqual({ sites: ["3", "10"], coverage: "complete" });
    expect(await fixture.references(6, "baz")).toEqual({ sites: ["6", "11"], coverage: "complete" });
    expect(await fixture.renameIsSafe(3, "baz")).toBe(true);
  });
});

it("binds each call between two outside definitions of one method to the one it runs", async () => {
  // Ruby 3.3: 1, 2
  const source = ["class Foo; end", "def Foo.bar; 1; end", "p Foo.bar", "def Foo.bar; 2; end", "p Foo.bar"].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(3, "bar")).toBe(2);
    expect(await fixture.gotoLine(5, "bar")).toBe(4);
    expect(await fixture.references(2, "bar")).toEqual({ sites: ["2", "3"], coverage: "partial" });
    expect(await fixture.references(4, "bar")).toEqual({ sites: ["4", "5"], coverage: "partial" });
  });
});

it("keeps a type name off the class methods of a sibling or a subclass", async () => {
  // Ruby 3.3: :circle_new, Square, :area, :none, :shape, :none
  const source = [
    "class Shape",
    "  def self.make; :shape; end",
    "end",
    "class Circle < Shape",
    "  def self.new(*); :circle_new; end",
    "  def self.area; :area; end",
    "end",
    "class Square < Shape; end",
    "p Circle.new",
    "p Square.new.class",
    "p Circle.area",
    "p (Square.area rescue :none)",
    "p Square.make",
    "p (Shape.area rescue :none)",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(9, "new")).toBe(5);
    expect(await fixture.gotoLine(10, "new")).toBe("not_found");
    expect(await fixture.gotoLine(11, "area")).toBe(6);
    expect(await fixture.gotoLine(12, "area")).toBe("not_found");
    expect(await fixture.gotoLine(13, "make")).toBe(2);
    expect(await fixture.gotoLine(14, "area")).toBe("not_found");
    expect(await fixture.references(5, "new")).toEqual({ sites: ["5", "9"], coverage: "complete" });
    expect(await fixture.renameIsSafe(5, "new")).toBe(true);
    expect(await fixture.references(6, "area")).toEqual({ sites: ["6", "11"], coverage: "complete" });
  });
});

it("lets a bare call reach a subclass's or a co-mixin's method, never a sibling's", async () => {
  // Ruby 3.3: :left, :none, "hi bob"
  const source = [
    "class Base",
    "  def self.build; hook; end",
    "end",
    "class Left < Base",
    "  def self.hook; :left; end",
    "end",
    "class Right < Base",
    "  def self.go; (hook rescue :none); end",
    "end",
    "module Greeting",
    '  def greet; "hi " + name; end',
    "end",
    "module Naming",
    '  def name; "bob"; end',
    "end",
    "class Person",
    "  include Greeting",
    "  include Naming",
    "end",
    "p Left.build",
    "p Right.go",
    "p Person.new.greet",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(2, "hook")).toBe(5);
    expect(await fixture.gotoLine(8, "hook")).toBe("not_found");
    expect(await fixture.gotoLine(11, "name")).toBe(14);
    expect((await fixture.references(5, "hook")).sites).toEqual(["2", "5"]);
  });
});

it("records the call edge of a qualified module_function call that goto resolves", async () => {
  // Ruby 3.3: 84, 0
  const source = [
    "module Tools",
    "  module_function",
    "  def calculate; 42; end",
    "  def compute(first = Tools.calculate)",
    "    first + Tools.calculate",
    "  end",
    "end",
    "module Plain",
    "  def calculate; 1; end",
    "  def self.run; (Plain.calculate rescue 0); end",
    "end",
    "p Tools.compute",
    "p Plain.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(4, "calculate")).toBe(3);
    expect(await fixture.callEdges(4, 3)).toBe(1);
    expect(await fixture.callEdges(5, 3)).toBe(1);
    // `Plain` hands its instance methods to nothing, so its qualified call runs none of them.
    expect(await fixture.callEdges(10, 9)).toBe(0);
  });
});

it("keeps an instance method reachable through the class name where the class may answer class calls with it", async () => {
  // Ruby 3.3: :k, :a, true
  const base = [
    "class ForwardingBase",
    "  def self.method_missing(name, *args); new.public_send(name, *args); end",
    "  def self.respond_to_missing?(*); true; end",
    "end",
    "",
  ].join("\n");
  const source = [
    'require "forwardable"',
    'load File.join(__dir__, "base.txt")',
    "class Tool",
    "  def self.method_missing(name, *args); new.public_send(name, *args); end",
    "  def self.respond_to_missing?(*); true; end",
    "  def kind; :k; end",
    "end",
    "class Current < ForwardingBase",
    "  def account; :a; end",
    "end",
    "class Registry",
    "  class << self",
    "    extend Forwardable",
    "    def_delegators :instance, :collect?",
    "    def instance; @instance ||= new; end",
    "  end",
    "  def collect?; true; end",
    "end",
    "p Tool.kind",
    "p Current.account",
    "p Registry.collect?",
  ].join("\n");
  await withFixture(
    source,
    async (fixture) => {
      expect(await fixture.gotoLine(19, "kind")).toBe(6);
      expect(await fixture.gotoLine(20, "account")).toBe(9);
      expect(await fixture.gotoLine(21, "collect?")).toBe(17);
      expect((await fixture.references(6, "kind")).sites).toEqual(["6", "19"]);
      expect((await fixture.references(9, "account")).sites).toEqual(["9", "20"]);
      expect(await fixture.renameIsSafe(6, "kind")).toBe(true);
    },
    { "base.txt": base },
  );
});

it("leaves a constructor call unproven where an alias or a defining call gives the class its own new", async () => {
  // Ruby 3.3: :other, :other
  const source = [
    "class Other",
    "  def run; :other; end",
    "end",
    "class Svc",
    "  def self.build(*); Other.new; end",
    "  class << self",
    "    alias_method :new, :build",
    "  end",
    "  def run; :svc; end",
    "end",
    "class Job",
    "  define_singleton_method(:new) { |*| Other.allocate }",
    "  def run; :job; end",
    "end",
    "p Svc.new.run",
    "p Job.new.run",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(15, "run")).toBe("not_found");
    expect(await fixture.gotoLine(16, "run")).toBe("not_found");
    expect((await fixture.references(9, "run")).coverage).toBe("partial");
    expect((await fixture.references(13, "run")).coverage).toBe("partial");
    expect(await fixture.renameIsSafe(9, "run")).toBe(false);
  });
});

it("keeps a class body opened under a condition out of the class and its redefinitions partial", async () => {
  // Ruby 3.3: 1, :b
  const source = [
    "class C",
    "  def calc; 1; end",
    "  def run; calc; end",
    "end",
    "class C",
    "  def calc; 2; end",
    "end if false",
    "class D",
    "  def go; :b; end",
    "end",
    "class D",
    "  def go; :a; end",
    "end unless D.method_defined?(:go)",
    "p C.new.run",
    "p D.new.go",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(3, "calc")).toBe(2);
    expect(await fixture.references(2, "calc")).toEqual({ sites: ["2", "3"], coverage: "partial" });
    expect((await fixture.references(6, "calc")).coverage).toBe("partial");
    expect(await fixture.renameIsSafe(2, "calc")).toBe(false);
    expect(await fixture.renameIsSafe(6, "calc")).toBe(false);
    expect((await fixture.references(9, "go")).coverage).toBe("partial");
  });
});

it("reaches no top-level def self through a type name", async () => {
  // Ruby 3.3: :nm
  const source = [
    "def self.bar; :main_bar; end",
    "class Foo",
    "  def bar; :foo_bar; end",
    "end",
    "class Baz; end",
    "p((Baz.bar rescue :nm))",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.gotoLine(6, "bar")).toBe("not_found");
    expect(await fixture.references(1, "bar")).toEqual({ sites: ["1"], coverage: "complete" });
    expect(await fixture.references(3, "bar")).toEqual({ sites: ["3"], coverage: "complete" });
  });
});

it("records no module_function call edge where the module's own method or its privacy may answer the call", async () => {
  // Ruby 3.3: :outside, :private
  const source = [
    "module Tools",
    "  extend self",
    "  def calc; :inst; end",
    "end",
    "def Tools.calc; :outside; end",
    "module Hidden",
    "  module_function",
    "  def helper; :h; end",
    "  private_class_method :helper",
    "end",
    "class Runner",
    "  def go; Tools.calc; end",
    "  def go2; (Hidden.helper rescue :private); end",
    "end",
    "p Runner.new.go",
    "p Runner.new.go2",
  ].join("\n");
  await withFixture(source, async (fixture) => {
    expect(await fixture.callEdges(12, 3)).toBe(0);
    expect(await fixture.callEdges(13, 8)).toBe(0);
  });
});

it("records no module_function call edge where another file opens the module", async () => {
  // Ruby 3.3: :cls
  const tools = ["module Tools", "  module_function", "  def calc; :inst; end", "  def go; Tools.calc; end", "end", ""];
  const source = ['require_relative "tools"', "module Tools", "  def self.calc; :cls; end", "end", "p Tools.go"];
  await withFixture(
    source.join("\n"),
    async (fixture) => {
      const graph = await buildSymbolGraphDetailed(fixture.index);
      const edges = graph.edges.filter(
        (edge) => edge.label === "calls" && path.basename(edge.site?.file ?? "") === "tools.rb",
      );
      expect(edges).toEqual([]);
    },
    { "tools.rb": tools.join("\n") },
  );
});
