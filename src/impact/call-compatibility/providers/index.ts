import type { CallCompatibilityProvider } from "./types.js";

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

export const callCompatibilityProviders: readonly CallCompatibilityProvider[] = [];

export function isCallCompatibilityLanguageSupported(languageId: string): boolean {
  return callCompatibilityLanguageIds.includes(languageId as (typeof callCompatibilityLanguageIds)[number]);
}

export function getCallCompatibilitySupportedLanguages(): readonly string[] {
  return callCompatibilityLanguageIds;
}
