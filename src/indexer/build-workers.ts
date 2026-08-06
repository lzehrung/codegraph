import { performance } from "node:perf_hooks";
import { isGraphOnlyLanguage } from "../documentLinks.js";
import type { LanguageSupport } from "../languages.js";
import { stringifyUnknown } from "../util/ast.js";
import { recordNativeExecutionOutcome } from "../native/nativeBackendReport.js";
import {
  getCachedNormalizedQuery,
  isNativeRequiredUnavailableError,
  isNativeTreeSitterAvailable,
} from "../native/treeSitterNative.js";
import type {
  NativeExtractBatchResult,
  NativeExtractResult,
  NativeExtractTask,
} from "../worker/nativeExtractWorker.js";
import { NATIVE_WORKER_BATCH_SIZE } from "../worker/nativeExtractWorker.js";
import { prepareFileForIndexing, type PreparedFileContext } from "./parse-context.js";
import type { BuildOptions, BuildReport, WorkerPoolReport } from "./types.js";

export const NATIVE_WORKER_AUTO_FILE_THRESHOLD = 250;

export type WorkerPoolSetupResult = {
  pool: import("piscina").Piscina | null;
  report: WorkerPoolReport | undefined;
  startTime: number;
  batchSize: number;
};

export function shouldEnableNativeWorkers(opts: BuildOptions | undefined, fileCount?: number): boolean {
  if (opts?.native === "off") return false;
  if (!isNativeTreeSitterAvailable(opts?.native)) return false;
  if (opts?.useNativeWorkers === false) return false;
  if (opts?.useNativeWorkers === true) return true;
  return (fileCount ?? 0) >= NATIVE_WORKER_AUTO_FILE_THRESHOLD;
}

function isSFCFile(filePath: string): boolean {
  return filePath.endsWith(".vue") || filePath.endsWith(".svelte") || filePath.endsWith(".astro");
}

function buildWorkerTask(filePath: string, sup: LanguageSupport): NativeExtractTask {
  return {
    filePath,
    languageId: sup.id,
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
): PreparedFileContext {
  return {
    file: filePath,
    source: result.source,
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
      const createdPool = createNativeWorkerPool({
        threads: opts?.nativeThreads,
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

export async function prepareFileContextForBuild(
  file: string,
  support: LanguageSupport,
  opts: BuildOptions | undefined,
  workerSetup: WorkerPoolSetupResult,
  report: BuildReport | undefined,
): Promise<PreparedFileContext> {
  let prepared: PreparedFileContext;
  if (workerSetup.pool && !isSFCFile(file) && !isGraphOnlyLanguage(support.id)) {
    if (workerSetup.report) workerSetup.report.tasksSubmitted++;
    try {
      const workerResult: NativeExtractResult = await workerSetup.pool.run(buildWorkerTask(file, support));
      prepared = workerResultToPrepared(workerResult, support, file);
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
      if (workerSetup.report) workerSetup.report.tasksFailed++;
      if (workerSetup.report) {
        workerSetup.report.errors ??= [];
        if (workerSetup.report.errors.length < 20) {
          workerSetup.report.errors.push({
            file,
            message: stringifyUnknown(error),
          });
        }
      }
      prepared = await prepareFileForIndexing(file, opts?.native, opts?.languageExtensions);
    }
  } else {
    prepared = await prepareFileForIndexing(file, opts?.native, opts?.languageExtensions);
  }
  if (isGraphOnlyLanguage(prepared.sup.id)) {
    return prepared;
  }
  recordNativeExecutionOutcome(report, {
    file,
    support: prepared.sup,
    languageId: prepared.sup.id,
    results: prepared.nativeQueries,
    ...(prepared.nativeFallbackReason ? { fallbackReason: prepared.nativeFallbackReason } : {}),
    ...(prepared.nativeError ? { error: prepared.nativeError } : {}),
  });
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
    try {
      const batchResult = (await workerSetup.pool.run({
        tasks: slice.map((entry) => entry.task),
      })) as NativeExtractBatchResult;
      for (const [i, entry] of slice.entries()) {
        const workerResult = batchResult.results[i];
        if (!workerResult) {
          results[entry.index] = await prepareFileForIndexing(entry.file, opts?.native, opts?.languageExtensions);
          continue;
        }
        const prepared = workerResultToPrepared(workerResult, entry.support, entry.file);
        if (!isGraphOnlyLanguage(prepared.sup.id)) {
          recordNativeExecutionOutcome(report, {
            file: entry.file,
            support: prepared.sup,
            languageId: prepared.sup.id,
            results: prepared.nativeQueries,
            ...(prepared.nativeFallbackReason ? { fallbackReason: prepared.nativeFallbackReason } : {}),
            ...(prepared.nativeError ? { error: prepared.nativeError } : {}),
          });
        }
        results[entry.index] = prepared;
      }
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
      if (workerSetup.report) workerSetup.report.tasksFailed += slice.length;
      for (const entry of slice) {
        results[entry.index] = await prepareFileForIndexing(entry.file, opts?.native, opts?.languageExtensions);
      }
    }
  }

  return results;
}
