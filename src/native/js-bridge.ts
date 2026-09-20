import type { LanguageSupport } from "../languages.js";
import type { NativeRuntimeMode, UnifiedQueryExecution } from "./contracts.js";
import { getNativeSingleQueryExecution } from "./execution.js";

/**
 * Whether the reduced-mode fallback reason for `languageId` is labelled `reduced-mode` rather
 * than the generic `unavailable`.
 *
 * This is a labelling predicate only. It no longer decides which languages can recover imports
 * without the native addon: that is the shared text extractor registry
 * (`src/indexer/imports/text-import-extractors.ts`), which the graph path and the indexer's
 * binding recovery both run. Keep the two apart so diagnostics cannot claim a parser ran when
 * it did not, or hide a fallback that really did.
 */
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
