import { describe, expect, it } from "vitest";

import { collectLocalsAndExportsFromSource } from "../src/indexer.js";
import { supportForFile } from "../src/languages.js";

describe("JS export fallback regressions", () => {
  it("ignores commented re-export syntax", () => {
    const file = "/virtual/module.ts";
    const source = ["// export { ghost } from './ghost';", "export function real() {", "  return 1;", "}", ""].join(
      "\n",
    );
    const support = supportForFile(file)!;

    const moduleIndex = collectLocalsAndExportsFromSource(file, source, support);

    expect(moduleIndex.exports).toEqual([
      expect.objectContaining({
        type: "local",
        exportedAs: "real",
      }),
    ]);
  });

  it("ignores export syntax inside string literals", () => {
    const file = "/virtual/module.js";
    const source = [
      'const text = "export * as fake from \\"./ghost\\"";',
      "function real() {",
      "  return text;",
      "}",
      "",
    ].join("\n");
    const support = supportForFile(file)!;

    const moduleIndex = collectLocalsAndExportsFromSource(file, source, support);

    expect(moduleIndex.exports).toHaveLength(0);
  });

  it("detects anonymous async default functions in reduced mode", () => {
    const file = "/virtual/module.ts";
    const source = "export default async function () {\n  return 1;\n}\n";
    const support = supportForFile(file)!;

    const moduleIndex = collectLocalsAndExportsFromSource(file, source, support, [], { nativeMode: "off" });

    expect(moduleIndex.exports).toEqual([
      expect.objectContaining({
        type: "local",
        exportedAs: "default",
      }),
    ]);
  });

  it("does not duplicate named default exports when native captures overlap", () => {
    const file = "/virtual/module.ts";
    const source = "export default function Foo() {\n  return 1;\n}\n";
    const support = supportForFile(file)!;

    const moduleIndex = collectLocalsAndExportsFromSource(file, source, support);
    const defaultExports = moduleIndex.exports.filter(
      (entry) => entry.type === "local" && entry.exportedAs === "default",
    );

    expect(defaultExports).toHaveLength(1);
    expect(defaultExports[0]).toEqual(
      expect.objectContaining({
        type: "local",
        exportedAs: "default",
        target: expect.objectContaining({
          localName: "Foo",
        }),
      }),
    );
  });

  it("ignores anonymous default syntax inside comments and strings in reduced mode", () => {
    const file = "/virtual/module.ts";
    const source = [
      "// export default function () {}",
      'const text = "export default class Ghost {}";',
      "export function real() {",
      "  return text;",
      "}",
      "",
    ].join("\n");
    const support = supportForFile(file)!;

    const moduleIndex = collectLocalsAndExportsFromSource(file, source, support, [], { nativeMode: "off" });
    const defaultExports = moduleIndex.exports.filter(
      (entry) => entry.type === "local" && entry.exportedAs === "default",
    );

    expect(defaultExports).toHaveLength(0);
  });
});
