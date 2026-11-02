import { describe, expect, it } from "vitest";
import { normalizeQuerySearchText } from "../src/agent/query-index/content.js";
import {
  matchTokenScore,
  matchTokenScoreFromNormalized,
  prepareSearchField,
  searchFieldMayMatch,
} from "../src/agent/search-scoring.js";
import { queryTerms, scanScore } from "./helpers/search-scan.js";

// Non-ASCII values are escapes so the file stays typeable; each still exercises real multi-byte text.
const TEXTS = [
  "getUserId",
  "parseJSONResponse",
  "XMLHttpRequest",
  "snake_case_helper",
  "validate",
  "ID",
  "id",
  "x",
  "user id",
  "id user",
  "identity",
  "idle",
  "src/idle/worker.ts",
  "node_modules/@scope/pkg/index.ts",
  "docs/agent-search.md",
  "Returns the user id for a session token.",
  "r\u00e9sum\u00e9",
  "Stra\u00dfe",
  "\u65e5\u672c\u8a9e\u30d1\u30fc\u30b5\u30fc",
  "caf\u00e9-\u65e5\u672c.ts",
  "a_b",
  "",
  "   ",
  "---",
];

const QUERIES = [
  "id",
  "user id",
  "userid",
  "id user",
  "uid",
  "ui",
  "json",
  "case helper",
  "x",
  "idle",
  "ty",
  "agent search",
  "r\u00e9sum\u00e9",
  "resume",
  "stra\u00dfe",
  "\u65e5\u672c",
  "\u672c\u8a9e",
  "snake case",
  "http request",
  "a b",
];

describe("search field scoring", () => {
  it("scores every field and query like a plain scan of the text", () => {
    for (const text of TEXTS) {
      for (const query of QUERIES) {
        const terms = queryTerms(query);
        expect(matchTokenScore(text, terms), `${JSON.stringify(text)} for ${JSON.stringify(query)}`).toEqual(
          scanScore(text, terms),
        );
        expect(matchTokenScoreFromNormalized(normalizeQuerySearchText(text), terms)).toEqual(scanScore(text, terms));
      }
    }
  });

  it("admits exactly the fields that score above zero, including tokens shorter than a trigram and cross-word runs", () => {
    let scoring = 0;
    let rejected = 0;
    for (const text of TEXTS) {
      const field = prepareSearchField(text);
      for (const query of QUERIES) {
        const terms = queryTerms(query);
        const scores = scanScore(text, terms).score > 0;
        expect(searchFieldMayMatch(field.compact, terms.rankTokens), `${JSON.stringify(text)} for ${query}`).toBe(
          scores,
        );
        if (scores) scoring += 1;
        else rejected += 1;
      }
    }
    expect(scoring).toBeGreaterThan(20);
    expect(rejected).toBeGreaterThan(20);

    // A two-character token and a token spanning two words both score by compact text, so a trigram index would drop them.
    expect(scanScore("getUserId", queryTerms("id")).score).toBeGreaterThan(0);
    expect(scanScore("getUserId", queryTerms("userid")).score).toBeGreaterThan(0);
    expect(searchFieldMayMatch(prepareSearchField("getUserId").compact, ["id"])).toBe(true);
    expect(searchFieldMayMatch(prepareSearchField("getUserId").compact, ["userid"])).toBe(true);
    expect(searchFieldMayMatch(prepareSearchField("getUserId").compact, ["users"])).toBe(false);
  });
});
