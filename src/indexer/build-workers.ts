import { performance } from "node:perf_hooks";
import { isGraphOnlyLanguage } from "../documentLinks.js";
import type { LanguageSupport } from "../languages.js";
import { stringifyUnknown } from "../util/ast.js";
import { readConfinedUtf8File } from "../util/confinedFile.js";
import { recordNativeExecutionOutcome } from "../native/nativeBackendReport.js";
import {
  getCachedNormalizedQuery,
  getNativeWorkerBindingHandoff,
  isNativeRequiredUnavailableError,
  isNativeTreeSitterAvailable,
} from "../native/treeSitterNative.js";
import type {
  NativeExtractBatchResult,
  NativeExtractResult,
  NativeExtractTask,
} from "../worker/nativeExtractWorker.js";
import { DEFAULT_NATIVE_SOURCE_MAX_BYTES, NATIVE_WORKER_BATCH_SIZE } from "../worker/nativeExtractWorker.js";
import { prepareFileForIndexing, type PreparedFileContext } from "./parse-context.js";
import type { BuildOptions, BuildReport, WorkerPoolReport } from "./types.js";

/**
 * Files below which the pool costs more than it saves, so auto mode stays single-threaded.
 *
 * Measured on this repository (4 cores, 3 pool threads), cold builds of a fixed file list,
 * median of 3, workers on versus off:
 *
 * | files |  on |  off | delta  |
 * | ----- | --- | ---- | ------ |
 * |     4 | 264 |  165 | -60.0% |
 * |    16 | 413 |  327 | -26.3% |
 * |    24 | 456 |  455 |  -0.2% |
 * |    32 | 515 |  578 | +10.9% |
 * |    64 | 841 | 1124 | +25.2% |
 * |   256 | 2990| 4635 | +35.5% |
 *
 * The crossover is 24; 32 is the first size that is clearly past it. The plan's suggested 16
 * would have been 26% slower than no pool at all. The previous value, 250, was chosen when this
 * count meant "files in the project"; it now means "files this build will parse", and anything
 * from 32 up is measurably better with the pool than without.
 */
export const NATIVE_WORKER_AUTO_FILE_THRESHOLD = 32;

type NativeWorkerPool = {
  run(task: NativeExtractTask | { tasks: NativeExtractTask[] }): Promise<unknown>;
  destroy(): Promise<void>;
};

export type WorkerPoolSetupResult = {
  pool: NativeWorkerPool | null;
  report: WorkerPoolReport | undefined;
  startTime: number;
  batchSize: number;
};

export function shouldEnableNativeWorkers(opts: BuildOptions | undefined, fileCount?: number): boolean {
  if (opts?.native === "off") return false;
  // No files to parse means no work to distribute. Piscina starts minThreads eagerly, so an
  // explicit request would otherwise spawn a full pool for a warm no-change run and tear it
  // down again without ever submitting a task.
  if (fileCount === 0) return false;
  if (!isNativeTreeSitterAvailable(opts?.native)) return false;
  if (opts?.useNativeWorkers === false) return false;
  if (opts?.useNativeWorkers === true) return true;
  return (fileCount ?? 0) >= NATIVE_WORKER_AUTO_FILE_THRESHOLD;
}

/**
 * A setup carrying no pool, for the window before one is created. Teardown accepts it, so the
 * caller can install its `finally` before deciding whether any worker is warranted.
 */
export function emptyWorkerPoolSetup(): WorkerPoolSetupResult {
  return { pool: null, report: undefined, startTime: 0, batchSize: NATIVE_WORKER_BATCH_SIZE };
}

function isSFCFile(filePath: string): boolean {
  return filePath.endsWith(".vue") || filePath.endsWith(".svelte") || filePath.endsWith(".astro");
}

function buildWorkerTask(filePath: string, sup: LanguageSupport, source?: string): NativeExtractTask {
  return {
    filePath,
    languageId: sup.id,
    ...(source !== undefined ? { source, includeSourceInResult: false } : {}),
    importsQuery: getCachedNormalizedQuery(sup, "imports"),
    exportsQuery: getCachedNormalizedQuery(sup, "exports"),
    localsQuery: getCachedNormalizedQuery(sup, "locals"),
    importBindingsQuery: getCachedNormalizedQuery(sup, "importBindings"),
  };
}

