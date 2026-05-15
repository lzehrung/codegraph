import fs from "node:fs/promises";
import path from "node:path";
import { LANG_CONFIGS } from "../bootstrap/treeSitterLanguages.js";
import { supportForFile } from "../languages.js";
import { chunkFile } from "../chunking/chunkFile.js";
import type { SymbolDef } from "../indexer/types.js";
import type { Range } from "../types.js";
import { defNodeId } from "../graphs/symbol-graph.js";
import type { SymbolNode } from "../graphs.js";
import { normalizePath, toProjectRelativePath } from "../util.js";
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
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "./session.js";

export type AgentSearchMode = "hybrid" | "symbol" | "path" | "text" | "graph" | "sql";

export type AgentSearchRequest = {
  root: string;
  query: string;
  mode?: AgentSearchMode;
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

type MutableSearchResult = Omit<AgentSearchResult, "rankReasons" | "evidence" | "neighbors" | "followUps" | "omittedCounts"> & {
  rankReasons: Set<string>;
  evidence: AgentSearchEvidence[];
  neighbors: Map<string, { relation: string; target: string; file?: string }>;
  followUps: Set<string>;
};

type SymbolDefLookup = {
  defById: Map<string, SymbolDef>;
  exportedIds: Set<string>;
};

type SymbolNeighbor = {
  key: string;
  relation: string;
  target: SymbolNode;
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

const DEFAULT_LIMIT = 20;
const MAX_RESULTS = 100;
const MAX_TEXT_BYTES = 300_000;
const MAX_GRAPH_DEPTH = 5;
const MAX_RANK_REASONS_PER_RESULT = 6;
const MAX_EVIDENCE_PER_RESULT = 5;
const MAX_NEIGHBORS_PER_RESULT = 12;
const MAX_FOLLOWUPS_PER_RESULT = 8;
const CHUNK_LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
};

export async function searchCodegraph(request: AgentSearchRequest): Promise<AgentSearchResponse> {
  const session = createAgentSession({ root: request.root });
  return await searchCodegraphWithSession(session, request);
}

export async function searchCodegraphWithSession(
  session: AgentSession,
  request: AgentSearchRequest,
): Promise<AgentSearchResponse> {
  const snapshot = await session.loadProject();
  return await searchSnapshot(snapshot, request);
}

export function formatAgentSearchResponse(response: AgentSearchResponse): string {
  if (response.results.length === 0) {
    return `No matches for "${response.query}"`;
  }
  return response.results
    .map((result, index) => {
      const location = result.range ? `${result.file}:${result.range.start.line}:${result.range.start.column}` : result.file;
      const reasons = result.rankReasons.slice(0, 3).join("; ");
      return `${index + 1}. ${result.label} [${result.kind}] ${location} score=${result.score}\n   ${reasons}`;
    })
    .join("\n");
}

async function searchSnapshot(snapshot: AgentProjectSnapshot, request: AgentSearchRequest): Promise<AgentSearchResponse> {
  const mode = request.mode ?? "hybrid";
  const tokens = tokenizeQuery(request.query);
  const resultMap = new Map<string, MutableSearchResult>();
  const limit = normalizeLimit(request.limit);

  if (tokens.length > 0) {
    const symbolLookup = buildSymbolLookup(snapshot);
    if (mode === "hybrid" || mode === "symbol" || mode === "sql" || mode === "graph") {
      addSymbolResults(snapshot, resultMap, symbolLookup, buildSymbolNeighborIndex(snapshot), tokens, mode);
    }
    if (mode === "hybrid" || mode === "path" || mode === "graph") {
      addPathResults(snapshot, resultMap, tokens);
    }
    if (mode === "hybrid" || mode === "text") {
      await addTextResults(snapshot, resultMap, tokens, request.includeSnippets ?? true);
    }
  }

  if (request.from !== undefined && (mode === "hybrid" || mode === "graph")) {
    applyGraphNeighborhood(snapshot, resultMap, tokens, request.from, normalizeDepth(request.depth));
  }

  const candidates = [...resultMap.values()]
    .filter((result) => result.score > 0)
    .sort(compareResults);
  const results = candidates
    .slice(0, limit)
    .map(finalizeResult);

  return {
    schemaVersion: 1,
    query: request.query,
    mode,
    root: snapshot.root,
    limits: {
      results: limit,
      rankReasonsPerResult: MAX_RANK_REASONS_PER_RESULT,
      evidencePerResult: MAX_EVIDENCE_PER_RESULT,
      neighborsPerResult: MAX_NEIGHBORS_PER_RESULT,
      followUpsPerResult: MAX_FOLLOWUPS_PER_RESULT,
    },
    resultCount: results.length,
    totalCandidates: candidates.length,
    omittedCounts: {
      results: Math.max(0, candidates.length - results.length),
    },
    results,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_RESULTS, Math.max(0, Math.floor(limit)));
}

function normalizeDepth(depth: number | undefined): number {
  if (typeof depth !== "number" || !Number.isFinite(depth)) return 1;
  return Math.min(MAX_GRAPH_DEPTH, Math.max(0, Math.floor(depth)));
}

function tokenizeQuery(input: string): string[] {
  const normalized = normalizeSearchText(input);
  const tokens = normalized.split(/\s+/).filter((token) => token.length > 0);
  return Array.from(new Set(tokens));
}

function normalizeSearchText(input: string): string {
  return splitCamelCase(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function splitCamelCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

function matchTokenScore(text: string, tokens: string[]): { score: number; matched: string[] } {
  const normalized = normalizeSearchText(text);
  if (!normalized) return { score: 0, matched: [] };
  const words = new Set(normalized.split(/\s+/).filter(Boolean));
  const compact = normalized.replace(/\s+/g, "");
  const matched: string[] = [];
  let score = 0;

  for (const token of tokens) {
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

  if (matched.length === tokens.length && tokens.length > 1) {
    score += 12;
  }

  return { score, matched };
}

function buildSymbolLookup(snapshot: AgentProjectSnapshot): SymbolDefLookup {
  const defById = new Map<string, SymbolDef>();
  const exportedIds = new Set<string>();

  for (const moduleIndex of snapshot.index.byFile.values()) {
    for (const local of moduleIndex.locals) {
      defById.set(defNodeId(local), local);
    }
    for (const exportEntry of moduleIndex.exports) {
      if (exportEntry.type !== "local") continue;
      exportedIds.add(defNodeId(exportEntry.target));
    }
  }

  return { defById, exportedIds };
}

function addSymbolResults(
  snapshot: AgentProjectSnapshot,
  resultMap: Map<string, MutableSearchResult>,
  lookup: SymbolDefLookup,
  neighborsBySymbolId: Map<string, SymbolNeighbor[]>,
  tokens: string[],
  mode: AgentSearchMode,
): void {
  for (const node of snapshot.symbolGraph.nodes.values()) {
    const sqlObject = isSqlObjectNode(node);
    if (mode === "sql" && !sqlObject) continue;
    if (mode === "symbol" && sqlObject) continue;

    const nameMatch = matchTokenScore(node.name, tokens);
    const fileMatch = matchTokenScore(relativeFile(snapshot.root, node.file), tokens);
    const docMatch = node.docstring ? matchTokenScore(node.docstring, tokens) : { score: 0, matched: [] };
    const score = nameMatch.score * 4 + fileMatch.score + docMatch.score;
    if (score <= 0) continue;

    const def = lookup.defById.get(node.id);
    const relFile = relativeFile(snapshot.root, node.file);
    const handle = sqlObject
      ? formatAgentSqlHandle({ name: node.name, file: relFile, line: def?.range.start.line ?? 0 })
      : formatAgentSymbolHandle({
          file: relFile,
          name: node.name,
          line: def?.range.start.line ?? 0,
          column: def?.range.start.column ?? 0,
        });
    const result = upsertResult(resultMap, {
      handle,
      kind: sqlObject ? "sql_object" : "symbol",
      label: node.name,
      file: relFile,
      ...(def ? { range: def.range } : {}),
    });
    result.score += score + (lookup.exportedIds.has(node.id) ? 5 : 0);
    if (nameMatch.matched.length > 0) {
      addReason(result, `${sqlObject ? "SQL object" : "symbol"} token match: ${nameMatch.matched.join(", ")}`);
      addEvidence(result, {
        source: sqlObject ? "sql" : "symbol",
        label: node.name,
        file: relFile,
        ...(def ? { line: def.range.start.line } : {}),
      });
    }
    if (fileMatch.matched.length > 0) {
      addReason(result, `path token match: ${fileMatch.matched.join(", ")}`);
    }
    if (docMatch.matched.length > 0) {
      addReason(result, `docstring token match: ${docMatch.matched.join(", ")}`);
    }
    addSymbolNeighbors(snapshot, result, neighborsBySymbolId.get(node.id) ?? []);
    addSymbolFollowUps(result, relFile, def);
  }
}

function isSqlObjectNode(node: SymbolNode): boolean {
  return node.kind === "table" || node.kind === "view" || node.kind === "index" || node.kind === "routine";
}

function addPathResults(
  snapshot: AgentProjectSnapshot,
  resultMap: Map<string, MutableSearchResult>,
  tokens: string[],
): void {
  for (const file of snapshot.files) {
    const relFile = relativeFile(snapshot.root, file);
    const pathMatch = matchTokenScore(relFile, tokens);
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
    addFileNeighbors(snapshot, result, file);
    addFileFollowUps(result, relFile);
  }
}

async function addTextResults(
  snapshot: AgentProjectSnapshot,
  resultMap: Map<string, MutableSearchResult>,
  tokens: string[],
  includeSnippets: boolean,
): Promise<void> {
  for (const file of snapshot.files) {
    const text = await readSearchableFile(file);
    if (!text) continue;
    if (!textCouldMatch(text, tokens)) continue;
    const chunks = buildTextChunks(file, text);
    for (const chunk of chunks) {
      const match = matchTokenScore([chunk.name, chunk.text].filter(Boolean).join(" "), tokens);
      if (match.score <= 0) continue;

      const relFile = relativeFile(snapshot.root, file);
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
      result.score += match.score;
      addReason(result, `text token match: ${match.matched.join(", ")}`);
      addEvidence(result, {
        source: "chunk",
        label: result.label,
        file: relFile,
        line: chunk.startLine,
        ...(includeSnippets ? { snippet: makeSnippet(chunk.text, tokens) } : {}),
      });
      addFileFollowUps(result, relFile);
    }
  }
}

function textCouldMatch(text: string, tokens: string[]): boolean {
  const normalized = normalizeSearchText(text);
  return tokens.some((token) => normalized.includes(token));
}

function applyGraphNeighborhood(
  snapshot: AgentProjectSnapshot,
  resultMap: Map<string, MutableSearchResult>,
  tokens: string[],
  from: string,
  depth: number,
): void {
  const anchorFiles = resolveAnchorFiles(snapshot, from);
  if (anchorFiles.size === 0) return;

  const reachable = collectReachableFiles(snapshot, anchorFiles, depth);
  for (const entry of reachable.values()) {
    const relFile = relativeFile(snapshot.root, entry.file);
    const existingResults = [...resultMap.values()].filter((result) => result.file === relFile);
    const fileMatch = matchTokenScore(relFile, tokens);
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
  const directFile = resolveFileCandidate(snapshot, from);
  if (directFile) anchor.add(directFile);

  const fileLikeHandle = parseAgentFileHandle(from) ?? parseAgentChunkHandle(from) ?? parseAgentGraphHandle(from);
  if (fileLikeHandle) {
    const handleFile = resolveFileCandidate(snapshot, fileLikeHandle.file);
    if (handleFile) anchor.add(handleFile);
  }

  if (from.startsWith("symbol:")) {
    const symbolHandle = parseAgentSymbolHandle(from);
    const symbolFile = symbolHandle ? resolveFileCandidate(snapshot, symbolHandle.file) : null;
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
      const file = resolveFileCandidate(snapshot, sqlHandle.file);
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

function resolveFileCandidate(snapshot: AgentProjectSnapshot, candidate: string): string | null {
  const normalizedFiles = new Map(snapshot.files.map((file) => [normalizePath(file), normalizePath(file)]));
  const absoluteCandidate = path.isAbsolute(candidate) ? normalizePath(candidate) : normalizePath(path.resolve(snapshot.root, candidate));
  return normalizedFiles.get(absoluteCandidate) ?? null;
}

function collectReachableFiles(
  snapshot: AgentProjectSnapshot,
  anchorFiles: Set<string>,
  depth: number,
): Map<string, ReachableFile> {
  const reachable = new Map<string, ReachableFile>();
  const queue: ReachableFile[] = [...anchorFiles].map((file) => ({
    file,
    distance: 0,
    relation: "anchor",
  }));

  while (queue.length > 0) {
    const current = queue.shift()!;
    const existing = reachable.get(current.file);
    if (existing && existing.distance <= current.distance) continue;
    reachable.set(current.file, current);
    if (current.distance >= depth) continue;

    for (const edge of snapshot.fileGraph.edges) {
      if (normalizePath(edge.from) === current.file && edge.to.type === "file") {
        queue.push({
          file: normalizePath(edge.to.path),
          distance: current.distance + 1,
          relation: "imports",
        });
      }
      if (edge.to.type === "file" && normalizePath(edge.to.path) === current.file) {
        queue.push({
          file: normalizePath(edge.from),
          distance: current.distance + 1,
          relation: "imported_by",
        });
      }
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

function buildTextChunks(file: string, text: string): Array<{ name?: string; text: string; startLine: number; endLine: number }> {
  const support = supportForFile(file);
  const languageId = support ? CHUNK_LANGUAGE_ALIASES[support.id] ?? support.id : undefined;
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
      if (chunks.length > 0) {
        return chunks.map((chunk) => ({
          ...(chunk.name ? { name: chunk.name } : {}),
          text: chunk.text,
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
    startLine: index + 1,
    endLine: index + 1,
  }));
}

function makeSnippet(text: string, tokens: string[]): string {
  const lines = text.split(/\r?\n/);
  const matchIndex = lines.findIndex((line) => matchTokenScore(line, tokens).score > 0);
  const index = matchIndex >= 0 ? matchIndex : 0;
  return lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join("\n").trim();
}

function upsertResult(
  resultMap: Map<string, MutableSearchResult>,
  base: SearchResultBase,
): MutableSearchResult {
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

function addSymbolNeighbors(
  snapshot: AgentProjectSnapshot,
  result: MutableSearchResult,
  neighbors: readonly SymbolNeighbor[],
): void {
  for (const neighbor of neighbors) {
    const relFile = relativeFile(snapshot.root, neighbor.target.file);
    const key = `${neighbor.key}:${neighbor.target.id}`;
    result.neighbors.set(key, {
      relation: neighbor.relation,
      target: neighbor.target.name,
      file: relFile,
    });
  }
}

function addFileNeighbors(snapshot: AgentProjectSnapshot, result: MutableSearchResult, file: string): void {
  const normalized = normalizePath(file);
  for (const edge of snapshot.fileGraph.edges) {
    if (normalizePath(edge.from) === normalized && edge.to.type === "file") {
      const relFile = relativeFile(snapshot.root, edge.to.path);
      result.neighbors.set(`imports:${relFile}`, {
        relation: "imports",
        target: relFile,
        file: relFile,
      });
    }
    if (edge.to.type === "file" && normalizePath(edge.to.path) === normalized) {
      const relFile = relativeFile(snapshot.root, edge.from);
      result.neighbors.set(`imported_by:${relFile}`, {
        relation: "imported_by",
        target: relFile,
        file: relFile,
      });
    }
  }
}

function addSymbolFollowUps(result: MutableSearchResult, relFile: string, def: SymbolDef | undefined): void {
  result.followUps.add(`codegraph explain ${quoteArg(result.handle)}`);
  if (def) {
    result.followUps.add(`codegraph goto ${quoteArg(relFile)} ${def.range.start.line} ${def.range.start.column}`);
    result.followUps.add(`codegraph refs --file ${quoteArg(relFile)} --line ${def.range.start.line} --col ${def.range.start.column} --pretty`);
  }
  addFileFollowUps(result, relFile);
}

function addFileFollowUps(result: MutableSearchResult, relFile: string): void {
  result.followUps.add(`codegraph deps ${quoteArg(relFile)} --json`);
  result.followUps.add(`codegraph rdeps ${quoteArg(relFile)} --json`);
  result.followUps.add(`codegraph chunk ${quoteArg(relFile)}`);
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function compareResults(left: MutableSearchResult, right: MutableSearchResult): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) return scoreDelta;
  const labelDelta = left.label.localeCompare(right.label);
  if (labelDelta !== 0) return labelDelta;
  return left.file.localeCompare(right.file);
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

  return {
    handle: result.handle,
    kind: result.kind,
    label: result.label,
    file: result.file,
    ...(result.range ? { range: result.range } : {}),
    score: Number(result.score.toFixed(3)),
    rankReasons: rankReasons.slice(0, MAX_RANK_REASONS_PER_RESULT),
    evidence: evidence.slice(0, MAX_EVIDENCE_PER_RESULT),
    neighbors: neighbors.slice(0, MAX_NEIGHBORS_PER_RESULT),
    followUps: followUps.slice(0, MAX_FOLLOWUPS_PER_RESULT),
    omittedCounts: {
      rankReasons: Math.max(0, rankReasons.length - MAX_RANK_REASONS_PER_RESULT),
      evidence: Math.max(0, evidence.length - MAX_EVIDENCE_PER_RESULT),
      neighbors: Math.max(0, neighbors.length - MAX_NEIGHBORS_PER_RESULT),
      followUps: Math.max(0, followUps.length - MAX_FOLLOWUPS_PER_RESULT),
    },
  };
}

function relativeFile(root: string, file: string): string {
  return toProjectRelativePath(root, file) ?? normalizePath(path.resolve(file));
}
