import { describe, expect, it, vi } from "vitest";

import type { NativeBinding, NativeQueryResults, NativeSyntaxTree } from "../src/native/contracts.js";
import { createNativeExtractor, REQUIRED_NATIVE_EXTRACTION_VERSION } from "../src/worker/nativeExtractWorker.js";
import { createStubNativeSyntaxTree } from "./helpers/native.js";

const results: NativeQueryResults = {
  imports: [],
  exports: [],
  locals: [],
  importBindings: [],
};

const syntaxTree: NativeSyntaxTree = createStubNativeSyntaxTree();

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
  it("omits source only when the caller supplies the exact source", async () => {
    const extractLanguage = vi.fn(() => ({ results, syntaxTree }));
    const binding: NativeBinding = {
      extractLanguage,
      runLanguageQueries: vi.fn(() => results),
      parseSyntaxTree: vi.fn(() => syntaxTree),
      supportedLanguageIds: () => ["ts"],
    };
    const extract = createNativeExtractor({
      loadBinding: () => ({
        binding,
        origin: { mode: "workspace", packageName: "@lzehrung/codegraph-native" },
      }),
      readFile: async () => {
        throw new Error("caller-owned source should avoid worker reads");
      },
    });

    const output = await extract({
      filePath: "owned.ts",
      languageId: "ts",
      source: "export const owned = 1;\n",
      includeSourceInResult: false,
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
    });

    expect(output.source).toBeUndefined();
    expect(extractLanguage).toHaveBeenCalledWith("export const owned = 1;\n", "ts", "", "", "", "");
  });
  it("reports an actionable version error for a native binary without extractLanguage", async () => {
    const binding: NativeBinding = {
      extractLanguage: () => ({ results, syntaxTree }),
      runLanguageQueries: vi.fn(() => results),
      parseSyntaxTree: vi.fn(() => syntaxTree),
      supportedLanguageIds: () => ["ts"],
    };
    Reflect.deleteProperty(binding, "extractLanguage");
    const extract = createNativeExtractor({
      loadBinding: () => ({
        binding,
        origin: { mode: "workspace", packageName: "@lzehrung/codegraph-native" },
      }),
      readFile: async () => "",
    });

    const output = await extract({
      filePath: "legacy.ts",
      languageId: "ts",
      source: "export const value = 1;\n",
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
    });

    expect(output.fallbackReason).toBe("unavailable");
    // Read the required version from the source of truth so a bump cannot silently
    // leave this assertion pinned to a stale value.
    expect(output.error).toContain(`@lzehrung/codegraph-native >= ${REQUIRED_NATIVE_EXTRACTION_VERSION}`);
    expect(output.error).toContain("extractLanguage");
  });

  it("rejects a native binary that returns the legacy syntax-tree shape", async () => {
    const legacyTree = { rootId: 0, nodes: [] };
    const binding = {
      extractLanguage: () => ({ results, syntaxTree: legacyTree }),
      runLanguageQueries: () => results,
      supportedLanguageIds: () => ["ts"],
    } as NativeBinding;
    const extract = createNativeExtractor({
      loadBinding: () => ({
        binding,
        origin: { mode: "workspace", packageName: "@lzehrung/codegraph-native" },
      }),
      readFile: async () => "export const value = 1;\n",
    });

    const output = await extract({
      filePath: "legacy.ts",
      languageId: "ts",
      source: "export const value = 1;\n",
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
    });

    expect(output.fallbackReason).toBe("unavailable");
    expect(output.syntaxTree).toBeNull();
    // The tree failed to project, but the query results came from the same extractLanguage
    // call and are unaffected by the tree's shape, so they should still come back.
    expect(output.nativeResults).toEqual(results);
    expect(output.error).toContain(`@lzehrung/codegraph-native >= ${REQUIRED_NATIVE_EXTRACTION_VERSION}`);
    expect(output.error).toContain("legacy syntax-tree shape");
  });

  it("preserves the unavailable fallback when the optional native addon is absent", async () => {
    const extract = createNativeExtractor({
      loadBinding: () => ({
        binding: null,
        error: new Error("MODULE_NOT_FOUND"),
      }),
      readFile: async () => "export const value = 1;\n",
    });

    const output = await extract({
      filePath: "reduced.ts",
      languageId: "ts",
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
    });

    expect(output).toMatchObject({
      source: "export const value = 1;\n",
      nativeResults: null,
      compactResults: null,
      syntaxTree: null,
      fallbackReason: "unavailable",
      error: "native addon not available in worker: MODULE_NOT_FOUND",
    });
  });
});
