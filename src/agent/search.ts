import fs from "node:fs/promises";
import { type AnalysisBackend, type AnalysisMode, type AnalysisSummary } from "../analysisSummary.js";
import { SymbolKind, type BuildOptions, type SymbolDef } from "../indexer/types.js";
import type { Range } from "../types.js";
import { type SymbolNode } from "../graphs/symbol-graph.js";
import { buildSymbolLookup, type SymbolLookup as SymbolDefLookup } from "./symbolLookup.js";
import {
  AGENT_SEARCH_EVIDENCE_PER_RESULT_LIMIT,
  AGENT_SEARCH_FOLLOWUPS_PER_RESULT_LIMIT,
  AGENT_SEARCH_FORMAT_REASON_LIMIT,
  AGENT_SEARCH_NEIGHBORS_PER_RESULT_LIMIT,
  AGENT_SEARCH_RANK_REASONS_PER_RESULT_LIMIT,
  AGENT_SEARCH_RESULT_LIMIT,
} from "../presentation/bounds.js";
import { normalizePath } from "../util/paths.js";
import { boundAgentList, defaultAgentLimit } from "./bounds.js";
import {
  formatAgentChunkHandle,
  formatAgentFileHandle,
  formatAgentGraphHandle,
  formatAgentSqlHandle,
  formatAgentSymbolHandle,
  parseAgentChunkHandle,
  parseAgentFileHandle,
  parseAgentGraphHandle,
  parseAgentSqlHandle,
  parseAgentSymbolHandle,
} from "./handles.js";
import {
  collectDefinitionFollowUps,
  collectFileFollowUps as collectCommonFileFollowUps,
  isAgentSqlObjectNode,
  normalizeAgentFilePath,
  resolveAgentSnapshotFile,
} from "./normalize.js";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "./session.js";
import { quoteShellArg } from "./shell.js";
import {
  buildQueryTextChunks,
  detectQueryIndexSurface,
  normalizeQuerySearchText,
  QUERY_INDEX_NORMALIZER_VERSION,
  type QueryTextChunk,
} from "./query-index/content.js";
import { findQueryIndexChunkCandidates, QUERY_INDEX_CANDIDATE_VERSION } from "./query-index/candidates.js";
import { registerSessionInvalidationHook } from "./sessionLifecycle.js";
import type { QueryIndexHandle } from "./query-index/update.js";

export type AgentSearchMode = "hybrid" | "symbol" | "path" | "text" | "graph" | "sql";

export type AgentSearchRequest = {
  root: string;
  query: string;
  mode?: AgentSearchMode;
  buildOptions?: BuildOptions;
  from?: string;
  depth?: number;
  limit?: number;
  includeSnippets?: boolean;
};

export type AgentSearchResultKind = "file" | "symbol" | "chunk" | "sql_object" | "graph_node";

export type AgentSearchEvidence = {
  source: "path" | "symbol" | "chunk" | "graph" | "sql";
  label: string;
  file?: string;
  line?: number;
  snippet?: string;
};

export type AgentSearchResult = {
  handle: string;
  kind: AgentSearchResultKind;
  label: string;
  file: string;
  range?: Range;
  score: number;
  provenance: {
    surface: "code" | "docs" | "config";
    capability: "semantic" | "graph" | "text";
    analysisMode: AnalysisMode;
    backend: AnalysisBackend;
    confidence: "high" | "medium";
  };
  rankReasons: string[];
  evidence: AgentSearchEvidence[];
  neighbors: Array<{ relation: string; target: string; file?: string }>;
  followUps: string[];
  omittedCounts: {
    rankReasons: number;
    evidence: number;
    neighbors: number;
    followUps: number;
  };
};

export type AgentSearchResponse = {
  schemaVersion: 1;
  query: string;
  mode: AgentSearchMode;
  root: string;
  analysis: AnalysisSummary;
  limits: {
    results: number;
    rankReasonsPerResult: number;
    evidencePerResult: number;
    neighborsPerResult: number;
    followUpsPerResult: number;
  };
  resultCount: number;
  totalCandidates: number;
  omittedCounts: {
    results: number;
  };
  results: AgentSearchResult[];
};

type MutableSearchResult = Omit<
  AgentSearchResult,
  "rankReasons" | "evidence" | "neighbors" | "followUps" | "omittedCounts"
> & {
  rankReasons: Set<string>;
  evidence: AgentSearchEvidence[];
  neighbors: Map<string, { relation: string; target: string; file?: string }>;
  followUps: Set<string>;
  matchedRankTerms: Set<string>;
};

type SymbolNeighbor = {
  key: string;
  relation: string;
  target: SymbolNode;
};

type FileNeighbor = {
  relation: "imports" | "imported_by";
  file: string;
};

type SearchResultBase = {
  handle: string;
  kind: AgentSearchResultKind;
  label: string;
  file: string;
  range?: Range;
  provenance: AgentSearchResult["provenance"];
};

type ReachableFile = {
  file: string;
  distance: number;
  relation: string;
};

type SearchQueryTerms = {
  tokens: string[];
  rankTokens: string[];
  normalizedRankPhrase: string;
  identifierLike: boolean;
};

type TokenMatch = {
  score: number;
  matched: string[];
  exactPhrase: boolean;
  proximity: boolean;
};

type SearchTextChunk = QueryTextChunk;

type SearchCache = {
  fileText: Map<string, Promise<string | null>>;
  normalizedText: Map<string, Promise<string | null>>;
  textChunks: Map<string, Promise<SearchTextChunk[]>>;
};

