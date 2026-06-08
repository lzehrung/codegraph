export type {
  CompactCapture,
  CompactImportsExecution,
  CompactMatch,
  CompactQueryResults,
  NativeBinding,
  NativeCapture,
  NativeFallbackReason,
  NativeMatch,
  NativeDuplicateTokens,
  NativePoint,
  NativeQueryExecution,
  NativeQueryResults,
  NativeQueryScope,
  NativeRuntimeMode,
  NativeSingleQueryExecution,
  NativeSyntaxNode,
  NativeSyntaxTree,
  NativeSyntaxTreeExecution,
  UnifiedQueryExecution,
} from "./contracts.js";

export {
  __resetNativeTreeSitterBindingForTests,
  assertNativeRequiredAvailable,
  getNativeTreeSitterLoadError,
  getNativeTreeSitterSupportedLanguageIds,
  isNativeBindingLoadedForLanguage,
  isNativeRequiredUnavailableError,
  isNativeTreeSitterAvailable,
  isNativeTreeSitterDisabledByEnv,
} from "./runtime.js";

export {
  getCachedNormalizedQuery,
  getNativeQueryMetadataForSupport,
  isNativeQueryAuthoritative,
  isNativeQueryModified,
  NATIVE_QUERY_KINDS,
  normalizeNativeQueryForSupport,
} from "./queries.js";

export {
  getCompactImportsExecution,
  getNativeQueryExecution,
  getNativeQueryExecutionForState,
  getNativeSingleQueryExecution,
  getNativeDuplicateTokens,
  getNativeSyntaxTreeExecution,
  runNativeLanguageQueries,
} from "./execution.js";

export {
  executeJsQueryAsNativeMatches,
  getUnifiedQueryExecution,
  shouldAvoidJsFallbackForLanguage,
} from "./jsBridge.js";
