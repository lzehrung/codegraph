import fsp from "node:fs/promises";
import path from "node:path";
import { isJsFallbackAvailable, parseWithJsLanguage, type JsLanguage, type JsSyntaxTree } from "./jsFallback.js";
import { isUnsupportedParserInputError, prepareSourceInput } from "./languages/filePrep.js";
import { type LanguageSupport } from "./languages.js";
import type { FileId, EdgeTo, Edge, Graph } from "./types.js";
import {
  listProjectFiles,
  sliceText,
  unquote,
  loadNearestTsconfigFor,
  loadWorkspaceConfig,
  getGraphOnlyResolutionExtensions,
  type WorkspaceConfig,
  resolveSpecifier,
  resolveImportSpecifier,
  resolvePythonModule,
  resolveJvmPackageImportPaths,
  getPhpComposerImplicitFiles,
  normalizeResolutionHints,
  mapLimit,
  type ProjectFileDiscoveryOptions,
} from "./util.js";
import { logWithLevel, type LogLevel } from "./logging.js";
import {
  graphOnlyLanguageSupportsImportAliases,
  graphOnlySpecifierNeedsResolutionConfig,
  isGraphOnlyLanguage,
} from "./documentLinks.js";
import { extractJsTsDynamicSpecifiers } from "./util.js";
import {
  getNativeQueryExecution,
  getCompactImportsExecution,
  getNativeSyntaxTreeExecution,
  getUnifiedQueryExecution,
  isNativeQueryModified,
  isNativeRequiredUnavailableError,
  type NativeRuntimeMode,
  type NativeQueryScope,
  type CompactQueryResults,
  type NativeQueryResults,
} from "./native/treeSitterNative.js";
import { capturesByName } from "./native/queryResults.js";
import { ProjectedSyntaxTree } from "./native/projectedTree.js";
import { initNativeBackendReport, recordNativeExecutionOutcome } from "./native/nativeBackendReport.js";
import { collectAngularJsFrameworkEdges } from "./graphs/angularjs.js";
import { astGrep, textGrep, type AstGrepHit, type TextGrepHit } from "./graphs/grep.js";
import { getHotspots, type HotspotEntry, type HotspotOptions } from "./graphs/hotspots.js";
import {
  findCycles,
  findDetailedCycles,
  getDependencies,
  getReverseDependencies,
  getShortestPath,
  getUnresolvedImports,
  sortDetailedCycles,
  type CycleInternalEdge,
  type CycleSortMode,
  type DependencyNode,
  type DetailedCycle,
} from "./graphs/queries.js";
import { dotLabel, graphToDOT, graphToMermaid, mermaidLabel } from "./graphs/render.js";
import {
  graphToDOTSymbols,
  graphToDOTSymbolsWithFiles,
  graphToMermaidSymbols,
  graphToMermaidSymbolsWithFiles,
} from "./graphs/symbol-render.js";
import {
  collectModuleSpecifiersFromSource,
  type CollectModuleSpecifiersOptions,
  type FallbackImportExtractionEvent,
  type FallbackImportExtractionReason,
} from "./graphs/specifiers.js";
import {
  buildSymbolGraph,
  defNodeId,
  nodeForDef,
  type SymbolEdge,
  type SymbolGraph,
  type SymbolNode,
  type SymbolNodeKind,
  type SymbolVisibility,
} from "./graphs/symbol-graph.js";
import { buildSymbolGraphDetailed } from "./graphs/symbol-graph-detailed.js";
import { type BuildReport, type ProjectIndex } from "./index.js";
import type { ParsedFileContext } from "./indexer/parse-context.js";
import type { SyntaxTreeLike } from "./languages/types.js";

export { collectModuleSpecifiersFromSource };
export { astGrep, findCycles, findDetailedCycles, getDependencies, getHotspots, getReverseDependencies };
export { buildSymbolGraph, buildSymbolGraphDetailed };
export { getShortestPath, getUnresolvedImports, graphToDOT, graphToDOTSymbols, graphToDOTSymbolsWithFiles };
export { graphToMermaid, graphToMermaidSymbols, graphToMermaidSymbolsWithFiles, sortDetailedCycles, textGrep };
export type { AstGrepHit, CycleInternalEdge, CycleSortMode, DependencyNode, DetailedCycle, HotspotEntry };
export type { CollectModuleSpecifiersOptions, FallbackImportExtractionEvent, FallbackImportExtractionReason };
export type { HotspotOptions, TextGrepHit };
export type { SymbolEdge, SymbolGraph, SymbolNode, SymbolNodeKind, SymbolVisibility };

