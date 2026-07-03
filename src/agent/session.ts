import fsp from "node:fs/promises";
import path from "node:path";
import { buildProjectIndexIncremental } from "../indexer/build-index.js";
import type { BuildOptions, BuildReport, ProjectIndex } from "../indexer/types.js";
import { buildSymbolGraphDetailed } from "../graphs/symbol-graph-detailed.js";
import { type SymbolGraph } from "../graphs/symbol-graph.js";
import type { Graph } from "../types.js";
import { listProjectFiles, type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions } from "../config.js";
import { createAgentFileLookup } from "./normalize.js";
import { summarizeAnalysis, type AnalysisSummary } from "../analysisSummary.js";

export type AgentProjectSnapshot = {
  root: string;
  files: string[];
  fileLookup?: ReadonlyMap<string, string>;
  index: ProjectIndex;
  fileGraph: Graph;
  symbolGraph: SymbolGraph;
  buildReport?: BuildReport;
  analysis: AnalysisSummary;
  fileSignatures?: ReadonlyMap<string, AgentFileSignature>;
};

export type AgentLoadProjectOptions = {
  symbolGraph?: "eager" | "skip";
};

export type AgentFreshnessPolicy = "manual" | "check" | "auto";

export type AgentFreshnessResult =
  | { state: "fresh" }
  | { state: "refreshed"; changedFiles: string[] }
  | {
      state: "stale";
      changedFiles: string[];
      changedFileCount: number;
      omittedChangedFileCount: number;
      reason: string;
    };

export type AgentSessionFreshnessOptions = {
  policy?: AgentFreshnessPolicy;
  maxAutoRefreshFiles?: number;
  maxAutoRefreshBytes?: number;
};

export type AgentSessionOptions = {
  root: string;
  discovery?: ProjectFileDiscoveryOptions;
  buildOptions?: BuildOptions;
  useConfig?: boolean;
  freshness?: AgentSessionFreshnessOptions;
};

export type AgentSession = {
  root?: string;
  listFiles?: () => Promise<string[]>;
  loadProject: (loadOptions?: AgentLoadProjectOptions) => Promise<AgentProjectSnapshot>;
  checkFreshness?: () => Promise<AgentFreshnessResult>;
  invalidate: () => void;
};

const EMPTY_SYMBOL_GRAPH: SymbolGraph = {
  nodes: new Map(),
  edges: [],
};
const AGENT_NATIVE_WORKER_AUTO_FILE_THRESHOLD = 250;
const DEFAULT_MAX_AUTO_REFRESH_FILES = 50;
const DEFAULT_MAX_AUTO_REFRESH_BYTES = 2_000_000;
const DEFAULT_MAX_FRESHNESS_CHANGED_FILES = 25;

type AgentProjectBaseSnapshot = Omit<AgentProjectSnapshot, "symbolGraph">;

export type AgentFileSignature = {
  file: string;
  size: number;
  mtimeMs: number;
};

type AgentDiscoverySettings = {
  discoveryOptions?: ProjectFileDiscoveryOptions;
};

type AgentFreshnessDiff = {
  changedFiles: string[];
  changedBytes: number;
};

async function resolveAgentDiscoverySettings(options: AgentSessionOptions): Promise<AgentDiscoverySettings> {
  const useConfig = options.useConfig ?? true;
  const config = useConfig ? await loadCodegraphConfig(options.root) : {};
  const optionDiscovery = mergeDiscoveryOptions(options.buildOptions?.discovery, options.discovery);
  const discovery = mergeDiscoveryOptions(config.discovery, optionDiscovery);
  const discoveryOptions = hasDiscoveryOptions(discovery)
    ? { ...discovery, globRoot: discovery.globRoot ?? options.root }
    : undefined;
  return discoveryOptions ? { discoveryOptions } : {};
}

export async function listAgentSessionFiles(options: AgentSessionOptions): Promise<string[]> {
  const { discoveryOptions } = await resolveAgentDiscoverySettings(options);
  return await listProjectFiles(options.root, undefined, discoveryOptions);
}

