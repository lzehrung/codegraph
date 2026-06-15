import { buildProjectIndexIncremental } from "../indexer/build-index.js";
import type { BuildOptions, ProjectIndex } from "../indexer/types.js";
import { buildSymbolGraphDetailed } from "../graphs/symbol-graph-detailed.js";
import { type SymbolGraph } from "../graphs/symbol-graph.js";
import type { Graph } from "../types.js";
import { listProjectFiles, type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions } from "../config.js";
import { createAgentFileLookup } from "./normalize.js";

export type AgentProjectSnapshot = {
  root: string;
  files: string[];
  fileLookup?: ReadonlyMap<string, string>;
  index: ProjectIndex;
  fileGraph: Graph;
  symbolGraph: SymbolGraph;
};

export type AgentLoadProjectOptions = {
  symbolGraph?: "eager" | "skip";
};

export type AgentSessionOptions = {
  root: string;
  discovery?: ProjectFileDiscoveryOptions;
  buildOptions?: BuildOptions;
  useConfig?: boolean;
};

export type AgentSession = {
  root: string;
  listFiles?: () => Promise<string[]>;
  loadProject: (loadOptions?: AgentLoadProjectOptions) => Promise<AgentProjectSnapshot>;
  invalidate: () => void;
};

type AgentProjectBaseSnapshot = Omit<AgentProjectSnapshot, "symbolGraph">;

const EMPTY_SYMBOL_GRAPH: SymbolGraph = {
  nodes: new Map(),
  edges: [],
};
const AGENT_NATIVE_WORKER_AUTO_FILE_THRESHOLD = 250;

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  let cachedFiles: Promise<string[]> | undefined;
  let cachedBase: Promise<AgentProjectBaseSnapshot> | undefined;
  let cachedSymbolGraph: Promise<SymbolGraph> | undefined;
  let cachedEagerSnapshot: Promise<AgentProjectSnapshot> | undefined;
  let cachedSkippedSnapshot: Promise<AgentProjectSnapshot> | undefined;

  const loadFiles = async (): Promise<string[]> => {
    if (cachedFiles) return cachedFiles;
    const loadPromise = (async () => {
      const useConfig = options.useConfig ?? true;
      const config = useConfig ? await loadCodegraphConfig(options.root) : {};
      const optionDiscovery = mergeDiscoveryOptions(options.buildOptions?.discovery, options.discovery);
      const discovery = mergeDiscoveryOptions(config.discovery, optionDiscovery);
      const discoveryOptions = hasDiscoveryOptions(discovery)
        ? { ...discovery, globRoot: discovery.globRoot ?? options.root }
        : undefined;

      return await listProjectFiles(options.root, undefined, discoveryOptions);
    })();
    cachedFiles = loadPromise;
    loadPromise.catch(() => {
      if (cachedFiles === loadPromise) cachedFiles = undefined;
    });
    return loadPromise;
  };

  const loadBase = async (): Promise<AgentProjectBaseSnapshot> => {
    if (cachedBase) return cachedBase;
    const loadPromise = (async () => {
      const useConfig = options.useConfig ?? true;
      const config = useConfig ? await loadCodegraphConfig(options.root) : {};
      const optionDiscovery = mergeDiscoveryOptions(options.buildOptions?.discovery, options.discovery);
      const discovery = mergeDiscoveryOptions(config.discovery, optionDiscovery);
      const discoveryOptions = hasDiscoveryOptions(discovery)
        ? { ...discovery, globRoot: discovery.globRoot ?? options.root }
        : undefined;
      const files = await loadFiles();
      const buildOptions: BuildOptions & { files: string[] } = {
        ...options.buildOptions,
        cache: options.buildOptions?.cache ?? "disk",
        keepParsed: options.buildOptions?.keepParsed ?? true,
        files,
        ...(discoveryOptions ? { discovery: discoveryOptions } : {}),
      };
      if (
        options.buildOptions?.useNativeWorkers === undefined &&
        files.length >= AGENT_NATIVE_WORKER_AUTO_FILE_THRESHOLD
      ) {
        buildOptions.useNativeWorkers = true;
      }
      const index = await buildProjectIndexIncremental(options.root, buildOptions);
      const fileGraph = index.graph;

      return {
        root: options.root,
        files,
        fileLookup: createAgentFileLookup(files),
        index,
        fileGraph,
      };
    })();
    cachedBase = loadPromise;
    loadPromise.catch(() => {
      if (cachedBase === loadPromise) cachedBase = undefined;
    });

    return loadPromise;
  };

  const loadSymbolGraph = async (base: AgentProjectBaseSnapshot): Promise<SymbolGraph> => {
    if (cachedSymbolGraph) return cachedSymbolGraph;
    const loadPromise = buildSymbolGraphDetailed(base.index);
    cachedSymbolGraph = loadPromise;
    loadPromise.catch(() => {
      if (cachedSymbolGraph === loadPromise) cachedSymbolGraph = undefined;
    });
    return loadPromise;
  };

  const loadProject = async (loadOptions?: AgentLoadProjectOptions): Promise<AgentProjectSnapshot> => {
    if (loadOptions?.symbolGraph === "skip") {
      cachedSkippedSnapshot ??= loadBase().then((base) => ({
        ...base,
        symbolGraph: EMPTY_SYMBOL_GRAPH,
      }));
      cachedSkippedSnapshot.catch(() => {
        cachedSkippedSnapshot = undefined;
      });
      return await cachedSkippedSnapshot;
    }

    cachedEagerSnapshot ??= loadBase().then(async (base) => ({
      ...base,
      symbolGraph: await loadSymbolGraph(base),
    }));
    cachedEagerSnapshot.catch(() => {
      cachedEagerSnapshot = undefined;
    });
    return await cachedEagerSnapshot;
  };

  return {
    root: options.root,
    listFiles: loadFiles,
    loadProject,
    invalidate: () => {
      cachedFiles = undefined;
      cachedBase = undefined;
      cachedSymbolGraph = undefined;
      cachedEagerSnapshot = undefined;
      cachedSkippedSnapshot = undefined;
    },
  };
}
