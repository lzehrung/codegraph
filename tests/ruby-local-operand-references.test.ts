import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { expect, it } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  type ProjectIndex,
} from "../src/index.js";
import { createAgentSession } from "../src/agent/session.js";
import { previewRenameWithSession } from "../src/agent/rename-preview.js";
import { clearMemoryCache, closeDiskCacheDatabase } from "../src/indexer/build-cache.js";

const options = { cache: "off" as const, threads: 1, useNativeWorkers: false };
it.each([
  { expression: "total -1", binding: "10" },
  { expression: "total -x", binding: "10" },
  { expression: "total +x", binding: "10" },
  { expression: "total - 1", binding: "10" },
  { expression: "total &blk", binding: "10" },
  { expression: "total *args", binding: "10" },
  { expression: "total **args", binding: "10" },
  { expression: "total [1]", binding: "[10, 20]" },
  { expression: "total[1]", binding: "[10, 20]" },
])("renames $expression operands, not method calls", async ({ expression, binding }) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-local-operands-"));
  const file = path.join(root, "fixture.rb");
  const lines = [
    "class Meter",
    "  def total(*values); values.empty? ? 99 : 88; end",
    "  def work(x = 2, blk = 3, args = 2)",
    `    total = ${binding}`,
    `    operand = ${expression}`,
    "    [operand, total(), total(1), self.total]",
    "  end",
    "end",
    "p Meter.new.work",
    "",
  ];
  const source = lines.join("\n");
  const site = (line: number, token: string) => ({ file, line, column: lines[line - 1]!.indexOf(token) + 1 });
  try {
    await fsp.writeFile(file, source);
    const index = await buildProjectIndex(root, options);
    const answer = await goToDefinition(index, site(5, "total"));
    expect(answer.status).toBe("ok");
    if (answer.status !== "ok") throw new Error("Missing local operand");
    expect(answer.definition.kind).toBe("variable");
    expect(answer.definition.range.start.line).toBe(4);
    const refs = await findReferences(index, site(4, "total"));
    expect(refs.status).toBe("ok");
    if (refs.status !== "ok") throw new Error("Missing local references");
    expect(refs.referenceCoverage.state).toBe("complete");
    expect(refs.references.map((ref) => ref.range.start.line)).toEqual([4, 5]);
    const graph = await buildSymbolGraphDetailed(index);
    expect(
      graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "total")
        .map((edge) => edge.site?.range.start.line),
    ).toEqual([6, 6, 6]);
    const session = createAgentSession({ root, useConfig: false, buildOptions: options });
    const preview = await previewRenameWithSession(session, {
      root,
      handle: `fixture.rb:4:${site(4, "total").column}`,
      newName: "level",
    });
    expect(preview.safe).toBe(true);
    expect(preview.edits.map((edit) => edit.range.start.line)).toEqual([4, 5]);
    let renamed = source;
    for (const edit of [...preview.edits].sort((a, b) => b.range.start.index! - a.range.start.index!)) {
      renamed = renamed.slice(0, edit.range.start.index) + edit.newText + renamed.slice(edit.range.end.index);
    }
    await fsp.writeFile(file, renamed);
    const after = await buildProjectIndex(root, options);
    const resolved = await goToDefinition(after, site(5, "total"));
    expect(resolved.status === "ok" && resolved.definition.localName).toBe("level");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("keeps unmodeled lambda operand binders partial instead of renaming the outer local", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-shadowed-operands-"));
  const file = path.join(root, "fixture.rb");
  try {
    await fsp.writeFile(file, "total = 10\ncall = ->(total) { total -1 }\np [total, call.call(5)]\n");
    const index = await buildProjectIndex(root, options);
    const refs = await findReferences(index, { file, line: 1, column: 1 });
    expect(refs.status).toBe("ok");
    if (refs.status !== "ok") throw new Error("Missing shadowed local");
    expect(refs.referenceCoverage.state).toBe("partial");
    expect(refs.references.map((ref) => ref.range.start.line)).toEqual([1, 3]);
    const session = createAgentSession({ root, useConfig: false, buildOptions: options });
    const preview = await previewRenameWithSession(session, {
      root,
      handle: "fixture.rb:1:1",
      newName: "level",
    });
    expect(preview.safe).toBe(false);
    expect(preview.edits.some((edit) => edit.range.start.line === 2)).toBe(false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it.each(["memory", "disk"] as const)("keeps %s reference caches cold-equal", async (cache) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-reference-cache-"));
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-reference-cache-data-"));
  const file = path.join(root, "fixture.rb");
  const source =
    "module Tools\n  def calculate; 42; end\n  module_function :calculate\nend\ntotal = 10\np [Tools.calculate, total -1]\n";
  const cachedOptions = { ...options, cache, cacheDir };
  const describe = async (index: ProjectIndex): Promise<string[]> => {
    const result: string[] = [];
    for (const mod of index.byFile.values()) {
      const lines = (await fsp.readFile(mod.file, "utf8")).split("\n");
      for (const [offset, line] of lines.entries()) {
        for (const match of line.matchAll(/\b(?:calculate|total)\b/g)) {
          const site = { file: mod.file, line: offset + 1, column: match.index + 1 };
          result.push(
            JSON.stringify({
              site,
              goto: await goToDefinition(index, site),
              refs: await findReferences(index, site),
            }),
          );
        }
      }
    }
    const graph = await buildSymbolGraphDetailed(index);
    result.push(...graph.edges.map((edge) => JSON.stringify(edge)));
    return result.sort();
  };
  const compare = async (step: string): Promise<string[]> => {
    const warm = await describe(await buildProjectIndexIncremental(root, cachedOptions));
    const reopened = await describe(await buildProjectIndex(root, cachedOptions));
    const cold = await describe(await buildProjectIndex(root, options));
    expect(warm, `${step}: incremental`).toEqual(cold);
    expect(reopened, `${step}: rebuilt`).toEqual(cold);
    if (cache === "disk") {
      closeDiskCacheDatabase(root, cachedOptions);
      clearMemoryCache();
      expect(await describe(await buildProjectIndex(root, cachedOptions)), `${step}: reload`).toEqual(cold);
    }
    return cold;
  };
  try {
    await fsp.writeFile(file, source);
    const baseline = await compare("initial");
    await compare("unchanged");
    await fsp.writeFile(
      file,
      source.replace("module_function :calculate", "public :calculate").replace("total -1", "total -2"),
    );
    await compare("edited");
    await fsp.writeFile(file, source);
    expect(await compare("restored")).toEqual(baseline);
    const moved = path.join(root, "moved.rb");
    await fsp.rename(file, moved);
    await compare("renamed");
    await fsp.rename(moved, file);
    expect(await compare("renamed back")).toEqual(baseline);
    await fsp.rm(file);
    await compare("deleted");
    await fsp.writeFile(file, source);
    expect(await compare("recreated")).toEqual(baseline);
  } finally {
    closeDiskCacheDatabase(root, cachedOptions);
    clearMemoryCache();
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(cacheDir, { recursive: true, force: true });
  }
});

it.each(["total !x", "total ~x"])("keeps %s in the method namespace beside a local", async (expression) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-unary-call-"));
  const file = path.join(root, "fixture.rb");
  const lines = [
    "class Meter",
    "  def total(value); value; end",
    "  def work(x = 2)",
    "    total = 10",
    `    ${expression}`,
    "  end",
    "end",
    "p Meter.new.work",
    "",
  ];
  try {
    await fsp.writeFile(file, lines.join("\n"));
    const index = await buildProjectIndex(root, options);
    const answer = await goToDefinition(index, { file, line: 5, column: 5 });
    expect(answer.status === "ok" && answer.definition.range.start.line).toBe(2);
    const local = await findReferences(index, { file, line: 4, column: 5 });
    expect(local.status === "ok" && local.references.map((ref) => ref.range.start.line)).toEqual([4]);
    const graph = await buildSymbolGraphDetailed(index);
    expect(
      graph.edges.filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "total").length,
    ).toBe(1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("excludes unbound and other-method operand names from a local's coverage", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-operand-scope-"));
  const file = path.join(root, "fixture.rb");
  try {
    await fsp.writeFile(
      file,
      "def first\n  total -1\n  total = 10\n  total -1\nend\ndef second\n  ->(total) { total -1 }\nend\n",
    );
    const index = await buildProjectIndex(root, options);
    const refs = await findReferences(index, { file, line: 3, column: 3 });
    expect(refs.status === "ok" && refs.referenceCoverage.state).toBe("complete");
    expect(refs.status === "ok" && refs.references.map((ref) => ref.range.start.line)).toEqual([3, 4]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
