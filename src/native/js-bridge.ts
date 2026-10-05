import type { LanguageSupport } from "../languages.js";
import type { UnifiedQueryExecution } from "./contracts.js";
import { getNativeSingleQueryExecution } from "./execution.js";

export function getUnifiedQueryExecution(
  source: string,
  support: LanguageSupport,
  queryText: string,
): UnifiedQueryExecution {
  const nativeExecution = getNativeSingleQueryExecution(source, support, queryText);
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
