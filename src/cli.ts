#!/usr/bin/env node
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import picomatch from "picomatch";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
  goToDefinition,
  findReferences,
} from "./indexer.js";
import type { BuildOptions, BuildReport } from "./indexer/types.js";
import { buildReviewReport, type ReviewBuildReport, type ReviewDepth } from "./review.js";
import {
  collectGraph,
  graphToMermaid,
  graphToDOT,
  astGrep,
  textGrep,
  buildSymbolGraph,
  buildSymbolGraphDetailed,
  graphToMermaidSymbols,
  graphToDOTSymbols,
  graphToMermaidSymbolsWithFiles,
  graphToDOTSymbolsWithFiles,
  findDetailedCycles,
  sortDetailedCycles,
  getUnresolvedImports,
  getHotspots,
  type GraphBuildOptions,
  type SymbolGraph,
  type SymbolNodeKind,
} from "./graphs.js";
import { analyzeImpactFromDiff } from "./impact/index.js";
import type { CompactImpactReport, ImpactItem, ImpactOptions, ImpactReport, ChangedSymbol } from "./impact/types.js";
import type { CandidateTestFile } from "./impact/context.js";
import { writeGraphSqlite, updateGraphSqlite } from "./sqlite.js";
import {
  isNativeTreeSitterAvailable,
  getNativeTreeSitterLoadError,
  getNativeTreeSitterSupportedLanguageIds,
  type NativeRuntimeMode,
} from "./native/treeSitterNative.js";
import { supportForFile } from "./languages.js";
import { handleChunkCommand } from "./cli/chunk.js";
import { handleArtifactCommand } from "./cli/artifact.js";
import { buildDoctorReport } from "./cli/doctor.js";
import { handleExplainCommand } from "./cli/explain.js";
import { handleGraphDeltaCommand } from "./cli/graphDelta.js";
import { handleGraphQueryCommand } from "./cli/graphQueries.js";
import { CLI_HELP_TEXT, helpTextForCommand } from "./cli/help.js";
import { handleMcpServeCommand } from "./cli/mcp.js";
import { parseCacheModeOption, parsePositiveIntegerOption } from "./cli/options.js";
import { getCodegraphPackageIdentity, getCodegraphVersion } from "./cli/packageInfo.js";
import { handleSearchCommand } from "./cli/search.js";
import { handleSkillCommand } from "./cli/skill.js";
import { handleSqlCommand } from "./cli/sql.js";
import { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions } from "./config.js";
import { buildSqlArtifactGraphFromFiles } from "./sql/index.js";
import type { Graph } from "./types.js";
import {
  assertFilePathWithinRoot,
  listChangedFiles,
  listProjectFiles,
  normalizePath,
  resolveFilePathFromRoot,
  type ProjectFileDiscoveryOptions,
} from "./util.js";
import { isRelativePathInside } from "./util/projectFiles.js";

function toJSON(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function normalizeCliGlobPattern(globPattern: string): string {
  return globPattern.trim().replace(/\\/g, "/");
}

export function isCliDiscoveryRelativePathInside(relativePath: string): boolean {
  return isRelativePathInside(relativePath);
}

function matchesCliDiscoveryGlob(
  absolutePath: string,
  scanRoot: string,
  matcher: (relativePath: string) => boolean,
): boolean {
  const relativePath = path.relative(scanRoot, absolutePath);
  if (!isCliDiscoveryRelativePathInside(relativePath)) {
    return false;
  }
  return matcher(normalizePath(relativePath));
}

function filterFilesByCliDiscoveryGlobs(
  files: readonly string[],
  scanRoot: string,
  discovery: ProjectFileDiscoveryOptions,
): string[] {
  const includeMatchers = (discovery.includeGlobs ?? [])
    .map(normalizeCliGlobPattern)
    .filter(Boolean)
    .map((globPattern) => picomatch(globPattern, { dot: true }));
  const ignoreMatchers = (discovery.ignoreGlobs ?? [])
    .map(normalizeCliGlobPattern)
    .filter(Boolean)
    .map((globPattern) => picomatch(globPattern, { dot: true }));

  if (!includeMatchers.length && !ignoreMatchers.length) {
    return [...files];
  }

  return files.filter((filePath) => {
    if (
      includeMatchers.length &&
      !includeMatchers.some((matcher) => matchesCliDiscoveryGlob(filePath, scanRoot, matcher))
    ) {
      return false;
    }
    return !ignoreMatchers.some((matcher) => matchesCliDiscoveryGlob(filePath, scanRoot, matcher));
  });
}

export type CliRuntime = {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  exit: (code: number) => never;
  cwd: () => string;
};

function createDefaultCliRuntime(): CliRuntime {
  return {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    exit: (code) => process.exit(code),
    cwd: () => process.cwd(),
  };
}

type CliContext = {
  runtime: CliRuntime;
  stderrFilePath: string | undefined;
};

const defaultCliContext: CliContext = {
  runtime: createDefaultCliRuntime(),
  stderrFilePath: undefined,
};
const cliContextStorage = new AsyncLocalStorage<CliContext>();

function getCliContext(): CliContext {
  return cliContextStorage.getStore() ?? defaultCliContext;
}

function createCliContext(runtime: Partial<CliRuntime> = {}): CliContext {
  return {
    runtime: { ...createDefaultCliRuntime(), ...runtime },
    stderrFilePath: undefined,
  };
}

function getCwd(): string {
  return getCliContext().runtime.cwd();
}

function exitCli(code: number): never {
  return getCliContext().runtime.exit(code);
}

function writeStdoutLine(message: string) {
  getCliContext().runtime.stdout(`${message}\n`);
}
function writeJSONLine(value: unknown) {
  writeStdoutLine(toJSON(value));
}
function writeStderrLine(message: string) {
  const context = getCliContext();
  context.runtime.stderr(`${message}\n`);
  try {
    if (context.stderrFilePath)
      fs.appendFileSync(context.stderrFilePath, `${message}\n`, {
        encoding: "utf8",
      });
  } catch {
    // Swallow file logging errors to avoid masking primary error output
  }
}
function writeError(error: unknown) {
  if (error instanceof Error) {
    writeStderrLine(error.stack ?? error.message);
    return;
  }
  writeStderrLine(String(error));
}

function formatNativeBackendStatus(report: BuildReport | undefined): string | undefined {
  const native = report?.backend?.native;
  if (!native) return undefined;
  if (native.filesUsed > 0) {
    if (native.filesFellBack > 0) {
      return `Backend: native tree-sitter used for ${native.filesUsed} file(s); fallback for ${native.filesFellBack} file(s)`;
    }
    return `Backend: native tree-sitter used for ${native.filesUsed} file(s)`;
  }
  const fallbackTotal = native.filesFellBack;
  if (native.available) {
    if (fallbackTotal > 0) {
      return `Backend: JS tree-sitter fallback for ${fallbackTotal} file(s)`;
    }
    return "Backend: native tree-sitter available";
  }
  const reason = native.loadError ? ` (${native.loadError})` : "";
  return `Backend: JS tree-sitter fallback; native addon unavailable${reason}`;
}

function formatNativeBackendFallbackSummary(report: BuildReport | undefined): string | undefined {
  const native = report?.backend?.native;
  if (!native || native.filesFellBack === 0) return undefined;
  const parts = Object.entries(native.byLanguage)
    .filter(([, entry]) => entry.filesFellBack > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([languageId, entry]) => {
      const reasonSummary = Object.entries(entry.fallbackReasons)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(",");
      return reasonSummary.length ? `${languageId}(${reasonSummary})` : `${languageId}(${entry.filesFellBack})`;
    });
  if (!parts.length) return undefined;
  return `Native fallback summary: ${parts.join(", ")}`;
}

function formatParserBackendSummary(report: BuildReport | undefined): string | undefined {
  const parser = report?.backend?.parser;
  if (!parser || parser.total === 0) return undefined;
  const parts = Object.entries(parser.byLanguage)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([languageId, count]) => `${languageId}(${count})`);
  if (!parts.length) {
    return `Parser backend degradation: ${parser.total} file(s)`;
  }
  return `Parser backend degradation: ${parser.total} file(s) [${parts.join(", ")}]`;
}

function maybeWriteNativeBackendStatus(report: BuildReport | undefined, showProgress: boolean): void {
  if (!showProgress) return;
  const message = formatNativeBackendStatus(report);
  if (message) writeStderrLine(message);
  const summary = formatNativeBackendFallbackSummary(report);
  if (summary) writeStderrLine(summary);
  const parserSummary = formatParserBackendSummary(report);
  if (parserSummary) writeStderrLine(parserSummary);
}

function normalizeEntrypointPath(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function isDirectCliExecution(importMetaUrl: string, argv: string[] = process.argv): boolean {
  const argv1 = argv[1];
  if (!argv1) return false;

  const modulePath = normalizeEntrypointPath(fileURLToPath(importMetaUrl));
  const invokedPath = normalizeEntrypointPath(argv1);

  if (process.platform === "win32") {
    return modulePath.toLowerCase() === invokedPath.toLowerCase();
  }
  return modulePath === invokedPath;
}

type CommandTimingReport = {
  totalMs?: number;
  resolveFilesMs?: number;
  commandMs?: number;
};

type CommandReport = {
  command: string;
  timings: CommandTimingReport;
  index?: BuildReport;
  review?: ReviewBuildReport;
};

type ParsedCliArgs = {
  positionals: string[];
  flags: Set<string>;
  options: Map<string, string[]>;
};

const CLI_VALUE_OPTIONS = new Set<string>([
  "--root",
  "--output",
  "--out",
  "--stderr-file",
  "--threads",
  "--native",
  "--cache",
  "--changed-since",
  "--git-base",
  "--git-head",
  "--symbols-detailed-scope",
  "--symbols-detailed-max-edges",
  "--sqlite",
  "--db",
  "--file",
  "--line",
  "--col",
  "--column",
  "--query",
  "--pattern",
  "--regex",
  "--glob",
  "--provider",
  "--base",
  "--head",
  "--pr",
  "--repo",
  "--max-refs",
  "--depth",
  "--scope",
  "--ref-context",
  "--ref-context-lines",
  "--ref-block-max-lines",
  "--max-tests",
  "--language",
  "--min-tokens",
  "--max-tokens",
  "--max-hits",
  "--resolution-hint",
  "--review-depth",
  "--ignore-glob",
  "--include-glob",
  "--report-file",
  "--lcov",
  "--coverage-report",
  "--test-command-template",
  "--agent",
  "--target",
  "--limit",
  "--mode",
  "--from",
  "--max-dependencies",
  "--max-snippets",
  "--max-symbols",
  "--artifact",
  "--host",
  "--port",
]);

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
  recommendedCommands: string[];
};

