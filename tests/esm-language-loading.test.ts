import Parser from "tree-sitter";
import { describe, expect, it } from "vitest";

describe("esm tree-sitter loading", () => {
  it("imports codegraph and initializes the CSS grammar", async () => {
    const mod = await import("../src/index.ts");
    expect(mod).toBeDefined();

    const { CSS_DEF } = await import("../src/languages/definitions/css.ts");
    const parser = new Parser();
    expect(() => parser.setLanguage(CSS_DEF.grammar())).not.toThrow();
  });
});
