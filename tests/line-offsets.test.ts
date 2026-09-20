import { describe, expect, it } from "vitest";

import { collectLocalsAndExportsFromSource } from "../src/index.js";
import { supportById } from "../src/languages.js";
import { collectLineStartOffsets, positionAtOffset } from "../src/util/lines.js";

describe("line start offsets", () => {
  it("counts LF, CRLF, and lone CR each as one line terminator", () => {
    expect(collectLineStartOffsets("one\ntwo\n")).toEqual([0, 4, 8]);
    expect(collectLineStartOffsets("one\r\ntwo\r\n")).toEqual([0, 5, 10]);
    expect(collectLineStartOffsets("one\rtwo\r")).toEqual([0, 4, 8]);
  });

  it("keeps mixed line endings aligned with their own terminators", () => {
    expect(collectLineStartOffsets("a\r\nb\rc\n")).toEqual([0, 3, 5, 7]);
  });

  it("gives a trailing lone CR the same single terminator as a trailing LF", () => {
    expect(collectLineStartOffsets("a\r")).toEqual(collectLineStartOffsets("a\n"));
    expect(collectLineStartOffsets("a\r")).toEqual([0, 2]);
  });

  it("reports the offset after a lone CR on line 2", () => {
    const lineStarts = collectLineStartOffsets("a\rbb");
    expect(positionAtOffset(lineStarts, 2)).toEqual({ line: 2, column: 1, index: 2 });
  });

  it("reports a declaration below a lone CR on its real line", () => {
    const source = "const alpha = 1;\rconst beta = 2;\rfunction gamma() { return 3; }\r";
    const support = supportById("js");
    expect(support).toBeDefined();
    if (!support) return;

    const moduleIndex = collectLocalsAndExportsFromSource("cr-only.js", source, support, []);
    const gamma = moduleIndex.locals.find((local) => local.localName === "gamma");
    expect(gamma).toBeDefined();
    expect(gamma?.range.start.line).toBe(3);
  });
});