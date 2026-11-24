import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findReferences } from "../src/indexer.js";
import { createTestIndexFromPath } from "./test-utils.js";

const ecmaSource = [
  "const needle = 1;",
  "function unrelated() { return 0; }",
  "function enclosing() {",
  "  if (needle) {",
  "    return needle;",
  "  }",
  "}",
  "function trailing() { return 0; }",
  "",
].join("\n");

const pythonSource = [
  "needle = 1",
  "def unrelated():",
  "    return 0",
  "def enclosing():",
  "    if needle:",
  "        return needle",
  "def trailing():",
  "    return 0",
  "",
].join("\n");

const goSource = [
  "package main",
  "var needle = 1",
  "func unrelated() int { return 0 }",
  "func enclosing() int {",
  "    if needle > 0 {",
  "        return needle",
  "    }",
  "    return 0",
  "}",
  "func trailing() int { return 0 }",
  "",
].join("\n");

function positionAt(source: string, index: number): { line: number; column: number } {
  const lines = source.slice(0, index).split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

describe("reference block context", () => {
  it.each([
    ["js", ecmaSource],
    ["ts", ecmaSource],
    ["tsx", ecmaSource],
    ["py", pythonSource],
    ["go", goSource],
  ])("selects the enclosing block for %s without adjacent functions", async (extension, source) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-reference-context-"));
    try {
      const file = path.join(root, `sample.${extension}`).replace(/\\/g, "/");
      await fsp.writeFile(file, source, "utf8");
      const index = await createTestIndexFromPath(root);
      const definition = positionAt(source, source.indexOf("needle"));
      const use = positionAt(source, source.lastIndexOf("needle"));
      const result = await findReferences(index, { file, ...definition }, { context: "block", blockMaxLines: 50 });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const reference = result.references.find((item) => item.file === file && item.range.start.line === use.line);
      expect(reference?.context).toContain("enclosing");
      expect(reference?.context).toContain("return needle");
      expect(reference?.context).not.toContain("unrelated");
      expect(reference?.context).not.toContain("trailing");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
