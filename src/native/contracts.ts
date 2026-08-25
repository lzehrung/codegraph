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

/**
 * Column-oriented projection of a Tree-sitter tree, mirroring the Rust
 * `NativeSyntaxTree`. Every column is a typed array indexed by node id, and node
 * kinds and child field names are interned into string tables.
 *
 * This shape exists so the napi boundary and the worker-to-main-thread transfer cost
 * scale with bytes rather than with node count: a file crosses as ~15 typed arrays
 * plus a few hundred strings instead of thousands of objects. `ProjectedSyntaxTree`
 * is the only reader; every other consumer sees the unchanged `SyntaxNodeLike` API.
 *
 * Child lists use compressed sparse row layout: the children of node `i` are
 * `childIds[childOffsets[i] .. childOffsets[i + 1]]`, with `childFieldNameIds`
 * parallel to `childIds`.
 */
export type NativeSyntaxTree = {
  rootId: number;
  nodeCount: number;
  /** Distinct node kinds; `kindIds[i]` indexes this table. */
  kinds: string[];
  /** Distinct child field names; index 0 is always the empty name. */
  fieldNames: string[];
  kindIds: Uint32Array;
  /** -1 for the root node. */
  parentIds: Int32Array;
  named: Uint8Array;
  startRow: Uint32Array;
  startColumn: Uint32Array;
  /** UTF-8 byte offset, matching Tree-sitter's `start_byte()`. */
  startIndex: Uint32Array;
  endRow: Uint32Array;
  endColumn: Uint32Array;
  /** UTF-8 byte offset, matching Tree-sitter's `end_byte()`. */
  endIndex: Uint32Array;
  childOffsets: Uint32Array;
  childIds: Uint32Array;
  childFieldNameIds: Uint32Array;
  namedChildOffsets: Uint32Array;
  namedChildIds: Uint32Array;
};

export type NativeLanguageExtraction = {
  results: NativeQueryResults;
  syntaxTree: NativeSyntaxTree;
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

export type NativeDuplicateTokens = {
  normalizedTokens: string[];
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
  backend: "native";
  fallbackReason?: NativeFallbackReason;
  error?: string;
};

export type NativeSyntaxTreeExecution = {
  tree: NativeSyntaxTree | null;
  fallbackReason?: NativeFallbackReason;
  error?: string;
};

/**
 * Query results plus the projected syntax tree from one native parse. Prefer this over
 * separately calling query execution and tree execution: each is backed by its own
 * Tree-sitter parse, so calling both on the same source parses it twice.
 */
export type NativeExtractionExecution = {
  results: NativeQueryResults | null;
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
  extractLanguage: (
    source: string,
    languageId: string,
    importsQuery: string,
    exportsQuery: string,
    localsQuery: string,
    importBindingsQuery: string,
  ) => NativeLanguageExtraction;
  runImportsQueryCompact?: (source: string, languageId: string, importsQuery: string) => CompactQueryResults;
  runQuery?: (source: string, languageId: string, queryText: string) => { matches: NativeMatch[] };
  parseSyntaxTree?: (source: string, languageId: string) => NativeSyntaxTree;
  tokenizeDuplicateSource?: (source: string) => NativeDuplicateTokens;
  supportedLanguageIds: () => string[];
};

export type NativeBindingOrigin = {
  mode: "workspace" | "package" | "cache";
  packageName: string;
  packageVersion?: string;
  target?: string;
  sourcePath?: string;
  loadedPath?: string;
  cacheKey?: string;
  sha256?: string;
  cacheError?: string;
};

/**
 * What the main thread tells an extraction worker about the addon it already resolved.
 *
 * Workers used to repeat the whole pipeline - workspace probe, platform-package resolve, two
 * 29 MB hashes, cache verification - to arrive at a file the parent had just verified and
 * loaded. Handing over the resolved path and the origin that goes with it makes that one
 * require() call per worker instead.
 */
export type NativeWorkerBindingHandoff = {
  loadedPath: string;
  origin: NativeBindingOrigin;
};

export type NativeBindingState =
  | {
      loaded: true;
      binding: NativeBinding;
      supportedLanguageIds: Set<string>;
      origin: NativeBindingOrigin;
    }
  | { loaded: false; error?: unknown; origin?: NativeBindingOrigin };
