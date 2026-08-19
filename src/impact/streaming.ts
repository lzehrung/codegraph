/**
 * Streaming API for impact analysis
 * Allows incremental results to be emitted as they're discovered
 */

import { type ProjectIndex, type BuildReport } from "../indexer/types.js";
import { summarizeAnalysis } from "../analysisSummary.js";
import {
  IMPACT_SCHEMA_VERSION,
  type ImpactOptions,
  type ChangedSymbol,
  type FileChange,
  type ImpactItem,
  type ImpactStreamSummaryReport,
} from "./types.js";
import { getDiff } from "./providers/base.js";
import { analyzeImpact } from "./analyzer.js";
import { discoverProjectFiles, type ProjectFileInfo } from "../util/projectFiles.js";
import { errorMessage } from "../util/errors.js";
import { buildImpactReport, newFileRangeForHunk } from "./report.js";
import {
  applyChangedFileSymbolMapping,
  createImpactDiagnostics,
  listFileLevelFallbackPaths,
  mapChangedFileSymbols,
} from "./collect.js";
import { createImpactIgnoreMatcher, normalizeImpactDiffFiles, toImpactReportFilePath } from "./path.js";
import { collectImpactReportSuggestions } from "./report-suggestions.js";

export type ImpactStreamChunk =
  | { type: "projectFiles"; files: ProjectFileInfo[] }
  | import("../types.js").ProgressUpdate
  | { type: "changedSymbol"; symbol: ChangedSymbol }
  | { type: "impactItem"; item: ImpactItem; partial?: true }
  | {
      type: "complete";
      summary: { totalChanged: number; totalImpacted: number };
      report: ImpactStreamSummaryReport;
    }
  | { type: "error"; error: string };

type PublicImpactStreamingOptions<Options> = Options extends unknown
  ? Omit<Options, "diagnostics" | "fileLevelFallbackPaths" | "onImpactItem" | "signal">
  : never;

type WithoutCompact<Options> = Options extends unknown ? Omit<Options, "compact"> : never;

/**
 * Options for streaming impact analysis.
 *
 * `streamSummary` is scoped to streaming callers so batch APIs do not accept a
 * no-op light mode. Streaming always emits the `stream-summary` report shape.
 * Use `"full"` for the default terminal report, or `"light"` to skip
 * suggestions, export summaries, re-export chains, ranked top impacts, graph
 * metadata, cycles, clusters, and surface area in the final `complete.report`.
 */
export type ImpactStreamingOptions = PublicImpactStreamingOptions<WithoutCompact<ImpactOptions>> & {
  streamSummary?: "full" | "light";
};

function toImpactOptions(options: ImpactStreamingOptions): ImpactOptions {
  const { streamSummary: _streamSummary, ...impactOptions } = options;
  return impactOptions;
}

function validateImpactStreamingOptions(options: ImpactStreamingOptions): "full" | "light" {
  const streamSummary = options.streamSummary ?? "full";
  if (streamSummary !== "full" && streamSummary !== "light") {
    throw new Error('streamSummary must be "full" or "light"');
  }
  return streamSummary;
}

/**
 * Raised when a stream consumer falls behind the producer far enough that the buffered,
 * unread chunk count would grow without bound. The producer stops (see
 * `analyzeImpactStreaming`'s `onImpactItem` wiring) instead of silently dropping chunks,
 * so a stalled consumer learns the stream could not keep up rather than quietly receiving
 * a truncated-but-apparently-successful result.
 */
export class ImpactStreamOverflowError extends Error {
  constructor(maxQueuedChunks: number) {
    super(
      `Impact stream consumer fell behind the producer: more than ${maxQueuedChunks} chunks were buffered ` +
        "without being read. The stream was stopped instead of dropping chunks silently.",
    );
    this.name = "ImpactStreamOverflowError";
  }
}

/**
 * Thrown from the `onImpactItem` producer callback once the consumer has abandoned the
 * stream (see the `analyzeImpactStreaming` cancellation note below). Unwinds
 * `analyzeImpact`'s in-progress work through its normal promise-rejection path; nothing
 * outside this module ever observes it, since by construction nobody is listening to the
 * stream anymore once it fires.
 */
class ImpactStreamAbandonedError extends Error {
  constructor() {
    super("Impact stream consumer stopped reading; cancelling in-progress analysis.");
    this.name = "ImpactStreamAbandonedError";
  }
}

/**
 * Default cap on buffered-but-unread stream chunks before `ImpactStreamOverflowError` is
 * raised. True backpressure (pausing the producer until the consumer catches up) would
 * require the `onImpactItem` emission callback to be genuinely awaitable, which means
 * awaiting it at every synchronous call site in `direct.ts`/`transitive.ts` - an invasive
 * redesign of code outside this module. A hard cap is the non-invasive alternative: it
 * turns unbounded memory growth into an explicit, surfaced failure instead.
 */
