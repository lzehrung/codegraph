import path from "node:path";
import { type JsLanguage } from "./jsFallback.js";
import { prepareSourceInput } from "./languages/filePrep.js";
import { type LanguageSupport } from "./languages.js";
import type { Edge } from "./types.js";
import { loadNearestTsconfigFor } from "./util/resolution.js";
import { type WorkspaceConfig } from "./util/workspace.js";
import { extractJsTsDynamicSpecifiers } from "./util/specifiers.js";
import { logWithLevel, type LogLevel } from "./logging.js";
import {
  graphOnlyLanguageSupportsImportAliases,
  graphOnlySpecifierNeedsResolutionConfig,
  isGraphOnlyLanguage,
} from "./documentLinks.js";
import {
  getCompactImportsExecution,
  type NativeRuntimeMode,
  type CompactQueryResults,
  type NativeQueryResults,
} from "./native/treeSitterNative.js";
import { recordNativeExecutionOutcome } from "./native/nativeBackendReport.js";
import { collectModuleSpecifiersFromSource, type FallbackImportExtractionEvent } from "./graphs/specifiers.js";
import { collectPhpComposerImplicitEdges, resolveModuleSpecifierEdges } from "./graphs/edgeResolution.js";
import type { GraphCacheEntry } from "./graphs/types.js";
import type { BuildReport } from "./indexer/types.js";
import type { SyntaxTreeLike } from "./languages/types.js";
import { collectSqlEdgesForFile, type SqlFactCache } from "./sql/sourceGraph.js";

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
    sqlCorpusSig?: string;
    cachedFileEdges?: GraphCacheEntry;
    onFileEdges?: (file: string, entry: GraphCacheEntry) => void;
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
    report?: BuildReport;
    logLevel?: LogLevel;
    allFiles?: readonly string[];
    sqlFactCache?: SqlFactCache;
  },
): Promise<Edge[]> {
  const normalizedFile = file.replace(/\\/g, "/");
  const sigEntry = opts.fileSignature;
  const sig = sigEntry?.sig;
  const gitSig = sigEntry?.gitSig;
  const sqlFile = path.extname(normalizedFile).toLowerCase() === ".sql";

  const emitCacheEntry = (edges: Edge[]) => {
    if (!sig || !opts.onFileEdges) return;
    opts.onFileEdges(normalizedFile, {
      sig,
      ...(gitSig ? { gitSig } : {}),
      ...(sqlFile && opts.sqlCorpusSig ? { sqlCorpusSig: opts.sqlCorpusSig } : {}),
      edges: edges.map(cloneEdge),
    });
  };

  const sqlCacheIsValid = sqlFile && !!opts.sqlCorpusSig && opts.cachedFileEdges?.sqlCorpusSig === opts.sqlCorpusSig;
  const canReadCache = !sqlFile || sqlCacheIsValid;
  const cached = canReadCache && (sig || gitSig) ? opts.cachedFileEdges : undefined;
  const matchesGitSig = !!gitSig && !!cached?.gitSig && cached.gitSig === gitSig;
  const matchesSig = !!sig && !!cached && cached.sig === sig;

  if (cached && (matchesGitSig || matchesSig)) {
    const cloned = cached.edges.map(cloneEdge);
    emitCacheEntry(cloned);
    return cloned;
  }

  const parsed = opts.parsed;
  let sup = parsed?.sup;
  const lang = parsed?.lang;
  let src = parsed?.source;
  const nativeQueries = parsed?.nativeQueries ?? null;
  let compactNativeImports: CompactQueryResults | null = null;
  let graphOnlyLanguage = sup ? isGraphOnlyLanguage(sup.id) : false;
  if (!sup || src === undefined) {
    const prep = await prepareSourceInput(file);
    sup = prep.sup;
    src = prep.source;
    graphOnlyLanguage = isGraphOnlyLanguage(sup.id);
    const fastRegexDisabled = opts.fastRegexDisabledLanguages?.includes(sup.id);
    const shouldSkipNativeForFastGraph = !!opts.fast && (sup.id === "ts" || sup.id === "js") && !fastRegexDisabled;
    if (!graphOnlyLanguage && !shouldSkipNativeForFastGraph) {
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

  if (sup.id === "sql") {
    const allFiles = opts.allFiles ?? [normalizedFile];
    const sqlEdges = await collectSqlEdgesForFile(normalizedFile, allFiles, opts.sqlFactCache);
    emitCacheEntry(sqlEdges);
    return sqlEdges;
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
    if (dynamicSpecs.length) {
      const existing = new Set(specs.map((entry) => entry.spec));
      for (const entry of dynamicSpecs) {
        if (existing.has(entry.spec)) continue;
        existing.add(entry.spec);
        specs.push(entry);
      }
    }
  }

  const graphOnlyAliasLanguage = graphOnlyLanguage && graphOnlyLanguageSupportsImportAliases(sup.id);
  const needsGraphOnlyResolutionConfig =
    graphOnlyAliasLanguage && specs.some(({ spec }) => graphOnlySpecifierNeedsResolutionConfig(spec));
  const { matchPath } =
    sup.id === "ts" || sup.id === "tsx" || needsGraphOnlyResolutionConfig
      ? await loadNearestTsconfigFor(file, opts?.logLevel)
      : { matchPath: undefined };
  const edges: Edge[] = [];
  const edgeResolutionTasks = specs.map(async (entry) => {
    return await resolveModuleSpecifierEdges(entry, {
      support: sup,
      file,
      projectRoot,
      workspaceConfig,
      matchPath,
      resolveNodeModules: !!opts.resolveNodeModules,
      ...(opts.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
    });
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
    edges.push(...(await collectPhpComposerImplicitEdges({ projectRoot, file, normalizedFile, existingEdges: edges })));
  }
  emitCacheEntry(edges);
  return edges;
}
