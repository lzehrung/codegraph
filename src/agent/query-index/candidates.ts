import type { QueryIndexStore, StoredQueryIndexChunk } from "./store.js";

export const QUERY_INDEX_CANDIDATE_VERSION = 2;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function escapeFtsTrigramTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

export function findQueryIndexChunkCandidates(
  store: QueryIndexStore,
  normalizedTerms: readonly string[],
): StoredQueryIndexChunk[] {
  const candidates = new Map<string, StoredQueryIndexChunk>();
  for (const term of normalizedTerms) {
    if (!term) continue;
    let chunks: StoredQueryIndexChunk[];
    if (codePointLength(term) >= 3) {
      chunks = store.ftsChunkCandidates(escapeFtsTrigramTerm(term));
    } else {
      chunks = store.substringChunkCandidates(term);
    }
    for (const chunk of chunks) candidates.set(`${chunk.path}\0${chunk.ordinal}`, chunk);
  }
  return [...candidates.values()].sort(
    (left, right) => left.path.localeCompare(right.path) || left.ordinal - right.ordinal,
  );
}