function workerResultToPrepared(
  result: NativeExtractResult,
  sup: LanguageSupport,
  filePath: string,
  ownedSource?: string,
): PreparedFileContext {
  const source = result.source ?? ownedSource;
  if (source === undefined) {
    throw new Error(`Native worker omitted source for ${filePath} without caller-owned content.`);
  }
  return {
    file: filePath,
    source,
    sup,
    nativeQueries: result.nativeResults,
    syntaxTree: result.syntaxTree,
    ...(result.fallbackReason ? { nativeFallbackReason: result.fallbackReason } : {}),
    ...(result.error ? { nativeError: result.error } : {}),
  };
}

export async function setupWorkerPool(
  opts: BuildOptions | undefined,
  fileCount?: number,
): Promise<WorkerPoolSetupResult> {
  const shouldUseWorkers = shouldEnableNativeWorkers(opts, fileCount);
  const report: WorkerPoolReport | undefined =
    shouldUseWorkers || opts?.useNativeWorkers !== undefined
      ? {
          enabled: shouldUseWorkers,
          threads: 0,
          tasksSubmitted: 0,
          tasksFailed: 0,
        }
      : undefined;
  let pool: import("piscina").Piscina | null = null;
  if (shouldUseWorkers) {
    try {
      const { createNativeWorkerPool } = await import("../worker/nativeWorkerPool.js");
      // shouldEnableNativeWorkers has already resolved the binding on this thread, so the
      // handoff is available here and saves every worker from repeating that resolution.
      const handoff = getNativeWorkerBindingHandoff();
      const createdPool = createNativeWorkerPool({
        threads: opts?.nativeThreads,
        // More threads than files means threads that bootstrap, idle, and exit having parsed
        // nothing, which on a small incremental build is the whole cost of the pool.
        ...(typeof fileCount === "number" && fileCount > 0 ? { maxThreads: fileCount } : {}),
        ...(handoff ? { workerData: { nativeBinding: handoff } } : {}),
      });
      pool = createdPool;
      if (report) {
        report.threads = (createdPool.options as { maxThreads?: number }).maxThreads ?? 0;
      }
    } catch (error) {
      pool = null;
      if (report) {
        report.enabled = false;
        report.startupError = stringifyUnknown(error);
      }
    }
  }
  return {
    pool,
    report,
    startTime: pool ? performance.now() : 0,
    batchSize: NATIVE_WORKER_BATCH_SIZE,
  };
}

export async function teardownWorkerPool(
  setup: WorkerPoolSetupResult,
  buildReport: BuildReport | undefined,
): Promise<void> {
  if (setup.pool) {
    if (setup.report) {
      setup.report.wallClockMs = Math.round(performance.now() - setup.startTime);
    }
    try {
      await setup.pool.destroy();
    } catch {
      // non-fatal
    }
    setup.pool = null;
  }
  if (buildReport && setup.report) {
    buildReport.workerPool = setup.report;
  }
}

function recordPreparedNativeExecutionOutcome(report: BuildReport | undefined, prepared: PreparedFileContext): void {
  if (isGraphOnlyLanguage(prepared.sup.id)) return;
  recordNativeExecutionOutcome(report, {
    file: prepared.file,
    support: prepared.sup,
    languageId: prepared.sup.id,
    results: prepared.nativeQueries,
    ...(prepared.nativeFallbackReason ? { fallbackReason: prepared.nativeFallbackReason } : {}),
    ...(prepared.nativeError ? { error: prepared.nativeError } : {}),
  });
}

function createOversizedNativeSourceFallback(
  file: string,
  support: LanguageSupport,
  source: string,
): PreparedFileContext {
  const bytes = Buffer.byteLength(source, "utf8");
  return {
    file,
    source,
    sup: support,
    nativeQueries: null,
    nativeFallbackReason: "queryFailure",
    nativeError: `source exceeds native byte limit (${bytes} > ${DEFAULT_NATIVE_SOURCE_MAX_BYTES})`,
  };
}

