import "../../../languages/all.js";
import { getLanguageById } from "../../../languages/registry.js";
import {
  CALL_COMPATIBILITY_LANGUAGE_ID_DECLARATIONS,
  CALL_COMPATIBILITY_LANGUAGE_PROFILES,
  type CallCompatibilityLanguageId,
  type CallCompatibilityLanguageProfile,
} from "./profiles.js";
import type { CallCompatibilityProvider, ExtractCallsiteRequest, ExtractSignatureRequest } from "./types.js";
import type { CallableSignature, CallsiteArguments } from "../types.js";

/**
 * Source languages the structural extractor understands, declared and documented in
 * `./profiles.js` and filtered through the registry here: a stale id such as the old
 * `javascript`/`typescript`/`jsx` spellings can never be reported as supported.
 * `tests/language-capability-registry.test.ts` asserts every declaration is registered.
 */
export const callCompatibilityLanguageIdDeclarations: readonly string[] = CALL_COMPATIBILITY_LANGUAGE_ID_DECLARATIONS;

export const callCompatibilityLanguageIds: readonly string[] = CALL_COMPATIBILITY_LANGUAGE_ID_DECLARATIONS.filter(
  (languageId) => getLanguageById(languageId) !== undefined,
);

/**
 * Resolved arity profile for a supported language, or null when the id is not a registered
 * call-compatibility language. The extractors branch on this profile, never on language ids.
 */
export function getCallCompatibilityLanguageProfile(languageId: string): CallCompatibilityLanguageProfile | null {
  if (!callCompatibilityLanguageIds.includes(languageId)) {
    return null;
  }
  return CALL_COMPATIBILITY_LANGUAGE_PROFILES[languageId as CallCompatibilityLanguageId];
}

interface RegisteredCallCompatibilityExtractors {
  extractSignature(request: ExtractSignatureRequest): CallableSignature | null;
  extractCallsite(request: ExtractCallsiteRequest): CallsiteArguments | null;
}

let registeredExtractors: RegisteredCallCompatibilityExtractors | null = null;

export function registerCallCompatibilityExtractors(extractors: RegisteredCallCompatibilityExtractors): void {
  registeredExtractors = extractors;
}

const structuralCallCompatibilityProvider: CallCompatibilityProvider = {
  languageIds: callCompatibilityLanguageIds,
  extractSignature(request) {
    if (!registeredExtractors) {
      return null;
    }
    return registeredExtractors.extractSignature(request);
  },
  extractCallsite(request) {
    if (!registeredExtractors) {
      return null;
    }
    return registeredExtractors.extractCallsite(request);
  },
  limitations() {
    return [];
  },
};

export const callCompatibilityProviders: readonly CallCompatibilityProvider[] = [structuralCallCompatibilityProvider];

export function getCallCompatibilityProvider(languageId: string): CallCompatibilityProvider | null {
  for (const provider of callCompatibilityProviders) {
    if (provider.languageIds.includes(languageId)) {
      return provider;
    }
  }
  return null;
}

export function isCallCompatibilityLanguageSupported(languageId: string): boolean {
  return getCallCompatibilityProvider(languageId) !== null;
}

export function getCallCompatibilitySupportedLanguages(): readonly string[] {
  return callCompatibilityLanguageIds;
}
