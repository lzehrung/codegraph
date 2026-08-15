import { isUnsupportedParserInputError } from "./languages/filePrep.js";
import type { Edge, Graph } from "./types.js";
import { loadWorkspaceConfig } from "./util/workspace.js";
import { fileIdentityKey, normalizePath, normalizeResolutionHints } from "./util/paths.js";
import { mapLimit } from "./util/concurrency.js";
import { logWithLevel } from "./logging.js";
import type { LogLevel } from "./logging.js";
import { isNativeRequiredUnavailableError } from "./native/treeSitterNative.js";
import type { NativeRuntimeMode } from "./native/treeSitterNative.js";
import { initNativeBackendReport } from "./native/nativeBackendReport.js";
import { collectAngularJsFrameworkEdges } from "./graphs/angularjs.js";
import type { FallbackImportExtractionEvent } from "./graphs/specifiers.js";
import type { GraphCacheEntry } from "./graphs/types.js";
import { supportForFile, type LanguageExtensionMap } from "./languages.js";
import type { BuildReport } from "./indexer/types.js";
import type { ParsedFileContext } from "./indexer/parse-context.js";
import { collectEdgesForFile, hasBetterProvenance } from "./graph-edge-collector.js";
import { buildSqlFactCache, sqlCorpusSignature } from "./sql/sourceGraph.js";

type GraphFileSignature = { sig: string; gitSig?: string; cacheSig?: string };

