import { describe, expect, it } from "vitest";

import "../src/languages/all.js";
import {
  callCompatibilityLanguageIdDeclarations,
  callCompatibilityLanguageIds,
  getCallCompatibilityProvider,
} from "../src/impact/call-compatibility/providers/index.js";
import { receiverKeywordLanguageIds, staticMemberLanguageIds } from "../src/graphs/symbol-graph-detailed/receiver-calls.js";
import { isJsTsLanguage, jsFamilyLanguageIdDeclarations } from "../src/languages/js-family.js";
import { getAllLanguages } from "../src/languages/registry.js";

const registeredLanguageIds = new Set(getAllLanguages().map((definition) => definition.id));

/**
 * Formats whose script blocks are re-parsed as their own language, so an entry for the document
 * id itself can never fire in a parser-driven capability list. `.vue` and `.svelte` scripts parse
 * as js/ts, their templates as HTML, and their styles as CSS.
 */
const DOCUMENT_FORMAT_LANGUAGE_IDS: Record<string, true> = {
  adoc: true,
  astro: true,
  hbs: true,
  html: true,
  markdown: true,
  mdx: true,
  rst: true,
  svelte: true,
  vue: true,
};

/** Capability lists that declare ids and then resolve them through the registry. */
const derivedCapabilityLists = [
  {
    name: "call compatibility",
    declaredIds: callCompatibilityLanguageIdDeclarations,
    resolvedIds: callCompatibilityLanguageIds,
  },
  {
    name: "ECMAScript family",
    declaredIds: jsFamilyLanguageIdDeclarations,
    resolvedIds: jsFamilyLanguageIdDeclarations.filter((languageId) => isJsTsLanguage(languageId)),
  },
];

/** Capability lists whose ids are the keys of a per-language table. */
const directCapabilityLists = [
  { name: "receiver keywords", languageIds: receiverKeywordLanguageIds },
  { name: "static members", languageIds: staticMemberLanguageIds },
];

describe("language capability registry consistency", () => {
  it("names only registered languages in every capability list", () => {
    for (const list of [...derivedCapabilityLists, ...directCapabilityLists]) {
      const languageIds = "declaredIds" in list ? list.declaredIds : list.languageIds;
      for (const languageId of languageIds) {
        expect(
          registeredLanguageIds.has(languageId),
          `${list.name} names unregistered language id ${languageId}`,
        ).toBe(true);
      }
    }
  });

  it("resolves every declared capability id through the registry", () => {
    for (const list of derivedCapabilityLists) {
      expect(new Set(list.resolvedIds), `${list.name} dropped declared ids`).toEqual(new Set(list.declaredIds));
    }
  });

  it("keeps document formats out of parser capability lists", () => {
    for (const list of [...derivedCapabilityLists, ...directCapabilityLists]) {
      const languageIds = "resolvedIds" in list ? list.resolvedIds : list.languageIds;
      for (const languageId of languageIds) {
        expect(
          DOCUMENT_FORMAT_LANGUAGE_IDS[languageId],
          `${list.name} lists document format ${languageId}`,
        ).toBeUndefined();
      }
    }
  });

  it("rejects the unregistered javascript, typescript, and jsx spellings", () => {
    for (const languageId of ["javascript", "typescript", "jsx"]) {
      expect(registeredLanguageIds.has(languageId)).toBe(false);
      expect(isJsTsLanguage(languageId)).toBe(false);
      expect(callCompatibilityLanguageIds).not.toContain(languageId);
      expect(getCallCompatibilityProvider(languageId)).toBeNull();
    }
  });
});
