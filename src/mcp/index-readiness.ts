import { registerSessionInvalidationHook } from "../agent/session-lifecycle.js";
import type { AgentSession } from "../agent/session.js";
import { parseQualifiedSymbolPath } from "../indexer/symbols.js";
import type { ProgressUpdate } from "../types.js";
import { isPlainRecord } from "../util/guards.js";
import { mcpCancellationError } from "./cancellation.js";
import { describeMcpRuntimeError } from "./stale-install.js";

/**
 * What the server builds in the background once it is serving. `"off"` builds nothing up front: the first tool call
 * that needs the index starts the build.
 */
export type CodegraphMcpWarmupMode = "off" | "base" | "symbols";

/**
 * The longest one tool call waits for an index build before it answers `index_building`. It stays below the 30 seconds
 * that MCP clients commonly allow for a request.
 */
export const DEFAULT_MCP_INDEX_WAIT_MS = 20_000;
/**
 * How soon a caller that got `index_building` may ask again. The build continues meanwhile, and the retry waits for it
 * up to the same budget, so an immediate retry is fine.
 */
export const MCP_INDEX_RETRY_AFTER_MS = 1_000;
/** The largest delay a timer accepts. */
export const MAX_MCP_INDEX_WAIT_MS = 2_147_483_647;

export function assertMcpIndexWait(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MCP_INDEX_WAIT_MS) {
    throw new RangeError(
      `mcpIndexWaitMs must be a whole number from 0 through ${MAX_MCP_INDEX_WAIT_MS}; 0 disables the budget.`,
    );
  }
  return value;
}

/**
 * A build that a tool call can wait for. Each stage includes the project index.
 * - `index`: the project index, which every index-backed tool reads.
 * - `graph`: the in-memory symbol graph that hybrid, symbol, and graph searches read.
 * - `query`: the session query index that hybrid and text searches read.
 * - `symbols`: the detailed symbol graph that handle-based tools such as `calls` and `get_symbol` read.
 * - `duplicates`: the duplicate analysis that `review` reads to add duplicate-sibling tasks.
 * - `warmup`: the whole startup warmup, which `refresh_index` takes its turn after.
 */
export type McpIndexStage = "index" | "graph" | "query" | "symbols" | "duplicates" | "warmup";
type McpBuildStage = Exclude<McpIndexStage, "warmup">;

/** What the build is doing. A count appears only when the work has a measurable total. */
export type McpIndexProgress = {
  activity: string;
  current?: number;
  total?: number;
  elapsedMs: number;
};

/** The structured answer of a tool call that would wait for the index build past the budget. It is not an error. */
export type McpIndexBuildingResult = {
  status: "index_building";
  tool: string;
  message: string;
  retryAfterMs: number;
  waitedMs: number;
  progress: McpIndexProgress;
};

export class McpIndexBuildingError extends Error {
  readonly result: McpIndexBuildingResult;

  constructor(result: McpIndexBuildingResult) {
    super(result.message);
    this.name = "McpIndexBuildingError";
    this.result = result;
  }
}

type RecordedBuildProgress = { activity: string; current: number; total: number };

/** Keeps the latest update of the session's own build, for the progress of an `index_building` answer. */
export type McpBuildProgress = {
  /** Feed it every `onProgress` update of the session. */
  record: (update: ProgressUpdate) => void;
  latest: () => RecordedBuildProgress | undefined;
};

function describeBuildUpdate(update: ProgressUpdate): string {
  if (update.activity) return update.activity;
  // A start update names the operation. The updates of the parse loop name a file, which a client does not need.
  if (update.phase === "start") return update.message;
  if (update.mode === "update") return "Updating project index";
  if (update.mode === "check") return "Checking project index";
  return "Indexing files";
}

export function createMcpBuildProgress(): McpBuildProgress {
  let latest: RecordedBuildProgress | undefined;
  return {
    record: (update) => {
      if (update.phase === "complete") {
        latest = undefined;
        return;
      }
      latest = { activity: describeBuildUpdate(update), current: update.current, total: update.total };
    },
    latest: () => latest,
  };
}

