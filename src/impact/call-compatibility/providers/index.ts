import "../../../languages/all.js";
import { getLanguageById } from "../../../languages/registry.js";
import type { CallCompatibilityProvider, ExtractCallsiteRequest, ExtractSignatureRequest } from "./types.js";
import type { CallableSignature, CallsiteArguments } from "../types.js";

/**
 * Source languages the structural extractor understands. The registry has no call-compatibility
 * flag, so the list is declared here and filtered through the registry: a stale id such as the
 * old `javascript`/`typescript`/`jsx` spellings can never be reported as supported.
 * `tests/language-capability-registry.test.ts` asserts every declaration is registered.
 */
const CALL_COMPATIBILITY_LANGUAGE_ID_DECLARATIONS = [
  "c",
  "cpp",
  "csharp",
  "go",
  "java",
  "js",
  "kotlin",
  "php",
  "python",
  "ruby",
  "rust",
  "swift",
  "ts",
  "tsx",
  "zig",
] as const;

export const callCompatibilityLanguageIdDeclarations: readonly string[] =
  CALL_COMPATIBILITY_LANGUAGE_ID_DECLARATIONS;

export const callCompatibilityLanguageIds: readonly string[] = CALL_COMPATIBILITY_LANGUAGE_ID_DECLARATIONS.filter(
  (languageId) => getLanguageById(languageId) !== undefined,
);

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
