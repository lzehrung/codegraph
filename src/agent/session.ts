import fsp from "node:fs/promises";
import path from "node:path";
import { boundList } from "../presentation/bounds.js";
import { buildProjectIndexIncremental } from "../indexer/build-index.js";
import { resolveIncrementalFilePlan, type IncrementalFilePlan } from "../indexer/incremental-plan.js";
import type { BuildOptions, BuildReport, IncrementalBuildOptions, ProjectIndex } from "../indexer/types.js";
import { tryLoadDetailedSymbolGraphSnapshot, writeDetailedSymbolGraphSnapshot } from "../indexer/build-cache.js";
import { buildSymbolGraphDetailed } from "../graphs/symbol-graph-detailed.js";
import { buildSymbolGraph, type SymbolGraph } from "../graphs/symbol-graph.js";
import type { Graph } from "../types.js";
import { listProjectFiles, type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { mapLimit } from "../util/concurrency.js";
import { normalizePath, toProjectDisplayPath } from "../util/paths.js";
import { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions, mergeGraphOptions } from "../config.js";
import { languageExtensionPatterns, normalizeLanguageExtensions } from "../languages.js";
import { createAgentFileLookup } from "./normalize.js";
import { summarizeAnalysis, type AnalysisSummary } from "../analysisSummary.js";
import { runSessionInvalidationHooks } from "./sessionLifecycle.js";
import { prepareDuplicateAnalysis, type DuplicatePreparedAnalysis } from "../duplicates.js";

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
  /**
   * - `eager` (default): detailed symbol graph (sidecar or buildSymbolGraphDetailed)
   * - `basic`: in-memory buildSymbolGraph from the loaded index (no detailed sidecar)
   * - `skip`: empty symbol graph
   */
  symbolGraph?: "eager" | "basic" | "skip";
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
  /** Bucketed duplicate-detection analysis for the current index, memoized for the session. */
  loadDuplicateAnalysis?: () => Promise<DuplicatePreparedAnalysis>;
  checkFreshness?: () => Promise<AgentFreshnessResult>;
  invalidate: () => void;
};

export function assertNoPrebuiltSessionWithBuildOptions(
  options: { session?: AgentSession; buildOptions?: BuildOptions },
  consumer: string,
): void {
  if (options.session && options.buildOptions) {
    throw new Error(`${consumer} cannot combine a prebuilt session with buildOptions.`);
  }
}

const EMPTY_SYMBOL_GRAPH: SymbolGraph = {
  nodes: new Map(),
  edges: [],
};
import { NATIVE_WORKER_AUTO_FILE_THRESHOLD } from "../indexer/build-workers.js";
export { NATIVE_WORKER_AUTO_FILE_THRESHOLD };
export const AGENT_FRESHNESS_CHECK_INTERVAL_MS = 5_000;
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
  graphOptions?: BuildOptions["graph"];
  languageExtensions?: BuildOptions["languageExtensions"];
  cacheLocation?: BuildOptions["cacheLocation"];
};

type AgentSessionFilePlan = AgentDiscoverySettings & {
  files: string[];
  incrementalPlan?: IncrementalFilePlan;
  /** When file planning began, so the build reports the wait including discovery. */
  startedAt: number;
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
  const graph = mergeGraphOptions(config.graph, options.buildOptions?.graph);
  const graphOptions = config.graph || options.buildOptions?.graph ? graph : undefined;
  const languageExtensions =
    normalizeLanguageExtensions(options.buildOptions?.languageExtensions) ?? config.languages?.extensions;
  const cacheLocation = options.buildOptions?.cacheLocation ?? config.cache?.location;
  const discoveryOptions = hasDiscoveryOptions(discovery)
    ? { ...discovery, globRoot: discovery.globRoot ?? options.root }
    : undefined;
  return {
    ...(discoveryOptions ? { discoveryOptions } : {}),
    ...(graphOptions ? { graphOptions } : {}),
    ...(languageExtensions ? { languageExtensions } : {}),
    ...(cacheLocation ? { cacheLocation } : {}),
  };
}

function emitAgentFilePlanProgress(options: AgentSessionOptions): void {
  options.buildOptions?.onProgress?.({
    type: "progress",
    phase: "start",
    mode: "check",
    message: "Discovering source files",
    activity: "Discovering source files",
    current: 0,
    total: 0,
  });
}

