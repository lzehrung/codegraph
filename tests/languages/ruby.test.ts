import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../../src/index.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { collectDetailedDeclarations } from "../../src/graphs/symbol-graph-detailed/ast.js";
import { collectImportsForFile, collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";
import { exportedNameOf } from "../helpers/narrow.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { getNativeQueryExecution } from "../../src/native/tree-sitter-native.js";

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
