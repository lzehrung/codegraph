import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, workerData } from "node:worker_threads";

import type {
  CompactQueryResults,
  NativeBinding,
  NativeBindingOrigin,
  NativeFallbackReason,
  NativeQueryResults,
  NativeSyntaxTree,
  NativeWorkerBindingHandoff,
} from "../native/contracts.js";
import type { ModuleRecordFallback, ModuleRecordPayload, ModuleRecordTask } from "../indexer/module-record.js";
import type * as ModuleRecords from "../indexer/module-record.js";
import type * as ProjectedTrees from "../native/projected-tree.js";
import type { LanguageSupport } from "../languages.js";
import { loadNativeBinding } from "../native/binding-loader.js";
import { getNativeQuerySetId } from "../native/queries.js";
import {
  isColumnarSyntaxTree,
  nativeQuerySetsUnavailableMessage,
  nativeShapeMismatchMessage,
  REQUIRED_NATIVE_EXTRACTION_VERSION,
} from "../native/tree-shape.js";
import type { NativeBindingLoadResult } from "../native/binding-loader.js";
import { adoptLoadedNativeBinding } from "../native/runtime.js";
import { supportById } from "../languages.js";
import { buildBloomFilterFromSource } from "../util/bloom-filter.js";
import { DEFAULT_NATIVE_SOURCE_MAX_BYTES } from "../native/source-limits.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import { collectProjectFileFacts, JVM_PACKAGE_HEAD_CHARS, type ProjectFileFacts } from "../util/project-file-facts.js";
import { isJvmLanguage, readsSyntaxTree } from "../util/syntax-tree.js";

export type NativeBloomFilterPayload = {
  bits: Uint8Array;
  size: number;
  hashCount: number;
  itemCount: number;
};

function buildBloomFilterPayload(source: string, languageId: string): NativeBloomFilterPayload | undefined {
  const support = supportById(languageId);
  if (!support) return undefined;
  const filter = buildBloomFilterFromSource(source, support);
  const { size, hashCount } = filter.getMetadata();
  return {
    bits: filter.toBuffer(),
    size,
    hashCount,
    itemCount: filter.getItemCount(),
  };
}

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
  includeBloomFilter?: boolean | undefined;
  compact?: boolean | undefined;
  limits?: NativeExtractLimits | undefined;
  /** Reads only project-scan facts for a file outside module extraction; returns neither source nor tree. */
  projectFactsOnly?: boolean | undefined;
  /**
   * Build the file's module record (`module-record.ts`) from this extraction and return it in place of the native
   * results and the syntax tree. A file the record does not cover returns the extraction as usual.
   */
  moduleRecord?: ModuleRecordTask | undefined;
};

export type NativeExtractResult = {
  filePath: string;
  languageId: string;
  source?: string | undefined;
  nativeResults: NativeQueryResults | null;
  compactResults: CompactQueryResults | null;
  syntaxTree: NativeSyntaxTree | null;
  bloomFilter?: NativeBloomFilterPayload;
  fallbackReason?: NativeFallbackReason;
  error?: string;
  /** The file's encoded module record, when the task asked for one. The native results and tree are then null. */
  moduleRecord?: ModuleRecordPayload;
  /** Why the task asked for a module record and got the extraction instead. */
  moduleRecordFallback?: ModuleRecordFallback;
  projectFacts?: ProjectFileFacts;
};

export type NativeExtractBatchTask = {
  tasks: NativeExtractTask[];
};

export type NativeExtractBatchResult = {
  results: NativeExtractResult[];
};

export const NATIVE_WORKER_BATCH_SIZE = 32;
export { REQUIRED_NATIVE_EXTRACTION_VERSION } from "../native/tree-shape.js";

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
  readPackageHead?: (filePath: string) => Promise<string>;
  /** Called once with the binding the extractor loaded and accepted. */
  onBindingLoaded?: (loaded: { binding: NativeBinding; origin: NativeBindingOrigin }) => void;
};

let moduleRecordModules: Promise<[typeof ModuleRecords, typeof ProjectedTrees]> | undefined;

/** The module record code loads in a worker only once a task asks for a record. */
function loadModuleRecordModules(): Promise<[typeof ModuleRecords, typeof ProjectedTrees]> {
  moduleRecordModules ??= Promise.all([import("../indexer/module-record.js"), import("../native/projected-tree.js")]);
  return moduleRecordModules;
}

/**
 * Builds the module record a task asked for from the file's extraction. The record takes the place of the native
 * results and the syntax tree; a file the record does not cover keeps the extraction and says why.
 */
