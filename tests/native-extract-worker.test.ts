import { describe, expect, it, vi } from "vitest";

import type { NativeBinding, NativeQueryResults, NativeSyntaxTree } from "../src/native/contracts.js";
import { createNativeExtractor } from "../src/worker/nativeExtractWorker.js";

const results: NativeQueryResults = {
  imports: [],
  exports: [],
  locals: [],
  importBindings: [],
};

const syntaxTree: NativeSyntaxTree = {
  rootId: 0,
  nodes: [
    {
      id: 0,
      parentId: -1,
      nodeType: "program",
      named: true,
      start: { row: 0, column: 0, index: 0 },
      end: { row: 0, column: 0, index: 0 },
      childIds: [],
      namedChildIds: [],
      childFieldNames: [],
    },
  ],
};

describe("native extraction worker", () => {
  it("uses one combined native extraction call per full-index task", async () => {
    const extractLanguage = vi.fn(() => ({ results, syntaxTree }));
    const runLanguageQueries = vi.fn(() => results);
    const parseSyntaxTree = vi.fn(() => syntaxTree);
    const binding: NativeBinding = {
      extractLanguage,
      runLanguageQueries,
      parseSyntaxTree,
      supportedLanguageIds: () => ["ts"],
    };
    const extract = createNativeExtractor({
      loadBinding: () => ({
        binding,
        origin: { mode: "workspace", packageName: "@lzehrung/codegraph-native" },
      }),
      readFile: async () => "",
    });

    const tasks = [
      { filePath: "first.ts", source: "export const first = 1;" },
      { filePath: "second.ts", source: "export const second = 2;" },
    ];
    const outputs = await Promise.all(
      tasks.map((task) =>
        extract({
          ...task,
          languageId: "ts",
          importsQuery: "",
          exportsQuery: "",
          localsQuery: "",
          importBindingsQuery: "",
        }),
      ),
    );

    expect(extractLanguage).toHaveBeenCalledTimes(tasks.length);
    expect(runLanguageQueries).not.toHaveBeenCalled();
    expect(parseSyntaxTree).not.toHaveBeenCalled();
    expect(outputs.map((output) => output.syntaxTree)).toEqual([syntaxTree, syntaxTree]);
  });
});
