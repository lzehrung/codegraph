import { performance } from "node:perf_hooks";
import type { LanguageSupport } from "../languages.js";
import { stringifyUnknown } from "../util/ast.js";
import { recordNativeExecutionOutcome } from "../native/nativeBackendReport.js";
import {
  getCachedNormalizedQuery,
  isNativeRequiredUnavailableError,
  isNativeTreeSitterAvailable,
} from "../native/treeSitterNative.js";
import type { NativeExtractResult, NativeExtractTask } from "../worker/nativeExtractWorker.js";
import { prepareFileForIndexing, type PreparedFileContext } from "./parse-context.js";
import type { BuildOptions, BuildReport, WorkerPoolReport } from "./types.js";

export type WorkerPoolSetupResult = {
  pool: import("piscina").Piscina | null;
  report: WorkerPoolReport | undefined;
  startTime: number;
};

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
    ...(result.fallbackReason ? { nativeFallbackReason: result.fallbackReason } : {}),
    ...(result.error ? { nativeError: result.error } : {}),
  };
}

export async function setupWorkerPool(opts: BuildOptions | undefined): Promise<WorkerPoolSetupResult> {
  const shouldUseWorkers =
    !!opts?.useNativeWorkers && opts?.native !== "off" && isNativeTreeSitterAvailable(opts?.native);
  const report: WorkerPoolReport | undefined = opts?.useNativeWorkers
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
        threads: opts.nativeThreads,
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
  return { pool, report, startTime: pool ? performance.now() : 0 };
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
  if (workerSetup.pool && !isSFCFile(file)) {
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
      prepared = await prepareFileForIndexing(file, opts?.native);
    }
  } else {
    prepared = await prepareFileForIndexing(file, opts?.native);
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
