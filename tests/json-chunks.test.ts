import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAsLines, writeJsonFileInChunks, writeJsonInChunks } from "../src/util/json-chunks.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { limitJsonStringLength } from "./helpers/string-limit.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  vi.restoreAllMocks();
  await roots.cleanup();
});

async function chunksOf(value: unknown, chunkChars?: number): Promise<string[]> {
  const chunks: string[] = [];
  await writeJsonInChunks(value, (chunk) => void chunks.push(chunk), chunkChars);
  return chunks;
}

function graphDocument(edgeCount: number): Record<string, unknown> {
  return {
    schemaVersion: 3,
    format: "codegraph.graph-json",
    files: Array.from({ length: edgeCount }, (_, index) => `src/file-${index}.ts`),
    fileEdges: Array.from({ length: edgeCount }, (_, index) => ({
      from: `src/file-${index}.ts`,
      to: { type: "file", path: `src/file-${(index + 1) % edgeCount}.ts` },
      raw: "./next",
      typeOnly: index % 2 === 0,
    })),
    symbols: [],
    symbolEdges: [],
  };
}

describe("writeJsonInChunks", () => {
  const shapes: Array<[string, unknown]> = [
    ["a graph document", graphDocument(40)],
    ["empty containers", { empty: [], nested: {}, list: [[], {}, [[]]] }],
    [
      "members with no JSON form",
      { kept: 1, dropped: undefined, callback: () => 1, [Symbol("s")]: 1, list: [undefined, () => 2, 3] },
    ],
    ["awkward strings", ["line\nbreak", 'quote"', "\u2028\u2029", "\ud83d\ude00", "\ud800 lone", "tab\t", ""]],
    ["numeric-like keys", { b: 1, 2: "two", a: 3, 1: "one" }],
    ["values with toJSON", { when: new Date(0), custom: { toJSON: () => ({ replaced: true }) }, list: [new Date(1)] }],
    [
      "nested past the walked levels",
      { a: { b: { c: { d: [1, { e: 2 }] } } }, list: [[1, [2, [3]]], { x: { y: { z: 1 } } }] },
    ],
    ["numbers and literals", { n: [0, -0, 1.5, 1e21, NaN, Infinity], t: true, f: false, z: null }],
    ["a bare scalar", 42],
    ["a bare string", "text"],
    ["a bare null", null],
    ["an empty array", []],
    ["an empty object", {}],
    [
      "sections holding lists",
      {
        files: ["a"],
        sqlArtifacts: {
          nodes: [{ id: 1 }, { id: 2 }],
          edges: [],
          facts: [{ text: "x\ny", at: { line: 1, spans: [1, 2] } }],
        },
        analysis: { mode: "semantic", counts: { a: 1 } },
      },
    ],
    ["lists in lists in sections", { a: { b: [[1, 2], [], [{ c: [3] }]], c: { d: [1] } } }],
    ["a list at the document root", [{ a: [1, 2] }, [[1], []], "s", null, 3, { b: { c: [1] } }]],
  ];

  it.each(shapes)("writes the text JSON.stringify gives for %s, at every piece size", async (_name, value) => {
    const expected = JSON.stringify(value, null, 2);
    for (const chunkChars of [1, 7, 64, undefined]) {
      expect((await chunksOf(value, chunkChars)).join("")).toBe(expected);
    }
  });

  it("keeps every piece near the piece size while the whole document is far larger", async () => {
    const document = graphDocument(3000);
    const whole = JSON.stringify(document, null, 2);

    const chunks = await chunksOf(document, 4096);

    expect(chunks.join("")).toBe(whole);
    expect(whole.length).toBeGreaterThan(300_000);
    // A piece ends at the first member that crosses the size, so it overshoots by at most one member.
    const longest = chunks.reduce((max, chunk) => Math.max(max, chunk.length), 0);
    expect(longest).toBeLessThan(4096 + 400);
  });

  it("completes where one string cannot hold the document", async () => {
    const document = graphDocument(3000);
    const whole = JSON.stringify(document, null, 2);
    limitJsonStringLength(20_000);

    expect(() => JSON.stringify(document, null, 2)).toThrow(RangeError);
    const chunks = await chunksOf(document, 4096);

    expect(chunks.join("")).toBe(whole);
  });

  it("waits for the sink to finish a piece before it hands over the next one", async () => {
    const document = graphDocument(50);
    const held: Array<{ chunk: string; release: () => void }> = [];
    const sink = (chunk: string): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      held.push({ chunk, release: resolve });
      return promise;
    };
    const settle = async (): Promise<void> => {
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    };

    const writing = writeJsonInChunks(document, sink, 512);
    await settle();
    expect(held).toHaveLength(1);

    held[0]!.release();
    await settle();
    expect(held).toHaveLength(2);

    let released = 1;
    while (released < held.length) {
      held[released]!.release();
      released += 1;
      await settle();
    }
    await writing;

    expect(held.map((entry) => entry.chunk).join("")).toBe(JSON.stringify(document, null, 2));
  });

  it("rejects a value that has no JSON form", async () => {
    await expect(chunksOf(undefined)).rejects.toThrow(TypeError);
    await expect(chunksOf({ big: 10n })).rejects.toThrow(TypeError);
  });

  it("chunks a list inside a section, as in graph --json --sql-artifacts", async () => {
    const records = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `sql:statement:${index}`,
        kind: "sql_statement",
        line: index,
      }));
    const document = {
      files: ["schema.sql"],
      sqlArtifacts: { nodes: records(400), edges: records(300), facts: records(200) },
      analysis: { mode: "semantic" },
    };
    const whole = JSON.stringify(document, null, 2);
    const limit = limitJsonStringLength(4_000);

    try {
      // Every record fits under the limit; no list of them does.
      expect(() => JSON.stringify(document.sqlArtifacts.nodes, null, 2)).toThrow(RangeError);
      const chunks = await chunksOf(document, 2048);
      expect(chunks.join("")).toBe(whole);
    } finally {
      limit.mockRestore();
    }
  });
});

