import { buildProjectIndexFromFiles } from "../indexer/build-index.js";
import type { ProjectIndex } from "../indexer/types.js";
import { buildSymbolGraphDetailed } from "../graphs/symbol-graph-detailed.js";
import { type SymbolGraph } from "../graphs/symbol-graph.js";
import type { Graph } from "../types.js";
import { listProjectFiles, type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions } from "../config.js";

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
  useConfig?: boolean;
};

export type AgentSession = {
  loadProject: () => Promise<AgentProjectSnapshot>;
  invalidate: () => void;
};

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  let cached: Promise<AgentProjectSnapshot> | undefined;

  const loadProject = async (): Promise<AgentProjectSnapshot> => {
    if (cached) return cached;

    const loadPromise = (async () => {
      const useConfig = options.useConfig ?? true;
      const config = useConfig ? await loadCodegraphConfig(options.root) : {};
      const discovery = mergeDiscoveryOptions(config.discovery, options.discovery);
      const discoveryOptions = hasDiscoveryOptions(discovery)
        ? { ...discovery, globRoot: discovery.globRoot ?? options.root }
        : undefined;
      const files = await listProjectFiles(options.root, undefined, discoveryOptions);
      const index = await buildProjectIndexFromFiles(options.root, files, {
        keepParsed: true,
        ...(discoveryOptions ? { discovery: discoveryOptions } : {}),
      });
      const fileGraph = index.graph;
      const symbolGraph = await buildSymbolGraphDetailed(index);

      return {
        root: options.root,
        files,
        index,
        fileGraph,
        symbolGraph,
      };
    })();
    cached = loadPromise;
    loadPromise.catch(() => {
      if (cached === loadPromise) cached = undefined;
    });

    return loadPromise;
  };

  return {
    loadProject,
    invalidate: () => {
      cached = undefined;
    },
  };
}
