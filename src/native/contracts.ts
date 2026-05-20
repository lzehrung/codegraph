export type NativePoint = {
  row: number;
  column: number;
  index: number;
};

export type NativeCapture = {
  name: string;
  text: string;
  nodeType: string;
  start: NativePoint;
  end: NativePoint;
};

export type NativeMatch = {
  patternIndex: number;
  captures: NativeCapture[];
};

export type NativeQueryResults = {
  imports: NativeMatch[];
  exports: NativeMatch[];
  locals: NativeMatch[];
  importBindings: NativeMatch[];
};

export type NativeSyntaxNode = {
  id: number;
  parentId: number;
  nodeType: string;
  named: boolean;
  start: NativePoint;
  end: NativePoint;
  childIds: number[];
  namedChildIds: number[];
  childFieldNames: string[];
};

export type NativeSyntaxTree = {
  rootId: number;
  nodes: NativeSyntaxNode[];
};

export type CompactCapture = {
  name: string;
  text: string;
};

export type CompactMatch = {
  patternIndex: number;
  captures: CompactCapture[];
};

export type CompactQueryResults = {
  imports: CompactMatch[];
};

export type NativeFallbackReason = "unavailable" | "unsupportedLanguage" | "queryFailure";

export type NativeQueryExecution = {
  results: NativeQueryResults | null;
  fallbackReason?: NativeFallbackReason;
  error?: string;
};

export type CompactImportsExecution = {
  results: CompactQueryResults | null;
  fallbackReason?: NativeFallbackReason;
  error?: string;
};

export type NativeSingleQueryExecution = {
  matches: NativeMatch[] | null;
  fallbackReason?: NativeFallbackReason;
  error?: string;
};

export type UnifiedQueryExecution = {
  matches: NativeMatch[] | null;
  backend: "native" | "js";
  fallbackReason?: NativeFallbackReason;
  error?: string;
};

export type NativeSyntaxTreeExecution = {
  tree: NativeSyntaxTree | null;
  fallbackReason?: NativeFallbackReason;
  error?: string;
};

export type NativeRuntimeMode = "auto" | "on" | "off";

/**
 * Controls which query kinds are executed in a native call.
 * - "imports": only run the imports query (used by graph mode)
 * - "full": run all query kinds (used by full indexing)
 */
export type NativeQueryScope = "imports" | "full";

export type NativeBinding = {
  runLanguageQueries: (
    source: string,
    languageId: string,
    importsQuery: string,
    exportsQuery: string,
    localsQuery: string,
    importBindingsQuery: string,
  ) => NativeQueryResults;
  runImportsQueryCompact?: (source: string, languageId: string, importsQuery: string) => CompactQueryResults;
  runQuery?: (source: string, languageId: string, queryText: string) => { matches: NativeMatch[] };
  parseSyntaxTree?: (source: string, languageId: string) => NativeSyntaxTree;
  supportedLanguageIds: () => string[];
};

export type NativeBindingState =
  | { loaded: true; binding: NativeBinding; supportedLanguageIds: Set<string> }
  | { loaded: false; error?: unknown };
