import type { AgentLoadProjectOptions, AgentProjectSnapshot, AgentSession } from "../../src/agent/session.js";

export function countingSession(session: AgentSession): { session: AgentSession; loads: () => number } {
  let cached: Promise<AgentProjectSnapshot> | undefined;
  let cachedMode: AgentLoadProjectOptions["symbolGraph"] | undefined;
  let loadCount = 0;
  return {
    session: {
      ...(session.root ? { root: session.root } : {}),
      ...(session.listFiles ? { listFiles: session.listFiles } : {}),
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
    },
    loads: () => loadCount,
  };
}
