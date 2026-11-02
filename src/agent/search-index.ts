import type { SymbolNode } from "../graphs/symbol-graph.js";
import type { SymbolDef } from "../indexer/types.js";
import { compareCodeUnits } from "../util/collections.js";
import { formatAgentSqlHandle, formatAgentSymbolHandle } from "./handles.js";
import { isAgentSqlObjectNode, normalizeAgentFilePath } from "./normalize.js";
import {
  countMatchedTerms,
  matchSearchField,
  prepareSearchField,
  searchFieldMayMatch,
  type SearchField,
  type SearchQueryTerms,
  type TokenMatch,
} from "./search-scoring.js";
import type { AgentProjectSnapshot } from "./session.js";
import { buildSymbolLookup } from "./symbol-lookup.js";

/**
 * Per-snapshot search tables. Every query used to normalize each symbol name, path, and docstring again; the tables
 * hold those normalized forms once, keyed by the object they were derived from, so a refreshed session starts clean.
 */

export type SearchFileTable = {
  readonly root: string;
  readonly files: readonly string[];
  readonly relative: readonly string[];
  readonly fields: readonly SearchField[];
  readonly relativeSet: ReadonlySet<string>;
  /** False when two files share a relative path; their results would merge under one handle. */
  readonly uniqueRelative: boolean;
};

const FILE_TABLES = new WeakMap<readonly string[], SearchFileTable>();

export function getSearchFileTable(root: string, files: readonly string[]): SearchFileTable {
  const cached = FILE_TABLES.get(files);
  if (cached && cached.root === root && cached.relative.length === files.length) return cached;
  const relative = files.map((file) => normalizeAgentFilePath(root, file));
  const relativeSet = new Set(relative);
  const table: SearchFileTable = {
    root,
    files,
    relative,
    fields: relative.map((file) => prepareSearchField(file)),
    relativeSet,
    uniqueRelative: relativeSet.size === relative.length,
  };
  FILE_TABLES.set(files, table);
  return table;
}

export type SymbolSearchIndex = {
  readonly nodes: readonly SymbolNode[];
  readonly defs: readonly SymbolDef[];
  readonly nameValues: readonly string[];
  readonly names: readonly SearchField[];
  readonly nameIds: Int32Array;
  readonly relativeFiles: readonly string[];
  readonly fileFields: readonly SearchField[];
  readonly fileIds: Int32Array;
  readonly docs: readonly SearchField[];
  /** Index into `docs`, or -1 when the symbol has no docstring. */
  readonly docIds: Int32Array;
  readonly sqlObject: Uint8Array;
  /** True when two symbols would share a handle, so their results merge and cannot be ranked one by one. */
  readonly handleCollisions: boolean;
};

type SymbolSearchParts = Omit<SymbolSearchIndex, "handleCollisions">;

const SYMBOL_INDEXES = new WeakMap<AgentProjectSnapshot, SymbolSearchIndex>();

export function getSymbolSearchIndex(snapshot: AgentProjectSnapshot): SymbolSearchIndex {
  const cached = SYMBOL_INDEXES.get(snapshot);
  if (cached) return cached;
  const index = buildSymbolSearchIndex(snapshot);
  SYMBOL_INDEXES.set(snapshot, index);
  return index;
}

function buildSymbolSearchIndex(snapshot: AgentProjectSnapshot): SymbolSearchIndex {
  const lookup = buildSymbolLookup(snapshot);
  const capacity = snapshot.symbolGraph.nodes.size;
  const nodes: SymbolNode[] = [];
  const defs: SymbolDef[] = [];
  const nameIds = new Int32Array(capacity);
  const fileIds = new Int32Array(capacity);
  const docIds = new Int32Array(capacity);
  const sqlObject = new Uint8Array(capacity);
  const nameValues: string[] = [];
  const names: SearchField[] = [];
  const nameIdByValue = new Map<string, number>();
  const relativeFiles: string[] = [];
  const fileFields: SearchField[] = [];
  const fileIdByRelative = new Map<string, number>();
  const fileIdByRaw = new Map<string, number>();
  const docs: SearchField[] = [];

  for (const node of snapshot.symbolGraph.nodes.values()) {
    // A symbol without a definition never yields a result, whatever it scores.
    const def = lookup.defById.get(node.id);
    if (!def) continue;
    const slot = nodes.length;
    nodes.push(node);
    defs.push(def);

    let nameId = nameIdByValue.get(node.name);
    if (nameId === undefined) {
      nameId = names.length;
      nameIdByValue.set(node.name, nameId);
      nameValues.push(node.name);
      names.push(prepareSearchField(node.name));
    }
    nameIds[slot] = nameId;

    let fileId = fileIdByRaw.get(node.file);
    if (fileId === undefined) {
      const relative = normalizeAgentFilePath(snapshot.root, node.file);
      fileId = fileIdByRelative.get(relative);
      if (fileId === undefined) {
        fileId = relativeFiles.length;
        fileIdByRelative.set(relative, fileId);
        relativeFiles.push(relative);
        fileFields.push(prepareSearchField(relative));
      }
      fileIdByRaw.set(node.file, fileId);
    }
    fileIds[slot] = fileId;

    if (node.docstring) {
      docIds[slot] = docs.length;
      docs.push(prepareSearchField(node.docstring));
    } else {
      docIds[slot] = -1;
    }
    sqlObject[slot] = isAgentSqlObjectNode(node) ? 1 : 0;
  }

  const parts: SymbolSearchParts = {
    nodes,
    defs,
    nameValues,
    names,
    nameIds,
    relativeFiles,
    fileFields,
    fileIds,
    docs,
    docIds,
    sqlObject,
  };
  return { ...parts, handleCollisions: hasHandleCollisions(parts) };
}

