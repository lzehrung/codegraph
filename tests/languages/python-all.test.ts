import { describe, it, expect } from "vitest";
import { collectLocalsAndExportsFromSource } from "../../src/indexer.js";
import { PY_SUPPORT } from "../../src/languages.js";
import { loadTreeSitterLanguage } from "../../src/languages/definitions/loadLanguage.js";

describe("Python __all__ exports", () => {
  const lang = loadTreeSitterLanguage("tree-sitter-python");

  it("extracts exports from __all__ tuple assignment", async () => {
    const source = `
def foo(): pass
def bar(): pass

__all__ = (
    "foo",
    "bar",
)
`;
    const mod = collectLocalsAndExportsFromSource(
      "test.py",
      source,
      PY_SUPPORT,
      lang,
      []
    );

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
    const mod = collectLocalsAndExportsFromSource(
      "test.py",
      source,
      PY_SUPPORT,
      lang,
      []
    );

    const exportedNames = mod.exports.map(e => e.exportedAs).sort();
    // It should NOT contain private_func
    expect(exportedNames).toEqual(["foo"]);
  });
});
