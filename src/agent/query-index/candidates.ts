import type { QueryIndexStore, StoredQueryIndexChunk } from "./store.js";

export const QUERY_INDEX_CANDIDATE_VERSION = 4;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function escapeFtsTrigramTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

export function findQueryIndexChunkCandidates(
  store: QueryIndexStore,
  rankTerms: readonly string[],
): StoredQueryIndexChunk[] {
  const directCandidates = new Map<string, StoredQueryIndexChunk>();
  const terms = rankTerms.filter((term) => term.length);
  const eligiblePaths = store.eligibleFilePaths(terms);
  const eligiblePathSet = new Set(eligiblePaths);
  for (const term of terms) {
    let chunks: StoredQueryIndexChunk[];
    if (codePointLength(term) >= 3) {
      chunks = store.ftsChunkCandidates(escapeFtsTrigramTerm(term));
    } else {
      chunks = store.substringChunkCandidates(term);
    }
    for (const chunk of chunks) {
      if (eligiblePathSet.has(chunk.path)) directCandidates.set(`${chunk.path}\0${chunk.ordinal}`, chunk);
    }
  }

  for (const term of terms) {
    for (const chunk of store.compactChunkCandidates(term, eligiblePaths)) {
      directCandidates.set(`${chunk.path}\0${chunk.ordinal}`, chunk);
    }
  }
  return [...directCandidates.values()].sort(
    (left, right) => left.path.localeCompare(right.path) || left.ordinal - right.ordinal,
  );
}
