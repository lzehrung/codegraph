import { prepareSourceInput, type PreparedSFCEmbeddedBlock } from "./languages/file-prep.js";
import { supportForFileWithoutHeaderSample, type LanguageExtensionMap, type LanguageSupport } from "./languages.js";
import type { Edge } from "./types.js";
import { loadNearestTsconfigFor } from "./util/resolution.js";
import type { WorkspaceConfig } from "./util/workspace.js";
import { extractDynamicImportSpecifiers, type ModuleSpecifier } from "./util/specifiers.js";
import { fileIdentityKey } from "./util/paths.js";
import { edgeKey } from "./util/graph-edges.js";
import type { LogLevel } from "./logging.js";
import {
  graphOnlyLanguageSupportsImportAliases,
  graphOnlySpecifierNeedsResolutionConfig,
  isGraphOnlyLanguage,
} from "./document-links.js";
import { getCompactImportsExecution } from "./native/tree-sitter-native.js";
import type { CompactQueryResults, NativeQueryResults } from "./native/tree-sitter-native.js";
import { recordNativeExecutionOutcome } from "./native/native-backend-report.js";
import { DEFAULT_NATIVE_SOURCE_MAX_BYTES } from "./worker/native-extract-worker.js";
import { collectModuleSpecifiersFromSource } from "./graphs/specifiers.js";
import { resolveModuleSpecifierEdges } from "./graphs/edge-resolution.js";
import type { GraphCacheEntry } from "./graphs/types.js";
import type { BuildReport } from "./indexer/types.js";
import type { SyntaxTreeLike } from "./languages/types.js";
import { collectSqlEdgesForFile } from "./sql/source-graph.js";
import type { SqlFactCache } from "./sql/source-graph.js";

const cloneEdge = (edge: Edge): Edge => ({
  ...edge,
  to: edge.to.type === "file" ? { type: "file", path: edge.to.path } : { type: "external", name: edge.to.name },
});

function appendMissingSpecifiers(target: ModuleSpecifier[], incoming: readonly ModuleSpecifier[]): void {
  if (!incoming.length) return;
  const existing = new Set(target.map((entry) => entry.spec));
  for (const entry of incoming) {
    if (existing.has(entry.spec)) continue;
    existing.add(entry.spec);
    target.push(entry);
  }
}

/**
 * Collapses duplicate edges.
 *
 * File-dependency edges identify on the resolved target: several import bindings that
 * resolve to one file express a single dependency, and counting them separately would
 * inflate fan-in, hotspots, and drift totals.
 *
 * C/C++ angle and quoted includes stay distinct even when they resolve to the same file:
 * their form controls whether an added header can satisfy them.
 *
 * SQL fact edges are the opposite. They deliberately reuse one file pair to express
 * distinct relationships (`sql:reads_from:...` vs `sql:writes_to:...`), so `raw` is part
 * of their identity and collapsing on it would discard real graph semantics.
 */
export function deduplicateEdges(edges: Edge[], rawIsIdentity = false): Edge[] {
  const deduplicated = new Map<string, Edge>();
  for (const edge of edges) {
    const key = edgeKey(edge, rawIsIdentity, fileIdentityKey);
    const previous = deduplicated.get(key);
    if (!previous || hasBetterProvenance(edge, previous)) deduplicated.set(key, edge);
  }
  return [...deduplicated.values()];
}

export function hasBetterProvenance(candidate: Edge, previous: Edge): boolean {
  let candidateResolutionRank = 0;
  if (candidate.resolved === "precise") candidateResolutionRank = 2;
  else if (candidate.resolved === "heuristic") candidateResolutionRank = 1;
  let previousResolutionRank = 0;
  if (previous.resolved === "precise") previousResolutionRank = 2;
  else if (previous.resolved === "heuristic") previousResolutionRank = 1;
  if (candidateResolutionRank !== previousResolutionRank) {
    return candidateResolutionRank > previousResolutionRank;
  }
  const candidateConfidence = candidate.confidence;
  const previousConfidence = previous.confidence;
  if (candidateConfidence === undefined || previousConfidence === undefined) {
    return candidateConfidence !== undefined && previousConfidence === undefined;
  }
  return candidateConfidence > previousConfidence;
}