/**
 * Report discovery work while it runs. Discovery walks or Git-lists the whole project
 * before any file is parsed, and on a project holding a large ignored tree that phase can
 * dominate the command. Without these updates the only output is the one "Discovering
 * source files" line, which is indistinguishable from a hang.
 */
function agentDiscoveryProgressReporter(
  options: AgentSessionOptions,
): ((progress: { activity: string; current: number; total: number }) => void) | undefined {
  const onProgress = options.buildOptions?.onProgress;
  if (!onProgress) return undefined;
  return ({ activity, current, total }) => {
    onProgress({
      type: "progress",
      phase: "update",
      mode: "check",
      message: activity,
      activity,
      current,
      total,
    });
  };
}

async function resolveAgentSessionFilePlan(options: AgentSessionOptions): Promise<AgentSessionFilePlan> {
  const startedAt = performance.now();
  const { discoveryOptions, graphOptions, languageExtensions, cacheLocation } =
    await resolveAgentDiscoverySettings(options);
  // Prefer the manifest-plus-Git reconciliation over a full recursive scan whenever it
  // can be trusted. Preserve its changed/untracked evidence so the indexer does not
  // repeat the same Git subprocesses immediately afterward.
  const incrementalOptions: BuildOptions = {
    ...options.buildOptions,
    ...(discoveryOptions ? { discovery: discoveryOptions } : {}),
    ...(graphOptions ? { graph: graphOptions } : {}),
    ...(languageExtensions ? { languageExtensions } : {}),
    ...(cacheLocation ? { cacheLocation } : {}),
  };
  const incrementalPlan = await resolveIncrementalFilePlan(options.root, incrementalOptions);
  if (incrementalPlan) {
    return {
      files: incrementalPlan.files,
      incrementalPlan,
      startedAt,
      ...(discoveryOptions ? { discoveryOptions } : {}),
      ...(graphOptions ? { graphOptions } : {}),
      ...(languageExtensions ? { languageExtensions } : {}),
      ...(cacheLocation ? { cacheLocation } : {}),
    };
  }
  const { DEFAULT_PROJECT_PATTERNS } = await import("../util/projectFiles.js");
  const customPatterns = languageExtensionPatterns(languageExtensions);
  const patterns = customPatterns.length ? [...DEFAULT_PROJECT_PATTERNS, ...customPatterns] : undefined;
  emitAgentFilePlanProgress(options);
  const onDiscoveryProgress = agentDiscoveryProgressReporter(options);
  const files = await listProjectFiles(options.root, patterns, {
    ...discoveryOptions,
    ...(onDiscoveryProgress ? { onDiscoveryProgress } : {}),
  });
  return {
    files,
    startedAt,
    ...(discoveryOptions ? { discoveryOptions } : {}),
    ...(graphOptions ? { graphOptions } : {}),
    ...(languageExtensions ? { languageExtensions } : {}),
    ...(cacheLocation ? { cacheLocation } : {}),
  };
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
  const bounded = boundList(files, DEFAULT_MAX_FRESHNESS_CHANGED_FILES);
  return {
    changedFiles: bounded.items,
    changedFileCount: files.length,
    omittedChangedFileCount: bounded.omitted,
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

function agentFileSignatureFromManifest(file: string, signature: string): AgentFileSignature | undefined {
  const firstSeparator = signature.indexOf(":");
  if (firstSeparator < 1) return undefined;
  const secondSeparator = signature.indexOf(":", firstSeparator + 1);
  const sizeEnd = secondSeparator < 0 ? signature.length : secondSeparator;
  const mtimeMs = Number(signature.slice(0, firstSeparator));
  const size = Number(signature.slice(firstSeparator + 1, sizeEnd));
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size) || mtimeMs < 0 || size < 0) return undefined;
  return { file, size, mtimeMs };
}

