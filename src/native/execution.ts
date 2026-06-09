import type { LanguageSupport } from "../languages.js";
import { stringifyUnknown } from "../util/ast.js";
import type {
  CompactImportsExecution,
  NativeBindingState,
  NativeQueryExecution,
  NativeDuplicateTokens,
  NativeQueryResults,
  NativeQueryScope,
  NativeRuntimeMode,
  NativeSingleQueryExecution,
  NativeSyntaxTreeExecution,
} from "./contracts.js";
import { getCachedNormalizedQuery, normalizeNativeQueryForSupport } from "./queries.js";
import { loadBinding, resolveNativeBindingState, throwIfNativeRequiredUnavailable } from "./runtime.js";

export function isNativeDuplicateTokenizationAvailable(mode?: NativeRuntimeMode): boolean {
  const state = resolveNativeBindingState(mode);
  throwIfNativeRequiredUnavailable(mode, state);
  return state.loaded && typeof state.binding.tokenizeDuplicateSource === "function";
}


export function getNativeDuplicateTokens(source: string, mode?: NativeRuntimeMode): NativeDuplicateTokens | null {
  const state = resolveNativeBindingState(mode);
  throwIfNativeRequiredUnavailable(mode, state);
  if (!state.loaded || !state.binding.tokenizeDuplicateSource) return null;
  try {
    return state.binding.tokenizeDuplicateSource(source);
  } catch {
    return null;
  }
}
export function runNativeLanguageQueries(
  source: string,
  support: LanguageSupport,
  mode?: NativeRuntimeMode,
): NativeQueryResults | null {
  return getNativeQueryExecution(source, support, mode).results;
}

export function getNativeQueryExecutionForState(
  source: string,
  support: LanguageSupport,
  state: NativeBindingState = loadBinding(),
  scope: NativeQueryScope = "full",
): NativeQueryExecution {
  if (!state.loaded) {
    return unavailableQueryExecution(state);
  }
  if (!state.supportedLanguageIds.has(support.id)) {
    return { results: null, fallbackReason: "unsupportedLanguage" };
  }
  const importsOnly = scope === "imports";
  try {
    return {
      results: state.binding.runLanguageQueries(
        source,
        support.id,
        getCachedNormalizedQuery(support, "imports"),
        importsOnly ? "" : getCachedNormalizedQuery(support, "exports"),
        importsOnly ? "" : getCachedNormalizedQuery(support, "locals"),
        importsOnly ? "" : getCachedNormalizedQuery(support, "importBindings"),
      ),
    };
  } catch (error) {
    return {
      results: null,
      fallbackReason: "queryFailure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getNativeQueryExecution(
  source: string,
  support: LanguageSupport,
  mode?: NativeRuntimeMode,
  scope: NativeQueryScope = "full",
): NativeQueryExecution {
  const state = resolveNativeBindingState(mode);
  throwIfNativeRequiredUnavailable(mode, state);
  return getNativeQueryExecutionForState(source, support, state, scope);
}

/**
 * Run only the imports query with a compact payload (name + text only).
 * Falls back to the full execution path if the compact entrypoint is not
 * available in the native binding.
 */
export function getCompactImportsExecution(
  source: string,
  support: LanguageSupport,
  mode?: NativeRuntimeMode,
): CompactImportsExecution {
  const state = resolveNativeBindingState(mode);
  throwIfNativeRequiredUnavailable(mode, state);
  if (!state.loaded) {
    return unavailableCompactExecution(state);
  }
  if (!state.supportedLanguageIds.has(support.id)) {
    return { results: null, fallbackReason: "unsupportedLanguage" };
  }
  const importsQuery = getCachedNormalizedQuery(support, "imports");
  try {
    if (state.binding.runImportsQueryCompact) {
      return {
        results: state.binding.runImportsQueryCompact(source, support.id, importsQuery),
      };
    }
    const full = getNativeQueryExecutionForState(source, support, state, "imports");
    if (!full.results) return full;
    return {
      results: {
        imports: full.results.imports.map((match) => ({
          patternIndex: match.patternIndex,
          captures: match.captures.map((capture) => ({ name: capture.name, text: capture.text })),
        })),
      },
    };
  } catch (error) {
    return {
      results: null,
      fallbackReason: "queryFailure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getNativeSingleQueryExecution(
  source: string,
  support: LanguageSupport,
  queryText: string,
  mode?: NativeRuntimeMode,
): NativeSingleQueryExecution {
  const state = resolveNativeBindingState(mode);
  throwIfNativeRequiredUnavailable(mode, state);
  if (!state.loaded) {
    return unavailableSingleQueryExecution(state);
  }
  if (!state.supportedLanguageIds.has(support.id)) {
    return { matches: null, fallbackReason: "unsupportedLanguage" };
  }
  if (!state.binding.runQuery) {
    return {
      matches: null,
      fallbackReason: "unavailable",
      error: "native binding does not expose runQuery",
    };
  }
  const normalizedQuery = normalizeNativeQueryForSupport(support, "adHoc", queryText);
  try {
    return {
      matches: state.binding.runQuery(source, support.id, normalizedQuery).matches,
    };
  } catch (error) {
    return {
      matches: null,
      fallbackReason: "queryFailure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getNativeSyntaxTreeExecution(
  source: string,
  support: LanguageSupport,
  mode?: NativeRuntimeMode,
): NativeSyntaxTreeExecution {
  const state = resolveNativeBindingState(mode);
  throwIfNativeRequiredUnavailable(mode, state);
  if (!state.loaded) {
    return unavailableSyntaxTreeExecution(state);
  }
  if (!state.supportedLanguageIds.has(support.id)) {
    return { tree: null, fallbackReason: "unsupportedLanguage" };
  }
  if (!state.binding.parseSyntaxTree) {
    return {
      tree: null,
      fallbackReason: "unavailable",
      error: "native binding does not expose parseSyntaxTree",
    };
  }
  try {
    return {
      tree: state.binding.parseSyntaxTree(source, support.id),
    };
  } catch (error) {
    return {
      tree: null,
      fallbackReason: "queryFailure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function unavailableQueryExecution(state: Extract<NativeBindingState, { loaded: false }>): NativeQueryExecution {
  return {
    results: null,
    ...unavailableNativeFailure(state),
  };
}

function unavailableCompactExecution(state: Extract<NativeBindingState, { loaded: false }>): CompactImportsExecution {
  return {
    results: null,
    ...unavailableNativeFailure(state),
  };
}

function unavailableSingleQueryExecution(
  state: Extract<NativeBindingState, { loaded: false }>,
): NativeSingleQueryExecution {
  return {
    matches: null,
    ...unavailableNativeFailure(state),
  };
}

function unavailableSyntaxTreeExecution(
  state: Extract<NativeBindingState, { loaded: false }>,
): NativeSyntaxTreeExecution {
  return {
    tree: null,
    ...unavailableNativeFailure(state),
  };
}

function unavailableNativeFailure(state: Extract<NativeBindingState, { loaded: false }>): {
  fallbackReason: "unavailable";
  error?: string;
} {
  if (!state.error) {
    return { fallbackReason: "unavailable" };
  }
  if (state.error instanceof Error) {
    return { fallbackReason: "unavailable", error: state.error.message };
  }
  return { fallbackReason: "unavailable", error: stringifyUnknown(state.error) };
}