const DEFAULT_LIMIT = 20;
const MAX_TEXT_BYTES = 300_000;
const MAX_GRAPH_DEPTH = 5;
const DOCS_EXACT_PHRASE_BOOST = 18;
const DOCS_PROXIMITY_BOOST = 6;
const NATURAL_LANGUAGE_SYNTAX_TERMS = new Set([
  "a",
  "an",
  "are",
  "can",
  "did",
  "do",
  "does",
  "how",
  "is",
  "the",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
]);
const SEARCH_CACHES = new WeakMap<AgentProjectSnapshot, SearchCache>();
const SEARCH_RESULT_CACHES = new WeakMap<AgentSession, Map<string, Promise<AgentSearchResponse>>>();
const SEARCH_RANKING_VERSION = 2;

export async function searchCodegraph(request: AgentSearchRequest): Promise<AgentSearchResponse> {
  const session = createAgentSession({
    root: request.root,
    ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
  });
  try {
    return await searchCodegraphWithSession(session, request);
  } finally {
    session.invalidate();
  }
}

export async function searchCodegraphWithSession(
  session: AgentSession,
  request: AgentSearchRequest,
): Promise<AgentSearchResponse> {
  if (canUsePathFastPath(request) && session.listFiles && session.root) {
    const files = await session.listFiles();
    return searchPathOnly(session.root, files, request);
  }

  const snapshot = await session.loadProject({
    // Hybrid/symbol/graph need symbol nodes, but not the detailed sidecar.
    symbolGraph: searchNeedsSymbolGraph(request) ? "basic" : "skip",
  });
  const resultCache = getSessionSearchResultCache(session);
  const cacheKey = searchResultCacheKey(snapshot, request);
  const existing = resultCache.get(cacheKey);
  if (existing) return await existing;
  const mode = request.mode ?? "hybrid";
  let queryIndex: QueryIndexHandle | undefined;
  if (mode === "hybrid" || mode === "text") {
    const { ensureSessionQueryIndex } = await import("./query-index/sessionStore.js");
    queryIndex = await ensureSessionQueryIndex(session, snapshot);
  }
  const search = searchSnapshot(snapshot, request, queryIndex);
  resultCache.set(cacheKey, search);
  search.catch(() => {
    if (resultCache.get(cacheKey) === search) resultCache.delete(cacheKey);
  });
  return await search;
}

export function formatAgentSearchResponse(response: AgentSearchResponse): string {
  if (!response.results.length) {
    return `No matches for "${response.query}"\nAnalysis: ${response.analysis.label}`;
  }
  const lines = [`Analysis: ${response.analysis.label}`];
  for (const [index, result] of response.results.entries()) {
    const location = result.range
      ? `${result.file}:${result.range.start.line}:${result.range.start.column}`
      : result.file;
    const reasons = result.rankReasons.slice(0, AGENT_SEARCH_FORMAT_REASON_LIMIT).join("; ");
    lines.push(
      `${index + 1}. ${result.label} [${result.kind}] ${location} score=${result.score} (${result.provenance.surface}, ${result.provenance.capability})`,
    );
    lines.push(`   ${reasons}`);
  }
  return lines.join("\n");
}

async function searchSnapshot(
  snapshot: AgentProjectSnapshot,
  request: AgentSearchRequest,
  queryIndex?: QueryIndexHandle,
): Promise<AgentSearchResponse> {
  const mode = request.mode ?? "hybrid";
  const query = buildQueryTerms(request.query);
  const resultMap = new Map<string, MutableSearchResult>();
  const limit = defaultAgentLimit(request.limit, DEFAULT_LIMIT, AGENT_SEARCH_RESULT_LIMIT);
  let fileNeighborIndex: Map<string, FileNeighbor[]> | undefined;
  const getFileNeighborIndex = (): Map<string, FileNeighbor[]> => {
    fileNeighborIndex ??= buildFileNeighborIndex(snapshot);
    return fileNeighborIndex;
  };

  if (query.rankTokens.length) {
    if (mode === "sql") {
      addSqlResults(snapshot, resultMap, getFileNeighborIndex(), query);
    } else if (mode === "hybrid" || mode === "symbol" || mode === "graph") {
      const symbolLookup = buildSymbolLookup(snapshot);
      addSymbolResults(snapshot, resultMap, symbolLookup, buildSymbolNeighborIndex(snapshot), query, mode);
    }
    if (mode === "hybrid" || mode === "path" || mode === "graph") {
      addPathResults(snapshot, resultMap, getFileNeighborIndex(), query);
    }
    if (mode === "hybrid" || mode === "text") {
      await addTextResults(snapshot, resultMap, query, request.includeSnippets ?? true, mode, queryIndex);
    }
  }

  if (request.from !== undefined && (mode === "hybrid" || mode === "graph")) {
    applyGraphNeighborhood(
      snapshot,
      resultMap,
      getFileNeighborIndex(),
      query,
      request.from,
      normalizeDepth(request.depth),
    );
  }

  const selectedResults = selectTopResults(resultMap, limit);
  const results = selectedResults.items.map(finalizeResult);

  return {
    schemaVersion: 1,
    query: request.query,
    mode,
    root: snapshot.root,
    analysis: snapshot.analysis,
    limits: {
      results: limit,
      rankReasonsPerResult: AGENT_SEARCH_RANK_REASONS_PER_RESULT_LIMIT,
      evidencePerResult: AGENT_SEARCH_EVIDENCE_PER_RESULT_LIMIT,
      neighborsPerResult: AGENT_SEARCH_NEIGHBORS_PER_RESULT_LIMIT,
      followUpsPerResult: AGENT_SEARCH_FOLLOWUPS_PER_RESULT_LIMIT,
    },
    resultCount: results.length,
    totalCandidates: selectedResults.totalCandidates,
    omittedCounts: {
      results: selectedResults.omitted,
    },
    results,
  };
}

function canUsePathFastPath(request: AgentSearchRequest): boolean {
  return (request.mode ?? "hybrid") === "path" && request.from === undefined;
}