export type McpIndexReadinessOptions = {
  /** The longest wait of one call. 0 waits for as long as the build takes. */
  waitMs: number;
  /** Which builds the startup warmup runs. */
  warmup: CodegraphMcpWarmupMode;
  /** Runs `operation` in its turn of the lock that `refresh_index`, `artifact_build`, and the file watcher share. */
  runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  progress: McpBuildProgress;
  log?: (message: string) => void;
  now?: () => number;
};

export type McpIndexReadiness = {
  /**
   * Starts the startup warmup, once; call it when the server is ready to serve. The warmup runs in the background and
   * its failure is logged: the next call that needs the index builds it again and reports that error itself.
   */
  startWarmup: () => void;
  /** Settles when the warmup has ended, at once when none was started. Never rejects. */
  warmupSettled: () => Promise<void>;
  /**
   * Waits for the builds that `stages` name. Every call shares the one build that the session runs for each stage, and
   * a stage that is already built returns at once. Past the budget it throws {@link McpIndexBuildingError}; the build
   * continues, and the next call waits for what is left of it.
   */
  waitFor: (tool: string, stages: readonly McpIndexStage[], signal?: AbortSignal) => Promise<void>;
};

const STAGE_ACTIVITY: Record<McpBuildStage, string> = {
  index: "Building project index",
  graph: "Building symbol graph",
  query: "Building search index",
  symbols: "Building detailed symbol graph",
  duplicates: "Preparing duplicate analysis",
};
const STAGES_BY_PRIORITY: readonly McpBuildStage[] = ["index", "graph", "symbols", "duplicates", "query"];

/**
 * Settles with `"ready"` when `build` settles, rethrows its failure, or settles with `"timeout"` after `budgetMs`.
 * Cancellation rejects. The build itself is never cancelled.
 */
function settleWithinBudget(
  build: Promise<unknown>,
  budgetMs: number,
  signal: AbortSignal | undefined,
): Promise<"ready" | "timeout"> {
  if (signal?.aborted) return Promise.reject(mcpCancellationError(signal));
  const { promise, resolve, reject } = Promise.withResolvers<"ready" | "timeout">();
  let timer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    cleanup();
    if (signal) reject(mcpCancellationError(signal));
  };
  const cleanup = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (budgetMs > 0) {
    timer = setTimeout(() => {
      cleanup();
      resolve("timeout");
    }, budgetMs);
    timer.unref();
  }
  build.then(
    () => {
      cleanup();
      resolve("ready");
    },
    (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    },
  );
  return promise;
}

