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
  type BuildReport,
  type ImportBinding,
  type ProjectIndex,
  type ResolvedExport,
  type SymbolDef,
  SymbolKind,
} from "./index.js";
import type { ParsedFileContext } from "./indexer/parse-context.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "./languages/types.js";

export { collectModuleSpecifiersFromSource };
export { astGrep, findCycles, findDetailedCycles, getDependencies, getHotspots, getReverseDependencies };
export { getShortestPath, getUnresolvedImports, graphToDOT, graphToDOTSymbols, graphToDOTSymbolsWithFiles };
export { graphToMermaid, graphToMermaidSymbols, graphToMermaidSymbolsWithFiles, sortDetailedCycles, textGrep };
export type { AstGrepHit, CycleInternalEdge, CycleSortMode, DependencyNode, DetailedCycle, HotspotEntry };
export type { CollectModuleSpecifiersOptions, FallbackImportExtractionEvent, FallbackImportExtractionReason };
export type { HotspotOptions, TextGrepHit };

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

// --------------------------- Symbol graph utilities ---------------------------

export type SymbolNodeKind =
  | "function"
  | "class"
  | "variable"
  | "interface"
  | "type"
  | "default"
  | "import"
  | "namespaceImport";

/**
 * Access visibility of a symbol. Used to track language-specific visibility modifiers:
 * - "public": Accessible from anywhere (default for exports, Python public names)
 * - "private": Class/module private (TypeScript private, Python _underscore, Rust private)
 * - "protected": Accessible to subclasses (TypeScript/Java protected)
 * - "internal": Package/module internal (Rust pub(crate), C# internal)
 */
export type SymbolVisibility = "public" | "private" | "protected" | "internal";
export type SymbolNode = {
  id: string;
  file: FileId;
  name: string;
  kind: SymbolNodeKind;
  docstring?: string;
  lineSpan?: number;
  complexity?: number;
  visibility?: SymbolVisibility;
};
export type SymbolEdge = { from: string; to: string; label?: string };
export type SymbolGraph = {
  nodes: Map<string, SymbolNode>;
  edges: SymbolEdge[];
};

function defNodeId(def: { file: string; localName: string; range?: { start: { index?: number } } }) {
  const idx = def.range?.start?.index ?? 0;
  const f = typeof def.file === "string" ? def.file.replace(/\\/g, "/") : def.file;
  return `${f}::${def.localName}::${idx}`;
}

function nodeForDef(def: {
  file: string;
  localName: string;
  kind: string;
  range?: { start: { index?: number } };
  docstring?: string;
  lineSpan?: number;
  complexity?: number;
}): SymbolNode {
  return {
    id: defNodeId(def),
    file: def.file,
    name: def.localName,
    kind: (def.kind as SymbolNodeKind) ?? "variable",
    ...(def.docstring ? { docstring: def.docstring } : {}),
    ...(def.lineSpan ? { lineSpan: def.lineSpan } : {}),
    ...(typeof def.complexity === "number" ? { complexity: def.complexity } : {}),
  };
}

