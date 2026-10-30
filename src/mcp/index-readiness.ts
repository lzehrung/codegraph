import {
  canUsePathFastPath,
  searchNeedsSymbolGraph,
  searchUsesQueryIndex,
  type AgentSearchMode,
} from "../agent/search.js";
import { checkSessionFreshness, type AgentSession } from "../agent/session.js";
import { registerSessionInvalidationHook } from "../agent/session-lifecycle.js";
import type { ProgressUpdate } from "../types.js";
import { mcpCancellationError } from "./cancellation.js";
import { describeMcpRuntimeError } from "./stale-install.js";

/**
 * The longest one tool call waits for an index build before it answers `index_building`. It stays below the 30 seconds
 * that MCP clients commonly allow for a request.
 */
export const DEFAULT_MCP_INDEX_WAIT_MS = 15_000;
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
 * The loads of the session that a tool call waits for. The session shares and memoizes each one, so a call joins the
 * build that the warmup or another call started, and the handler that runs afterwards finds the result ready.
 * - `index`: the project index, which every index-backed tool reads.
 * - `symbolGraph`: the in-memory symbol graph that hybrid, symbol, and graph searches read.
 * - `queryIndex`: the search index that hybrid and text searches read.
 * - `detailedGraph`: the detailed symbol graph that `packet_get` and `explore` source packets read.
 * - `duplicates`: the duplicate analysis that `review`, `packet_get`, and `explore` source packets read.
 */
export type McpIndexNeed = "index" | "symbolGraph" | "queryIndex" | "detailedGraph" | "duplicates";

/**
 * What a search reads, as `searchCodegraphWithSession` decides it: a path search lists files and builds nothing, and the
 * other modes read the project index, the symbol graph (hybrid, symbol, graph), and the query index (hybrid, text).
 * Waiting for a path search is only the freshness check that every call makes.
 */
export function searchNeeds(request: {
  mode?: AgentSearchMode | undefined;
  from?: string | undefined;
}): McpIndexNeed[] {
  if (canUsePathFastPath(request)) return [];
  const needs: McpIndexNeed[] = [searchNeedsSymbolGraph(request) ? "symbolGraph" : "index"];
  if (searchUsesQueryIndex(request)) needs.push("queryIndex");
  return needs;
}

/**
 * `explore` searches in hybrid mode. Its source packets, which are off by default over MCP, read the detailed symbol
 * graph and the duplicate analysis.
 */
export function exploreNeeds(request: {
  includeSource?: boolean | undefined;
  maxPackets?: number | undefined;
}): McpIndexNeed[] {
  const needs = searchNeeds({});
  if (request.includeSource && request.maxPackets !== 0) needs.push("detailedGraph", "duplicates");
  return needs;
}

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

/** Keeps the latest update of the session's own index build, for the progress of an `index_building` answer. */
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
  /** What the startup warmup loads once the server is serving; empty builds nothing up front. */
  warmup: readonly McpIndexNeed[];
  progress: McpBuildProgress;
};

/**
 * Needs that depend on what the first ones loaded, asked for once those are loaded and inside the same wait.
 * `packet_get` reads the duplicate analysis only for a target that resolves to a file or a symbol, and the resolution
 * reads the detailed symbol graph, so it cannot say what it needs before that graph is loaded.
 */
export type McpFollowUpNeeds = () => Promise<readonly McpIndexNeed[]>;

export type McpIndexReadiness = {
  /**
   * Starts the startup warmup, once; call it when the server is ready to serve. The warmup runs in the background and
   * its failure is logged: the next call that needs the index builds it again and reports that error itself.
   */
  startWarmup: () => void;
  /**
   * Settles when no load that the server started runs, at once when none was started: the loads of the warmup and of
   * every wait of a call, including a call that stopped waiting and a load that ran beside one that failed. Loads that
   * start while it waits count too. Never rejects.
   */
  buildsSettled: () => Promise<void>;
  /**
   * Waits for the freshness check that every index-backed handler runs, for the session loads that `needs` names, for
   * the loads that `followUp` names once those are loaded, and for the check again, so that the handler that runs next
   * finds all of it ready. When the session is replaced meanwhile, which drops what was loaded, the loads run again for
   * the new session, up to {@link MAX_READINESS_ROUNDS} times in all. A file that changed makes the final check do it,
   * and so do the file watcher and `refresh_index`. It all shares one budget: past it the call throws
   * {@link McpIndexBuildingError}; the loads continue, and the next call joins them. A load that fails fails the call at
   * once. A cancelled call stops waiting.
   */
  waitFor: (
    tool: string,
    needs: readonly McpIndexNeed[],
    signal?: AbortSignal,
    followUp?: McpFollowUpNeeds,
  ) => Promise<void>;
};

const ACTIVITY: Record<McpIndexNeed, string> = {
  index: "Building project index",
  symbolGraph: "Building symbol graph",
  queryIndex: "Building search index",
  detailedGraph: "Building detailed symbol graph",
  duplicates: "Preparing duplicate analysis",
};
const CHECKING_ACTIVITY = "Checking the project for changed files";

/**
 * How often one call runs its loads: once, and again each time that the session was replaced under what they had
 * loaded. A session that keeps being replaced leaves the rest to the freshness check of the call's own handler.
 */
const MAX_READINESS_ROUNDS = 3;

/**
 * Settles with `"ready"` when `work` settles, rethrows its failure, or settles with `"timeout"` after `budgetMs`.
 * Cancellation rejects. The work itself is never cancelled.
 */
