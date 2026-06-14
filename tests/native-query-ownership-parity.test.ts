import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LANG_CONFIGS } from "../src/bootstrap/treeSitterLanguages.js";
import { chunkFile, type Chunk } from "../src/chunking/chunkFile.js";
import { chunkSFCFile } from "../src/chunking/chunkSFC.js";
import { astGrep } from "../src/index.js";
import { isNativeTreeSitterAvailable } from "../src/native/treeSitterNative.js";
import { resetNativeRuntimeModeForTests, withNativeRuntimeMode, withNativeRuntimeModeAsync } from "./helpers/native.js";

function normalizeChunks(chunks: Chunk[]) {
  return chunks.map((chunk) => ({
    languageId: chunk.languageId,
    filePath: chunk.filePath,
    type: chunk.type,
    name: chunk.name,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    text: chunk.text,
    tokenCount: chunk.tokenCount,
  }));
}

function stableChunks(chunks: Chunk[]) {
  return normalizeChunks(chunks).map((chunk) => ({
    ...chunk,
    filePath: path.isAbsolute(chunk.filePath)
      ? path.relative(process.cwd(), chunk.filePath).replace(/\\/g, "/")
      : chunk.filePath,
  }));
}

function stableAstGrepHits(projectRoot: string, hits: Awaited<ReturnType<typeof astGrep>>) {
  return hits.map((hit) => ({
    ...hit,
    file: path.isAbsolute(hit.file) ? path.relative(projectRoot, hit.file).replace(/\\/g, "/") : hit.file,
  }));
}

const tokenize = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
const SOURCE_CHUNK_CASES = [
  {
    config: LANG_CONFIGS.javascript,
    filePath: "sample.js",
    source: [
      "function alpha(input) {",
      "  if (!input) return 0;",
      "  return input + 1;",
      "}",
      "",
      "const beta = () => alpha(2);",
    ].join("\n"),
  },
  {
    config: LANG_CONFIGS.typescript,
    filePath: "sample.ts",
    source: [
      "export namespace Tools {",
      "  export function build(value: number): number {",
      "    return value + 1;",
      "  }",
      "}",
    ].join("\n"),
  },
  {
    config: LANG_CONFIGS.python,
    filePath: "sample.py",
    source: ["def classify(value):", "    if value > 0:", '        return "positive"', '    return "zero"'].join("\n"),
  },
];

const SFC_CHUNK_CASES = [
  {
    framework: "vue" as const,
    filePath: path.resolve(process.cwd(), "tests", "samples", "vue", "inline-script.vue"),
  },
  {
    framework: "svelte" as const,
    filePath: path.resolve(process.cwd(), "tests", "samples", "svelte", "inline-script.svelte"),
  },
];
const nativeDescribe = isNativeTreeSitterAvailable() ? describe : describe.skip;

afterEach(() => {
  resetNativeRuntimeModeForTests();
});

nativeDescribe("native query ownership", () => {
  it("keeps chunkFile productive in native mode", () => {
    for (const testCase of SOURCE_CHUNK_CASES) {
      const nativeChunks = withNativeRuntimeMode("native", () =>
        chunkFile({
          language: testCase.config,
          source: testCase.source,
          filePath: testCase.filePath,
          minTokens: 1,
          maxTokens: 12,
          tokenizer: tokenize,
        }),
      );

      expect(stableChunks(nativeChunks)).toMatchSnapshot();
    }
  });

  it("keeps SFC chunking productive in native mode", () => {
    for (const testCase of SFC_CHUNK_CASES) {
      const source = fs.readFileSync(testCase.filePath, "utf8");
      const nativeChunks = withNativeRuntimeMode("native", () =>
        chunkSFCFile({
          source,
          filePath: testCase.filePath,
          framework: testCase.framework,
          minTokens: 1,
          maxTokens: 16,
          tokenizer: tokenize,
        }),
      );

      expect(stableChunks(nativeChunks)).toMatchSnapshot();
    }
  });

  it("keeps astGrep productive in native mode", async () => {
    const projectRoot = path.resolve(process.cwd(), "tests", "samples", "typescript");
    const query = "(import_statement source: (string) @mod)";

    const nativeHits = await withNativeRuntimeModeAsync(
      "native",
      async () => await astGrep(projectRoot, query, ["**/*.ts"]),
    );

    expect(stableAstGrepHits(projectRoot, nativeHits)).toMatchSnapshot();
  });
});

describe("reduced query mode", () => {
  it("keeps chunkFile safe without native", () => {
    for (const testCase of SOURCE_CHUNK_CASES) {
      const reducedChunks = withNativeRuntimeMode("reduced", () =>
        chunkFile({
          language: testCase.config,
          source: testCase.source,
          filePath: testCase.filePath,
          minTokens: 1,
          maxTokens: 12,
          tokenizer: tokenize,
        }),
      );

      expect(stableChunks(reducedChunks)).toMatchSnapshot();
    }
  });

  it("keeps SFC chunking safe without native", () => {
    for (const testCase of SFC_CHUNK_CASES) {
      const source = fs.readFileSync(testCase.filePath, "utf8");
      const reducedChunks = withNativeRuntimeMode("reduced", () =>
        chunkSFCFile({
          source,
          filePath: testCase.filePath,
          framework: testCase.framework,
          minTokens: 1,
          maxTokens: 16,
          tokenizer: tokenize,
        }),
      );

      expect(stableChunks(reducedChunks)).toMatchSnapshot();
    }
  });

  it("keeps astGrep empty-but-safe without native", async () => {
    const projectRoot = path.resolve(process.cwd(), "tests", "samples", "typescript");
    const query = "(import_statement source: (string) @mod)";

    const reducedHits = await withNativeRuntimeModeAsync(
      "reduced",
      async () => await astGrep(projectRoot, query, ["**/*.ts"]),
    );

    expect(reducedHits).toEqual([]);
  });
});