export async function collectEdgesForFile(
  file: string,
  projectRoot: string,
  workspaceConfig: WorkspaceConfig | undefined,
  opts: {
    parsed?: {
      source: string;
      tree?: SyntaxTreeLike;
      sup: LanguageSupport;
      nativeQueries?: NativeQueryResults | null;
      embeddedBlocks?: PreparedSFCEmbeddedBlock[];
    };
    resolveNodeModules?: boolean;
    dynamicImportHeuristics?: boolean;
    resolutionHints?: string[];
    fileSignature?: { sig: string; gitSig?: string; cacheSig?: string };
    sqlCorpusSig?: string;
    cachedFileEdges?: GraphCacheEntry;
    /** Root stored with the manifest that supplied `cachedFileEdges`. */
    cachedFileEdgesProjectRoot?: string;
    languageExtensions?: LanguageExtensionMap;
    onFileEdges?: (file: string, entry: GraphCacheEntry) => void;
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
  const sqlFile = supportForFileWithoutHeaderSample(normalizedFile, opts.languageExtensions)?.id === "sql";
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
  const cacheRootMatchesProject =
    opts.cachedFileEdgesProjectRoot === undefined ||
    fileIdentityKey(opts.cachedFileEdgesProjectRoot) === fileIdentityKey(projectRoot);
  const canReadCache = !sqlFile || sqlCacheIsValid;
  const cached = canReadCache && cacheRootMatchesProject && (sig || gitSig) ? opts.cachedFileEdges : undefined;
  const matchesGitSig = !!gitSig && !!cached?.gitSig && cached.gitSig === gitSig;
  const matchesSig = !!sig && !!cached && cached.sig === sig;

  if (cached && (matchesGitSig || matchesSig)) {
    const cloned = deduplicateEdges(cached.edges.map(cloneEdge), sqlFile);
    emitCacheEntry(cloned);
    return cloned;
  }

  const parsed = opts.parsed;
  let sup = parsed?.sup;
  let src = parsed?.source;
  let embeddedBlocks = parsed?.embeddedBlocks ?? [];
  let compactNativeImports: CompactQueryResults | null = null;
  let graphOnlyLanguage = sup ? isGraphOnlyLanguage(sup.id) : false;
  if (!sup || src === undefined) {
    const prep = await prepareSourceInput(file, { languageExtensions: opts.languageExtensions });
    sup = prep.sup;
    src = prep.source;
    embeddedBlocks = prep.embeddedBlocks ?? [];
    graphOnlyLanguage = isGraphOnlyLanguage(sup.id);
  }
  if (!graphOnlyLanguage && Buffer.byteLength(src, "utf8") > DEFAULT_NATIVE_SOURCE_MAX_BYTES) {
    if (!parsed) {
      recordNativeExecutionOutcome(opts.report, {
        file: normalizedFile,
        support: sup,
        results: null,
        fallbackReason: "sourceTooLarge",
      });
    }
    emitCacheEntry([]);
    return [];
  }
  if (!parsed && !graphOnlyLanguage) {
    const compactExecution = getCompactImportsExecution(src, sup);
    compactNativeImports = compactExecution.results;
    recordNativeExecutionOutcome(opts.report, {
      file: normalizedFile,
      support: sup,
      results: compactExecution.results,
      ...(compactExecution.fallbackReason ? { fallbackReason: compactExecution.fallbackReason } : {}),
      ...(compactExecution.error ? { error: compactExecution.error } : {}),
    });
  }
  if (sup.id === "sql") {
    const allFiles = opts.allFiles ?? [normalizedFile];
    const sqlEdges = deduplicateEdges(
      await collectSqlEdgesForFile(normalizedFile, allFiles, opts.sqlFactCache, opts.languageExtensions),
      true,
    );
    emitCacheEntry(sqlEdges);
    return sqlEdges;
  }

  const specs = collectModuleSpecifiersFromSource(sup, src, {
    ...(parsed?.tree ? { tree: parsed.tree } : {}),
    ...(parsed && parsed.nativeQueries !== undefined ? { nativeQueries: parsed.nativeQueries } : {}),
    ...(!parsed && !graphOnlyLanguage ? { compactNativeImports } : {}),
    file: normalizedFile,
    ...(opts.logLevel ? { logLevel: opts.logLevel } : {}),
    ...(opts.report ? { report: opts.report } : {}),
  });

  if (opts.dynamicImportHeuristics) {
    appendMissingSpecifiers(specs, extractDynamicImportSpecifiers(sup.id, src, normalizedFile, projectRoot));
  }

  const specSources = specs.map((entry) => ({ entry, support: sup }));
  for (const block of embeddedBlocks) {
    const blockSpecs = collectModuleSpecifiersFromSource(block.sup, block.source, {
      file: normalizedFile,
      ...(opts.logLevel ? { logLevel: opts.logLevel } : {}),
      ...(opts.report ? { report: opts.report } : {}),
    });
    if (opts.dynamicImportHeuristics) {
      appendMissingSpecifiers(
        blockSpecs,
        extractDynamicImportSpecifiers(block.sup.id, block.source, normalizedFile, projectRoot),
      );
    }
    for (const entry of blockSpecs) {
      specSources.push({ entry, support: block.sup });
    }
  }

  const graphOnlyAliasLanguage = graphOnlyLanguage && graphOnlyLanguageSupportsImportAliases(sup.id);
  const needsGraphOnlyResolutionConfig =
    graphOnlyAliasLanguage && specSources.some(({ entry }) => graphOnlySpecifierNeedsResolutionConfig(entry.spec));
  const { matchPath } =
    sup.id === "ts" || sup.id === "tsx" || needsGraphOnlyResolutionConfig
      ? await loadNearestTsconfigFor(file, projectRoot, opts?.logLevel)
      : { matchPath: undefined };
  const edges: Edge[] = [];
  const edgeResolutionTasks = specSources.map(async ({ entry, support }) => {
    return await resolveModuleSpecifierEdges(entry, {
      support,
      file,
      projectRoot,
      workspaceConfig,
      matchPath,
      resolveNodeModules: !!opts.resolveNodeModules,
      ...(opts.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
      ...(opts.languageExtensions ? { languageExtensions: opts.languageExtensions } : {}),
    });
  });

  for (const resolvedEdge of await Promise.all(edgeResolutionTasks)) {
    if (!resolvedEdge) continue;
    for (const edgeEntry of resolvedEdge) {
      const { to, spec, raw, typeOnly, resolved, confidence, includeForm } = edgeEntry;
      edges.push({
        from: normalizedFile,
        to,
        raw: raw ?? spec,
        ...(typeOnly !== undefined && { typeOnly }),
        ...(resolved !== undefined && { resolved }),
        ...(confidence !== undefined && { confidence }),
        ...(includeForm ? { includeForm } : {}),
      });
    }
  }

  const deduplicatedEdges = deduplicateEdges(edges);
  emitCacheEntry(deduplicatedEdges);
  return deduplicatedEdges;
}
