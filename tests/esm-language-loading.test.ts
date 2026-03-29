import { describe, expect, it } from "vitest";
import { parseWithJsLanguage } from "@lzehrung/codegraph-native/js-fallback";
import { supportById } from "../src/languages.js";

describe("esm tree-sitter loading", () => {
  it("imports codegraph and initializes the CSS grammar", async () => {
    const mod = await import("../src/index.ts");
    expect(mod).toBeDefined();

    const support = supportById("css");
    expect(support).toBeDefined();
    expect(() =>
      parseWithJsLanguage("body { color: red; }", support!.language("test.css")),
    ).not.toThrow();
  });
});
