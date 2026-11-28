import { normalizeQuerySearchText } from "./content.js";
import { QUERY_INDEX_CANDIDATE_ROW_LIMIT, type QueryIndexStore, type StoredQueryIndexChunk } from "./store.js";
import { matchNormalizedField } from "../search-scoring.js";
import { compareStrings } from "../../util/strings.js";

export const QUERY_INDEX_CANDIDATE_VERSION = 7;

export type QueryIndexCandidateScore = {
  score: number;
  matched: string[];
  exactPhrase: boolean;
  proximity: boolean;
  matchedTerms: number;
};

export type QueryIndexCandidate = StoredQueryIndexChunk & {
  score: QueryIndexCandidateScore;
};

export type QueryIndexCandidateResult = {
  candidates: QueryIndexCandidate[];
  totalCandidates: number;
  totalCandidatesLowerBound: boolean;
  omittedCandidates: number;
};

/** A stored chunk's normalized text holds single spaces between words, as the shared search scorer expects. */
function scoreCandidateChunk(
  normalizedText: string,
  rankTerms: readonly string[],
  normalizedRankPhrase = rankTerms.join(" "),
): QueryIndexCandidateScore {
  const match = matchNormalizedField(normalizedText, undefined, { rankTokens: rankTerms, normalizedRankPhrase });
  return { ...match, matchedTerms: match.matched.length };
}

/** The first line of a candidate's text that scores for the terms, or the first line when none does. */
export function firstMatchingLine(
  text: string,
  rankTerms: readonly string[],
  normalizedRankPhrase = rankTerms.join(" "),
): number {
  const lines = text.split(/\r?\n/);
  const matchIndex = lines.findIndex(
    (line) => scoreCandidateChunk(normalizeQuerySearchText(line), rankTerms, normalizedRankPhrase).score > 0,
  );
  return matchIndex >= 0 ? matchIndex : 0;
}

function compareCandidateChunks(left: QueryIndexCandidate, right: QueryIndexCandidate): number {
  return (
    right.score.score - left.score.score ||
    Number(right.score.exactPhrase) - Number(left.score.exactPhrase) ||
    Number(right.score.proximity) - Number(left.score.proximity) ||
    right.score.matchedTerms - left.score.matchedTerms ||
    compareStrings(left.path, right.path) ||
    left.ordinal - right.ordinal
  );
}

export function findQueryIndexChunkCandidates(
  store: QueryIndexStore,
  rankTerms: readonly string[],
  normalizedRankPhrase = rankTerms.join(" "),
): QueryIndexCandidateResult {
  const terms = rankTerms.filter((term) => term.length);
  const eligiblePaths = store.eligibleFilePaths(terms);
  const retrieval = store.candidateChunkRetrievalForTerms(terms, eligiblePaths, normalizedRankPhrase);
  const ranked = retrieval.chunks
    .map((chunk) => ({
      ...chunk,
      score: scoreCandidateChunk(chunk.normalizedText, terms, normalizedRankPhrase),
    }))
    .filter((candidate) => candidate.score.score > 0)
    .sort(compareCandidateChunks);
  const candidates = ranked.slice(0, QUERY_INDEX_CANDIDATE_ROW_LIMIT);
  const totalCandidates = ranked.length;
  return {
    candidates,
    totalCandidates,
    totalCandidatesLowerBound: retrieval.totalCandidatesLowerBound,
    omittedCandidates: Math.max(0, totalCandidates - candidates.length),
  };
}
