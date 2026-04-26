import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";

describe("Python __all__ exports", () => {
  async function collectModule(source: string) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-all-"));
    const file = path.join(root, "test.py");
    await fsp.writeFile(file, source, "utf8");
    try {
      const parsed = await parseFile(file);
      return collectLocalsAndExportsFromSource(
        file,
        parsed.source,
        parsed.sup,
        parsed.lang,
        [],
        {
          tree: parsed.tree,
          nativeQueries: parsed.nativeQueries,
        },
      );
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

    const exportedNames = mod.exports.map(e => e.exportedAs).sort();
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

    const exportedNames = mod.exports.map(e => e.exportedAs).sort();
    // It should NOT contain private_func
    expect(exportedNames).toEqual(["foo"]);
  });
});