/**
 * Two symbols collide when their handles are equal. A handle names the file, the name, and the position, so only
 * symbols with one file and one name can collide; those groups are small, and the check compares their positions.
 */
function hasHandleCollisions(parts: SymbolSearchParts): boolean {
  const nameCount = parts.names.length;
  const groups = new Map<number, number | number[]>();
  for (let slot = 0; slot < parts.nodes.length; slot += 1) {
    const key = parts.fileIds[slot]! * nameCount + parts.nameIds[slot]!;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, slot);
      continue;
    }
    const members = typeof existing === "number" ? [existing] : existing;
    if (members.some((member) => sameHandle(parts, slot, member))) return true;
    if (typeof existing === "number") groups.set(key, [existing, slot]);
    else existing.push(slot);
  }
  return false;
}

function sameHandle(parts: SymbolSearchParts, left: number, right: number): boolean {
  const leftSql = parts.sqlObject[left] === 1;
  if (leftSql !== (parts.sqlObject[right] === 1)) return false;
  const leftStart = parts.defs[left]!.range.start;
  const rightStart = parts.defs[right]!.range.start;
  if (leftStart.line !== rightStart.line) return false;
  return leftSql || leftStart.column === rightStart.column;
}

/** The handle a symbol result carries: SQL objects and other symbols format differently. */
export function symbolHandleAt(index: SymbolSearchIndex, slot: number): string {
  const node = index.nodes[slot]!;
  const start = index.defs[slot]!.range.start;
  const file = index.relativeFiles[index.fileIds[slot]!]!;
  if (index.sqlObject[slot] === 1) return formatAgentSqlHandle({ name: node.name, file, line: start.line });
  return formatAgentSymbolHandle({ file, name: node.name, line: start.line, column: start.column });
}

/** Symbols that score above zero for a query, in symbol graph order, with what the scores were built from. */
export type SymbolCandidates = {
  readonly index: SymbolSearchIndex;
  readonly slots: readonly number[];
  readonly scores: readonly number[];
  readonly matchedTerms: readonly number[];
  readonly nameMatches: ReadonlyArray<TokenMatch | undefined>;
  readonly fileMatches: ReadonlyArray<TokenMatch | undefined>;
  readonly docMatches: ReadonlyArray<TokenMatch | undefined>;
};

const NO_TERMS: readonly string[] = [];

/**
 * Collects the symbols a full scan would keep. A field scores only when a rank token occurs in its compact text
 * (`searchFieldMayMatch`), so testing each distinct name, path, and docstring once selects exactly the symbols
 * whose name, path, or docstring score, with no fuzzy or short-token match left out.
 */
