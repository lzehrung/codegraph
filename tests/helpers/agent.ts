import type { AgentLoadProjectOptions, AgentProjectSnapshot, AgentSession } from "../../src/agent/session.js";

type SymbolGraphLoadMode = NonNullable<AgentLoadProjectOptions["symbolGraph"]>;

const SYMBOL_GRAPH_MODE_RANK: Record<SymbolGraphLoadMode, number> = {
  skip: 0,
  basic: 1,
  eager: 2,
};

function resolveSymbolGraphMode(options?: AgentLoadProjectOptions): SymbolGraphLoadMode {
  return options?.symbolGraph ?? "eager";
}

/**
 * Count warm project opens, not symbol-graph mode switches.
 * `skip` < `basic` < `eager`: downgrades reuse a stronger cache; upgrades rebuild the
 * graph through the real session but still count as one warm session load.
 */
export function countingSession(session: AgentSession): { session: AgentSession; loads: () => number } {
  let cached: Promise<AgentProjectSnapshot> | undefined;
  let cachedMode: SymbolGraphLoadMode | undefined;
  let loadCount = 0;
  const countedSession: AgentSession = {
    ...(session.root ? { root: session.root } : {}),
    ...(session.listFiles ? { listFiles: session.listFiles } : {}),
    ...(session.discoverFiles ? { discoverFiles: session.discoverFiles } : {}),
    loadProject: async (options) => {
      const mode = resolveSymbolGraphMode(options);
      if (!cached || cachedMode === undefined) {
        loadCount += 1;
        cachedMode = mode;
        cached = session.loadProject(options);
        return await cached;
      }

      if (SYMBOL_GRAPH_MODE_RANK[mode] <= SYMBOL_GRAPH_MODE_RANK[cachedMode]) {
        return await cached;
      }

      // In-session upgrade (e.g. search basic → explain/refactor eager): keep one load.
      cachedMode = mode;
      cached = session.loadProject(options);
      return await cached;
    },
    invalidate: () => {
      cached = undefined;
      cachedMode = undefined;
      session.invalidate();
    },
  };
  const checkFreshness = session.checkFreshness;
  if (checkFreshness) {
    countedSession.checkFreshness = async () => {
      const freshness = await checkFreshness();
      if (freshness.state === "refreshed") {
        cached = undefined;
        cachedMode = undefined;
      }
      return freshness;
    };
  }
  return {
    session: countedSession,
    loads: () => loadCount,
  };
}
