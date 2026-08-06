import {
  codePointLength,
  escapeFtsTrigramTerm,
  QUERY_INDEX_CANDIDATE_ROW_LIMIT,
  type QueryIndexStore,
  type StoredQueryIndexChunk,
} from "./store.js";

export const QUERY_INDEX_CANDIDATE_VERSION = 5;

type CandidateScore = {
  score: number;
  exactPhrase: boolean;
  proximity: boolean;
  matchedTerms: number;
};

function scoreCandidateChunk(normalizedText: string, rankTerms: readonly string[]): CandidateScore {
  if (!normalizedText.length || !rankTerms.length) {
    return { score: 0, exactPhrase: false, proximity: false, matchedTerms: 0 };
  }
  const words = new Set(normalizedText.split(/\s+/).filter(Boolean));
  const compact = normalizedText.replace(/\s+/g, "");
  let score = 0;
  let matchedTerms = 0;
  for (const term of rankTerms) {
    if (words.has(term)) {
      score += 10;
      matchedTerms += 1;
    } else if (compact.includes(term)) {
      score += 7;
      matchedTerms += 1;
    } else if (normalizedText.includes(term)) {
      score += 4;
      matchedTerms += 1;
    }
  }
  let exactPhrase = false;
  let proximity = false;
  if (matchedTerms === rankTerms.length && rankTerms.length > 1) {
    score += 12;
    const normalizedPhrase = rankTerms.join(" ");
    if (normalizedText.includes(normalizedPhrase)) {
      score += 30;
      exactPhrase = true;
    } else {
      let fromIndex = 0;
      proximity = true;
      for (const term of rankTerms) {
        const termIndex = normalizedText.indexOf(term, fromIndex);
        if (termIndex < 0) {
          proximity = false;
          break;
        }
        fromIndex = termIndex + term.length;
      }
      if (proximity) score += 10;
    }
  }
  return { score, exactPhrase, proximity, matchedTerms };
}

function compareCandidateChunks(
  left: { chunk: StoredQueryIndexChunk; score: CandidateScore },
  right: { chunk: StoredQueryIndexChunk; score: CandidateScore },
): number {
  return (
    right.score.score - left.score.score ||
    Number(right.score.exactPhrase) - Number(left.score.exactPhrase) ||
    Number(right.score.proximity) - Number(left.score.proximity) ||
    right.score.matchedTerms - left.score.matchedTerms ||
    left.chunk.path.localeCompare(right.chunk.path) ||
    left.chunk.ordinal - right.chunk.ordinal
  );
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
      chunks = store.substringChunkCandidates(term, eligiblePaths);
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
  return [...directCandidates.values()]
    .map((chunk) => ({ chunk, score: scoreCandidateChunk(chunk.normalizedText, terms) }))
    .filter((candidate) => candidate.score.score > 0)
    .sort(compareCandidateChunks)
    .slice(0, QUERY_INDEX_CANDIDATE_ROW_LIMIT)
    .map((candidate) => candidate.chunk);
}
