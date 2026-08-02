import fs from "node:fs";
import path from "node:path";
import { NATIVE_WORKER_AUTO_FILE_THRESHOLD } from "../agent/session.js";
import { findDuplicates, type DuplicateConfidence, type DuplicateGroup } from "../duplicates.js";
import { collectGraph } from "../graph-builder.js";
import { findDetailedCycles, getUnresolvedImports } from "../graphs/queries.js";
import { getHotspots } from "../graphs/hotspots.js";
import { type GraphBuildOptions } from "../graphs/types.js";
import { buildProjectIndexIncremental } from "../indexer/build-index.js";
import { type BuildOptions, type BuildReport } from "../indexer/types.js";
import {
  getNativeTreeSitterLoadError,
  getNativeTreeSitterSupportedLanguageIds,
  isNativeTreeSitterAvailable,
  type NativeRuntimeMode,
} from "../native/treeSitterNative.js";
import type { Graph } from "../types.js";
import { restrictGraphToIncludeRoots } from "../util/includeRoots.js";
import { supportForFile } from "../languages.js";
import { toProjectDisplayPath } from "../util/paths.js";
import { type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { parseCacheModeOption, parsePositiveIntegerOption } from "./options.js";
import { writeCliOutput } from "./pretty.js";

type CacheMode = "off" | "memory" | "disk";
const INSPECT_DUPLICATE_MIN_TOKENS = 60;
const INSPECT_DUPLICATE_MAX_PAIRS = 20_000;

type IndexCacheMetadata = {
  manifestPath: string;
  updatedAt?: number;
  lastCommit?: string;
};

type InspectReport = {
  root: string;
  includeRoots: string[];
  indexCache?: IndexCacheMetadata;
  backend: {
    native: {
      available: boolean;
      loadError?: string;
      supportedLanguageIds: string[];
    };
  };
  files: {
    total: number;
    byLanguage: Record<string, number>;
  };
  hotspots: Array<{
    file: string;
    fanIn: number;
    fanOut: number;
    score: number;
  }>;
  unresolved: {
    total: number;
    top: Array<{ name: string; importerCount: number }>;
  };
  cycles: {
    total: number;
    top: Array<{
      files: string[];
      priorityScore: number;
      size: number;
    }>;
  };
  duplicates:
    | { enabled: false }
    | {
        enabled: true;
        total: number;
        omitted: number;
        minConfidence: DuplicateConfidence;
        top: DuplicateOpportunitySummary[];
      };
  recommendedCommands: string[];
};

type DuplicateOpportunitySummary = {
  confidence: DuplicateConfidence;
  cloneType: DuplicateGroup["cloneType"];
  score: number;
  left: DuplicateOpportunitySide;
  right: DuplicateOpportunitySide;
  rawPairCount: number;
  reasons: string[];
};

type DuplicateOpportunitySide = {
  file: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
  name?: string;
};

export type InspectCommandContext = {
  projectRootFs: string;
  includeRootsAbs: string[];
  discoveryOptions: ProjectFileDiscoveryOptions;
  graphOptions: GraphBuildOptions | undefined;
  nativeMode: NativeRuntimeMode;
  workerOpts: { useNativeWorkers: true } | Record<string, never>;
  progressHandler: BuildOptions["onProgress"];
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  resolveFilesFromRoots: () => Promise<string[]>;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
};

function normalizePathForDisplay(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function defaultCacheIndexPath(projectRoot: string): string {
  return path.join(projectRoot, ".codegraph-cache", "index-v1");
}

function defaultCacheManifestPath(projectRoot: string): string {
  return path.join(defaultCacheIndexPath(projectRoot), "manifest.json");
}

function readIndexCacheMetadata(projectRoot: string): IndexCacheMetadata | null {
  const manifestPath = defaultCacheManifestPath(projectRoot);
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as {
      updatedAt?: number;
      lastCommit?: string;
    };
    return {
      manifestPath: normalizePathForDisplay(manifestPath),
      ...(typeof parsed.updatedAt === "number" ? { updatedAt: parsed.updatedAt } : {}),
      ...(typeof parsed.lastCommit === "string" && parsed.lastCommit ? { lastCommit: parsed.lastCommit } : {}),
    };
  } catch {
    return null;
  }
}

function formatIndexCacheMetadata(metadata: IndexCacheMetadata): string {
  const updatedAt = metadata.updatedAt !== undefined ? new Date(metadata.updatedAt).toISOString() : "unknown";
  const lastCommit = metadata.lastCommit ?? "unknown";
  return `Index cache: manifest=${metadata.manifestPath} updatedAt=${updatedAt} lastCommit=${lastCommit}`;
}

async function buildScopedReportGraph(
  projectRoot: string,
  includeRoots: string[],
  files: string[],
  opts: {
    cache?: CacheMode;
    discovery?: ProjectFileDiscoveryOptions;
    graphOptions?: GraphBuildOptions;
    nativeMode?: NativeRuntimeMode;
    workerOpts?: { useNativeWorkers: true } | Record<string, never>;
    progressHandler?: BuildOptions["onProgress"];
    report?: BuildReport;
    writeStderrLine: (message: string) => void;
  },
): Promise<{ graph: Graph; indexCache?: IndexCacheMetadata }> {
  const useDiskCache = opts.cache === "disk" || opts.cache === undefined;
  const indexCache = useDiskCache ? readIndexCacheMetadata(projectRoot) : null;
  if (indexCache) {
    opts.writeStderrLine(formatIndexCacheMetadata(indexCache));
    const index = await buildProjectIndexIncremental(projectRoot, {
      files,
      filesAreProjectScope: true,
      cache: "disk",
      ...(opts.discovery ? { discovery: opts.discovery } : {}),
      ...(opts.progressHandler ? { onProgress: opts.progressHandler } : {}),
      ...(opts.nativeMode && opts.nativeMode !== "auto" ? { native: opts.nativeMode } : {}),
      ...(opts.workerOpts ?? {}),
      ...(opts.graphOptions ? { graph: opts.graphOptions } : {}),
      ...(opts.report ? { report: opts.report } : {}),
    });
    return {
      graph: restrictGraphToIncludeRoots(index.graph, includeRoots, normalizePathForDisplay),
      indexCache,
    };
  }

  const sourceGraph = await collectGraph(projectRoot, files, {
    ...(opts.graphOptions ?? {}),
    ...(opts.report ? { report: opts.report } : {}),
  });
  return {
    graph: restrictGraphToIncludeRoots(sourceGraph, includeRoots, normalizePathForDisplay),
  };
}

function summarizeDuplicateSide(side: DuplicateGroup["primaryLeft"]): DuplicateOpportunitySide {
  return {
    file: side.file,
    startLine: side.startLine,
    endLine: side.endLine,
    tokenCount: side.tokenCount,
    ...(side.name ? { name: side.name } : {}),
  };
}

function summarizeDuplicateGroup(group: DuplicateGroup): DuplicateOpportunitySummary {
  return {
    confidence: group.confidence,
    cloneType: group.cloneType,
    score: group.score,
    left: summarizeDuplicateSide(group.primaryLeft),
    right: summarizeDuplicateSide(group.primaryRight),
    rawPairCount: group.rawPairCount,
    reasons: group.reasons,
  };
}

function countFilesByLanguage(files: Iterable<string>): Record<string, number> {
  const byLanguage: Record<string, number> = {};
  for (const file of files) {
    const languageId = supportForFile(file)?.id ?? "other";
    byLanguage[languageId] = (byLanguage[languageId] ?? 0) + 1;
  }
  return byLanguage;
}

function buildRecommendedInspectCommands(
  projectRoot: string,
  includeRoots: string[],
  hasCycles: boolean,
  hasUnresolvedImports: boolean,
): string[] {
  const rootFlag = `--root "${normalizePathForDisplay(projectRoot)}"`;
  const targetSuffix = includeRoots.length
    ? ` ${includeRoots.map((root) => `"${normalizePathForDisplay(root)}"`).join(" ")}`
    : "";
  const commands = [
    `codegraph hotspots ${rootFlag}${targetSuffix} --limit 20 --json`,
    `codegraph graph ${rootFlag}${targetSuffix} --json --symbols-detailed`,
    `codegraph duplicates ${rootFlag}${targetSuffix} --json --min-confidence medium --limit 20 --include-same-file`,
  ];
  if (hasUnresolvedImports) {
    commands.push(`codegraph unresolved ${rootFlag}${targetSuffix} --json`);
  }
  if (hasCycles) {
    commands.push(`codegraph cycles ${rootFlag}${targetSuffix} --sort priority --json`);
  }
  commands.push(`codegraph doctor "${normalizePathForDisplay(defaultCacheIndexPath(projectRoot))}"`);
  return commands;
}

async function buildInspectReport(
  projectRoot: string,
  includeRoots: string[],
  files: string[],
  discovery: ProjectFileDiscoveryOptions,
  graphOptions: GraphBuildOptions | undefined,
  cache: CacheMode | undefined,
  nativeMode: NativeRuntimeMode,
  workerOpts: { useNativeWorkers: true } | Record<string, never>,
  progressHandler: BuildOptions["onProgress"],
  limit: number,
  includeDuplicates: boolean,
  writeStderrLine: (message: string) => void,
): Promise<InspectReport> {
  const useDiskCache = cache === "disk" || cache === undefined;
  const indexCache = useDiskCache ? readIndexCacheMetadata(projectRoot) : null;
  if (indexCache) {
    writeStderrLine(formatIndexCacheMetadata(indexCache));
  }
  const useNativeWorkers = "useNativeWorkers" in workerOpts || files.length >= NATIVE_WORKER_AUTO_FILE_THRESHOLD;
  const index = await buildProjectIndexIncremental(projectRoot, {
    files,
    filesAreProjectScope: true,
    cache: cache ?? "disk",
    discovery,
    ...(progressHandler ? { onProgress: progressHandler } : {}),
    ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
    ...(useNativeWorkers ? { useNativeWorkers: true } : {}),
    ...(graphOptions ? { graph: graphOptions } : {}),
  });
  const graph = restrictGraphToIncludeRoots(index.graph, includeRoots, normalizePathForDisplay);
  const hotspots = getHotspots(graph, { limit });
  const unresolved = getUnresolvedImports(graph, { projectRoot });
  const cycles = findDetailedCycles(graph);
  let duplicates: InspectReport["duplicates"] = { enabled: false };
  if (includeDuplicates) {
    const minConfidence: DuplicateConfidence = "high";
    const duplicateResult = await findDuplicates(index, {
      projectRoot,
      files,
      includeSameFile: true,
      minConfidence,
      minTokens: INSPECT_DUPLICATE_MIN_TOKENS,
      maxPairs: INSPECT_DUPLICATE_MAX_PAIRS,
      limit,
    });
    duplicates = {
      enabled: true,
      total:
        duplicateResult.groups.length +
        duplicateResult.omittedCounts.groups +
        duplicateResult.omittedCounts.candidatePairs,
      omitted: duplicateResult.omittedCounts.groups + duplicateResult.omittedCounts.candidatePairs,
      minConfidence,
      top: duplicateResult.groups.map(summarizeDuplicateGroup),
    };
  }
  const loadError = getNativeTreeSitterLoadError(nativeMode);
  return {
    root: normalizePathForDisplay(projectRoot),
    includeRoots: includeRoots.map(normalizePathForDisplay),
    ...(indexCache ? { indexCache } : {}),
    backend: {
      native: {
        available: isNativeTreeSitterAvailable(nativeMode),
        ...(loadError ? { loadError: String(loadError) } : {}),
        supportedLanguageIds: getNativeTreeSitterSupportedLanguageIds(nativeMode),
      },
    },
    files: {
      total: files.length,
      byLanguage: countFilesByLanguage(files),
    },
    hotspots,
    unresolved: {
      total: unresolved.length,
      top: unresolved.slice(0, limit).map((entry) => ({
        name: entry.name,
        importerCount: entry.importers.length,
      })),
    },
    cycles: {
      total: cycles.length,
      top: cycles.slice(0, limit).map((cycle) => ({
        files: cycle.files.map(normalizePathForDisplay),
        priorityScore: cycle.priorityScore,
        size: cycle.files.length,
      })),
    },
    duplicates,
    recommendedCommands: buildRecommendedInspectCommands(
      projectRoot,
      includeRoots,
      !!cycles.length,
      !!unresolved.length,
    ),
  };
}

export async function handleInspectCommand(context: InspectCommandContext): Promise<void> {
  const cache = parseCacheModeOption(context.getOpt("--cache"));
  const limit = parsePositiveIntegerOption(context.getOpt("--limit"), "--limit", 20);
  const files = await context.resolveFilesFromRoots();
  const report = await buildInspectReport(
    context.projectRootFs,
    context.includeRootsAbs,
    files,
    context.discoveryOptions,
    context.graphOptions,
    cache,
    context.nativeMode,
    context.workerOpts,
    context.progressHandler,
    limit,
    context.hasFlag("--duplicates"),
    context.writeStderrLine,
  );
  writeCliOutput(context, report);
}

export async function handleHotspotsCommand(context: InspectCommandContext): Promise<void> {
  const json = context.hasFlag("--json");
  const cache = parseCacheModeOption(context.getOpt("--cache"));
  const limit = parsePositiveIntegerOption(context.getOpt("--limit"), "--limit", 20);
  const files = await context.resolveFilesFromRoots();
  const { graph } = await buildScopedReportGraph(context.projectRootFs, context.includeRootsAbs, files, {
    ...(cache ? { cache } : {}),
    discovery: context.discoveryOptions,
    ...(context.graphOptions ? { graphOptions: context.graphOptions } : {}),
    nativeMode: context.nativeMode,
    workerOpts: context.workerOpts,
    ...(context.progressHandler ? { progressHandler: context.progressHandler } : {}),
    writeStderrLine: context.writeStderrLine,
  });
  const hotspots = getHotspots(graph, { limit });

  if (json) {
    context.writeJSONLine(hotspots);
    return;
  }
  context.writeStdoutLine("Top hotspots (files with high fan-in/out):");
  for (const item of hotspots) {
    context.writeStdoutLine(
      `- ${toProjectDisplayPath(context.projectRootFs, item.file)} (fan-in: ${item.fanIn}, fan-out: ${item.fanOut}, score: ${item.score.toFixed(1)})`,
    );
  }
}
