import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonFileInChunks, writeJsonInChunks } from "../src/util/json-chunks.js";
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
});
