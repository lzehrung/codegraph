import { describe, expect, it, vi } from "vitest";

import { TS_SUPPORT } from "../src/languages.js";
import type { NativeBinding, NativeQueryResults, NativeSyntaxTree } from "../src/native/contracts.js";
import { getCachedNormalizedQuery } from "../src/native/queries.js";
import { createNativeExtractor, REQUIRED_NATIVE_EXTRACTION_VERSION } from "../src/worker/native-extract-worker.js";
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
      registerQuerySet: () => 1,
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
    const outputs = await Promise.all(tasks.map((task) => extract({ ...task, languageId: "ts" })));

    expect(extractLanguage).toHaveBeenCalledTimes(tasks.length);
    expect(runLanguageQueries).not.toHaveBeenCalled();
    expect(parseSyntaxTree).not.toHaveBeenCalled();
    expect(outputs.map((output) => output.syntaxTree)).toEqual([syntaxTree, syntaxTree]);
  });

  it("registers a language's queries once and passes only the id on each extraction", async () => {
    const registerQuerySet = vi.fn(() => 7);
    const extractLanguage = vi.fn(() => ({ results, syntaxTree }));
    const binding: NativeBinding = {
      registerQuerySet,
      extractLanguage,
      runLanguageQueries: vi.fn(() => results),
      supportedLanguageIds: () => ["ts"],
    };
    const extract = createNativeExtractor({
      loadBinding: () => ({
        binding,
        origin: { mode: "workspace", packageName: "@lzehrung/codegraph-native" },
      }),
      readFile: async () => "",
    });

    for (const source of ["export const first = 1;", "export const second = 2;", "export const third = 3;"]) {
      await extract({ filePath: "file.ts", languageId: "ts", source });
    }

    expect(registerQuerySet).toHaveBeenCalledTimes(1);
    expect(registerQuerySet).toHaveBeenCalledWith(
      "ts",
      getCachedNormalizedQuery(TS_SUPPORT, "imports"),
      getCachedNormalizedQuery(TS_SUPPORT, "exports"),
      getCachedNormalizedQuery(TS_SUPPORT, "locals"),
      getCachedNormalizedQuery(TS_SUPPORT, "importBindings"),
    );
    // Exactly the source and the id: no query text rides along on any call.
    expect(extractLanguage.mock.calls).toEqual([
      ["export const first = 1;", 7],
      ["export const second = 2;", 7],
      ["export const third = 3;", 7],
    ]);
  });

  it("runs a compact task against a set that holds only the imports query", async () => {
    const registerQuerySet = vi.fn(() => 3);
    const runImportsQueryCompact = vi.fn(() => ({ imports: [] }));
    const binding: NativeBinding = {
      registerQuerySet,
      extractLanguage: vi.fn(() => ({ results, syntaxTree })),
      runLanguageQueries: vi.fn(() => results),
      runImportsQueryCompact,
      supportedLanguageIds: () => ["ts"],
    };
    const extract = createNativeExtractor({
      loadBinding: () => ({
        binding,
        origin: { mode: "workspace", packageName: "@lzehrung/codegraph-native" },
      }),
      readFile: async () => "",
    });

    const output = await extract({
      filePath: "graph.ts",
      languageId: "ts",
      source: "import { a } from './a';\n",
      compact: true,
    });

    expect(registerQuerySet).toHaveBeenCalledWith("ts", getCachedNormalizedQuery(TS_SUPPORT, "imports"), "", "", "");
    expect(runImportsQueryCompact.mock.calls).toEqual([["import { a } from './a';\n", 3]]);
    expect(output.compactResults).toEqual({ imports: [] });
  });

  it("omits source only when the caller supplies the exact source", async () => {
    const extractLanguage = vi.fn(() => ({ results, syntaxTree }));
    const binding: NativeBinding = {
      registerQuerySet: () => 5,
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
    });

    expect(output.source).toBeUndefined();
    expect(extractLanguage).toHaveBeenCalledWith("export const owned = 1;\n", 5);
  });

  it("reports an unsupported language for one the binding parses but this build defines no queries for", async () => {
    const extractLanguage = vi.fn(() => ({ results, syntaxTree }));
    const binding: NativeBinding = {
      registerQuerySet: () => 1,
      extractLanguage,
      runLanguageQueries: vi.fn(() => results),
      supportedLanguageIds: () => ["ts", "klingon"],
    };
    const extract = createNativeExtractor({
      loadBinding: () => ({
        binding,
        origin: { mode: "workspace", packageName: "@lzehrung/codegraph-native" },
      }),
      readFile: async () => "",
    });

    const output = await extract({ filePath: "file.kl", languageId: "klingon", source: "qapla'" });

    expect(output.fallbackReason).toBe("unsupportedLanguage");
    expect(extractLanguage).not.toHaveBeenCalled();
  });

  it("reports an actionable version error for a native binary without extractLanguage", async () => {
    const binding: NativeBinding = {
      registerQuerySet: () => 1,
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
    });

    expect(output.fallbackReason).toBe("unavailable");
    // Read the required version from the source of truth so a bump cannot silently
    // leave this assertion pinned to a stale value.
    expect(output.error).toContain(`@lzehrung/codegraph-native >= ${REQUIRED_NATIVE_EXTRACTION_VERSION}`);
    expect(output.error).toContain("extractLanguage");
  });

  it("reports an actionable version error for a native binary that takes query text on every call", async () => {
    const extractLanguage = vi.fn(() => ({ results, syntaxTree }));
    const binding: NativeBinding = {
      registerQuerySet: () => 1,
      extractLanguage,
      runLanguageQueries: vi.fn(() => results),
      supportedLanguageIds: () => ["ts"],
    };
    Reflect.deleteProperty(binding, "registerQuerySet");
    const extract = createNativeExtractor({
      loadBinding: () => ({
        binding,
        origin: { mode: "workspace", packageName: "@lzehrung/codegraph-native" },
      }),
      readFile: async () => "",
    });

    const output = await extract({ filePath: "legacy.ts", languageId: "ts", source: "export const value = 1;\n" });

    expect(output.fallbackReason).toBe("unavailable");
    expect(output.error).toContain("registerQuerySet");
    expect(output.error).toContain("Reinstall the native package");
    expect(extractLanguage).not.toHaveBeenCalled();
  });

  it("rejects a native binary that returns the legacy syntax-tree shape", async () => {
    // A pre-columnar binary returns a tree without the typed-array columns. Build a
    // valid tree and drop a column at runtime, so the mock stays typed while the
    // structural probe sees exactly the legacy shape it exists to reject.
    const legacyTree = createStubNativeSyntaxTree();
    Reflect.deleteProperty(legacyTree, "kindIds");
    const binding: NativeBinding = {
      registerQuerySet: () => 1,
      extractLanguage: () => ({ results, syntaxTree: legacyTree }),
      runLanguageQueries: () => results,
      supportedLanguageIds: () => ["ts"],
    };
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
    });

    expect(output.fallbackReason).toBe("unavailable");
    expect(output.syntaxTree).toBeNull();
    // The tree failed to project, but the query results came from the same extractLanguage
    // call and are unaffected by the tree's shape, so they should still come back.
    expect(output.nativeResults).toEqual(results);
    expect(output.error).toContain(
      "The @lzehrung/codegraph-native version that ships with your Codegraph release is required",
    );
    expect(output.error).not.toContain(REQUIRED_NATIVE_EXTRACTION_VERSION);
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

    const output = await extract({ filePath: "reduced.ts", languageId: "ts" });

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