function getSessionSearchResultCache(session: AgentSession): Map<string, Promise<AgentSearchResponse>> {
  const existing = SEARCH_RESULT_CACHES.get(session);
  if (existing) return existing;
  const created = new Map<string, Promise<AgentSearchResponse>>();
  SEARCH_RESULT_CACHES.set(session, created);
  registerSessionInvalidationHook(session, () => SEARCH_RESULT_CACHES.delete(session));
  return created;
}

function searchResultCacheKey(snapshot: AgentProjectSnapshot, request: AgentSearchRequest): string {
  return JSON.stringify({
    projectSnapshotIdentity: snapshot.index.projectSnapshotIdentity ?? "",
    query: normalizeQuerySearchText(request.query),
    mode: request.mode ?? "hybrid",
    limit: defaultAgentLimit(request.limit, DEFAULT_LIMIT, AGENT_SEARCH_RESULT_LIMIT),
    depth: normalizeDepth(request.depth),
    from: request.from ?? "",
    includeSnippets: request.includeSnippets ?? true,
    normalizerVersion: QUERY_INDEX_NORMALIZER_VERSION,
    rankingVersion: SEARCH_RANKING_VERSION,
    candidateVersion: QUERY_INDEX_CANDIDATE_VERSION,
  });
}
function searchPathOnly(root: string, files: readonly string[], request: AgentSearchRequest): AgentSearchResponse {
  const query = buildQueryTerms(request.query);
  const resultMap = new Map<string, MutableSearchResult>();
  const limit = defaultAgentLimit(request.limit, DEFAULT_LIMIT, AGENT_SEARCH_RESULT_LIMIT);

  if (query.tokens.length) {
    for (const file of files) {
      const relFile = normalizeAgentFilePath(root, file);
      const pathMatch = matchTokenScore(relFile, query);
      if (pathMatch.score <= 0) continue;

      const result = upsertResult(resultMap, {
        handle: formatAgentFileHandle({ file: relFile }),
        kind: "file",
        label: relFile,
        file: relFile,
        provenance: createSearchProvenance(relFile, "text", "high", {
          mode: "reduced",
          backend: "unknown",
        }),
      });
      result.score += pathMatch.score * 2;
      addMatchedRankTerms(result, pathMatch);
      addReason(result, `path token match: ${pathMatch.matched.join(", ")}`);
      addEvidence(result, { source: "path", label: relFile, file: relFile });
      addFileFollowUps(result, relFile);
    }
  }

  const selectedResults = selectTopResults(resultMap, limit);
  const results = selectedResults.items.map(finalizeResult);

  return {
    schemaVersion: 1,
    query: request.query,
    mode: "path",
    root,
    analysis: {
      mode: "reduced",
      backend: "unknown",
      parserDegradedFiles: 0,
      fallbackImportExtractionFiles: 0,
      nativeFilesUsed: 0,
      nativeFilesFellBack: 0,
      label: "path-only",
    },
    limits: {
      results: limit,
      rankReasonsPerResult: AGENT_SEARCH_RANK_REASONS_PER_RESULT_LIMIT,
      evidencePerResult: AGENT_SEARCH_EVIDENCE_PER_RESULT_LIMIT,
      neighborsPerResult: AGENT_SEARCH_NEIGHBORS_PER_RESULT_LIMIT,
      followUpsPerResult: AGENT_SEARCH_FOLLOWUPS_PER_RESULT_LIMIT,
    },
    resultCount: results.length,
    totalCandidates: selectedResults.totalCandidates,
    omittedCounts: {
      results: selectedResults.omitted,
    },
    results,
  };
}

function normalizeDepth(depth: number | undefined): number {
  if (typeof depth !== "number" || !Number.isFinite(depth)) return 1;
  return Math.min(MAX_GRAPH_DEPTH, Math.max(0, Math.floor(depth)));
}

function searchNeedsSymbolGraph(request: AgentSearchRequest): boolean {
  const mode = request.mode ?? "hybrid";
  return mode !== "path" && mode !== "text" && mode !== "sql";
}

function buildQueryTerms(input: string): SearchQueryTerms {
  const normalized = normalizeSearchText(input);
  const tokenSequence = normalized.split(/\s+/).filter((token) => token.length);
  const tokens = Array.from(new Set(tokenSequence));
  const identifierLike = isIdentifierLikeQuery(input);
  const pathLike = isExplicitPathQuery(input);
  const filterNaturalLanguageSyntax = !identifierLike && !pathLike;
  const filteredRankTokenSequence = filterNaturalLanguageSyntax
    ? tokenSequence.filter((token) => !NATURAL_LANGUAGE_SYNTAX_TERMS.has(token))
    : tokenSequence;
  const rankTokenSequence = filteredRankTokenSequence.length ? filteredRankTokenSequence : tokenSequence;
  return {
    tokens,
    rankTokens: Array.from(new Set(rankTokenSequence)),
    normalizedRankPhrase: rankTokenSequence.join(" "),
    identifierLike,
  };
}

function isExplicitPathQuery(input: string): boolean {
  const trimmed = input.trim();
  const slashIndex = trimmed.search(/[\\/]/);
  if (slashIndex < 0 || /\s/.test(trimmed.slice(0, slashIndex))) return false;
  return !/\s/.test(trimmed) || /\.[A-Za-z0-9]+$/.test(trimmed);
}

function normalizeSearchText(input: string): string {
  return normalizeQuerySearchText(input);
}

function isIdentifierLikeQuery(input: string): boolean {
  const trimmed = input.trim();
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.#:][A-Za-z_$][A-Za-z0-9_$]*)*$/.test(trimmed);
}

function emptyTokenMatch(): TokenMatch {
  return { score: 0, matched: [], exactPhrase: false, proximity: false };
}

function matchTokenScore(text: string, query: SearchQueryTerms): TokenMatch {
  const normalized = normalizeSearchText(text);
  return matchTokenScoreFromNormalized(normalized, query);
}

