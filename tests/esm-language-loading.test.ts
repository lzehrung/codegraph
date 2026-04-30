import { describe, expect, it } from "vitest";
import { isJsFallbackAvailable, parseWithJsLanguage } from "../src/jsFallback.js";
import { supportById } from "../src/languages.js";

const jsFallbackDescribe = isJsFallbackAvailable() ? describe : describe.skip;

jsFallbackDescribe("esm tree-sitter loading", () => {
  it("imports codegraph and initializes the CSS grammar", async () => {
    const mod = await import("../src/index.ts");
    expect(mod).toBeDefined();

    const support = supportById("css");
    expect(support).toBeDefined();
    expect(() => parseWithJsLanguage("body { color: red; }", support!.language("test.css"))).not.toThrow();
  });
});
