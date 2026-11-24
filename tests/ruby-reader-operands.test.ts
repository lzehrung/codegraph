import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { expect, it } from "vitest";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../src/index.js";
import { createAgentSession } from "../src/agent/session.js";
import { previewRenameWithSession } from "../src/agent/rename-preview.js";

it.each([
  { expression: "total -1", binding: "10" },
  { expression: "total -x", binding: "10" },
  { expression: "total [1]", binding: "[10, 20]" },
])("keeps $expression out of generated-reader references and rename edits", async ({ expression, binding }) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-reader-operands-"));
  const file = path.join(root, "fixture.rb");
  // The uninitialized reader isolates call-namespace renames from implicit backing-field renames.
  // Ruby 3.3 returns 9, 8, or 20 for the operand; both reader calls return nil and total(1) raises ArgumentError.
  const lines = [
    "class Meter",
    "  attr_reader :total",
    "  def work(x = 2)",
    `    total = ${binding}`,
    `    operand = ${expression}`,
    "    arity = begin",
    "      total(1)",
    "    rescue ArgumentError",
    "      :arity",
    "    end",
    "    [operand, total(), self.total, arity]",
    "  end",
    "end",
    "p Meter.new.work",
    "",
  ];
  const source = lines.join("\n");
  const site = (line: number, token: string, occurrence = 0) => {
    let offset = -1;
    for (let count = 0; count <= occurrence; count += 1) offset = lines[line - 1]!.indexOf(token, offset + 1);
    if (offset < 0) throw new Error(`Missing ${token} on line ${line}`);
    return { file, line, column: offset + 1 };
  };
  const options = { cache: "off" as const, threads: 1, useNativeWorkers: false };
  const controls = [site(7, "total"), site(11, "total"), site(11, "total", 1)];
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    const operand = await goToDefinition(index, site(5, "total"));
    expect(operand.status === "ok" && operand.definition.range.start.line).toBe(4);
    for (const control of controls) {
      const answer = await goToDefinition(index, control);
      expect(answer.status).toBe("ok");
      if (answer.status !== "ok") throw new Error("Missing explicit reader call");
      expect(answer.definition.range.start.line).toBe(2);
      expect(answer.definition.kind).toBe("function");
    }
    const refs = await findReferences(index, site(2, ":total"));
    expect(refs.status).toBe("ok");
    if (refs.status !== "ok") throw new Error("Missing generated-reader references");
    expect(refs.referenceCoverage.state).toBe("complete");
    expect(refs.references.map((reference) => reference.range.start.line)).toEqual([2, 7, 11, 11]);
    const graph = await buildSymbolGraphDetailed(index);
    const calls = graph.edges.filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "total");
    expect(calls.map((edge) => edge.site?.range.start.line)).toEqual([7, 11, 11]);
    const session = createAgentSession({ root, useConfig: false, buildOptions: options });
    const preview = await previewRenameWithSession(session, {
      root,
      handle: `fixture.rb:2:${site(2, ":total").column}`,
      newName: "level",
    });
    expect(preview.safe).toBe(false);
    expect(preview.edits.map((edit) => edit.range.start.line)).toEqual([7, 11, 11]);
    const workRename = await previewRenameWithSession(session, {
      root,
      handle: `fixture.rb:3:${site(3, "work").column}`,
      newName: "calculate",
    });
    expect(workRename.safe).toBe(true);
    expect(workRename.edits.map((edit) => edit.range.start.line)).toEqual([3, 14]);
    let renamed = source;
    for (const edit of [...workRename.edits].sort(
      (left, right) => right.range.start.index! - left.range.start.index!,
    )) {
      renamed = renamed.slice(0, edit.range.start.index) + edit.newText + renamed.slice(edit.range.end.index);
    }
    await fsp.writeFile(file, renamed);
    const renamedIndex = await buildProjectIndex(root, options);
    const renamedOperand = await goToDefinition(renamedIndex, site(5, "total"));
    expect(renamedOperand.status === "ok" && renamedOperand.definition.range.start.line).toBe(4);
    for (const control of controls) {
      const answer = await goToDefinition(renamedIndex, control);
      expect(answer.status).toBe("ok");
      if (answer.status !== "ok") throw new Error("Missing renamed reader call");
      expect(answer.definition.localName).toBe("total");
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("preserves local bitmask targets while excluding operands from generated readers", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-local-bitmasks-"));
  const file = path.join(root, "decoder.rb");
  const lines = [
    "class Decoder",
    "  def decode(s)",
    "    c0 = s[0].ord",
    "    c1 = s[1].ord",
    "    c2 = s[2].ord",
    "    c3 = s[3].ord",
    "    ((c0&0x07)<<18) | ((c1&0x3f)<<12) | ((c2&0x3f)<<6) | (c3&0x3f)",
    "  end",
    "end",
    "",
  ];
  try {
    await fsp.writeFile(file, lines.join("\n"));
    const index = await buildProjectIndex(root, { cache: "off", threads: 1, useNativeWorkers: false });
    for (const [name, declarationLine] of [
      ["c0", 3],
      ["c1", 4],
      ["c2", 5],
      ["c3", 6],
    ] as const) {
      const answer = await goToDefinition(index, { file, line: 7, column: lines[6]!.indexOf(name) + 1 });
      expect(answer.status).toBe("ok");
      if (answer.status !== "ok") throw new Error(`Missing ${name} local target`);
      expect(answer.definition.kind).toBe("variable");
      expect(answer.definition.range.start.line).toBe(declarationLine);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