async function withModuleRecord(
  recordTask: ModuleRecordTask,
  task: NativeExtractTask,
  support: LanguageSupport,
  source: string,
  extracted: NativeExtractResult,
): Promise<NativeExtractResult> {
  if (!extracted.syntaxTree || !extracted.nativeResults) return extracted;
  const [records, trees] = await loadModuleRecordModules();
  const outcome = await records.buildModuleRecord({
    ...recordTask,
    file: task.filePath,
    source,
    support,
    nativeQueries: extracted.nativeResults,
    tree: new trees.ProjectedSyntaxTree(source, extracted.syntaxTree),
  });
  if ("fallback" in outcome) return { ...extracted, moduleRecordFallback: outcome.fallback };
  return {
    filePath: task.filePath,
    languageId: task.languageId,
    nativeResults: null,
    compactResults: null,
    syntaxTree: null,
    ...(extracted.bloomFilter ? { bloomFilter: extracted.bloomFilter } : {}),
    moduleRecord: records.encodeModuleRecord(outcome.record),
  };
}

export type NativeExtractor = (task: NativeExtractTask) => Promise<NativeExtractResult>;

/**
 * The addon the parent thread already resolved, verified, and loaded, if it passed one.
 *
 * Absent when this module is imported outside a worker (tests, direct use), or by a parent that
 * had no loaded binding to offer. Both cases fall through to the full resolution below.
 */
export function readWorkerBindingHandoff(
  source: unknown = isMainThread ? undefined : workerData,
): NativeWorkerBindingHandoff | null {
  if (!source || typeof source !== "object") return null;
  const candidate = (source as { nativeBinding?: unknown }).nativeBinding;
  if (!candidate || typeof candidate !== "object") return null;
  const { loadedPath, origin } = candidate as Partial<NativeWorkerBindingHandoff>;
  if (typeof loadedPath !== "string" || !loadedPath) return null;
  if (!origin || typeof origin !== "object" || typeof origin.packageName !== "string") return null;
  return { loadedPath, origin };
}