export function collectSymbolCandidates(
  index: SymbolSearchIndex,
  exportedIds: ReadonlySet<string>,
  query: SearchQueryTerms,
  includeSqlObjects: boolean,
): SymbolCandidates {
  const { rankTokens } = query;
  const matchHits = (fields: readonly SearchField[]): Array<TokenMatch | undefined> =>
    fields.map((field) =>
      searchFieldMayMatch(field.compact, rankTokens) ? matchSearchField(field, query) : undefined,
    );
  const nameMatches = matchHits(index.names);
  const fileMatches = matchHits(index.fileFields);
  const docMatches = matchHits(index.docs);

  const slots: number[] = [];
  const scores: number[] = [];
  const matchedTerms: number[] = [];
  for (let slot = 0; slot < index.nodes.length; slot += 1) {
    if (!includeSqlObjects && index.sqlObject[slot] === 1) continue;
    const nameMatch = nameMatches[index.nameIds[slot]!];
    const fileMatch = fileMatches[index.fileIds[slot]!];
    const docId = index.docIds[slot]!;
    const docMatch = docId >= 0 ? docMatches[docId] : undefined;
    if (!nameMatch && !fileMatch && !docMatch) continue;
    const exported = exportedIds.has(index.nodes[slot]!.id) ? 5 : 0;
    slots.push(slot);
    scores.push((nameMatch?.score ?? 0) * 4 + (fileMatch?.score ?? 0) + (docMatch?.score ?? 0) + exported);
    matchedTerms.push(
      countMatchedTerms(nameMatch?.matched ?? NO_TERMS, fileMatch?.matched ?? NO_TERMS, docMatch?.matched ?? NO_TERMS),
    );
  }
  return { index, slots, scores, matchedTerms, nameMatches, fileMatches, docMatches };
}

/**
 * Keeps the best `limit` entries of `count` candidates, best first. `compare` orders two candidate positions the way
 * the final ranking orders their results; this is the bounded insertion that ranking uses.
 */
export function selectTopCandidates(
  count: number,
  limit: number,
  compare: (left: number, right: number) => number,
): number[] {
  const top: number[] = [];
  if (limit <= 0) return top;
  for (let candidate = 0; candidate < count; candidate += 1) {
    let insertIndex = top.length;
    while (insertIndex > 0 && compare(candidate, top[insertIndex - 1]!) < 0) insertIndex -= 1;
    if (insertIndex >= limit) continue;
    top.splice(insertIndex, 0, candidate);
    if (top.length > limit) top.pop();
  }
  return top;
}

/** Orders symbol candidates like `compareResults` orders their results: score, coverage, label, file, handle. */
export function selectTopSymbolCandidates(candidates: SymbolCandidates, limit: number): number[] {
  const { index, slots, scores, matchedTerms } = candidates;
  return selectTopCandidates(slots.length, limit, (left, right) => {
    const scoreDelta = scores[right]! - scores[left]!;
    if (scoreDelta !== 0) return scoreDelta;
    const coverageDelta = matchedTerms[right]! - matchedTerms[left]!;
    if (coverageDelta !== 0) return coverageDelta;
    const leftSlot = slots[left]!;
    const rightSlot = slots[right]!;
    const leftName = index.nameIds[leftSlot]!;
    const rightName = index.nameIds[rightSlot]!;
    if (leftName !== rightName) return compareCodeUnits(index.nameValues[leftName]!, index.nameValues[rightName]!);
    const leftFile = index.fileIds[leftSlot]!;
    const rightFile = index.fileIds[rightSlot]!;
    if (leftFile !== rightFile) {
      return compareCodeUnits(index.relativeFiles[leftFile]!, index.relativeFiles[rightFile]!);
    }
    return compareCodeUnits(symbolHandleAt(index, leftSlot), symbolHandleAt(index, rightSlot));
  });
}

/** Files whose relative path scores above zero for a query, in file order. */
export type FileCandidates = {
  readonly table: SearchFileTable;
  readonly slots: readonly number[];
  readonly matches: readonly TokenMatch[];
};

export function collectFileCandidates(table: SearchFileTable, query: SearchQueryTerms): FileCandidates {
  const slots: number[] = [];
  const matches: TokenMatch[] = [];
  for (let slot = 0; slot < table.fields.length; slot += 1) {
    const field = table.fields[slot]!;
    if (!searchFieldMayMatch(field.compact, query.rankTokens)) continue;
    slots.push(slot);
    matches.push(matchSearchField(field, query));
  }
  return { table, slots, matches };
}

/** Orders file candidates like `compareResults` orders their results; the relative path is label, file, and handle. */
export function selectTopFileCandidates(candidates: FileCandidates, limit: number): number[] {
  const { table, slots, matches } = candidates;
  return selectTopCandidates(slots.length, limit, (left, right) => {
    const scoreDelta = matches[right]!.score - matches[left]!.score;
    if (scoreDelta !== 0) return scoreDelta;
    const coverageDelta = matches[right]!.matched.length - matches[left]!.matched.length;
    if (coverageDelta !== 0) return coverageDelta;
    return compareCodeUnits(table.relative[slots[left]!]!, table.relative[slots[right]!]!);
  });
}