export async function prepareFileContextForBuild(
  file: string,
  support: LanguageSupport,
  opts: BuildOptions | undefined,
  workerSetup: WorkerPoolSetupResult,
  report: BuildReport | undefined,
  confinedRoot?: string,
  lexicalRoot?: string,
  trustedSource?: string,
): Promise<PreparedFileContext> {
  const source =
    trustedSource ??
    (confinedRoot ? await readConfinedUtf8File(confinedRoot, lexicalRoot ?? confinedRoot, file) : undefined);
  if (source && Buffer.byteLength(source, "utf8") > DEFAULT_NATIVE_SOURCE_MAX_BYTES) {
    const prepared = createOversizedNativeSourceFallback(file, support, source);
    recordPreparedNativeExecutionOutcome(report, prepared);
    return prepared;
  }
  let prepared: PreparedFileContext;
  if (workerSetup.pool && !isSFCFile(file) && !isGraphOnlyLanguage(support.id)) {
    if (workerSetup.report) workerSetup.report.tasksSubmitted++;
    try {
      const workerResult = (await workerSetup.pool.run(buildWorkerTask(file, support, source))) as NativeExtractResult;
      prepared = workerResultToPrepared(workerResult, support, file, source);
    } catch (error) {
      if (isNativeRequiredUnavailableError(error) && error instanceof Error) throw error;
      if (workerSetup.report) workerSetup.report.tasksFailed++;
      if (workerSetup.report) {
        workerSetup.report.errors ??= [];
        if (workerSetup.report.errors.length < 20) {
          workerSetup.report.errors.push({ file, message: stringifyUnknown(error) });
        }
      }
      prepared = await prepareFileForIndexing(file, opts?.native, opts?.languageExtensions, source);
    }
  } else {
    prepared = await prepareFileForIndexing(file, opts?.native, opts?.languageExtensions, source);
  }
  recordPreparedNativeExecutionOutcome(report, prepared);
  return prepared;
}

export async function prepareFileContextsForBuildBatch(
  files: readonly { file: string; support: LanguageSupport }[],
  opts: BuildOptions | undefined,
  workerSetup: WorkerPoolSetupResult,
  report: BuildReport | undefined,
): Promise<PreparedFileContext[]> {
  if (!workerSetup.pool || files.length === 0) {
    const out: PreparedFileContext[] = [];
    for (const entry of files) {
      out.push(await prepareFileContextForBuild(entry.file, entry.support, opts, workerSetup, report));
    }
    return out;
  }

  const results: PreparedFileContext[] = new Array(files.length);
  const batchable: Array<{ index: number; file: string; support: LanguageSupport; task: NativeExtractTask }> = [];
  for (const [index, entry] of files.entries()) {
    if (isSFCFile(entry.file) || isGraphOnlyLanguage(entry.support.id)) {
      results[index] = await prepareFileContextForBuild(entry.file, entry.support, opts, workerSetup, report);
      continue;
    }
    batchable.push({
      index,
      file: entry.file,
      support: entry.support,
      task: buildWorkerTask(entry.file, entry.support),
    });
  }

  for (let offset = 0; offset < batchable.length; offset += workerSetup.batchSize) {
    const slice = batchable.slice(offset, offset + workerSetup.batchSize);
    if (workerSetup.report) workerSetup.report.tasksSubmitted += slice.length;
    let batchResult: NativeExtractBatchResult | undefined;
    let batchError: unknown;
    try {
      batchResult = (await workerSetup.pool.run({
        tasks: slice.map((entry) => entry.task),
      })) as NativeExtractBatchResult;
    } catch (error) {
      batchError = error;
    }
    for (const [index, entry] of slice.entries()) {
      const result = batchResult?.results[index];
      if (batchError !== undefined || result === undefined) {
        const error = batchError ?? new Error("Native worker returned no result for batch task.");
        if (isNativeRequiredUnavailableError(error) && error instanceof Error) throw error;
        if (workerSetup.report) {
          workerSetup.report.tasksFailed++;
          workerSetup.report.errors ??= [];
          if (workerSetup.report.errors.length < 20) {
            workerSetup.report.errors.push({ file: entry.file, message: stringifyUnknown(error) });
          }
        }
        const prepared = await prepareFileForIndexing(entry.file, opts?.native, opts?.languageExtensions);
        recordPreparedNativeExecutionOutcome(report, prepared);
        results[entry.index] = prepared;
        continue;
      }
      const prepared = workerResultToPrepared(result, entry.support, entry.file);
      recordPreparedNativeExecutionOutcome(report, prepared);
      results[entry.index] = prepared;
    }
  }

  return results;
}