function matchTokenScoreFromNormalized(normalized: string, query: SearchQueryTerms): TokenMatch {
  if (!normalized) return emptyTokenMatch();
  const words = new Set(normalized.split(/\s+/).filter(Boolean));
  const compact = normalized.replace(/\s+/g, "");
  const matched: string[] = [];
  let score = 0;

  for (const token of query.rankTokens) {
    if (words.has(token)) {
      score += 10;
      matched.push(token);
    } else if (compact.includes(token)) {
      score += 7;
      matched.push(token);
    } else if (normalized.includes(token)) {
      score += 4;
      matched.push(token);
    }
  }

  let exactPhrase = false;
  let proximity = false;
  if (matched.length === query.rankTokens.length && query.rankTokens.length > 1) {
    score += 12;
    if (normalized.includes(query.normalizedRankPhrase)) {
      score += 30;
      exactPhrase = true;
    } else if (tokensAppearInOrder(normalized, query.rankTokens)) {
      score += 10;
      proximity = true;
    }
  }

  return { score, matched, exactPhrase, proximity };
}

function tokensAppearInOrder(normalizedText: string, tokens: readonly string[]): boolean {
  let fromIndex = 0;
  for (const token of tokens) {
    const tokenIndex = normalizedText.indexOf(token, fromIndex);
    if (tokenIndex < 0) return false;
    fromIndex = tokenIndex + token.length;
  }
  return true;
}

function addSymbolResults(
  snapshot: AgentProjectSnapshot,
  resultMap: Map<string, MutableSearchResult>,
  lookup: SymbolDefLookup,
  neighborsBySymbolId: Map<string, SymbolNeighbor[]>,
  query: SearchQueryTerms,
  mode: AgentSearchMode,
): void {
  for (const node of snapshot.symbolGraph.nodes.values()) {
    const sqlObject = isAgentSqlObjectNode(node);
    if (mode === "sql" && !sqlObject) continue;
    if (mode === "symbol" && sqlObject) continue;

    const nameMatch = matchTokenScore(node.name, query);
    const fileMatch = matchTokenScore(normalizeAgentFilePath(snapshot.root, node.file), query);
    const docMatch = node.docstring ? matchTokenScore(node.docstring, query) : emptyTokenMatch();
    const score = nameMatch.score * 4 + fileMatch.score + docMatch.score;
    if (score <= 0) continue;

    const def = lookup.defById.get(node.id);
    if (!def) continue;
    const relFile = normalizeAgentFilePath(snapshot.root, node.file);
    const handle = sqlObject
      ? formatAgentSqlHandle({ name: node.name, file: relFile, line: def.range.start.line })
      : formatAgentSymbolHandle({
          file: relFile,
          name: node.name,
          line: def.range.start.line,
          column: def.range.start.column,
        });
    const result = upsertResult(resultMap, {
      handle,
      kind: sqlObject ? "sql_object" : "symbol",
      label: node.name,
      file: relFile,
      range: def.range,
      provenance: createSearchProvenance(relFile, "semantic", "high", snapshot.analysis),
    });
    result.score += score + (lookup.exportedIds.has(node.id) ? 5 : 0);
    addMatchedRankTerms(result, nameMatch, fileMatch, docMatch);
    if (nameMatch.matched.length) {
      addReason(result, `${sqlObject ? "SQL object" : "symbol"} token match: ${nameMatch.matched.join(", ")}`);
      addEvidence(result, {
        source: sqlObject ? "sql" : "symbol",
        label: node.name,
        file: relFile,
        line: def.range.start.line,
      });
    }
    if (fileMatch.matched.length) {
      addReason(result, `path token match: ${fileMatch.matched.join(", ")}`);
    }
    if (docMatch.matched.length) {
      addReason(result, `docstring token match: ${docMatch.matched.join(", ")}`);
    }
    addPhraseReasons(result, nameMatch, "symbol name");
    addPhraseReasons(result, docMatch, "docstring");
    addSymbolNeighbors(snapshot, result, neighborsBySymbolId.get(node.id) ?? []);
    addSymbolFollowUps(result, relFile, def);
  }
}

function addSqlResults(
  snapshot: AgentProjectSnapshot,
  resultMap: Map<string, MutableSearchResult>,
  fileNeighborIndex: Map<string, FileNeighbor[]>,
  query: SearchQueryTerms,
): void {
  for (const moduleIndex of snapshot.index.byFile.values()) {
    for (const local of moduleIndex.locals) {
      if (!isSqlObjectSymbol(local)) continue;
      const nameMatch = matchTokenScore(local.localName, query);
      const relFile = normalizeAgentFilePath(snapshot.root, local.file);
      const fileMatch = matchTokenScore(relFile, query);
      const docMatch = local.docstring ? matchTokenScore(local.docstring, query) : emptyTokenMatch();
      const score = nameMatch.score * 4 + fileMatch.score + docMatch.score;
      if (score <= 0) continue;

      const result = upsertResult(resultMap, {
        handle: formatAgentSqlHandle({ name: local.localName, file: relFile, line: local.range.start.line }),
        kind: "sql_object",
        label: local.localName,
        file: relFile,
        range: local.range,
        provenance: createSearchProvenance(relFile, "semantic", "high", snapshot.analysis),
      });
      result.score += score;
      addMatchedRankTerms(result, nameMatch, fileMatch, docMatch);
      if (nameMatch.matched.length) {
        addReason(result, `SQL object token match: ${nameMatch.matched.join(", ")}`);
        addEvidence(result, {
          source: "sql",
          label: local.localName,
          file: relFile,
          line: local.range.start.line,
        });
      }
      if (fileMatch.matched.length) {
        addReason(result, `path token match: ${fileMatch.matched.join(", ")}`);
      }
      if (docMatch.matched.length) {
        addReason(result, `docstring token match: ${docMatch.matched.join(", ")}`);
      }
      addPhraseReasons(result, nameMatch, "SQL object name");
      addPhraseReasons(result, docMatch, "docstring");
      addFileNeighbors(snapshot, result, fileNeighborIndex.get(normalizePath(local.file)) ?? []);
      addSymbolFollowUps(result, relFile, local);
    }
  }
}

