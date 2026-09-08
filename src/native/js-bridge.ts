import type { LanguageSupport } from "../languages.js";
import type { NativeRuntimeMode, UnifiedQueryExecution } from "./contracts.js";
import { getNativeSingleQueryExecution } from "./execution.js";

export function supportsReducedModeRegexRecovery(languageId: string): boolean {
  return languageId === "js" || languageId === "ts" || languageId === "tsx";
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