describe("writeJsonAsLines", () => {
  const flushMicrotasks = async (): Promise<void> => {
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
  };

  it("hands over runs of whole lines that make the bytes of one line write of the whole text", async () => {
    const document = graphDocument(300);
    const lines: string[] = [];

    await writeJsonAsLines(document, (text) => void lines.push(text), 512);

    expect(lines.length).toBeGreaterThan(3);
    expect(lines.map((line) => `${line}\n`).join("")).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });

  it("hands a small document over in one run", async () => {
    const document = graphDocument(5);
    const lines: string[] = [];

    await writeJsonAsLines(document, (text) => void lines.push(text));

    expect(lines).toEqual([JSON.stringify(document, null, 2)]);
  });

  it("waits for each run to be taken before it builds the next", async () => {
    const document = graphDocument(300);
    const held: Array<{ text: string; release: () => void }> = [];
    const writeLine = (text: string): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      held.push({ text, release: resolve });
      return promise;
    };

    const writing = writeJsonAsLines(document, writeLine, 512);
    await flushMicrotasks();

    // One run waits to be taken and the next is not built until it is.
    let taken = 0;
    while (taken < held.length) {
      expect(held).toHaveLength(taken + 1);
      held[taken]!.release();
      taken += 1;
      await flushMicrotasks();
    }
    await writing;

    expect(held.length).toBeGreaterThan(3);
    expect(held.map((entry) => `${entry.text}\n`).join("")).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });
});

describe("writeJsonFileInChunks", () => {
  it("writes the same bytes as JSON.stringify plus a final newline", async () => {
    const root = await roots.create("cg-json-chunks-");
    const target = path.join(root, "graph.json");
    const document = graphDocument(500);

    await writeJsonFileInChunks(target, document);

    await expect(fsp.readFile(target, "utf8")).resolves.toBe(`${JSON.stringify(document, null, 2)}\n`);
  });

  it("writes a document larger than the string limit and leaves the error to the caller when a member cannot be written", async () => {
    const root = await roots.create("cg-json-chunks-limit-");
    const target = path.join(root, "graph.json");
    const document = graphDocument(2000);
    const whole = `${JSON.stringify(document, null, 2)}\n`;
    limitJsonStringLength(30_000);

    await writeJsonFileInChunks(target, document);
    await expect(fsp.readFile(target, "utf8")).resolves.toBe(whole);

    // A single member larger than the limit cannot be written by any piece size.
    limitJsonStringLength(40);
    await expect(writeJsonFileInChunks(target, document)).rejects.toThrow(/Invalid string length/);
  });

  it("keeps a previous file and leaves no temporary file when the document cannot be written", async () => {
    const root = await roots.create("cg-json-chunks-keep-");
    const target = path.join(root, "graph.json");
    await fsp.writeFile(target, "previous\n", "utf8");
    // Over a million characters go out before the member that fails, so a partial file exists when it does.
    const document = {
      files: Array.from({ length: 60_000 }, (_, index) => `src/file-${index}.ts`),
      tail: "x".repeat(6_000),
    };
    const limit = limitJsonStringLength(5_000);

    try {
      await expect(writeJsonFileInChunks(target, document)).rejects.toThrow(RangeError);
    } finally {
      limit.mockRestore();
    }

    await expect(fsp.readFile(target, "utf8")).resolves.toBe("previous\n");
    expect(await fsp.readdir(root)).toEqual(["graph.json"]);
  });
});