export function createMcpIndexReadiness(session: AgentSession, options: McpIndexReadinessOptions): McpIndexReadiness {
  const now = options.now ?? ((): number => performance.now());
  const log = options.log ?? ((message: string): void => console.error(message));
  // The builds that are running, one promise per stage. The session already shares its own build between callers;
  // this is what tells a waiter which stage is running and since when.
  const running = new Map<McpBuildStage, Promise<void>>();
  let buildStartedAt: number | undefined;
  let warmup: Promise<void> = Promise.resolve();
  let warmupStarted = false;

  // A rebuilt session shares nothing with the builds of the one it replaced. `registerSessionInvalidationHook` runs a
  // hook once, so it registers itself again.
  const forgetBuildsOnInvalidation = (): void => {
    registerSessionInvalidationHook(session, () => {
      running.clear();
      buildStartedAt = undefined;
      forgetBuildsOnInvalidation();
    });
  };
  forgetBuildsOnInvalidation();

  const share = (stage: McpBuildStage, build: () => Promise<void>): Promise<void> => {
    const existing = running.get(stage);
    if (existing) return existing;
    buildStartedAt ??= now();
    const promise = build();
    running.set(stage, promise);
    const finish = (): void => {
      if (running.get(stage) === promise) running.delete(stage);
      if (!running.size) buildStartedAt = undefined;
    };
    promise.then(finish, finish);
    return promise;
  };

  const buildIndex = (): Promise<void> =>
    share("index", async () => {
      await session.loadProject({ symbolGraph: "skip" });
    });
  const buildGraph = (): Promise<void> =>
    share("graph", async () => {
      await buildIndex();
      await session.loadProject({ symbolGraph: "basic" });
    });
  const buildQuery = (): Promise<void> =>
    share("query", async () => {
      await buildIndex();
      const snapshot = await session.loadProject({ symbolGraph: "skip" });
      // Loaded on first use, as `search` does, so that server startup does not pay for the SQLite store.
      const { ensureSessionQueryIndex } = await import("../agent/query-index/session-store.js");
      await ensureSessionQueryIndex(session, snapshot);
    });
  const buildSymbols = (): Promise<void> =>
    share("symbols", async () => {
      await buildIndex();
      await session.loadProject();
    });
  const buildDuplicates = (): Promise<void> =>
    share("duplicates", async () => {
      await buildIndex();
      await session.loadDuplicateAnalysis?.();
    });
  const startStage = (stage: McpIndexStage): Promise<void> => {
    if (stage === "warmup") return warmup;
    if (stage === "graph") return buildGraph();
    if (stage === "query") return buildQuery();
    if (stage === "symbols") return buildSymbols();
    if (stage === "duplicates") return buildDuplicates();
    return buildIndex();
  };

  const startWarmup = (): void => {
    if (warmupStarted) return;
    warmupStarted = true;
    if (options.warmup === "off") return;
    const detailed = options.warmup === "symbols";
    // In the shared turn, so that `refresh_index`, `artifact_build`, and a background refresh wait for the warmup
    // instead of replacing the session under it.
    warmup = options
      .runExclusive(async () => {
        const stages = [buildGraph(), buildQuery()];
        if (detailed) stages.push(buildSymbols());
        await Promise.all(stages);
      })
      .catch((error: unknown) => {
        log(`[codegraph] MCP startup warmup failed: ${describeMcpRuntimeError(error)}`);
      });
  };

  const describeProgress = (waitedMs: number): McpIndexProgress => {
    const stage = STAGES_BY_PRIORITY.find((candidate) => running.has(candidate));
    const elapsedMs = buildStartedAt === undefined ? waitedMs : Math.round(now() - buildStartedAt);
    // Only the project index reports counts; the stages after it have one activity each.
    const update = stage === "index" ? options.progress.latest() : undefined;
    if (update) {
      return {
        activity: update.activity,
        ...(update.total > 0 ? { current: update.current, total: update.total } : {}),
        elapsedMs,
      };
    }
    return { activity: stage ? STAGE_ACTIVITY[stage] : "Waiting for the index build", elapsedMs };
  };

  const waitFor = async (tool: string, stages: readonly McpIndexStage[], signal?: AbortSignal): Promise<void> => {
    if (!stages.length) return;
    const startedAt = now();
    const ready = Promise.all(stages.map(startStage));
    const outcome = await settleWithinBudget(ready, options.waitMs, signal);
    if (outcome === "ready") return;
    const waitedMs = Math.round(now() - startedAt);
    const progress = describeProgress(waitedMs);
    const counts = progress.total === undefined ? "" : ` ${progress.current ?? 0}/${progress.total}`;
    throw new McpIndexBuildingError({
      status: "index_building",
      tool,
      message:
        `Codegraph is still building the index for this project (${progress.activity}${counts}, ` +
        `${Math.round(progress.elapsedMs / 1000)}s so far). The build continues in the background; ` +
        `call '${tool}' again to wait for it.`,
      retryAfterMs: MCP_INDEX_RETRY_AFTER_MS,
      waitedMs,
      progress,
    });
  };

  return { startWarmup, warmupSettled: () => warmup, waitFor };
}

/** What a resolver may ask beyond the request itself. */
export type McpStageContext = {
  /** Whether the range of a `review` request has a changed file. */
  reviewRangeHasChanges: (request: { base: string; head: string }) => Promise<boolean>;
};
export type McpStageResolver = (
  request: Record<string, unknown>,
  context: McpStageContext,
) => readonly McpIndexStage[] | Promise<readonly McpIndexStage[]>;

function isReviewRange(
  request: Record<string, unknown>,
): request is Record<string, unknown> & { base: string; head: string } {
  return typeof request.base === "string" && typeof request.head === "string";
}

const NO_STAGES: readonly McpIndexStage[] = [];
const INDEX_STAGES: readonly McpIndexStage[] = ["index"];
const SYMBOL_GRAPH_STAGES: readonly McpIndexStage[] = ["symbols"];

