import type { FallbackImportExtractionReason } from "../graphs/specifiers.js";
import type { GraphAdjacencyIndex } from "../graphs/adjacency.js";
import type { GraphBuildOptions } from "../graphs/types.js";
import type { LogLevel } from "../logging.js";
import type { NativeFallbackReason, NativeRuntimeMode } from "../native/contracts.js";
import type { ScopeIndex } from "./scope-types.js";
import type { ReferenceCandidateIndex } from "./reference-candidate-types.js";
import type { ParsedFileContext } from "./parse-context.js";
import type { Edge, FileId, Graph, ProgressUpdate, Range } from "../types.js";
import type { ProjectFileDiscoveryOptions, ProjectFileInfo } from "../util/projectFiles.js";
import type { ImportBinding } from "./import-types.js";

export type { ImportBinding } from "./import-types.js";

export enum SymbolKind {
  Function = "function",
  Class = "class",
  Variable = "variable",
  Interface = "interface",
  TypeAlias = "type",
  Default = "default",
  Table = "table",
  View = "view",
  Index = "index",
  Constraint = "constraint",
  Routine = "routine",
}

export type SymbolDef = {
  file: FileId;
  localName: string;
  kind: SymbolKind;
  range: Range;
  isMember?: boolean;
  docstring?: string;
  lineSpan?: number;
  complexity?: number;
};

export type ExportEntry =
  | { type: "local"; exportedAs: string; target: SymbolDef }
  | {
      type: "reexport";
      exportedAs: string;
      fromModule: string;
      moduleSpecifier?: string;
      sourceSpecifier: string;
      typeOnly?: boolean;
    }
  | {
      type: "namespaceReexport";
      exportedAs: string;
      fromModule: string;
      moduleSpecifier?: string;
      typeOnly?: boolean;
    }
  | {
      type: "exportStar";
      fromModule: string;
      moduleSpecifier?: string;
      sourceSpecifier: string;
      typeOnly?: boolean;
    };

export type ModuleIndex = {
  file: FileId;
  exports: ExportEntry[];
  imports: ImportBinding[];
  locals: SymbolDef[];
};

export type ResolvedExport = { kind: "resolved"; def: SymbolDef } | { kind: "namespace"; file: FileId };

/**
 * In-memory structural model for one project snapshot.
 *
 * Build this once with `buildProjectIndex()` or an incremental variant, then
 * reuse it across graph, navigation, review, impact, and agent-tool calls that
 * should agree on the same repo state.
 */
export type ProjectIndexManifestEntry = {
  sig: string;
  gitSig?: string;
  /**
   * Content-identity signature (`FileSignature.cacheSig`), when it was available at signature
   * computation time. Stronger than `sig` alone: unlike the cheap `mtime:size` fast path used
   * when `cacheStrict` is off, this is git- or content-hash-derived and does not falsely match
   * a changed file whose mtime and size happen to be restored to their prior values.
   */
  cacheSig?: string;
};

export type SqlNavigationCache = {
  sourceByFile: Map<FileId, string>;
  factsByFile: Map<FileId, import("../sql/types.js").SqlStatementFact[]>;
  definitionLookup?: {
    exact: Map<string, SymbolDef[]>;
    basename: Map<string, SymbolDef[]>;
  };
};
export type CachedAnalysisSummary = {
  mode: "semantic" | "mixed" | "reduced";
  backend: "native" | "mixed" | "graph-only" | "unknown";
  parserDegradedFiles: number;
  fallbackImportExtractionFiles: number;
  nativeFilesUsed: number;
  nativeFilesFellBack: number;
  label: string;
};

export type ProjectIndex = {
  graph: Graph;
  graphAdjacency?: GraphAdjacencyIndex;
  modules: Map<FileId, ModuleIndex>;
  byFile: Map<FileId, ModuleIndex>;
  projectRoot?: string;
  languageExtensions?: LanguageExtensionMap;
  nativeMode?: NativeRuntimeMode;
  exportCache: Map<string, ResolvedExport | null>;
  scopeCache: Map<string, ScopeIndex>;
  parsed?: Map<string, ParsedFileContext> | undefined;
  bloomFilters?: import("../util/bloomFilter.js").BloomFilterCache;
  projectFiles?: ProjectFileInfo[];
  referenceCandidates?: ReferenceCandidateIndex;
  sqlNavigation?: SqlNavigationCache;
  manifestEntries?: Map<FileId, ProjectIndexManifestEntry>;
  /** True only when manifest signatures were observed during the current index build. */
  manifestSignaturesFresh?: boolean;
  cacheMode?: BuildOptions["cache"];
  buildReport?: BuildReport;
  analysis?: CachedAnalysisSummary;
  cacheRootDir?: string;
  /** Internal identity for disk artifacts derived from this exact reusable snapshot. */
  projectSnapshotIdentity?: string;
};

