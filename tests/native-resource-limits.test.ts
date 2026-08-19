import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNativeExtractor,
  DEFAULT_NATIVE_MAX_PROJECTED_DEPTH,
  DEFAULT_NATIVE_MAX_PROJECTED_NODES,
  DEFAULT_NATIVE_SOURCE_MAX_BYTES,
  runExtractionBatch,
} from "../src/worker/nativeExtractWorker.js";
import { buildProjectIndexFromFiles } from "../src/indexer/build-index.js";
import { cacheSignatureForFile, fileSignature, writeToCache } from "../src/indexer/build-cache/module-cache.js";
import { isNativeTreeSitterAvailable } from "../src/native/treeSitterNative.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
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

  it("serializes batch extraction to bound source residency", async () => {
    let active = 0;
    let maximumActive = 0;
    const task = {
      filePath: "sample.ts",
      languageId: "ts",
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
    };

    const result = await runExtractionBatch({ tasks: [task, task] }, async (currentTask) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        filePath: currentTask.filePath,
        languageId: currentTask.languageId,
        nativeResults: null,
        compactResults: null,
        syntaxTree: null,
      };
    });

    expect(result.results).toHaveLength(2);
    expect(maximumActive).toBe(1);
  });

  it("returns a structured fallback when provided source exceeds the byte cap", async () => {
    const extractLanguage = vi.fn(() => ({ results: emptyResults(), syntaxTree: null }));
    const extractor = createNativeExtractor({
      loadBinding: () => ({
        binding: {
          supportedLanguageIds: () => ["ts"],
          runLanguageQueries: () => emptyResults(),
          extractLanguage,
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
    expect(extractLanguage).not.toHaveBeenCalled();
    expect(result.source).toBe(oversized);
  });

  it("stats the file before reading when the on-disk size exceeds the configurable cap", async () => {
    const readFile = vi.fn(async () => "should not load");
    const extractLanguage = vi.fn(() => ({ results: emptyResults(), syntaxTree: null }));
    const extractor = createNativeExtractor({
      loadBinding: () => ({
        binding: {
          supportedLanguageIds: () => ["ts"],
          runLanguageQueries: () => emptyResults(),
          extractLanguage,
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
    expect(extractLanguage).not.toHaveBeenCalled();
  });

  it("surfaces native projection depth/node limit errors as structured fallbacks", async () => {
    const extractor = createNativeExtractor({
      loadBinding: () => ({
        binding: {
          supportedLanguageIds: () => ["ts"],
          runLanguageQueries: () => emptyResults(),
          extractLanguage: () => {
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
          extractLanguage: () => ({ results: emptyResults(), syntaxTree: tree }),
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

describe.runIf(isNativeTreeSitterAvailable())("resource-limited worker cache behavior", () => {
  it("does not persist or reuse an empty module after a byte-limit fallback", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-resource-limit-cache-"));
    const file = path.join(root, "oversized.ts");
    const normalizedFile = normalizePath(file);
    const source = `export const retained = 1;\n${"// filler\n".repeat(Math.ceil(DEFAULT_NATIVE_SOURCE_MAX_BYTES / 10))}`;
    await fsp.writeFile(file, source, "utf8");

    try {
      const firstReport = { timings: {} };
      const first = await buildProjectIndexFromFiles(root, [file], {
        cache: "disk",
        native: "on",
        nativeThreads: 1,
        useNativeWorkers: true,
        report: firstReport,
      });
      expect(first.byFile.get(fileIdentityKey(normalizedFile))?.locals).toEqual([]);
      expect(firstReport.backend?.native.filesFellBack).toBe(1);
      expect(firstReport.backend?.native.errors[0]?.file).toBe(normalizedFile);

      const db = new DatabaseSync(path.join(root, ".codegraph-cache", "index-v1", "index-cache.sqlite"), {
        readOnly: true,
      });
      try {
        const row = db.prepare("SELECT file FROM module_cache WHERE file = ?").get(normalizedFile);
        expect(row).toBeUndefined();
      } finally {
        db.close();
      }

      const secondReport = { timings: {} };
      await buildProjectIndexFromFiles(root, [file], {
        cache: "disk",
        native: "on",
        nativeThreads: 1,
        useNativeWorkers: true,
        report: secondReport,
      });
      expect(secondReport.cache?.hits).toBe(0);
      expect(secondReport.workerPool?.tasksSubmitted).toBe(0);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe.runIf(isNativeTreeSitterAvailable())("module cache upgrade behavior", () => {
  it("rejects an older empty cache artifact whose implementation fingerprint differs", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-resource-limit-upgrade-"));
    const file = path.join(root, "sample.ts");
    const normalizedFile = normalizePath(file);
    await fsp.writeFile(file, "export const retained = 1;\n", "utf8");

    try {
      const signature = await fileSignature(file, true);
      const currentCacheSignature = await cacheSignatureForFile(file, signature, { native: "on" });
      const separator = currentCacheSignature.lastIndexOf(":");
      expect(separator).toBeGreaterThan(0);
      const legacyCacheSignature = `${currentCacheSignature.slice(0, separator)}:${"0".repeat(64)}`;
      writeToCache(
        root,
        normalizedFile,
        legacyCacheSignature,
        { file: normalizedFile, exports: [], imports: [], locals: [] },
        { cache: "disk", native: "on" },
      );

      const report = { timings: {} };
      const index = await buildProjectIndexFromFiles(root, [file], {
        cache: "disk",
        native: "on",
        nativeThreads: 1,
        useNativeWorkers: true,
        report,
      });

      expect(report.cache?.hits).toBe(0);
      expect(index.byFile.get(fileIdentityKey(normalizedFile))?.locals.map((symbol) => symbol.localName)).toContain(
        "retained",
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
