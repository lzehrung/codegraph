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

it("reads Ruby method defaults without declaring their expression identifiers as parameters", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-method-defaults-"));
  const file = path.join(root, "defaults.rb");
  // Ruby 3.3 prints 7,7,42; 8,8,42; 9,9; and 42 for this program.
  const lines = [
    "helper = 3",
    "def helper; 42; end",
    "def first(a, b = a, c = helper)",
    "  [a, b, c]",
    "end",
    "def keywords(a:, b: a, c: helper)",
    "  [a, b, c]",
    "end",
    "def parameter(helper, value = helper)",
    "  [helper, value]",
    "end",
    "def call(value = helper())",
    "  value",
    "end",
    'puts first(7).join(",")',
    'puts keywords(a: 8).join(",")',
    'puts parameter(9).join(",")',
    "puts call",
    "",
  ];
  const site = (line: number, name: string, occurrence = 0) => {
    let offset = -1;
    for (let count = 0; count <= occurrence; count += 1) offset = lines[line - 1]!.indexOf(name, offset + 1);
    if (offset < 0) throw new Error(`Missing ${name} on line ${line}`);
    return { file, line, column: offset + 1 };
  };
  try {
    await fsp.writeFile(file, lines.join("\n"));
    const options = { cache: "off" as const, threads: 1, useNativeWorkers: false };
    const index = await buildProjectIndex(root, options);
    for (const [use, declaration] of [
      [site(3, "a", 1), site(3, "a")],
      [site(3, "helper"), site(2, "helper")],
      [site(6, "a", 1), site(6, "a")],
      [site(6, "helper"), site(2, "helper")],
      [site(9, "helper", 1), site(9, "helper")],
      [site(12, "helper"), site(2, "helper")],
    ]) {
      const found = await goToDefinition(index, use!);
      expect(found.status, `${use!.line}:${use!.column}`).toBe("ok");
      if (found.status !== "ok") throw new Error("Missing default-value binding");
      expect([found.definition.range.start.line, found.definition.range.start.column]).toEqual([
        declaration!.line,
        declaration!.column,
      ]);
    }
    for (const [declaration, expected] of [
      [site(3, "a"), [site(3, "a"), site(3, "a", 1), site(4, "a")]],
      [site(6, "a"), [site(6, "a"), site(6, "a", 1), site(7, "a")]],
      [site(9, "helper"), [site(9, "helper"), site(9, "helper", 1), site(10, "helper")]],
      [site(2, "helper"), [site(2, "helper"), site(3, "helper"), site(6, "helper"), site(12, "helper")]],
    ] as const) {
      const refs = await findReferences(index, declaration);
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error("Missing default-value references");
      expect(refs.referenceCoverage.state).toBe("complete");
      expect(refs.references.map((ref) => [ref.range.start.line, ref.range.start.column])).toEqual(
        expected.map((position) => [position.line, position.column]),
      );
    }
    const graph = await buildSymbolGraphDetailed(index);
    const calls = graph.edges
      .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "helper")
      .map((edge) => [graph.nodes.get(edge.from)?.name, edge.site?.range.start.line]);
    expect(calls).toEqual([
      ["first", 3],
      ["keywords", 6],
      ["call", 12],
    ]);
    const session = createAgentSession({ root, useConfig: false, buildOptions: options });
    const renamed = await previewRenameWithSession(session, {
      root,
      handle: "defaults.rb:2:5",
      newName: "renamed_helper",
    });
    expect(renamed.safe).toBe(true);
    expect(renamed.edits.map((edit) => [edit.range.start.line, edit.range.start.column])).toEqual(
      [site(2, "helper"), site(3, "helper"), site(6, "helper"), site(12, "helper")].map((position) => [
        position.line,
        position.column,
      ]),
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it.each(["memory", "disk"] as const)(
  "keeps Ruby default-value bindings cold-equal through %s cache lifecycle changes",
  async (cache) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-default-cache-"));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ruby-default-cache-data-"));
    let file = path.join(root, "defaults.rb");
    const source = "def helper; 42; end\ndef first(a, b = a, c = helper); [a, b, c]; end\n";
    const options = { cache, cacheDir, threads: 1, useNativeWorkers: false };
    const describe = async (index: ProjectIndex): Promise<string[]> => {
      const answers: string[] = [];
      for (const mod of index.byFile.values()) {
        const lines = (await fsp.readFile(mod.file, "utf8")).split("\n");
        for (const [offset, line] of lines.entries()) {
          for (const token of line.matchAll(/\b(?:helper|first|a|b|c)\b/g)) {
            const use = { file: mod.file, line: offset + 1, column: token.index + 1 };
            const found = await goToDefinition(index, use);
            const refs = await findReferences(index, use);
            answers.push(
              JSON.stringify({
                use,
                target: found.status === "ok" ? found.definition : found,
                references: refs.status === "ok" ? refs.references : refs,
                coverage: refs.status === "ok" ? refs.referenceCoverage : undefined,
              }),
            );
          }
        }
      }
      const graph = await buildSymbolGraphDetailed(index);
      answers.push(...graph.edges.map((edge) => JSON.stringify(edge)));
      return answers.sort();
    };
    const answersAt = async (step: string): Promise<string[]> => {
      const warm = await describe(await buildProjectIndexIncremental(root, options));
      const reopened = await describe(await buildProjectIndex(root, options));
      const cold = await describe(await buildProjectIndex(root, { ...options, cache: "off" }));
      expect(warm, `${step}: incremental`).toEqual(cold);
      expect(reopened, `${step}: full`).toEqual(cold);
      if (cache === "disk") {
        closeDiskCacheDatabase(root, options);
        clearMemoryCache();
        expect(await describe(await buildProjectIndex(root, options)), `${step}: disk reload`).toEqual(cold);
      }
      return cold;
    };
    try {
      await fsp.writeFile(file, source);
      const baseline = await answersAt("initial");
      await answersAt("unchanged");
      await fsp.writeFile(file, source.replace("b = a", "b = helper"));
      await answersAt("default edited");
      await fsp.writeFile(file, source);
      expect(await answersAt("default restored")).toEqual(baseline);
      const moved = path.join(root, "moved.rb");
      await fsp.rename(file, moved);
      file = moved;
      await answersAt("file renamed");
      const original = path.join(root, "defaults.rb");
      await fsp.rename(file, original);
      file = original;
      expect(await answersAt("file renamed back")).toEqual(baseline);
      await fsp.rm(file);
      await answersAt("file deleted");
      await fsp.writeFile(file, source);
      expect(await answersAt("file restored")).toEqual(baseline);
    } finally {
      closeDiskCacheDatabase(root, options);
      clearMemoryCache();
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  },
);
