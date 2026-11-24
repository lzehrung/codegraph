import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { expect, it } from "vitest";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../src/index.js";
import { createAgentSession } from "../src/agent/session.js";
import { previewRenameWithSession } from "../src/agent/rename-preview.js";

const options = { cache: "off" as const, threads: 1, useNativeWorkers: false };
const namingForms = [
  { statement: "module_function :calculate", owner: "module", singleton: false, invocation: "Tools.calculate" },
  ...["private", "protected", "public"].map((visibility) => ({
    statement: `${visibility} :calculate`,
    owner: "class",
    singleton: false,
    invocation: "Tools.new.run",
  })),
  { statement: "private_class_method :calculate", owner: "class", singleton: true, invocation: "Tools.run" },
  { statement: "alias_method :copy, :calculate", owner: "class", singleton: false, invocation: "Tools.new.run" },
  { statement: "alias copy calculate", owner: "class", singleton: false, invocation: "Tools.new.run" },
  { statement: "alias :copy :calculate", owner: "class", singleton: false, invocation: "Tools.new.run" },
  { statement: "define_method(:calculate) { 84 }", owner: "class", singleton: false, invocation: "Tools.new.run" },
];

it.each(namingForms)("includes $statement in method navigation and rename", async (form) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-method-symbol-"));
  const file = path.join(root, "fixture.rb");
  const qualifier = form.singleton ? "self." : "";
  const lines = [
    `${form.owner} Tools`,
    `  def ${qualifier}calculate; 42; end`,
    `  ${form.statement}`,
    `  def ${qualifier}run; calculate; end`,
    "end",
    "class Decoy",
    "  def calculate; -1; end",
    "end",
    `p ${form.invocation}`,
    "",
  ];
  const source = lines.join("\n");
  const site = (line: number) => ({ file, line, column: lines[line - 1]!.indexOf("calculate") + 1 });
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    const answer = await goToDefinition(index, site(3));
    expect(answer.status).toBe("ok");
    if (answer.status !== "ok") throw new Error("Missing method-name reference");
    expect(answer.definition.range.start.line).toBe(2);
    const refs = await findReferences(index, site(2));
    expect(refs.status).toBe("ok");
    if (refs.status !== "ok") throw new Error("Missing method references");
    expect(refs.referenceCoverage.state).toBe("complete");
    expect(refs.references.map((ref) => ref.range.start.line)).toContain(3);
    expect(refs.references.some((ref) => ref.range.start.line === 7)).toBe(false);
    const named = refs.references.find((ref) => ref.range.start.line === 3)!;
    expect(source.slice(named.range.start.index, named.range.end.index)).toBe("calculate");
    const graph = await buildSymbolGraphDetailed(index);
    expect(graph.edges.some((edge) => edge.label === "calls" && edge.site?.range.start.line === 3)).toBe(false);
    const session = createAgentSession({ root, useConfig: false, buildOptions: options });
    const preview = await previewRenameWithSession(session, {
      root,
      handle: `fixture.rb:2:${site(2).column}`,
      newName: "compute",
    });
    expect(preview.safe).toBe(true);
    expect(preview.edits.some((edit) => edit.range.start.line === 3 && edit.oldText === "calculate")).toBe(true);
    expect(preview.edits.every((edit) => edit.oldText === "calculate")).toBe(true);
    let renamed = source;
    for (const edit of [...preview.edits].sort((a, b) => b.range.start.index! - a.range.start.index!)) {
      renamed = renamed.slice(0, edit.range.start.index) + edit.newText + renamed.slice(edit.range.end.index);
    }
    expect(renamed).toContain(form.statement.replace("calculate", "compute"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it.each([
  "send(:calculate)",
  "public_send(:calculate)",
  "respond_to?(:calculate)",
  "method(:calculate)",
  'send("calculate")',
  'send(:"calculate#{suffix}")',
  'send(:"#{:calculate}")',
  'private "calculate"',
  'alias :"copy" :"calculate"',
  "other.send(:calculate)",
  "other.method(:calculate)",
])("retains partial coverage for %s without editing unproven names", async (expression) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-dynamic-method-"));
  const file = path.join(root, "fixture.rb");
  const source = ["class Tools", "  def calculate; 42; end", "  def unrelated; 7; end", "end", expression, ""].join(
    "\n",
  );
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    const refs = await findReferences(index, { file, line: 2, column: 7 });
    expect(refs.status).toBe("ok");
    if (refs.status !== "ok") throw new Error("Missing dynamic-name coverage");
    expect(refs.referenceCoverage.state).toBe("partial");
    expect(refs.references.map((ref) => ref.range.start.line)).toEqual([2]);
    const unrelated = await findReferences(index, { file, line: 3, column: 7 });
    expect(unrelated.status === "ok" && unrelated.referenceCoverage.state).toBe("complete");
    const session = createAgentSession({ root, useConfig: false, buildOptions: options });
    const preview = await previewRenameWithSession(session, {
      root,
      handle: "fixture.rb:2:7",
      newName: "compute",
    });
    expect(preview.safe).toBe(false);
    expect(preview.edits.some((edit) => edit.range.start.line === 5)).toBe(false);
    const graph = await buildSymbolGraphDetailed(index);
    expect(graph.edges.some((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "calculate")).toBe(
      false,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("includes an attr_reader name later replaced by an explicit method", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-replaced-reader-"));
  const file = path.join(root, "fixture.rb");
  try {
    await fsp.writeFile(
      file,
      "class Tools\n  attr_reader :calculate\n  def calculate; 42; end\n  def run; calculate; end\nend\np Tools.new.run\n",
    );
    const index = await buildProjectIndex(root, options);
    const answer = await goToDefinition(index, { file, line: 2, column: 16 });
    expect(answer.status === "ok" && answer.definition.range.start.line).toBe(3);
    const refs = await findReferences(index, { file, line: 3, column: 7 });
    expect(refs.status === "ok" && refs.references.map((ref) => ref.range.start.line)).toEqual([2, 3, 4]);
    const session = createAgentSession({ root, useConfig: false, buildOptions: options });
    const preview = await previewRenameWithSession(session, {
      root,
      handle: "fixture.rb:3:7",
      newName: "compute",
    });
    expect(preview.safe).toBe(true);
    expect(preview.edits.map((edit) => edit.range.start.line)).toEqual([2, 3, 4]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("keeps inherited naming statements partial without involving unrelated owners", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-inherited-symbol-"));
  const file = path.join(root, "fixture.rb");
  const source = [
    "class Base",
    "  def calculate; 42; end",
    "end",
    "class Child < Base",
    "  private :calculate",
    "end",
    "class Decoy",
    "  def calculate; -1; end",
    "end",
    "class Token; end",
    "def query(other); other.method(:Token); end",
    "",
  ].join("\n");
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    const inherited = await findReferences(index, { file, line: 2, column: 7 });
    expect(inherited.status === "ok" && inherited.referenceCoverage.state).toBe("partial");
    const unrelated = await findReferences(index, { file, line: 8, column: 7 });
    expect(unrelated.status === "ok" && unrelated.referenceCoverage.state).toBe("complete");
    const token = await findReferences(index, { file, line: 10, column: 7 });
    expect(token.status === "ok" && token.referenceCoverage.state).toBe("complete");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it.each(["alias copy calculate if true", "alias copy calculate unless false"])(
  "preserves a proven alias under a modifier: %s",
  async (statement) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-alias-modifier-"));
    const file = path.join(root, "fixture.rb");
    try {
      const source = `class Tools\n  def calculate; 42; end\n  ${statement}\nend\np Tools.new.copy\n`;
      await fsp.writeFile(file, source);
      const index = await buildProjectIndex(root, options);
      const answer = await goToDefinition(index, { file, line: 3, column: 14 });
      expect(answer.status === "ok" && answer.definition.range.start.line).toBe(2);
      const refs = await findReferences(index, { file, line: 2, column: 7 });
      expect(refs.status === "ok" && refs.references.map((ref) => ref.range.start.line)).toEqual([2, 3]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  },
);

it("preserves bare alias operands in a block-built owner", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-block-alias-"));
  const file = path.join(root, "fixture.rb");
  try {
    await fsp.writeFile(
      file,
      "Tools = Class.new do\n  def calculate; 42; end\n  alias copy calculate\nend\np Tools.new.copy\n",
    );
    const index = await buildProjectIndex(root, options);
    const answer = await goToDefinition(index, { file, line: 3, column: 14 });
    expect(answer.status === "ok" && answer.definition.range.start.line).toBe(2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("preserves generated writers and excludes literal values from graph import aliases", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-symbol-declarations-"));
  const file = path.join(root, "fixture.rb");
  try {
    await fsp.writeFile(path.join(root, "library.rb"), "module Library; end\n");
    await fsp.writeFile(
      file,
      'require_relative "library"\nclass Tools\n  attr_writer :calculate\n  def calculate; 42; end\n  def strings; ["Library", :Library]; end\nend\n',
    );
    const index = await buildProjectIndex(root, options);
    const answer = await goToDefinition(index, { file, line: 3, column: 15 });
    expect(answer.status === "ok" && answer.definition.localName).toBe("calculate=");
    const graph = await buildSymbolGraphDetailed(index);
    expect(graph.edges.some((edge) => edge.label === "uses" && graph.nodes.get(edge.to)?.name === "Library")).toBe(
      false,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("includes aliases of generated readers without conflating reader/writer pairs", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-generated-alias-"));
  const file = path.join(root, "fixture.rb");
  try {
    await fsp.writeFile(
      file,
      "class Tools\n  attr_reader :calculate\n  alias copy calculate\n  attr_accessor :paired\n  alias paired_copy paired\nend\n",
    );
    const index = await buildProjectIndex(root, options);
    const reader = await goToDefinition(index, { file, line: 3, column: 14 });
    expect(reader.status === "ok" && reader.definition.range.start.line).toBe(2);
    const refs = await findReferences(index, { file, line: 2, column: 15 });
    expect(refs.status === "ok" && refs.references.map((ref) => ref.range.start.line)).toEqual([2, 3]);
    const paired = await goToDefinition(index, { file, line: 5, column: 21 });
    expect(paired.status).toBe("not_found");
    const pairRefs = await findReferences(index, { file, line: 4, column: 17 });
    expect(pairRefs.status === "ok" && pairRefs.referenceCoverage.state).toBe("partial");
    expect(pairRefs.status === "ok" && pairRefs.references.map((ref) => ref.range.start.line)).toEqual([4]);
    const session = createAgentSession({ root, useConfig: false, buildOptions: options });
    const preview = await previewRenameWithSession(session, {
      root,
      handle: "fixture.rb:2:15",
      newName: "compute",
    });
    expect(preview.safe).toBe(false);
    expect(preview.edits.some((edit) => edit.range.start.line === 3 && edit.oldText === "calculate")).toBe(true);
    const graph = await buildSymbolGraphDetailed(index);
    expect(graph.edges.some((edge) => edge.label === "calls")).toBe(false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("keeps quoted generated declarations out of unrelated method-name uncertainty", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-quoted-reader-"));
  const file = path.join(root, "fixture.rb");
  try {
    await fsp.writeFile(file, 'class Tools\n  attr_reader "unit"\nend\nclass Decoy\n  attr_reader "unit"\nend\n');
    const index = await buildProjectIndex(root, options);
    const target = [...index.byFile.values()]
      .flatMap((mod) => mod.locals)
      .find((local) => local.localName === "unit" && local.range.start.line === 2);
    if (!target) throw new Error("Missing quoted reader declaration");
    const refs = await findReferences(index, { def: target });
    expect(refs.status === "ok" && refs.referenceCoverage.state).toBe("complete");
    expect(refs.status === "ok" && refs.references.map((ref) => ref.range.start.line)).toEqual([2]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it.each([
  {
    source:
      "class Base\n  def self.calculate; 42; end\nend\nclass Child < Base\n  class << self\n    alias copy calculate\n    def calculate; 84; end\n  end\nend\n",
    useLine: 6,
    useColumn: 16,
    definitionLine: 7,
  },
  {
    source: "class Tools\n  def self.calculate; 42; end\n  def read; 84; end\n  alias calculate read\nend\n",
    useLine: 4,
    useColumn: 9,
    definitionLine: 2,
  },
])("excludes alias tokens from an incompatible declaration at $definitionLine", async (fixture) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-alias-namespace-"));
  const file = path.join(root, "fixture.rb");
  try {
    await fsp.writeFile(file, fixture.source);
    const index = await buildProjectIndex(root, options);
    const answer = await goToDefinition(index, {
      file,
      line: fixture.useLine,
      column: fixture.useColumn,
    });
    expect(answer.status).toBe("not_found");
    const column = fixture.source.split("\n")[fixture.definitionLine - 1]!.indexOf("calculate") + 1;
    const refs = await findReferences(index, { file, line: fixture.definitionLine, column });
    expect(refs.status === "ok" && refs.references.map((ref) => ref.range.start.line)).toEqual([
      fixture.definitionLine,
    ]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("keeps wrapped method-naming literals out of unrelated owners' coverage", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-wrapped-symbol-"));
  const file = path.join(root, "fixture.rb");
  try {
    await fsp.writeFile(
      file,
      "class Vault\n  def self.memoize(value); value; end\n  memoize attr_reader :calculate\nend\nclass Rival\n  def calculate; 42; end\n  def run; calculate; end\nend\np Rival.new.run\n",
    );
    const index = await buildProjectIndex(root, options);
    const refs = await findReferences(index, { file, line: 6, column: 7 });
    expect(refs.status === "ok" && refs.referenceCoverage.state).toBe("complete");
    expect(refs.status === "ok" && refs.references.map((ref) => ref.range.start.line)).toEqual([6, 7]);
    const session = createAgentSession({ root, useConfig: false, buildOptions: options });
    const preview = await previewRenameWithSession(session, {
      root,
      handle: "fixture.rb:6:7",
      newName: "compute",
    });
    expect(preview.safe).toBe(true);
    expect(preview.edits.map((edit) => edit.range.start.line)).toEqual([6, 7]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("retains uncertainty when a method-naming call is inside an unknown-self block", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-block-symbol-"));
  const file = path.join(root, "fixture.rb");
  try {
    await fsp.writeFile(
      file,
      "class Receiver\n  def calculate; 42; end\nend\nclass Builder\n  def self.configure(&block); Receiver.class_eval(&block); end\n  configure do\n    public :calculate\n  end\nend\np Receiver.new.calculate\n",
    );
    const index = await buildProjectIndex(root, options);
    const refs = await findReferences(index, { file, line: 2, column: 7 });
    expect(refs.status === "ok" && refs.referenceCoverage.state).toBe("partial");
    const session = createAgentSession({ root, useConfig: false, buildOptions: options });
    const preview = await previewRenameWithSession(session, {
      root,
      handle: "fixture.rb:2:7",
      newName: "compute",
    });
    expect(preview.safe).toBe(false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
