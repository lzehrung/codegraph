import { describe, expect, it } from "vitest";

import { isNonNativeParserAvailable, parseWithLanguage } from "../src/parserBackend.js";

describe("ESM parser backend unavailable contract", () => {
  it("imports codegraph and exposes the unavailable parser backend", async () => {
    const mod = await import("../src/index.ts");
    expect(mod).toBeDefined();
    expect(isNonNativeParserAvailable()).toBe(false);
    expect(() => parseWithLanguage("body { color: red; }", { name: "tree-sitter-css" })).toThrow(
      "Non-native Tree-sitter parser is unavailable",
    );
  });
});
