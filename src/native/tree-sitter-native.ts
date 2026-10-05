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
  NativeExtractionExecution,
  NativePoint,
  NativeQueryExecution,
  NativeQueryResults,
  NativeQueryScope,
  NativeSingleQueryExecution,
  NativeSyntaxTree,
  NativeSyntaxTreeExecution,
  UnifiedQueryExecution,
} from "./contracts.js";

export {
  __resetNativeTreeSitterBindingForTests,
  __setNativeTreeSitterBindingForTests,
  assertNativeRequiredAvailable,
  getNativeTreeSitterLoadError,
  getNativeBindingOrigin,
  getNativeRuntimeFingerprint,
  getNativeWorkerBindingHandoff,
  getNativeTreeSitterSupportedLanguageIds,
  isNativeBindingLoadedForLanguage,
  isNativeRequiredUnavailableError,
  isNativeTreeSitterAvailable,
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
  getNativeExtractionExecution,
  getNativeQueryExecution,
  getNativeQueryExecutionForState,
  getNativeSingleQueryExecution,
  getNativeDuplicateTokens,
  isNativeDuplicateTokenizationAvailable,
  getNativeSyntaxTreeExecution,
  runNativeLanguageQueries,
} from "./execution.js";

export { getUnifiedQueryExecution } from "./js-bridge.js";