function normalizePathForDisplay(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

type CliProjectFileInput =
  | { status: "ok"; file: string }
  | { status: "error"; reason: "outside_project_root"; error: string };

function resolveCliProjectFile(projectRoot: string, fileArg: string, label: string): CliProjectFileInput {
  try {
    return {
      status: "ok",
      file: assertFilePathWithinRoot(projectRoot, fileArg, label),
    };
  } catch (error) {
    return {
      status: "error",
      reason: "outside_project_root",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function writeCliProjectFileError(
  result: Extract<CliProjectFileInput, { status: "error" }>,
  output: "json" | "text" = "json",
): void {
  if (output === "json") {
    writeJSONLine(result);
    return;
  }
  writeStdoutLine(`error: ${result.reason}: ${result.error}`);
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
    cache?: "off" | "memory" | "disk";
    discovery?: ProjectFileDiscoveryOptions;
    graphOptions?: GraphBuildOptions;
    nativeMode?: NativeRuntimeMode;
    workerOpts?: { useNativeWorkers: true } | Record<string, never>;
    progressHandler?: ((update: { current: number; total: number }) => void) | undefined;
    report?: BuildReport;
  },
): Promise<{ graph: Graph; indexCache?: IndexCacheMetadata }> {
  const useDiskCache = opts.cache === "disk" || opts.cache === undefined;
  const indexCache = useDiskCache ? readIndexCacheMetadata(projectRoot) : null;
  if (indexCache) {
    writeStderrLine(formatIndexCacheMetadata(indexCache));
    const index = await buildProjectIndexIncremental(projectRoot, {
      files,
      cache: "disk",
      ...(opts.discovery ? { discovery: opts.discovery } : {}),
      ...(opts.progressHandler ? { onProgress: opts.progressHandler } : {}),
      ...(opts.nativeMode && opts.nativeMode !== "auto" ? { native: opts.nativeMode } : {}),
      ...(opts.workerOpts ?? {}),
      ...(opts.graphOptions ? { graph: opts.graphOptions } : {}),
      ...(opts.report ? { report: opts.report } : {}),
    });
    return {
      graph: restrictGraphToIncludeRoots(index.graph, includeRoots),
      indexCache,
    };
  }

  const sourceGraph = await collectGraph(projectRoot, files, {
    ...(opts.graphOptions ?? {}),
    ...(opts.report ? { report: opts.report } : {}),
  });
  return {
    graph: restrictGraphToIncludeRoots(sourceGraph, includeRoots),
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
    `codegraph graph ${rootFlag}${targetSuffix} --json --symbols-detailed --compact-json`,
  ];
  if (hasUnresolvedImports) {
    commands.push(`codegraph unresolved ${rootFlag} --json`);
  }
  if (hasCycles) {
    commands.push(`codegraph cycles ${rootFlag} --sort priority --json`);
  }
  commands.push(`codegraph doctor "${normalizePathForDisplay(defaultCacheIndexPath(projectRoot))}"`);
  return commands;
}

function restrictGraphToIncludeRoots(graph: Graph, includeRoots: string[]): Graph {
  if (!includeRoots.length) {
    return graph;
  }
  const normalizedRoots = includeRoots.map(normalizePathForDisplay);
  const nodes = new Set<string>();
  for (const file of graph.nodes) {
    const normalizedFile = normalizePathForDisplay(file);
    if (normalizedRoots.some((root) => normalizedFile === root || normalizedFile.startsWith(`${root}/`))) {
      nodes.add(normalizedFile);
    }
  }
  const edges = graph.edges.filter((edge) => {
    if (!nodes.has(normalizePathForDisplay(edge.from))) {
      return false;
    }
    return edge.to.type === "external" || nodes.has(normalizePathForDisplay(edge.to.path));
  });
  return {
    nodes,
    edges,
  };
}

async function buildInspectReport(
  projectRoot: string,
  includeRoots: string[],
  files: string[],
  discovery: ProjectFileDiscoveryOptions,
  graphOptions: GraphBuildOptions | undefined,
  cache: "off" | "memory" | "disk" | undefined,
  nativeMode: NativeRuntimeMode,
  workerOpts: { useNativeWorkers: true } | Record<string, never>,
  progressHandler: ((update: { current: number; total: number }) => void) | undefined,
  limit: number,
): Promise<InspectReport> {
  const { graph, indexCache } = await buildScopedReportGraph(projectRoot, includeRoots, files, {
    ...(cache ? { cache } : {}),
    discovery,
    ...(graphOptions ? { graphOptions } : {}),
    nativeMode,
    workerOpts,
    ...(progressHandler ? { progressHandler } : {}),
  });
  const hotspots = getHotspots(graph, { limit });
  const unresolved = getUnresolvedImports(graph, { projectRoot });
  const cycles = sortDetailedCycles(findDetailedCycles(graph), "priority");
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
    recommendedCommands: buildRecommendedInspectCommands(
      projectRoot,
      includeRoots,
      !!cycles.length,
      !!unresolved.length,
    ),
  };
}

function parseCliArgs(command: string, tokens: string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string[]>();

  const pushOpt = (key: string, value: string) => {
    const existing = options.get(key);
    if (existing) existing.push(value);
    else options.set(key, [value]);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq !== -1) {
        const key = t.slice(0, eq);
        const value = t.slice(eq + 1);
        pushOpt(key, value);
        continue;
      }
      const key = t;
      if (isCliValueOption(command, key, positionals)) {
        const next = tokens[i + 1];
        if (next === undefined) throw new Error(`Missing value for ${key} option`);
        pushOpt(key, next);
        i++;
      } else {
        flags.add(key);
      }
      continue;
    }

    if (t.startsWith("-") && t.length > 1) {
      // Support a minimal set of short options. Everything else is treated as a boolean flag.
      if (t === "-o") {
        const next = tokens[i + 1];
        if (!next || next.startsWith("-")) throw new Error("Missing value for -o/--output");
        pushOpt("--output", next);
        i++;
        continue;
      }
      flags.add(t);
      continue;
    }

    positionals.push(t);
  }

  return { positionals, flags, options };
}

function isCliValueOption(command: string, key: string, positionals: readonly string[]): boolean {
  if (command === "artifact" && key === "--sqlite" && positionals[0] === "build") return false;
  return CLI_VALUE_OPTIONS.has(key);
}

async function writeCommandReport(report: CommandReport, reportFile: string | undefined) {
  const payload = JSON.stringify(report, null, 2);
  if (reportFile) {
    const resolved = normalizePath(resolveFilePathFromRoot(getCwd(), reportFile));
    await fsp.writeFile(resolved, `${payload}\n`, "utf8");
  } else {
    writeStderrLine(payload);
  }
}

// Compact JSON helpers to reduce repeated strings in graph output
type CompactEdgeTo = { type: "file"; path: number } | { type: "external"; name: string };
type CompactFileEdge = {
  from: number;
  to: CompactEdgeTo;
  raw: string;
  typeOnly?: boolean;
};
type CompactSymbolEdge = { from: number; to: number; label?: string };

function compactGraphWithSymbols(fgraph: Graph, sgraph: SymbolGraph, stable = false) {
  const files = [...fgraph.nodes];
  if (stable) files.sort();
  const fileIndex = new Map<string, number>();
  for (let i = 0; i < files.length; i++) fileIndex.set(files[i]!, i);

  const fileEdges: CompactFileEdge[] = fgraph.edges.map((e) => ({
    from: fileIndex.get(e.from)!,
    to:
      e.to?.type === "file"
        ? { type: "file" as const, path: fileIndex.get(e.to.path)! }
        : { type: "external" as const, name: e.to.name },
    raw: e.raw,
    ...(e.typeOnly !== undefined ? { typeOnly: e.typeOnly } : {}),
  }));
  if (stable) {
    const toKey = (to: CompactEdgeTo) => (to?.type === "file" ? `file:${to.path}` : `ext:${to?.name ?? ""}`);
    fileEdges.sort((a, b) => {
      const byFrom = a.from - b.from;
      if (byFrom) return byFrom;
      const ak = toKey(a.to);
      const bk = toKey(b.to);
      if (ak !== bk) return ak < bk ? -1 : 1;
      const ar = String(a.raw ?? "");
      const br = String(b.raw ?? "");
      if (ar !== br) return ar < br ? -1 : 1;
      return Number(!!a.typeOnly) - Number(!!b.typeOnly);
    });
  }

  const symbolIds = [...sgraph.nodes.keys()];
  if (stable) symbolIds.sort();
  const symbolIndex = new Map<string, number>();
  for (let i = 0; i < symbolIds.length; i++) symbolIndex.set(symbolIds[i]!, i);

  const symbols = symbolIds.map((id) => {
    const n = sgraph.nodes.get(id)!;
    return {
      id: symbolIndex.get(id)!,
      file: fileIndex.get(n.file)!,
      name: n.name,
      kind: n.kind,
    };
  });

  const symbolEdges: CompactSymbolEdge[] = sgraph.edges.map((e) => ({
    from: symbolIndex.get(e.from)!,
    to: symbolIndex.get(e.to)!,
    ...(e.label ? { label: e.label } : {}),
  }));
  if (stable) {
    symbolEdges.sort((a, b) => {
      const byFrom = a.from - b.from;
      if (byFrom) return byFrom;
      const byTo = a.to - b.to;
      if (byTo) return byTo;
      const al = String(a.label ?? "");
      const bl = String(b.label ?? "");
      if (al !== bl) return al < bl ? -1 : 1;
      return 0;
    });
  }

  return {
    files,
    fileEdges,
    symbols,
    symbolEdges,
    symbolIdIndex: symbolIds,
  };
}

