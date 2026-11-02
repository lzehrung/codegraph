import { normalizeQuerySearchText } from "../../src/agent/query-index/content.js";
import type { SearchQueryTerms, TokenMatch } from "../../src/agent/search-scoring.js";

/** Rank terms for a query without natural-language stop words or repeated tokens. */
export function queryTerms(input: string): SearchQueryTerms {
  const tokens = Array.from(
    new Set(
      normalizeQuerySearchText(input)
        .split(/\s+/)
        .filter((token) => token.length),
    ),
  );
  return { tokens, rankTokens: tokens, normalizedRankPhrase: tokens.join(" "), identifierLike: false };
}

/** The scorer written as a plain scan: a word set and a compact string built for every text and query. */
export function scanScore(text: string, query: SearchQueryTerms): TokenMatch {
  const normalized = normalizeQuerySearchText(text);
  if (!normalized) return { score: 0, matched: [], exactPhrase: false, proximity: false };
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
    } else {
      let from = 0;
      const inOrder = query.rankTokens.every((token) => {
        const at = normalized.indexOf(token, from);
        if (at < 0) return false;
        from = at + token.length;
        return true;
      });
      if (inOrder) {
        score += 10;
        proximity = true;
      }
    }
  }
  return { score, matched, exactPhrase, proximity };
}