function isSqlObjectSymbol(symbol: SymbolDef): boolean {
  return (
    symbol.kind === SymbolKind.Table ||
    symbol.kind === SymbolKind.View ||
    symbol.kind === SymbolKind.Index ||
    symbol.kind === SymbolKind.Routine
  );
}

function addPathResults(
  snapshot: AgentProjectSnapshot,
  resultMap: Map<string, MutableSearchResult>,
  fileNeighborIndex: Map<string, FileNeighbor[]>,
  query: SearchQueryTerms,
): void {
  for (const file of snapshot.files) {
    const relFile = normalizeAgentFilePath(snapshot.root, file);
    const pathMatch = matchTokenScore(relFile, query);
    if (pathMatch.score <= 0) continue;

    const result = upsertResult(resultMap, {
      handle: formatAgentFileHandle({ file: relFile }),
      kind: "file",
      label: relFile,
      file: relFile,
      provenance: createSearchProvenance(relFile, "graph", "high", snapshot.analysis),
    });
    result.score += pathMatch.score * 2;
    addMatchedRankTerms(result, pathMatch);
    addReason(result, `path token match: ${pathMatch.matched.join(", ")}`);
    addEvidence(result, { source: "path", label: relFile, file: relFile });
    addFileNeighbors(snapshot, result, fileNeighborIndex.get(normalizePath(file)) ?? []);
    addFileFollowUps(result, relFile);
  }
}

function mergeSearchResults(
  targetMap: Map<string, MutableSearchResult>,
  sourceMap: ReadonlyMap<string, MutableSearchResult>,
): void {
  for (const source of sourceMap.values()) {
    const target = upsertResult(targetMap, source);
    target.score += source.score;
    for (const term of source.matchedRankTerms) target.matchedRankTerms.add(term);
    for (const reason of source.rankReasons) target.rankReasons.add(reason);
    for (const evidence of source.evidence) addEvidence(target, evidence);
    for (const [key, neighbor] of source.neighbors) target.neighbors.set(key, neighbor);
    for (const followUp of source.followUps) target.followUps.add(followUp);
  }
}

async function addTextResults(
  snapshot: AgentProjectSnapshot,
  resultMap: Map<string, MutableSearchResult>,
  query: SearchQueryTerms,
  includeSnippets: boolean,
  mode: AgentSearchMode,
  queryIndex?: QueryIndexHandle,
): Promise<void> {
  const projectSnapshotIdentity = snapshot.index.projectSnapshotIdentity;
  const store = queryIndex?.store;
  const diagnostics = queryIndex?.diagnostics;
  if (store && diagnostics && projectSnapshotIdentity) {
    const candidateResultMap = new Map<string, MutableSearchResult>();
    try {
      store.withReadSnapshot(projectSnapshotIdentity, () => {
        const candidateStarted = performance.now();
        const candidateChunks = findQueryIndexChunkCandidates(store, query.rankTokens);
        diagnostics.candidateMs += performance.now() - candidateStarted;
        diagnostics.fileCandidates += new Set(candidateChunks.map((chunk) => chunk.path)).size;
        diagnostics.chunkCandidates += candidateChunks.length;
        const allowedPaths = new Set(snapshot.files.map((file) => normalizeAgentFilePath(snapshot.root, file)));
        const scoringStarted = performance.now();
        for (const chunk of candidateChunks) {
          if (!allowedPaths.has(chunk.path)) {
            throw new Error(`Query index returned an out-of-snapshot path: ${chunk.path}`);
          }
          addTextFileResults(snapshot, candidateResultMap, query, includeSnippets, mode, chunk.path, [chunk]);
        }
        diagnostics.scoringMs += performance.now() - scoringStarted;
      });
      mergeSearchResults(resultMap, candidateResultMap);
      return;
    } catch (error) {
      diagnostics.sidecarState = "unavailable";
      diagnostics.fallbackReason = error instanceof Error ? error.message : String(error);
    }
  }

  const cache = getSearchCache(snapshot);
  for (const file of snapshot.files) {
    const normalizedText = await getCachedNormalizedText(cache, file);
    if (!normalizedText || !textCouldMatchNormalized(normalizedText, query.rankTokens)) continue;
    const relFile = normalizeAgentFilePath(snapshot.root, file);
    const chunks = await getCachedTextChunks(cache, file);
    addTextFileResults(snapshot, resultMap, query, includeSnippets, mode, relFile, chunks);
  }
}

function addTextFileResults(
  snapshot: AgentProjectSnapshot,
  resultMap: Map<string, MutableSearchResult>,
  query: SearchQueryTerms,
  includeSnippets: boolean,
  mode: AgentSearchMode,
  relFile: string,
  chunks: readonly SearchTextChunk[],
): void {
  const documentationFile = isDocumentationFile(relFile);
  for (const chunk of chunks) {
    const match = matchTokenScoreFromNormalized(chunk.normalizedText, query);
    if (match.score <= 0) continue;

    const handle = formatAgentChunkHandle({ file: relFile, line: chunk.startLine });
    const result = upsertResult(resultMap, {
      handle,
      kind: "chunk",
      label: chunk.name ? `${chunk.name} (${relFile})` : `${relFile}:${chunk.startLine}`,
      file: relFile,
      range: {
        start: { line: chunk.startLine, column: 0 },
        end: { line: chunk.endLine, column: 0 },
      },
      provenance: createSearchProvenance(relFile, "text", documentationFile ? "medium" : "high", snapshot.analysis),
    });
    result.score += match.score + textResultBoost(match, documentationFile, query, mode);
    addMatchedRankTerms(result, match);
    addReason(result, `text token match: ${match.matched.join(", ")}`);
    addPhraseReasons(result, match, documentationFile ? "docs text" : "text");
    addEvidence(result, {
      source: "chunk",
      label: result.label,
      file: relFile,
      line: chunk.startLine,
      ...(includeSnippets ? { snippet: makeSnippet(chunk.text, query) } : {}),
    });
    addFileFollowUps(result, relFile);
  }
}