/**
 * Options for full index construction.
 *
 * For deterministic agent packs, the most common choices are `native: "auto"`,
 * optional `discovery` globs, and a `report` object when the caller wants
 * timings/backend diagnostics alongside the resulting index.
 */
export type LanguageExtensionMap = import("../languages.js").LanguageExtensionMap;

export type CacheLocation = string;

export type BuildOptions = {
  onProgress?: ((progress: ProgressUpdate) => void) | undefined;
  threads?: number;
  cache?: "off" | "memory" | "disk";
  /**
   * Highest-precedence disk-cache anchor; also settable via `CODEGRAPH_CACHE_DIR`. Like an
   * absolute `cacheLocation`, this is an anchor, not the final cache directory: the resolved
   * cache lives in a namespaced subdirectory underneath it.
   */
  cacheDir?: string;
  /**
   * Disk-cache anchor when `cacheDir`/`CODEGRAPH_CACHE_DIR` are unset: `"project"` anchors at
   * `projectRoot`, `"user"` anchors at the platform user cache directory, `"repo"` (or omitted)
   * searches ancestor directories for repository metadata and falls back to `projectRoot`. Any
   * other value is treated as an absolute anchor directory (like `cacheDir`), not a final cache
   * path: the resolved cache lives in a namespaced subdirectory under the anchor.
   */
  cacheLocation?: CacheLocation;
  cacheStrict?: boolean;
  useBloomFilters?: boolean;
  graph?: GraphBuildOptions;
  native?: NativeRuntimeMode;
  cacheVerify?: boolean;
  incrementalStrict?: boolean;
  report?: BuildReport;
  parsedCacheMaxEntries?: number;
  logLevel?: LogLevel;
  keepParsed?: boolean;
  /** Force native worker pool on/off. When unset, workers auto-enable at NATIVE_WORKER_AUTO_FILE_THRESHOLD. */
  useNativeWorkers?: boolean;
  /** Override native extraction worker count. Automatic sizing reserves capacity and caps at 8. */
  nativeThreads?: number;
  discovery?: ProjectFileDiscoveryOptions;
  /**
   * @internal Origin, from `performance.now()`, for progress elapsed reporting. Callers that
   * discover files before the build set it so the completion event measures the whole
   * operation the user waited on rather than file processing alone.
   */
  progressStartedAt?: number;
  languageExtensions?: LanguageExtensionMap;
};

/**
 * Options for manifest-backed incremental indexing.
 *
 * `gitHead` accepts normal revisions plus the `WORKTREE`, `STAGED`, and `INDEX`
 * sentinels used by review agents analyzing uncommitted changes.
 */
export type IncrementalBuildOptions = BuildOptions & {
  files?: string[];
  /** @internal Union these files into full discovery without treating them as caller-selected changes. */
  additionalFiles?: string[];
  /** @internal Treat `files` as the current project scope, not as caller-selected changed files. */
  filesAreProjectScope?: boolean;
  /** @internal Manifest identity associated with precomputed reconciliation. */
  reconciledManifestUpdatedAt?: number;
  /** @internal Reuse working-tree reconciliation already performed for `files`. */
  reconciledWorkingTreeDiffFiles?: string[];
  /** @internal Reuse untracked-file reconciliation already performed for `files`. */
  reconciledUntrackedFiles?: string[];
  changedSince?: string;
  gitBase?: string;
  gitHead?: string;
};

export type CacheReport = {
  mode: "off" | "memory" | "disk";
  hits: number;
  misses: number;
};

export type BuildTimingStep = {
  name: string;
  ms: number;
};

export type BuildTimingReport = {
  totalMs?: number;
  manifestMs?: number;
  sourceDiscoveryMs?: number;
  metadataDiscoveryMs?: number;
  /** Git candidate listing; absent when discovery did not ask Git. */
  gitListMs?: number;
  /** Filesystem glob scan used when Git listing is unavailable. */
  filesystemScanMs?: number;
  parseMs?: number;
  graphMs?: number;
  writeManifestMs?: number;
  /** Named step durations for diagnosis. Coarse fields above remain the stable summary. */
  steps?: BuildTimingStep[];
};

export type BuildFileReport = {
  total: number;
  changed?: number;
  cached?: number;
  parsed?: number;
  failed?: number;
  errors?: Array<{ file: string; message: string }>;
};

export type FallbackImportExtractionReport = {
  total: number;
  byLanguage: Record<string, number>;
  files: Record<
    string,
    {
      language: string;
      reason: FallbackImportExtractionReason;
    }
  >;
  byReason?: Record<FallbackImportExtractionReason, number>;
};