function settleWithinBudget(
  work: Promise<unknown>,
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
  work.then(
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
  // The work that the server started, from its start until it settles, whether or not a call still waits for it. The
  // shutdown waits for all of it before it releases the session. Each entry consumes its own failure, so work that
  // nobody waits for cannot end as an unhandled rejection.
  const pending = new Set<Promise<unknown>>();
  let busySince: number | undefined;
  let warmupStarted = false;

  // Counts the invalidations of the session, each of which drops what the loads loaded. A hook runs once, so it
  // registers itself again.
  let invalidations = 0;
  const countInvalidations = (): void => {
    registerSessionInvalidationHook(session, () => {
      invalidations += 1;
      countInvalidations();
    });
  };
  countInvalidations();

  const track = <T>(work: Promise<T>): Promise<T> => {
    if (!pending.size) busySince = performance.now();
    pending.add(work);
    const release = (): void => {
      pending.delete(work);
      if (!pending.size) busySince = undefined;
    };
    work.then(release, release);
    return work;
  };
  const buildsSettled = async (): Promise<void> => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  const load = async (need: McpIndexNeed): Promise<void> => {
    if (need === "symbolGraph") {
      await session.loadProject({ symbolGraph: "basic" });
    } else if (need === "detailedGraph") {
      await session.loadProject();
    } else if (need === "duplicates") {
      await session.loadDuplicateAnalysis?.();
    } else if (need === "queryIndex") {
      const snapshot = await session.loadProject({ symbolGraph: "skip" });
      // A dynamic import on purpose: like `search`, the load pays for the SQLite store on first use, not at startup.
      const { ensureSessionQueryIndex } = await import("../agent/query-index/session-store.js");
      await ensureSessionQueryIndex(session, snapshot);
    } else {
      await session.loadProject({ symbolGraph: "skip" });
    }
  };

  // Each load is tracked on its own. When one fails, the loads of a call or of the warmup reject as a whole at once,
  // while the others still run, and the shutdown has to wait for those too.
  const trackedLoad = (need: McpIndexNeed): Promise<void> => track(load(need));

  const startWarmup = (): void => {
    if (warmupStarted) return;
    warmupStarted = true;
    if (!options.warmup.length) return;
    // The failure is logged here, where nobody else can report it: the next call that needs a build runs it again.
    void track(
      Promise.all(options.warmup.map(trackedLoad)).then(
        () => undefined,
        (error: unknown) => {
          console.error(`[codegraph] MCP startup warmup failed: ${describeMcpRuntimeError(error)}`);
        },
      ),
    );
  };

  const describeProgress = (
    needs: readonly McpIndexNeed[],
    done: ReadonlySet<McpIndexNeed>,
    waitedMs: number,
  ): McpIndexProgress => {
    const elapsedMs = Math.round(busySince === undefined ? waitedMs : performance.now() - busySince);
    // Only the project index reports counts; the loads after it have one activity each.
    const update = options.progress.latest();
    if (update) {
      return {
        activity: update.activity,
        ...(update.total > 0 ? { current: update.current, total: update.total } : {}),
        elapsedMs,
      };
    }
    const unfinished = needs.find((need) => !done.has(need));
    return { activity: unfinished ? ACTIVITY[unfinished] : CHECKING_ACTIVITY, elapsedMs };
  };

  const waitFor = async (
    tool: string,
    needs: readonly McpIndexNeed[],
    signal?: AbortSignal,
    followUp?: McpFollowUpNeeds,
  ): Promise<void> => {
    if (signal?.aborted) throw mcpCancellationError(signal);
    const startedAt = performance.now();
    // What this round asks for and has loaded: `wanted` grows by the follow-up, and both start over for a new round, so
    // that the progress of an `index_building` answer names what runs now.
    let wanted: McpIndexNeed[] = [...needs];
    const done = new Set<McpIndexNeed>();
    const loadAll = async (list: readonly McpIndexNeed[]): Promise<void> => {
      await Promise.all(
        list.map(async (need) => {
          await trackedLoad(need);
          done.add(need);
        }),
      );
    };
    // The check first, because it waits for a build that runs and replaces the session when files changed, so that the
    // loads below are the ones of the session the handler reads. The check again, because a session that was not built
    // yet is checked against files only once it is. A file that changed while the loads ran makes that check replace the
    // session, and so do the file watcher and `refresh_index`: what the loads loaded is gone, and the handler would
    // build it again outside the budget. So the loads run again, and the target-dependent follow-up with them, inside
    // the same wait. Each round ends with the check that starts the next one.
    const ready = track(
      (async (): Promise<void> => {
        await checkSessionFreshness(session);
        for (let round = 0; round < MAX_READINESS_ROUNDS; round += 1) {
          const loadedAt = invalidations;
          wanted = [...needs];
          done.clear();
          await loadAll(needs);
          if (followUp) {
            const later = await followUp();
            wanted.push(...later);
            await loadAll(later);
          }
          await checkSessionFreshness(session);
          if (invalidations === loadedAt) return;
        }
      })(),
    );
    if ((await settleWithinBudget(ready, options.waitMs, signal)) === "ready") return;
    const waitedMs = Math.round(performance.now() - startedAt);
    const progress = describeProgress(wanted, done, waitedMs);
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

  return { startWarmup, buildsSettled, waitFor };
}
