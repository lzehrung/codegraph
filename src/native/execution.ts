import type { LanguageSupport } from "../languages.js";
import { stringifyUnknown } from "../util/ast.js";
import { errorMessage } from "../util/errors.js";
import type {
  CompactImportsExecution,
  NativeBindingState,
  NativeQueryExecution,
  NativeDuplicateTokens,
  NativeExtractionExecution,
  NativeQueryResults,
  NativeQueryScope,
  NativeRuntimeMode,
  NativeSingleQueryExecution,
  NativeSyntaxTreeExecution,
} from "./contracts.js";
import { getCachedNormalizedQuery, normalizeNativeQueryForSupport } from "./queries.js";
import { loadBinding, resolveNativeBindingState, throwIfNativeRequiredUnavailable } from "./runtime.js";
import { isColumnarSyntaxTree, nativeShapeMismatchMessage, REQUIRED_NATIVE_EXTRACTION_VERSION } from "./treeShape.js";

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
      error: errorMessage(error),
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
      error: errorMessage(error),
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
      error: errorMessage(error),
    };
  }
}

/**
 * Runs the full query set and projects the syntax tree from one Tree-sitter parse.
 * Prefer this over calling {@link getNativeQueryExecution} and
 * {@link getNativeSyntaxTreeExecution} on the same source: each parses independently,
 * so calling both parses the file twice for no benefit. This is what the native worker
 * pool already uses (`extractLanguage`, one parse per file); this is the same call for
 * callers that need both results outside a worker.
 */
export function getNativeExtractionExecution(
  source: string,
  support: LanguageSupport,
  mode?: NativeRuntimeMode,
): NativeExtractionExecution {
  const state = resolveNativeBindingState(mode);
  throwIfNativeRequiredUnavailable(mode, state);
  if (!state.loaded) {
    return { results: null, tree: null, ...unavailableNativeFailure(state) };
  }
  if (!state.supportedLanguageIds.has(support.id)) {
    return { results: null, tree: null, fallbackReason: "unsupportedLanguage" };
  }
  if (typeof state.binding.extractLanguage !== "function") {
    return {
      results: null,
      tree: null,
      fallbackReason: "unavailable",
      error:
        `@lzehrung/codegraph-native >= ${REQUIRED_NATIVE_EXTRACTION_VERSION} is required; ` +
        "the installed native binary does not provide extractLanguage. Reinstall the native package.",
    };
  }
  try {
    const extraction = state.binding.extractLanguage(
      source,
      support.id,
      getCachedNormalizedQuery(support, "imports"),
      getCachedNormalizedQuery(support, "exports"),
      getCachedNormalizedQuery(support, "locals"),
      getCachedNormalizedQuery(support, "importBindings"),
    );
    const tree = extraction.syntaxTree ?? null;
    // A missing tree is a tolerated state; a present-but-legacy tree means the installed
    // native package predates the columnar projection and cannot be read here. Query
    // results are unaffected by that mismatch, so they still come back.
    if (tree !== null && !isColumnarSyntaxTree(tree)) {
      return {
        results: extraction.results,
        tree: null,
        fallbackReason: "unavailable",
        error: nativeShapeMismatchMessage(),
      };
    }
    return { results: extraction.results, tree };
  } catch (error) {
    return {
      results: null,
      tree: null,
      fallbackReason: "queryFailure",
      error: errorMessage(error),
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
    const tree = state.binding.parseSyntaxTree(source, support.id) ?? null;
    // A missing tree is a tolerated state; a present-but-legacy tree means the installed
    // native package predates the columnar projection and cannot be read here.
    if (tree !== null && !isColumnarSyntaxTree(tree)) {
      return { tree: null, fallbackReason: "unavailable", error: nativeShapeMismatchMessage() };
    }
    return { tree };
  } catch (error) {
    return {
      tree: null,
      fallbackReason: "queryFailure",
      error: errorMessage(error),
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