function compactSymbolsOnly(allFiles: string[], sgraph: SymbolGraph, stable = false) {
  const files = [...allFiles];
  if (stable) files.sort();
  const fileIndex = new Map<string, number>();
  for (let i = 0; i < files.length; i++) fileIndex.set(files[i]!, i);

  const symbolIds = [...sgraph.nodes.keys()];
  if (stable) symbolIds.sort();
  const symbolIndex = new Map<string, number>();
  for (let i = 0; i < symbolIds.length; i++) symbolIndex.set(symbolIds[i]!, i);

  const symbols = symbolIds.map((id) => {
    const n = sgraph.nodes.get(id)!;
    return {
      id: symbolIndex.get(id)!,
      file: fileIndex.get(n.file)!,
      name: n.name,
      kind: n.kind,
    };
  });

  const symbolEdges: CompactSymbolEdge[] = sgraph.edges.map((e) => ({
    from: symbolIndex.get(e.from)!,
    to: symbolIndex.get(e.to)!,
    ...(e.label ? { label: e.label } : {}),
  }));
  if (stable) {
    symbolEdges.sort((a, b) => {
      const byFrom = a.from - b.from;
      if (byFrom) return byFrom;
      const byTo = a.to - b.to;
      if (byTo) return byTo;
      const al = String(a.label ?? "");
      const bl = String(b.label ?? "");
      if (al !== bl) return al < bl ? -1 : 1;
      return 0;
    });
  }

  return {
    files,
    symbols,
    symbolEdges,
    symbolIdIndex: symbolIds,
  };
}

function stabilizeGraph(graph: Graph): Graph {
  const nodes = [...graph.nodes].slice().sort();
  const edges = [...graph.edges].slice().sort((a, b) => {
    const af = String(a.from);
    const bf = String(b.from);
    if (af !== bf) return af < bf ? -1 : 1;
    const at = a.to.type === "file" ? `file:${a.to.path}` : `ext:${a.to.name ?? ""}`;
    const bt = b.to.type === "file" ? `file:${b.to.path}` : `ext:${b.to.name ?? ""}`;
    if (at !== bt) return at < bt ? -1 : 1;
    const ar = String(a.raw ?? "");
    const br = String(b.raw ?? "");
    if (ar !== br) return ar < br ? -1 : 1;
    return Number(!!a.typeOnly) - Number(!!b.typeOnly);
  });
  return { nodes: new Set(nodes), edges };
}

function stabilizeSymbolGraph(graph: SymbolGraph): SymbolGraph {
  const nodeEntries = [...graph.nodes.entries()].slice().sort((a, b) => {
    const ak = a[0];
    const bk = b[0];
    if (ak !== bk) return ak < bk ? -1 : 1;
    return 0;
  });
  const edges = [...graph.edges].slice().sort((a, b) => {
    const af = String(a.from);
    const bf = String(b.from);
    if (af !== bf) return af < bf ? -1 : 1;
    const at = String(a.to);
    const bt = String(b.to);
    if (at !== bt) return at < bt ? -1 : 1;
    const al = String(a.label ?? "");
    const bl = String(b.label ?? "");
    if (al !== bl) return al < bl ? -1 : 1;
    return 0;
  });
  return { nodes: new Map(nodeEntries), edges };
}

const SYMBOL_NODE_KINDS: SymbolNodeKind[] = [
  "function",
  "class",
  "variable",
  "interface",
  "type",
  "default",
  "import",
  "namespaceImport",
];

function symbolNodeKindFromString(kind?: string): SymbolNodeKind {
  return kind && SYMBOL_NODE_KINDS.includes(kind as SymbolNodeKind) ? (kind as SymbolNodeKind) : "variable";
}

function ensureImpactReport(report: ImpactReport | CompactImpactReport): ImpactReport {
  if (!("files" in report)) return report;
  const files = report.files;
  const resolveFilePath = (index: number): string => {
    const file = files[index];
    if (!file) {
      throw new Error(`Missing file path for index ${index} in compact impact report`);
    }
    return file;
  };
  const resolveSurfaceArea = (surfaceArea: CompactImpactReport["surfaceArea"]) => ({
    files: surfaceArea.files.map((item) => ({
      file: resolveFilePath(item.file),
      fanIn: item.fanIn,
      fanOut: item.fanOut,
      changed: item.changed,
      impacted: item.impacted,
    })),
    topFanIn: surfaceArea.topFanIn.map((file) => resolveFilePath(file)),
    topFanOut: surfaceArea.topFanOut.map((file) => resolveFilePath(file)),
  });
  const changedFiles = report.changedFiles.map((cf) => ({
    file: resolveFilePath(cf.file),
    hunks: cf.hunks,
  }));
  const changedSymbols = report.changedSymbols.map((cs) => {
    const symbol: ChangedSymbol = {
      id: cs.id,
      file: resolveFilePath(cs.file),
      name: cs.name,
      kind: cs.kind,
      exported: cs.exported,
      range: cs.range,
      ...(cs.typeOnly !== undefined ? { typeOnly: cs.typeOnly } : {}),
    };
    return symbol;
  });
  const impacted: ImpactItem[] = report.impacted.map((item) => {
    const impact: ImpactItem = {
      file: resolveFilePath(item.file),
      symbols: item.symbols,
      reasons: item.reasons,
      severity: item.severity,
    };
    if (item.depth !== undefined) impact.depth = item.depth;
    if (item.typeOnly !== undefined) impact.typeOnly = item.typeOnly;
    if (item.explain !== undefined) impact.explain = item.explain;
    const maybeRefs = "refs" in item ? (item as { refs?: ImpactItem["refs"] }).refs : undefined;
    if (maybeRefs !== undefined) impact.refs = maybeRefs;
    return impact;
  });
  const suggestions = report.suggestions?.map((suggestion) => ({
    file: resolveFilePath(suggestion.file),
    kind: suggestion.kind,
    ...(suggestion.range ? { range: suggestion.range } : {}),
    ...(suggestion.symbol ? { symbol: suggestion.symbol } : {}),
    ...(suggestion.relatedFile !== undefined ? { relatedFile: resolveFilePath(suggestion.relatedFile) } : {}),
    ...(suggestion.details ? { details: suggestion.details } : {}),
    confidence: suggestion.confidence,
  }));
  const exportSummary = report.exportSummary?.map((entry) => ({
    file: resolveFilePath(entry.file),
    symbols: entry.symbols,
  }));
  const reexportChains = report.reexportChains
    ? {
        chains: report.reexportChains.chains.map((entry) => ({
          symbol: entry.symbol,
          file: resolveFilePath(entry.file),
          paths: entry.paths.map((pathChain) => pathChain.map((file) => resolveFilePath(file))),
        })),
      }
    : undefined;
  const topImpacts = report.topImpacts?.map((item) => ({
    file: resolveFilePath(item.file),
    symbols: item.symbols,
    reasons: item.reasons,
    severity: item.severity,
    ...(item.depth !== undefined ? { depth: item.depth } : {}),
    ...(item.typeOnly !== undefined ? { typeOnly: item.typeOnly } : {}),
    ...(item.explain ? { explain: item.explain } : {}),
  }));
  const clusters = report.clusters.map((cluster) => ({
    id: cluster.id,
    files: cluster.files.map((file) => resolveFilePath(file)),
    changedFiles: cluster.changedFiles.map((file) => resolveFilePath(file)),
    totalSeverity: cluster.totalSeverity,
  }));
  const fileEdges = report.graph.fileEdges.map((edge) => ({
    from: resolveFilePath(edge.from),
    to: resolveFilePath(edge.to),
    ...(edge.typeOnly !== undefined ? { typeOnly: edge.typeOnly } : {}),
  }));
  const symbolEdges = report.graph.symbolEdges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    label: edge.label,
  }));
  const result: ImpactReport = {
    schemaVersion: report.schemaVersion,
    format: "full",
    changedFiles,
    changedSymbols,
    impacted,
    ...(suggestions ? { suggestions } : {}),
    ...(exportSummary ? { exportSummary } : {}),
    ...(reexportChains ? { reexportChains } : {}),
    ...(topImpacts ? { topImpacts } : {}),
    surfaceArea: resolveSurfaceArea(report.surfaceArea),
    clusters,
    graph: {
      fileEdges,
      symbolEdges,
    },
  };
  if (report.projectFiles) result.projectFiles = report.projectFiles;
  if (report.warning) result.warning = report.warning;
  return result;
}

const IMPACT_REASON_LABELS: Record<ImpactItem["reasons"][number], string> = {
  directRef: "reason: direct reference",
  namespaceMember: "reason: namespace member",
  importAlias: "reason: import alias",
  transitive: "reason: transitive dependency",
  exportChain: "reason: export chain",
  fileLevelChange: "reason: file-level change",
};

function formatImpactReasonLabel(item: Pick<ImpactItem, "reasons" | "explain">): string {
  const primaryReason = item.explain?.reason ?? item.reasons[0];
  if (!primaryReason) return "reason: impact";
  return IMPACT_REASON_LABELS[primaryReason];
}

