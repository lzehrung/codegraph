import { parseReviewHandle } from "../agent/packet.js";
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
/**
 * How long after it ended the outcome of a `refresh_index` whose call stopped waiting stays for the retry. A
 * `refresh_index` call that comes later is a refresh of its own.
 */
export const MCP_REFRESH_RETRY_WINDOW_MS = 60_000;
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
 * What a tool call can wait for. Each build stage includes the project index, and a wait on one ends with the
 * session's freshness check: when files changed it replaces the session, and the builds run again for the new one.
 * - `index`: the project index, which every index-backed tool reads.
 * - `graph`: the in-memory symbol graph that hybrid, symbol, and graph searches read.
 * - `query`: the session query index that hybrid and text searches read.
 * - `symbols`: the detailed symbol graph that handle-based tools such as `calls` and `get_symbol` read.
 * - `duplicates`: the duplicate analysis that `review` and `packet_get` read, for duplicate-sibling tasks and context.
 * - `freshness`: the check alone, for a handler that runs it without needing a build. It waits for a running build.
 * - `idle`: every build that runs, whichever call started it. The turn of the lock that `artifact_build` takes starts
 *   after them.
 */
export type McpIndexStage = McpBuildStage | "idle";
type McpBuildStage = "index" | "graph" | "query" | "symbols" | "duplicates" | "freshness";

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
  /**
   * Settles when no build runs, at once when none was started: the warmup, and every build that a call started,
   * including one whose call stopped waiting. Builds that start while it waits count too. Never rejects.
   */
  buildsSettled: () => Promise<void>;
  /**
   * Runs `operation` once no build runs, with no build starting between that moment and the first synchronous step of
   * `operation`. An operation that replaces the session starts this way: a build that outlived the replacement would
   * write its file signatures over those of the new session.
   */
  whenIdle: <T>(operation: () => Promise<T>) => Promise<T>;
  /**
   * Waits for the builds that `stages` name, then for the freshness check; see {@link McpIndexStage}. Every call
   * shares the one build that the session runs for each stage, and a stage that is already built returns at once. Past
   * the budget it throws {@link McpIndexBuildingError}; the build continues, and the next call waits for what is left.
   */
  waitFor: (tool: string, stages: readonly McpIndexStage[], signal?: AbortSignal) => Promise<void>;
  /**
   * Waits for `work`, which the caller started, as `waitFor` waits for builds: past the budget it throws
   * {@link McpIndexBuildingError} and leaves `work` running, and a cancelled call stops waiting.
   */
  waitUntil: (tool: string, work: Promise<unknown>, signal?: AbortSignal) => Promise<void>;
  /**
   * Rebuilds what a `refresh_index` with `warmup` builds: `"base"` the project index, `"symbols"` also the detailed
   * symbol graph. Call it in the step that replaces the session. The builds are shared and tracked like those of any
   * stage, and until they end every wait for builds starts after them.
   */
  rebuild: (warmup: CodegraphMcpWarmupMode) => Promise<void>;
  /**
   * Marks the refresh that runs as handed off: the call that started it stopped waiting for it. Its outcome then waits
   * for the retry, while the rebuild runs and for {@link MCP_REFRESH_RETRY_WINDOW_MS} after it ended, unless it failed.
   */
  handOffRefresh: () => void;
  /**
   * The retry of a call that handed its refresh off. It waits for that refresh as `waitUntil` does and takes its
   * outcome, so that no second refresh replaces the session. `undefined` when no handed-off refresh builds at least
   * what `warmup` says.
   */
  joinRefresh: (tool: string, warmup: CodegraphMcpWarmupMode, signal?: AbortSignal) => Promise<void> | undefined;
};

const WARMUP_RANK: Record<CodegraphMcpWarmupMode, number> = { off: 0, base: 1, symbols: 2 };

const STAGE_ACTIVITY: Record<McpBuildStage, string> = {
  index: "Building project index",
  graph: "Building symbol graph",
  query: "Building search index",
  symbols: "Building detailed symbol graph",
  duplicates: "Preparing duplicate analysis",
  freshness: "Checking the project for changed files",
};
const STAGES_BY_PRIORITY: readonly McpBuildStage[] = ["index", "graph", "symbols", "duplicates", "query", "freshness"];

/**
 * How often one call runs its builds again because the session was replaced while it waited. A session that keeps
 * being replaced leaves the rest to the freshness check of the call's own handler.
 */
const MAX_READINESS_ATTEMPTS = 3;

/**
 * Settles with `"ready"` when `build` settles, rethrows its failure, or settles with `"timeout"` after `budgetMs`.
 * Cancellation rejects. The build itself is never cancelled.
 */