export const DEFAULT_MAX_IMPACT_STREAM_QUEUED_CHUNKS = 10_000;

type AsyncQueue<T> = {
  push: (value: T) => void;
  close: () => void;
  next: () => Promise<IteratorResult<T>>;
};

function createAsyncQueue<T>(maxQueuedChunks: number): AsyncQueue<T> {
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
      if (values.length >= maxQueuedChunks) {
        throw new ImpactStreamOverflowError(maxQueuedChunks);
      }
      values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined, done: true });
      }
    },
    async next(): Promise<IteratorResult<T>> {
      if (values.length) {
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

function buildLightStreamSummaryReport(
  analysis: ImpactStreamSummaryReport["analysis"],
  normalizedChanges: FileChange[],
  changedSymbols: ChangedSymbol[],
  impactedItems: ImpactItem[],
  diagnostics: ImpactStreamSummaryReport["diagnostics"],
  warning: string | undefined,
  displayFile: (filePath: string) => string,
): ImpactStreamSummaryReport {
  return {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    format: "stream-summary",
    ...(analysis ? { analysis } : {}),
    changedFiles: normalizedChanges.map((change) => ({
      file: displayFile(change.path),
      kind: change.kind,
      ...(change.oldPath ? { oldFile: displayFile(change.oldPath) } : {}),
      ...(change.similarityIndex !== undefined ? { similarityIndex: change.similarityIndex } : {}),
      hunks: change.hunks.map((hunk) => newFileRangeForHunk(hunk)),
    })),
    changedSymbols: changedSymbols.map((symbol) => ({
      ...symbol,
      file: displayFile(symbol.file),
    })),
    impacted: impactedItems.map((item) => ({
      ...item,
      file: displayFile(item.file),
    })),
    topImpacts: [],
    surfaceArea: { files: [], topFanIn: [], topFanOut: [] },
    clusters: [],
    cycles: [],
    graph: { fileEdges: [], symbolEdges: [] },
    diagnostics,
    ...(warning ? { warning } : {}),
  };
}

export function impactItemEmissionKey(item: ImpactItem, partial: boolean): string {
  const symbols = item.symbols.slice().sort().join(",");
  const reasons = item.reasons.slice().sort().join(",");
  const refCount = item.refs?.length ?? 0;
  const hintCount = item.explain?.hints?.length ?? 0;
  return [
    item.file,
    partial ? "partial" : "final",
    symbols,
    reasons,
    item.severity.toFixed(6),
    String(item.depth ?? 0),
    String(item.confidence ?? 0),
    String(item.typeOnly ?? ""),
    String(item.explain?.typeOnly ?? ""),
    String(refCount),
    String(hintCount),
  ].join("|");
}

export type ImpactStreamingContext = {
  buildReport?: BuildReport | undefined;
  /** @internal Overrides the buffered-chunk cap (`DEFAULT_MAX_IMPACT_STREAM_QUEUED_CHUNKS`).
   * Test seam for deterministically exercising `ImpactStreamOverflowError`. */
  maxQueuedChunks?: number | undefined;
};

/**
 * Stream impact analysis results as they are discovered.
 *
 * Consumers receive progress, `changedSymbol`, and `impactItem` chunks before
 * the final `complete` chunk. `complete.report` is the structured integration
 * payload for function callers. By default it includes the same key extras as
 * the batch impact report, including suggestions, export summaries, re-export
 * chains, graph edges, cycles, diagnostics, and schema metadata. Use
 * `streamSummary: "light"` when a caller only needs the progressive chunks and
 * a cheap terminal count/detail summary.
 *
 * Cancellation: if the consumer stops iterating early - a `for await` `break`, or an
 * explicit `.return()` on the generator - the async-generator return protocol resumes
 * this function's execution at its `finally` block, which aborts an internal
 * `AbortController`. The background `analyzeImpact()` producer receives that signal and
 * checks it at analysis work boundaries and before emitting items, so it does not start
 * later batches or transitive work after abandonment. An in-progress synchronous lookup
 * still runs until it returns because it cannot be preempted by JavaScript.
 */
export async function* analyzeImpactStreaming(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactStreamingOptions,
  context: ImpactStreamingContext = {},
): AsyncGenerator<ImpactStreamChunk> {
  const abortController = new AbortController();
  let analysisPromise: Promise<void> | undefined;
  try {
    const streamSummary = validateImpactStreamingOptions(options);
    const impactOptions = toImpactOptions(options);
    const displayFile = (filePath: string): string => toImpactReportFilePath(projectRoot, filePath);
    const analysis = summarizeAnalysis({ index, report: context.buildReport ?? index.buildReport });
    const projectFiles = index.projectFiles ?? (await discoverProjectFiles(projectRoot));
    yield { type: "projectFiles", files: projectFiles };

    // Step 1: Get diff
    yield {
      type: "progress",
      message: "Fetching diff",
      current: 0,
      total: 4,
    };

    const diff = await getDiff(impactOptions);
    const { ignoreGlobs = [] } = impactOptions;
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

    const changedSymbols: ChangedSymbol[] = [];
    const filesWithSymbols = new Set<string>();
    for (let idx = 0; idx < normalizedDiff.files.length; idx += 1) {
      const fileChange = normalizedDiff.files[idx]!;
      const mapped = await mapChangedFileSymbols(index, fileChange, idx);
      const symbols = applyChangedFileSymbolMapping(mapped, impactOptions, diagnostics, filesWithSymbols);
      for (const symbol of symbols) {
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
    const fileLevelFallback = impactOptions.fileLevelFallback ?? true;
    const fileLevelFallbackPaths = listFileLevelFallbackPaths(normalizedChanges, filesWithSymbols);
    const impactQueue = createAsyncQueue<ImpactStreamChunk>(
      context.maxQueuedChunks ?? DEFAULT_MAX_IMPACT_STREAM_QUEUED_CHUNKS,
    );
    const emittedSignatures = new Set<string>();
    let impactedItems: ImpactItem[] = [];
    let impactError: string | null = null;
    const queueImpactItem = (item: ImpactItem, partial: boolean) => {
      const key = impactItemEmissionKey(item, partial);
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
    analysisPromise = analyzeImpact(index, changedSymbols, normalizedChanges, {
      ...impactOptions,
      projectRoot,
      fileLevelFallback,
      fileLevelFallbackPaths,
      diagnostics,
      signal: abortController.signal,
      onImpactItem: (item, phase) => {
        if (abortController.signal.aborted) {
          throw new ImpactStreamAbandonedError();
        }
        queueImpactItem(item, phase === "partial");
      },
    })
      .then((items) => {
        impactedItems = items;
      })
      .catch((error) => {
        impactError = errorMessage(error);
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

    yield {
      type: "progress",
      message: "Building summary",
      current: 3,
      total: 4,
    };

    const report =
      streamSummary === "light"
        ? buildLightStreamSummaryReport(
            analysis,
            normalizedChanges,
            changedSymbols,
            impactedItems,
            diagnostics,
            diff.warning,
            displayFile,
          )
        : await buildFullStreamSummaryReport(
            projectRoot,
            index,
            impactOptions,
            normalizedChanges,
            changedSymbols,
            impactedItems,
            diagnostics,
            diff.warning,
            context,
          );

    yield {
      type: "progress",
      message: "Analysis complete",
      current: 4,
      total: 4,
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
      error: errorMessage(error),
    };
  } finally {
    // Abort abandoned work and wait for the producer to acknowledge cancellation before the
    // iterator's return promise resolves.
    abortController.abort();
    await analysisPromise;
  }
}

async function buildFullStreamSummaryReport(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactOptions,
  normalizedChanges: FileChange[],
  changedSymbols: ChangedSymbol[],
  impactedItems: ImpactItem[],
  diagnostics: ImpactStreamSummaryReport["diagnostics"],
  warning: string | undefined,
  context: ImpactStreamingContext,
): Promise<ImpactStreamSummaryReport> {
  const suggestions = await collectImpactReportSuggestions(
    projectRoot,
    index,
    options,
    normalizedChanges,
    changedSymbols,
  );
  const fullReport = await buildImpactReport(
    projectRoot,
    index,
    normalizedChanges,
    changedSymbols,
    impactedItems,
    suggestions,
    { ...options, compact: false, warning, buildReport: context.buildReport },
    diagnostics,
  );
  if (fullReport.format !== "full") {
    throw new Error("Expected full impact report while building streaming summary");
  }
  return {
    schemaVersion: fullReport.schemaVersion,
    format: "stream-summary",
    ...(fullReport.analysis ? { analysis: fullReport.analysis } : {}),
    changedFiles: fullReport.changedFiles,
    changedSymbols: fullReport.changedSymbols,
    impacted: fullReport.impacted,
    ...(fullReport.markdownLinks ? { markdownLinks: fullReport.markdownLinks } : {}),
    ...(fullReport.suggestions ? { suggestions: fullReport.suggestions } : {}),
    ...(fullReport.exportSummary ? { exportSummary: fullReport.exportSummary } : {}),
    ...(fullReport.reexportChains ? { reexportChains: fullReport.reexportChains } : {}),
    topImpacts: fullReport.topImpacts ?? [],
    surfaceArea: fullReport.surfaceArea,
    clusters: fullReport.clusters,
    cycles: fullReport.cycles ?? [],
    graph: fullReport.graph,
    diagnostics: fullReport.diagnostics ?? diagnostics,
    ...(fullReport.warning ? { warning: fullReport.warning } : {}),
  };
}
