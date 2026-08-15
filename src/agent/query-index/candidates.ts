import { normalizeQuerySearchText } from "./content.js";
import {
  codePointLength,
  escapeFtsTrigramTerm,
  QUERY_INDEX_CANDIDATE_ROW_LIMIT,
  type QueryIndexStore,
  type StoredQueryIndexChunk,
} from "./store.js";

export const QUERY_INDEX_CANDIDATE_VERSION = 6;

export type QueryIndexCandidateScore = {
  score: number;
  matched: string[];
  exactPhrase: boolean;
  proximity: boolean;
  matchedTerms: number;
};

export type QueryIndexCandidate = StoredQueryIndexChunk & {
  score: QueryIndexCandidateScore;
  matchedLine: number;
};

function scoreCandidateChunk(normalizedText: string, rankTerms: readonly string[]): QueryIndexCandidateScore {
  if (!normalizedText.length || !rankTerms.length) {
    return { score: 0, matched: [], exactPhrase: false, proximity: false, matchedTerms: 0 };
  }
  const words = new Set(normalizedText.split(/\s+/).filter(Boolean));
  const compact = normalizedText.replace(/\s+/g, "");
  const matched: string[] = [];
  let score = 0;
  for (const term of rankTerms) {
    if (words.has(term)) {
      score += 10;
      matched.push(term);
    } else if (compact.includes(term)) {
      score += 7;
      matched.push(term);
    } else if (normalizedText.includes(term)) {
      score += 4;
      matched.push(term);
    }
  }
  let exactPhrase = false;
  let proximity = false;
  if (matched.length === rankTerms.length && rankTerms.length > 1) {
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
  return { score, matched, exactPhrase, proximity, matchedTerms: matched.length };
}

function firstMatchingLine(text: string, rankTerms: readonly string[]): number {
  const lines = text.split(/\r?\n/);
  const matchIndex = lines.findIndex(
    (line) => scoreCandidateChunk(normalizeQuerySearchText(line), rankTerms).score > 0,
  );
  return matchIndex >= 0 ? matchIndex : 0;
}

function compareCandidateChunks(left: QueryIndexCandidate, right: QueryIndexCandidate): number {
  return (
    right.score.score - left.score.score ||
    Number(right.score.exactPhrase) - Number(left.score.exactPhrase) ||
    Number(right.score.proximity) - Number(left.score.proximity) ||
    right.score.matchedTerms - left.score.matchedTerms ||
    left.path.localeCompare(right.path) ||
    left.ordinal - right.ordinal
  );
}

export function findQueryIndexChunkCandidates(
  store: QueryIndexStore,
  rankTerms: readonly string[],
): QueryIndexCandidate[] {
  const terms = rankTerms.filter((term) => term.length);
  const eligiblePaths = store.eligibleFilePaths(terms);
  return store
    .candidateChunksForTerms(terms, eligiblePaths)
    .map((chunk) => ({
      ...chunk,
      score: scoreCandidateChunk(chunk.normalizedText, terms),
      matchedLine: firstMatchingLine(chunk.text, terms),
    }))
    .filter((candidate) => candidate.score.score > 0)
    .sort(compareCandidateChunks)
    .slice(0, QUERY_INDEX_CANDIDATE_ROW_LIMIT);
}