function textResultBoost(
  match: TokenMatch,
  documentationFile: boolean,
  query: SearchQueryTerms,
  mode: AgentSearchMode,
): number {
  if (!documentationFile || query.identifierLike) return 0;
  if (mode !== "text" && mode !== "hybrid") return 0;
  if (match.exactPhrase) return DOCS_EXACT_PHRASE_BOOST;
  if (match.proximity) return DOCS_PROXIMITY_BOOST;
  return 0;
}

function isDocumentationFile(relFile: string): boolean {
  const lower = relFile.toLowerCase();
  return (
    lower === "readme.md" ||
    lower.startsWith("docs/") ||
    lower.endsWith(".md") ||
    lower.endsWith(".mdx") ||
    lower.endsWith(".rst") ||
    lower.endsWith(".adoc") ||
    lower.endsWith(".txt")
  );
}

function addPhraseReasons(result: MutableSearchResult, match: TokenMatch, label: string): void {
  if (match.exactPhrase) {
    addReason(result, `exact phrase match in ${label}`);
    return;
  }
  if (match.proximity) {
    addReason(result, `nearby token match in ${label}`);
  }
}

function textCouldMatchNormalized(normalizedText: string, tokens: string[]): boolean {
  return tokens.some((token) => normalizedText.includes(token));
}

function getSearchCache(snapshot: AgentProjectSnapshot): SearchCache {
  const existing = SEARCH_CACHES.get(snapshot);
  if (existing) return existing;
  const created: SearchCache = {
    fileText: new Map(),
    normalizedText: new Map(),
    textChunks: new Map(),
  };
  SEARCH_CACHES.set(snapshot, created);
  return created;
}

async function getCachedFileText(cache: SearchCache, file: string): Promise<string | null> {
  const cached = cache.fileText.get(file);
  if (cached) return await cached;
  const loadPromise = readSearchableFile(file);
  cache.fileText.set(file, loadPromise);
  loadPromise.catch(() => {
    if (cache.fileText.get(file) === loadPromise) cache.fileText.delete(file);
  });
  return await loadPromise;
}

async function getCachedNormalizedText(cache: SearchCache, file: string): Promise<string | null> {
  const cached = cache.normalizedText.get(file);
  if (cached) return await cached;
  const loadPromise = getCachedFileText(cache, file).then((text) => (text ? normalizeSearchText(text) : null));
  cache.normalizedText.set(file, loadPromise);
  loadPromise.catch(() => {
    if (cache.normalizedText.get(file) === loadPromise) cache.normalizedText.delete(file);
  });
  return await loadPromise;
}

async function getCachedTextChunks(cache: SearchCache, file: string): Promise<SearchTextChunk[]> {
  const cached = cache.textChunks.get(file);
  if (cached) return await cached;
  const loadPromise = getCachedFileText(cache, file).then((text) => (text ? buildTextChunks(file, text) : []));
  cache.textChunks.set(file, loadPromise);
  loadPromise.catch(() => {
    if (cache.textChunks.get(file) === loadPromise) cache.textChunks.delete(file);
  });
  return await loadPromise;
}

function applyGraphNeighborhood(
  snapshot: AgentProjectSnapshot,
  resultMap: Map<string, MutableSearchResult>,
  fileNeighborIndex: Map<string, FileNeighbor[]>,
  query: SearchQueryTerms,
  from: string,
  depth: number,
): void {
  const anchorFiles = resolveAnchorFiles(snapshot, from);
  if (anchorFiles.size === 0) return;

  const reachable = collectReachableFiles(fileNeighborIndex, anchorFiles, depth);
  for (const entry of reachable.values()) {
    const relFile = normalizeAgentFilePath(snapshot.root, entry.file);
    const existingResults = [...resultMap.values()].filter((result) => result.file === relFile);
    const fileMatch = matchTokenScore(relFile, query);
    if (fileMatch.score > 0) {
      const graphResult = upsertResult(resultMap, {
        handle: formatAgentGraphHandle({ file: relFile }),
        kind: "graph_node",
        label: relFile,
        file: relFile,
        provenance: createSearchProvenance(relFile, "graph", "medium", snapshot.analysis),
      });
      graphResult.score += fileMatch.score + graphBoost(entry.distance);
      addGraphEvidence(graphResult, relFile, entry);
      addMatchedRankTerms(graphResult, fileMatch);
      addFileFollowUps(graphResult, relFile);
    }

    for (const result of existingResults) {
      result.score += graphBoost(entry.distance);
      addGraphEvidence(result, relFile, entry);
    }
  }
}

function addGraphEvidence(result: MutableSearchResult, relFile: string, entry: ReachableFile): void {
  addReason(result, `graph neighborhood match at depth ${entry.distance}`);
  addEvidence(result, {
    source: "graph",
    label: entry.relation,
    file: relFile,
  });
}

function graphBoost(distance: number): number {
  return Math.max(2, 14 - distance * 3);
}

