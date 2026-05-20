import {
  executeJsQueryAsNativeMatches as executeJsQueryAsNativeMatchesViaPackage,
  type JsLanguage,
  type JsNativeMatch,
  type JsSyntaxTree,
} from "../jsFallback.js";
import type { LanguageSupport } from "../languages.js";
import type { NativeMatch, NativeRuntimeMode, UnifiedQueryExecution } from "./contracts.js";
import { getNativeSingleQueryExecution } from "./execution.js";
import { isNativeBindingLoadedForLanguage } from "./runtime.js";

const NATIVE_ONLY_JS_FAMILY_LANGUAGE_IDS = new Set(["js", "ts", "tsx"]);

export function shouldAvoidJsFallbackForLanguage(languageId: string): boolean {
  return NATIVE_ONLY_JS_FAMILY_LANGUAGE_IDS.has(languageId);
}

export function executeJsQueryAsNativeMatches(
  source: string,
  support: LanguageSupport,
  lang: JsLanguage,
  queryText: string,
  tree?: JsSyntaxTree,
): NativeMatch[] {
  return executeJsQueryAsNativeMatchesViaPackage(source, lang, queryText, tree) as NativeMatch[] & JsNativeMatch[];
}

export function getUnifiedQueryExecution(
  source: string,
  support: LanguageSupport,
  queryText: string,
  opts?: {
    tree?: JsSyntaxTree;
    mode?: NativeRuntimeMode;
    lang?: JsLanguage;
    getLanguage?: () => JsLanguage;
  },
): UnifiedQueryExecution {
  const nativeExecution = getNativeSingleQueryExecution(source, support, queryText, opts?.mode);
  if (nativeExecution.matches) {
    return {
      matches: nativeExecution.matches,
      backend: "native",
    };
  }
  if (shouldAvoidJsFallbackForLanguage(support.id) && isNativeBindingLoadedForLanguage(support.id, opts?.mode)) {
    return {
      matches: null,
      backend: "native",
      ...(nativeExecution.fallbackReason ? { fallbackReason: nativeExecution.fallbackReason } : {}),
      ...(nativeExecution.error ? { error: nativeExecution.error } : {}),
    };
  }
  try {
    const resolvedLang = opts?.lang ?? opts?.getLanguage?.();
    if (!resolvedLang) {
      throw new Error("JS query fallback requires a language");
    }
    const matches = executeJsQueryAsNativeMatches(source, support, resolvedLang, queryText, opts?.tree);
    return {
      matches,
      backend: "js",
      ...(nativeExecution.fallbackReason ? { fallbackReason: nativeExecution.fallbackReason } : {}),
      ...(nativeExecution.error ? { error: nativeExecution.error } : {}),
    };
  } catch (error) {
    return {
      matches: null,
      backend: "js",
      fallbackReason: nativeExecution.fallbackReason ?? "queryFailure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
