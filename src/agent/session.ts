import fsp from "node:fs/promises";
import path from "node:path";
import { buildProjectIndexIncremental } from "../indexer/build-index.js";
import { resolveIncrementalFilePlan, type IncrementalFilePlan } from "../indexer/incremental-plan.js";
import type { BuildOptions, BuildReport, IncrementalBuildOptions, ProjectIndex } from "../indexer/types.js";
import { buildSymbolGraphDetailed } from "../graphs/symbol-graph-detailed.js";
import { type SymbolGraph } from "../graphs/symbol-graph.js";
import type { Graph } from "../types.js";
import { listProjectFiles, type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { mapLimit } from "../util/concurrency.js";
import { normalizePath, toProjectDisplayPath } from "../util/paths.js";
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
  discoverFiles?: () => Promise<string[]>;
  listFiles?: () => Promise<string[]>;
  loadProject: (loadOptions?: AgentLoadProjectOptions) => Promise<AgentProjectSnapshot>;
  checkFreshness?: () => Promise<AgentFreshnessResult>;
  invalidate: () => void;
};

const EMPTY_SYMBOL_GRAPH: SymbolGraph = {
  nodes: new Map(),
  edges: [],
};
export const NATIVE_WORKER_AUTO_FILE_THRESHOLD = 250;
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

type AgentSessionFilePlan = AgentDiscoverySettings & {
  files: string[];
  incrementalPlan?: IncrementalFilePlan;
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

async function resolveAgentSessionFilePlan(options: AgentSessionOptions): Promise<AgentSessionFilePlan> {
  const { discoveryOptions } = await resolveAgentDiscoverySettings(options);
  // Prefer the manifest-plus-Git reconciliation over a full recursive scan whenever it
  // can be trusted. Preserve its changed/untracked evidence so the indexer does not
  // repeat the same Git subprocesses immediately afterward.
  const incrementalOptions: BuildOptions = {
    ...options.buildOptions,
    ...(discoveryOptions ? { discovery: discoveryOptions } : {}),
  };
  const incrementalPlan = await resolveIncrementalFilePlan(options.root, incrementalOptions);
  if (incrementalPlan) {
    return {
      files: incrementalPlan.files,
      incrementalPlan,
      ...(discoveryOptions ? { discoveryOptions } : {}),
    };
  }
  const files = await listProjectFiles(options.root, undefined, discoveryOptions);
  return { files, ...(discoveryOptions ? { discoveryOptions } : {}) };
}

export async function listAgentSessionFiles(options: AgentSessionOptions): Promise<string[]> {
  return (await resolveAgentSessionFilePlan(options)).files;
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

const FILE_SIGNATURE_STAT_CONCURRENCY = 64;

async function collectAgentFileSignatures(files: readonly string[]): Promise<Map<string, AgentFileSignature>> {
  const signatures = new Map<string, AgentFileSignature>();
  await mapLimit([...files], FILE_SIGNATURE_STAT_CONCURRENCY, async (file) => {
    const resolvedFile = normalizePath(path.resolve(file));
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
  });
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
  for (const [file, previousSignature] of previous.entries()) {
    if (current.has(file)) continue;
    changedFiles.push(file);
    changedBytes += previousSignature.size;
  }
  changedFiles.sort();
  return { changedFiles, changedBytes };
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  let cachedFilePlan: Promise<AgentSessionFilePlan> | undefined;
  let cachedFiles: Promise<string[]> | undefined;
  let cachedBase: Promise<AgentProjectBaseSnapshot> | undefined;
  let cachedSymbolGraph: Promise<SymbolGraph> | undefined;
  let cachedEagerSnapshot: Promise<AgentProjectSnapshot> | undefined;
  let cachedSkippedSnapshot: Promise<AgentProjectSnapshot> | undefined;
  let cachedFileSignatures: Map<string, AgentFileSignature> | undefined;

  const invalidate = (): void => {
    cachedFilePlan = undefined;
    cachedFiles = undefined;
    cachedBase = undefined;
    cachedSymbolGraph = undefined;
    cachedEagerSnapshot = undefined;
    cachedSkippedSnapshot = undefined;
    cachedFileSignatures = undefined;
  };

  const loadFilePlan = async (): Promise<AgentSessionFilePlan> => {
    if (cachedFilePlan) return cachedFilePlan;
    const loadPromise = resolveAgentSessionFilePlan(options);
    cachedFilePlan = loadPromise;
    loadPromise.catch(() => {
      if (cachedFilePlan === loadPromise) cachedFilePlan = undefined;
    });
    return loadPromise;
  };

  const loadFiles = async (): Promise<string[]> => {
    if (cachedFiles) return cachedFiles;
    const loadPromise = loadFilePlan().then((plan) => plan.files);
    cachedFiles = loadPromise;
    loadPromise.catch(() => {
      if (cachedFiles === loadPromise) cachedFiles = undefined;
    });
    return loadPromise;
  };

  const loadBase = async (): Promise<AgentProjectBaseSnapshot> => {
    if (cachedBase) return cachedBase;
    const loadPromise = (async () => {
      const { files, discoveryOptions, incrementalPlan } = await loadFilePlan();
      if (options.freshness?.policy !== "manual") {
        cachedFileSignatures = await collectAgentFileSignatures(files);
      }
      const buildOptions: IncrementalBuildOptions = {
        ...options.buildOptions,
        cache: options.buildOptions?.cache ?? "disk",
        keepParsed: options.buildOptions?.keepParsed ?? true,
        files,
        filesAreProjectScope: true,
        ...(incrementalPlan
          ? {
              reconciledManifestUpdatedAt: incrementalPlan.manifestUpdatedAt,
              reconciledWorkingTreeDiffFiles: incrementalPlan.workingTreeDiffFiles,
              reconciledUntrackedFiles: incrementalPlan.untrackedFiles,
            }
          : {}),
        ...(discoveryOptions ? { discovery: discoveryOptions } : {}),
      };
      if (options.buildOptions?.useNativeWorkers === undefined && files.length >= NATIVE_WORKER_AUTO_FILE_THRESHOLD) {
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
        ...(cachedFileSignatures ? { fileSignatures: cachedFileSignatures } : {}),
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

    // Reuse the same fast-path-aware resolution loadFiles()/discoverFiles() use, instead
    // of an independent full scan, so freshness checks stay cheap on unchanged repos too.
    const currentFiles = await listAgentSessionFiles(options);
    const currentSignatures = await collectAgentFileSignatures(currentFiles);
    const diff = diffAgentFileSignatures(cachedFileSignatures, currentSignatures);
    if (!diff.changedFiles.length) return { state: "fresh" };

    const changedFiles = diff.changedFiles.map((file) => toProjectDisplayPath(options.root, file));
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
    discoverFiles: () => listAgentSessionFiles(options),
    listFiles: loadFiles,
    loadProject,
    checkFreshness,
    invalidate,
  };
}