function formatImpactMermaid(report: ImpactReport, root: string): string {
  const fileGraph: Graph = { nodes: new Set<string>(), edges: [] };
  const ensureFileNode = (file: string) => fileGraph.nodes.add(file);
  for (const cf of report.changedFiles) ensureFileNode(cf.file);
  for (const item of report.impacted) ensureFileNode(item.file);
  for (const symbol of report.changedSymbols) ensureFileNode(symbol.file);
  for (const edge of report.graph.fileEdges) {
    ensureFileNode(edge.from);
    ensureFileNode(edge.to);
    fileGraph.edges.push({
      from: edge.from,
      to: { type: "file", path: edge.to },
      raw: "",
      ...(edge.typeOnly ? { typeOnly: edge.typeOnly } : {}),
    });
  }

  const symbolGraph: SymbolGraph = { nodes: new Map(), edges: [] };
  for (const sym of report.changedSymbols) {
    symbolGraph.nodes.set(sym.id, {
      id: sym.id,
      file: sym.file,
      name: sym.name,
      kind: symbolNodeKindFromString(sym.kind),
    });
  }
  for (const edge of report.graph.symbolEdges) {
    const fromSym = report.changedSymbols[edge.from];
    const toSym = report.changedSymbols[edge.to];
    if (!fromSym || !toSym) continue;
    symbolGraph.edges.push({
      from: fromSym.id,
      to: toSym.id,
      ...(edge.label ? { label: edge.label } : {}),
    });
  }

  return graphToMermaidSymbolsWithFiles(symbolGraph, fileGraph, root);
}

function formatReviewSummary(report: Awaited<ReturnType<typeof buildReviewReport>>): string {
  const lines: string[] = [];
  const candidateCounts = countCandidateTestsByConfidence(report.candidateTests);
  lines.push("Review Summary");
  lines.push("==============");
  lines.push(`Status: ${report.status}`);
  lines.push(`Files changed: ${report.summary.filesChanged}`);
  lines.push(`Symbols changed: ${report.summary.symbolsChanged}`);
  lines.push(
    `Candidate tests: ${report.summary.candidateTests} (high: ${candidateCounts.high}, medium: ${candidateCounts.medium}, low: ${candidateCounts.low})`,
  );
  lines.push(`Risk: ${report.riskSummary.level} (${report.riskSummary.score})`);
  if (report.riskSummary.signals.length) {
    lines.push(`Signals: ${report.riskSummary.signals.join(", ")}`);
  }
  lines.push("");
  lines.push("Changed files:");
  if (!report.changedFiles.length) {
    lines.push("- none");
  } else {
    for (const file of report.changedFiles.slice(0, 20)) {
      const symbolNames = file.symbols.slice(0, 5).map((symbol) => symbol.name);
      const symbolSummary = symbolNames.length ? ` (${symbolNames.join(", ")})` : "";
      lines.push(`- ${file.file}: ${file.status}${symbolSummary}`);
    }
    const remainingFiles = report.changedFiles.length - 20;
    if (remainingFiles > 0) {
      lines.push(`- ... and ${remainingFiles} more`);
    }
  }
  lines.push("");
  lines.push("Candidate tests:");
  if (!report.candidateTests.length) {
    lines.push("- none");
  } else {
    const listedCandidates =
      appendCandidateTestGroup(lines, "High-confidence tests:", report.candidateTests, "high") +
      appendCandidateTestGroup(lines, "Medium-confidence tests:", report.candidateTests, "medium");
    if (listedCandidates === 0) {
      lines.push("No high- or medium-confidence test candidates found.");
    }
    appendLowConfidenceCandidateSummary(lines, candidateCounts.low);
  }
  lines.push("");
  lines.push("Review tasks:");
  if (!report.reviewTasks.length) {
    lines.push("- none");
  } else {
    for (const task of report.reviewTasks.slice(0, 8)) {
      lines.push(`- ${task.id}: ${task.priority} - ${task.title} (${task.reason})`);
    }
    const remainingTasks = report.reviewTasks.length - 8;
    if (remainingTasks > 0) {
      lines.push(`- ... and ${remainingTasks} more`);
    }
  }
  if (report.diagnostics) {
    lines.push("");
    lines.push("Diagnostics:");
    lines.push(`- missing files: ${report.diagnostics.missingFiles.length}`);
    lines.push(`- symbol mapping parse failures: ${report.diagnostics.symbolMappingParseFailures.length}`);
  }
  return `${lines.join("\n")}\n`;
}

function countCandidateTestsByConfidence(
  candidates: CandidateTestFile[],
): Record<CandidateTestFile["confidence"], number> {
  const counts: Record<CandidateTestFile["confidence"], number> = {
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const candidate of candidates) {
    counts[candidate.confidence] += 1;
  }
  return counts;
}

function appendCandidateTestGroup(
  lines: string[],
  title: string,
  candidates: CandidateTestFile[],
  confidence: CandidateTestFile["confidence"],
): number {
  const matches = candidates.filter((candidate) => candidate.confidence === confidence);
  if (!matches.length) return 0;
  lines.push(title);
  for (const candidate of matches.slice(0, 8)) {
    lines.push(`- ${candidate.file}: ${candidate.reason}`);
  }
  const remaining = matches.length - 8;
  if (remaining > 0) {
    lines.push(`- ... and ${remaining} more`);
  }
  return matches.length;
}

function appendLowConfidenceCandidateSummary(lines: string[], lowConfidenceCount: number): void {
  if (lowConfidenceCount === 0) return;
  lines.push(`Low-confidence pattern matches: ${lowConfidenceCount} available as breadth hints in full JSON.`);
}

function parseReviewDepth(value: string): ReviewDepth | null {
  if (value === "minimal" || value === "standard" || value === "deep") {
    return value;
  }
  return null;
}

function parseNativeRuntimeMode(value: string | undefined): NativeRuntimeMode {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "on" || value === "off") {
    return value;
  }
  throw new Error(`Invalid --native value "${value}". Expected auto|on|off.`);
}

type ImpactOptionsBuilder = Partial<ImpactOptions> & {
  base?: string;
  head?: string;
  cwd?: string;
  pr?: number;
  repo?: string;
  diffText?: string;
  threads?: number;
  cache?: string;
  cacheStrict?: boolean;
};

