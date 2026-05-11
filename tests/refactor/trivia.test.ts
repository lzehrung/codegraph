import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildProjectIndexFromFiles, getSymbolRange, listSymbols, type TriviaMode } from "../../src/index.js";
import { computeLeadingTriviaRange } from "../../src/indexer/symbol-ranges.js";
import type { SyntaxNodeLike } from "../../src/languages/types.js";

async function withTempProject<T>(files: Record<string, string>, fn: (root: string, files: string[]) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-trivia-"));
  try {
    const absoluteFiles: string[] = [];
    for (const [relative, source] of Object.entries(files)) {
      const file = path.join(root, relative);
      await writeFile(file, source, "utf8");
      absoluteFiles.push(file.replace(/\\/g, "/"));
    }
    return await fn(root, absoluteFiles);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function rangeStartLine(source: string, symbol: string, trivia: TriviaMode): Promise<number | undefined> {
  return await withTempProject({ "sample.ts": source }, async (root, files) => {
    const index = await buildProjectIndexFromFiles(root, files, { native: "off", keepParsed: true });
    return listSymbols(index, { file: files[0], trivia }).find((item) => item.name === symbol)?.range?.start.line;
  });
}

function fakeNode(type: string, startIndex: number, endIndex: number, startLine: number): SyntaxNodeLike {
  return {
    type,
    startIndex,
    endIndex,
    startPosition: { row: startLine - 1, column: 0 },
    endPosition: { row: startLine - 1, column: endIndex - startIndex },
    namedChildren: [],
    previousNamedSibling: null,
    parent: null,
    text: "",
    child: () => null,
    childForFieldName: () => null,
  };
}

describe("trivia-aware symbol ranges", () => {
  test("expands TypeScript leading-doc ranges without crossing blank lines", async () => {
    const source = [
      "// File header",
      "",
      "/** Greets a user. */",
      "export function greet() {",
      "  return 'hi';",
      "}",
      "",
    ].join("\n");

    await expect(rangeStartLine(source, "greet", "exclude")).resolves.toBe(4);
    await expect(rangeStartLine(source, "greet", "leading-doc")).resolves.toBe(3);
  });

  test("leading-all includes decorators while leading-doc starts at the doc block", async () => {
    const source = [
      "/** Service docs. */",
      "@sealed",
      "export class Service {",
      "  run() {}",
      "}",
      "",
    ].join("\n");

    await expect(rangeStartLine(source, "Service", "leading-doc")).resolves.toBe(1);
    await expect(rangeStartLine(source, "Service", "leading-all")).resolves.toBe(1);
  });

  test("expands Python line-comment docs and leaves internal docstrings inside the bare range", async () => {
    await withTempProject(
      {
        "sample.py": [
          "# Function docs",
          "def helper():",
          '    """internal docstring"""',
          "    return 1",
          "",
        ].join("\n"),
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, files, { native: "off", keepParsed: true });
        const def = index.byFile.get(files[0]!)?.locals.find((item) => item.localName === "helper");
        expect(def).toBeDefined();
        if (!def) return;

        expect(def.range.start.line).toBe(2);
        const expanded = getSymbolRange(index, def, { trivia: "leading-doc" });
        expect(expanded.start.line).toBe(1);
        expect(expanded.end.line).toBe(4);
      },
    );
  });

  test("leading-all includes Rust attributes attached to a documented function", async () => {
    await withTempProject(
      {
        "sample.rs": [
          "/// Runs work.",
          "#[inline]",
          "pub fn run_work() {",
          "}",
          "",
        ].join("\n"),
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, files, { native: "off", keepParsed: true });
        const symbol = listSymbols(index, { file: files[0], trivia: "leading-all" }).find(
          (item) => item.name === "run_work",
        );
        expect(symbol?.range?.start.line).toBe(1);
      },
    );
  });

  test("transparent leading trivia nodes are scoped to the current language", () => {
    const source = "/** docs */\n[Attr]\nexport function run() {}\n";
    const doc = fakeNode("comment", 0, 11, 1);
    const attributeList = fakeNode("attribute_list", 11, 18, 2);
    const functionNode = fakeNode("function_declaration", 18, source.length, 3);
    attributeList.previousNamedSibling = doc;
    functionNode.previousNamedSibling = attributeList;

    const range = computeLeadingTriviaRange(functionNode, source, "ts", "leading-doc");

    expect(range.start.line).toBe(3);
  });

  test("disk trivia parsing uses SFC script preprocessing", async () => {
    await withTempProject(
      {
        "Widget.vue": [
          "<template>",
          "  <p>ignored</p>",
          "</template>",
          "<script lang=\"ts\">",
          "/** Builds the widget. */",
          "export function buildWidget() {",
          "  return 1;",
          "}",
          "</script>",
          "",
        ].join("\n"),
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, files, { native: "off" });
        const def = index.byFile.get(files[0]!)?.locals.find((item) => item.localName === "buildWidget");
        expect(def).toBeDefined();
        if (!def) return;

        const expanded = getSymbolRange(index, def, { trivia: "leading-doc", source: "disk" });

        expect(expanded.start.line).toBe(5);
        expect(expanded.end.line).toBe(8);
      },
    );
  });
});
