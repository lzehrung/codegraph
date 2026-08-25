import { describe, expect, it, vi } from "vitest";
import * as byteIndexModule from "../src/native/byteIndex.js";
import { rangeFromNativeCapture } from "../src/native/queryResults.js";
import { collectLocalsAndExportsFromSource } from "../src/indexer.js";
import { supportForFile } from "../src/languages.js";
import { isNativeTreeSitterAvailable } from "../src/native/treeSitterNative.js";

describe("rangeFromNativeCapture", () => {
  it("converts UTF-8 byte indexes and point columns to UTF-16 range boundaries", () => {
    const source = 'const emoji = "😀";\nconst café = 1;\n';
    const text = "café";
    const startIndex = source.indexOf(text);
    const endIndex = startIndex + text.length;
    const startByteIndex = Buffer.byteLength(source.slice(0, startIndex), "utf8");
    const endByteIndex = Buffer.byteLength(source.slice(0, endIndex), "utf8");
    const lineStartIndex = source.lastIndexOf("\n", startIndex - 1) + 1;
    const startColumn = Buffer.byteLength(source.slice(lineStartIndex, startIndex), "utf8");
    const endColumn = Buffer.byteLength(source.slice(lineStartIndex, endIndex), "utf8");

    const range = rangeFromNativeCapture(
      {
        name: "name",
        text,
        nodeType: "identifier",
        start: { row: 1, column: startColumn, index: startByteIndex },
        end: { row: 1, column: endColumn, index: endByteIndex },
      },
      byteIndexModule.buildByteToStringIndexMap(source),
    );

    expect(range).toEqual({
      start: { line: 2, column: startIndex - lineStartIndex + 1, index: startIndex },
      end: { line: 2, column: endIndex - lineStartIndex + 1, index: endIndex },
    });
    expect(source.slice(range.start.index, range.end.index)).toBe(text);
  });
});

describe.runIf(isNativeTreeSitterAvailable())("locals/exports byte-index map reuse", () => {
  it("builds the byte-offset index map once and shares it with the projected syntax tree", () => {
    const file = "consumer.ts";
    const support = supportForFile(file)!;
    const source = "export const café = 1;\nexport function uséCafé() { return café; }\n";
    const buildSpy = vi.spyOn(byteIndexModule, "buildByteToStringIndexMap");

    try {
      const moduleIndex = collectLocalsAndExportsFromSource(file, source, support);
      // Every native-capture range conversion (locals, exports) and every tree lookup during
      // this call must share one byte-index map instead of each rescanning the source.
      expect(buildSpy).toHaveBeenCalledTimes(1);
      const local = moduleIndex.locals.find((entry) => entry.localName === "uséCafé");
      expect(local?.range).toEqual({
        start: { line: 2, column: 17, index: 39 },
        end: { line: 2, column: 24, index: 46 },
      });
    } finally {
      buildSpy.mockRestore();
    }
  });
});
