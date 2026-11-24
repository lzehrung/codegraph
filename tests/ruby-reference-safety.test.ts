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

it.each(["alias_method :calculate, :original", "alias calculate original", "alias :calculate :original"])(
  "excludes the destination of %s and retains its source",
  async (statement) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-alias-destination-"));
    const file = path.join(root, "fixture.rb");
    const source = `class Tools\n  def calculate; 11; end\n  def original; 22; end\n  ${statement}\nend\np Tools.instance_method(:calculate).bind(Tools.new).call\n`;
    try {
      await fsp.writeFile(file, source);
      const index = await buildProjectIndex(root, options);
      expect((await goToDefinition(index, site(file, source, 4, "calculate"))).status).toBe("not_found");
      const original = await goToDefinition(index, site(file, source, 4, "original"));
      expect(original.status === "ok" && original.definition.range.start.line).toBe(3);
      const replaced = await findReferences(index, site(file, source, 2, "calculate"));
      expect(replaced.status === "ok" && replaced.referenceCoverage.state).toBe("partial");
      expect(replaced.status === "ok" && replaced.references.some((ref) => ref.range.start.line === 4)).toBe(false);
      const refs = await findReferences(index, site(file, source, 3, "original"));
      expect(refs.status === "ok" && refs.references.map((ref) => ref.range.start.line)).toEqual([3, 4]);
      const session = createAgentSession({ root, useConfig: false, buildOptions: options });
      const unsafe = await previewRenameWithSession(session, {
        root,
        handle: `fixture.rb:2:${site(file, source, 2, "calculate").column}`,
        newName: "compute",
      });
      expect(unsafe.safe).toBe(false);
      expect(unsafe.edits.some((edit) => edit.range.start.line === 4)).toBe(false);
      const safe = await previewRenameWithSession(session, {
        root,
        handle: `fixture.rb:3:${site(file, source, 3, "original").column}`,
        newName: "initial",
      });
      expect(safe.safe).toBe(true);
      expect(safe.edits.map((edit) => edit.range.start.line)).toEqual([3, 4]);
      const graph = await buildSymbolGraphDetailed(index);
      expect(graph.edges.some((edge) => edge.label === "calls" && edge.site?.range.start.line === 4)).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  "private_class_method :calculate",
  "public_class_method :calculate",
  "private_class_method(*%i[calculate])",
  "public_class_method(*%i[calculate])",
  "private_class_method(*[:calculate])",
  "public_class_method(*[:calculate])",
])("keeps module singleton coverage partial for %s", async (visibility) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-module-singleton-"));
  const file = path.join(root, "fixture.rb");
  const source = `module Tools\n  def self.calculate; 42; end\n  ${visibility}\n  def self.run; calculate; end\nend\np Tools.run\n`;
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    const answer = await goToDefinition(index, site(file, source, 3, "calculate"));
    if (visibility.includes("*")) expect(answer.status).toBe("not_found");
    else expect(answer.status === "ok" && answer.definition.range.start.line).toBe(2);
    const refs = await findReferences(index, site(file, source, 2, "calculate"));
    expect(refs.status === "ok" && refs.referenceCoverage.state).toBe("partial");
    expect(refs.status === "ok" && refs.references.map((ref) => ref.range.start.line)).toEqual([2, 4]);
    const preview = await previewRenameWithSession(
      createAgentSession({ root, useConfig: false, buildOptions: options }),
      {
        root,
        handle: `fixture.rb:2:${site(file, source, 2, "calculate").column}`,
        newName: "compute",
      },
    );
    expect(preview.safe).toBe(false);
    expect(preview.edits.map((edit) => edit.range.start.line)).toEqual([2, 4]);
    const graph = await buildSymbolGraphDetailed(index);
    expect(
      graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "calculate")
        .map((edge) => edge.site?.range.start.line),
    ).toEqual([4]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it.each([
  { statement: "private(*%i[calculate])", invocation: "calculate" },
  { statement: "private(*[:calculate])", invocation: "calculate" },
  { statement: "alias_method(*%i[copy calculate])", invocation: "copy" },
  { statement: "public :calculate", invocation: "self.send(*%i[calculate])", dynamic: true },
])("retains uncertainty for compound method names in $statement / $invocation", async (form) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-compound-symbol-"));
  const file = path.join(root, "fixture.rb");
  const source = `class Tools\n  def calculate; 42; end\n  ${form.statement}\n  def run; ${form.invocation}; end\nend\np Tools.new.run\n`;
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    const line = form.dynamic ? 4 : 3;
    expect((await goToDefinition(index, site(file, source, line, "calculate"))).status).toBe("not_found");
    const refs = await findReferences(index, site(file, source, 2, "calculate"));
    expect(refs.status === "ok" && refs.referenceCoverage.state).toBe("partial");
    expect(refs.status === "ok" && refs.references.some((ref) => ref.range.start.line === line)).toBe(false);
    const preview = await previewRenameWithSession(
      createAgentSession({ root, useConfig: false, buildOptions: options }),
      {
        root,
        handle: `fixture.rb:2:${site(file, source, 2, "calculate").column}`,
        newName: "compute",
      },
    );
    expect(preview.safe).toBe(false);
    const graph = await buildSymbolGraphDetailed(index);
    expect(graph.edges.some((edge) => edge.label === "calls" && edge.site?.range.start.line === line)).toBe(false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it.each([
  { value: "10", read: "total -1", assignment: "total = 20" },
  { value: "[10, 11]", read: "total [1]", assignment: "total = [20, 21]" },
  { value: "10", read: "total -1", assignment: "[20].each { |n| total = n }" },
])("keeps separate reassignment families unsafe for $read / $assignment", async (form) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-reassigned-local-"));
  const file = path.join(root, "fixture.rb");
  const source = `class Tools\n  def total; 90; end\n  def run\n    total = ${form.value}\n    compute = proc { ${form.read} }\n    ${form.assignment}\n    [compute.call, total(), self.total]\n  end\nend\np Tools.new.run\n`;
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    const answer = await goToDefinition(index, site(file, source, 5, "total"));
    expect(answer.status === "ok" && answer.definition.range.start.line).toBe(4);
    for (const line of [4, 6]) {
      const refs = await findReferences(index, site(file, source, line, "total"));
      expect(refs.status === "ok" && refs.referenceCoverage.state).toBe("partial");
      const preview = await previewRenameWithSession(
        createAgentSession({ root, useConfig: false, buildOptions: options }),
        {
          root,
          handle: `fixture.rb:${line}:${site(file, source, line, "total").column}`,
          newName: "level",
        },
      );
      expect(preview.safe).toBe(false);
    }
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

it("does not confuse block parameters or sibling block locals with captured reassignments", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-local-families-"));
  const file = path.join(root, "fixture.rb");
  const source =
    "total = 10\nfirst = [1].map { |total| total -1 }\nsecond = [2].map { |total| total -1 }\nthird = [3].map { local = 1; local -1 }\nfourth = [4].map { local = 2; local -1 }\np [total, first, second, third, fourth]\n";
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    for (const [line, token] of [
      [1, "total"],
      [2, "total"],
      [3, "total"],
      [4, "local"],
      [5, "local"],
    ] as const) {
      const answer = await goToDefinition(index, site(file, source, line, token));
      expect(answer.status === "ok" && answer.definition.localName).toBe(token);
      const refs = await findReferences(index, site(file, source, line, token));
      expect(refs.status === "ok" && refs.referenceCoverage.state).toBe("complete");
      const preview = previewRenameWithSession(createAgentSession({ root, useConfig: false, buildOptions: options }), {
        root,
        handle: `fixture.rb:${line}:${site(file, source, line, token).column}`,
        newName: "level",
      });
      if (line === 2 || line === 3) await expect(preview).rejects.toThrow("Symbol target");
      else expect((await preview).safe).toBe(true);
    }
    const graph = await buildSymbolGraphDetailed(index);
    expect(graph.edges.filter((edge) => edge.label === "calls")).toEqual([]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("keeps attribute reference scans independent of the number of sibling method-name candidates", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-attribute-candidates-"));
  const file = path.join(root, "fixture.rb");
  const attributes = Array.from({ length: 80 }, (_, index) => `:a${index}`).join(", ");
  const source = `class Tools\n  attr_reader ${attributes}\n  def target; 42; end\n  def run; target; end\nend\np Tools.new.run\n`;
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    const refs = await findReferences(index, site(file, source, 3, "target"));
    expect(refs.status === "ok" && refs.referenceCoverage.state).toBe("complete");
    expect(refs.status === "ok" && refs.references.map((ref) => ref.range.start.line)).toEqual([3, 4]);
    const preview = await previewRenameWithSession(
      createAgentSession({ root, useConfig: false, buildOptions: options }),
      {
        root,
        handle: `fixture.rb:3:${site(file, source, 3, "target").column}`,
        newName: "compute",
      },
    );
    expect(preview.safe).toBe(true);
    expect(preview.edits.map((edit) => edit.range.start.line)).toEqual([3, 4]);
    const graph = await buildSymbolGraphDetailed(index);
    expect(
      graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "target")
        .map((edge) => edge.site?.range.start.line),
    ).toEqual([4]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
