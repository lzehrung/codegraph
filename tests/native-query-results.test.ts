import { describe, expect, it } from "vitest";
import { buildByteToStringIndexMap } from "../src/native/byteIndex.js";
import { rangeFromNativeCapture } from "../src/native/queryResults.js";

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
      buildByteToStringIndexMap(source),
    );

    expect(range).toEqual({
      start: { line: 2, column: startIndex - lineStartIndex + 1, index: startIndex },
      end: { line: 2, column: endIndex - lineStartIndex + 1, index: endIndex },
    });
    expect(source.slice(range.start.index, range.end.index)).toBe(text);
  });
});