function settleWithinBudget(
  build: Promise<unknown>,
  budgetMs: number,
  signal: AbortSignal | undefined,
): Promise<"ready" | "timeout"> {
  if (signal?.aborted) {
    // The build goes on without this call, and may still fail: its failure is not this call's to report.
    build.catch(() => undefined);
    return Promise.reject(mcpCancellationError(signal));
  }
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

/** A refresh that rebuilds the session: what it builds, and whether the call that started it stopped waiting for it. */
type Refresh = { warmup: CodegraphMcpWarmupMode; rebuilt: Promise<void>; handedOff: boolean; endedAt?: number };

export function createMcpIndexReadiness(session: AgentSession, options: McpIndexReadinessOptions): McpIndexReadiness {
  const now = options.now ?? ((): number => performance.now());
  const log = options.log ?? ((message: string): void => console.error(message));
  // Every build from its start until it settles, whether or not a call still waits for it: the warmup, the shared build
  // of each stage, and each call's wait for its stages. A replacement of the session and the shutdown wait for all of
  // them. Each one consumes its own failure, so a build that nobody waits for cannot end as an unhandled rejection.
  const builds = new Set<Promise<unknown>>();
  // The build that each stage shares between calls, for the session as it is now. The session already shares its own
  // build between callers; this is what tells a waiter which stage is running and since when.
  const running = new Map<McpBuildStage, Promise<void>>();
  let buildStartedAt: number | undefined;
  // Counts the replacements of the session, so that a call can tell that its builds served a session that is gone.
  let generation = 0;
  let warmupStarted = false;
  // The refresh that rebuilds the session now, or that its call handed off and no retry has taken the outcome of. Every
  // wait for builds starts after the one that runs.
  let refreshing: Refresh | undefined;

  // A rebuilt session shares nothing with the builds of the one it replaced. They go on, and `builds` keeps them.
  // `registerSessionInvalidationHook` runs a hook once, so it registers itself again.
  const forgetBuildsOnInvalidation = (): void => {
    registerSessionInvalidationHook(session, () => {
      running.clear();
      buildStartedAt = undefined;
      generation += 1;
      forgetBuildsOnInvalidation();
    });
  };
  forgetBuildsOnInvalidation();

  const track = <T>(build: Promise<T>): Promise<T> => {
    builds.add(build);
    const ended = (): void => {
      builds.delete(build);
    };
    build.then(ended, ended);
    return build;
  };
  const whenIdle = async <T>(operation: () => Promise<T>): Promise<T> => {
    while (builds.size) await Promise.allSettled([...builds]);
    // Nothing awaits between the last check and the call, so no build starts in between.
    return await operation();
  };
  const settled = (): Promise<void> => whenIdle(() => Promise.resolve());

  const share = (stage: McpBuildStage, build: () => Promise<void>): Promise<void> => {
    const existing = running.get(stage);
    if (existing) return existing;
    buildStartedAt ??= now();
    const promise = track(build());
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
  const buildFreshness = (): Promise<void> =>
    share("freshness", async () => {
      await session.checkFreshness?.();
    });
  const startStage = (stage: McpIndexStage): Promise<void> => {
    if (stage === "graph") return buildGraph();
    if (stage === "query") return buildQuery();
    if (stage === "symbols") return buildSymbols();
    if (stage === "duplicates") return buildDuplicates();
    if (stage === "index") return buildIndex();
    // The check that ends every wait is the `freshness` stage, and `idle` is no build.
    return Promise.resolve();
  };

  const startWarmup = (): void => {
    if (warmupStarted) return;
    warmupStarted = true;
    if (options.warmup === "off") return;
    const detailed = options.warmup === "symbols";
    const stages = [buildGraph(), buildQuery()];
    if (detailed) stages.push(buildSymbols());
    // The failure is logged here, where nobody else can report it: the next call that needs a build runs it again.
    void track(
      Promise.all(stages).then(
        () => undefined,
        (error: unknown) => {
          log(`[codegraph] MCP startup warmup failed: ${describeMcpRuntimeError(error)}`);
        },
      ),
    );
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

  const rebuild = (warmup: CodegraphMcpWarmupMode): Promise<void> => {
    let rebuilt = Promise.resolve();
    if (warmup === "symbols") rebuilt = buildSymbols();
    else if (warmup === "base") rebuilt = buildIndex();
    const refresh: Refresh = { warmup, rebuilt, handedOff: false };
    refreshing = refresh;
    const forget = (): void => {
      if (refreshing === refresh) refreshing = undefined;
    };
    rebuilt.then(() => {
      refresh.endedAt = now();
      // Only a refresh that was handed off keeps its outcome, and only a success: a failed one is for the retry to run
      // again, and to report.
      if (!refresh.handedOff) forget();
    }, forget);
    return rebuilt;
  };

  const handOffRefresh = (): void => {
    if (refreshing) refreshing.handedOff = true;
  };

  // The builds of `stages`, then the freshness check that the handler runs next. When files changed, the check replaces
  // the session and the builds above served the old one, so they run again inside the same wait. A refresh that runs
  // replaces the session and rebuilds it, which the handler would wait for as well, so the wait starts after it.
  const ensure = async (stages: readonly McpIndexStage[]): Promise<void> => {
    for (let attempt = 0; attempt < MAX_READINESS_ATTEMPTS; attempt += 1) {
      // A refresh that failed is not this call's to report: the builds below run again, and report their own failure.
      if (refreshing && refreshing.endedAt === undefined) await refreshing.rebuilt.catch(() => undefined);
      const built = generation;
      await Promise.all(stages.map(startStage));
      await buildFreshness();
      if (built === generation) return;
    }
  };

  const waitUntil = async (tool: string, work: Promise<unknown>, signal?: AbortSignal): Promise<void> => {
    const startedAt = now();
    const outcome = await settleWithinBudget(work, options.waitMs, signal);
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

  const waitFor = async (tool: string, stages: readonly McpIndexStage[], signal?: AbortSignal): Promise<void> => {
    if (!stages.length) return;
    const ready = (async (): Promise<void> => {
      if (stages.some((stage) => stage !== "idle")) await track(ensure(stages));
      // After the builds of this call, which are over: `idle` waits for the ones of the other calls.
      if (stages.includes("idle")) await settled();
    })();
    await waitUntil(tool, ready, signal);
  };

  const joinRefresh = (
    tool: string,
    warmup: CodegraphMcpWarmupMode,
    signal?: AbortSignal,
  ): Promise<void> | undefined => {
    const refresh = refreshing;
    if (!refresh?.handedOff || WARMUP_RANK[refresh.warmup] < WARMUP_RANK[warmup]) return undefined;
    // A retry comes soon after the answer that asked for it. A call that comes much later is a refresh of its own.
    if (refresh.endedAt !== undefined && now() - refresh.endedAt > MCP_REFRESH_RETRY_WINDOW_MS) return undefined;
    return waitUntil(tool, refresh.rebuilt, signal).then(() => {
      if (refreshing === refresh) refreshing = undefined;
    });
  };

  return { startWarmup, buildsSettled: settled, whenIdle, waitFor, waitUntil, rebuild, handOffRefresh, joinRefresh };
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
const FRESHNESS_STAGES: readonly McpIndexStage[] = ["freshness"];

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
  // Mirrors `exploreCodegraphWithSession`: a search, which reads the symbol graph and the query index, and with
  // `includeSource` (off by default over MCP) one packet for each anchor, which reads the detailed symbol graph and the
  // duplicate analysis. A `maxPackets` of 0 builds no packet.
  explore: (request) => {
    if (request.includeSource && request.maxPackets !== 0) return ["graph", "query", "symbols", "duplicates"];
    return ["graph", "query"];
  },
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
  // A qualified `file::symbol` path resolves in the project index; any other handle goes through the explain path,
  // without the duplicate context that refs would discard.
  refs: (request) => {
    const handle = request.handle;
    return typeof handle === "string" && !parseQualifiedSymbolPath(handle) ? SYMBOL_GRAPH_STAGES : INDEX_STAGES;
  },
  get_symbol: () => SYMBOL_GRAPH_STAGES,
  // A packet reads the detailed symbol graph, and a file or symbol packet also the duplicate context of its target
  // from the session's duplicate analysis, which a SQL handle does not need. A review packet reads what `review` does.
  // A review target that is invalid, or has no changed file, builds nothing, but the call's freshness check waits.
  packet_get: async (request, context) => {
    const target = request.target;
    if (typeof target !== "string") return SYMBOL_GRAPH_STAGES;
    if (target.startsWith("review:")) {
      const range = parseReviewHandle(target);
      return range && (await context.reviewRangeHasChanges(range)) ? ["duplicates"] : FRESHNESS_STAGES;
    }
    return target.startsWith("sql:") ? SYMBOL_GRAPH_STAGES : ["symbols", "duplicates"];
  },
  calls: () => SYMBOL_GRAPH_STAGES,
  callers: () => SYMBOL_GRAPH_STAGES,
  callees: () => SYMBOL_GRAPH_STAGES,
  type_hierarchy: () => SYMBOL_GRAPH_STAGES,
  supertypes: () => SYMBOL_GRAPH_STAGES,
  subtypes: () => SYMBOL_GRAPH_STAGES,
  implementations: () => SYMBOL_GRAPH_STAGES,
  rename_preview: () => SYMBOL_GRAPH_STAGES,
  refactor_plan: () => SYMBOL_GRAPH_STAGES,
  // Takes its turn of the lock, which starts once no build runs.
  artifact_build: () => ["symbols", "idle"],
  // Answers from the SQLite artifact, so a fresh one never waits. The handler waits for the session itself, within the
  // same budget, when the artifact is stale.
  query_sqlite: () => NO_STAGES,
  // Takes its own turn, inside one wait: it takes the outcome of a refresh that its call handed off, or waits for the
  // builds that run, replaces the session, and rebuilds it. See `refresh_index` in the handlers.
  refresh_index: () => NO_STAGES,
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