function canReuseSqlEdgeCache(
  file: string,
  sqlCorpusSig: string | undefined,
  fileSignatures: Map<string, GraphFileSignature> | undefined,
  cachedFileEdges: Map<string, GraphCacheEntry> | undefined,
): boolean {
  if (!sqlCorpusSig || !fileSignatures || !cachedFileEdges) return false;
  const signature = fileSignatures.get(file);
  const cached = cachedFileEdges.get(file);
  if (!signature || !cached || cached.sqlCorpusSig !== sqlCorpusSig) return false;
  const matchesGitSig = !!signature.gitSig && !!cached.gitSig && cached.gitSig === signature.gitSig;
  return matchesGitSig || cached.sig === signature.sig;
}

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
    fileSignatures?: Map<string, GraphFileSignature>;
    cachedFileEdges?: Map<string, GraphCacheEntry>;
    onFileEdges?: (file: string, entry: GraphCacheEntry) => void;
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
    report?: BuildReport;
    baseGraph?: Graph;
    replaceFiles?: Set<string>;
    logLevel?: LogLevel;
    allFiles?: string[];
    languageExtensions?: LanguageExtensionMap;
  },
): Promise<Graph> {
  const normalizedFiles = files.map(normalizePath);
  const normalizedAllFiles = (opts?.allFiles ?? files).map(normalizePath);
  const isSqlFile = (file: string): boolean => supportForFile(file, opts?.languageExtensions)?.id === "sql";
  const hasExplicitReplace = !!opts?.replaceFiles;
  const requestedReplaceSet = hasExplicitReplace
    ? new Set(Array.from(opts.replaceFiles ?? [], (file) => normalizePath(file)))
    : new Set<string>(normalizedFiles);
  const sqlFiles = Array.from(new Set(normalizedAllFiles.filter(isSqlFile))).sort((left, right) =>
    left.localeCompare(right),
  );
  const sqlFactsMayHaveChanged = normalizedFiles.some(isSqlFile) || Array.from(requestedReplaceSet).some(isSqlFile);
  const filesToCollect = sqlFactsMayHaveChanged
    ? Array.from(new Set([...normalizedFiles, ...sqlFiles]))
    : normalizedFiles;
  const replaceSet = sqlFactsMayHaveChanged
    ? new Set([...Array.from(requestedReplaceSet), ...sqlFiles])
    : requestedReplaceSet;
  const baseGraph = opts?.baseGraph;
  const graph: Graph = baseGraph
    ? {
        nodes: new Set(baseGraph.nodes),
        edges: baseGraph.edges.filter((edge) => !replaceSet.has(edge.from)),
      }
    : { nodes: new Set(filesToCollect), edges: [] };
  for (const file of filesToCollect) graph.nodes.add(file);
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);
  const resolutionHints = normalizeResolutionHints(opts?.resolutionHints);
  initNativeBackendReport(opts?.report);
  const sqlCorpusSig = sqlCorpusSignature(sqlFiles, opts?.fileSignatures);
  const sqlFactCacheNeeded =
    !!sqlFiles.length &&
    filesToCollect.some((file) => {
      if (!isSqlFile(file)) return false;
      const shouldReplace = hasExplicitReplace && replaceSet.has(file);
      return shouldReplace || !canReuseSqlEdgeCache(file, sqlCorpusSig, opts?.fileSignatures, opts?.cachedFileEdges);
    });
  const sqlFactCache = sqlFactCacheNeeded
    ? await buildSqlFactCache(normalizedAllFiles, opts?.languageExtensions)
    : undefined;

  const conc = Math.max(1, Math.min(Number(opts?.threads || 0) || 32, 128));

  const addEdgeTargetsToGraph = (edges: Edge[]) => {
    for (const edge of edges) {
      if (edge.to.type === "file") graph.nodes.add(edge.to.path);
    }
  };

  const mergeUniqueEdges = (...edgeGroups: Edge[][]): Edge[] => {
    const byKey = new Map<string, Edge>();
    for (const group of edgeGroups) {
      for (const edge of group) {
        const target = edge.to.type === "file" ? edge.to.path : `external:${edge.to.name}`;
        // typeOnly is part of identity: a runtime import and a type-only import to the same
        // target are distinct edges (e.g. `import { X }` plus `import type { X }`), and
        // collapsing them on from/raw/target alone silently drops the weaker of the two.
        const kind = edge.typeOnly ? "type-only" : "runtime";
        const key = `${edge.from}::${edge.raw}::${target}::${kind}`;
        const previous = byKey.get(key);
        if (!previous || hasBetterProvenance(edge, previous)) byKey.set(key, edge);
      }
    }
    return [...byKey.values()];
  };

  if (graph.edges.length) {
    addEdgeTargetsToGraph(graph.edges);
  }

  const filePromises = await mapLimit(filesToCollect, conc, async (file) => {
    try {
      const normalizedFile = file.replace(/\\/g, "/");
      const sigEntry = opts?.fileSignatures?.get(normalizedFile);
      const shouldReplace = hasExplicitReplace && replaceSet.has(normalizedFile);
      const cachedFileEdges = !shouldReplace ? opts?.cachedFileEdges?.get(normalizedFile) : undefined;
      const parsedEntry = opts?.parsed?.get(fileIdentityKey(file));
      const edges = await collectEdgesForFile(file, projectRoot, workspaceConfig, {
        ...(parsedEntry ? { parsed: parsedEntry } : {}),
        fast: !!opts?.fast,
        ...(opts?.fastRegexDisabledLanguages ? { fastRegexDisabledLanguages: opts.fastRegexDisabledLanguages } : {}),
        resolveNodeModules: !!opts?.resolveNodeModules,
        dynamicImportHeuristics: !!opts?.dynamicImportHeuristics,
        resolutionHints,
        ...(opts?.native ? { native: opts.native } : {}),
        ...(sigEntry ? { fileSignature: sigEntry } : {}),
        ...(sqlCorpusSig ? { sqlCorpusSig } : {}),
        ...(cachedFileEdges ? { cachedFileEdges } : {}),
        ...(opts?.onFileEdges ? { onFileEdges: opts.onFileEdges } : {}),
        ...(opts?.onFallbackImportExtraction ? { onFallbackImportExtraction: opts.onFallbackImportExtraction } : {}),
        ...(opts?.report ? { report: opts.report } : {}),
        allFiles: normalizedAllFiles,
        ...(sqlFactCache ? { sqlFactCache } : {}),
        ...(opts?.languageExtensions ? { languageExtensions: opts.languageExtensions } : {}),
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
  const angularJsEdges = await collectAngularJsFrameworkEdges(
    projectRoot,
    filesToCollect,
    workspaceConfig,
    opts?.parsed,
  );
  addEdgeTargetsToGraph(angularJsEdges);
  graph.edges = mergeUniqueEdges(graph.edges, newEdges, angularJsEdges);
  graph.nodes = new Set(normalizedAllFiles);
  addEdgeTargetsToGraph(graph.edges);
  return graph;
}
