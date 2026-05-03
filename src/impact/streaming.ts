/**
 * Streaming API for impact analysis
 * Allows incremental results to be emitted as they're discovered
 */

import type { ProjectIndex } from "../indexer.js";
import type {
  ImpactOptions,
  ChangedSymbol,
  ImpactItem,
  ImpactStreamSummaryReport,
} from "./types.js";
import { getDiff } from "./providers/base.js";
import { analyzeImpact } from "./analyzer.js";
import { discoverProjectFiles, type ProjectFileInfo } from "../util.js";
import { buildImpactReport } from "./report.js";
import { collectChangedSymbols, createImpactDiagnostics, listFileLevelFallbackPaths } from "./collect.js";
import {
  createImpactIgnoreMatcher,
  normalizeImpactDiffFiles,
  toImpactReportFilePath,
} from "./path.js";

export type ImpactStreamChunk =
  | { type: "projectFiles"; files: ProjectFileInfo[] }
  | import("../types.js").ProgressUpdate
  | { type: "changedSymbol"; symbol: ChangedSymbol }
  | { type: "impactItem"; item: ImpactItem; partial?: boolean }
  | {
      type: "complete";
      summary: { totalChanged: number; totalImpacted: number };
      report: ImpactStreamSummaryReport;
    }
  | { type: "error"; error: string };

type AsyncQueue<T> = {
  push: (value: T) => void;
  close: () => void;
  next: () => Promise<IteratorResult<T>>;
};

function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    push(value: T) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
        return;
      }
      values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined, done: true });
      }
    },
    async next(): Promise<IteratorResult<T>> {
      if (values.length > 0) {
        const nextValue = values.shift()!;
        return { value: nextValue, done: false };
      }
      if (closed) {
        return { value: undefined, done: true };
      }
      return await new Promise<IteratorResult<T>>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

/**
 * Stream impact analysis results as they're discovered
 * This is much better for agent UX as they can start reasoning immediately
 */
export async function* analyzeImpactStreaming(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactOptions,
): AsyncGenerator<ImpactStreamChunk> {
  try {
    const displayFile = (filePath: string): string => toImpactReportFilePath(projectRoot, filePath);
    const projectFiles = index.projectFiles ?? (await discoverProjectFiles(projectRoot));
    yield { type: "projectFiles", files: projectFiles };

    // Step 1: Get diff
    yield {
      type: "progress",
      message: "Fetching diff",
      current: 0,
      total: 4,
    };

    const diff = await getDiff(options);
    const { ignoreGlobs = [] } = options;
    const isIgnored = createImpactIgnoreMatcher(projectRoot, ignoreGlobs);
    const normalizedDiff = normalizeImpactDiffFiles(projectRoot, diff.files, isIgnored);
    const diagnostics = createImpactDiagnostics(diff.files.length, normalizedDiff.ignoredCount);

    // Step 2: Map changed files to symbols
    yield {
      type: "progress",
      message: "Analyzing changed symbols",
      current: 1,
      total: 4,
    };

    const { changedSymbols, filesWithSymbols } = await collectChangedSymbols(index, normalizedDiff.files, options, diagnostics);
    for (const symbol of changedSymbols) {
      yield {
        type: "changedSymbol",
        symbol: {
          ...symbol,
          file: displayFile(symbol.file),
        },
      };
    }

    // Step 3: Analyze impact (stream results)
    yield {
      type: "progress",
      message: "Finding impacted files",
      current: 2,
      total: 4,
    };

    const normalizedChanges = normalizedDiff.files;
    const fileLevelFallback = options.fileLevelFallback ?? true;
    const fileLevelFallbackPaths = listFileLevelFallbackPaths(normalizedChanges, filesWithSymbols);
    const impactQueue = createAsyncQueue<ImpactStreamChunk>();
    const emittedSignatures = new Set<string>();
    let impactedItems: ImpactItem[] = [];
    let impactError: string | null = null;
    const queueImpactItem = (item: ImpactItem, partial: boolean) => {
      const signature = JSON.stringify(item);
      const key = `${item.file}::${partial ? "partial" : "final"}::${signature}`;
      if (emittedSignatures.has(key)) return;
      emittedSignatures.add(key);
      impactQueue.push({
        type: "impactItem",
        item: {
          ...item,
          file: displayFile(item.file),
        },
        ...(partial ? { partial: true } : {}),
      });
    };

    void analyzeImpact(index, changedSymbols, normalizedChanges, {
      ...options,
      projectRoot,
      fileLevelFallback,
      fileLevelFallbackPaths,
      diagnostics,
      onImpactItem: (item, phase) => {
        queueImpactItem(item, phase === "partial");
      },
    })
      .then((items) => {
        impactedItems = items;
      })
      .catch((error) => {
        impactError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        impactQueue.close();
      });

    while (true) {
      const nextChunk = await impactQueue.next();
      if (nextChunk.done) break;
      yield nextChunk.value;
    }

    if (impactError) {
      yield {
        type: "error",
        error: impactError,
      };
      return;
    }

    // Step 4: Complete
    yield {
      type: "progress",
      message: "Analysis complete",
      current: 4,
      total: 4,
    };

    const fullReport = await buildImpactReport(
      projectRoot,
      index,
      normalizedChanges,
      changedSymbols,
      impactedItems,
      [],
      { ...options, compact: false, warning: diff.warning },
      diagnostics,
    );
    if (fullReport.format !== "full") {
      yield {
        type: "error",
        error: "Expected full impact report while building streaming summary",
      };
      return;
    }
    const report: ImpactStreamSummaryReport = {
      schemaVersion: fullReport.schemaVersion,
      format: "stream-summary",
      changedFiles: fullReport.changedFiles,
      changedSymbols: fullReport.changedSymbols,
      impacted: fullReport.impacted,
      topImpacts: fullReport.topImpacts ?? [],
      surfaceArea: fullReport.surfaceArea,
      clusters: fullReport.clusters,
      cycles: fullReport.cycles ?? [],
      diagnostics: fullReport.diagnostics ?? diagnostics,
      ...(fullReport.warning ? { warning: fullReport.warning } : {}),
    };

    yield {
      type: "complete",
      summary: {
        totalChanged: report.changedSymbols.length,
        totalImpacted: report.impacted.length,
      },
      report,
    };
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
