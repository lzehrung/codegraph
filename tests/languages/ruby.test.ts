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
    "v w later name count err ay dy z mode target label full? drain! full drain other k lv ev mv limit total item ax level kind reserve cap slot note reading pulse emit top_total cx mx area fill describe stamp entries notes stoke kindle beam gel around c0 c1 verify sap leaf drink wrap breeze frost make".split(
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
