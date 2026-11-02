import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectImportsForFile } from "../src/index.js";
import { collectModuleSpecifiersFromSource } from "../src/graphs.js";
import { supportById } from "../src/languages.js";
import { utf8ByteOffsetToStringIndex } from "../src/util/rust-test-modules.js";

/** The conversion this module used before it kept tables: count UTF-8 bytes per code point from the start. */
function scanToStringIndex(source: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytesSeen = 0;
  for (let index = 0; index < source.length; ) {
    if (bytesSeen >= byteOffset) return index;
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) return source.length;
    bytesSeen += Buffer.byteLength(String.fromCodePoint(codePoint), "utf8");
    index += codePoint > 0xffff ? 2 : 1;
  }
  return source.length;
}

/** Every byte offset around the source, inside every code point, and the values that are not byte offsets. */
function offsetsFor(source: string): number[] {
  const total = Buffer.byteLength(source, "utf8");
  const offsets = [Number.NEGATIVE_INFINITY, -2, -1];
  for (let offset = 0; offset <= total + 3; offset += 1) offsets.push(offset);
  offsets.push(0.5, 1.5, total - 0.5, total + 0.5, 2 ** 31, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, NaN);
  return offsets;
}

function mismatchesWithScan(source: string): Array<{ offset: number; actual: number; expected: number }> {
  const mismatches: Array<{ offset: number; actual: number; expected: number }> = [];
  for (const offset of offsetsFor(source)) {
    const actual = utf8ByteOffsetToStringIndex(source, offset);
    const expected = scanToStringIndex(source, offset);
    if (actual !== expected) mismatches.push({ offset, actual, expected });
  }
  return mismatches;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const SOURCES: Array<{ name: string; source: string }> = [
  { name: "an empty source", source: "" },
  { name: "ASCII", source: "import { a } from './a';\nconst b = 1;\n" },
  { name: "two-byte BMP characters", source: "const café = 'naïve';\n" },
  { name: "three-byte BMP characters", source: "const 中文 = '€';\n" },
  { name: "surrogate pairs", source: "a😀b𝒳c" },
  { name: "a source that is one surrogate pair", source: "😀" },
  { name: "a multi-byte character at the end", source: "ab€" },
  { name: "a byte-order mark", source: "\ufeffconst a = 1;" },
  { name: "CRLF line breaks", source: "é\r\nb\r\n" },
  { name: "NUL characters", source: "a\0é\0" },
  { name: "a lone high surrogate", source: "a\ud800b" },
  { name: "a lone low surrogate", source: "a\udc00b" },
  { name: "a reversed surrogate pair", source: "\ude00\ud83d" },
  { name: "a lone high surrogate at the end", source: "x\ud83d" },
  { name: "mixed text before an import", source: "// héllo wörld 😀 中文\nimport x from './x';\n" },
];

describe("utf8ByteOffsetToStringIndex", () => {
  it.each(SOURCES)("matches the previous scan at every offset for $name", ({ source }) => {
    expect(mismatchesWithScan(source)).toEqual([]);
  });

  it("matches the previous scan on random mixed sources", () => {
    const pool = [
      "a",
      "Z",
      "_",
      " ",
      "\n",
      "\r",
      "é",
      "ü",
      "中",
      "€",
      "\u2028",
      "\ufeff",
      "😀",
      "𝒳",
      "\ud800",
      "\udc00",
      "\0",
    ];
    const random = mulberry32(0x5eed);
    const mismatches: unknown[] = [];
    for (let round = 0; round < 300; round += 1) {
      let source = "";
      const length = Math.floor(random() * 25);
      for (let index = 0; index < length; index += 1) source += pool[Math.floor(random() * pool.length)];
      for (const mismatch of mismatchesWithScan(source)) mismatches.push({ source, ...mismatch });
    }
    expect(mismatches).toEqual([]);
  });

  it("is the identity for an ASCII source and ends at its length", () => {
    const offsets = [-1, 0, 1, 2, 3, 4, 100];
    expect(offsets.map((offset) => utf8ByteOffsetToStringIndex("abc", offset))).toEqual([0, 0, 1, 2, 3, 3, 3]);
  });

  it("resolves an offset inside a code point to the end of that code point", () => {
    // Bytes: `a`, then `é` (2), then a surrogate pair (4), then `b`.
    const source = "aé😀b";
    const resolved = Array.from({ length: 10 }, (_, byteOffset) => utf8ByteOffsetToStringIndex(source, byteOffset));
    expect(resolved).toEqual([0, 1, 2, 2, 4, 4, 4, 4, 5, 5]);
  });

  it("counts a lone surrogate as the three bytes of its replacement character", () => {
    // Bytes: `a`, then a lone high surrogate (3), then `b`.
    const source = "a\ud800b";
    const resolved = Array.from({ length: 7 }, (_, byteOffset) => utf8ByteOffsetToStringIndex(source, byteOffset));
    expect(resolved).toEqual([0, 1, 2, 2, 2, 3, 3]);
  });
});

describe("conversion tables of utf8ByteOffsetToStringIndex", () => {
  let sourceCount = 0;
  /** A source no other test uses, so that its first conversion builds a table. */
  const freshSource = (ascii = false): string => {
    sourceCount += 1;
    return ascii ? `// ${sourceCount}\nimport x from "./x";\n` : `// ${sourceCount} é\nimport x from "./x";\n`;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Building a table counts the bytes of its source once, and nothing else in a conversion does, so the calls of
  // `Buffer.byteLength` are the builds.

  it("builds one table per source however the conversions of several sources interleave", () => {
    const sources = Array.from({ length: 8 }, (_, index) => freshSource(index % 2 === 0));
    const byteLength = vi.spyOn(Buffer, "byteLength");
    for (const source of sources) utf8ByteOffsetToStringIndex(source, 5);
    expect(byteLength).toHaveBeenCalledTimes(8);

    for (let round = 0; round < 25; round += 1) {
      for (const source of sources) utf8ByteOffsetToStringIndex(source, 6 + round);
    }
    expect(byteLength).toHaveBeenCalledTimes(8);
  });

  it("builds no table for an offset at or before the start", () => {
    const source = freshSource();
    const byteLength = vi.spyOn(Buffer, "byteLength");
    expect(utf8ByteOffsetToStringIndex(source, 0)).toBe(0);
    expect(utf8ByteOffsetToStringIndex(source, -3)).toBe(0);
    expect(byteLength).not.toHaveBeenCalled();
  });

  it("evicts the least recently used source once 96 sources hold tables", () => {
    const sources = Array.from({ length: 96 }, (_, index) => freshSource(index % 3 === 0));
    for (const source of sources) utf8ByteOffsetToStringIndex(source, 5);
    // The oldest source is used again, so the second one is now the least recently used.
    utf8ByteOffsetToStringIndex(sources[0]!, 6);
    const byteLength = vi.spyOn(Buffer, "byteLength");
    utf8ByteOffsetToStringIndex(freshSource(), 5);
    expect(byteLength).toHaveBeenCalledTimes(1);

    utf8ByteOffsetToStringIndex(sources[0]!, 7);
    utf8ByteOffsetToStringIndex(sources[95]!, 7);
    expect(byteLength).toHaveBeenCalledTimes(1);
    utf8ByteOffsetToStringIndex(sources[1]!, 7);
    expect(byteLength).toHaveBeenCalledTimes(2);
  });

  it("keeps converting correctly while the cache evicts and rebuilds tables", () => {
    const sources = Array.from(
      { length: 200 },
      (_, index) => `${freshSource(index % 2 === 0)}${"€".repeat(index % 5)}`,
    );
    for (let round = 0; round < 3; round += 1) {
      for (const [index, source] of sources.entries()) {
        const offset = 4 + ((index * 7 + round) % 30);
        expect(utf8ByteOffsetToStringIndex(source, offset)).toBe(scanToStringIndex(source, offset));
      }
    }
  });

  it("keeps a source larger than the byte budget cached and drops older tables to stay inside it", () => {
    const sources = [0, 1, 2, 3].map((id) => `${"é".repeat(2_000_000)}${id}`);
    for (const source of sources) utf8ByteOffsetToStringIndex(source, 1_000_001);
    const byteLength = vi.spyOn(Buffer, "byteLength");
    // Four tables of about 20 MB do not fit in the 64 MiB budget, so the oldest is gone and the others stay.
    for (const source of sources.slice(1)) utf8ByteOffsetToStringIndex(source, 1_000_001);
    expect(byteLength).not.toHaveBeenCalled();
    expect(utf8ByteOffsetToStringIndex(sources[0]!, 1_000_001)).toBe(500_001);
    expect(byteLength).toHaveBeenCalledTimes(1);
    // Release the large tables for the tests that follow.
    for (let index = 0; index < 100; index += 1) utf8ByteOffsetToStringIndex(freshSource(), 5);
  });
});

describe("statement start indexes of sources with multi-byte text", () => {
  // Forty surrogate pairs put 80 more UTF-8 bytes than UTF-16 units before the first statement.
  const heading = `${"😀".repeat(40)} héllo wörld 中文`;

  async function withTemporaryProject<T>(run: (root: string) => Promise<T>): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-utf8-offsets-"));
    try {
      return await run(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const pythonSource = [
    `# ${heading}`,
    "from typing import TYPE_CHECKING",
    "",
    "if TYPE_CHECKING:",
    "    from pkg.types import Thing",
    "",
    "from pkg.runtime import Real",
    "",
  ].join("\n");

  it("marks the TYPE_CHECKING import of a Python file type-only in its bindings", async () => {
    await withTemporaryProject(async (root) => {
      const imports = await collectImportsForFile(path.join(root, "app.py"), root, { source: pythonSource });
      const byModule = new Map(imports.map((binding) => [binding.from, binding] as const));
      expect(byModule.get("pkg.types")).toMatchObject({ typeOnly: true, moduleLevel: false });
      expect(byModule.get("pkg.runtime")).toMatchObject({ moduleLevel: true });
      expect(byModule.get("pkg.runtime")?.typeOnly).not.toBe(true);
      expect(byModule.get("typing")).toMatchObject({ moduleLevel: true });
    });
  });

  it("marks the TYPE_CHECKING import of a Python file type-only in its specifiers", () => {
    const specifiers = collectModuleSpecifiersFromSource(supportById("python")!, pythonSource);
    const byModule = new Map(specifiers.map((entry) => [entry.spec, entry] as const));
    expect(byModule.get("pkg.types")?.typeOnly).toBe(true);
    expect(byModule.get("pkg.runtime")?.typeOnly).not.toBe(true);
    expect(byModule.get("typing")?.typeOnly).not.toBe(true);
  });

  const rustSource = [
    `// ${heading} ${heading}`,
    "use crate::shared::Real;",
    "#[cfg(test)]",
    "mod tests {",
    "    use crate::fixtures::Fixture;",
    "}",
    '#[path = "custom.rs"]',
    "mod external;",
    "",
  ].join("\n");

  it("keeps a Rust cfg(test) module's imports and a #[path] module's target apart in its bindings", async () => {
    await withTemporaryProject(async (root) => {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "sample"\nversion = "0.1.0"\n');
      await fs.writeFile(path.join(root, "src", "custom.rs"), "pub fn custom() {}\n");
      await fs.writeFile(path.join(root, "src", "lib.rs"), rustSource);

      const imports = await collectImportsForFile(path.join(root, "src", "lib.rs"), root, { source: rustSource });
      expect(imports.map((binding) => binding.from).sort()).toEqual(["crate::shared", "external"]);
      const resolved = imports.find((binding) => binding.from === "external")?.resolved;
      expect(String(resolved).replace(/\\/g, "/")).toMatch(/\/src\/custom\.rs$/);
    });
  });

  it("keeps a Rust cfg(test) module's imports and a #[path] module's target apart in its specifiers", () => {
    const specifiers = collectModuleSpecifiersFromSource(supportById("rust")!, rustSource);
    expect(specifiers.map((entry) => entry.spec).sort()).toEqual(["crate::shared", "external"]);
    const external = specifiers.find((entry) => entry.spec === "external");
    expect(external?.pathAttribute).toBe("custom.rs");
    // The statement start is a UTF-16 index: the `mod` declaration begins there, after its attribute.
    const start = external?.statementStartIndex ?? -1;
    expect(rustSource.slice(start, start + "mod external;".length)).toBe("mod external;");
  });
});
