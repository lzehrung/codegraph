import Parser from "tree-sitter";
import { describe, expect, it } from "vitest";
import { supportById } from "../src/languages.js";

describe("esm tree-sitter loading", () => {
  it("imports codegraph and initializes the CSS grammar", async () => {
    const mod = await import("../src/index.ts");
    expect(mod).toBeDefined();

    const support = supportById("css");
    expect(support).toBeDefined();
    const parser = new Parser();
    expect(() => parser.setLanguage(support!.language("test.css"))).not.toThrow();
  });
});
