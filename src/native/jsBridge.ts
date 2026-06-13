import type { LanguageSupport } from "../languages.js";
import type { NativeRuntimeMode, UnifiedQueryExecution } from "./contracts.js";
import { getNativeSingleQueryExecution } from "./execution.js";

const REDUCED_MODE_REGEX_LANGUAGES: Record<string, true> = {
  js: true,
  ts: true,
  tsx: true,
};

export function supportsReducedModeRegexRecovery(languageId: string): boolean {
  return REDUCED_MODE_REGEX_LANGUAGES[languageId] === true;
}

export function getUnifiedQueryExecution(
  source: string,
  support: LanguageSupport,
  queryText: string,
  opts?: {
    mode?: NativeRuntimeMode;
  },
): UnifiedQueryExecution {
  const nativeExecution = getNativeSingleQueryExecution(source, support, queryText, opts?.mode);
  if (nativeExecution.matches) {
    return {
      matches: nativeExecution.matches,
      backend: "native",
    };
  }
  return {
    matches: null,
    backend: "native",
    ...(nativeExecution.fallbackReason ? { fallbackReason: nativeExecution.fallbackReason } : {}),
    ...(nativeExecution.error ? { error: nativeExecution.error } : {}),
  };
}
