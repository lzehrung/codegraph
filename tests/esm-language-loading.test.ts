import { describe, expect, it } from "vitest";

import { isJsFallbackAvailable, parseWithJsLanguage } from "../src/jsFallback.js";

describe("esm fallback compatibility shim", () => {
  it("imports codegraph and exposes the unavailable grammar shim", async () => {
    const mod = await import("../src/index.ts");
    expect(mod).toBeDefined();
    expect(isJsFallbackAvailable()).toBe(false);
    expect(() => parseWithJsLanguage("body { color: red; }", { name: "tree-sitter-css" })).toThrow(
      "JS Tree-sitter fallback is unavailable",
    );
  });
});
