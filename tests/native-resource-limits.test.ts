import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNativeExtractor,
  DEFAULT_NATIVE_MAX_PROJECTED_DEPTH,
  DEFAULT_NATIVE_MAX_PROJECTED_NODES,
  DEFAULT_NATIVE_SOURCE_MAX_BYTES,
} from "../src/worker/nativeExtractWorker.js";
import type { NativeBinding, NativeSyntaxTree } from "../src/native/contracts.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function emptyResults() {
  return { imports: [], exports: [], locals: [], importBindings: [] };
}

describe("native extraction resource limits", () => {
  it("documents exact default byte/node/depth caps", () => {
    // 8 MiB: above ordinary source, below sizes that routinely OOM workers.
    expect(DEFAULT_NATIVE_SOURCE_MAX_BYTES).toBe(8 * 1024 * 1024);
    // 250k nodes / depth 512: far above normal ASTs; fail closed on generated trees.
    expect(DEFAULT_NATIVE_MAX_PROJECTED_NODES).toBe(250_000);
    expect(DEFAULT_NATIVE_MAX_PROJECTED_DEPTH).toBe(512);
  });

  it("returns a structured fallback when provided source exceeds the byte cap", async () => {
    const runLanguageQueries = vi.fn(() => emptyResults());
    const extractor = createNativeExtractor({
      loadBinding: () => ({
        binding: {
          supportedLanguageIds: () => ["ts"],
          runLanguageQueries,
        } satisfies NativeBinding,
      }),
      readFile: async () => {
        throw new Error("should not read");
      },
    });

    const oversized = "x".repeat(DEFAULT_NATIVE_SOURCE_MAX_BYTES + 1);
    const result = await extractor({
      filePath: "huge.ts",
      languageId: "ts",
      source: oversized,
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
    });

    expect(result.nativeResults).toBeNull();
    expect(result.compactResults).toBeNull();
    expect(result.syntaxTree).toBeNull();
    expect(result.fallbackReason).toBe("queryFailure");
    expect(result.error).toMatch(/source exceeds native byte limit/i);
    expect(result.error).toContain(String(DEFAULT_NATIVE_SOURCE_MAX_BYTES));
    expect(runLanguageQueries).not.toHaveBeenCalled();
  });

  it("stats the file before reading when the on-disk size exceeds the configurable cap", async () => {
    const readFile = vi.fn(async () => "should not load");
    const runLanguageQueries = vi.fn(() => emptyResults());
    const extractor = createNativeExtractor({
      loadBinding: () => ({
        binding: {
          supportedLanguageIds: () => ["ts"],
          runLanguageQueries,
        } satisfies NativeBinding,
      }),
      readFile,
      statFile: async () => ({ size: 64 }),
    });

    const result = await extractor({
      filePath: "on-disk.ts",
      languageId: "ts",
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
      limits: { maxSourceBytes: 32 },
    });

    expect(result.fallbackReason).toBe("queryFailure");
    expect(result.error).toMatch(/source exceeds native byte limit \(64 > 32\)/);
    expect(readFile).not.toHaveBeenCalled();
    expect(runLanguageQueries).not.toHaveBeenCalled();
  });

  it("surfaces native projection depth/node limit errors as structured fallbacks", async () => {
    const extractor = createNativeExtractor({
      loadBinding: () => ({
        binding: {
          supportedLanguageIds: () => ["ts"],
          runLanguageQueries: () => emptyResults(),
          parseSyntaxTree: () => {
            throw new Error(`syntax tree projection exceeded max depth limit (${DEFAULT_NATIVE_MAX_PROJECTED_DEPTH})`);
          },
        } satisfies NativeBinding,
      }),
      readFile: async () => "export const value = 1;\n",
    });

    const result = await extractor({
      filePath: "deep.ts",
      languageId: "ts",
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
    });

    expect(result.fallbackReason).toBe("queryFailure");
    expect(result.nativeResults).toBeNull();
    expect(result.syntaxTree).toBeNull();
    expect(result.error).toMatch(/max depth limit/i);
  });

  it("keeps ordinary in-budget extraction successful", async () => {
    const tree: NativeSyntaxTree = { rootId: 0, nodes: [] };
    const extractor = createNativeExtractor({
      loadBinding: () => ({
        binding: {
          supportedLanguageIds: () => ["ts"],
          runLanguageQueries: () => emptyResults(),
          parseSyntaxTree: () => tree,
        } satisfies NativeBinding,
      }),
      readFile: async () => "export const value = 1;\n",
    });

    const result = await extractor({
      filePath: "ok.ts",
      languageId: "ts",
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
    });

    expect(result.fallbackReason).toBeUndefined();
    expect(result.nativeResults).toEqual(emptyResults());
    expect(result.syntaxTree).toBe(tree);
    expect(result.error).toBeUndefined();
  });
});