function resolveAnchorFiles(snapshot: AgentProjectSnapshot, from: string): Set<string> {
  const anchor = new Set<string>();
  const directFile = resolveAgentSnapshotFile(snapshot, from);
  if (directFile) anchor.add(directFile);

  const fileLikeHandle = parseAgentFileHandle(from) ?? parseAgentChunkHandle(from) ?? parseAgentGraphHandle(from);
  if (fileLikeHandle) {
    const handleFile = resolveAgentSnapshotFile(snapshot, fileLikeHandle.file);
    if (handleFile) anchor.add(handleFile);
  }

  if (from.startsWith("symbol:")) {
    const symbolHandle = parseAgentSymbolHandle(from);
    const symbolFile = symbolHandle ? resolveAgentSnapshotFile(snapshot, symbolHandle.file) : null;
    if (symbolFile) {
      anchor.add(symbolFile);
    } else {
      const symbol = snapshot.symbolGraph.nodes.get(from.slice("symbol:".length));
      if (symbol) anchor.add(normalizePath(symbol.file));
    }
  }

  if (from.startsWith("sql:")) {
    const sqlHandle = parseAgentSqlHandle(from);
    if (sqlHandle) {
      const file = resolveAgentSnapshotFile(snapshot, sqlHandle.file);
      if (file) anchor.add(file);
    }
  }

  for (const node of snapshot.symbolGraph.nodes.values()) {
    if (node.name === from) {
      anchor.add(normalizePath(node.file));
    }
  }

  return anchor;
}

function collectReachableFiles(
  fileNeighborIndex: Map<string, FileNeighbor[]>,
  anchorFiles: Set<string>,
  depth: number,
): Map<string, ReachableFile> {
  const reachable = new Map<string, ReachableFile>();
  const queue: ReachableFile[] = [...anchorFiles].map((file) => ({
    file,
    distance: 0,
    relation: "anchor",
  }));

  while (queue.length) {
    const current = queue.shift()!;
    const existing = reachable.get(current.file);
    if (existing && existing.distance <= current.distance) continue;
    reachable.set(current.file, current);
    if (current.distance >= depth) continue;

    for (const neighbor of fileNeighborIndex.get(current.file) ?? []) {
      queue.push({
        file: neighbor.file,
        distance: current.distance + 1,
        relation: neighbor.relation,
      });
    }
  }

  return reachable;
}

async function readSearchableFile(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_TEXT_BYTES) return null;
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function buildTextChunks(file: string, text: string): SearchTextChunk[] {
  return buildQueryTextChunks(file, text);
}

function makeSnippet(text: string, query: SearchQueryTerms): string {
  const lines = text.split(/\r?\n/);
  const matchIndex = lines.findIndex((line) => matchTokenScore(line, query).score > 0);
  const index = matchIndex >= 0 ? matchIndex : 0;
  return lines
    .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
    .join("\n")
    .trim();
}

function upsertResult(resultMap: Map<string, MutableSearchResult>, base: SearchResultBase): MutableSearchResult {
  const existing = resultMap.get(base.handle);
  if (existing) return existing;
  const result: MutableSearchResult = {
    handle: base.handle,
    kind: base.kind,
    label: base.label,
    file: base.file,
    ...(base.range ? { range: base.range } : {}),
    provenance: base.provenance,
    score: 0,
    rankReasons: new Set(),
    evidence: [],
    neighbors: new Map(),
    followUps: new Set(),
    matchedRankTerms: new Set(),
  };
  resultMap.set(base.handle, result);
  return result;
}

function addMatchedRankTerms(result: MutableSearchResult, ...matches: readonly TokenMatch[]): void {
  for (const match of matches) {
    for (const term of match.matched) result.matchedRankTerms.add(term);
  }
}

function addReason(result: MutableSearchResult, reason: string): void {
  if (reason.trim()) result.rankReasons.add(reason);
}

function addEvidence(result: MutableSearchResult, evidence: AgentSearchEvidence): void {
  if (
    result.evidence.some(
      (entry) =>
        entry.source === evidence.source &&
        entry.label === evidence.label &&
        entry.file === evidence.file &&
        entry.line === evidence.line,
    )
  ) {
    return;
  }
  result.evidence.push(evidence);
}

function buildSymbolNeighborIndex(snapshot: AgentProjectSnapshot): Map<string, SymbolNeighbor[]> {
  const neighborsBySymbolId = new Map<string, SymbolNeighbor[]>();
  const addNeighbor = (sourceId: string, neighbor: SymbolNeighbor): void => {
    const neighbors = neighborsBySymbolId.get(sourceId);
    if (neighbors) {
      neighbors.push(neighbor);
      return;
    }
    neighborsBySymbolId.set(sourceId, [neighbor]);
  };

  for (const edge of snapshot.symbolGraph.edges) {
    const from = snapshot.symbolGraph.nodes.get(edge.from);
    const to = snapshot.symbolGraph.nodes.get(edge.to);
    if (!from || !to) continue;
    const forwardRelation = edge.label ?? "uses";
    addNeighbor(from.id, { key: "uses", relation: forwardRelation, target: to });
    addNeighbor(to.id, {
      key: "referenced_by",
      relation: `incoming:${forwardRelation}`,
      target: from,
    });
  }
  return neighborsBySymbolId;
}

function buildFileNeighborIndex(snapshot: AgentProjectSnapshot): Map<string, FileNeighbor[]> {
  const neighborsByFile = new Map<string, FileNeighbor[]>();
  const addNeighbor = (file: string, neighbor: FileNeighbor): void => {
    const normalizedFile = normalizePath(file);
    const neighbors = neighborsByFile.get(normalizedFile);
    if (neighbors) {
      neighbors.push(neighbor);
      return;
    }
    neighborsByFile.set(normalizedFile, [neighbor]);
  };

  for (const edge of snapshot.fileGraph.edges) {
    if (edge.to.type !== "file") continue;
    const from = normalizePath(edge.from);
    const to = normalizePath(edge.to.path);
    addNeighbor(from, { relation: "imports", file: to });
    addNeighbor(to, { relation: "imported_by", file: from });
  }

  return neighborsByFile;
}

