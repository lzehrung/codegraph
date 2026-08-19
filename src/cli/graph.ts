import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildSymbolGraph, type SymbolEdge, type SymbolGraph, type SymbolNode } from "../graphs/symbol-graph.js";
import { buildSymbolGraphDetailed } from "../graphs/symbol-graph-detailed.js";
import { collectGraph } from "../graph-builder.js";
import { graphToDOT, graphToMermaid } from "../graphs/render.js";
import {
  graphToDOTSymbols,
  graphToDOTSymbolsWithFiles,
  graphToMermaidSymbols,
  graphToMermaidSymbolsWithFiles,
} from "../graphs/symbol-render.js";
import { buildProjectIndexFromFiles, buildProjectIndexIncremental } from "../indexer/build-index.js";
import { type BuildOptions, type BuildReport, type CacheLocation } from "../indexer/types.js";
import { summarizeAnalysis } from "../analysisSummary.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import { updateGraphSqlite, writeGraphSqlite } from "../sqlite.js";
import { buildSqlArtifactGraphFromFiles } from "../sql/index.js";
import type { Edge, Graph } from "../types.js";
import { normalizePath, resolveFilePathFromRoot } from "../util/paths.js";
import { type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import {
  parseCacheModeOption,
  parseNonNegativeIntegerOption,
  parseOptionalNonNegativeIntegerOption,
  parseSymbolGraphScopeOption,
} from "./options.js";

// Graph JSON output is always index-based: repeated file paths and symbol ids are
// replaced with integer offsets into `files[]`/`symbolIdIndex[]` so large graphs don't
// duplicate the same strings across every node/edge. Index assignment is always sorted
// (independent of `stable`) because `fgraph.nodes`/`sgraph.nodes` insertion order can vary
// run to run under concurrent extraction, which would otherwise change what an index means
// even when the underlying graph is identical; `stable` only additionally sorts the
// fileEdges/symbolEdges arrays for byte-identical output across runs.
export type CompactEdgeTo = { type: "file"; path: number } | { type: "external"; name: string };
export type CompactFileEdge = Omit<Edge, "from" | "to"> & { from: number; to: CompactEdgeTo };
export type CompactSymbolEdge = Omit<SymbolEdge, "from" | "to"> & { from: number; to: number };
export type CompactSymbolNode = Omit<SymbolNode, "id" | "file"> & { id: number; file: number };
export type CompactFileProjection = { files: string[]; fileEdges: CompactFileEdge[] };
export type CompactSymbolProjection = {
  files: string[];
  symbols: CompactSymbolNode[];
  symbolEdges: CompactSymbolEdge[];
  symbolIdIndex: string[];
};

type CommandTimingReport = {
  totalMs?: number;
  resolveFilesMs?: number;
  commandMs?: number;
};

type GraphCommandReport = {
  command: string;
  timings: CommandTimingReport;
  index?: BuildReport;
};

function resolveGraphCacheMode(cache: BuildOptions["cache"]): Exclude<BuildOptions["cache"], undefined> {
  return cache ?? "disk";
}

export type GraphCommandContext = {
  projectRootFs: string;
  discoveryOptions: ProjectFileDiscoveryOptions;
  nativeMode: NativeRuntimeMode;
  workerOpts: { useNativeWorkers: true } | Record<string, never>;
  progressHandler: BuildOptions["onProgress"];
  cacheLocation: CacheLocation | undefined;
  graphFlags: {
    fast: boolean;
    resolveNodeModules: boolean;
    dynamicImportHeuristics: boolean;
    resolutionHints: string[];
  };
  gitBase: string | undefined;
  gitHead: string | undefined;
  changedSince: string | undefined;
  reportEnabled: boolean;
  reportFile: string | undefined;
  showProgress: boolean;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  cwd: () => string;
  resolveFiles: () => Promise<string[]>;
  resolveChangedFilesWithDeletes: () => Promise<{
    existingFiles: string[];
    deletedFiles: string[];
  } | null>;
  writeStdoutLine: (message: string) => void;
  setStderrFilePath: (filePath: string | undefined) => void;
  writeCommandReport: (report: GraphCommandReport, reportFile: string | undefined) => Promise<void>;
  maybeWriteNativeBackendStatus: (report: BuildReport | undefined, showProgress: boolean) => void;
};

function toJSON(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

export function compactFileGraph(fgraph: Graph, stable = false): CompactFileProjection {
  const files = [...fgraph.nodes].sort();
  const fileIndex = new Map<string, number>();
  for (let i = 0; i < files.length; i++) fileIndex.set(files[i]!, i);

  const fileEdges: CompactFileEdge[] = fgraph.edges.map((e) => ({
    ...e,
    from: fileIndex.get(e.from)!,
    to: e.to.type === "file" ? { type: "file" as const, path: fileIndex.get(e.to.path)! } : e.to,
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

  return { files, fileEdges };
}

export function compactGraphWithSymbols(fgraph: Graph, sgraph: SymbolGraph, stable = false) {
  const { files, fileEdges } = compactFileGraph(fgraph, stable);
  const symbolProjection = buildCompactSymbolProjection(files, sgraph, stable);

  return {
    files,
    fileEdges,
    symbols: symbolProjection.symbols,
    symbolEdges: symbolProjection.symbolEdges,
    symbolIdIndex: symbolProjection.symbolIdIndex,
  };
}

export function compactSymbolsOnly(allFiles: string[], sgraph: SymbolGraph, stable = false) {
  return buildCompactSymbolProjection(allFiles, sgraph, stable);
}

export function buildCompactSymbolProjection(
  allFiles: string[],
  sgraph: SymbolGraph,
  stable = false,
): CompactSymbolProjection {
  const files = [...allFiles].sort();
  const fileIndex = new Map<string, number>();
  for (let i = 0; i < files.length; i++) fileIndex.set(files[i]!, i);

  const symbolIds = [...sgraph.nodes.keys()].sort();
  const symbolIndex = new Map<string, number>();
  for (let i = 0; i < symbolIds.length; i++) symbolIndex.set(symbolIds[i]!, i);

  const symbols: CompactSymbolNode[] = symbolIds.map((id) => {
    const n = sgraph.nodes.get(id)!;
    return {
      ...n,
      id: symbolIndex.get(id)!,
      file: fileIndex.get(n.file)!,
    };
  });

  const symbolEdges: CompactSymbolEdge[] = sgraph.edges.map((e) => ({
    ...e,
    from: symbolIndex.get(e.from)!,
    to: symbolIndex.get(e.to)!,
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

export async function handleGraphCommand(context: GraphCommandContext): Promise<void> {
  const commandReport: GraphCommandReport | undefined = context.reportEnabled
    ? { command: "graph", timings: {} }
    : undefined;
  const commandStart = performance.now();
  const resolveStart = performance.now();
  const files = await context.resolveFiles();
  if (commandReport) {
    commandReport.timings.resolveFilesMs = Math.round(performance.now() - resolveStart);
  }
  const hasExplicitSymbolFlag =
    context.hasFlag("--symbols") || context.hasFlag("--symbols-only") || context.hasFlag("--symbols-detailed");
  const outputArg = context.getOpt("--output") ?? context.getOpt("--out");
  const sqliteArg = context.getOpt("--sqlite") ?? context.getOpt("--db");
  const stderrArg = context.getOpt("--stderr-file");
  const wantSymbols = hasExplicitSymbolFlag;
  const detailedSymbols = context.hasFlag("--symbols-detailed");
  const threads = parseNonNegativeIntegerOption(context.getOpt("--threads"), "--threads", 0);
  const cache = parseCacheModeOption(context.getOpt("--cache"));
  const cacheStrict = context.hasFlag("--cache-strict");
  const cacheVerify = context.hasFlag("--cache-verify");
  const cacheDir = context.getOpt("--cache-dir");
  const cacheDirOptions: Pick<BuildOptions, "cacheDir" | "cacheLocation"> = {
    ...(cacheDir ? { cacheDir } : {}),
    ...(context.cacheLocation ? { cacheLocation: context.cacheLocation } : {}),
  };
  const stable = context.hasFlag("--stable");
  let format: "mermaid" | "dot" | "json" = "mermaid";
  if (context.hasFlag("--json")) {
    format = "json";
  } else if (context.hasFlag("--dot")) {
    format = "dot";
  } else if (context.hasFlag("--pretty") || context.hasFlag("--mermaid")) {
    format = "mermaid";
  }
  const fast = context.graphFlags.fast;
  const resolveNodeModules = context.graphFlags.resolveNodeModules;
  const dynamicImportHeuristics = context.graphFlags.dynamicImportHeuristics;
  const resolutionHints = context.graphFlags.resolutionHints;
  const includeSqlArtifacts = context.hasFlag("--sql-artifacts");
  const outputFile =
    outputArg && !context.hasFlag("--stdout")
      ? normalizePath(resolveFilePathFromRoot(context.cwd(), outputArg))
      : undefined;
  const sqliteFile = sqliteArg ? normalizePath(resolveFilePathFromRoot(context.cwd(), sqliteArg)) : undefined;
  const effectiveCache = resolveGraphCacheMode(cache);
  if (stderrArg) {
    context.setStderrFilePath(normalizePath(resolveFilePathFromRoot(context.cwd(), stderrArg)));
  } else {
    context.setStderrFilePath(undefined);
  }

  const finalizeReport = async () => {
    if (!commandReport) return;
    commandReport.timings.commandMs = Math.round(performance.now() - commandStart);
    commandReport.timings.totalMs = commandReport.timings.commandMs;
    await context.writeCommandReport(commandReport, context.reportFile);
  };

  const writeOut = async (text: string) => {
    if (outputFile) {
      await fsp.writeFile(outputFile, `${text}\n`, "utf8");
    } else {
      context.writeStdoutLine(text);
    }
  };
  // Always populated (not gated behind --report/--progress) so a normal run can
  // detect and surface reduced-accuracy analysis (native tree-sitter unavailable
  // or per-file regex fallback) via both the stderr warning and the --json
  // `analysis` field below, per finding #43.
  const indexReport: BuildReport = { timings: {} };
  if (commandReport) {
    commandReport.index = indexReport;
  }
  if (sqliteFile) {
    const changedSet = await context.resolveChangedFilesWithDeletes();
    const graphOptions = {
      fast,
      resolveNodeModules,
      dynamicImportHeuristics,
      ...(resolutionHints.length ? { resolutionHints } : {}),
    };
    const index = changedSet
      ? await buildProjectIndexIncremental(context.projectRootFs, {
          onProgress: context.progressHandler,
          threads,
          discovery: context.discoveryOptions,
          ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
          ...context.workerOpts,
          ...cacheDirOptions,
          cache: effectiveCache,
          cacheStrict,
          cacheVerify,
          files: changedSet.existingFiles,
          ...(context.gitBase ? { gitBase: context.gitBase } : {}),
          ...(context.gitHead ? { gitHead: context.gitHead } : {}),
          ...(context.changedSince ? { changedSince: context.changedSince } : {}),
          graph: graphOptions,
          report: indexReport,
        })
      : await buildProjectIndexFromFiles(context.projectRootFs, files, {
          onProgress: context.progressHandler,
          threads,
          discovery: context.discoveryOptions,
          ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
          ...context.workerOpts,
          ...cacheDirOptions,
          cache: effectiveCache,
          cacheStrict,
          cacheVerify,
          graph: graphOptions,
          report: indexReport,
        });
    context.maybeWriteNativeBackendStatus(indexReport, context.showProgress);

    const detailedSymbols = context.hasFlag("--symbols-detailed");
    const scope = parseSymbolGraphScopeOption(context.getOpt("--symbols-detailed-scope"), "--symbols-detailed-scope");
    const maxEdgesRaw = context.getOpt("--symbols-detailed-max-edges");
    const maxEdges = parseOptionalNonNegativeIntegerOption(maxEdgesRaw, "--symbols-detailed-max-edges");
    const membersOnly = context.hasFlag("--symbols-detailed-members-only");
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
    const index = await buildProjectIndexFromFiles(context.projectRootFs, files, {
      onProgress: context.progressHandler,
      threads,
      discovery: context.discoveryOptions,
      ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
      ...context.workerOpts,
      ...cacheDirOptions,
      cache: effectiveCache,
      cacheStrict,
      cacheVerify,
      graph: {
        fast,
        resolveNodeModules,
        dynamicImportHeuristics,
        ...(resolutionHints.length ? { resolutionHints } : {}),
      },
      report: indexReport,
    });
    context.maybeWriteNativeBackendStatus(indexReport, context.showProgress);
    const analysis = summarizeAnalysis({ index, nativeMode: context.nativeMode, report: indexReport });
    let sgraph: SymbolGraph;
    if (detailedSymbols) {
      const scope = parseSymbolGraphScopeOption(context.getOpt("--symbols-detailed-scope"), "--symbols-detailed-scope");
      const maxEdgesRaw = context.getOpt("--symbols-detailed-max-edges");
      const maxEdges = parseOptionalNonNegativeIntegerOption(maxEdgesRaw, "--symbols-detailed-max-edges");
      const membersOnly = context.hasFlag("--symbols-detailed-members-only");
      sgraph = await buildSymbolGraphDetailed(index, {
        ...(scope !== undefined ? { scope } : {}),
        ...(typeof maxEdges === "number" ? { maxEdges } : {}),
        membersOnly,
      });
    } else {
      sgraph = await buildSymbolGraph(index);
    }
    const sgraphOut = stable ? stabilizeSymbolGraph(sgraph) : sgraph;
    if (context.hasFlag("--symbols-only")) {
      if (format === "mermaid") {
        await writeOut(graphToMermaidSymbols(sgraphOut, context.projectRootFs));
      } else if (format === "dot") {
        await writeOut(graphToDOTSymbols(sgraphOut, context.projectRootFs));
      } else {
        const allFiles = [...index.graph.nodes];
        await writeOut(toJSON({ ...compactSymbolsOnly(allFiles, sgraphOut, stable), analysis }));
      }
      await finalizeReport();
      return;
    }
    const fgraph = index.graph;
    const fgraphOut = stable ? stabilizeGraph(fgraph) : fgraph;
    if (format === "mermaid") {
      await writeOut(graphToMermaidSymbolsWithFiles(sgraphOut, fgraphOut, context.projectRootFs));
    } else if (format === "dot") {
      await writeOut(graphToDOTSymbolsWithFiles(sgraphOut, fgraphOut, context.projectRootFs));
    } else {
      await writeOut(toJSON({ ...compactGraphWithSymbols(fgraphOut, sgraphOut, stable), analysis }));
    }
    await finalizeReport();
    return;
  }
  let graph: Graph;
  if (cacheVerify) {
    const index = await buildProjectIndexFromFiles(context.projectRootFs, files, {
      onProgress: context.progressHandler,
      threads,
      discovery: context.discoveryOptions,
      ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
      ...context.workerOpts,
      ...cacheDirOptions,
      cache: effectiveCache,
      cacheStrict,
      cacheVerify,
      graph: {
        fast,
        resolveNodeModules,
        dynamicImportHeuristics,
        ...(resolutionHints.length ? { resolutionHints } : {}),
      },
      report: indexReport,
    });
    graph = index.graph;
  } else {
    graph = await collectGraph(context.projectRootFs, files, {
      fast,
      threads,
      resolveNodeModules,
      dynamicImportHeuristics,
      ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
      ...(resolutionHints.length ? { resolutionHints } : {}),
      report: indexReport,
    });
  }
  context.maybeWriteNativeBackendStatus(indexReport, context.showProgress);
  const analysis = summarizeAnalysis({ nativeMode: context.nativeMode, report: indexReport });
  const graphOut = stable ? stabilizeGraph(graph) : graph;
  if (format === "mermaid") {
    await writeOut(graphToMermaid(graphOut));
  } else if (format === "dot") {
    await writeOut(graphToDOT(graphOut));
  } else {
    const sqlFiles = includeSqlArtifacts ? files.filter((file) => path.extname(file).toLowerCase() === ".sql") : [];
    const sqlArtifacts = sqlFiles.length ? await buildSqlArtifactGraphFromFiles(sqlFiles) : undefined;
    const { files: compactFiles, fileEdges } = compactFileGraph(graphOut, stable);
    await writeOut(
      toJSON({
        files: compactFiles,
        fileEdges,
        ...(sqlArtifacts ? { sqlArtifacts } : {}),
        analysis,
      }),
    );
  }
  await finalizeReport();
}