async function collectBuiltAgentFileSignatures(
  files: readonly string[],
  index: ProjectIndex,
): Promise<Map<string, AgentFileSignature>> {
  const signatures = new Map<string, AgentFileSignature>();
  const missing: string[] = [];
  for (const file of files) {
    const resolvedFile = normalizePath(path.resolve(file));
    const entry = index.manifestSignaturesFresh ? index.manifestEntries?.get(resolvedFile) : undefined;
    const signature = entry ? agentFileSignatureFromManifest(resolvedFile, entry.sig) : undefined;
    if (signature) {
      signatures.set(resolvedFile, signature);
    } else {
      missing.push(resolvedFile);
    }
  }
  if (missing.length) {
    const fallback = await collectAgentFileSignatures(missing);
    for (const [file, signature] of fallback) signatures.set(file, signature);
  }
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
  let cachedBasicSymbolGraph: Promise<SymbolGraph> | undefined;
  let cachedEagerSnapshot: Promise<AgentProjectSnapshot> | undefined;
  let cachedBasicSnapshot: Promise<AgentProjectSnapshot> | undefined;
  let cachedSkippedSnapshot: Promise<AgentProjectSnapshot> | undefined;
  let cachedFileSignatures: Map<string, AgentFileSignature> | undefined;
  let cachedDuplicateAnalysis: Promise<DuplicatePreparedAnalysis> | undefined;

  let lastFreshnessCheckedAt = 0;
  let lastFreshnessResult: AgentFreshnessResult | undefined;
  let freshnessInFlight: Promise<AgentFreshnessResult> | undefined;

  const invalidate = (): void => {
    runSessionInvalidationHooks(session);
    cachedFilePlan = undefined;
    cachedFiles = undefined;
    cachedBase = undefined;
    cachedSymbolGraph = undefined;
    cachedBasicSymbolGraph = undefined;
    cachedEagerSnapshot = undefined;
    cachedBasicSnapshot = undefined;
    cachedSkippedSnapshot = undefined;
    cachedFileSignatures = undefined;
    cachedDuplicateAnalysis = undefined;
    lastFreshnessCheckedAt = 0;
    lastFreshnessResult = undefined;
    freshnessInFlight = undefined;
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
      const { files, discoveryOptions, graphOptions, languageExtensions, cacheLocation, incrementalPlan, startedAt } =
        await loadFilePlan();
      const buildOptions: IncrementalBuildOptions = {
        ...options.buildOptions,
        ...(graphOptions ? { graph: graphOptions } : {}),
        cache: options.buildOptions?.cache ?? "disk",
        keepParsed: options.buildOptions?.keepParsed ?? true,
        files,
        filesAreProjectScope: true,
        // Discovery ran before this build, so the completion event must measure from there.
        progressStartedAt: options.buildOptions?.progressStartedAt ?? startedAt,
        ...(incrementalPlan
          ? {
              reconciledManifestUpdatedAt: incrementalPlan.manifestUpdatedAt,
              reconciledWorkingTreeDiffFiles: incrementalPlan.workingTreeDiffFiles,
              reconciledUntrackedFiles: incrementalPlan.untrackedFiles,
            }
          : {}),
        ...(discoveryOptions ? { discovery: discoveryOptions } : {}),
        ...(languageExtensions ? { languageExtensions } : {}),
        ...(cacheLocation ? { cacheLocation } : {}),
      };
      // Let the incremental build decide after it identifies parse misses. Session file counts
      // include cache hits and files that cannot use native workers, so forcing a pool here can
      // start idle workers for a small incremental update.
      const buildReport: BuildReport = options.buildOptions?.report ?? { timings: {} };
      buildOptions.report = buildReport;
      const index = await buildProjectIndexIncremental(options.root, buildOptions);
      if (options.freshness?.policy !== "manual") {
        cachedFileSignatures = await collectBuiltAgentFileSignatures(files, index);
      }
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
    const loadPromise = (async () => {
      const { graphOptions, cacheLocation } = await loadFilePlan();
      const cacheOptions: BuildOptions = {
        ...options.buildOptions,
        ...(graphOptions ? { graph: graphOptions } : {}),
        cache: options.buildOptions?.cache ?? "disk",
        ...(cacheLocation ? { cacheLocation } : {}),
      };
      const persisted = await tryLoadDetailedSymbolGraphSnapshot(
        options.root,
        cacheOptions,
        base.index,
        base.buildReport,
      );
      if (persisted) return persisted;
      const built = await buildSymbolGraphDetailed(base.index);
      await writeDetailedSymbolGraphSnapshot(options.root, cacheOptions, base.index, built);
      return built;
    })();
    cachedSymbolGraph = loadPromise;
    loadPromise.catch(() => {
      if (cachedSymbolGraph === loadPromise) cachedSymbolGraph = undefined;
    });
    return loadPromise;
  };

  const loadBasicSymbolGraph = async (base: AgentProjectBaseSnapshot): Promise<SymbolGraph> => {
    // Prefer an already-loaded detailed graph (superset) when present.
    if (cachedSymbolGraph) return cachedSymbolGraph;
    if (cachedBasicSymbolGraph) return cachedBasicSymbolGraph;
    const loadPromise = buildSymbolGraph(base.index);
    cachedBasicSymbolGraph = loadPromise;
    loadPromise.catch(() => {
      if (cachedBasicSymbolGraph === loadPromise) cachedBasicSymbolGraph = undefined;
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

    if (loadOptions?.symbolGraph === "basic") {
      // If detailed was already loaded in this session, reuse it.
      if (cachedEagerSnapshot) return await cachedEagerSnapshot;
      cachedBasicSnapshot ??= loadBase().then(async (base) => ({
        ...base,
        symbolGraph: await loadBasicSymbolGraph(base),
      }));
      cachedBasicSnapshot.catch(() => {
        cachedBasicSnapshot = undefined;
      });
      return await cachedBasicSnapshot;
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

  const loadDuplicateAnalysis = async (): Promise<DuplicatePreparedAnalysis> => {
    if (cachedDuplicateAnalysis) return cachedDuplicateAnalysis;
    const loadPromise = loadBase().then((base) => prepareDuplicateAnalysis(base.index, { projectRoot: options.root }));
    cachedDuplicateAnalysis = loadPromise;
    loadPromise.catch(() => {
      if (cachedDuplicateAnalysis === loadPromise) cachedDuplicateAnalysis = undefined;
    });
    return loadPromise;
  };

  const checkFreshness = async (): Promise<AgentFreshnessResult> => {
    const policy = options.freshness?.policy ?? "check";
    if (policy === "manual") return { state: "fresh" };
    if (!cachedBase || !cachedFileSignatures) return { state: "fresh" };

    const now = Date.now();
    if (lastFreshnessResult && now - lastFreshnessCheckedAt < AGENT_FRESHNESS_CHECK_INTERVAL_MS) {
      return lastFreshnessResult;
    }
    if (freshnessInFlight) return freshnessInFlight;

    freshnessInFlight = (async (): Promise<AgentFreshnessResult> => {
      await cachedBase;
      // Reuse the same fast-path-aware resolution loadFiles()/discoverFiles() use, instead
      // of an independent full scan, so freshness checks stay cheap on unchanged repos too.
      const currentFiles = await listAgentSessionFiles(options);
      const currentSignatures = await collectAgentFileSignatures(currentFiles);
      const signatures = cachedFileSignatures;
      if (!signatures) return { state: "fresh" };
      const diff = diffAgentFileSignatures(signatures, currentSignatures);
      let result: AgentFreshnessResult;
      if (!diff.changedFiles.length) {
        result = { state: "fresh" };
      } else {
        const changedFiles = diff.changedFiles.map((file) => toProjectDisplayPath(options.root, file));
        if (policy === "check") {
          result = {
            state: "stale",
            ...summarizeChangedFiles(changedFiles),
            reason: "session snapshot is older than files on disk",
          };
        } else {
          const maxFiles = options.freshness?.maxAutoRefreshFiles ?? DEFAULT_MAX_AUTO_REFRESH_FILES;
          const maxBytes = options.freshness?.maxAutoRefreshBytes ?? DEFAULT_MAX_AUTO_REFRESH_BYTES;
          if (diff.changedFiles.length > maxFiles) {
            result = {
              state: "stale",
              ...summarizeChangedFiles(changedFiles),
              reason: `changed file count exceeds ${maxFiles}`,
            };
          } else if (diff.changedBytes > maxBytes) {
            result = {
              state: "stale",
              ...summarizeChangedFiles(changedFiles),
              reason: `changed byte count exceeds ${maxBytes}`,
            };
          } else {
            invalidate();
            result = { state: "refreshed", changedFiles };
          }
        }
      }
      lastFreshnessCheckedAt = Date.now();
      lastFreshnessResult = result;
      return result;
    })().finally(() => {
      freshnessInFlight = undefined;
    });

    return freshnessInFlight;
  };

  const session: AgentSession = {
    root: options.root,
    discoverFiles: () => listAgentSessionFiles(options),
    listFiles: loadFiles,
    loadProject,
    loadDuplicateAnalysis,
    checkFreshness,
    invalidate,
  };
  return session;
}