export type GraphBuildOptions = {
  fast?: boolean;
  fastRegexDisabledLanguages?: string[];
  resolveNodeModules?: boolean;
  dynamicImportHeuristics?: boolean;
  resolutionHints?: string[];
  native?: NativeRuntimeMode;
  logLevel?: LogLevel;
};

export type GraphCacheEntry = {
  sig: string;
  gitSig?: string;
  edges: Edge[];
};

const cloneEdge = (edge: Edge): Edge => ({
  ...edge,
  to: edge.to.type === "file" ? { type: "file", path: edge.to.path } : { type: "external", name: edge.to.name },
});

export async function collectEdgesForFile(
  file: string,
  projectRoot: string,
  workspaceConfig: WorkspaceConfig | undefined,
  opts: {
    parsed?: {
      source: string;
      tree?: SyntaxTreeLike;
      sup: LanguageSupport;
      lang?: JsLanguage;
      nativeQueries?: NativeQueryResults | null;
    };
    fast?: boolean;
    fastRegexDisabledLanguages?: string[];
    resolveNodeModules?: boolean;
    dynamicImportHeuristics?: boolean;
    resolutionHints?: string[];
    native?: NativeRuntimeMode;
    fileSignature?: { sig: string; gitSig?: string; cacheSig?: string };
    cachedFileEdges?: GraphCacheEntry;
    onFileEdges?: (file: string, entry: GraphCacheEntry) => void;
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
    report?: BuildReport;
    logLevel?: LogLevel;
  },
): Promise<Edge[]> {
  const normalizedFile = file.replace(/\\/g, "/");
  const sigEntry = opts.fileSignature;
  const sig = sigEntry?.sig;
  const gitSig = sigEntry?.gitSig;

  const emitCacheEntry = (edges: Edge[]) => {
    if (!sig || !opts.onFileEdges) return;
    opts.onFileEdges(normalizedFile, {
      sig,
      ...(gitSig ? { gitSig } : {}),
      edges: edges.map(cloneEdge),
    });
  };

  const cached = sig || gitSig ? opts.cachedFileEdges : undefined;
  const matchesGitSig = !!gitSig && !!cached?.gitSig && cached.gitSig === gitSig;
  const matchesSig = !!sig && !!cached && cached.sig === sig;

  if (cached && (matchesGitSig || matchesSig)) {
    const cloned = cached.edges.map(cloneEdge);
    emitCacheEntry(cloned);
    return cloned;
  }

  const parsed = opts.parsed;
  let sup = parsed?.sup;
  let lang = parsed?.lang;
  let src = parsed?.source;
  let nativeQueries = parsed?.nativeQueries ?? null;
  let compactNativeImports: CompactQueryResults | null = null;
  if (!sup || src === undefined) {
    const prep = await prepareSourceInput(file);
    sup = prep.sup;
    src = prep.source;
    const fastRegexDisabled = opts.fastRegexDisabledLanguages?.includes(sup.id);
    const shouldSkipNativeForFastGraph = !!opts.fast && (sup.id === "ts" || sup.id === "js") && !fastRegexDisabled;
    if (!shouldSkipNativeForFastGraph) {
      // Use compact imports execution for graph mode -- smaller payload
      const compactExecution = getCompactImportsExecution(src, sup, opts.native);
      compactNativeImports = compactExecution.results;
      recordNativeExecutionOutcome(opts.report, {
        file: normalizedFile,
        support: sup,
        results: compactExecution.results,
        ...(compactExecution.fallbackReason ? { fallbackReason: compactExecution.fallbackReason } : {}),
        ...(compactExecution.error ? { error: compactExecution.error } : {}),
      });
    }
  }

  const fast = !!opts.fast;
  const specs = collectModuleSpecifiersFromSource(sup, lang, src, {
    ...(parsed?.tree ? { tree: parsed.tree } : {}),
    ...(nativeQueries ? { nativeQueries } : {}),
    ...(compactNativeImports ? { compactNativeImports } : {}),
    fast,
    file: normalizedFile,
    ...(opts.fastRegexDisabledLanguages ? { fastRegexDisabledLanguages: opts.fastRegexDisabledLanguages } : {}),
    ...(opts.onFallbackImportExtraction ? { onFallbackImportExtraction: opts.onFallbackImportExtraction } : {}),
    ...(opts.native ? { native: opts.native } : {}),
    ...(opts.logLevel ? { logLevel: opts.logLevel } : {}),
  });

  if ((sup.id === "ts" || sup.id === "js") && opts.dynamicImportHeuristics) {
    const dynamicSpecs = extractJsTsDynamicSpecifiers(src, normalizedFile, projectRoot);
    if (dynamicSpecs.length > 0) {
      const existing = new Set(specs.map((entry) => entry.spec));
      for (const entry of dynamicSpecs) {
        if (existing.has(entry.spec)) continue;
        existing.add(entry.spec);
        specs.push(entry);
      }
    }
  }

  const graphOnlyLanguage = isGraphOnlyLanguage(sup.id);
  const graphOnlyAliasLanguage = graphOnlyLanguageSupportsImportAliases(sup.id);
  const needsGraphOnlyResolutionConfig =
    graphOnlyAliasLanguage && specs.some(({ spec }) => graphOnlySpecifierNeedsResolutionConfig(spec));
  const { matchPath } =
    sup.id === "ts" || sup.id === "tsx" || needsGraphOnlyResolutionConfig
      ? await loadNearestTsconfigFor(file, opts?.logLevel)
      : { matchPath: undefined };
  const edges: Edge[] = [];
  const edgeResolutionTasks = specs.map(async (entry) => {
    const { spec, raw, typeOnly, phpImportType, resolved, confidence, resolutionKind, dropIfUnresolved } = entry;
    let to: EdgeTo;
    const resolutionExtensions = graphOnlyLanguage
      ? getGraphOnlyResolutionExtensions(sup.id, resolutionKind ?? "document")
      : undefined;
    if (sup.id === "python") {
      const relDotsMatch = spec.startsWith(".") ? spec.match(/^\.+/) : null;
      const relDots = relDotsMatch ? relDotsMatch[0].length : 0;
      const isDotsOnly = /^\.+$/.test(spec);
      const res = await resolvePythonModule(projectRoot, file, isDotsOnly ? null : spec, relDots);
      to =
        typeof res === "string"
          ? { type: "file", path: res.replace(/\\/g, "/") }
          : { type: "external", name: res.external };
    } else if (sup.id === "go") {
      const res = await resolveImportSpecifier(projectRoot, file, spec, sup.id, {
        ...(matchPath ? { matchPath } : {}),
        ...(workspaceConfig ? { workspaceConfig } : {}),
        resolveNodeModules: !!opts.resolveNodeModules,
        ...(opts.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
      });
      to =
        typeof res === "string"
          ? { type: "file", path: res.replace(/\\/g, "/") }
          : { type: "external", name: res.external };
    } else if (sup.id === "java" || sup.id === "kotlin") {
      const packageTargets = await resolveJvmPackageImportPaths(projectRoot, spec, sup.id);
      if (packageTargets.length > 0) {
        return packageTargets.map((targetPath) => ({
          to: { type: "file", path: targetPath.replace(/\\/g, "/") } as EdgeTo,
          spec,
          ...(raw !== undefined && { raw }),
          ...(typeOnly !== undefined && { typeOnly }),
          ...(resolved !== undefined && { resolved }),
          ...(confidence !== undefined && { confidence }),
        }));
      }
      const res = await resolveImportSpecifier(projectRoot, file, spec, sup.id, {
        ...(matchPath ? { matchPath } : {}),
        ...(workspaceConfig ? { workspaceConfig } : {}),
        resolveNodeModules: !!opts.resolveNodeModules,
        ...(opts.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
      });
      to =
        typeof res === "string"
          ? { type: "file", path: res.replace(/\\/g, "/") }
          : { type: "external", name: raw ?? res.external };
    } else if (["csharp", "ruby", "rust", "php"].includes(sup.id)) {
      const { resolvePathLikeModule } = await import("./util.js");
      const res =
        sup.id === "php"
          ? await resolveImportSpecifier(projectRoot, file, spec, sup.id, {
              ...(matchPath ? { matchPath } : {}),
              ...(workspaceConfig ? { workspaceConfig } : {}),
              resolveNodeModules: !!opts.resolveNodeModules,
              ...(opts.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
              ...(phpImportType ? { phpImportType } : {}),
            })
          : await resolvePathLikeModule(projectRoot, spec);
      if (res && typeof res === "string") {
        to = { type: "file", path: res.replace(/\\/g, "/") };
      } else {
        // Fallback to resolveSpecifier for relative paths like ./foo
        const res2 = await resolveSpecifier(file, spec, projectRoot, matchPath, workspaceConfig, {
          resolveNodeModules: !!opts.resolveNodeModules,
          ...(resolutionExtensions ? { resolutionExtensions } : {}),
          ...(opts.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
        });
        to =
          typeof res2 === "string"
            ? { type: "file", path: res2.replace(/\\/g, "/") }
            : { type: "external", name: raw ?? res2.external };
      }
    } else {
      const res = await resolveSpecifier(file, spec, projectRoot, matchPath, workspaceConfig, {
        resolveNodeModules: !!opts.resolveNodeModules,
        ...(resolutionExtensions ? { resolutionExtensions } : {}),
        ...(opts.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
      });
      to =
        typeof res === "string"
          ? { type: "file", path: res.replace(/\\/g, "/") }
          : { type: "external", name: raw ?? res.external };
    }
    if (to.type === "external" && dropIfUnresolved) {
      return null;
    }
    return [
      {
        to,
        spec,
        ...(raw !== undefined && { raw }),
        ...(typeOnly !== undefined && { typeOnly }),
        ...(resolved !== undefined && { resolved }),
        ...(confidence !== undefined && { confidence }),
      },
    ];
  });

  for (const resolvedEdge of await Promise.all(edgeResolutionTasks)) {
    if (!resolvedEdge) continue;
    for (const edgeEntry of resolvedEdge) {
      const { to, spec, raw, typeOnly, resolved, confidence } = edgeEntry;
      edges.push({
        from: normalizedFile,
        to,
        raw: raw ?? spec,
        ...(typeOnly !== undefined && { typeOnly }),
        ...(resolved !== undefined && { resolved }),
        ...(confidence !== undefined && { confidence }),
      });
    }
  }

  if (sup.id === "php") {
    const implicitFiles = await getPhpComposerImplicitFiles(projectRoot, file);
    const seenFileTargets = new Set(
      edges
        .map((edge) => (edge.to.type === "file" ? edge.to.path : null))
        .filter((target): target is string => !!target),
    );
    for (const implicitFile of implicitFiles) {
      const normalizedTarget = implicitFile.replace(/\\/g, "/");
      if (normalizedTarget === normalizedFile || seenFileTargets.has(normalizedTarget)) {
        continue;
      }

      const relativeRaw = path.relative(path.dirname(file), implicitFile).replace(/\\/g, "/");
      edges.push({
        from: normalizedFile,
        to: { type: "file", path: normalizedTarget },
        raw: relativeRaw.startsWith(".") || relativeRaw.startsWith("/") ? relativeRaw : `./${relativeRaw}`,
      });
      seenFileTargets.add(normalizedTarget);
    }
  }
  emitCacheEntry(edges);
  return edges;
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
    fileSignatures?: Map<string, { sig: string; gitSig?: string; cacheSig?: string }>;
    cachedFileEdges?: Map<string, GraphCacheEntry>;
    onFileEdges?: (file: string, entry: GraphCacheEntry) => void;
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
    report?: BuildReport;
    baseGraph?: Graph;
    replaceFiles?: Set<string>;
    logLevel?: LogLevel;
  },
): Promise<Graph> {
  const normalizePath = (file: string) => file.replace(/\\/g, "/");
  const normalizedFiles = files.map(normalizePath);
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