function addSymbolNeighbors(
  snapshot: AgentProjectSnapshot,
  result: MutableSearchResult,
  neighbors: readonly SymbolNeighbor[],
): void {
  for (const neighbor of neighbors) {
    const relFile = normalizeAgentFilePath(snapshot.root, neighbor.target.file);
    const key = `${neighbor.key}:${neighbor.target.id}`;
    result.neighbors.set(key, {
      relation: neighbor.relation,
      target: neighbor.target.name,
      file: relFile,
    });
  }
}

function addFileNeighbors(
  snapshot: AgentProjectSnapshot,
  result: MutableSearchResult,
  neighbors: readonly FileNeighbor[],
): void {
  for (const neighbor of neighbors) {
    const relFile = normalizeAgentFilePath(snapshot.root, neighbor.file);
    result.neighbors.set(`${neighbor.relation}:${relFile}`, {
      relation: neighbor.relation,
      target: relFile,
      file: relFile,
    });
  }
}

function addSymbolFollowUps(result: MutableSearchResult, relFile: string, def: SymbolDef | undefined): void {
  result.followUps.add(`codegraph explain ${quoteShellArg(result.handle)}`);
  if (def) {
    for (const command of collectDefinitionFollowUps(relFile, def.range.start.line, def.range.start.column)) {
      result.followUps.add(command);
    }
  }
  addFileFollowUps(result, relFile);
}

function addFileFollowUps(result: MutableSearchResult, relFile: string): void {
  for (const command of collectCommonFileFollowUps(relFile)) {
    result.followUps.add(command);
  }
}

function compareResults(left: MutableSearchResult, right: MutableSearchResult): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) return scoreDelta;
  const capabilityDelta = capabilityRank(left.provenance.capability) - capabilityRank(right.provenance.capability);
  if (capabilityDelta !== 0) return capabilityDelta;
  const coverageDelta = right.matchedRankTerms.size - left.matchedRankTerms.size;
  if (coverageDelta !== 0) return coverageDelta;
  const labelDelta = compareAscii(left.label, right.label);
  if (labelDelta !== 0) return labelDelta;
  const fileDelta = compareAscii(left.file, right.file);
  if (fileDelta !== 0) return fileDelta;
  return compareAscii(left.handle, right.handle);
}

function capabilityRank(capability: AgentSearchResult["provenance"]["capability"]): number {
  if (capability === "semantic") return 0;
  if (capability === "graph") return 1;
  return 2;
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function selectTopResults(
  resultMap: Map<string, MutableSearchResult>,
  limit: number,
): { items: MutableSearchResult[]; totalCandidates: number; omitted: number } {
  const top: MutableSearchResult[] = [];
  let totalCandidates = 0;

  for (const result of resultMap.values()) {
    if (result.score <= 0) continue;
    totalCandidates += 1;
    insertTopResult(top, result, limit);
  }

  return {
    items: top,
    totalCandidates,
    omitted: Math.max(0, totalCandidates - top.length),
  };
}

function insertTopResult(top: MutableSearchResult[], result: MutableSearchResult, limit: number): void {
  if (limit <= 0) return;
  let insertIndex = top.length;
  while (insertIndex > 0 && compareResults(result, top[insertIndex - 1]!) < 0) {
    insertIndex -= 1;
  }
  if (insertIndex >= limit) return;
  top.splice(insertIndex, 0, result);
  if (top.length > limit) top.pop();
}

function finalizeResult(result: MutableSearchResult): AgentSearchResult {
  const rankReasons = [...result.rankReasons].sort();
  const evidence = result.evidence.sort((left, right) => {
    const sourceDelta = left.source.localeCompare(right.source);
    if (sourceDelta !== 0) return sourceDelta;
    return left.label.localeCompare(right.label);
  });
  const neighbors = [...result.neighbors.values()].sort((left, right) => {
    const relationDelta = left.relation.localeCompare(right.relation);
    if (relationDelta !== 0) return relationDelta;
    return left.target.localeCompare(right.target);
  });
  const followUps = [...result.followUps].sort();
  const boundedRankReasons = boundAgentList(rankReasons, AGENT_SEARCH_RANK_REASONS_PER_RESULT_LIMIT);
  const boundedEvidence = boundAgentList(evidence, AGENT_SEARCH_EVIDENCE_PER_RESULT_LIMIT);
  const boundedNeighbors = boundAgentList(neighbors, AGENT_SEARCH_NEIGHBORS_PER_RESULT_LIMIT);
  const boundedFollowUps = boundAgentList(followUps, AGENT_SEARCH_FOLLOWUPS_PER_RESULT_LIMIT);

  return {
    handle: result.handle,
    kind: result.kind,
    label: result.label,
    file: result.file,
    ...(result.range ? { range: result.range } : {}),
    score: Number(result.score.toFixed(3)),
    provenance: result.provenance,
    rankReasons: boundedRankReasons.items,
    evidence: boundedEvidence.items,
    neighbors: boundedNeighbors.items,
    followUps: boundedFollowUps.items,
    omittedCounts: {
      rankReasons: boundedRankReasons.omitted,
      evidence: boundedEvidence.omitted,
      neighbors: boundedNeighbors.omitted,
      followUps: boundedFollowUps.omitted,
    },
  };
}

function createSearchProvenance(
  relFile: string,
  capability: "semantic" | "graph" | "text",
  confidence: "high" | "medium",
  analysis: Pick<AnalysisSummary, "mode" | "backend">,
): AgentSearchResult["provenance"] {
  return {
    surface: detectSearchSurface(relFile),
    capability,
    analysisMode: analysis.mode,
    backend: analysis.backend,
    confidence,
  };
}

function detectSearchSurface(relFile: string): "code" | "docs" | "config" {
  return detectQueryIndexSurface(relFile);
}
