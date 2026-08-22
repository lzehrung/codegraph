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
import {
  isColumnarSyntaxTree,
  nativeShapeMismatchMessage,
  REQUIRED_NATIVE_EXTRACTION_VERSION,
} from "../native/treeShape.js";
import type { NativeBindingLoadResult } from "../native/bindingLoader.js";

export type NativeExtractLimits = {
  /** Maximum UTF-8 source bytes accepted before native parsing. Default: 8 MiB. */
  maxSourceBytes?: number | undefined;
};

export type NativeExtractTask = {
  filePath: string;
  languageId: string;
  source?: string | undefined;
  /** Omit the source from the result only when the caller supplied the exact source above. */
  includeSourceInResult?: boolean | undefined;
  importsQuery: string;
  exportsQuery: string;
  localsQuery: string;
  importBindingsQuery: string;
  compact?: boolean | undefined;
  limits?: NativeExtractLimits | undefined;
};

export type NativeExtractResult = {
  filePath: string;
  languageId: string;
  source?: string | undefined;
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
export { REQUIRED_NATIVE_EXTRACTION_VERSION } from "../native/treeShape.js";

/**
 * Default source byte cap before native parse/projection.
 * 8 MiB is above virtually all hand-written sources while preventing a single
 * generated/minified file from OOM-ing a long-lived extraction worker.
 */
export const DEFAULT_NATIVE_SOURCE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Mirrored documentation of native projection defaults (enforced in Rust).
 * 250k nodes / depth 512: far above ordinary ASTs; fail closed on pathological trees.
 */
export const DEFAULT_NATIVE_MAX_PROJECTED_NODES = 250_000;
export const DEFAULT_NATIVE_MAX_PROJECTED_DEPTH = 512;

const require = createRequire(import.meta.url);
const localNativePackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/codegraph-native",
);

type NativeExtractorDeps = {
  loadBinding: () => NativeBindingLoadResult<NativeBinding>;
  readFile: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  statFile?: (filePath: string) => Promise<{ size: number }>;
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

function resolveSourceMaxBytes(task: NativeExtractTask): number {
  const configured = task.limits?.maxSourceBytes;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_NATIVE_SOURCE_MAX_BYTES;
}

function resourceLimitFallback(task: NativeExtractTask, source: string, error: string): NativeExtractResult {
  const includeSource = task.includeSourceInResult ?? true;
  return {
    filePath: task.filePath,
    languageId: task.languageId,
    ...(includeSource ? { source } : {}),
    nativeResults: null,
    compactResults: null,
    syntaxTree: null,
    fallbackReason: "queryFailure",
    error,
  };
}

export function createNativeExtractor(deps: NativeExtractorDeps): NativeExtractor {
  let binding: NativeBinding | null = null;
  let supportedIds: Set<string> | null = null;
  let loadError: string | undefined;

  function ensureBinding(): void {
    if (binding || loadError) return;
    const loaded = deps.loadBinding();
    if (loaded.binding) {
      if (typeof loaded.binding.extractLanguage !== "function") {
        loadError =
          `@lzehrung/codegraph-native >= ${REQUIRED_NATIVE_EXTRACTION_VERSION} is required; ` +
          "the installed native binary does not provide extractLanguage. Reinstall the native package.";
        return;
      }
      binding = loaded.binding;
      supportedIds = new Set(binding.supportedLanguageIds());
      return;
    }
    loadError =
      "native addon not available in worker" +
      (loaded.error ? `: ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}` : "");
  }

  async function loadSource(
    task: NativeExtractTask,
  ): Promise<{ ok: true; source: string } | { ok: false; source: string; error: string }> {
    const maxSourceBytes = resolveSourceMaxBytes(task);
    if (task.source !== undefined) {
      const bytes = Buffer.byteLength(task.source, "utf8");
      if (bytes > maxSourceBytes) {
        return {
          ok: false,
          source: task.source,
          error: `source exceeds native byte limit (${bytes} > ${maxSourceBytes})`,
        };
      }
      return { ok: true, source: task.source };
    }

    if (deps.statFile) {
      const stat = await deps.statFile(task.filePath);
      if (stat.size > maxSourceBytes) {
        return {
          ok: false,
          source: "",
          error: `source exceeds native byte limit (${stat.size} > ${maxSourceBytes})`,
        };
      }
    }

    const source = await deps.readFile(task.filePath, "utf8");
    const bytes = Buffer.byteLength(source, "utf8");
    if (bytes > maxSourceBytes) {
      return {
        ok: false,
        source: "",
        error: `source exceeds native byte limit (${bytes} > ${maxSourceBytes})`,
      };
    }
    return { ok: true, source };
  }

  return async function runExtraction(task: NativeExtractTask): Promise<NativeExtractResult> {
    ensureBinding();

    const loaded = await loadSource(task);
    if (!loaded.ok) {
      return resourceLimitFallback(task, loaded.source, loaded.error);
    }
    const includeSource = task.includeSourceInResult ?? true;
    const source = loaded.source;

    if (!binding || !supportedIds) {
      return {
        filePath: task.filePath,
        languageId: task.languageId,
        ...(includeSource ? { source } : {}),
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
        ...(includeSource ? { source } : {}),
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
          ...(includeSource ? { source } : {}),
          nativeResults: null,
          compactResults,
          syntaxTree: null,
        };
      }

      const extraction = binding.extractLanguage(
        source,
        task.languageId,
        task.importsQuery,
        task.exportsQuery,
        task.localsQuery,
        task.importBindingsQuery,
      );
      // A missing tree is a tolerated state downstream; a present-but-legacy tree is a
      // version mismatch this build cannot read, so only the latter fails the task.
      const syntaxTree = extraction.syntaxTree ?? null;
      if (syntaxTree !== null && !isColumnarSyntaxTree(syntaxTree)) {
        loadError = nativeShapeMismatchMessage();
        return {
          filePath: task.filePath,
          languageId: task.languageId,
          ...(includeSource ? { source } : {}),
          nativeResults: null,
          compactResults: null,
          syntaxTree: null,
          fallbackReason: "unavailable",
          error: loadError,
        };
      }
      return {
        filePath: task.filePath,
        languageId: task.languageId,
        ...(includeSource ? { source } : {}),
        nativeResults: extraction.results,
        compactResults: null,
        syntaxTree,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/max (node|depth) limit/i.test(message)) {
        return resourceLimitFallback(task, source, message);
      }
      return {
        filePath: task.filePath,
        languageId: task.languageId,
        ...(includeSource ? { source } : {}),
        nativeResults: null,
        compactResults: null,
        syntaxTree: null,
        fallbackReason: "queryFailure",
        error: message,
      };
    }
  };
}

const runExtraction = createNativeExtractor({
  loadBinding: loadProductionBinding,
  readFile: fsp.readFile,
  statFile: async (filePath) => {
    const stat = await fsp.stat(filePath);
    return { size: stat.size };
  },
});

export async function runExtractionBatch(
  batch: NativeExtractBatchTask,
  extract: NativeExtractor = runExtraction,
): Promise<NativeExtractBatchResult> {
  const results: NativeExtractResult[] = [];
  for (const task of batch.tasks) results.push(await extract(task));
  return { results };
}

export default async function runWorkerTask(
  task: NativeExtractTask | NativeExtractBatchTask,
): Promise<NativeExtractResult | NativeExtractBatchResult> {
  if ("tasks" in task) return await runExtractionBatch(task);
  return await runExtraction(task);
}
