import fs from "node:fs/promises";
import { LANG_CONFIGS } from "../bootstrap/treeSitterLanguages.js";
import { supportForFile } from "../languages.js";
import { chunkFile } from "../chunking/chunkFile.js";
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
};

type ReachableFile = {
  file: string;
  distance: number;
  relation: string;
};

type SearchQueryTerms = {
  tokens: string[];
  normalizedPhrase: string;
  identifierLike: boolean;
};

type TokenMatch = {
  score: number;
  matched: string[];
  exactPhrase: boolean;
  proximity: boolean;
};

type SearchTextChunk = {
  name?: string;
  text: string;
  normalizedText: string;
  startLine: number;
  endLine: number;
};

type SearchCache = {
  fileText: Map<string, Promise<string | null>>;
  normalizedText: Map<string, Promise<string | null>>;
  textChunks: Map<string, Promise<SearchTextChunk[]>>;
};

const DEFAULT_LIMIT = 20;
const MAX_TEXT_BYTES = 300_000;
const MAX_GRAPH_DEPTH = 5;
const DOCS_EXACT_PHRASE_BOOST = 220;
const DOCS_PROXIMITY_BOOST = 20;
const CHUNK_LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
};
const SEARCH_CACHES = new WeakMap<AgentProjectSnapshot, SearchCache>();

export async function searchCodegraph(request: AgentSearchRequest): Promise<AgentSearchResponse> {
  const session = createAgentSession({
    root: request.root,
    ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
  });
  return await searchCodegraphWithSession(session, request);
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
    symbolGraph: searchNeedsSymbolGraph(request) ? "eager" : "skip",
  });
  return await searchSnapshot(snapshot, request);
}

export function formatAgentSearchResponse(response: AgentSearchResponse): string {
  if (!response.results.length) {
    return `No matches for "${response.query}"`;
  }
  return response.results
    .map((result, index) => {
      const location = result.range
        ? `${result.file}:${result.range.start.line}:${result.range.start.column}`
        : result.file;
      const reasons = result.rankReasons.slice(0, AGENT_SEARCH_FORMAT_REASON_LIMIT).join("; ");
      return `${index + 1}. ${result.label} [${result.kind}] ${location} score=${result.score}\n   ${reasons}`;
    })
    .join("\n");
}

async function searchSnapshot(
  snapshot: AgentProjectSnapshot,
  request: AgentSearchRequest,
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

  if (query.tokens.length) {
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
      await addTextResults(snapshot, resultMap, query, request.includeSnippets ?? true);
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
      });
      result.score += pathMatch.score * 2;
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
  const tokens = normalized.split(/\s+/).filter((token) => token.length);
  return {
    tokens: Array.from(new Set(tokens)),
    normalizedPhrase: normalized,
    identifierLike: isIdentifierLikeQuery(input),
  };
}

function normalizeSearchText(input: string): string {
  return splitCamelCase(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function splitCamelCase(input: string): string {
  return input.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
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

  for (const token of query.tokens) {
    if (words.has(token)) {
      matched.push(token);
      score += 10;
      continue;
    }
    if (compact.includes(token)) {
      matched.push(token);
      score += 7;
      continue;
    }
    if (normalized.includes(token)) {
      matched.push(token);
      score += 4;
    }
  }

  let exactPhrase = false;
  let proximity = false;
  if (matched.length === query.tokens.length && query.tokens.length > 1) {
    score += 12;
    if (query.normalizedPhrase.includes(" ") && normalized.includes(query.normalizedPhrase)) {
      score += 30;
      exactPhrase = true;
    } else if (tokensAppearInOrder(normalized, query.tokens)) {
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
    });
    result.score += score + (lookup.exportedIds.has(node.id) ? 5 : 0);
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
      });
      result.score += score;
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
    });
    result.score += pathMatch.score * 2;
    addReason(result, `path token match: ${pathMatch.matched.join(", ")}`);
    addEvidence(result, { source: "path", label: relFile, file: relFile });
    addFileNeighbors(snapshot, result, fileNeighborIndex.get(normalizePath(file)) ?? []);
    addFileFollowUps(result, relFile);
  }
}

async function addTextResults(
  snapshot: AgentProjectSnapshot,
  resultMap: Map<string, MutableSearchResult>,
  query: SearchQueryTerms,
  includeSnippets: boolean,
): Promise<void> {
  const cache = getSearchCache(snapshot);
  for (const file of snapshot.files) {
    const normalizedText = await getCachedNormalizedText(cache, file);
    if (!normalizedText) continue;
    if (!textCouldMatchNormalized(normalizedText, query.tokens)) continue;
    const relFile = normalizeAgentFilePath(snapshot.root, file);
    const documentationFile = isDocumentationFile(relFile);
    const chunks = await getCachedTextChunks(cache, file);
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
      });
      result.score += match.score + textResultBoost(match, documentationFile, query);
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
}

function textResultBoost(match: TokenMatch, documentationFile: boolean, query: SearchQueryTerms): number {
  if (!documentationFile || query.identifierLike) return 0;
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
      });
      graphResult.score += fileMatch.score + graphBoost(entry.distance);
      addGraphEvidence(graphResult, relFile, entry);
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
  const support = supportForFile(file);
  const languageId = support ? (CHUNK_LANGUAGE_ALIASES[support.id] ?? support.id) : undefined;
  const language = languageId ? LANG_CONFIGS[languageId] : undefined;
  if (language) {
    try {
      const chunks = chunkFile({
        language,
        source: text,
        filePath: file,
        minTokens: 1,
        maxTokens: 120,
      });
      if (chunks.length) {
        return chunks.map((chunk) => ({
          ...(chunk.name ? { name: chunk.name } : {}),
          text: chunk.text,
          normalizedText: normalizeSearchText([chunk.name, chunk.text].filter(Boolean).join(" ")),
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        }));
      }
    } catch {
      // Fall through to line chunks when semantic chunking is unavailable.
    }
  }

  return text.split(/\r?\n/).map((line, index) => ({
    text: line,
    normalizedText: normalizeSearchText(line),
    startLine: index + 1,
    endLine: index + 1,
  }));
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
    score: 0,
    rankReasons: new Set(),
    evidence: [],
    neighbors: new Map(),
    followUps: new Set(),
  };
  resultMap.set(base.handle, result);
  return result;
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
  const labelDelta = left.label.localeCompare(right.label);
  if (labelDelta !== 0) return labelDelta;
  return left.file.localeCompare(right.file);
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