function isMissingStatRace(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function summarizeChangedFiles(files: readonly string[]): {
  changedFiles: string[];
  changedFileCount: number;
  omittedChangedFileCount: number;
} {
  const changedFiles = files.slice(0, DEFAULT_MAX_FRESHNESS_CHANGED_FILES);
  return {
    changedFiles,
    changedFileCount: files.length,
    omittedChangedFileCount: Math.max(0, files.length - changedFiles.length),
  };
}

async function collectAgentFileSignatures(files: readonly string[]): Promise<Map<string, AgentFileSignature>> {
  const signatures = new Map<string, AgentFileSignature>();
  await Promise.all(
    files.map(async (file) => {
      const resolvedFile = path.resolve(file);
      try {
        const stat = await fsp.stat(resolvedFile);
        if (!stat.isFile()) return;
        signatures.set(resolvedFile, {
          file: resolvedFile,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch (error) {
        if (isMissingStatRace(error)) return;
        throw new Error(`Unable to verify freshness for ${resolvedFile}`, { cause: error });
      }
    }),
  );
  return signatures;
}

function diffAgentFileSignatures(
  previous: ReadonlyMap<string, AgentFileSignature>,
  current: ReadonlyMap<string, AgentFileSignature>,
): AgentFreshnessDiff {
  const changedFiles: string[] = [];
  let changedBytes = 0;
  for (const [file, currentSignature] of current.entries()) {
    const previousSignature = previous.get(file);
    if (
      !previousSignature ||
      previousSignature.size !== currentSignature.size ||
      previousSignature.mtimeMs !== currentSignature.mtimeMs
    ) {
      changedFiles.push(file);
      changedBytes += currentSignature.size;
    }
  }
  for (const file of previous.keys()) {
    if (current.has(file)) continue;
    changedFiles.push(file);
  }
  changedFiles.sort();
  return { changedFiles, changedBytes };
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  let cachedFiles: Promise<string[]> | undefined;
  let cachedBase: Promise<AgentProjectBaseSnapshot> | undefined;
  let cachedSymbolGraph: Promise<SymbolGraph> | undefined;
  let cachedEagerSnapshot: Promise<AgentProjectSnapshot> | undefined;
  let cachedSkippedSnapshot: Promise<AgentProjectSnapshot> | undefined;
  let cachedFileSignatures: Map<string, AgentFileSignature> | undefined;

  const invalidate = (): void => {
    cachedFiles = undefined;
    cachedBase = undefined;
    cachedSymbolGraph = undefined;
    cachedEagerSnapshot = undefined;
    cachedSkippedSnapshot = undefined;
    cachedFileSignatures = undefined;
  };

  const loadFiles = async (): Promise<string[]> => {
    if (cachedFiles) return cachedFiles;
    const loadPromise = listAgentSessionFiles(options);
    cachedFiles = loadPromise;
    loadPromise.catch(() => {
      if (cachedFiles === loadPromise) cachedFiles = undefined;
    });
    return loadPromise;
  };

  const loadBase = async (): Promise<AgentProjectBaseSnapshot> => {
    if (cachedBase) return cachedBase;
    const loadPromise = (async () => {
      const { discoveryOptions } = await resolveAgentDiscoverySettings(options);
      const files = await loadFiles();
      cachedFileSignatures = await collectAgentFileSignatures(files);
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
      const buildReport: BuildReport = { timings: {} };
      buildOptions.report = buildReport;
      const index = await buildProjectIndexIncremental(options.root, buildOptions);
      const fileGraph = index.graph;

      return {
        root: options.root,
        files,
        fileLookup: createAgentFileLookup(files),
        index,
        fileGraph,
        fileSignatures: cachedFileSignatures,
        buildReport,
        analysis: summarizeAnalysis({ index, report: buildReport }),
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

  const checkFreshness = async (): Promise<AgentFreshnessResult> => {
    const policy = options.freshness?.policy ?? "check";
    if (policy === "manual") return { state: "fresh" };
    if (!cachedBase || !cachedFileSignatures) return { state: "fresh" };
    await cachedBase;

    const { discoveryOptions } = await resolveAgentDiscoverySettings(options);
    const currentFiles = await listProjectFiles(options.root, undefined, discoveryOptions);
    const currentSignatures = await collectAgentFileSignatures(currentFiles);
    const diff = diffAgentFileSignatures(cachedFileSignatures, currentSignatures);
    if (!diff.changedFiles.length) return { state: "fresh" };

    const changedFiles = diff.changedFiles.map((file) => {
      const relativeFile = path.relative(options.root, file).replace(/\\/g, "/");
      if (!relativeFile || relativeFile.startsWith("../")) return file.replace(/\\/g, "/");
      return relativeFile;
    });
    if (policy === "check") {
      return {
        state: "stale",
        ...summarizeChangedFiles(changedFiles),
        reason: "session snapshot is older than files on disk",
      };
    }

    const maxFiles = options.freshness?.maxAutoRefreshFiles ?? DEFAULT_MAX_AUTO_REFRESH_FILES;
    const maxBytes = options.freshness?.maxAutoRefreshBytes ?? DEFAULT_MAX_AUTO_REFRESH_BYTES;
    if (diff.changedFiles.length > maxFiles) {
      return {
        state: "stale",
        ...summarizeChangedFiles(changedFiles),
        reason: `changed file count exceeds ${maxFiles}`,
      };
    }
    if (diff.changedBytes > maxBytes) {
      return {
        state: "stale",
        ...summarizeChangedFiles(changedFiles),
        reason: `changed byte count exceeds ${maxBytes}`,
      };
    }

    invalidate();
    return { state: "refreshed", changedFiles };
  };

  return {
    root: options.root,
    listFiles: loadFiles,
    loadProject,
    checkFreshness,
    invalidate,
  };
}
