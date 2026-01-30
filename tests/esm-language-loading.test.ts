import Parser from "tree-sitter";
import { describe, expect, it } from "vitest";

describe("esm tree-sitter loading", () => {
  it("imports codegraph and initializes the CSS grammar", async () => {
    const mod = await import("../src/index.ts");
    expect(mod).toBeDefined();

    const { CSS_DEF } = await import("../src/languages/definitions/css.ts");
    const parser = new Parser();
    const lang = await CSS_DEF.grammar();
    expect(() => parser.setLanguage(lang)).not.toThrow();
  });
});
