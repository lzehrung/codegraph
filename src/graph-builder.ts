import path from "node:path";

import { isUnsupportedParserInputError } from "./languages/filePrep.js";
import type { Edge, Graph } from "./types.js";
import { loadWorkspaceConfig, normalizeResolutionHints, mapLimit } from "./util.js";
import { logWithLevel, type LogLevel } from "./logging.js";
import { isNativeRequiredUnavailableError, type NativeRuntimeMode } from "./native/treeSitterNative.js";
import { initNativeBackendReport } from "./native/nativeBackendReport.js";
import { collectAngularJsFrameworkEdges } from "./graphs/angularjs.js";
import { type FallbackImportExtractionEvent } from "./graphs/specifiers.js";
import type { GraphCacheEntry } from "./graphs/types.js";
import type { BuildReport } from "./indexer/types.js";
import type { ParsedFileContext } from "./indexer/parse-context.js";
import { collectEdgesForFile } from "./graph-edge-collector.js";
import { buildSqlFactCache } from "./sql/sourceGraph.js";

export async function collectGraph(
  projectRoot: string,
  files: string[],
  opts?: {
    parsed?: Map<string, ParsedFileContext>;
    fast?: boolean;
    fastRegexDisabledLanguages?: string[];
    threads?: number;
    resolveNodeModules?: boolean;
    dynamicImportHeuristics?: boolean;
    resolutionHints?: string[];
    native?: NativeRuntimeMode;
    fileSignatures?: Map<string, { sig: string; gitSig?: string; cacheSig?: string }>;
    cachedFileEdges?: Map<string, GraphCacheEntry>;
    onFileEdges?: (file: string, entry: GraphCacheEntry) => void;
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
    report?: BuildReport;
    baseGraph?: Graph;
    replaceFiles?: Set<string>;
    logLevel?: LogLevel;
    allFiles?: string[];
  },
): Promise<Graph> {
  const normalizePath = (file: string) => file.replace(/\\/g, "/");
  const normalizedFiles = files.map(normalizePath);
  const normalizedAllFiles = (opts?.allFiles ?? files).map(normalizePath);
  const hasExplicitReplace = !!opts?.replaceFiles;
  const replaceSet = hasExplicitReplace
    ? new Set(Array.from(opts.replaceFiles ?? [], (file) => normalizePath(file)))
    : new Set<string>(normalizedFiles);
  const baseGraph = opts?.baseGraph;
  const graph: Graph = baseGraph
    ? {
        nodes: new Set(baseGraph.nodes),
        edges: baseGraph.edges.filter((edge) => !replaceSet.has(edge.from)),
      }
    : { nodes: new Set(normalizedFiles), edges: [] };
  for (const file of normalizedFiles) graph.nodes.add(file);
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);
  const resolutionHints = normalizeResolutionHints(opts?.resolutionHints);
  initNativeBackendReport(opts?.report);
  const sqlFactCache = normalizedAllFiles.some((file) => path.extname(file).toLowerCase() === ".sql")
    ? await buildSqlFactCache(normalizedAllFiles)
    : undefined;

  const conc = Math.max(1, Math.min(Number(opts?.threads || 0) || 32, 128));

  const addEdgeTargetsToGraph = (edges: Edge[]) => {
    for (const edge of edges) {
      if (edge.to.type === "file") graph.nodes.add(edge.to.path);
    }
  };

  const mergeUniqueEdges = (...edgeGroups: Edge[][]): Edge[] => {
    const merged: Edge[] = [];
    const seen = new Set<string>();
    for (const group of edgeGroups) {
      for (const edge of group) {
        const key = `${edge.from}::${edge.raw}::${edge.to.type === "file" ? edge.to.path : `external:${edge.to.name}`}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(edge);
      }
    }
    return merged;
  };

  if (graph.edges.length > 0) {
    addEdgeTargetsToGraph(graph.edges);
  }

  const filePromises = await mapLimit(files, conc, async (file) => {
    try {
      const normalizedFile = file.replace(/\\/g, "/");
      const sigEntry = opts?.fileSignatures?.get(normalizedFile);
      const shouldReplace = hasExplicitReplace && replaceSet.has(normalizedFile);
      const cachedFileEdges = !shouldReplace ? opts?.cachedFileEdges?.get(normalizedFile) : undefined;
      const parsedEntry = opts?.parsed?.get(file);
      const edges = await collectEdgesForFile(file, projectRoot, workspaceConfig, {
        ...(parsedEntry ? { parsed: parsedEntry } : {}),
        fast: !!opts?.fast,
        ...(opts?.fastRegexDisabledLanguages ? { fastRegexDisabledLanguages: opts.fastRegexDisabledLanguages } : {}),
        resolveNodeModules: !!opts?.resolveNodeModules,
        dynamicImportHeuristics: !!opts?.dynamicImportHeuristics,
        resolutionHints,
        ...(opts?.native ? { native: opts.native } : {}),
        ...(sigEntry ? { fileSignature: sigEntry } : {}),
        ...(cachedFileEdges ? { cachedFileEdges } : {}),
        ...(opts?.onFileEdges ? { onFileEdges: opts.onFileEdges } : {}),
        ...(opts?.onFallbackImportExtraction ? { onFallbackImportExtraction: opts.onFallbackImportExtraction } : {}),
        ...(opts?.report ? { report: opts.report } : {}),
        allFiles: normalizedAllFiles,
        ...(sqlFactCache ? { sqlFactCache } : {}),
      });
      addEdgeTargetsToGraph(edges);
      return edges;
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
      if (isUnsupportedParserInputError(error)) {
        return [] as Edge[];
      }
      logWithLevel(opts?.logLevel, "warn", `Warning: Failed to process file ${file} for graph:`, error);
      return [] as Edge[];
    }
  });

  const allEdges = filePromises;
  const newEdges = allEdges.flat();
  const angularJsEdges = await collectAngularJsFrameworkEdges(projectRoot, files, workspaceConfig, opts?.parsed);
  addEdgeTargetsToGraph(angularJsEdges);
  graph.edges = mergeUniqueEdges(graph.edges, newEdges, angularJsEdges);
  return graph;
}
