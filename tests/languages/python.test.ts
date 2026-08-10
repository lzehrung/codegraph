import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";

const definition: LanguageTestDefinition = {
  id: "python",
  samples: [
    {
      name: "chunks Python with docstrings",
      sourceFile: "python.sample.py",
      expectedChunks: (chunks) => {
        // expect(chunks.some((c) => c.type === "docstring")).toBe(true);
        expect(chunks.some((c) => c.type === "imports")).toBe(true);
        expect(chunks.some((c) => c.type === "module_var" && c.name === "CONFIG_PATH")).toBe(true);

        const classChunk = chunks.find((c) => c.type === "class" && c.name === "Foo");
        expect(classChunk).toBeDefined();

        const methodChunk = chunks.find((c) => c.type === "function" && c.name === "method");
        expect(methodChunk).toBeDefined(); // Method is inside class, but might be split if large enough or configured

        const topLevelFunc = chunks.find((c) => c.type === "function" && c.name === "top_level");
        expect(topLevelFunc).toBeDefined();

        // We expect only the top-level docstring to be a standalone chunk
        // Note: In the previous turn, we fixed the Python definition to only capture top-level docstrings.
        // However, the sample file has a top-level docstring.
        // Let's verify that we get exactly 1 docstring chunk.
        const docstringChunks = chunks.filter((c) => c.type === "docstring");
        expect(docstringChunks.length).toBe(1);
        expect(docstringChunks[0]?.text).toBe('"""Module docstring explaining the purpose of this file."""');
      },
    },
  ],
  parity: {
    sampleDir: "python",
    dependencyGraph: [
      {
        from: "relative-imports.py",
        to: { type: "file", path: "utils.py" },
      },
      {
        from: "relative-imports.py",
        to: { type: "file", path: "helpers.py" },
      },
    ],
    goToDefinition: [
      {
        name: "go to definition resolves a match keyword-pattern bound variable from its usage site",
        file: "match_patterns.py",
        line: 10,
        column: 20,
        expectedDefinition: { file: "match_patterns.py", line: 9 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("Python __all__ exports", () => {
  async function collectModule(source: string) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-all-"));
    const file = path.join(root, "test.py");
    await fsp.writeFile(file, source, "utf8");
    try {
      const parsed = await parseFile(file);
      return collectLocalsAndExportsFromSource(file, parsed.source, parsed.sup, parsed.lang, [], {
        tree: parsed.tree,
        nativeQueries: parsed.nativeQueries,
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }

  it("extracts exports from __all__ tuple assignment", async () => {
    const source = `
def foo(): pass
def bar(): pass

__all__ = (
    "foo",
    "bar",
)
`;
    const mod = await collectModule(source);

    const exportedNames = mod.exports.map((e) => e.exportedAs).sort();
    expect(exportedNames).toEqual(["bar", "foo"]);
  });

  it("avoids false positives from nearby strings in fallback", async () => {
    // The current fallback just scans 800 chars after __all__.
    // If we have a string that matches a local name, it will be exported.
    const source = `
def foo(): pass
def private_func(): pass

__all__ = ["foo"]

# "private_func" is mentioned in a string nearby, but not in __all__
description = "This module uses private_func internally"
`;
    const mod = await collectModule(source);

    const exportedNames = mod.exports.map((e) => e.exportedAs).sort();
    // It should NOT contain private_func
    expect(exportedNames).toEqual(["foo"]);
  });
});