export function loadProductionBinding(
  handoffSource: unknown = isMainThread ? undefined : workerData,
): NativeBindingLoadResult<NativeBinding> {
  const handoff = readWorkerBindingHandoff(handoffSource);
  if (handoff) {
    try {
      // path.resolve puts the separators back in the platform's form; the parent normalizes
      // them to forward slashes when it builds the origin.
      return { binding: require(path.resolve(handoff.loadedPath)) as NativeBinding, origin: handoff.origin };
    } catch {
      // A handoff that will not load is a bug worth surviving rather than failing the build on:
      // fall through and resolve the addon the long way, exactly as before.
    }
  }
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

function resourceLimitFallback(
  task: NativeExtractTask,
  source: string,
  error: string,
  reason: NativeFallbackReason,
  bloomFilter?: NativeBloomFilterPayload,
): NativeExtractResult {
  const includeSource = !task.projectFactsOnly && (task.includeSourceInResult ?? true);
  return {
    filePath: task.filePath,
    languageId: task.languageId,
    ...(includeSource ? { source } : {}),
    nativeResults: null,
    compactResults: null,
    syntaxTree: null,
    ...(bloomFilter ? { bloomFilter } : {}),
    fallbackReason: reason,
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
      if (typeof loaded.binding.registerQuerySet !== "function") {
        loadError = nativeQuerySetsUnavailableMessage();
        return;
      }
      binding = loaded.binding;
      supportedIds = new Set(binding.supportedLanguageIds());
      deps.onBindingLoaded?.({ binding: loaded.binding, origin: loaded.origin });
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

  async function withProjectFacts(
    task: NativeExtractTask,
    source: string,
    extracted: NativeExtractResult,
  ): Promise<NativeExtractResult> {
    if (!readsSyntaxTree(task.languageId)) return extracted;
    let factsSource = source;
    // Oversized files are rejected before reading. JVM scans still need their bounded package-only fallback.
    if (!source && extracted.fallbackReason === "sourceTooLarge" && isJvmLanguage(task.languageId)) {
      if (task.source !== undefined) factsSource = task.source;
      else if (deps.readPackageHead) factsSource = await deps.readPackageHead(task.filePath);
      else factsSource = await deps.readFile(task.filePath, "utf8");
    }
    const tree = extracted.syntaxTree ? new ProjectedSyntaxTree(source, extracted.syntaxTree) : null;
    const projectFacts = collectProjectFileFacts(factsSource, task.languageId, tree, (head, languageId) => {
      const syntaxTree = binding?.parseSyntaxTree?.(head, languageId);
      return syntaxTree && isColumnarSyntaxTree(syntaxTree) ? new ProjectedSyntaxTree(head, syntaxTree) : null;
    });
    return { ...extracted, ...(projectFacts ? { projectFacts } : {}) };
  }

  return async function runExtraction(task: NativeExtractTask): Promise<NativeExtractResult> {
    ensureBinding();

    const loaded = await loadSource(task);
    if (!loaded.ok) {
      return await withProjectFacts(
        task,
        loaded.source,
        resourceLimitFallback(task, loaded.source, loaded.error, "sourceTooLarge"),
      );
    }
    const includeSource = !task.projectFactsOnly && (task.includeSourceInResult ?? true);
    const source = loaded.source;
    const bloomFilter = task.includeBloomFilter ? buildBloomFilterPayload(source, task.languageId) : undefined;

    if (!binding || !supportedIds) {
      return {
        filePath: task.filePath,
        languageId: task.languageId,
        ...(includeSource ? { source } : {}),
        nativeResults: null,
        compactResults: null,
        syntaxTree: null,
        ...(bloomFilter ? { bloomFilter } : {}),
        fallbackReason: "unavailable",
        ...(loadError ? { error: loadError } : {}),
      };
    }

    // The binding parses the language, but only a language this build defines has queries to run.
    const support = supportById(task.languageId);
    if (!support || !supportedIds.has(task.languageId)) {
      return {
        filePath: task.filePath,
        languageId: task.languageId,
        ...(includeSource ? { source } : {}),
        nativeResults: null,
        compactResults: null,
        syntaxTree: null,
        ...(bloomFilter ? { bloomFilter } : {}),
        fallbackReason: "unsupportedLanguage",
      };
    }

    let extracted: NativeExtractResult;
    try {
      if (task.projectFactsOnly) {
        const syntaxTree = binding.parseSyntaxTree?.(source, task.languageId);
        if (!syntaxTree || !isColumnarSyntaxTree(syntaxTree)) throw new Error(nativeShapeMismatchMessage());
        const facts = await withProjectFacts(task, source, {
          filePath: task.filePath,
          languageId: task.languageId,
          nativeResults: null,
          compactResults: null,
          syntaxTree,
        });
        return { ...facts, syntaxTree: null };
      }
      if (task.compact && binding.runImportsQueryCompact) {
        const compactResults = binding.runImportsQueryCompact(source, getNativeQuerySetId(binding, support, "imports"));
        return {
          filePath: task.filePath,
          languageId: task.languageId,
          ...(includeSource ? { source } : {}),
          nativeResults: null,
          compactResults,
          syntaxTree: null,
          ...(bloomFilter ? { bloomFilter } : {}),
        };
      }

      const extraction = binding.extractLanguage(source, getNativeQuerySetId(binding, support, "full"));
      // A missing tree is a tolerated state downstream; a present-but-legacy tree is a
      // version mismatch this build cannot read, so only the latter fails the task. The
      // query results came from the same extractLanguage call and are unaffected by the
      // tree's shape, so they still come back -- matching getNativeExtractionExecution's
      // handling of the same mismatch on the non-worker path.
      const syntaxTree = extraction.syntaxTree ?? null;
      if (syntaxTree !== null && !isColumnarSyntaxTree(syntaxTree)) {
        loadError = nativeShapeMismatchMessage();
        return {
          filePath: task.filePath,
          languageId: task.languageId,
          ...(includeSource ? { source } : {}),
          nativeResults: extraction.results,
          compactResults: null,
          syntaxTree: null,
          ...(bloomFilter ? { bloomFilter } : {}),
          fallbackReason: "unavailable",
          error: loadError,
        };
      }
      extracted = {
        filePath: task.filePath,
        languageId: task.languageId,
        ...(includeSource ? { source } : {}),
        nativeResults: extraction.results,
        compactResults: null,
        syntaxTree,
        ...(bloomFilter ? { bloomFilter } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/max (node|depth) limit/i.test(message)) {
        return await withProjectFacts(
          task,
          source,
          resourceLimitFallback(task, source, message, "queryFailure", bloomFilter),
        );
      }
      return await withProjectFacts(task, source, {
        filePath: task.filePath,
        languageId: task.languageId,
        ...(includeSource ? { source } : {}),
        nativeResults: null,
        compactResults: null,
        syntaxTree: null,
        ...(bloomFilter ? { bloomFilter } : {}),
        fallbackReason: "queryFailure",
        error: message,
      });
    }
    if (readsSyntaxTree(task.languageId)) extracted = await withProjectFacts(task, source, extracted);
    return task.moduleRecord ? await withModuleRecord(task.moduleRecord, task, support, source, extracted) : extracted;
  };
}

const runExtraction = createNativeExtractor({
  loadBinding: loadProductionBinding,
  readFile: fsp.readFile,
  readPackageHead: async (filePath) => {
    const file = await fsp.open(filePath, "r");
    try {
      // UTF-8 needs at most three bytes per UTF-16 unit. Look ahead past the prefix (and an optional BOM), so the
      // shared whole-line cutoff cannot mistake a truncated package clause for the end of the source.
      const buffer = Buffer.allocUnsafe(3 * (JVM_PACKAGE_HEAD_CHARS + 2));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return buffer.toString("utf8", 0, offset);
    } finally {
      await file.close();
    }
  },
  statFile: async (filePath) => {
    const stat = await fsp.stat(filePath);
    return { size: stat.size };
  },
  // Module records run indexing code that reaches the native runtime, which then uses the addon this worker loaded.
  ...(isMainThread ? {} : { onBindingLoaded: adoptLoadedNativeBinding }),
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