// Mirrors what `searchCodegraphWithSession` loads: the symbol graph for hybrid, symbol, and graph modes, and the query
// index for hybrid and text modes. Path and SQL searches read the project index only.
function searchStages(mode: unknown): readonly McpIndexStage[] {
  if (mode === undefined || mode === "hybrid") return ["graph", "query"];
  if (mode === "text") return ["query"];
  if (mode === "symbol" || mode === "graph") return ["graph"];
  return INDEX_STAGES;
}

/**
 * The builds that each handler of a set waits for. Every handler but `dispose`, which releases the session and is no
 * tool, needs an entry: a tool without one would skip the wait budget, so the compiler checks the table where it meets
 * the handler set (see `withIndexReadiness`).
 */
export type McpStageTable<Handlers> = { readonly [Name in Exclude<keyof Handlers, "dispose">]: McpStageResolver };

/**
 * The builds each MCP handler waits for, by what its implementation loads from the session. A handler that this table
 * understates still works: it builds what is missing itself, but then its call waits without the budget.
 */
export const MCP_STAGES_BY_HANDLER = {
  search: (request) => searchStages(request.mode),
  explore: () => ["graph", "query"],
  orient: () => INDEX_STAGES,
  workspace_symbols: () => INDEX_STAGES,
  goto: () => INDEX_STAGES,
  file_deps: () => INDEX_STAGES,
  deps: () => INDEX_STAGES,
  rdeps: () => INDEX_STAGES,
  path: () => INDEX_STAGES,
  impact: () => INDEX_STAGES,
  // The duplicate analysis is the slowest build on a large project, and only a review that has a changed file reads
  // it. A range without one reads no index at all, and the handler answers it from git alone.
  review: async (request, context) => {
    if (!isReviewRange(request) || (await context.reviewRangeHasChanges(request))) return ["duplicates"];
    return NO_STAGES;
  },
  // Only a graph context needs the index; the bytes of a file are read from disk.
  get_file: (request) => (request.includeGraphContext ? INDEX_STAGES : NO_STAGES),
  // A qualified `file::symbol` path resolves in the project index; any other handle goes through the explain path.
  refs: (request) => {
    const handle = request.handle;
    return typeof handle === "string" && !parseQualifiedSymbolPath(handle) ? SYMBOL_GRAPH_STAGES : INDEX_STAGES;
  },
  get_symbol: () => SYMBOL_GRAPH_STAGES,
  packet_get: () => SYMBOL_GRAPH_STAGES,
  calls: () => SYMBOL_GRAPH_STAGES,
  callers: () => SYMBOL_GRAPH_STAGES,
  callees: () => SYMBOL_GRAPH_STAGES,
  type_hierarchy: () => SYMBOL_GRAPH_STAGES,
  supertypes: () => SYMBOL_GRAPH_STAGES,
  subtypes: () => SYMBOL_GRAPH_STAGES,
  implementations: () => SYMBOL_GRAPH_STAGES,
  rename_preview: () => SYMBOL_GRAPH_STAGES,
  refactor_plan: () => SYMBOL_GRAPH_STAGES,
  artifact_build: () => SYMBOL_GRAPH_STAGES,
  // Answers from the SQLite artifact. Its freshness check asks the session only when the artifact is stale.
  query_sqlite: () => NO_STAGES,
  refresh_index: () => ["warmup"],
} satisfies Record<string, McpStageResolver>;

/**
 * Makes every tool call wait for the builds it needs, within the budget, before its handler runs. A call that is not
 * ready in time never starts its handler: it ends with {@link McpIndexBuildingError} and holds nothing. `stages` must
 * name every handler of the set but `dispose`, which the compiler enforces at the call.
 */
export function withIndexReadiness<Handlers extends object>(
  handlers: Handlers,
  stages: NoInfer<McpStageTable<Handlers>>,
  readiness: McpIndexReadiness,
  context: McpStageContext,
): Handlers {
  const resolvers: Readonly<Record<string, McpStageResolver>> = stages;
  return new Proxy(handlers, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") return value;
      const stagesFor = Object.hasOwn(resolvers, property) ? resolvers[property] : undefined;
      if (!stagesFor) return value;
      return async (...args: unknown[]): Promise<unknown> => {
        const request = isPlainRecord(args[0]) ? args[0] : {};
        const signal = args[1] instanceof AbortSignal ? args[1] : undefined;
        await readiness.waitFor(property, await stagesFor(request, context), signal);
        return Reflect.apply(value, target, args);
      };
    },
  });
}
