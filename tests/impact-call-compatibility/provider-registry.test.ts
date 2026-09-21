import { describe, expect, it } from "vitest";

import "../../src/languages/all.js";
import { GRAPH_ONLY_LANGUAGE_IDS } from "../../src/document-links/language-ids.js";
import {
  callCompatibilityLanguageIdDeclarations,
  callCompatibilityProviders,
  getCallCompatibilityLanguageProfile,
  getCallCompatibilityProvider,
  getCallCompatibilitySupportedLanguages,
  isCallCompatibilityLanguageSupported,
} from "../../src/impact/call-compatibility/providers/index.js";
import { CALL_COMPATIBILITY_LANGUAGE_PROFILES } from "../../src/impact/call-compatibility/providers/profiles.js";
import { getAllLanguages, getLanguageById } from "../../src/languages/registry.js";

/**
 * Registered languages that have no callable function signatures for the structural extractor.
 * Every other registered language must be supported, so registering a new source language fails
 * this test until the provider list (and its registry derivation) includes it.
 */
const NON_CALLABLE_LANGUAGE_IDS: Record<string, string> = {
  css: "stylesheet",
  html: "document format",
  less: "stylesheet",
  scss: "stylesheet",
  sql: "SQL object facts, not callable symbols",
  svelte: "SFC document; script blocks parse as js/ts and templates as HTML",
  vue: "SFC document; script blocks parse as js/ts and templates as HTML",
};

describe("call compatibility provider registry", () => {
  it("covers exactly the registered languages with callable declarations", () => {
    const expected = getAllLanguages()
      .map((definition) => definition.id)
      .filter(
        (languageId) => !GRAPH_ONLY_LANGUAGE_IDS.has(languageId) && NON_CALLABLE_LANGUAGE_IDS[languageId] === undefined,
      )
      .sort();
    expect([...getCallCompatibilitySupportedLanguages()].sort()).toEqual(expected);
  });

  it("routes supported languages through registered providers", () => {
    expect(callCompatibilityProviders).toHaveLength(1);
    expect(getCallCompatibilityProvider("ts")).toBe(callCompatibilityProviders[0]);
    expect(getCallCompatibilityProvider("python")).toBe(callCompatibilityProviders[0]);
    expect(getCallCompatibilityProvider("markdown")).toBeNull();
  });

  it("never claims the unregistered javascript, typescript, or jsx ids", () => {
    for (const languageId of ["javascript", "typescript", "jsx"]) {
      expect(isCallCompatibilityLanguageSupported(languageId)).toBe(false);
      expect(getCallCompatibilityProvider(languageId)).toBeNull();
    }
  });

  it("does not claim graph-only or SQL call compatibility support", () => {
    expect(isCallCompatibilityLanguageSupported("markdown")).toBeFalsy();
    expect(isCallCompatibilityLanguageSupported("css")).toBeFalsy();
    expect(isCallCompatibilityLanguageSupported("sql")).toBeFalsy();
  });

  it("keys the profile table to exactly the declared call-compatibility languages", () => {
    expect(Object.keys(CALL_COMPATIBILITY_LANGUAGE_PROFILES).sort()).toEqual(
      [...callCompatibilityLanguageIdDeclarations].sort(),
    );
    for (const languageId of Object.keys(CALL_COMPATIBILITY_LANGUAGE_PROFILES)) {
      expect(getLanguageById(languageId), `${languageId} is not a registered language`).toBeDefined();
    }
  });

  it("resolves one profile for every supported language and none for unsupported ids", () => {
    for (const languageId of getCallCompatibilitySupportedLanguages()) {
      expect(getCallCompatibilityLanguageProfile(languageId), `${languageId} has no profile`).not.toBeNull();
    }
    for (const languageId of ["javascript", "typescript", "jsx", "markdown"]) {
      expect(getCallCompatibilityLanguageProfile(languageId)).toBeNull();
    }
  });
});
