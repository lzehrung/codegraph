import { normalizeQuerySearchText } from "./query-index/content.js";

export type SearchQueryTerms = {
  tokens: string[];
  rankTokens: string[];
  normalizedRankPhrase: string;
  identifierLike: boolean;
};

export type TokenMatch = {
  score: number;
  matched: string[];
  exactPhrase: boolean;
  proximity: boolean;
};

/** A normalized search field and its separator-free form, prepared once so queries only compare strings. */
export type SearchField = {
  readonly normalized: string;
  readonly compact: string;
};

export function emptyTokenMatch(): TokenMatch {
  return { score: 0, matched: [], exactPhrase: false, proximity: false };
}

export function prepareSearchField(text: string): SearchField {
  const normalized = normalizeQuerySearchText(text);
  return { normalized, compact: normalized.replace(/\s+/g, "") };
}

/**
 * Whether a field can score above zero for these rank tokens. A token scores through a whole word, the compact
 * text, or the normalized text, and rank tokens hold no whitespace, so every scoring branch implies that the token
 * occurs in the compact text. The test is exact: it admits the fields that score and none that do not.
 */
export function searchFieldMayMatch(compact: string, rankTokens: readonly string[]): boolean {
  for (const token of rankTokens) {
    if (compact.includes(token)) return true;
  }
  return false;
}

/** Normalized text holds single spaces between words, so a whole word is a token bounded by spaces or the ends. */
function hasWholeWord(normalized: string, token: string): boolean {
  if (!token) return false;
  let index = normalized.indexOf(token);
  while (index !== -1) {
    const end = index + token.length;
    const startsWord = index === 0 || normalized.charCodeAt(index - 1) === 32;
    const endsWord = end === normalized.length || normalized.charCodeAt(end) === 32;
    if (startsWord && endsWord) return true;
    index = normalized.indexOf(token, index + 1);
  }
  return false;
}

export function matchNormalizedField(normalized: string, compact: string, query: SearchQueryTerms): TokenMatch {
  if (!normalized) return emptyTokenMatch();
  const matched: string[] = [];
  let score = 0;

  for (const token of query.rankTokens) {
    if (hasWholeWord(normalized, token)) {
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

export function matchSearchField(field: SearchField, query: SearchQueryTerms): TokenMatch {
  return matchNormalizedField(field.normalized, field.compact, query);
}

export function matchTokenScoreFromNormalized(normalized: string, query: SearchQueryTerms): TokenMatch {
  return matchNormalizedField(normalized, normalized.replace(/\s+/g, ""), query);
}

export function matchTokenScore(text: string, query: SearchQueryTerms): TokenMatch {
  return matchSearchField(prepareSearchField(text), query);
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

/** Distinct matched rank tokens across fields. Each list holds a token at most once. */
export function countMatchedTerms(
  first: readonly string[],
  second: readonly string[],
  third: readonly string[],
): number {
  let count = first.length;
  for (const term of second) {
    if (!first.includes(term)) count += 1;
  }
  for (const term of third) {
    if (!first.includes(term) && !second.includes(term)) count += 1;
  }
  return count;
}
