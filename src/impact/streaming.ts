/**
 * Streaming API for impact analysis
 * Allows incremental results to be emitted as they're discovered
 */

import type { ProjectIndex } from "../indexer.js";
import type { ImpactOptions, ChangedSymbol, ImpactItem } from "./types.js";
import { getDiff } from "./providers/base.js";
import { locateChangedSymbolsWithLines } from "./map.js";
import { analyzeImpact } from "./analyzer.js";
import { discoverProjectFiles, type ProjectFileInfo } from "../util.js";
import {
  createImpactIgnoreMatcher,
  normalizeImpactDiffFiles,
  normalizeImpactFilePath,
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

    // Step 2: Map changed files to symbols
    yield {
      type: "progress",
      message: "Analyzing changed symbols",
      current: 1,
      total: 4,
    };

    let changedSymbols: ChangedSymbol[] = [];
    const filesWithSymbols = new Set<string>();
    for (const fileChange of normalizedDiff.files) {
      const absPath = normalizeImpactFilePath(projectRoot, fileChange.path);
      const mapped = await locateChangedSymbolsWithLines(index, absPath, fileChange.hunks);
      const symbols = mapped.changedSymbols;

      if (symbols.length > 0) filesWithSymbols.add(absPath);
      const emittedSymbols = options.scope === "imported" ? symbols.filter((symbol) => symbol.exported) : symbols;
      for (const symbol of emittedSymbols) {
        yield {
          type: "changedSymbol",
          symbol: {
            ...symbol,
            file: displayFile(symbol.file),
          },
        };
        changedSymbols.push(symbol);
      }
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
    const fileLevelFallbackPaths = normalizedChanges
      .filter((change) => change.kind !== "deleted" && !filesWithSymbols.has(change.path))
      .map((change) => change.path);
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

    yield {
      type: "complete",
      summary: {
        totalChanged: changedSymbols.length,
        totalImpacted: impactedItems.length,
      },
    };
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
