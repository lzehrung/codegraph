import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CompactQueryResults,
  NativeBinding,
  NativeFallbackReason,
  NativeQueryResults,
  NativeSyntaxTree,
} from "../native/contracts.js";
import { loadNativeBinding } from "../native/bindingLoader.js";
import type { NativeBindingLoadResult } from "../native/bindingLoader.js";

export type NativeExtractTask = {
  filePath: string;
  languageId: string;
  source?: string | undefined;
  importsQuery: string;
  exportsQuery: string;
  localsQuery: string;
  importBindingsQuery: string;
  compact?: boolean | undefined;
};

export type NativeExtractResult = {
  filePath: string;
  languageId: string;
  source: string;
  nativeResults: NativeQueryResults | null;
  compactResults: CompactQueryResults | null;
  syntaxTree: NativeSyntaxTree | null;
  fallbackReason?: NativeFallbackReason;
  error?: string;
};

export type NativeExtractBatchTask = {
  tasks: NativeExtractTask[];
};

export type NativeExtractBatchResult = {
  results: NativeExtractResult[];
};

export const NATIVE_WORKER_BATCH_SIZE = 32;

const require = createRequire(import.meta.url);
const localNativePackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/codegraph-native",
);

type NativeExtractorDeps = {
  loadBinding: () => NativeBindingLoadResult<NativeBinding>;
  readFile: (filePath: string, encoding: BufferEncoding) => Promise<string>;
};

export type NativeExtractor = (task: NativeExtractTask) => Promise<NativeExtractResult>;

export function loadProductionBinding(): NativeBindingLoadResult<NativeBinding> {
  return loadNativeBinding<NativeBinding>({
    packageName: "@lzehrung/codegraph-native",
    localPackageRoot: localNativePackageRoot,
    requireFn: require,
    resolveFn: require.resolve,
  });
}

export function createNativeExtractor(deps: NativeExtractorDeps): NativeExtractor {
  let binding: NativeBinding | null = null;
  let supportedIds: Set<string> | null = null;
  let loadError: string | undefined;

  function ensureBinding(): void {
    if (binding || loadError) return;
    const loaded = deps.loadBinding();
    if (loaded.binding) {
      binding = loaded.binding;
      supportedIds = new Set(binding.supportedLanguageIds());
      return;
    }
    loadError =
      "native addon not available in worker" +
      (loaded.error ? `: ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}` : "");
  }

  return async function runExtraction(task: NativeExtractTask): Promise<NativeExtractResult> {
    ensureBinding();

    const source = task.source ?? (await deps.readFile(task.filePath, "utf8"));

    if (!binding || !supportedIds) {
      return {
        filePath: task.filePath,
        languageId: task.languageId,
        source,
        nativeResults: null,
        compactResults: null,
        syntaxTree: null,
        fallbackReason: "unavailable",
        ...(loadError ? { error: loadError } : {}),
      };
    }

    if (!supportedIds.has(task.languageId)) {
      return {
        filePath: task.filePath,
        languageId: task.languageId,
        source,
        nativeResults: null,
        compactResults: null,
        syntaxTree: null,
        fallbackReason: "unsupportedLanguage",
      };
    }

    try {
      if (task.compact && binding.runImportsQueryCompact) {
        const compactResults = binding.runImportsQueryCompact(source, task.languageId, task.importsQuery);
        return {
          filePath: task.filePath,
          languageId: task.languageId,
          source,
          nativeResults: null,
          compactResults,
          syntaxTree: null,
        };
      }

      const nativeResults = binding.runLanguageQueries(
        source,
        task.languageId,
        task.importsQuery,
        task.exportsQuery,
        task.localsQuery,
        task.importBindingsQuery,
      );
      let syntaxTree: NativeSyntaxTree | null = null;
      if (binding.parseSyntaxTree) {
        try {
          syntaxTree = binding.parseSyntaxTree(source, task.languageId);
        } catch {
          syntaxTree = null;
        }
      }
      return {
        filePath: task.filePath,
        languageId: task.languageId,
        source,
        nativeResults,
        compactResults: null,
        syntaxTree,
      };
    } catch (err) {
      return {
        filePath: task.filePath,
        languageId: task.languageId,
        source,
        nativeResults: null,
        compactResults: null,
        syntaxTree: null,
        fallbackReason: "queryFailure",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

const runExtraction = createNativeExtractor({
  loadBinding: loadProductionBinding,
  readFile: fsp.readFile,
});

export async function runExtractionBatch(batch: NativeExtractBatchTask): Promise<NativeExtractBatchResult> {
  const results: NativeExtractResult[] = [];
  for (const task of batch.tasks) {
    results.push(await runExtraction(task));
  }
  return { results };
}

export default async function runWorkerTask(
  task: NativeExtractTask | NativeExtractBatchTask,
): Promise<NativeExtractResult | NativeExtractBatchResult> {
  if ("tasks" in task) return await runExtractionBatch(task);
  return await runExtraction(task);
}
