import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LANG_CONFIGS } from "../src/bootstrap/treeSitterLanguages.js";
import { chunkFile, type Chunk } from "../src/chunking/chunkFile.js";
import { chunkSFCFile } from "../src/chunking/chunkSFC.js";
import { astGrep } from "../src/index.js";
import { __resetNativeTreeSitterBindingForTests, isNativeTreeSitterAvailable } from "../src/native/treeSitterNative.js";

const nativeDescribe = isNativeTreeSitterAvailable() ? describe : describe.skip;

type RuntimeMode = "native" | "js";

function withRuntimeMode<T>(mode: RuntimeMode, run: () => T): T {
  const previous = process.env.CODEGRAPH_DISABLE_NATIVE;
  if (mode === "js") {
    process.env.CODEGRAPH_DISABLE_NATIVE = "1";
  } else {
    delete process.env.CODEGRAPH_DISABLE_NATIVE;
  }
  __resetNativeTreeSitterBindingForTests();
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.CODEGRAPH_DISABLE_NATIVE;
    } else {
      process.env.CODEGRAPH_DISABLE_NATIVE = previous;
    }
    __resetNativeTreeSitterBindingForTests();
  }
}

async function withRuntimeModeAsync<T>(mode: RuntimeMode, run: () => Promise<T>): Promise<T> {
  const previous = process.env.CODEGRAPH_DISABLE_NATIVE;
  if (mode === "js") {
    process.env.CODEGRAPH_DISABLE_NATIVE = "1";
  } else {
    delete process.env.CODEGRAPH_DISABLE_NATIVE;
  }
  __resetNativeTreeSitterBindingForTests();
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.CODEGRAPH_DISABLE_NATIVE;
    } else {
      process.env.CODEGRAPH_DISABLE_NATIVE = previous;
    }
    __resetNativeTreeSitterBindingForTests();
  }
}

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

const tokenize = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

afterEach(() => {
  delete process.env.CODEGRAPH_DISABLE_NATIVE;
  __resetNativeTreeSitterBindingForTests();
});

nativeDescribe("native query ownership parity", () => {
  it("keeps chunkFile output identical for representative languages", () => {
    const cases = [
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
        source: ["def classify(value):", "    if value > 0:", '        return "positive"', '    return "zero"'].join(
          "\n",
        ),
      },
    ];

    for (const testCase of cases) {
      const nativeChunks = withRuntimeMode("native", () =>
        chunkFile({
          language: testCase.config,
          source: testCase.source,
          filePath: testCase.filePath,
          minTokens: 1,
          maxTokens: 12,
          tokenizer: tokenize,
        }),
      );
      const jsChunks = withRuntimeMode("js", () =>
        chunkFile({
          language: testCase.config,
          source: testCase.source,
          filePath: testCase.filePath,
          minTokens: 1,
          maxTokens: 12,
          tokenizer: tokenize,
        }),
      );

      expect(normalizeChunks(nativeChunks)).toEqual(normalizeChunks(jsChunks));
    }
  });

  it("keeps SFC chunking identical for Vue and Svelte inline-script fixtures", () => {
    const cases = [
      {
        framework: "vue" as const,
        filePath: path.resolve(process.cwd(), "tests", "samples", "vue", "inline-script.vue"),
      },
      {
        framework: "svelte" as const,
        filePath: path.resolve(process.cwd(), "tests", "samples", "svelte", "inline-script.svelte"),
      },
    ];

    for (const testCase of cases) {
      const source = fs.readFileSync(testCase.filePath, "utf8");
      const nativeChunks = withRuntimeMode("native", () =>
        chunkSFCFile({
          source,
          filePath: testCase.filePath,
          framework: testCase.framework,
          minTokens: 1,
          maxTokens: 16,
          tokenizer: tokenize,
        }),
      );
      const jsChunks = withRuntimeMode("js", () =>
        chunkSFCFile({
          source,
          filePath: testCase.filePath,
          framework: testCase.framework,
          minTokens: 1,
          maxTokens: 16,
          tokenizer: tokenize,
        }),
      );

      expect(normalizeChunks(nativeChunks)).toEqual(normalizeChunks(jsChunks));
    }
  });

  it("keeps astGrep results identical when native owns query execution", async () => {
    const projectRoot = path.resolve(process.cwd(), "tests", "samples", "typescript");
    const query = "(import_statement source: (string) @mod)";

    const nativeHits = await withRuntimeModeAsync("native", async () => await astGrep(projectRoot, query, ["**/*.ts"]));
    const jsHits = await withRuntimeModeAsync("js", async () => await astGrep(projectRoot, query, ["**/*.ts"]));

    expect(nativeHits).toEqual(jsHits);
  });
});
