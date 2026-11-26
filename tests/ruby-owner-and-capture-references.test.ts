import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { expect, it } from "vitest";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../src/index.js";
import { createAgentSession } from "../src/agent/session.js";
import { previewRenameWithSession } from "../src/agent/rename-preview.js";

const options = { cache: "off" as const, threads: 1, useNativeWorkers: false };

function site(file: string, source: string, line: number, token: string) {
  return { file, line, column: source.split("\n")[line - 1]!.indexOf(token) + 1 };
}

it("keeps another constant's constructor out of module singleton references", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-singleton-owner-"));
  const file = path.join(root, "fixture.rb");
  const source = [
    "module Tools",
    "  def self.new(*args); :module_result; end",
    "  def self.build",
    "    own = self.new",
    "    qualified = Tools.new",
    "    other = DontCall.new(7)",
    "    [own, qualified, other.value]",
    "  end",
    "  class DontCall < BasicObject",
    "    def initialize(value); @value = value; end",
    "    def value; @value; end",
    "  end",
    "end",
    "p Tools.build",
  ].join("\n");
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    for (const line of [4, 5]) {
      const answer = await goToDefinition(index, site(file, source, line, "new"));
      expect(answer.status === "ok" && answer.definition.range.start.line).toBe(2);
    }
    const receiver = await goToDefinition(index, site(file, source, 6, "DontCall"));
    expect(receiver.status === "ok" && receiver.definition.range.start.line).toBe(9);
    const refs = await findReferences(index, site(file, source, 2, "new"));
    expect(refs.status === "ok" && refs.referenceCoverage.state).toBe("partial");
    // `self.new` and `Tools.new` name the module's own `new`; `DontCall.new` does not.
    expect(refs.status === "ok" && refs.references.map((ref) => ref.range.start.line)).toEqual([2, 4, 5]);
    const preview = await previewRenameWithSession(
      createAgentSession({ root, useConfig: false, buildOptions: options }),
      {
        root,
        handle: `fixture.rb:2:${site(file, source, 2, "new").column}`,
        newName: "make",
      },
    );
    expect(preview.safe).toBe(false);
    expect(preview.edits.some((edit) => edit.range.start.line === 6)).toBe(false);
    const graph = await buildSymbolGraphDetailed(index);
    expect(graph.edges.some((edge) => edge.label === "calls" && edge.site?.range.start.line === 6)).toBe(false);
    expect(
      graph.edges.some(
        (edge) =>
          edge.label === "instantiates" &&
          edge.site?.range.start.line === 6 &&
          graph.nodes.get(edge.to)?.name === "DontCall",
      ),
    ).toBe(true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it.each([
  { capture: '/(?<total>[0-9]+)/ =~ "20"', partial: true },
  { capture: '[0].each { /(?<total>[0-9]+)/ =~ "20" }', partial: true },
  { capture: '[0].each { |total| /(?<total>[0-9]+)/ =~ "20" }', partial: false },
  { capture: '[0].each { |value; total| /(?<total>[0-9]+)/ =~ "20" }', partial: false },
  { capture: 'def other; /(?<total>[0-9]+)/ =~ "20"; end', partial: false },
  { capture: '/(?<different>[0-9]+)/ =~ "20"', partial: false },
])("keeps named-capture reassignment coverage local for $capture", async ({ capture, partial }) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-capture-family-"));
  const file = path.join(root, "fixture.rb");
  const source = `class Tools\n  def total; 90; end\n  def run\n    total = 10\n    compute = proc { total -1 rescue :bad }\n    ${capture}\n    [compute.call, total(), self.total]\n  end\nend\np Tools.new.run\n`;
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    const answer = await goToDefinition(index, site(file, source, 5, "total"));
    expect(answer.status === "ok" && answer.definition.range.start.line).toBe(4);
    const refs = await findReferences(index, site(file, source, 4, "total"));
    expect(refs.status === "ok" && refs.referenceCoverage.state).toBe(partial ? "partial" : "complete");
    const preview = await previewRenameWithSession(
      createAgentSession({ root, useConfig: false, buildOptions: options }),
      {
        root,
        handle: `fixture.rb:4:${site(file, source, 4, "total").column}`,
        newName: "level",
      },
    );
    expect(preview.safe).toBe(!partial);
    expect(preview.edits.some((edit) => edit.range.start.line === 6)).toBe(false);
    const method = await findReferences(index, site(file, source, 2, "total"));
    expect(method.status === "ok" && method.referenceCoverage.state).toBe("complete");
    const graph = await buildSymbolGraphDetailed(index);
    expect(
      graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "total")
        .map((edge) => edge.site?.range.start.line),
    ).toEqual([7, 7]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it.each([
  { declarations: ["def self.calculate; 11; end", "def calculate; 22; end"], definition: 2 },
  { declarations: ["def calculate; 22; end", "def self.calculate; 11; end"], definition: 3 },
  { declarations: ["class << self", "def calculate; 11; end", "end", "def calculate; 22; end"], definition: 3 },
  { declarations: ["def self.calculate; 11; end"], definition: 2 },
  { declarations: ["def calculate; 22; end"], definition: undefined },
])("keeps class-body calls in the singleton namespace", async ({ declarations, definition }) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-class-body-method-"));
  const file = path.join(root, "fixture.rb");
  const callLine = declarations.length + 2;
  const lines = ["class Tools", ...declarations, "begin; p calculate; rescue NameError; puts :missing; end", "end"];
  const source = lines.join("\n");
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    const answer = await goToDefinition(index, site(file, source, callLine, "calculate"));
    if (definition === undefined) {
      expect(answer.status).toBe("not_found");
    } else {
      expect(answer.status === "ok" && answer.definition.range.start.line).toBe(definition);
    }
    for (const [offset, declaration] of declarations.entries()) {
      if (!declaration.startsWith("def ")) continue;
      const line = offset + 2;
      const refs = await findReferences(index, site(file, source, line, "calculate"));
      expect(refs.status === "ok" && refs.references.some((ref) => ref.range.start.line === callLine)).toBe(
        line === definition,
      );
    }
    const target = definition ?? 2;
    const preview = await previewRenameWithSession(
      createAgentSession({ root, useConfig: false, buildOptions: options }),
      {
        root,
        handle: `fixture.rb:${target}:${site(file, source, target, "calculate").column}`,
        newName: "compute",
      },
    );
    expect(preview.edits.some((edit) => edit.range.start.line === callLine)).toBe(definition !== undefined);
    if (declarations.length === 1 && definition !== undefined) expect(preview.safe).toBe(true);
    const graph = await buildSymbolGraphDetailed(index);
    const calls = graph.edges.filter((edge) => edge.label === "calls" && edge.site?.range.start.line === callLine);
    for (const edge of calls) {
      expect(answer.status).toBe("ok");
      expect(edge.to.split("::").at(-1)).toBe(String(answer.status === "ok" && answer.definition.range.start.index));
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("keeps alias and undef operands in the instance-method namespace", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-body-method-operands-"));
  const file = path.join(root, "fixture.rb");
  const source =
    "class Tools\n  def calculate; 42; end\n  alias copy calculate\n  undef calculate\nend\np Tools.new.copy\n";
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    for (const line of [3, 4]) {
      const answer = await goToDefinition(index, site(file, source, line, "calculate"));
      expect(answer.status === "ok" && answer.definition.range.start.line).toBe(2);
    }
    const refs = await findReferences(index, site(file, source, 2, "calculate"));
    expect(refs.status === "ok" && refs.referenceCoverage.state).toBe("complete");
    expect(refs.status === "ok" && refs.references.map((ref) => ref.range.start.line)).toEqual([2, 3, 4]);
    const preview = await previewRenameWithSession(
      createAgentSession({ root, useConfig: false, buildOptions: options }),
      { root, handle: "fixture.rb:2:7", newName: "compute" },
    );
    expect(preview.safe).toBe(true);
    expect(preview.edits.map((edit) => edit.range.start.line)).toEqual([2, 3, 4]);
    const graph = await buildSymbolGraphDetailed(index);
    const operandCalls = graph.edges.filter(
      (edge) => edge.label === "calls" && [3, 4].includes(edge.site?.range.start.line ?? 0),
    );
    expect(operandCalls).toEqual([]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
