import { buildProjectIndex } from "../indexer.js";
import type { ProjectIndex } from "../indexer/types.js";
import { buildSymbolGraphDetailed, collectGraph } from "../graphs.js";
import type { SymbolGraph } from "../graphs.js";
import type { Graph } from "../types.js";
import { listProjectFiles, type ProjectFileDiscoveryOptions } from "../util.js";

export type AgentProjectSnapshot = {
  root: string;
  files: string[];
  index: ProjectIndex;
  fileGraph: Graph;
  symbolGraph: SymbolGraph;
};

export type AgentSessionOptions = {
  root: string;
  discovery?: ProjectFileDiscoveryOptions;
};

export type AgentSession = {
  loadProject: () => Promise<AgentProjectSnapshot>;
  invalidate: () => void;
};

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  let cached: Promise<AgentProjectSnapshot> | undefined;

  const loadProject = async (): Promise<AgentProjectSnapshot> => {
    if (cached) return cached;

    cached = (async () => {
      const files = await listProjectFiles(options.root, undefined, options.discovery);
      const index = await buildProjectIndex(options.root, {
        keepParsed: true,
        ...(options.discovery ? { discovery: options.discovery } : {}),
      });
      const fileGraph = await collectGraph(options.root, files, { allFiles: files });
      const symbolGraph = await buildSymbolGraphDetailed(index);

      return {
        root: options.root,
        files,
        index,
        fileGraph,
        symbolGraph,
      };
    })();

    return cached;
  };

  return {
    loadProject,
    invalidate: () => {
      cached = undefined;
    },
  };
}
