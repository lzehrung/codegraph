import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonMembers } from "../src/util/json-members.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { limitJsonParseLength } from "./helpers/string-limit.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  vi.restoreAllMocks();
  await roots.cleanup();
});

async function fileWith(text: string): Promise<string> {
  const root = await roots.create("cg-json-members-");
  const file = path.join(root, "doc.json");
  await fsp.writeFile(file, text, "utf8");
  return file;
}

const WANTED = [
  "format",
  "files",
  "fileEdges",
  "scalar",
  "text",
  "flag",
  "nothing",
  "emptyObject",
  "empty",
  "decoys",
  'key "with" escapes',
];

function documentWithEveryShape(): Record<string, unknown> {
  return {
    // The same names one level down must not be taken for the top-level members.
    decoys: { files: ["decoy"], fileEdges: ["decoy"], format: "decoy" },
    schemaVersion: 3,
    format: "codegraph.graph-json",
    skipped: { deep: [1, { x: ["]", "}", ",", '"'] }], more: "str" },
    files: ["a.ts", "b,c]}.ts", 'q"uote.ts', "back\\slash.ts", "é\u2028😀.ts", "", "\\\\", '\\"'],
    fileEdges: [
      { from: "a.ts", to: { type: "file", path: "b.ts" }, raw: "./b", list: [1, [2, 3], {}] },
      [],
      [[1], []],
      "s",
      4,
      null,
      true,
      -1.5e-7,
    ],
    empty: [],
    emptyObject: {},
    scalar: 42,
    text: "hello",
    flag: false,
    nothing: null,
    'key "with" escapes': [1],
  };
}

describe("readJsonMembers", () => {
  it.each([
    ["compact", (value: unknown) => JSON.stringify(value)],
    ["indented by two spaces", (value: unknown) => JSON.stringify(value, null, 2)],
    [
      "indented by tabs with CRLF line ends",
      (value: unknown) => JSON.stringify(value, null, "\t").replace(/\n/g, "\r\n"),
    ],
  ])(
    "reads every kind of member as JSON.parse does from a file that is %s, at every piece size",
    async (_name, format) => {
      const document = documentWithEveryShape();
      const file = await fileWith(format(document));
      const expected = Object.fromEntries(WANTED.map((name) => [name, document[name]]));

      // A piece of one byte splits every multi-byte character and every token across reads.
      for (const chunkBytes of [1, 3, 17, undefined]) {
        expect(Object.fromEntries(await readJsonMembers(file, WANTED, chunkBytes))).toEqual(expected);
      }
    },
  );

  it("parses nothing but the members it was asked for, one list element at a time", async () => {
    const records = Array.from({ length: 400 }, (_, index) => ({ id: index, label: `record ${index}` }));
    const text = JSON.stringify({ skipped: records, wanted: records, last: "end" }, null, 2);
    const file = await fileWith(text);
    const parse = limitJsonParseLength(200);

    try {
      // Neither the whole text nor the list is something one parse may take under this limit.
      expect(() => JSON.parse(text)).toThrow(RangeError);
      const members = await readJsonMembers(file, ["wanted"], 64);
      expect(members.get("wanted")).toEqual(records);
    } finally {
      parse.mockRestore();
    }
  });

  it("does not check the members it skips", async () => {
    const file = await fileWith('{"skipped": [1, not json, {"a": }], "kept": [1, 2]}');

    expect(Object.fromEntries(await readJsonMembers(file, ["kept"]))).toEqual({ kept: [1, 2] });
  });

  it("returns only the wanted members the object has", async () => {
    const file = await fileWith('{"a": 1}');

    expect(Object.fromEntries(await readJsonMembers(file, ["a", "b"]))).toEqual({ a: 1 });
  });

  it("stops at the last wanted member and leaves the rest of the file unread", async () => {
    // The text after the second member never ends, so only a read that stops early gets through it.
    const file = await fileWith(`{"a": 1, "b": [2, 3], "tail": "${"x".repeat(3_000_000)}`);

    expect(Object.fromEntries(await readJsonMembers(file, ["a", "b"]))).toEqual({ a: 1, b: [2, 3] });
    await expect(readJsonMembers(file, ["a", "missing"])).rejects.toThrow(SyntaxError);
  });

  it.each([
    ["an array at the top level", "[1, 2]"],
    ["text that is not JSON", "not json at all"],
    ["an empty file", ""],
    ["only whitespace", " \n "],
    ["an object that never closes", '{"a": [1, 2'],
    ["a value that never ends", '{"a": 1'],
    ["a wanted value that is not JSON", '{"a": nope}'],
    ["a wanted list element that is not JSON", '{"a": [1, nope]}'],
    ["a trailing comma in a wanted list", '{"a": [1,]}'],
    ["a blank first element in a wanted list", '{"a": [,1]}'],
  ])("throws a SyntaxError for %s", async (_name, text) => {
    const file = await fileWith(text);

    await expect(readJsonMembers(file, ["a"])).rejects.toThrow(SyntaxError);
  });

  it("rejects with the file error for a file that is not there", async () => {
    const root = await roots.create("cg-json-members-missing-");

    await expect(readJsonMembers(path.join(root, "missing.json"), ["a"])).rejects.toMatchObject({ code: "ENOENT" });
  });
});
