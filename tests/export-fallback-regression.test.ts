import { describe, expect, it } from "vitest";

import { collectLocalsAndExportsFromSource } from "../src/indexer.js";
import { supportForFile } from "../src/languages.js";

describe("JS export fallback regressions", () => {
  it("ignores commented re-export syntax", () => {
    const file = "/virtual/module.ts";
    const source = ["// export { ghost } from './ghost';", "export function real() {", "  return 1;", "}", ""].join("\n");
    const support = supportForFile(file)!;

    const moduleIndex = collectLocalsAndExportsFromSource(file, source, support, support.language(file));

    expect(moduleIndex.exports).toEqual([
      expect.objectContaining({
        type: "local",
        exportedAs: "real",
      }),
    ]);
  });

  it("ignores export syntax inside string literals", () => {
    const file = "/virtual/module.js";
    const source = ['const text = "export * as fake from \\"./ghost\\"";', "function real() {", "  return text;", "}", ""].join("\n");
    const support = supportForFile(file)!;

    const moduleIndex = collectLocalsAndExportsFromSource(file, source, support, support.language(file));

    expect(moduleIndex.exports).toHaveLength(0);
  });
});