async function runCliWithActiveRuntime(rawArgs: string[]) {
  const cmd = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs[0] : "graph";
  const argTokens = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs.slice(1) : rawArgs;

  const parsed = parseCliArgs(cmd, argTokens);
  const hasFlag = (name: string) => parsed.flags.has(name);
  const getOpt = (name: string) => {
    const v = parsed.options.get(name);
    return v?.length ? v[v.length - 1] : undefined;
  };

  // Handle help flag
  if (hasFlag("--help") || hasFlag("-h")) {
    const commandHelp = helpTextForCommand(cmd, parsed.positionals);
    writeStdoutLine((commandHelp ?? CLI_HELP_TEXT).trimEnd());
    return;
  }

  if (hasFlag("--version")) {
    if (hasFlag("--json")) {
      writeJSONLine(getCodegraphPackageIdentity());
    } else {
      writeStdoutLine(getCodegraphVersion());
    }
    return;
  }

  const reportFile = getOpt("--report-file");
  const reportEnabled = hasFlag("--report") || reportFile !== undefined;
  const nativeMode = parseNativeRuntimeMode(getOpt("--native"));
  const useNativeWorkers = hasFlag("--workers");
  const workerOpts = useNativeWorkers ? ({ useNativeWorkers: true } as const) : ({} as const);
  const showProgress = hasFlag("--progress");
  let lastProgressUpdate = 0;
  function handleIndexingProgress(update: { current: number; total: number }): void {
    const now = Date.now();
    const isComplete = update.current === update.total;
    const shouldUpdate = isComplete || now - lastProgressUpdate > 100;

    if (shouldUpdate) {
      if (process.stderr.isTTY) {
        getCliContext().runtime.stderr(`\r[Progress] ${update.current}/${update.total} files processed...`);
        if (isComplete) {
          getCliContext().runtime.stderr("\n");
        }
      } else if (update.current === 1 || isComplete || update.current % 100 === 0) {
        getCliContext().runtime.stderr(`[Progress] ${update.current}/${update.total} files processed.\n`);
      }
      lastProgressUpdate = now;
    }
  }
  const progressHandler = showProgress ? handleIndexingProgress : undefined;
  const graphFlags = {
    fast: hasFlag("--fast-graph"),
    resolveNodeModules: hasFlag("--resolve-node-modules"),
    dynamicImportHeuristics: hasFlag("--dynamic-import-heuristics"),
    resolutionHints: parsed.options.get("--resolution-hint") ?? [],
  };
  const hasGraphOverrides =
    graphFlags.fast ||
    graphFlags.resolveNodeModules ||
    graphFlags.dynamicImportHeuristics ||
    !!graphFlags.resolutionHints.length;
  const buildGraphOptions = () => ({
    fast: graphFlags.fast,
    resolveNodeModules: graphFlags.resolveNodeModules,
    dynamicImportHeuristics: graphFlags.dynamicImportHeuristics,
    ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
    ...(graphFlags.resolutionHints.length ? { resolutionHints: graphFlags.resolutionHints } : {}),
  });

  const changedSince = getOpt("--changed-since");
  const gitBase = getOpt("--git-base");
  const gitHead = getOpt("--git-head");

  const rootOpt = getOpt("--root");
  const resolveAbs = (p: string) => resolveFilePathFromRoot(getCwd(), p);

  const defaultProjectRoot =
    (cmd === "graph" ||
      cmd === "graph-delta" ||
      cmd === "index" ||
      cmd === "grep" ||
      cmd === "hotspots" ||
      cmd === "inspect" ||
      cmd === "impact") &&
    !rootOpt &&
    parsed.positionals.length === 1 &&
    fs.existsSync(resolveAbs(parsed.positionals[0]!)) &&
    fs.statSync(resolveAbs(parsed.positionals[0]!)).isDirectory()
      ? resolveAbs(parsed.positionals[0]!)
      : getCwd();

  const projectRootFs = rootOpt ? resolveAbs(rootOpt) : defaultProjectRoot;
  const projectRootAbs = projectRootFs.replace(/\\/g, "/");
  const includeGlobs = parsed.options.get("--include-glob") ?? [];
  const scanIgnoreGlobs = parsed.options.get("--ignore-glob") ?? [];
  const cliGlobDiscoveryOptions: ProjectFileDiscoveryOptions = {
    ...(includeGlobs.length ? { includeGlobs } : {}),
    ...(scanIgnoreGlobs.length ? { ignoreGlobs: scanIgnoreGlobs } : {}),
  };
  const cliGitignoreDiscoveryOptions: ProjectFileDiscoveryOptions = {
    ...(hasFlag("--no-gitignore") ? { useGitignore: false } : {}),
  };
  const explicitDiscoveryOptions: ProjectFileDiscoveryOptions = {
    ...cliGlobDiscoveryOptions,
    ...cliGitignoreDiscoveryOptions,
  };

  if (cmd === "version") {
    if (hasFlag("--json")) {
      writeJSONLine(getCodegraphPackageIdentity());
    } else {
      writeStdoutLine(getCodegraphVersion());
    }
    return;
  }

  if (cmd === "doctor") {
    writeJSONLine(buildDoctorReport(parsed.positionals.at(-1)));
    return;
  }

  if (cmd === "skill") {
    await handleSkillCommand({
      positionals: parsed.positionals,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "sql") {
    await handleSqlCommand({
      getOpt,
      cwd: getCwd,
      writeJSONLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "chunk") {
    await handleChunkCommand({
      positionals: parsed.positionals,
      getOpt,
      hasFlag,
      cwd: getCwd,
      writeJSONLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  const config = await loadCodegraphConfig(projectRootFs);
  const configDiscoveryOptions = mergeDiscoveryOptions(config.discovery, cliGitignoreDiscoveryOptions);
  const mergedDiscoveryOptions = mergeDiscoveryOptions(config.discovery, explicitDiscoveryOptions);
  const discoveryOptions: ProjectFileDiscoveryOptions = hasDiscoveryOptions(mergedDiscoveryOptions)
    ? { ...mergedDiscoveryOptions, globRoot: projectRootFs }
    : {};
  const includeRootDiscoveryOptions: ProjectFileDiscoveryOptions = hasDiscoveryOptions(configDiscoveryOptions)
    ? { ...configDiscoveryOptions, globRoot: projectRootFs }
    : {};

  const supportsIncludeRoots = cmd === "graph" || cmd === "index" || cmd === "hotspots" || cmd === "inspect";
  let includeRoots: string[] = [];
  if (supportsIncludeRoots) {
    if (rootOpt) {
      // If the user explicitly sets --root, treat all remaining positionals as include roots.
      includeRoots = parsed.positionals;
    } else if (parsed.positionals.length > 1) {
      // Otherwise, a single positional arg is treated as the project root (back-compat).
      includeRoots = parsed.positionals;
    }
  }
  const includeRootsAbs = includeRoots.map((r) => normalizePath(resolveFilePathFromRoot(projectRootFs, r)));

  const isUnderIncludeRoots = (filePath: string): boolean => {
    if (!includeRootsAbs.length) return true;
    const f = filePath.replace(/\\/g, "/");
    return includeRootsAbs.some((root) => f === root || f.startsWith(`${root}/`));
  };

  const resolveFilesFromRoots = async (): Promise<string[]> => {
    if (!includeRootsAbs.length) return await listProjectFiles(projectRootFs, undefined, discoveryOptions);
    const normalizedRoots = includeRootsAbs;
    const all: string[][] = await Promise.all(
      normalizedRoots.map(async (r) => {
        const files = await listProjectFiles(r, undefined, {
          ...includeRootDiscoveryOptions,
          gitignoreRoot: projectRootFs,
        });
        return filterFilesByCliDiscoveryGlobs(files, r, cliGlobDiscoveryOptions);
      }),
    );
    return Array.from(new Set(all.flat()));
  };

  const listProjectFilesForScan = async (scanRoot: string): Promise<string[]> => {
    if (scanRoot === projectRootFs) {
      return await listProjectFiles(scanRoot, undefined, discoveryOptions);
    }
    const files = await listProjectFiles(scanRoot, undefined, {
      ...includeRootDiscoveryOptions,
      gitignoreRoot: projectRootFs,
    });
    return filterFilesByCliDiscoveryGlobs(files, scanRoot, cliGlobDiscoveryOptions);
  };

  const resolveChangedFiles = async (): Promise<string[] | null> => {
    if (gitBase) {
      const diffOpts: { base: string; head?: string } = { base: gitBase };
      if (gitHead) diffOpts.head = gitHead;
      return (await listChangedFiles(projectRootFs, diffOpts)).filter(isUnderIncludeRoots);
    }
    if (changedSince) {
      return (
        await listChangedFiles(projectRootFs, {
          changedSince,
        })
      ).filter(isUnderIncludeRoots);
    }
    return null;
  };

  const resolveChangedFilesWithDeletes = async (): Promise<{
    existingFiles: string[];
    deletedFiles: string[];
  } | null> => {
    const gitFiles = await resolveChangedFiles();
    if (!gitFiles) return null;
    const existence = gitFiles.map((file: string) => ({
      file,
      exists: fs.existsSync(file),
    }));
    return {
      existingFiles: existence.filter((entry) => entry.exists).map((entry) => entry.file),
      deletedFiles: existence.filter((entry) => !entry.exists).map((entry) => entry.file),
    };
  };

  const resolveFiles = async (): Promise<string[]> => {
    const changedSet = await resolveChangedFilesWithDeletes();
    if (changedSet) {
      const { existingFiles, deletedFiles } = changedSet;
      if (deletedFiles.length) {
        writeStderrLine(
          `Skipping ${deletedFiles.length} deleted file(s) from git diff: ${deletedFiles
            .map((file) => path.relative(projectRootFs, file) || file)
            .join(", ")}`,
        );
      }
      if (!existingFiles.length) {
        writeStderrLine("No changed files detected via git diff.");
      }
      return existingFiles;
    }
    return await resolveFilesFromRoots();
  };

  if (cmd === "search") {
    await handleSearchCommand({
      positionals: parsed.positionals,
      root: projectRootFs,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "explain") {
    await handleExplainCommand({
      positionals: parsed.positionals,
      root: projectRootFs,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "artifact") {
    await handleArtifactCommand({
      positionals: parsed.positionals,
      root: projectRootFs,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "mcp") {
    await handleMcpServeCommand({
      positionals: parsed.positionals,
      root: projectRootFs,
      getOpt,
      hasFlag,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "graph-delta") {
    const files = await resolveFiles();
    await handleGraphDeltaCommand({
      projectRootFs,
      files,
      getOpt,
      hasFlag,
      cwd: getCwd,
      nativeMode,
      workerOpts,
      graphOptions: hasGraphOverrides ? buildGraphOptions() : undefined,
      gitBase,
      gitHead,
      changedSince,
      writeJSONLine,
    });
    return;
  }

  if (cmd === "graph") {
    const commandReport: CommandReport | undefined = reportEnabled ? { command: "graph", timings: {} } : undefined;
    const commandStart = performance.now();
    const resolveStart = performance.now();
    const files = await resolveFiles();
    if (commandReport) {
      commandReport.timings.resolveFilesMs = Math.round(performance.now() - resolveStart);
    }
    const hasExplicitSymbolFlag = hasFlag("--symbols") || hasFlag("--symbols-only") || hasFlag("--symbols-detailed");
    const hasExplicitFormatFlag = hasFlag("--mermaid") || hasFlag("--dot") || hasFlag("--json");
    const outputArg = getOpt("--output");
    const sqliteArg = getOpt("--sqlite");
    const stderrArg = getOpt("--stderr-file");
    const stdoutMode = hasFlag("--stdout");
    const defaultGraphMode = !hasExplicitSymbolFlag && !hasExplicitFormatFlag;

    const wantSymbols = hasExplicitSymbolFlag;
    const detailedSymbols = hasFlag("--symbols-detailed");
    const threads = Number(getOpt("--threads") ?? 0);
    const cache = parseCacheModeOption(getOpt("--cache"));
    const cacheStrict = hasFlag("--cache-strict");
    const stable = hasFlag("--stable");
    let format: "mermaid" | "dot" | "json" = "json";
    if (hasFlag("--mermaid")) {
      format = "mermaid";
    } else if (hasFlag("--dot")) {
      format = "dot";
    }
    const fast = graphFlags.fast;
    const resolveNodeModules = graphFlags.resolveNodeModules;
    const dynamicImportHeuristics = graphFlags.dynamicImportHeuristics;
    const resolutionHints = graphFlags.resolutionHints;
    const compact = defaultGraphMode || hasFlag("--compact-json");
    const includeSqlArtifacts = hasFlag("--sql-artifacts");
    let outputFile: string | undefined;
    if (outputArg) {
      outputFile = normalizePath(resolveFilePathFromRoot(getCwd(), outputArg));
    } else if (defaultGraphMode && !stdoutMode) {
      outputFile = path.resolve(getCwd(), "codegraph.json").replace(/\\/g, "/");
    }
    const sqliteFile = sqliteArg ? normalizePath(resolveFilePathFromRoot(getCwd(), sqliteArg)) : undefined;
    if (stderrArg) {
      getCliContext().stderrFilePath = normalizePath(resolveFilePathFromRoot(getCwd(), stderrArg));
    } else if (defaultGraphMode) {
      getCliContext().stderrFilePath = path.resolve(getCwd(), "codegraph.err").replace(/\\/g, "/");
    } else {
      getCliContext().stderrFilePath = undefined;
    }

    const finalizeReport = async () => {
      if (!commandReport) return;
      commandReport.timings.commandMs = Math.round(performance.now() - commandStart);
      commandReport.timings.totalMs = commandReport.timings.commandMs;
      await writeCommandReport(commandReport, reportFile);
    };

    const writeOut = async (text: string) => {
      if (outputFile) {
        await fsp.writeFile(outputFile, `${text}\n`, "utf8");
      } else {
        writeStdoutLine(text);
      }
    };
    const indexReport: BuildReport | undefined = reportEnabled || showProgress ? { timings: {} } : undefined;
    if (commandReport && indexReport) {
      commandReport.index = indexReport;
    }
    if (sqliteFile) {
      const changedSet = await resolveChangedFilesWithDeletes();
      const graphOptions = {
        fast,
        resolveNodeModules,
        dynamicImportHeuristics,
        ...(resolutionHints.length ? { resolutionHints } : {}),
      };
      const sqliteCacheMode = cache ?? (changedSet ? "disk" : undefined);
      const index = changedSet
        ? await buildProjectIndexIncremental(projectRootFs, {
            onProgress: progressHandler,
            threads,
            discovery: discoveryOptions,
            ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
            ...workerOpts,
            ...(sqliteCacheMode !== undefined ? { cache: sqliteCacheMode } : {}),
            cacheStrict,
            files: changedSet.existingFiles,
            ...(gitBase ? { gitBase } : {}),
            ...(gitHead ? { gitHead } : {}),
            ...(changedSince ? { changedSince } : {}),
            graph: graphOptions,
            ...(indexReport ? { report: indexReport } : {}),
          })
        : await buildProjectIndexFromFiles(projectRootFs, files, {
            onProgress: progressHandler,
            threads,
            discovery: discoveryOptions,
            ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
            ...workerOpts,
            ...(sqliteCacheMode !== undefined ? { cache: sqliteCacheMode } : {}),
            cacheStrict,
            graph: graphOptions,
            ...(indexReport ? { report: indexReport } : {}),
          });
      maybeWriteNativeBackendStatus(indexReport, showProgress);

      const detailedSymbols = hasFlag("--symbols-detailed");
      const scope = getOpt("--symbols-detailed-scope") as "all" | "imported" | undefined;
      const maxEdgesRaw = getOpt("--symbols-detailed-max-edges");
      const maxEdges = maxEdgesRaw !== undefined ? Number(maxEdgesRaw) : undefined;
      const membersOnly = hasFlag("--symbols-detailed-members-only");
      const sgraph = detailedSymbols
        ? await buildSymbolGraphDetailed(index, {
            ...(scope !== undefined ? { scope } : {}),
            ...(typeof maxEdges === "number" ? { maxEdges } : {}),
            membersOnly,
          })
        : await buildSymbolGraph(index);

      const sqliteDbExists = fs.existsSync(sqliteFile);
      if (changedSet && sqliteDbExists) {
        await updateGraphSqlite({
          fileGraph: index.graph,
          symbolGraph: sgraph,
          outputPath: sqliteFile,
          changedFiles: changedSet.existingFiles,
          deletedFiles: changedSet.deletedFiles,
          fullGraphSync: true,
        });
      } else {
        await writeGraphSqlite({
          fileGraph: index.graph,
          symbolGraph: sgraph,
          outputPath: sqliteFile,
        });
      }
      await finalizeReport();
      return;
    }
    if (wantSymbols) {
      const index = await buildProjectIndexFromFiles(projectRootFs, files, {
        onProgress: progressHandler,
        threads,
        discovery: discoveryOptions,
        ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
        ...workerOpts,
        ...(cache !== undefined ? { cache } : {}),
        cacheStrict,
        graph: {
          fast,
          resolveNodeModules,
          dynamicImportHeuristics,
          ...(resolutionHints.length ? { resolutionHints } : {}),
        },
        ...(indexReport ? { report: indexReport } : {}),
      });
      maybeWriteNativeBackendStatus(indexReport, showProgress);
      let sgraph;
      if (detailedSymbols) {
        const scope = getOpt("--symbols-detailed-scope") as "all" | "imported" | undefined;
        const maxEdgesRaw = getOpt("--symbols-detailed-max-edges");
        const maxEdges = maxEdgesRaw !== undefined ? Number(maxEdgesRaw) : undefined;
        const membersOnly = hasFlag("--symbols-detailed-members-only");
        sgraph = await buildSymbolGraphDetailed(index, {
          ...(scope !== undefined ? { scope } : {}),
          ...(typeof maxEdges === "number" ? { maxEdges } : {}),
          membersOnly,
        });
      } else {
        sgraph = await buildSymbolGraph(index);
      }
      const sgraphOut = stable ? stabilizeSymbolGraph(sgraph) : sgraph;
      if (hasFlag("--symbols-only")) {
        if (format === "mermaid") {
          await writeOut(graphToMermaidSymbols(sgraphOut, projectRootFs));
        } else if (format === "dot") {
          await writeOut(graphToDOTSymbols(sgraphOut, projectRootFs));
        } else {
          if (compact) {
            const allFiles = [...index.graph.nodes];
            await writeOut(toJSON(compactSymbolsOnly(allFiles, sgraphOut, stable)));
          } else {
            await writeOut(
              toJSON({
                nodes: [...sgraphOut.nodes.values()],
                edges: sgraphOut.edges,
              }),
            );
          }
        }
        await finalizeReport();
        return;
      }
      // Reuse the graph already built during indexing to avoid an extra pass
      const fgraph = index.graph;
      const fgraphOut = stable ? stabilizeGraph(fgraph) : fgraph;
      if (format === "mermaid") {
        await writeOut(graphToMermaidSymbolsWithFiles(sgraphOut, fgraphOut, projectRootFs));
      } else if (format === "dot") {
        await writeOut(graphToDOTSymbolsWithFiles(sgraphOut, fgraphOut, projectRootFs));
      } else {
        if (compact) {
          await writeOut(toJSON(compactGraphWithSymbols(fgraphOut, sgraphOut, stable)));
        } else {
          await writeOut(
            toJSON({
              files: [...fgraphOut.nodes],
              fileEdges: fgraphOut.edges,
              symbols: [...sgraphOut.nodes.values()],
              symbolEdges: sgraphOut.edges,
            }),
          );
        }
      }
      await finalizeReport();
      return;
    }
    const graph = await collectGraph(projectRootFs, files, {
      fast,
      threads,
      resolveNodeModules,
      dynamicImportHeuristics,
      ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
      ...(resolutionHints.length ? { resolutionHints } : {}),
      ...(indexReport ? { report: indexReport } : {}),
    });
    maybeWriteNativeBackendStatus(indexReport, showProgress);
    const graphOut = stable ? stabilizeGraph(graph) : graph;
    if (format === "mermaid") await writeOut(graphToMermaid(graphOut));
    else if (format === "dot") await writeOut(graphToDOT(graphOut));
    else {
      const sqlFiles = includeSqlArtifacts ? files.filter((file) => path.extname(file).toLowerCase() === ".sql") : [];
      const sqlArtifacts = sqlFiles.length ? await buildSqlArtifactGraphFromFiles(sqlFiles) : undefined;
      await writeOut(
        toJSON({
          nodes: [...graphOut.nodes],
          edges: graphOut.edges,
          ...(sqlArtifacts ? { sqlArtifacts } : {}),
        }),
      );
    }
    await finalizeReport();
    return;
  }

  if (cmd === "index") {
    const verbose = hasFlag("--verbose");
    const commandReport: CommandReport | undefined = reportEnabled ? { command: "index", timings: {} } : undefined;
    const commandStart = performance.now();
    const resolveStart = performance.now();
    const files = await resolveFiles();
    if (commandReport) {
      commandReport.timings.resolveFilesMs = Math.round(performance.now() - resolveStart);
    }
    const threads = Number(getOpt("--threads") ?? 0);
    const cache = parseCacheModeOption(getOpt("--cache"));
    const cacheStrict = hasFlag("--cache-strict");
    const full = hasFlag("--json") || hasFlag("--full");
    const cacheVerify = hasFlag("--cache-verify");
    const shouldWriteManifest = !includeRootsAbs.length && !gitBase && !changedSince;
    const graphOptions = hasGraphOverrides ? buildGraphOptions() : undefined;
    const indexReport: BuildReport | undefined = reportEnabled || verbose ? { timings: {} } : undefined;
    if (commandReport && indexReport) {
      commandReport.index = indexReport;
    }
    const baseIndexOptions: BuildOptions = {
      onProgress: progressHandler,
      threads,
      discovery: discoveryOptions,
      ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
      ...workerOpts,
      ...(cache !== undefined ? { cache } : {}),
      cacheStrict,
      cacheVerify,
      ...(graphOptions ? { graph: graphOptions } : {}),
      ...(indexReport ? { report: indexReport } : {}),
    };
    const index = shouldWriteManifest
      ? await buildProjectIndex(projectRootFs, baseIndexOptions)
      : await buildProjectIndexFromFiles(projectRootFs, files, baseIndexOptions);
    maybeWriteNativeBackendStatus(indexReport, showProgress);
    if (full) {
      const modules = [...index.byFile.values()].map((m) => ({
        file: m.file,
        locals: m.locals.map((l) => ({
          name: l.localName,
          kind: l.kind,
          start: l.range.start,
        })),
        exports: m.exports,
        imports: m.imports,
      }));
      writeJSONLine({
        files: modules.length,
        edges: index.graph.edges.length,
        modules,
      });
    } else {
      writeJSONLine({
        files: [...index.byFile.keys()].length,
        edges: index.graph.edges.length,
      });
    }
    if (verbose && indexReport) {
      const cache = indexReport.cache;
      const fileStats = indexReport.files;
      if (cache) {
        writeStderrLine(`Cache (${cache.mode}): ${cache.hits} hits, ${cache.misses} misses`);
      }
      if (fileStats) {
        writeStderrLine(
          `Files: ${fileStats.parsed ?? 0} parsed, ${fileStats.cached ?? 0} cached, ${fileStats.total} total`,
        );
      }
    }
    if (commandReport) {
      commandReport.timings.commandMs = Math.round(performance.now() - commandStart);
      commandReport.timings.totalMs = commandReport.timings.commandMs;
      await writeCommandReport(commandReport, reportFile);
    }
    return;
  }

  if (cmd === "dumpmod") {
    const [fileArg] = parsed.positionals;
    if (!fileArg) {
      writeStderrLine("Usage: dumpmod <file>");
      exitCli(2);
    }
    const resolvedFile = resolveCliProjectFile(projectRootFs, fileArg, "File");
    if (resolvedFile.status === "error") {
      writeCliProjectFileError(resolvedFile);
      return;
    }
    const file = resolvedFile.file;
    const index = await buildProjectIndex(projectRootFs, {
      onProgress: progressHandler,
      discovery: discoveryOptions,
      ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
      ...workerOpts,
    });
    const mod = index.byFile.get(file);
    if (!mod) {
      writeJSONLine({
        status: "not_found",
        reason: "Module not indexed",
        file,
      });
      return;
    }
    writeJSONLine({
      file,
      locals: mod.locals.map((l) => ({
        name: l.localName,
        kind: l.kind,
        start: l.range.start,
      })),
      exports: mod.exports.map((e) =>
        e.type === "local"
          ? {
              type: e.type,
              exportedAs: e.exportedAs,
              def: {
                name: e.target.localName,
                kind: e.target.kind,
                start: e.target.range.start,
              },
            }
          : e,
      ),
      imports: mod.imports,
    });
    return;
  }

  if (cmd === "goto") {
    const [fileArg, lineArg, colArg] = parsed.positionals;
    if (!fileArg || !lineArg || !colArg) {
      writeStderrLine("Usage: goto <file> <line> <column>");
      exitCli(2);
    }
    const resolvedFile = resolveCliProjectFile(projectRootFs, fileArg, "File");
    if (resolvedFile.status === "error") {
      writeCliProjectFileError(resolvedFile);
      return;
    }
    const file = resolvedFile.file;
    const line = Number(lineArg);
    const column = Number(colArg);
    const index = await buildProjectIndex(projectRootFs, {
      onProgress: progressHandler,
      discovery: discoveryOptions,
      ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
      ...workerOpts,
    });
    const res = await goToDefinition(index, { file, line, column });
    writeJSONLine(res);
    return;
  }

  if (cmd === "refs") {
    const fileArg = getOpt("--file");
    const lineArg = getOpt("--line");
    const colArg = getOpt("--col") ?? getOpt("--column");
    if (!fileArg || !lineArg || !colArg) {
      writeStderrLine("Usage: refs --file <file> --line <line> --col <column>");
      exitCli(2);
    }
    const line = Number(lineArg);
    const column = Number(colArg);
    const pretty = hasFlag("--pretty");
    const resolvedFile = resolveCliProjectFile(projectRootFs, fileArg, "File");
    if (resolvedFile.status === "error") {
      writeCliProjectFileError(resolvedFile, pretty ? "text" : "json");
      return;
    }
    const file = resolvedFile.file;
    const index = await buildProjectIndex(projectRootFs, {
      onProgress: progressHandler,
      discovery: discoveryOptions,
      ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
      ...workerOpts,
    });
    const res = await findReferences(index, { file, line, column });
    if (!pretty) {
      writeJSONLine(res);
      return;
    }
    if (res.status === "ok") {
      for (const r of res.references) {
        const rel = path.relative(projectRootFs, r.file);
        const { line, column } = r.range.start;
        writeStdoutLine(`${rel}:${line}:${column}`);
      }
    } else {
      writeStdoutLine(`not_found: ${res.reason}`);
    }
    return;
  }

  if (cmd === "grep") {
    const querySource = getOpt("--query");
    const patternSource = getOpt("--pattern") ?? getOpt("--regex");
    const globs = parsed.options.get("--glob") ?? [];
    const patterns = globs.length ? globs : undefined;

    if ((querySource ? 1 : 0) + (patternSource ? 1 : 0) !== 1) {
      writeStderrLine(
        "Usage: grep [--root <dir>] (--query '<treesitter query>' | --pattern '<regex>') [--glob '<glob>'] [--ignore-case] [--max-hits N]",
      );
      exitCli(2);
    }

    if (querySource) {
      const hits = await astGrep(projectRootFs, querySource, patterns, discoveryOptions);
      writeJSONLine(hits);
      return;
    }

    const ignoreCase = hasFlag("--ignore-case") || hasFlag("-i");
    const maxHitsRaw = getOpt("--max-hits");
    const maxHits = maxHitsRaw !== undefined ? Number(maxHitsRaw) : undefined;
    const hits = await textGrep(projectRootFs, patternSource!, patterns, {
      ignoreCase,
      ...(maxHits !== undefined ? { maxHits } : {}),
      ...discoveryOptions,
    });
    writeJSONLine(hits);
    return;
  }

  if (cmd === "impact") {
    const provider = getOpt("--provider") ?? "git";

    if (provider !== "git" && provider !== "github" && provider !== "raw") {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    const options: ImpactOptionsBuilder = { provider };

    if (provider === "git") {
      const base = getOpt("--base");
      const head = getOpt("--head");
      if (!base || !head) {
        throw new Error(
          "Impact provider 'git' requires --base and --head. Example: codegraph impact --provider git --base main --head HEAD",
        );
      }
      options.base = base;
      options.head = head;
      options.cwd = projectRootFs;
    } else if (provider === "github") {
      const pr = getOpt("--pr");
      const repo = getOpt("--repo");
      if (!pr || !repo) {
        throw new Error(
          "Impact provider 'github' requires --repo owner/name and --pr <number>. Example: codegraph impact --provider github --repo acme/app --pr 42",
        );
      }
      options.pr = Number(pr);
      if (!Number.isFinite(options.pr) || options.pr <= 0) {
        throw new Error("Impact provider 'github' expects --pr as a positive integer.");
      }
      options.repo = repo;
    } else if (provider === "raw") {
      // For raw provider, diff text would come from stdin or file
      // For now, assume stdin
      const diffText = await new Promise<string>((resolve) => {
        let data = "";
        process.stdin.on("data", (chunk) => (data += chunk.toString()));
        process.stdin.on("end", () => resolve(data));
      });
      options.diffText = diffText;
    }

    // Parse other options
    const threadsRaw = getOpt("--threads");
    const threads = threadsRaw ? Number(threadsRaw) : 0;
    if (threadsRaw) options.threads = threads;

    const cache = parseCacheModeOption(getOpt("--cache"));
    if (cache !== undefined) options.cache = cache;

    const cacheStrict = hasFlag("--cache-strict");
    if (cacheStrict) options.cacheStrict = true;

    if (hasFlag("--compact") || hasFlag("--compact-json")) options.compact = true;

    const maxRefs = getOpt("--max-refs");
    if (maxRefs) options.maxRefs = Number(maxRefs);

    const depth = getOpt("--depth");
    if (depth) options.depth = Number(depth);

    const includeTests = hasFlag("--include-tests");
    const membersOnly = hasFlag("--members-only");

    const scope = getOpt("--scope");
    if (scope === "all" || scope === "imported") options.scope = scope;

    const refContext = getOpt("--ref-context");
    if (refContext) options.refContext = refContext as "line" | "block";

    const refContextLines = getOpt("--ref-context-lines");
    if (refContextLines) options.refContextLines = Number(refContextLines);

    const refBlockMaxLines = getOpt("--ref-block-max-lines");
    if (refBlockMaxLines) options.refBlockMaxLines = Number(refBlockMaxLines);

    if (discoveryOptions.ignoreGlobs?.length) {
      options.ignoreGlobs = discoveryOptions.ignoreGlobs;
    }

    const verifyRefs = hasFlag("--verify-refs");
    if (verifyRefs) options.verifyReferences = true;

    const lcovPaths = parsed.options.get("--lcov");
    if (lcovPaths?.length) {
      options.lcovPaths = lcovPaths;
      options.testCoverageSuggestions = true;
    }

    const coveragePaths = parsed.options.get("--coverage-report");
    if (coveragePaths?.length) {
      options.coveragePaths = coveragePaths;
      options.testCoverageSuggestions = true;
    }

    const testCommandTemplate = getOpt("--test-command-template");
    if (testCommandTemplate) {
      options.testCommandTemplate = testCommandTemplate;
      options.testCoverageSuggestions = true;
    }

    options.includeTests = includeTests;
    options.membersOnly = membersOnly;

    const fastGraph = graphFlags.fast;
    const resolveNodeModules = graphFlags.resolveNodeModules;
    const dynamicImportHeuristics = graphFlags.dynamicImportHeuristics;
    const resolutionHints = graphFlags.resolutionHints;

    const pretty = hasFlag("--pretty");
    const mermaid = hasFlag("--mermaid");

    try {
      const cacheMode = cache === "off" || cache === "memory" || cache === "disk" ? cache : undefined;
      const indexOpts: BuildOptions = {
        threads,
        ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
        ...workerOpts,
        ...(cacheMode !== undefined ? { cache: cacheMode } : {}),
        ...(cacheStrict ? { cacheStrict: true } : {}),
      };
      if (hasGraphOverrides) {
        indexOpts.graph = {
          fast: fastGraph,
          resolveNodeModules,
          dynamicImportHeuristics,
          ...(resolutionHints.length ? { resolutionHints } : {}),
        };
      }
      const index = await buildProjectIndex(projectRootFs, {
        ...indexOpts,
        discovery: discoveryOptions,
        onProgress: progressHandler,
      });
      const report = await analyzeImpactFromDiff(projectRootFs, index, options as ImpactOptions);
      const impactReport = ensureImpactReport(report);

      if (mermaid) {
        writeStdoutLine(formatImpactMermaid(impactReport, projectRootFs));
      } else if (pretty) {
        writeStdoutLine(`Impact Analysis Report`);
        writeStdoutLine(`======================`);
        if (impactReport.warning) {
          writeStdoutLine(`WARNING: ${impactReport.warning}`);
          writeStdoutLine(``);
        }
        writeStdoutLine(`Changed files: ${impactReport.changedFiles.length}`);
        writeStdoutLine(`Changed symbols: ${impactReport.changedSymbols.length}`);
        writeStdoutLine(`Impacted items: ${impactReport.impacted.length}`);
        writeStdoutLine(``);
        for (const item of impactReport.impacted.slice(0, 10)) {
          const reasonLabel = formatImpactReasonLabel(item);
          writeStdoutLine(
            `${item.file}: ${item.symbols.join(", ")} (${reasonLabel}, severity: ${(item.severity * 100).toFixed(1)}%)`,
          );
          if ("refs" in item && item.refs?.length) {
            const contextsToShow = item.refs.slice(0, 2);
            for (const ref of contextsToShow) {
              writeStdoutLine(`  Reference at ${ref.range.start.line}:${ref.range.start.column}:`);
              const contextLines = ref.context!.split("\n").slice(0, 5);
              for (const line of contextLines) {
                writeStdoutLine(`    ${line}`);
              }
              if (ref.context!.split("\n").length > 5) {
                writeStdoutLine(`    ...`);
              }
            }
            if (item.refs.length > 2) {
              writeStdoutLine(`  ... and ${item.refs.length - 2} more references`);
            }
          }
        }
        if (impactReport.impacted.length > 10) {
          writeStdoutLine(`... and ${impactReport.impacted.length - 10} more`);
        }
      } else {
        writeJSONLine(report);
      }
    } catch (error) {
      writeStderrLine(`Impact analysis failed: ${error instanceof Error ? error.message : String(error)}`);
      exitCli(1);
    }
    return;
  }

  // Review entry point: CLI workflow for review reports.
  if (cmd === "review") {
    const commandReport: CommandReport | undefined = reportEnabled ? { command: "review", timings: {} } : undefined;
    const commandStart = performance.now();
    const base = getOpt("--base");
    const head = getOpt("--head");
    const changedSince = getOpt("--changed-since");
    const reviewDepthRaw = getOpt("--review-depth");
    const reviewDepth = reviewDepthRaw !== undefined ? parseReviewDepth(reviewDepthRaw) : null;
    if (reviewDepthRaw !== undefined && !reviewDepth) {
      writeStderrLine(`Invalid --review-depth value "${reviewDepthRaw}". Expected minimal|standard|deep.`);
      exitCli(2);
    }
    const threadsRaw = getOpt("--threads");
    const threads = threadsRaw !== undefined ? Number(threadsRaw) : undefined;
    const cache = parseCacheModeOption(getOpt("--cache"));
    const cacheStrict = hasFlag("--cache-strict");
    const cacheVerify = hasFlag("--cache-verify");
    const incrementalStrict = hasFlag("--incremental-strict");
    const includeSymbolDetails = hasFlag("--include-symbol-details");
    const maxCallsitesRaw = getOpt("--max-callsites");
    const maxCallsites = maxCallsitesRaw !== undefined ? Number(maxCallsitesRaw) : undefined;
    const maxTestsRaw = getOpt("--max-tests");
    const maxTests = maxTestsRaw !== undefined ? Number(maxTestsRaw) : undefined;
    const reviewOpts: Parameters<typeof buildReviewReport>[1] = {};
    reviewOpts.discovery = discoveryOptions;
    if (reviewDepth) reviewOpts.reviewDepth = reviewDepth;
    if (base !== undefined) reviewOpts.gitBase = base;
    if (head !== undefined) reviewOpts.gitHead = head;
    if (changedSince !== undefined) reviewOpts.changedSince = changedSince;
    if (threads !== undefined) reviewOpts.threads = threads;
    if (cache === "off" || cache === "memory" || cache === "disk") {
      reviewOpts.cache = cache;
    }
    if (nativeMode !== "auto") reviewOpts.native = nativeMode;
    if (useNativeWorkers) reviewOpts.useNativeWorkers = true;
    if (cacheStrict) reviewOpts.cacheStrict = true;
    if (cacheVerify) reviewOpts.cacheVerify = true;
    if (incrementalStrict) reviewOpts.incrementalStrict = true;
    if (hasGraphOverrides) reviewOpts.graph = buildGraphOptions();
    if (includeSymbolDetails) {
      reviewOpts.includeSymbolDetails = includeSymbolDetails;
    }
    if (maxCallsites !== undefined) reviewOpts.maxCallsites = maxCallsites;
    if (maxTests !== undefined) reviewOpts.maxCandidates = maxTests;
    if (commandReport) {
      const reviewReport: ReviewBuildReport = { timings: {} };
      commandReport.review = reviewReport;
      reviewOpts.report = reviewReport;
    }
    const report = await buildReviewReport(projectRootFs, reviewOpts);
    if (hasFlag("--summary") || hasFlag("--pretty")) {
      writeStdoutLine(formatReviewSummary(report).trimEnd());
    } else {
      writeJSONLine(report);
    }
    if (commandReport) {
      commandReport.timings.commandMs = Math.round(performance.now() - commandStart);
      commandReport.timings.totalMs = commandReport.timings.commandMs;
      await writeCommandReport(commandReport, reportFile);
    }
    return;
  }

  if (cmd === "deps" || cmd === "rdeps") {
    await handleGraphQueryCommand({
      command: cmd,
      positionals: parsed.positionals,
      projectRootFs,
      projectRootAbs,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
      listProjectFilesForScan: async () => await listProjectFilesForScan(projectRootFs),
      ...(hasGraphOverrides || nativeMode !== "auto" ? { graphOptions: buildGraphOptions() } : {}),
    });
    return;
  }

  if (cmd === "path" || cmd === "cycles" || cmd === "unresolved") {
    await handleGraphQueryCommand({
      command: cmd,
      positionals: parsed.positionals,
      projectRootFs,
      projectRootAbs,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
      listProjectFilesForScan: async () => await listProjectFilesForScan(projectRootFs),
      ...(hasGraphOverrides || nativeMode !== "auto" ? { graphOptions: buildGraphOptions() } : {}),
    });
    return;
  }

  if (cmd === "inspect") {
    const cache = parseCacheModeOption(getOpt("--cache"));
    const limit = parsePositiveIntegerOption(getOpt("--limit"), "--limit", 20);
    const files = await resolveFilesFromRoots();
    const report = await buildInspectReport(
      projectRootFs,
      includeRootsAbs,
      files,
      discoveryOptions,
      hasGraphOverrides || nativeMode !== "auto" ? buildGraphOptions() : undefined,
      cache,
      nativeMode,
      workerOpts,
      progressHandler,
      limit,
    );
    writeJSONLine(report);
    return;
  }

  if (cmd === "hotspots") {
    const json = hasFlag("--json");
    const cache = parseCacheModeOption(getOpt("--cache"));
    const limit = parsePositiveIntegerOption(getOpt("--limit"), "--limit", 20);
    const files = await resolveFilesFromRoots();
    const { graph } = await buildScopedReportGraph(projectRootFs, includeRootsAbs, files, {
      ...(cache ? { cache } : {}),
      discovery: discoveryOptions,
      ...(hasGraphOverrides || nativeMode !== "auto" ? { graphOptions: buildGraphOptions() } : {}),
      nativeMode,
      workerOpts,
      ...(progressHandler ? { progressHandler } : {}),
    });
    const hotspots = getHotspots(graph, { limit });

    if (json) {
      writeJSONLine(hotspots);
    } else {
      writeStdoutLine("Top hotspots (files with high fan-in/out):");
      for (const item of hotspots) {
        writeStdoutLine(
          `- ${path.relative(projectRootFs, item.file)} (fan-in: ${item.fanIn}, fan-out: ${item.fanOut}, score: ${item.score.toFixed(1)})`,
        );
      }
    }
    return;
  }

  if (cmd === "apisurface") {
    await handleGraphQueryCommand({
      command: cmd,
      positionals: parsed.positionals,
      projectRootFs,
      projectRootAbs,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
      listProjectFilesForScan: async () => await listProjectFilesForScan(projectRootFs),
      indexOptions: {
        onProgress: progressHandler,
        discovery: discoveryOptions,
        ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
        ...workerOpts,
      },
    });
    return;
  }

  writeStderrLine(`Unknown command: ${cmd}`);
  exitCli(1);
}

export async function runCli(
  rawArgs: string[] = process.argv.slice(2),
  runtime: Partial<CliRuntime> = {},
): Promise<void> {
  const context = createCliContext(runtime);
  await cliContextStorage.run(context, async () => await runCliWithActiveRuntime(rawArgs));
}

if (isDirectCliExecution(import.meta.url)) {
  const context = createCliContext();
  void cliContextStorage.run(context, async () => {
    try {
      await runCliWithActiveRuntime(process.argv.slice(2));
    } catch (error) {
      writeError(error);
      exitCli(1);
    }
  });
}