export type GraphReport = {
  fallbackImportExtraction: FallbackImportExtractionReport;
};

export type ManifestReport = {
  used: boolean;
  reused: boolean;
  reason?: string;
  mismatches?: number;
  missing?: number;
  optionsMismatch?: string[];
  configHashError?: string;
  corruptions?: Array<{ artifact: string; reason: string }>;
};

export type NativeBackendFallbackReason = NativeFallbackReason;

export type NativeBackendLanguageReport = {
  filesSeen: number;
  filesUsed: number;
  filesFellBack: number;
  fallbackReasons: Record<NativeBackendFallbackReason, number>;
  normalizedQueryKinds?: string[];
  skippedQueryKinds?: string[];
};

export type NativeBackendReport = {
  available: boolean;
  enabled: boolean;
  supportedLanguageIds: string[];
  filesUsed: number;
  filesFellBack: number;
  fallbackReasons: Record<NativeBackendFallbackReason, number>;
  byLanguage: Record<string, NativeBackendLanguageReport>;
  errors: Array<{
    file: string;
    languageId: string;
    reason: NativeBackendFallbackReason;
    message: string;
  }>;
  loadError?: string;
};

export type ParserBackendDegradationReport = {
  total: number;
  byLanguage: Record<string, number>;
  files: Array<{
    file: string;
    languageId: string;
    nativeFallbackReason?: NativeBackendFallbackReason;
    nativeError?: string;
    jsError?: string;
  }>;
};

export type BackendReport = {
  native: NativeBackendReport;
  parser?: ParserBackendDegradationReport;
};

export type WorkerPoolReport = {
  enabled: boolean;
  threads: number;
  tasksSubmitted: number;
  tasksFailed: number;
  startupError?: string;
  errors?: Array<{ file: string; message: string }>;
  totalWorkerMs?: number;
  wallClockMs?: number;
};

export type QueryIndexDiagnostics = {
  sidecarState: "hit" | "created" | "updated" | "rebuilt" | "unavailable" | "writer-busy" | "rebuilt-corrupt";
  filesRead: number;
  filesAdded: number;
  filesUpdated: number;
  filesDeleted: number;
  fileCandidates: number;
  chunkCandidates: number;
  openMs: number;
  updateMs: number;
  candidateMs: number;
  scoringMs: number;
  /** Files dropped from an otherwise successful preparation batch; see workerPool preparation. */
  filesSkipped?: number;
  fallbackReason?: string;
};

export type BuildReport = {
  timings: BuildTimingReport;
  cache?: CacheReport;
  files?: BuildFileReport;
  graph?: GraphReport;
  manifest?: ManifestReport;
  backend?: BackendReport;
  workerPool?: WorkerPoolReport;
  queryIndex?: QueryIndexDiagnostics;
};

export type GraphDeltaReport = {
  changedFiles: string[];
  added: Edge[];
  removed: Edge[];
};

/** Stable symbol handle suitable for storing in review packets and resolving later. */
export type SymbolHandle = string;

/** Lightweight symbol listing item returned by `listSymbols()`. */
export type SymbolListItem = {
  id: SymbolHandle;
  file: FileId;
  name: string;
  kind: SymbolKind | "import" | "namespaceImport";
  range?: Range;
  docstring?: string;
};

/** Export-oriented view of the indexed public API surface. */
export type ApiSurface = Array<{
  file: FileId;
  exports: Array<{
    name: string;
    kind: string;
    exportedAs: string;
    target?: { file: FileId; name: string };
  }>;
}>;

export type GoToRequest = { file: FileId; line: number; column: number };

export type ResolutionProvenance = {
  backend?: "native" | "graph-only" | "heuristic";
  resolution?: "exact" | "import" | "import-star" | "namespace" | "reexport" | "php-qualified" | "member-access";
  confidence?: "high" | "medium" | "low";
};

export type GoToResult =
  | {
      status: "ok";
      definition: SymbolDef;
      via?: {
        importedFrom?: string | undefined;
        exportedName?: string | undefined;
      };
      provenance?: ResolutionProvenance;
    }
  | { status: "not_found"; reason: string };

export type Reference = {
  file: FileId;
  range: Range;
  context?: string;
  via?: { import?: ImportBinding; namespaceMember?: string; reexport?: true };
  /**
   * Resolution provenance for this specific reference, populated only when the
   * reference was verified through a goto-style lookup (e.g. member-access
   * receiver resolution) rather than an exact scope/import binding. Absent
   * means the reference came from an exact scope or import-binding match.
   */
  provenance?: ResolutionProvenance;
};

export type FindReferencesResult =
  | {
      status: "ok";
      definition: SymbolDef;
      references: Reference[];
      provenance?: ResolutionProvenance;
    }
  | { status: "not_found"; reason: string };
