import type { AgentLoadProjectOptions, AgentProjectSnapshot, AgentSession } from "../../src/agent/session.js";

export function countingSession(session: AgentSession): { session: AgentSession; loads: () => number } {
  let cached: Promise<AgentProjectSnapshot> | undefined;
  let cachedMode: AgentLoadProjectOptions["symbolGraph"] | undefined;
  let loadCount = 0;
  const countedSession: AgentSession = {
    ...(session.root ? { root: session.root } : {}),
    ...(session.listFiles ? { listFiles: session.listFiles } : {}),
    ...(session.discoverFiles ? { discoverFiles: session.discoverFiles } : {}),
    loadProject: async (options) => {
      const mode = options?.symbolGraph ?? "eager";
      if (!cached || cachedMode !== mode) {
        loadCount += 1;
        cachedMode = mode;
        cached = session.loadProject(options);
      }
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
