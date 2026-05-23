import type { AgentProjectSnapshot, AgentSession } from "../../src/agent/session.js";

export function countingSession(session: AgentSession): { session: AgentSession; loads: () => number } {
  let cached: Promise<AgentProjectSnapshot> | undefined;
  let loadCount = 0;
  return {
    session: {
      loadProject: async () => {
        if (!cached) {
          loadCount += 1;
          cached = session.loadProject();
        }
        return await cached;
      },
      invalidate: () => {
        cached = undefined;
        session.invalidate();
      },
    },
    loads: () => loadCount,
  };
}
