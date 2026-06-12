import { describe, expect, it } from "vitest";

import * as jsFallback from "../src/jsFallback.js";

describe("js fallback shim", () => {
  it("always reports grammar fallback as unavailable", () => {
    expect(jsFallback.isJsFallbackAvailable()).toBe(false);
    expect(() => jsFallback.parseWithJsLanguage("const value = 1;", { name: "tree-sitter-javascript" })).toThrow(
      "JS Tree-sitter fallback is unavailable",
    );
  });
});
