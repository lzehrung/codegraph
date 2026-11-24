import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
} from "../../src/index.js";
import { previewRenameWithSession } from "../../src/agent/rename-preview.js";
import { createAgentSession } from "../../src/agent/session.js";
import { workspaceSymbolsWithSession } from "../../src/agent/workspace-symbols.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { collectDetailedDeclarations } from "../../src/graphs/symbol-graph-detailed/ast.js";
import { collectImportsForFile, collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";
import { buildScopeIndexFromSource } from "../../src/indexer/scope.js";
import { exportedNameOf } from "../helpers/narrow.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { getNativeQueryExecution } from "../../src/native/tree-sitter-native.js";
import { QUALIFIED_BASE_FIXTURES, expectQualifiedBases } from "../helpers/qualified-base-fixture.js";
import { writeFixtureFiles } from "./callable-consumer-fixtures.js";
import { RUBY_MEMBER_SOURCES } from "../helpers/ruby-member-names-fixture.js";
import { RUBY_SCOPE_SOURCES, expectRubyScopeCalls } from "../helpers/ruby-generated-scope-fixture.js";

const sampleRoot = path.resolve(process.cwd(), "tests", "samples", "ruby");

const definition: LanguageTestDefinition = {
  id: "ruby",
  samples: [
    {
      name: "chunks Ruby structures",
      sourceFile: "ruby.sample.rb",
      exactChunks: [
        { type: "comment", startLine: 1, endLine: 1 },
        { type: "module", name: "MyModule", startLine: 2, endLine: 12 },
        { type: "class", name: "MyClass", startLine: 3, endLine: 11 },
        { type: "method", name: "my_method", startLine: 4, endLine: 6 },
        { type: "method", name: "static_method", startLine: 8, endLine: 10 },
        { type: "misc", startLine: 12, endLine: 16 },
      ],
    },
  ],
  parity: {
    sampleDir: "ruby",
    exact: {
      dependencyGraph: [
        {
          from: "consumer.rb",
          to: { type: "file", path: "namespaced.rb" },
        },
        {
          from: "main.rb",
          to: { type: "file", path: "helpers.rb" },
        },
        {
          from: "main.rb",
          to: { type: "file", path: "utils.rb" },
        },
      ],
      symbols: [
        {
          file: "namespaced.rb",
          symbols: [
            { name: "Outer", kind: "class" },
            { name: "Inner", kind: "class" },
            { name: "VALUE", kind: "variable" },
            { name: "Tool", kind: "class" },
          ],
        },
        {
          file: ".regressions/struct_point.rb",
          symbols: [
            { name: "Point", kind: "class" },
            { name: "point", kind: "variable" },
          ],
        },
      ],
      references: [
        {
          name: "find references for namespaced class",
          file: "namespaced.rb",
          line: 5,
          column: 11,
          references: [
            { file: "namespaced.rb", line: 5 },
            { file: "consumer.rb", line: 3 },
          ],
        },
        {
          name: "finds Struct.new class assignment references",
          file: ".regressions/struct_point.rb",
          line: 1,
          column: 1,
          references: [
            { file: ".regressions/struct_point.rb", line: 1 },
            { file: ".regressions/struct_point.rb", line: 3 },
          ],
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition resolves namespaced class use",
        file: "consumer.rb",
        line: 3,
        column: 22,
        expectedDefinition: { file: "namespaced.rb", line: 5 },
      },
      {
        name: "go to definition resolves a Struct.new class assignment",
        file: ".regressions/struct_point.rb",
        line: 3,
        column: 9,
        expectedDefinition: { file: ".regressions/struct_point.rb", line: 1 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("Ruby Struct.new declarations", () => {
  it("creates a synthetic detailed class node with class ownership", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "ruby");
    const file = path.join(samplePath, ".regressions", "struct_point.rb").replace(/\\/g, "/");
    const parsed = await parseFile(file);
    const module = collectLocalsAndExportsFromSource(file, parsed.source, parsed.sup, [], {
      ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
    });
    const declarations = collectDetailedDeclarations(parsed.tree.rootNode, parsed.sup, parsed.source, module.locals);
    const pointClass = declarations.classNodes.find((node) => node.name === "Point");

    expect(pointClass?.def.kind).toBe("class");
    expect(pointClass?.node.type).toBe("assignment");

    const index = await createTestIndexFromFiles(samplePath, [file]);
    const graph = await buildSymbolGraphDetailed(index);
    expect(Array.from(graph.nodes.values())).toContainEqual(
      expect.objectContaining({ file, name: "Point", kind: "class" }),
    );
  });
});

describe("Ruby compact names and declarations", () => {
  async function collectModule(source: string) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-decls-"));
    const file = path.join(root, "test.rb");
    await fsp.writeFile(file, source, "utf8");
    try {
      const parsed = await parseFile(file);
      const module = collectLocalsAndExportsFromSource(file, parsed.source, parsed.sup, [], {
        ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
      });
      const imports = await collectImportsForFile(file, root, {
        source: parsed.source,
        sup: parsed.sup,
        ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
      });
      return { module, imports };
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }

  it("exports compact class and module names as the full scope resolution", async () => {
    const { module } = await collectModule(`
module Outer::Compact
  class Inner::Tool
  end
end
`);
    const exportedNames = module.exports.map((entry) => exportedNameOf(entry));
    expect(exportedNames).toEqual(expect.arrayContaining(["Outer::Compact", "Inner::Tool"]));
  });

  it("exports setter methods and singleton methods", async () => {
    const { module } = await collectModule(`
class Tool
  def foo=(v)
    @v = v
  end
  def self.x
    :x
  end
end
`);
    const exportedNames = module.exports.map((entry) => exportedNameOf(entry));
    expect(exportedNames).toEqual(expect.arrayContaining(["Tool", "foo=", "x"]));
  });

  it("captures load and autoload paths and ignores ordinary calls", async () => {
    const { imports } = await collectModule(`
require "json"
require_relative "./other"
load "lazy_load.rb"
autoload :Lazy, "lazy"
puts "hello"
log.info "x"
`);
    const froms = imports.map((entry) => entry.from).sort();
    expect(froms).toEqual(["./other", "json", "lazy", "lazy_load.rb"]);
  });

  it("defines accessor methods for attr calls that are body statements, bare or under a visibility call", async () => {
    const { module } = await collectModule(`
class Odd
  attr_reader :real
  other.attr_accessor :via_receiver
  attr_writer.chained :via_chain
  helper(attr_accessor)
  attr_accessor = 1
  def attr_reader; end
  [1].each { attr_reader :in_block }
  class << self
    attr_accessor :on_meta
  end
  def build
    attr_accessor :in_method
  end
  attr_reader :under_if if build
  memoize attr_reader :under_memoize
  private attr_reader(*NAMES)
  private attr_reader :under_private, "text"
  protected(attr_accessor(:under_protected))
  public attr_writer :under_public
  self.private attr_reader :under_self_receiver
end
module Shared
  attr_writer "plain", :symbol
end
`);
    // An identifier spelled like an accessor macro is only a candidate; the receiver, argument, variable, definition,
    // block, singleton class, method body, modifier, and unknown-call forms define nothing beyond what they already
    // declared. A `private`, `protected`, or `public` call that is a body statement keeps the attr call it wraps.
    expect(module.locals.map((local) => local.localName).sort()).toEqual(
      [
        "Odd",
        "Shared",
        "attr_accessor",
        "attr_reader",
        "build",
        "plain=",
        "real",
        "symbol=",
        "text",
        "under_private",
        "under_protected",
        "under_protected=",
        "under_public=",
      ].sort(),
    );
  });
});

describe("Ruby query-driven locals", () => {
  it("extracts locals from the natives locals query without a syntax tree", async () => {
    const parsed = await parseFile(path.join(sampleRoot, ".regressions", "struct_point.rb"));
    const native = getNativeQueryExecution(parsed.source, parsed.sup);
    const module = collectLocalsAndExportsFromSource("probe.rb", parsed.source, parsed.sup, [], {
      nativeQueries: native.results,
    });
    const names = module.locals.map((local) => local.localName);
    // `usesQueryDrivenLocals` must be on for the query lane to run without a tree; before
    // it was enabled the Ruby locals query was captured but its results were discarded.
    expect(names).toContain("Point");
    expect(names).toContain("point");
  });

  it("kinds classes, modules, and methods from the locals query captures", async () => {
    const parsed = await parseFile(path.join(sampleRoot, ".regressions", "struct_point.rb"));
    const native = getNativeQueryExecution(parsed.source, parsed.sup);
    const module = collectLocalsAndExportsFromSource("probe.rb", parsed.source, parsed.sup, [], {
      nativeQueries: native.results,
    });
    const kindByName = new Map(module.locals.map((local) => [local.localName, local.kind]));
    // Query-driven kinds come from classifyDefinition; it must agree with the kinds the
    // scope walker supplies structurally for class, module, and method captures.
    expect(kindByName.get("Point")).toBe("class");
    expect(kindByName.get("point")).toBe("variable");
  });
});
describe("Ruby receiver navigation and calls", () => {
  it("finds inherited instance methods through a derived constant without selecting a decoy", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-inherited-"));
    const shapes = path.join(root, "shapes.rb");
    const use = path.join(root, "use.rb");
    const decoy = path.join(root, "decoy.rb");
    try {
      await Promise.all([
        fsp.writeFile(shapes, "class Base\n  def run; 1; end\nend\nclass Derived < Base\nend\n"),
        fsp.writeFile(use, "require_relative 'shapes'\ndef call_derived\n  d = Derived.new\n  d.run\nend\n"),
        fsp.writeFile(decoy, "class Other\n  def run; -1; end\nend\n"),
      ]);
      const index = await buildProjectIndex(root, { cache: "off" });
      const result = await goToDefinition(index, { file: use, line: 4, column: 5 });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(shapes));
        expect(result.definition.range.start.line).toBe(2);
        expect(fileIdentityKey(result.definition.file)).not.toBe(fileIdentityKey(decoy));
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Ruby class instance methods out of require_relative imports and references", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-require-methods-"));
    const shapes = path.join(root, "shapes.rb");
    const derived = path.join(root, "derived.rb");
    const onlyClass = path.join(root, "only-class.rb");
    const bare = path.join(root, "bare.rb");
    try {
      await Promise.all([
        fsp.writeFile(shapes, "class Base\n  def run; 1; end\nend\nclass Decoy\n  def run; -1; end\nend\n"),
        fsp.writeFile(
          derived,
          "require_relative 'shapes'\nclass Derived < Base\n  def run\n    super + 1\n  end\nend\n",
        ),
        fsp.writeFile(onlyClass, "class Lone\n  def run; 1; end\nend\n"),
        fsp.writeFile(bare, "require_relative 'only-class'\ndef caller\n  run\nend\n"),
      ]);
      const index = await buildProjectIndex(root, { cache: "off" });
      const imports = index.byFile.get(fileIdentityKey(derived))?.imports ?? [];
      expect(imports.some((binding) => binding.kind === "named" && binding.local === "run")).toBe(false);
      expect((await goToDefinition(index, { file: bare, line: 3, column: 3 })).status).toBe("not_found");
      const references = await findReferences(index, { file: shapes, line: 2, column: 7 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        const sites = references.references.map((reference) => [
          fileIdentityKey(reference.file),
          reference.range.start.line,
        ]);
        expect(sites).toContainEqual([fileIdentityKey(shapes), 2]);
        expect(sites).not.toContainEqual([fileIdentityKey(shapes), 5]);
        expect(references.referenceCoverage.state).toBe("complete");
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("records calls to bare Ruby module and class constant methods, excluding same-named decoys", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-constant-call-"));
    const calc = path.join(root, "calc.rb");
    const counter = path.join(root, "counter.rb");
    const decoy = path.join(root, "decoy.rb");
    const use = path.join(root, "use.rb");
    try {
      await Promise.all([
        fsp.writeFile(calc, "module Calc\n  def self.add(a, b); a + b; end\nend\n"),
        fsp.writeFile(counter, "class Counter\n  def self.zero; 0; end\nend\n"),
        fsp.writeFile(decoy, "module Other\n  def self.add(a, b); -1; end\n  def self.zero; -1; end\nend\n"),
        fsp.writeFile(
          use,
          "require_relative 'calc'\nrequire_relative 'counter'\ndef sum_pair; Calc.add(1, 2); end\ndef make_counter; Counter.zero; end\n",
        ),
      ]);
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      for (const [callerName, targetName, targetFile] of [
        ["sum_pair", "add", calc],
        ["make_counter", "zero", counter],
      ]) {
        const caller = [...graph.nodes.values()].find(
          (node) => node.name === callerName && fileIdentityKey(node.file) === fileIdentityKey(use),
        );
        expect(caller).toBeDefined();
        const callees = graph.edges
          .filter((edge) => edge.from === caller?.id && edge.label === "calls")
          .map((edge) => graph.nodes.get(edge.to));
        expect(
          callees.some(
            (node) => node?.name === targetName && fileIdentityKey(node.file) === fileIdentityKey(targetFile),
          ),
        ).toBe(true);
        expect(callees.some((node) => node && fileIdentityKey(node.file) === fileIdentityKey(decoy))).toBe(false);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("records no call for a bare name inside a block that hands the code another self", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-other-self-"));
    try {
      await fsp.writeFile(
        path.join(root, "meter.rb"),
        [
          "class Meter",
          "  def pulse = 2",
          "  def own",
          "    [1].each { pulse }",
          "  end",
          "  def other",
          "    Object.new.instance_eval { pulse }",
          "    Struct.new(:a) { pulse }",
          "    Class.new { pulse }",
          "  end",
          "end",
          "",
        ].join("\n"),
      );
      const graph = await buildSymbolGraphDetailed(await buildProjectIndex(root, { cache: "off" }));
      const calleesOf = (callerName: string): string[] => {
        const caller = [...graph.nodes.values()].find((node) => node.name === callerName);
        return graph.edges
          .filter((edge) => edge.from === caller?.id && edge.label === "calls")
          .map((edge) => graph.nodes.get(edge.to)?.name ?? "")
          .sort();
      };
      // An ordinary block keeps its method's `self`; `instance_eval`, `Struct.new`, and `Class.new` hand the code another.
      expect(calleesOf("own")).toEqual(["pulse"]);
      expect(calleesOf("other")).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Ruby bare require targets", () => {
  it("prefers a path-like Ruby file over a workspace package for a bare require", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-path-before-workspace-"));
    try {
      await fsp.mkdir(path.join(root, "pkgs", "foo"), { recursive: true });
      const rubyFile = path.join(root, "foo.rb");
      const packageFile = path.join(root, "pkgs", "foo", "index.js");
      const use = path.join(root, "use.rb");
      await fsp.writeFile(path.join(root, "package.json"), '{"name":"root","private":true,"workspaces":["pkgs/*"]}\n');
      await fsp.writeFile(path.join(root, "pkgs", "foo", "package.json"), '{"name":"foo","main":"index.js"}\n');
      await fsp.writeFile(packageFile, "module.exports = 1;\n");
      await fsp.writeFile(rubyFile, "module Foo\nend\n");
      await fsp.writeFile(use, 'require "foo"\n');
      const index = await buildProjectIndex(root, { cache: "off" });
      const binding = index.byFile
        .get(fileIdentityKey(use))
        ?.imports.find((entry) => entry.kind === "star" && entry.from === "foo");
      const fileEdges = index.graph.edges.filter(
        (edge) => fileIdentityKey(edge.from) === fileIdentityKey(use) && edge.to.type === "file",
      );
      const edgeBases = fileEdges.map((edge) => (edge.to.type === "file" ? path.basename(edge.to.path) : ""));

      expect(typeof binding?.resolved).toBe("string");
      if (typeof binding?.resolved === "string") {
        expect(path.basename(binding.resolved)).toBe("foo.rb");
        expect(path.basename(binding.resolved)).not.toBe("index.js");
      }
      expect(edgeBases).toEqual(["foo.rb"]);
      expect(edgeBases).not.toContain("index.js");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
describe("Ruby require_relative lookup", () => {
  it("resolves the sibling before a root decoy while bare require keeps root precedence", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-relative-root-"));
    try {
      const nested = path.join(root, "lib", "a");
      await fsp.mkdir(nested, { recursive: true });
      const rootFoo = path.join(root, "foo.rb");
      const siblingFoo = path.join(nested, "foo.rb");
      const relative = path.join(nested, "relative.rb");
      const bare = path.join(nested, "bare.rb");
      const mixedFile = path.join(nested, "mixed.rb");
      const missingFile = path.join(nested, "missing.rb");
      const rootOnly = path.join(root, "root_only.rb");
      await Promise.all([
        fsp.writeFile(rootFoo, "class Widget\n  def render; -1; end\nend\n"),
        fsp.writeFile(siblingFoo, "class Widget\n  def render; 1; end\nend\n"),
        fsp.writeFile(relative, "require_relative 'foo'\ndef relative_use\n  Widget.new.render\nend\n"),
        fsp.writeFile(bare, "require 'foo'\ndef bare_use\n  Widget.new.render\nend\n"),
        fsp.writeFile(mixedFile, "require 'foo'\nrequire_relative 'foo'\n"),
        fsp.writeFile(rootOnly, "class RootOnly; end\n"),
        fsp.writeFile(missingFile, "require_relative 'root_only'\n"),
      ]);
      const index = await buildProjectIndex(root, { cache: "off" });
      const mixed = index.byFile
        .get(fileIdentityKey(mixedFile))
        ?.imports.filter((entry) => entry.kind === "star" && entry.from === "foo");
      expect(
        mixed?.map((entry) => (typeof entry.resolved === "string" ? fileIdentityKey(entry.resolved) : "external")),
      ).toEqual([fileIdentityKey(rootFoo), fileIdentityKey(siblingFoo)]);
      const mixedEdges = index.graph.edges
        .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(mixedFile) && edge.to.type === "file")
        .map((edge) => (edge.to.type === "file" ? fileIdentityKey(edge.to.path) : ""));
      expect(new Set(mixedEdges)).toEqual(new Set([fileIdentityKey(rootFoo), fileIdentityKey(siblingFoo)]));
      const missingBinding = index.byFile
        .get(fileIdentityKey(missingFile))
        ?.imports.find((entry) => entry.kind === "star" && entry.from === "root_only");
      expect(missingBinding?.resolved).toEqual({ external: "root_only" });
      expect(
        index.graph.edges.some(
          (edge) =>
            fileIdentityKey(edge.from) === fileIdentityKey(missingFile) &&
            edge.to.type === "file" &&
            fileIdentityKey(edge.to.path) === fileIdentityKey(rootOnly),
        ),
      ).toBe(false);
      for (const [consumer, expected, excluded] of [
        [relative, siblingFoo, rootFoo],
        [bare, rootFoo, siblingFoo],
      ]) {
        const binding = index.byFile
          .get(fileIdentityKey(consumer))
          ?.imports.find((entry) => entry.kind === "star" && entry.from === "foo");
        const targets = index.graph.edges
          .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(consumer) && edge.to.type === "file")
          .map((edge) => (edge.to.type === "file" ? fileIdentityKey(edge.to.path) : ""));
        expect(targets).toEqual([fileIdentityKey(expected)]);
        expect(targets).not.toContain(fileIdentityKey(excluded));
        expect(fileIdentityKey(String(binding?.resolved))).toBe(fileIdentityKey(expected));
        expect(fileIdentityKey(String(binding?.resolved))).not.toBe(fileIdentityKey(excluded));
        const goto = await goToDefinition(index, { file: consumer, line: 3, column: 4 });
        expect(goto.status).toBe("ok");
        if (goto.status !== "ok") throw new Error("Expected required Ruby constant");
        expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(expected));
        expect(fileIdentityKey(goto.definition.file)).not.toBe(fileIdentityKey(excluded));
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Ruby qualified scope reopenings", () => {
  it("follows the proven lexical or top-level root across consumers", async () => {
    const fixture = QUALIFIED_BASE_FIXTURES.find((candidate) => candidate.language === "Ruby");
    if (!fixture) throw new Error("Missing Ruby qualified base fixture");
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-qualified-reopenings-"));
    try {
      await writeFixtureFiles(root, fixture.files);
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      await expectQualifiedBases(root, index, graph, fixture, "language");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Ruby method names, generated accessors, and writer calls", () => {
  const FILES: Record<string, string> = RUBY_MEMBER_SOURCES;
  const GAUGE = FILES["gauge.rb"]!;

  async function fixture(): Promise<string> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-names-"));
    for (const [name, source] of Object.entries(FILES)) await fsp.writeFile(path.join(root, name), source);
    return root;
  }

  /** The 1-based column of the `occurrence`-th `token` on a 1-based line of `source`. */
  function columnOf(source: string, line: number, token: string, occurrence = 1): number {
    const text = source.split("\n")[line - 1] ?? "";
    let index = -1;
    for (let seen = 0; seen < occurrence; seen += 1) index = text.indexOf(token, index + 1);
    if (index < 0) throw new Error(`no ${token} on line ${line}: ${text}`);
    return index + 1;
  }

  async function gotoLine(
    index: Awaited<ReturnType<typeof buildProjectIndex>>,
    root: string,
    file: string,
    line: number,
    token: string,
  ) {
    const column = columnOf(FILES[file]!, line, token);
    const result = await goToDefinition(index, { file: path.join(root, file), line, column });
    if (result.status !== "ok") return result.status;
    return `${path.basename(result.definition.file)}:${result.definition.range.start.line}:${result.definition.localName}`;
  }

  async function referenceLines(
    index: Awaited<ReturnType<typeof buildProjectIndex>>,
    root: string,
    file: string,
    line: number,
    token: string,
  ) {
    const result = await findReferences(index, {
      file: path.join(root, file),
      line,
      column: columnOf(FILES[file]!, line, token),
    });
    if (result.status !== "ok") throw new Error(`references ${result.status}`);
    return {
      sites: result.references
        .map((reference) => `${path.basename(reference.file)}:${reference.range.start.line}`)
        .sort(),
      coverage: result.referenceCoverage.state,
    };
  }

  async function answers(index: Awaited<ReturnType<typeof buildProjectIndex>>, root: string) {
    return {
      goto: [
        await gotoLine(index, root, "gauge.rb", 26, "full?"),
        await gotoLine(index, root, "gauge.rb", 27, "full"),
        await gotoLine(index, root, "gauge.rb", 29, "label"),
        await gotoLine(index, root, "gauge.rb", 30, "label"),
        await gotoLine(index, root, "gauge.rb", 14, "mode"),
        await gotoLine(index, root, "gauge.rb", 31, "mode"),
        await gotoLine(index, root, "use.rb", 4, "full?"),
        await gotoLine(index, root, "use.rb", 5, "level"),
        await gotoLine(index, root, "use.rb", 6, "unit"),
        await gotoLine(index, root, "use.rb", 7, "label"),
        await gotoLine(index, root, "use.rb", 8, "full?"),
        await gotoLine(index, root, "use.rb", 9, "level"),
        await gotoLine(index, root, "use.rb", 10, "label"),
      ],
      refs: [
        await referenceLines(index, root, "gauge.rb", 5, "full?"),
        await referenceLines(index, root, "gauge.rb", 9, "full"),
        await referenceLines(index, root, "gauge.rb", 2, "level"),
        await referenceLines(index, root, "gauge.rb", 3, "mode"),
        await referenceLines(index, root, "gauge.rb", 17, "label"),
        await referenceLines(index, root, "gauge.rb", 21, "label"),
      ],
    };
  }

  it("resolves suffix names, generated accessors, and writer calls apart from same-named decoys", async () => {
    const root = await fixture();
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const found = await answers(index, root);
      expect(found.goto).toEqual([
        "gauge.rb:5:full?",
        "gauge.rb:9:full",
        "gauge.rb:17:label=",
        "gauge.rb:21:label",
        "gauge.rb:3:mode=",
        "gauge.rb:3:mode",
        "gauge.rb:5:full?",
        "gauge.rb:2:level",
        "gauge.rb:2:unit",
        "gauge.rb:17:label=",
        "dial.rb:3:full?",
        "dial.rb:2:level",
        "dial.rb:6:label=",
      ]);
      // `full?` and `full` share no site; `attr_accessor :mode` lists the writer call and the reader call.
      expect(found.refs).toEqual([
        { sites: ["gauge.rb:26", "gauge.rb:5", "use.rb:4"], coverage: "complete" },
        { sites: ["gauge.rb:27", "gauge.rb:9"], coverage: "complete" },
        { sites: ["gauge.rb:10", "gauge.rb:2", "gauge.rb:6", "use.rb:5"], coverage: "complete" },
        { sites: ["gauge.rb:14", "gauge.rb:3", "gauge.rb:31"], coverage: "complete" },
        { sites: ["gauge.rb:17", "gauge.rb:29", "use.rb:7"], coverage: "complete" },
        { sites: ["gauge.rb:21", "gauge.rb:30"], coverage: "complete" },
      ]);
      const graph = await buildSymbolGraphDetailed(index);
      const gauge = path.join(root, "gauge.rb");
      const callees = (callerName: string) => {
        const caller = [...graph.nodes.values()].find(
          (node) => node.name === callerName && fileIdentityKey(node.file) === fileIdentityKey(gauge),
        );
        return graph.edges
          .filter((edge) => edge.from === caller?.id && edge.label === "calls")
          .map((edge) => graph.nodes.get(edge.to)?.name)
          .sort();
      };
      expect(callees("drain!")).toEqual(["mode="]);
      // A bare `full` is no local, so it calls `full` (and `full?` stays a different method).
      expect(callees("check")).toEqual(["drain!", "full", "full?", "label", "label=", "mode"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps cold, reopened, and incrementally updated disk caches equal to a cold build", async () => {
    const root = await fixture();
    try {
      const cold = await answers(await buildProjectIndex(root, { cache: "off" }), root);
      expect(await answers(await buildProjectIndex(root, { cache: "disk" }), root)).toEqual(cold);
      expect(await answers(await buildProjectIndex(root, { cache: "disk" }), root)).toEqual(cold);
      await fsp.appendFile(path.join(root, "gauge.rb"), "# edited\n");
      const edited = await buildProjectIndexIncremental(root, { cache: "disk" });
      expect(await answers(edited, root)).toEqual(await answers(await buildProjectIndex(root, { cache: "off" }), root));
      await fsp.writeFile(path.join(root, "gauge.rb"), GAUGE);
      expect(await answers(await buildProjectIndexIncremental(root, { cache: "disk" }), root)).toEqual(cold);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("previews a writer rename without touching its reader or the unsafe call sites", async () => {
    const root = await fixture();
    try {
      const session = createAgentSession({ root, freshness: { policy: "check" } });
      const symbols = await workspaceSymbolsWithSession(session, { root, query: "label" });
      const writer = symbols.symbols.find((symbol) => symbol.name === "label=" && symbol.location.file === "gauge.rb");
      expect(writer).toBeDefined();
      if (!writer) throw new Error("missing writer symbol");
      const preview = await previewRenameWithSession(session, { root, handle: writer.handle, newName: "title" });
      // A call site spells the writer `label`, not `label=`, so the preview cannot edit it and is not safe.
      expect(preview.safe).toBe(false);
      const touched = [
        ...preview.edits.map((edit) => edit.file),
        ...preview.unsafeSites.map((site) => site.location.file),
      ];
      expect(touched.every((file) => file === "gauge.rb" || file === "use.rb")).toBe(true);
      const readerLines = new Set([21, 30]);
      for (const edit of preview.edits) {
        expect(edit.file === "gauge.rb" && readerLines.has(edit.range.start.line)).toBe(false);
      }
      for (const site of preview.unsafeSites) {
        expect(site.location.file === "gauge.rb" && readerLines.has(site.location.range.start.line)).toBe(false);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("previews a reader rename as unsafe while a compound assignment calls the writer", async () => {
    const root = await fixture();
    try {
      const session = createAgentSession({ root, freshness: { policy: "check" } });
      const handleOf = async (query: string, name: string): Promise<string> => {
        const symbols = await workspaceSymbolsWithSession(session, { root, query });
        const found = symbols.symbols.find((symbol) => symbol.name === name && symbol.location.file === "item.rb");
        if (!found) throw new Error(`missing ${name}`);
        return found.handle;
      };
      const lines = (ranges: ReadonlyArray<{ range: { start: { line: number } } }>): number[] =>
        ranges.map((entry) => entry.range.start.line).sort((a, b) => a - b);
      const reader = await previewRenameWithSession(session, {
        root,
        handle: await handleOf("total", "total"),
        newName: "sum",
      });
      // `item.total += 1` and `item.total ||= 2` call the writer `total=` too, which a reader rename leaves behind.
      expect(reader.safe).toBe(false);
      expect(lines(reader.unsafeSites.map((site) => site.location))).toEqual([11, 12]);
      expect(lines(reader.edits)).toEqual([2, 13]);
      const accessor = await previewRenameWithSession(session, {
        root,
        handle: await handleOf("amount", "amount"),
        newName: "size",
      });
      // An accessor is declared at its symbol token (`:amount`), which a text edit cannot rewrite, so it stays unsafe.
      expect(accessor.safe).toBe(false);
      expect(lines(accessor.unsafeSites.map((site) => site.location))).toEqual([8, 15]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Ruby generated methods across cache states", () => {
  type Index = Awaited<ReturnType<typeof buildProjectIndex>>;
  const NAMES = new Set(
    "v w later name count err ay dy z mode target label full? drain! full drain other k lv ev mv limit total item ax level kind reserve cap slot note reading pulse emit top_total cx mx area fill describe stamp entries notes stoke kindle beam gel around c0 c1 verify sap leaf drink wrap breeze frost make checkable_layout?".split(
      " ",
    ),
  );

  /**
   * The fixture files each replay builds: the files its edits touch, the files that read them, and untouched files whose
   * answers must not move. Together the groups cover the whole fixture, and each replay stays a few builds of a few files.
   */
  const REPLAY_FILES = {
    attrLines: ["scope.rb", "locals.rb", "order.rb", "receivers.rb", "blocks.rb"],
    declaringFile: ["device.rb", "decoy.rb", "operator.rb"],
    scopes: ["shadow.rb", "selfs.rb", "statics.rb", "use_statics.rb"],
    memberCoverage: ["untyped_owner.rb", "untyped_use.rb"],
    gates: [
      "wrapped.rb",
      "nested.rb",
      "gates.rb",
      "families.rb",
      "heritage.rb",
      "singletons.rb",
      "chains.rb",
      "mixins.rb",
      "mixed_use.rb",
      "includer.rb",
      "inclusion.rb",
      "nodraft.rb",
      "dsl.rb",
      "locals_ops.rb",
    ],
  } as const;

  const sourcesOf = (group: keyof typeof REPLAY_FILES): Record<string, string> =>
    Object.fromEntries(
      REPLAY_FILES[group].map((name) => {
        const source = RUBY_SCOPE_SOURCES[name];
        if (source === undefined) throw new Error(`Missing Ruby scope fixture file ${name}`);
        return [name, source];
      }),
    );

  /** Every goto, reference list, and call edge at each token of the names under test, from the files as they stand. */
  async function snapshot(index: Index, root: string): Promise<string[]> {
    const relative = (file: string): string => path.relative(root, file).replaceAll("\\", "/");
    const out: string[] = [];
    for (const name of (await fsp.readdir(root)).filter((file) => file.endsWith(".rb")).sort()) {
      const lines = (await fsp.readFile(path.join(root, name), "utf8")).split("\n");
      for (const [offset, line] of lines.entries()) {
        for (const match of line.matchAll(/:?[A-Za-z_][A-Za-z0-9_]*[?!]?/g)) {
          if (!NAMES.has(match[0].replace(/^:/, ""))) continue;
          const where = { file: path.join(root, name), line: offset + 1, column: match.index + 1 };
          const goto = await goToDefinition(index, where);
          const refs = await findReferences(index, where);
          const target =
            goto.status === "ok"
              ? `${relative(goto.definition.file)}:${goto.definition.range.start.line}:${goto.definition.localName}`
              : "not_found";
          const sites =
            refs.status === "ok"
              ? `${refs.references
                  .map((ref) => `${relative(ref.file)}:${ref.range.start.line}:${ref.range.start.column}`)
                  .sort()
                  .join(" ")} ${refs.referenceCoverage.state}`
              : refs.status;
          out.push(`${name}:${offset + 1}:${match.index + 1} ${match[0]} goto=${target} refs=${sites}`);
        }
      }
    }
    const graph = await buildSymbolGraphDetailed(index);
    for (const edge of graph.edges) {
      if (edge.label !== "calls") continue;
      const from = graph.nodes.get(edge.from);
      const to = graph.nodes.get(edge.to);
      out.push(`calls ${relative(from?.file ?? "")}:${from?.name} -> ${relative(to?.file ?? "")}:${to?.name}`);
    }
    return out.sort();
  }

  type Replay = {
    file: (name: string) => string;
    edit: (name: string, from: string, to: string) => Promise<void>;
    /** Builds cold, incrementally from the disk cache, reopened from it, and in memory; the last three answer like the cold one. */
    answersAt: (step: string) => Promise<string[]>;
    /** The files are back as they were at the start, so a cold build would repeat the baseline: the other three answer like it. */
    restoredAt: (step: string, baseline: readonly string[]) => Promise<void>;
  };

  /** Writes `sources` to a temporary project and runs `steps` over it. */
  async function replayAcrossCacheStates(
    sources: Readonly<Record<string, string>>,
    steps: (replay: Replay) => Promise<void>,
  ): Promise<void> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-scope-cache-"));
    const file = (name: string): string => path.join(root, name);
    try {
      await writeFixtureFiles(root, sources);
      const edit = async (name: string, from: string, to: string): Promise<void> => {
        const text = await fsp.readFile(file(name), "utf8");
        expect(text, `${name} contains ${from}`).toContain(from);
        await fsp.writeFile(file(name), text.replace(from, to));
      };
      const filesOnDisk = async (): Promise<Record<string, string>> => {
        const found: Record<string, string> = {};
        for (const name of (await fsp.readdir(root)).filter((entry) => entry.endsWith(".rb")).sort()) {
          found[name] = await fsp.readFile(file(name), "utf8");
        }
        return found;
      };
      const cachedAnswers = async () => ({
        warm: await snapshot(await buildProjectIndexIncremental(root, { cache: "disk" }), root),
        reopened: await snapshot(await buildProjectIndex(root, { cache: "disk" }), root),
        memory: await snapshot(await buildProjectIndex(root, { cache: "memory" }), root),
      });
      const answersAt = async (step: string): Promise<string[]> => {
        const cold = await snapshot(await buildProjectIndex(root, { cache: "off" }), root);
        const { warm, reopened, memory } = await cachedAnswers();
        expect(warm, `${step}: incremental disk`).toEqual(cold);
        expect(reopened, `${step}: reopened disk`).toEqual(cold);
        expect(memory, `${step}: memory`).toEqual(cold);
        return cold;
      };
      const restoredAt = async (step: string, baseline: readonly string[]): Promise<void> => {
        expect(await filesOnDisk(), `${step}: files as at the start`).toEqual(sources);
        const { warm, reopened, memory } = await cachedAnswers();
        expect(warm, `${step}: incremental disk`).toEqual(baseline);
        expect(reopened, `${step}: reopened disk`).toEqual(baseline);
        expect(memory, `${step}: memory`).toEqual(baseline);
      };
      await steps({ file, edit, answersAt, restoredAt });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }

  it("answers calls to generated methods, typed locals, and decoys from the detailed graph", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-scope-graph-"));
    try {
      const paths = await writeFixtureFiles(root, RUBY_SCOPE_SOURCES);
      const index = await createTestIndexFromFiles(root, Object.values(paths));
      await expectRubyScopeCalls(index, paths);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("replays every file of the scope fixture", () => {
    expect(Object.values(REPLAY_FILES).flat().sort()).toEqual(Object.keys(RUBY_SCOPE_SOURCES).sort());
  });

  it("keeps cold, memory, disk, and reopened builds equal while an attr line names another attribute or becomes a def", async () => {
    await replayAcrossCacheStates(sourcesOf("attrLines"), async ({ edit, answersAt, restoredAt }) => {
      const baseline = await answersAt("cold");
      expect(baseline).toContain("scope.rb:3:13 v goto=scope.rb:2:v refs=scope.rb:2:15 scope.rb:3:13 complete");

      // An attr line that names another attribute removes the reader and its sites.
      await edit(
        "scope.rb",
        "attr_reader :v\n  def read; v; end\nend\nclass Right",
        "attr_reader :u\n  def read; v; end\nend\nclass Right",
      );
      const renamed = await answersAt("attr line edited");
      expect(renamed).toContain("scope.rb:3:13 v goto=not_found refs=not_found");
      await edit("scope.rb", "attr_reader :u", "attr_reader :v");
      await restoredAt("attr line restored", baseline);

      // An attr line becomes a def, and a def becomes an attr line, of the same name.
      await edit("scope.rb", "attr_reader :later", "def later; end");
      await answersAt("attr replaced by def");
      await edit("scope.rb", "def later; end", "attr_reader :later");
      await restoredAt("def replaced by attr", baseline);
    });
  });

  it("keeps cold, memory, disk, and reopened builds equal while a ?/! def loses its suffix and its file is deleted or renamed", async () => {
    await replayAcrossCacheStates(sourcesOf("declaringFile"), async ({ file, edit, answersAt, restoredAt }) => {
      const baseline = await answersAt("cold");
      expect(baseline).toContain(
        "operator.rb:11:12 full? goto=device.rb:5:full? refs=device.rb:5:7 operator.rb:11:12 complete",
      );

      // A `?` and a `!` def lose their suffix, so the receiver calls that name them find nothing.
      await edit("device.rb", "def full?; true; end", "def full; true; end");
      await edit("device.rb", "def drain!; end", "def drain; end");
      const suffixed = await answersAt("suffix removed");
      expect(suffixed).toContain("operator.rb:11:12 full? goto=not_found refs=not_found");
      await edit("device.rb", "def full; true; end", "def full?; true; end");
      await edit("device.rb", "def drain; end", "def drain!; end");
      await restoredAt("suffix restored", baseline);

      // The declaring file is deleted and restored.
      const device = await fsp.readFile(file("device.rb"), "utf8");
      await fsp.rm(file("device.rb"));
      const deleted = await answersAt("declaring file deleted");
      expect(deleted).toContain("operator.rb:6:12 mode goto=not_found refs=not_found");
      await fsp.writeFile(file("device.rb"), device);
      await restoredAt("declaring file restored", baseline);

      // The declaring file is renamed away and back.
      await fsp.rename(file("device.rb"), file("device_moved.rb"));
      const moved = await answersAt("declaring file renamed away");
      expect(moved).not.toEqual(baseline);
      await fsp.rename(file("device_moved.rb"), file("device.rb"));
      await restoredAt("declaring file renamed back", baseline);
    });
  });

  it("keeps cold, memory, disk, and reopened builds equal while a lambda parameter, a singleton method, and a static method change", async () => {
    await replayAcrossCacheStates(sourcesOf("scopes"), async ({ edit, answersAt, restoredAt }) => {
      const baseline = await answersAt("cold");
      expect(baseline.some((line) => line.startsWith("use_statics.rb:6:12 level goto=statics.rb:7:level "))).toBe(true);

      // A lambda parameter hides the reader; renaming it releases the reader, and restoring it hides the reader again.
      await edit("shadow.rb", "->(k) { k }.call(1)", "->(j) { k }.call(1)");
      const released = await answersAt("lambda parameter renamed");
      expect(released.some((line) => line.startsWith("shadow.rb:4:13 k goto=shadow.rb:2:k "))).toBe(true);
      await edit("shadow.rb", "->(j) { k }.call(1)", "->(k) { k }.call(1)");
      await restoredAt("lambda parameter restored", baseline);

      // `self` in a singleton method is the class; as an instance method it reaches the accessor.
      await edit("selfs.rb", "def self.single", "def single");
      const instance = await answersAt("singleton method became an instance method");
      expect(instance.some((line) => line.startsWith("selfs.rb:8:10 lv goto=selfs.rb:2:lv "))).toBe(true);
      await edit("selfs.rb", "def single", "def self.single");
      await restoredAt("singleton method restored", baseline);

      // The singleton method of the same name goes away: the constant receiver still does not reach the accessor.
      await edit("statics.rb", "def self.level", "def self.levelx");
      const withoutSingleton = await answersAt("singleton method renamed");
      expect(withoutSingleton.some((line) => line.startsWith("statics.rb:14:12 level goto=not_found "))).toBe(true);
      await edit("statics.rb", "def self.levelx", "def self.level");
      await restoredAt("singleton method restored again", baseline);
    });
  });

  it("keeps conservative lambda shadowing equal across cold, memory, disk, and reopened builds", async () => {
    const source = ["total = 1", "def total; 42; end", "puts ->(total) { total }.call(7)", "puts total", ""].join("\n");
    await replayAcrossCacheStates({ "lambda.rb": source }, async ({ edit, answersAt, restoredAt }) => {
      const baseline = await answersAt("lambda shadows local");
      expect(baseline.some((line) => line.startsWith("lambda.rb:3:18 total goto=not_found "))).toBe(true);
      await edit("lambda.rb", "->(total)", "->(other)");
      const captured = await answersAt("lambda captures local");
      expect(captured.some((line) => line.startsWith("lambda.rb:3:18 total goto=lambda.rb:1:total "))).toBe(true);
      await edit("lambda.rb", "->(other)", "->(total)");
      await restoredAt("lambda parameter restored", baseline);
    });
  });

  it("keeps cold, memory, disk, and reopened builds equal while a visibility call and a scope gate change", async () => {
    await replayAcrossCacheStates(sourcesOf("gates"), async ({ edit, answersAt, restoredAt }) => {
      const baseline = await answersAt("cold");
      expect(baseline).toContain("gates.rb:10:5 cx goto=gates.rb:9:cx refs=gates.rb:10:5 gates.rb:9:3 complete");

      // A visibility call around an attr macro goes away and comes back.
      await edit("wrapped.rb", "private attr_reader :reserve", "attr_reader :reserve");
      await answersAt("visibility call removed");
      await edit("wrapped.rb", "attr_reader :reserve", "private attr_reader :reserve");
      await restoredAt("visibility call restored", baseline);

      // A `def` that hid a top-level local becomes a block, which reads it, and becomes a `def` again.
      await edit("gates.rb", "def uses_top_total\n  top_total\nend", "[1].each do\n  top_total\nend");
      const opened = await answersAt("def became a block");
      expect(opened.some((line) => line.startsWith("gates.rb:3:3 top_total goto=gates.rb:1:top_total "))).toBe(true);
      await edit("gates.rb", "[1].each do\n  top_total\nend", "def uses_top_total\n  top_total\nend");
      await restoredAt("block became a def", baseline);
    });
  });
  it("keeps explicit method namespaces equal through edits, file renames, deletion, and restoration", async () => {
    const source = [
      "def total; 42; end",
      "def read(total); [total, total()]; end",
      "class Reader",
      "  attr_reader :level",
      "  def read(level); [level, level(), self.level]; end",
      "end",
      "",
    ].join("\n");
    await replayAcrossCacheStates({ "explicit.rb": source }, async ({ file, edit, answersAt, restoredAt }) => {
      const baseline = await answersAt("explicit calls beside parameters");
      expect(baseline.some((line) => line.startsWith("explicit.rb:2:26 total goto=explicit.rb:1:total "))).toBe(true);
      await edit("explicit.rb", "def read(total); [total, total()]", "def read(value); [value, total()]");
      await answersAt("parameter renamed");
      await edit("explicit.rb", "def read(value); [value, total()]", "def read(total); [total, total()]");
      await restoredAt("parameter restored", baseline);
      await fsp.rename(file("explicit.rb"), file("moved.rb"));
      await answersAt("file renamed");
      await fsp.rename(file("moved.rb"), file("explicit.rb"));
      await restoredAt("file renamed back", baseline);
      await fsp.rm(file("explicit.rb"));
      await answersAt("file deleted");
      await fsp.writeFile(file("explicit.rb"), source);
      await restoredAt("file restored", baseline);
    });
  });

  it("keeps nested module member coverage equal across edits and file lifecycle changes", async () => {
    await replayAcrossCacheStates(sourcesOf("memberCoverage"), async ({ file, edit, answersAt, restoredAt }) => {
      const baseline = await answersAt("untyped module receiver");
      expect(baseline.some((line) => line.startsWith("untyped_owner.rb:3:9 checkable_layout? "))).toBe(true);
      await edit("untyped_owner.rb", "def checkable_layout?", "def other");
      await answersAt("method renamed");
      await edit("untyped_owner.rb", "def other", "def checkable_layout?");
      await restoredAt("method restored", baseline);
      const owner = await fsp.readFile(file("untyped_owner.rb"), "utf8");
      await fsp.rename(file("untyped_owner.rb"), file("moved.rb"));
      await answersAt("module file moved");
      await fsp.rename(file("moved.rb"), file("untyped_owner.rb"));
      await restoredAt("module file moved back", baseline);
      await fsp.rm(file("untyped_owner.rb"));
      await answersAt("module file deleted");
      await fsp.writeFile(file("untyped_owner.rb"), owner);
      await restoredAt("module file restored", baseline);
    });
  });
});

describe("Ruby scope index facts", () => {
  async function scopeOf(source: string) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-scope-fact-"));
    const file = path.join(root, "test.rb");
    await fsp.writeFile(file, source, "utf8");
    try {
      const parsed = await parseFile(file);
      return buildScopeIndexFromSource(file, parsed.source, parsed.sup, [], { tree: parsed.tree });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }

  it("records whether a file can generate methods, so a file without attr_ pays nothing for them", async () => {
    expect((await scopeOf("class A\n  attr_reader :v\nend\n")).hasGeneratedMembers).toBe(true);
    expect((await scopeOf("class A\n  def v; end\nend\n")).hasGeneratedMembers).toBe(false);
  });
});

describe("Ruby locals sharing method names", () => {
  it("keeps local reads and method calls in separate reference and rename families", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-local-method-"));
    const file = path.join(root, "collision.rb");
    // Ruby 3.3 prints 1,1,1,1,42,42, then 73,7, then 13,13,88 for this exact program.
    const source = [
      "total = 1",
      "def total",
      "  42",
      "end",
      "after = total",
      "from_block = [1].map { total }.first",
      "from_lambda = -> { total }.call",
      "define_singleton_method(:captured_total) { total }",
      "def read_total",
      "  total",
      "end",
      "explicit = total()",
      'puts [after, from_block, from_lambda, captured_total, read_total, explicit].join(",")',
      "def second",
      "  73",
      "end",
      "before_second = second",
      "second = 7",
      "after_second = second",
      'puts [before_second, after_second].join(",")',
      "amount = 13",
      "before_amount = amount",
      "def amount",
      "  88",
      "end",
      "after_amount = amount",
      'puts [before_amount, after_amount, amount()].join(",")',
      "",
    ].join("\n");
    const request = (line: number, name = "total") => ({
      file,
      line,
      column: source.split("\n")[line - 1]!.lastIndexOf(name) + 1,
    });
    try {
      await fsp.writeFile(file, source);
      const options = { cache: "off" as const, threads: 1, useNativeWorkers: false, logLevel: "silent" as const };
      const index = await buildProjectIndex(root, options);
      for (const [line, target, name] of [
        [5, 1, "total"],
        [6, 1, "total"],
        [7, 1, "total"],
        [8, 1, "total"],
        [10, 2, "total"],
        [12, 2, "total"],
        [17, 14, "second"],
        [19, 18, "second"],
        [22, 21, "amount"],
        [26, 21, "amount"],
        [27, 23, "amount"],
      ] as const) {
        const result = await goToDefinition(index, request(line, name));
        expect(result.status, `line ${line}`).toBe("ok");
        if (result.status !== "ok") throw new Error(`Missing definition at ${line}`);
        expect(result.definition.range.start.line).toBe(target);
      }
      for (const [declaration, name, expected] of [
        [1, "total", [1, 5, 6, 7, 8]],
        [2, "total", [2, 10, 12]],
        [14, "second", [14, 17]],
        [18, "second", [18, 19]],
        [21, "amount", [21, 22, 26]],
        [23, "amount", [23, 27]],
      ] as const) {
        const result = await findReferences(index, request(declaration, name));
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error(`Missing references for ${declaration}`);
        expect(result.referenceCoverage.state).toBe("complete");
        expect(result.references.map((reference) => reference.range.start.line).sort((a, b) => a - b)).toEqual(
          expected,
        );
      }
      const graph = await buildSymbolGraphDetailed(index);
      const caller = [...graph.nodes.values()].find((node) => node.name === "read_total");
      const method = [...graph.nodes.values()].find((node) => node.name === "total" && node.kind === "function");
      expect(caller).toBeDefined();
      expect(method).toBeDefined();
      expect(
        graph.edges.filter((edge) => edge.from === caller?.id && edge.label === "calls").map((edge) => edge.to),
      ).toEqual([method?.id]);
      const session = createAgentSession({
        root,
        useConfig: false,
        buildOptions: options,
        freshness: { policy: "check" },
      });
      for (const [name, declaration, expected] of [
        ["total", 1, [1, 5, 6, 7, 8]],
        ["total", 2, [2, 10, 12]],
        ["amount", 21, [21, 22, 26]],
        ["amount", 23, [23, 27]],
      ] as const) {
        const symbols = await workspaceSymbolsWithSession(session, { root, query: name });
        const symbol = symbols.symbols.find(
          (entry) => entry.name === name && entry.location.range.start.line === declaration,
        );
        if (!symbol) throw new Error(`Missing symbol at ${declaration}`);
        const preview = await previewRenameWithSession(session, { root, handle: symbol.handle, newName: "sum" });
        expect(preview.safe).toBe(true);
        expect(preview.edits.map((edit) => edit.range.start.line).sort((a, b) => a - b)).toEqual(expected);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Ruby block and lambda parameter shadowing", () => {
  it("keeps shadowing binders out of an outer local's references and marks incomplete renames unsafe", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-lambda-shadow-"));
    const file = path.join(root, "shadowing.rb");
    // Ruby 3.3 prints 7, 8, 9, 10, 11, 1, 1, 1, 12, 99, 13, 3, 42, 14, 1, 42, 42, 15, 42, 42.
    const lines = [
      "total = 1",
      "def total; 42; end",
      "puts ->(total) { total }.call(7)",
      "puts lambda { |total| total }.call(8)",
      "puts proc { |total| total }.call(9)",
      "puts [10].map { |total| total }.first",
      "puts [0].map { |;total| total || 11 }.first",
      "puts ->(value = total) { value }.call",
      "puts -> { total }.call",
      "puts total",
      "puts [12].map { _1 }.first",
      "it = 13",
      "def it; 42; end",
      "puts [99].map { |it| it }.first",
      "puts [99].map { it }.first",
      "def check_local",
      "  local = 3",
      "  def local; 4; end",
      "  [7].map { |local| local }",
      "  ->(local) { local }.call(8)",
      "  local",
      "end",
      "puts check_local",
      "def read_method",
      "  total",
      "end",
      "puts read_method",
      "puts ->(total: 14) { total }.call",
      "puts ->(value: total) { value }.call",
      "puts ->(total) { total() }.call(17)",
      "def explicit_lambda",
      "  ->(total) { total() }.call(17)",
      "end",
      "puts explicit_lambda",
      "puts [0].map { |;total| total = 15; total }.first",
      "puts ->(total = 16) { total() }.call",
      "puts ->(total: 17) { total() }.call",
      "",
    ];
    const source = lines.join("\n");
    const site = (line: number, name: string, occurrence = 0) => {
      let column = -1;
      for (let seen = 0; seen <= occurrence; seen += 1) column = lines[line - 1]!.indexOf(name, column + 1);
      if (column < 0) throw new Error(`Missing ${name} on line ${line}`);
      return { file, line, column: column + 1 };
    };
    try {
      await fsp.writeFile(file, source);
      const options = { cache: "off" as const, threads: 1, useNativeWorkers: false, logLevel: "silent" as const };
      const index = await buildProjectIndex(root, options);
      for (const [line, name] of [
        [4, "total"],
        [5, "total"],
        [6, "total"],
        [7, "total"],
        [14, "it"],
        [19, "local"],
      ] as const) {
        const declaration = site(line, name);
        const use = site(line, name, 1);
        for (const request of [declaration, use]) {
          const result = await goToDefinition(index, request);
          expect(result.status, `${line}:${request.column}`).toBe("ok");
          if (result.status !== "ok") throw new Error(`Missing ${name} definition at ${line}:${request.column}`);
          expect(result.definition.range.start.line).toBe(line);
          expect(result.definition.range.start.column).toBe(declaration.column);
        }
        const references = await findReferences(index, declaration);
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error(`Missing ${name} references at ${line}`);
        expect(references.referenceCoverage.state).toBe("complete");
        expect(references.references.map((reference) => reference.range.start.column).sort((a, b) => a - b)).toEqual([
          declaration.column,
          use.column,
        ]);
      }
      for (const [line, name] of [
        [3, "total"],
        [20, "local"],
        [28, "total"],
      ] as const) {
        for (const occurrence of [0, 1]) {
          expect((await goToDefinition(index, site(line, name, occurrence))).status).toBe("not_found");
        }
      }
      for (const [name, declaration, uses] of [
        ["total", 1, [8, 9, 10, 29]],
        ["it", 12, [15]],
      ] as const) {
        for (const line of uses) {
          const result = await goToDefinition(index, site(line, name));
          expect(result.status).toBe("ok");
          if (result.status !== "ok") throw new Error(`Missing outer ${name} at ${line}`);
          expect(result.definition.range.start.line).toBe(declaration);
        }
        const references = await findReferences(index, site(declaration, name));
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error(`Missing outer ${name} references`);
        expect(references.referenceCoverage.state).toBe(name === "total" ? "partial" : "complete");
        expect(references.references.map((reference) => reference.range.start.line).sort((a, b) => a - b)).toEqual([
          declaration,
          ...uses,
        ]);
      }
      for (const line of [30, 32, 36, 37]) {
        const result = await goToDefinition(index, site(line, "total", 1));
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error(`Missing explicit method at ${line}`);
        expect(result.definition.range.start.line).toBe(2);
      }
      const methodReferences = await findReferences(index, site(2, "total"));
      expect(methodReferences.status).toBe("ok");
      if (methodReferences.status !== "ok") throw new Error("Missing total method references");
      expect(methodReferences.referenceCoverage.state).toBe("partial");
      expect(methodReferences.references.map((reference) => reference.range.start.line).sort((a, b) => a - b)).toEqual([
        2, 25, 30, 32, 36, 37,
      ]);
      for (const occurrence of [0, 1, 2]) {
        const result = await goToDefinition(index, site(35, "total", occurrence));
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error(`Missing block-local total at occurrence ${occurrence}`);
        expect(result.definition.range.start.line).toBe(35);
      }
      expect((await goToDefinition(index, site(30, "total"))).status).toBe("not_found");
      expect((await goToDefinition(index, site(11, "_1"))).status).toBe("not_found");
      const graph = await buildSymbolGraphDetailed(index);
      const callees = (name: string): Array<string | undefined> => {
        const caller = [...graph.nodes.values()].find((node) => node.name === name);
        return graph.edges
          .filter((edge) => edge.from === caller?.id && edge.label === "calls")
          .map((edge) => graph.nodes.get(edge.to)?.name);
      };
      expect(callees("check_local")).not.toContain("local");
      expect(callees("read_method")).toContain("total");
      expect(callees("explicit_lambda")).toContain("total");
      const session = createAgentSession({
        root,
        useConfig: false,
        buildOptions: options,
        freshness: { policy: "check" },
      });
      const symbols = await workspaceSymbolsWithSession(session, { root, query: "total" });
      const local = symbols.symbols.find((entry) => entry.name === "total" && entry.location.range.start.line === 1);
      if (!local) throw new Error("Missing outer total");
      const preview = await previewRenameWithSession(session, { root, handle: local.handle, newName: "sum" });
      expect(preview.safe).toBe(false);
      expect(preview.edits.map((edit) => edit.range.start.line).sort((a, b) => a - b)).toEqual([1, 8, 9, 10, 29]);
      let renamed = source;
      for (const edit of [...preview.edits].sort((left, right) => right.range.start.index! - left.range.start.index!)) {
        renamed = renamed.slice(0, edit.range.start.index) + edit.newText + renamed.slice(edit.range.end.index);
      }
      expect(renamed).toBe(
        source
          .replace("total = 1", "sum = 1")
          .replace("value = total", "value = sum")
          .replace("value: total", "value: sum")
          .replace("-> { total }", "-> { sum }")
          .replace("puts total\n", "puts sum\n"),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps unmodeled lambda parameters apart from outer and nearer block locals", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-unmodeled-lambda-"));
    const file = path.join(root, "locals.rb");
    // Ruby 3.3 prints 22, 21, 32, 31, 43, 41, 51, 61.
    const lines = [
      "plain = 21",
      "puts ->(plain) { plain }.call(22)",
      "puts plain",
      "value = 31",
      "puts ->(value) { [32].map { |value| value }.first }.call(30)",
      "puts value",
      "first = 41",
      "puts ->((first, second)) { first + second }.call([42, 1])",
      "puts first",
      "other = 51",
      "puts ->(a = other) { other }.call",
      "delta = 61",
      "puts ->(fn = ->(delta) { delta }) { delta }.call",
      "",
    ];
    const site = (line: number, name: string, occurrence = 0) => {
      let column = -1;
      for (let seen = 0; seen <= occurrence; seen += 1) column = lines[line - 1]!.indexOf(name, column + 1);
      if (column < 0) throw new Error(`Missing ${name} on line ${line}`);
      return { file, line, column: column + 1 };
    };
    try {
      await fsp.writeFile(file, lines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off", threads: 1, useNativeWorkers: false });
      for (const [line, name] of [
        [2, "plain"],
        [8, "first"],
        [13, "delta"],
      ] as const) {
        for (const occurrence of [0, 1]) {
          expect((await goToDefinition(index, site(line, name, occurrence))).status).toBe("not_found");
        }
      }
      for (const [line, name, occurrence, declaration] of [
        [5, "value", 1, 5],
        [5, "value", 2, 5],
        [11, "other", 0, 10],
        [11, "other", 1, 10],
        [13, "delta", 2, 12],
      ] as const) {
        const result = await goToDefinition(index, site(line, name, occurrence));
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error(`Missing ${name} at ${line}`);
        expect(result.definition.range.start.line).toBe(declaration);
        if (line === 5) expect(result.definition.range.start.column).toBe(site(5, "value", 1).column);
      }
      for (const [name, declaration, uses] of [
        ["plain", 1, [3]],
        ["value", 4, [6]],
        ["first", 7, [9]],
        ["delta", 12, [13]],
      ] as const) {
        const result = await findReferences(index, site(declaration, name));
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error(`Missing ${name} references`);
        expect(result.referenceCoverage.state).toBe("partial");
        expect(result.references.map((reference) => reference.range.start.line).sort((a, b) => a - b)).toEqual([
          declaration,
          ...uses,
        ]);
      }
      const session = createAgentSession({
        root,
        useConfig: false,
        buildOptions: { cache: "off", threads: 1, useNativeWorkers: false },
        freshness: { policy: "check" },
      });
      const symbols = await workspaceSymbolsWithSession(session, { root, query: "plain" });
      const local = symbols.symbols.find((symbol) => symbol.name === "plain" && symbol.location.range.start.line === 1);
      if (!local) throw new Error("Missing plain local");
      const preview = await previewRenameWithSession(session, { root, handle: local.handle, newName: "renamed" });
      expect(preview.safe).toBe(false);
      expect(preview.edits.map((edit) => edit.range.start.line).sort((a, b) => a - b)).toEqual([1, 3]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not bind a singleton-method receiver through a shadowed lambda parameter", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-singleton-lambda-"));
    const file = path.join(root, "singleton.rb");
    // Ruby 3.3 prints false and 7: the singleton method is installed on `other`, not `target`.
    const source = [
      "target = Object.new",
      "other = Object.new",
      "->(target) do",
      "  def target.answer; 7; end",
      "end.call(other)",
      "puts target.respond_to?(:answer)",
      "puts other.answer",
      "",
    ].join("\n");
    try {
      await fsp.writeFile(file, source);
      const index = await buildProjectIndex(root, { cache: "off", threads: 1, useNativeWorkers: false });
      expect((await goToDefinition(index, { file, line: 4, column: 7 })).status).toBe("not_found");
      const refs = await findReferences(index, { file, line: 1, column: 1 });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error("Missing target references");
      expect(refs.referenceCoverage.state).toBe("partial");
      expect(refs.references.map((reference) => reference.range.start.line).sort((a, b) => a - b)).toEqual([1, 6]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "block",
      owner: "class Item\n  def touch; 42; end\nend\n",
      line: 2,
      call: "items.map { |a| a.touch }.first",
      item: "Item",
    },
    {
      label: "lambda",
      owner: "class Item\n  def touch; 42; end\nend\n",
      line: 2,
      call: "->(a) { a.touch }.call(items.first)",
      item: "Item",
    },
    {
      label: "nested lambda",
      owner: "module Outer\n  module Inner\n    class Item\n      def touch; 42; end\n    end\n  end\nend\n",
      line: 4,
      call: "->(a) { a.touch }.call(items.first)",
      item: "Outer::Inner::Item",
    },
    {
      label: "nested module block",
      owner:
        "module Outer\n  module Inner\n    def touch; 42; end\n  end\nend\nclass Item\n  include Outer::Inner\nend\n",
      line: 3,
      call: "items.map { |a| a.touch }.first",
      item: "Item",
      member: false,
    },
  ])("keeps $label receiver coverage partial", async ({ owner, line, call, item, member = true }) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-untyped-receiver-"));
    const declarationFile = path.join(root, "owner.rb");
    const useFile = path.join(root, "use.rb");
    try {
      await fsp.writeFile(declarationFile, owner);
      await fsp.writeFile(
        useFile,
        `require_relative "owner"\nclass Consumer\n  def run(items)\n    ${call}\n  end\nend\nputs Consumer.new.run([${item}.new])\n`,
      );
      const index = await buildProjectIndex(root, { cache: "off", threads: 1, useNativeWorkers: false });
      expect(
        !!index.byFile.get(fileIdentityKey(declarationFile))?.locals.find((local) => local.localName === "touch")
          ?.isMember,
      ).toBe(member);
      const column = owner.split("\n")[line - 1]!.indexOf("touch") + 1;
      const result = await findReferences(index, { file: declarationFile, line, column });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Missing touch references");
      expect(result.referenceCoverage.state).toBe("partial");
      expect(result.referenceCoverage.reasons).toContain("strategy_unavailable");
      expect(result.referenceCoverage.affectedFiles?.map(fileIdentityKey)).toContain(fileIdentityKey(useFile));
      expect(result.references.map((reference) => reference.range.start.line)).toEqual([line]);
      const session = createAgentSession({
        root,
        useConfig: false,
        buildOptions: { cache: "off", threads: 1, useNativeWorkers: false },
      });
      const renamed = await previewRenameWithSession(session, {
        root,
        handle: `owner.rb:${line}:${column}`,
        newName: "touched",
      });
      expect(renamed.safe).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit calls apart from method and block parameters and generated-reader locals", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-explicit-method-"));
    const file = path.join(root, "explicit.rb");
    const lines = [
      "def total(value = 42); value; end",
      "def read(total)",
      "  [total, total(), total(7)]",
      "end",
      "def block_read",
      "  [3].map { |total| [total, total(), total(8)] }",
      "end",
      "def operands(total, other)",
      "  [total -other, total &other, total [other]]",
      "end",
      "class Reader",
      "  attr_reader :amount",
      "  def initialize; @amount = 43; end",
      "  def read(amount)",
      "    [amount, amount(), self.amount]",
      "  end",
      "  def local",
      "    amount = 3",
      "    [amount, amount(), self.amount]",
      "  end",
      "end",
      "",
    ];
    const site = (line: number, name: string, occurrence = 0) => {
      let offset = -1;
      for (let seen = 0; seen <= occurrence; seen += 1) offset = lines[line - 1]!.indexOf(name, offset + 1);
      if (offset < 0) throw new Error(`Missing ${name} on line ${line}`);
      return { file, line, column: offset + 1 };
    };
    try {
      await fsp.writeFile(file, lines.join("\n"));
      const options = { cache: "off" as const, threads: 1, useNativeWorkers: false };
      const index = await buildProjectIndex(root, options);
      for (const [line, name, occurrence, target] of [
        [3, "total", 0, 2],
        [3, "total", 1, 1],
        [3, "total", 2, 1],
        [6, "total", 1, 6],
        [6, "total", 2, 1],
        [6, "total", 3, 1],
        [9, "total", 0, 8],
        [9, "total", 1, 8],
        [9, "total", 2, 8],
        [15, "amount", 0, 14],
        [15, "amount", 1, 12],
        [15, "amount", 2, 12],
        [19, "amount", 0, 18],
        [19, "amount", 1, 12],
        [19, "amount", 2, 12],
      ] as const) {
        const found = await goToDefinition(index, site(line, name, occurrence));
        expect(found.status, `${line}:${name}#${occurrence}`).toBe("ok");
        if (found.status !== "ok") throw new Error(`Missing method namespace target at ${line}`);
        expect(found.definition.range.start.line).toBe(target);
      }
      for (const [line, name, expected] of [
        [1, "total", [1, 3, 3, 6, 6]],
        [2, "total", [2, 3]],
        [6, "total", [6, 6]],
        [8, "total", [8, 9, 9, 9]],
        [12, "amount", [12, 15, 15, 19, 19]],
        [14, "amount", [14, 15]],
        [18, "amount", [18, 19]],
      ] as const) {
        const refs = await findReferences(index, site(line, name));
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") throw new Error(`Missing references at ${line}`);
        expect(refs.referenceCoverage.state).toBe("complete");
        expect(refs.references.map((ref) => ref.range.start.line).sort((a, b) => a - b)).toEqual(expected);
      }
      const graph = await buildSymbolGraphDetailed(index);
      for (const callerName of ["read", "block_read", "local"]) {
        for (const caller of [...graph.nodes.values()].filter((node) => node.name === callerName)) {
          const calls = graph.edges.filter((edge) => edge.from === caller.id && edge.label === "calls");
          expect(calls).toHaveLength(2);
          expect(calls.every((edge) => graph.nodes.get(edge.to)?.kind === "function")).toBe(true);
        }
      }
      const operands = [...graph.nodes.values()].find((node) => node.name === "operands");
      expect(graph.edges.filter((edge) => edge.from === operands?.id && edge.label === "calls")).toEqual([]);
      const session = createAgentSession({ root, useConfig: false, buildOptions: options });
      const renamed = await previewRenameWithSession(session, {
        root,
        handle: "explicit.rb:1:5",
        newName: "sum",
      });
      expect(renamed.safe).toBe(true);
      expect(renamed.edits.map((edit) => edit.range.start.line).sort((a, b) => a - b)).toEqual([1, 3, 3, 6, 6]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("marks unresolved explicit self calls to top-level Object methods partial and unsafe", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-object-method-"));
    const file = path.join(root, "object.rb");
    try {
      await fsp.writeFile(file, "total = 1\ndef total; 42; end\nputs total\nputs self.total\n");
      const options = { cache: "off" as const, threads: 1, useNativeWorkers: false };
      const index = await buildProjectIndex(root, options);
      expect((await goToDefinition(index, { file, line: 4, column: 11 })).status).toBe("not_found");
      const refs = await findReferences(index, { file, line: 2, column: 5 });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error("Missing Object method references");
      expect(refs.references.map((ref) => ref.range.start.line)).toEqual([2]);
      expect(refs.referenceCoverage.state).toBe("partial");
      expect(refs.referenceCoverage.affectedFiles?.map(fileIdentityKey)).toContain(fileIdentityKey(file));
      const session = createAgentSession({ root, useConfig: false, buildOptions: options });
      const preview = await previewRenameWithSession(session, { root, handle: "object.rb:2:5", newName: "sum" });
      expect(preview.safe).toBe(false);
      const local = await findReferences(index, { file, line: 1, column: 1 });
      expect(local.status).toBe("ok");
      if (local.status !== "ok") throw new Error("Missing local references");
      expect(local.references.map((ref) => ref.range.start.line)).toEqual([1, 3]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["singleton_method", "singleton_class"])(
    "never resolves a qualified %s call to a class-body local",
    async (form) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-singleton-local-"));
      const file = path.join(root, "singleton.rb");
      const body =
        form === "singleton_method"
          ? ["  total = 3", "  def self.total; 42; end", "  puts total", "  def self.read; self.total; end"]
          : ["  class << self", "    total = 3", "    def total; 42; end", "    puts total", "  end"];
      const lines = ["class Box", ...body, "end", "puts Box.total", ""];
      const declaration = form === "singleton_method" ? 2 : 3;
      try {
        await fsp.writeFile(file, lines.join("\n"));
        const options = { cache: "off" as const, threads: 1, useNativeWorkers: false };
        const index = await buildProjectIndex(root, options);
        const useLine = lines.length - 1;
        const selected = await goToDefinition(index, { file, line: useLine, column: 10 });
        expect(selected.status).toBe("not_found");
        const column = lines[declaration - 1]!.indexOf("total") + 1;
        const local = await findReferences(index, { file, line: declaration, column });
        expect(local.status).toBe("ok");
        if (local.status !== "ok") throw new Error("Missing class-body local");
        expect(local.referenceCoverage.state).toBe("complete");
        expect(local.references.map((ref) => ref.range.start.line)).toEqual([declaration, declaration + 2]);
        const methodLine = declaration + 1;
        const method = await findReferences(index, {
          file,
          line: methodLine,
          column: lines[methodLine - 1]!.indexOf("total") + 1,
        });
        expect(method.status).toBe("ok");
        if (method.status !== "ok") throw new Error("Missing singleton method");
        expect(method.referenceCoverage.state).toBe("partial");
        expect(method.references.some((ref) => ref.range.start.line === useLine)).toBe(false);
        const session = createAgentSession({ root, useConfig: false, buildOptions: options });
        const renamed = await previewRenameWithSession(session, {
          root,
          handle: `singleton.rb:${declaration}:${column}`,
          newName: "sum",
        });
        expect(renamed.safe).toBe(true);
        expect(renamed.edits.map((edit) => edit.range.start.line)).toEqual([declaration, declaration + 2]);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
  );
});

it("preserves an earlier singleton method's module-body references beside a later instance method", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-singleton-order-"));
  const file = path.join(root, "order.rb");
  const source = [
    "module Named",
    "  def self.prefixed(*names); puts names.first; end",
    "  prefixed :before",
    "  def prefixed(name); name; end",
    "end",
    "",
  ].join("\n");
  try {
    await fsp.writeFile(file, source);
    const options = { cache: "off" as const, threads: 1, useNativeWorkers: false };
    const index = await buildProjectIndex(root, options);
    const before = await goToDefinition(index, { file, line: 3, column: 3 });
    expect(before.status === "ok" && before.definition.range.start.line).toBe(2);
    const refs = await findReferences(index, { file, line: 2, column: 12 });
    expect(refs.status).toBe("ok");
    if (refs.status !== "ok") throw new Error("Missing singleton method references");
    expect(refs.references.map((ref) => ref.range.start.line)).toEqual([2, 3]);
    expect(refs.referenceCoverage.state).toBe("partial");
    const session = createAgentSession({ root, useConfig: false, buildOptions: options });
    const renamed = await previewRenameWithSession(session, { root, handle: "order.rb:2:12", newName: "renamed" });
    // A same-named static/instance pair keeps rename linkage conservative.
    expect(renamed.safe).toBe(false);
    expect(renamed.unsafeSites.some((site) => site.reason === "ambiguous_target")).toBe(true);
    expect(renamed.edits.map((edit) => edit.range.start.line)).toEqual([2, 3]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
