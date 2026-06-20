import { describe, expect, it } from "vitest";

import * as parserBackend from "../src/parserBackend.js";

describe("parser backend unavailable contract", () => {
  it("always reports non-native parsing as unavailable", () => {
    expect(parserBackend.isNonNativeParserAvailable()).toBe(false);
    expect(() => parserBackend.parseWithLanguage("const value = 1;", { name: "tree-sitter-javascript" })).toThrow(
      "Non-native Tree-sitter parser is unavailable",
    );
  });
});
