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
import type { ReviewBuildReport } from "./review.js";
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
} from "./graphs.js";
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
import { CLI_HELP_TEXT, helpTextForCommand, isKnownCliCommand } from "./cli/help.js";
import { handleImpactCommand } from "./cli/impact.js";
import { handleMcpServeCommand } from "./cli/mcp.js";
import {
  isCliValueOption,
  parseCacheModeOption,
  parseNonNegativeIntegerOption,
  parseOptionalNonNegativeIntegerOption,
  parseOptionalPositiveIntegerOption,
  parsePositiveIntegerOption,
} from "./cli/options.js";
import { getCodegraphPackageIdentity, getCodegraphVersion } from "./cli/packageInfo.js";
import { handleReviewCommand } from "./cli/review.js";
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
    commands.push(`codegraph unresolved ${rootFlag}${targetSuffix} --json`);
  }
  if (hasCycles) {
    commands.push(`codegraph cycles ${rootFlag}${targetSuffix} --sort priority --json`);
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

function parseNativeRuntimeMode(value: string | undefined): NativeRuntimeMode {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "on" || value === "off") {
    return value;
  }
  throw new Error(`Invalid --native value "${value}". Expected auto|on|off.`);
}

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

  if (!isKnownCliCommand(cmd)) {
    writeStderrLine(`Unknown command: ${cmd}`);
    exitCli(1);
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
    const threads = parseNonNegativeIntegerOption(getOpt("--threads"), "--threads", 0);
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
      const maxEdges = parseOptionalNonNegativeIntegerOption(maxEdgesRaw, "--symbols-detailed-max-edges");
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
        const maxEdges = parseOptionalNonNegativeIntegerOption(maxEdgesRaw, "--symbols-detailed-max-edges");
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
    const threads = parseNonNegativeIntegerOption(getOpt("--threads"), "--threads", 0);
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
    const line = parsePositiveIntegerOption(lineArg, "line", 1);
    const column = parsePositiveIntegerOption(colArg, "column", 1);
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
    const line = parsePositiveIntegerOption(lineArg, "--line", 1);
    const column = parsePositiveIntegerOption(colArg, "--col", 1);
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
    const maxHits = parseOptionalPositiveIntegerOption(maxHitsRaw, "--max-hits");
    const hits = await textGrep(projectRootFs, patternSource!, patterns, {
      ignoreCase,
      ...(maxHits !== undefined ? { maxHits } : {}),
      ...discoveryOptions,
    });
    writeJSONLine(hits);
    return;
  }

  if (cmd === "impact") {
    await handleImpactCommand({
      projectRootFs,
      discoveryOptions,
      getOpt,
      hasFlag,
      parsedOptions: parsed.options,
      nativeMode,
      workerOpts,
      graphOptions: hasGraphOverrides
        ? {
            fast: graphFlags.fast,
            resolveNodeModules: graphFlags.resolveNodeModules,
            dynamicImportHeuristics: graphFlags.dynamicImportHeuristics,
            ...(graphFlags.resolutionHints.length ? { resolutionHints: graphFlags.resolutionHints } : {}),
          }
        : undefined,
      progressHandler,
      readStdin: async () =>
        await new Promise<string>((resolve) => {
          let data = "";
          process.stdin.on("data", (chunk) => {
            data += chunk.toString();
          });
          process.stdin.on("end", () => resolve(data));
        }),
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  // Review entry point: CLI workflow for review reports.
  if (cmd === "review") {
    const commandReport: CommandReport | undefined = reportEnabled ? { command: "review", timings: {} } : undefined;
    await handleReviewCommand({
      projectRootFs,
      discoveryOptions,
      reportFile,
      commandReport,
      getOpt,
      hasFlag,
      nativeMode,
      useNativeWorkers,
      graphOptions: hasGraphOverrides ? buildGraphOptions() : undefined,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      writeCommandReport,
      exit: exitCli,
    });
    return;
  }

  const buildGraphQueryIndexOptions = (graphOptions: GraphBuildOptions | undefined): BuildOptions => ({
    onProgress: progressHandler,
    discovery: discoveryOptions,
    ...(graphOptions ? { graph: graphOptions } : {}),
    ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
    ...workerOpts,
  });

  if (cmd === "deps" || cmd === "rdeps") {
    const graphOptions = hasGraphOverrides || nativeMode !== "auto" ? buildGraphOptions() : undefined;
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
      ...(graphOptions ? { graphOptions } : {}),
      indexOptions: buildGraphQueryIndexOptions(graphOptions),
    });
    return;
  }

  if (cmd === "path" || cmd === "cycles" || cmd === "unresolved") {
    const graphOptions = hasGraphOverrides || nativeMode !== "auto" ? buildGraphOptions() : undefined;
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
      ...(graphOptions ? { graphOptions } : {}),
      indexOptions: buildGraphQueryIndexOptions(graphOptions),
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
