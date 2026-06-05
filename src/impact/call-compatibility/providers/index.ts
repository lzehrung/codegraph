import type { CallCompatibilityProvider, ExtractCallsiteRequest, ExtractSignatureRequest } from "./types.js";
import type { CallableSignature, CallsiteArguments } from "../types.js";

export const callCompatibilityLanguageIds = [
  "c",
  "cpp",
  "csharp",
  "go",
  "java",
  "javascript",
  "js",
  "jsx",
  "kotlin",
  "php",
  "python",
  "ruby",
  "rust",
  "swift",
  "ts",
  "tsx",
  "typescript",
  "zig",
] as const;

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