export async function buildSymbolGraph(index: ProjectIndex): Promise<SymbolGraph> {
  await Promise.resolve();
  const nodes = new Map<string, SymbolNode>();
  const edges: SymbolEdge[] = [];
  const seenEdges = new Set<string>();

  const addEdge = (from: string, to: string, label?: string) => {
    const key = `${from}->${to}::${label ?? ""}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(label ? { from, to, label } : { from, to });
  };

  // Add definition nodes for all locals
  for (const [, mod] of index.byFile) {
    for (const def of mod.locals) {
      const n = nodeForDef(def);
      if (!nodes.has(n.id)) nodes.set(n.id, n);
    }
  }

  const normalizePath = (p: string) => p.replace(/\\/g, "/");

  // Resolve imports to exported locals and add edges from aliases to defs
  for (const [file, mod] of index.byFile) {
    for (const imp of mod.imports) {
      if (!imp) continue;
      const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
      const targetMod = targetFile ? index.byFile.get(targetFile) : undefined;

      if (imp.kind === "named") {
        const aliasId = `${file}::${imp.local}::import`;
        if (!nodes.has(aliasId))
          nodes.set(aliasId, {
            id: aliasId,
            file,
            name: imp.local,
            kind: "import",
          });
        if (targetMod) {
          let exp = targetMod.exports.find((e) => e.type === "local" && e.exportedAs === imp.imported);
          if (!exp) {
            // fallback: match local by name
            const loc = targetMod.locals.find((l) => l.localName === imp.imported);
            if (loc)
              exp = {
                type: "local",
                exportedAs: imp.imported,
                target: loc,
              };
          }
          if (exp && exp.type === "local") {
            const def = exp.target;
            const toId = defNodeId(def);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(def));
            addEdge(aliasId, toId, imp.imported);
          }
        }
      } else if (imp.kind === "default") {
        const aliasId = `${file}::${imp.local}::import`;
        if (!nodes.has(aliasId))
          nodes.set(aliasId, {
            id: aliasId,
            file,
            name: imp.local,
            kind: "import",
          });
        if (targetMod) {
          // try explicit default export; else fall back to a single export
          let exp = targetMod.exports.find((e) => e.type === "local" && e.exportedAs === "default");
          if (!exp) exp = targetMod.exports.find((e) => e.type === "local");
          if (exp && exp.type === "local") {
            const def = exp.target;
            const toId = defNodeId(def);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(def));
            addEdge(aliasId, toId, "default");
          }
        }
      } else if (imp.kind === "namespace") {
        const aliasId = `${file}::${imp.localNS}::import`;
        if (!nodes.has(aliasId))
          nodes.set(aliasId, {
            id: aliasId,
            file,
            name: imp.localNS,
            kind: "namespaceImport",
          });
        if (targetMod) {
          const exportedLocals = targetMod.exports.filter((e) => e.type === "local");
          for (const e of exportedLocals) {
            const def = e.target;
            const toId = defNodeId(def);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(def));
            addEdge(aliasId, toId, e.exportedAs);
          }
        }
      }
    }
  }

  return { nodes, edges };
}

export async function buildSymbolGraphDetailed(
  index: ProjectIndex,
  opts?: {
    scope?: "all" | "imported";
    files?: Set<FileId>;
    maxEdges?: number;
    membersOnly?: boolean;
    logLevel?: LogLevel;
  },
): Promise<SymbolGraph> {
  const base = await buildSymbolGraph(index);
  const nodes = new Map(base.nodes);
  const edges = base.edges.slice();
  let skippedSyntaxTreeFiles = 0;

  const added = new Set<string>();
  const maxEdges = typeof opts?.maxEdges === "number" && opts.maxEdges > 0 ? opts.maxEdges : Number.POSITIVE_INFINITY;
  const membersOnly = !!opts?.membersOnly;
  const scopeMode = opts?.scope ?? "all";

  const normalizePath = (p: string) => p.replace(/\\/g, "/");
  const importedByOthers = new Set<string>();
  if (scopeMode === "imported") {
    for (const [, m] of index.byFile) {
      for (const imp of m.imports) {
        const target = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
        if (target) importedByOthers.add(target);
      }
    }
  }

  let edgeCount = edges.length;
  const maybePushEdge = (fromId: string, toId: string, label?: string) => {
    if (edgeCount >= maxEdges) return false;
    edges.push(label ? { from: fromId, to: toId, label } : { from: fromId, to: toId });
    edgeCount++;
    return true;
  };
  const recordEdge = (fromId: string, toId: string, label?: string) => {
    const key = `${fromId}->${toId}::${label ?? ""}`;
    if (added.has(key)) return true;
    added.add(key);
    return maybePushEdge(fromId, toId, label);
  };

  const isIdentifierType = (sup: LanguageSupport, t: string) =>
    Array.isArray(sup.nodeTypes?.identifier) && sup.nodeTypes.identifier.includes(t);

  type ResolvedDetailedExport = ResolvedExport;

  const normalizeModuleFile = (file: string) => file.replace(/\\/g, "/");

  const resolveExportNamespace = (
    file: string,
    exportedName: string,
    cache: Map<string, ResolvedDetailedExport | null> = new Map(),
  ): ResolvedDetailedExport | null => {
    const normalizedFile = normalizeModuleFile(file);
    const key = `${normalizedFile}::${exportedName}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    cache.set(key, null);
    const mod = index.byFile.get(normalizedFile);
    if (!mod) {
      return null;
    }

    for (const e of mod.exports)
      if (e.type === "local" && e.exportedAs === exportedName) {
        const res: ResolvedDetailedExport = { kind: "resolved", def: e.target };
        cache.set(key, res);
        return res;
      }

    for (const e of mod.exports)
      if (e.type === "namespaceReexport" && e.exportedAs === exportedName) {
        const res: ResolvedDetailedExport = {
          kind: "namespace",
          file: normalizeModuleFile(e.fromModule),
        };
        cache.set(key, res);
        return res;
      }

    for (const e of mod.exports)
      if (e.type === "reexport" && e.exportedAs === exportedName && typeof e.fromModule === "string") {
        const down =
          resolveExportNamespace(e.fromModule, e.sourceSpecifier || exportedName, cache) ||
          resolveExportNamespace(e.fromModule, exportedName, cache);
        if (down) {
          cache.set(key, down);
          return down;
        }
      }

    for (const e of mod.exports)
      if (e.type === "exportStar" && typeof e.fromModule === "string") {
        const down = resolveExportNamespace(e.fromModule, exportedName, cache);
        if (down) {
          cache.set(key, down);
          return down;
        }
      }

    const local = mod.locals.find((l) => l.localName === exportedName);
    if (local) {
      const res: ResolvedDetailedExport = { kind: "resolved", def: local };
      cache.set(key, res);
      return res;
    }

    cache.set(key, null);
    return null;
  };

  const resolveExportDef = (
    file: string,
    exportedName: string,
    cache?: Map<string, ResolvedDetailedExport | null>,
  ): SymbolDef | null => {
    const resolved = resolveExportNamespace(file, exportedName, cache);
    return resolved?.kind === "resolved" ? resolved.def : null;
  };

  const resolveMemberPathFromModule = (startFile: string, names: string[]): SymbolDef | null => {
    let file: string | null = normalizeModuleFile(startFile);
    let targetDef: SymbolDef | null = null;
    for (const seg of [...names].reverse()) {
      if (!file) break;
      const resolved = resolveExportNamespace(file, seg);
      if (!resolved) {
        targetDef = null;
        break;
      }
      if (resolved.kind === "namespace") {
        file = normalizeModuleFile(resolved.file);
        targetDef = null;
        continue;
      }
      targetDef = resolved.def;
      file = normalizeModuleFile(targetDef.file);
    }

    if (targetDef) {
      return targetDef;
    }

    const fileKey = typeof file === "string" ? normalizeModuleFile(file) : null;
    const mod = fileKey ? index.byFile.get(fileKey) : undefined;
    const last = names[0];
    return mod?.locals.find((l) => l.localName === last) ?? null;
  };

  // Resolve an exported symbol definition from a module file, following re-exports recursively
  const resolveExportFrom = (
    file: string,
    exportedName: string,
    cache: Map<string, ResolvedDetailedExport | null> = new Map(),
  ): SymbolDef | null => resolveExportDef(file, exportedName, cache);

  for (const [file, mod] of index.byFile) {
    if (opts?.files && !opts.files.has(file)) continue;
    if (scopeMode === "imported") {
      const hasFuncOrClass = mod.locals.some((l) => l.kind === SymbolKind.Function || l.kind === SymbolKind.Class);
      const isImportedOrImports = importedByOthers.has(normalizePath(file)) || mod.imports.length > 0;
      if (!(hasFuncOrClass && isImportedOrImports)) continue;
    }
    try {
      const parsedEntry = index.parsed?.get(file);
      let sup = parsedEntry?.sup;
      let lang = parsedEntry?.lang;
      let src = parsedEntry?.source;
      let tree: SyntaxTreeLike | undefined = parsedEntry?.tree;
      if (!sup || src === undefined) {
        const prep = await prepareSourceInput(file);
        sup = prep.sup;
        src = prep.source;
      }
      if (sup && !sup.supportsCrossModuleSymbols) {
        continue;
      }
      if (sup && src !== undefined && !tree) {
        const nativeTreeExecution = getNativeSyntaxTreeExecution(src, sup, index.nativeMode);
        if (nativeTreeExecution.tree) {
          tree = new ProjectedSyntaxTree(src, nativeTreeExecution.tree);
        } else {
          if (!isJsFallbackAvailable()) {
            skippedSyntaxTreeFiles += 1;
            continue;
          }
          lang ??= sup.language(file);
          tree = parseWithJsLanguage(src, lang);
        }
      }
      if (!sup || src === undefined || !tree) {
        throw new Error(`Failed to parse ${file}`);
      }

      // Build mapping from imported local alias -> target def (best-effort)
      const aliasToTargetDef = new Map<string, SymbolDef>();
      // And for namespace imports: alias -> target module file path (string)
      const aliasToTargetModule = new Map<string, string>();
      const targetModOf = (imp: ImportBinding) => {
        const targetFile = typeof imp.resolved === "string" ? imp.resolved.replace(/\\/g, "/") : undefined;
        return targetFile ? index.byFile.get(targetFile) : undefined;
      };
      for (const imp of mod.imports) {
        if (!imp) continue;
        const tmod = targetModOf(imp);
        const targetFile = typeof imp.resolved === "string" ? imp.resolved.replace(/\\/g, "/") : undefined;
        if (!tmod || !targetFile) continue;
        if (imp.kind === "named") {
          const resolved =
            resolveExportNamespace(targetFile, imp.imported) ??
            (tmod.locals.find((l) => l.localName === imp.imported)
              ? {
                  kind: "resolved",
                  def: tmod.locals.find((l) => l.localName === imp.imported)!,
                }
              : null);
          if (resolved?.kind === "resolved") {
            aliasToTargetDef.set(imp.local, resolved.def);
          } else if (resolved?.kind === "namespace") {
            aliasToTargetModule.set(imp.local, normalizeModuleFile(resolved.file));
          }
        } else if (imp.kind === "default") {
          const def = resolveExportFrom(targetFile, "default") || tmod.exports.find((e) => e.type === "local")?.target;
          if (def) aliasToTargetDef.set(imp.local, def);
          // Also treat default imports as potential namespace holders for member usage (u.helper())
          aliasToTargetModule.set(imp.local, targetFile);
        } else if (imp.kind === "namespace") {
          aliasToTargetModule.set(imp.localNS, targetFile);
        }
      }

      // Collect function-like declarations.
      // JS/TS: function_declaration, arrow/function expressions bound to vars.
      // Python: function_definition.
      const functionNodes: Array<{
        name: string;
        node: SyntaxNodeLike;
        def: SymbolDef;
      }> = [];
      const classNodes: Array<{
        name: string;
        node: SyntaxNodeLike;
        def: SymbolDef;
      }> = [];
      // Collect simple constant string bindings for resolving computed member keys, e.g., const k = "x"; obj[k]
      const constStringOf = new Map<string, string>();
      const collectConsts = (n: SyntaxNodeLike) => {
        if (n.type === "variable_declarator") {
          const nameNode = n.childForFieldName("name");
          const valueNode = n.childForFieldName("value");
          if (nameNode && valueNode && valueNode.type === "string") {
            const name = sliceText(nameNode, src);
            const val = unquote(sliceText(valueNode, src));
            constStringOf.set(name, val);
          }
        }
        for (const ch of n.namedChildren) collectConsts(ch);
      };
      collectConsts(tree.rootNode);

      // Node type helpers (must be initialized before any walkers that reference them)
      const memberExpressionType = sup.nodeTypes.memberExpression ?? "member_expression";
      const propertyIdentifierTypes: string[] = sup.nodeTypes.propertyIdentifier ?? ["property_identifier"];
      const optionalMemberTypes = new Set<string>([
        memberExpressionType,
        "optional_member_expression",
        "subscript_expression",
        "optional_chain",
        sup.id === "python" ? "attribute" : "",
      ]);
      const walkCollect = (n: SyntaxNodeLike) => {
        if (
          n.type === "function_declaration" ||
          n.type === "function_definition" ||
          n.type === "method_declaration" ||
          n.type === "constructor_declaration" ||
          n.type === "function_item" ||
          n.type === "method" ||
          n.type === "singleton_method"
        ) {
          const nameNode = n.childForFieldName("name") ?? n.childForFieldName("type");
          const name = nameNode ? sliceText(nameNode, src) : undefined;
          if (name) {
            const def = mod.locals.find((d) => d.localName === name);
            if (def) functionNodes.push({ name, node: n, def });
          }
        } else if (n.type === "class_declaration" || n.type === "class_definition" || n.type === "class") {
          const nameNode = n.childForFieldName("name");
          const name = nameNode ? sliceText(nameNode, src) : undefined;
          if (name) {
            const def = mod.locals.find((d) => d.localName === name);
            if (def) classNodes.push({ name, node: n, def });
          }
        } else if (n.type === "variable_declarator") {
          const nameNode = n.childForFieldName("name");
          const valueNode = n.childForFieldName("value");
          if (nameNode && valueNode) {
            const vt = String(valueNode.type || "");
            if (/arrow_function|function/.test(vt)) {
              const name = sliceText(nameNode, src);
              const def = mod.locals.find((d) => d.localName === name);
              if (def) functionNodes.push({ name, node: valueNode, def });
            }
          }
        } else if (n.type === "assignment_expression") {
          const left = n.childForFieldName("left");
          const right = n.childForFieldName("right");
          if (left && right) {
            const vt = String(right.type || "");
            if (/arrow_function|function/.test(vt)) {
              let name: string | null = null;
              if (left.type === memberExpressionType) {
                const prop = left.child(2);
                if (prop && propertyIdentifierTypes.includes(prop.type)) name = sliceText(prop, src);
              } else if (left.type === "identifier") {
                name = sliceText(left, src);
              }
              if (name) {
                const def = mod.locals.find((d) => d.localName === name);
                if (def) functionNodes.push({ name, node: right, def });
              }
            }
          }
        }
        for (const ch of n.namedChildren) walkCollect(ch);
      };
      walkCollect(tree.rootNode);

      // For each function, look for identifier occurrences of imported aliases in its subtree
      const scanForAliasUse = (node: SyntaxNodeLike, cb: (name: string, atNode: SyntaxNodeLike) => void) => {
        if (isIdentifierType(sup, node.type)) {
          const name = sliceText(node, src);
          cb(name, node);
        }
        for (const ch of node.namedChildren) scanForAliasUse(ch, cb);
      };

      const resolveIdentifier = (name: string): SymbolDef | null => {
        const fromAlias = aliasToTargetDef.get(name);
        if (fromAlias) return fromAlias;
        return mod.locals.find((d) => d.localName === name) ?? null;
      };

      const tryResolveNode = (node: SyntaxNodeLike, fromId: string, label: string) => {
        if (isIdentifierType(sup, node.type) || node.type === "type_identifier") {
          const name = sliceText(node, src);
          const target = resolveIdentifier(name);
          if (target) {
            const toId = defNodeId(target);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
            recordEdge(fromId, toId, label);
            return;
          }
        }
        if (optionalMemberTypes.has(node.type)) {
          tryResolveChain(node, fromId, label);
        }
      };

      const callNodeTypes = new Set<string>(["call_expression", "call", "method_invocation", "invocation_expression"]);
      const newNodeTypes = new Set<string>([
        "new_expression",
        "object_creation_expression",
        "struct_expression",
        "composite_literal",
      ]);

      const getCallTarget = (n: SyntaxNodeLike): SyntaxNodeLike | null => {
        const explicitTarget =
          n.childForFieldName("function") ??
          n.childForFieldName("callee") ??
          n.childForFieldName("name") ??
          n.childForFieldName("method") ??
          n.childForFieldName("member") ??
          n.childForFieldName("expression");
        if (explicitTarget) return explicitTarget;
        const nonArgumentChildren = n.namedChildren.filter((ch) => ch.type !== "argument_list");
        return nonArgumentChildren.length === 1 ? (nonArgumentChildren[0] ?? null) : null;
      };

      const getNewTarget = (n: SyntaxNodeLike) =>
        n.childForFieldName("constructor") ??
        n.childForFieldName("type") ??
        n.childForFieldName("name") ??
        n.namedChildren.find((ch) => ch.type === "type_identifier") ??
        n.child(0);

      const tryResolveChain = (node: SyntaxNodeLike, fromId?: string, label = "uses") => {
        const names: string[] = [];
        let cur: SyntaxNodeLike | null = node;
        let base: SyntaxNodeLike | null = null;
        const pushProp = (p: SyntaxNodeLike | null) => {
          if (!p) return;
          if (propertyIdentifierTypes.includes(p.type)) names.push(sliceText(p, src));
          else if (p.type === "string") names.push(unquote(sliceText(p, src)));
          else if (p.type === "identifier") {
            const keyName = sliceText(p, src);
            const v = constStringOf.get(keyName);
            if (typeof v === "string") names.push(v);
          }
        };
        while (cur && optionalMemberTypes.has(cur.type)) {
          if (cur.type === "subscript_expression") {
            base = cur.child(0) ?? base;
            const idx = cur.child(2);
            pushProp(idx);
            cur = base;
          } else if (
            cur.type === memberExpressionType ||
            cur.type === "optional_member_expression" ||
            cur.type === "attribute"
          ) {
            base = cur.child(0) ?? base;
            const prop = cur.childForFieldName?.("property") ?? cur.child(2) ?? cur.childForFieldName?.("attribute");
            pushProp(prop);
            cur = base;
          } else if (cur.type === "optional_chain") {
            cur = cur.child(0);
          } else {
            break;
          }
        }
        if (!cur || !isIdentifierType(sup, cur.type)) return false;
        const alias = sliceText(cur, src);
        const targetFile = aliasToTargetModule.get(alias);
        if (!targetFile || names.length === 0) return false;
        const targetDef = resolveMemberPathFromModule(targetFile, names);
        if (targetDef && fromId) {
          const toId = defNodeId(targetDef);
          if (!nodes.has(toId)) nodes.set(toId, nodeForDef(targetDef));
          if (!recordEdge(fromId, toId, label)) return true;
          return true;
        }
        return !!targetDef;
      };

      // Collect Python decorators on functions and add uses edges
      if (sup.id === "python") {
        const addDecoratorUses = (n: SyntaxNodeLike) => {
          if (n.type === "decorated_definition") {
            const fn = n.namedChildren.find((child) => child.type === "function_definition");
            if (fn) addDecoratorUses(fn);
            for (const d of n.namedChildren) {
              if (d.type !== "decorator") continue;
              const nameNode = fn?.childForFieldName("name");
              if (!nameNode) continue;
              const name = sliceText(nameNode, src);
              const def = mod.locals.find((l) => l.localName === name);
              if (!def) continue;
              const fromId = defNodeId(def);
              if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(def));
              const expr = d.childForFieldName?.("name") ?? d.namedChildren?.[0] ?? d.child(1);
              if (expr) tryResolveNode(expr, fromId, "decorates");
            }
          } else if (n.type === "function_definition") {
            const nameNode = n.childForFieldName("name");
            if (nameNode) {
              const name = sliceText(nameNode, src);
              const def = mod.locals.find((d) => d.localName === name);
              if (def) {
                const fromId = defNodeId(def);
                if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(def));
                // Python decorators appear before the function; walk preceding siblings to find attributes
                let prev = n.previousSibling;
                while (prev) {
                  if (prev.type === "decorated_definition") {
                    for (const d of prev.namedChildren) {
                      if (d.type === "decorator") {
                        const expr = d.childForFieldName?.("name") ?? d.namedChildren?.[0] ?? d.child(1);
                        if (expr) tryResolveNode(expr, fromId, "decorates");
                      } else if (d.type === "attribute") {
                        tryResolveNode(d, fromId, "decorates");
                      }
                    }
                  } else if (prev.type === "decorator") {
                    const expr = prev.childForFieldName?.("name") ?? prev.namedChildren?.[0] ?? prev.child(1);
                    if (expr) tryResolveNode(expr, fromId, "decorates");
                  }
                  prev = prev.previousSibling;
                }
              }
            }
          }
          for (const ch of n.namedChildren) addDecoratorUses(ch);
        };
        addDecoratorUses(tree.rootNode);
      }

      for (const fn of functionNodes) {
        const fromId = defNodeId(fn.def);
        if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(fn.def));
        const seenAliases = new Set<string>();
        if (!membersOnly)
          scanForAliasUse(fn.node, (name: string, atNode: SyntaxNodeLike) => {
            if (seenAliases.has(name)) return;
            let target: SymbolDef | null = aliasToTargetDef.get(name) ?? null;
            if (!target) {
              const modFile = aliasToTargetModule.get(name);
              if (modFile) {
                // If used as a member (u.helper), prefer that member name
                let exportedName: string | null = null;
                const p = atNode.parent;
                if (p && (p.type === memberExpressionType || p.type === "optional_member_expression")) {
                  const prop = p.childForFieldName?.("property") ?? p.child(2);
                  if (prop && propertyIdentifierTypes.includes(prop.type)) exportedName = sliceText(prop, src);
                }
                if (exportedName) {
                  target = resolveExportFrom(modFile, exportedName);
                  if (!target) {
                    const m = index.byFile.get(modFile);
                    target = (m?.locals ?? []).find((l: SymbolDef) => l.localName === exportedName) ?? null;
                  }
                }
                // Do not fall back to default or arbitrary first local to avoid spurious edges
              }
            }
            if (!target) return;
            seenAliases.add(name);
            const toId = defNodeId(target);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
            if (!recordEdge(fromId, toId, "uses")) return;
          });

        // Walk for member expressions of namespace imports: alias.member
        const walkForMembers = (n: SyntaxNodeLike) => {
          const tryResolveChainLocal = (node: SyntaxNodeLike) => {
            const names: string[] = [];
            let cur: SyntaxNodeLike | null = node;
            let base: SyntaxNodeLike | null = null;
            const pushProp = (p: SyntaxNodeLike | null) => {
              if (!p) return;
              if (propertyIdentifierTypes.includes(p.type)) names.push(sliceText(p, src));
              else if (p.type === "string") names.push(unquote(sliceText(p, src)));
              else if (p.type === "identifier") {
                const keyName = sliceText(p, src);
                const v = constStringOf.get(keyName);
                if (typeof v === "string") names.push(v);
              }
            };
            while (cur && optionalMemberTypes.has(cur.type)) {
              if (cur.type === "subscript_expression") {
                base = cur.child(0) ?? base;
                const idx = cur.child(2);
                pushProp(idx);
                cur = base;
              } else if (
                cur.type === memberExpressionType ||
                cur.type === "optional_member_expression" ||
                cur.type === "attribute"
              ) {
                base = cur.child(0) ?? base;
                const prop =
                  cur.childForFieldName?.("property") ?? cur.child(2) ?? cur.childForFieldName?.("attribute");
                pushProp(prop);
                cur = base;
              } else if (cur.type === "optional_chain") {
                cur = cur.child(0);
              } else {
                break;
              }
            }
            if (!cur || !isIdentifierType(sup, cur.type)) return;
            const alias = sliceText(cur, src);
            const targetFile = aliasToTargetModule.get(alias);
            if (!targetFile || names.length === 0) return;
            const targetDef = resolveMemberPathFromModule(targetFile, names);
            if (targetDef) {
              const toId = defNodeId(targetDef);
              if (!nodes.has(toId)) nodes.set(toId, nodeForDef(targetDef));
              if (!recordEdge(fromId, toId, "uses")) return;
            }
          };

          if (optionalMemberTypes.has(n.type)) tryResolveChainLocal(n);
          for (const ch of n.namedChildren ?? []) walkForMembers(ch);
        };
        walkForMembers(fn.node);

        const walkForCalls = (n: SyntaxNodeLike) => {
          if (callNodeTypes.has(n.type)) {
            if (sup.id === "go") {
              const callTarget = getCallTarget(n);
              const calleeName =
                callTarget && isIdentifierType(sup, callTarget.type) ? sliceText(callTarget, src) : null;
              if (calleeName === "new" || calleeName === "make") {
                const argList = n.childForFieldName("arguments") ?? n.childForFieldName("argument_list");
                const typeNode = argList?.namedChildren?.find((child) => child.type === "type_identifier") ?? null;
                if (typeNode) {
                  tryResolveNode(typeNode, fromId, "instantiates");
                }
                return;
              }
            }
            if (sup.id === "ruby" && n.type === "call") {
              const methodNode = n.childForFieldName("method");
              const receiverNode = n.childForFieldName("receiver");
              const methodName = methodNode ? sliceText(methodNode, src) : null;
              if (methodName === "new" && receiverNode) {
                tryResolveNode(receiverNode, fromId, "instantiates");
                return;
              }
              if (methodNode) {
                tryResolveNode(methodNode, fromId, "calls");
                return;
              }
            }
            const callee = getCallTarget(n);
            if (callee) tryResolveNode(callee, fromId, "calls");
          }
          if (newNodeTypes.has(n.type)) {
            const target = getNewTarget(n);
            if (target) tryResolveNode(target, fromId, "instantiates");
          }
          for (const ch of n.namedChildren ?? []) walkForCalls(ch);
        };
        walkForCalls(fn.node);
      }

      const collectIdentifiers = (n: SyntaxNodeLike, out: string[]) => {
        if (isIdentifierType(sup, n.type) || n.type === "type_identifier") {
          out.push(sliceText(n, src));
        }
        for (const ch of n.namedChildren ?? []) collectIdentifiers(ch, out);
      };

      const findFirstNodeByType = (node: SyntaxNodeLike, type: string): SyntaxNodeLike | null => {
        for (const ch of node.namedChildren ?? []) {
          if (ch.type === type) return ch;
          const found = findFirstNodeByType(ch, type);
          if (found) return found;
        }
        return null;
      };

      const collectNodesByType = (node: SyntaxNodeLike, type: string, out: SyntaxNodeLike[]) => {
        for (const ch of node.namedChildren ?? []) {
          if (ch.type === type) out.push(ch);
          collectNodesByType(ch, type, out);
        }
      };

      for (const cls of classNodes) {
        const fromId = defNodeId(cls.def);
        if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(cls.def));
        if (sup.id === "java") {
          const superClass = findFirstNodeByType(cls.node, "superclass");
          const superNode = superClass?.childForFieldName("name") ?? superClass?.namedChildren?.[0] ?? null;
          if (superNode) tryResolveNode(superNode, fromId, "extends");

          const interfaces = findFirstNodeByType(cls.node, "super_interfaces");
          if (interfaces) {
            const names: string[] = [];
            collectIdentifiers(interfaces, names);
            for (const name of names) {
              const target = resolveIdentifier(name);
              if (!target) continue;
              const toId = defNodeId(target);
              if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
              recordEdge(fromId, toId, "implements");
            }
          }
          continue;
        }

        if (sup.id === "csharp") {
          const baseList = findFirstNodeByType(cls.node, "base_list");
          if (baseList) {
            const names: string[] = [];
            collectIdentifiers(baseList, names);
            names.forEach((name, idx) => {
              const target = resolveIdentifier(name);
              if (!target) return;
              const toId = defNodeId(target);
              if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
              recordEdge(fromId, toId, idx === 0 ? "extends" : "implements");
            });
          }
          continue;
        }

        const superClause = findFirstNodeByType(cls.node, "extends_clause");
        const superNode = superClause?.namedChildren?.[0] ?? superClause?.child(1);
        if (superNode) tryResolveNode(superNode, fromId, "extends");

        const implementsClauses: SyntaxNodeLike[] = [];
        collectNodesByType(cls.node, "implements_clause", implementsClauses);
        for (const clause of implementsClauses) {
          const names: string[] = [];
          collectIdentifiers(clause, names);
          for (const name of names) {
            const target = resolveIdentifier(name);
            if (!target) continue;
            const toId = defNodeId(target);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
            recordEdge(fromId, toId, "implements");
          }
        }
      }

      if (sup.id === "rust") {
        const walkImpls = (node: SyntaxNodeLike) => {
          if (node.type === "impl_item") {
            const typeIdentifiers = node.namedChildren?.filter((child) => child.type === "type_identifier") ?? [];
            if (typeIdentifiers.length >= 2) {
              const traitName = sliceText(typeIdentifiers[0], src);
              const typeName = sliceText(typeIdentifiers[1], src);
              const typeDef = resolveIdentifier(typeName);
              const traitDef = resolveIdentifier(traitName);
              if (typeDef && traitDef) {
                const fromId = defNodeId(typeDef);
                const toId = defNodeId(traitDef);
                if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(typeDef));
                if (!nodes.has(toId)) nodes.set(toId, nodeForDef(traitDef));
                recordEdge(fromId, toId, "implements");
              }
            }
          }
          for (const ch of node.namedChildren ?? []) walkImpls(ch);
        };
        walkImpls(tree.rootNode);
      }
    } catch (error) {
      if (isUnsupportedParserInputError(error)) {
        continue;
      }
      logWithLevel(opts?.logLevel, "warn", `Warning: Failed to build detailed symbol edges for ${file}:`, error);
    }
  }

  if (skippedSyntaxTreeFiles > 0) {
    logWithLevel(
      opts?.logLevel,
      "warn",
      `Warning: Skipped detailed symbol edges for ${skippedSyntaxTreeFiles} file(s) because no syntax-tree backend was available.`,
    );
  }

  return { nodes, edges };
}
