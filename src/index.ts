/**
 * Public package entrypoint for core library primitives.
 *
 * Agent-shaped JSON APIs live under `@lzehrung/codegraph/agent`.
 * MCP server/handlers live under `@lzehrung/codegraph/mcp`.
 * Implementation modules below `dist/` outside the documented package exports
 * are not a stable import surface for consumers.
 */
/** Language registry helpers and support metadata. */
export * from "./languages.js";

/** Project-local Codegraph config loading and discovery option merging. */
export {
  CODEGRAPH_CONFIG_FILE,
  hasDiscoveryOptions,
  loadCodegraphConfig,
  mergeDiscoveryOptions,
  type CodegraphConfig,
} from "./config.js";

/** Shared path, discovery, resolution, workspace, and git utilities. */
export {
  sliceText,
  unquote,
  toRange,
  listProjectFiles,
  discoverProjectFiles,
  stripJsLikeComments,
  stripPythonCommentsAndStrings,
  loadNearestTsconfigFor,
  loadWorkspaceConfig,
  resolveSpecifier,
  resolvePythonModule,
  resolveWorkspacePackage,
  resolvePackageSubpath,
  getGitHead,
  listChangedFiles,
  clearImportResolutionCaches,
  clearResolutionCaches,
} from "./util.js";

/** Project file discovery option and result shapes. */
export type {
  ProjectFileDiscoveryOptions,
  ProjectFileInfo,
  ProjectFileKind,
  ProjectFileRole,
  ProjectFileType,
} from "./util.js";

/** File and symbol graph builders, renderers, and traversal helpers. */
export {
  collectGraph,
  graphToDOT,
  graphToMermaid,
  astGrep,
  textGrep,
  buildSymbolGraph,
  buildSymbolGraphDetailed,
  graphToMermaidSymbols,
  graphToDOTSymbols,
  graphToMermaidSymbolsWithFiles,
  graphToDOTSymbolsWithFiles,
  getDependencies,
  getReverseDependencies,
  getShortestPath,
  findCycles,
  findDetailedCycles,
  sortDetailedCycles,
  getUnresolvedImports,
  getHotspots,
  type DependencyNode,
  type GraphBuildOptions,
  type SymbolGraph,
  type SymbolNodeKind,
  type DetailedCycle,
  type CycleInternalEdge,
  type CycleSortMode,
} from "./graphs.js";

/** Local Markdown link validation. */
export {
  checkMarkdownLinks,
  type MarkdownLinkCheckFailure,
  type MarkdownLinkCheckFailureReason,
  type MarkdownLinkCheckResult,
} from "./documentLinks/check.js";

/** Symbol query parser and graph-neighborhood query helpers. */
export {
  parseSymbolQuery,
  querySymbols,
  querySymbolNeighbors,
  type SymbolQuery,
  type NeighborQuery,
  type NeighborResult,
} from "./query.js";

/** RDF-style graph triple projection helpers. */
export { graphToTriples, type Triple, type TripleNode } from "./triples.js";

/** Core graph primitives shared across index, graph, and tool APIs. */
export type { Pos, Range, FileId, EdgeTo, Edge, Graph } from "./types.js";
export type { AnalysisBackend, AnalysisMode, AnalysisSummary } from "./analysisSummary.js";

/** Project indexing, navigation, reference search, and API-surface analysis. */
export {
  SymbolKind,
  type SymbolDef,
  type SymbolHandle,
  type ExportEntry,
  type ImportBinding,
  type ModuleIndex,
  type ProjectIndex,
  type ResolvedExport,
  type ResolutionProvenance,
  type BuildReport,
  type BuildOptions,
  type CacheReport,
  type BuildTimingReport,
  type BuildFileReport,
  type FallbackImportExtractionReport,
  type GraphReport,
  type ManifestReport,
  type NativeBackendFallbackReason,
  type NativeBackendReport,
  type BackendReport,
  type WorkerPoolReport,
  type GraphDeltaReport,
  type FindReferencesResult,
  type Reference,
  DEFAULT_WORKSPACE_SYMBOL_LIMIT,
  MAX_WORKSPACE_SYMBOL_LIMIT,
  workspaceSymbols as queryWorkspaceSymbols,
  type WorkspaceSymbolMatch,
  type WorkspaceSymbolsRequest,
  type WorkspaceSymbolsResult,
  findImplementations as queryImplementations,
  findTypeHierarchy as queryTypeHierarchy,
  type ImplementationMatch,
  type ImplementationsResult as IndexImplementationsResult,
  type TypeHierarchyDirection,
  type TypeHierarchyRelationKind,
  type TypeHierarchyRelationMatch,
  type TypeHierarchyResult as IndexTypeHierarchyResult,
  findCallHierarchy as queryCallHierarchy,
  type CallHierarchyDirection,
  type CallHierarchyMatch,
  type CallHierarchyResult as IndexCallHierarchyResult,
  type CallHierarchySite,
  parseFile,
  collectLocalsAndExportsFromSource,
  collectImportsForFile,
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
  buildGraphDelta,
  resolveExport,
  goToDefinition,
  findReferences,
  buildScopeIndexFromSource,
  resolveImported,
  symbolId,
  defFromSymbolId,
  resolveSymbolId,
  resolveSymbolTarget,
  goToDefinitionById,
  findReferencesById,
  type ResolvedSymbolTarget,
  type SymbolTargetResolution,
  type SymbolListItem,
  listSymbols,
  getApiSurface,
  type ApiSurface,
} from "./indexer.js";

/** Diff impact analysis and review-context helper APIs. */
export {
  analyzeImpactFromDiff,
  analyzeImpactStreaming,
  collectImpactContext,
  listCandidateTestFiles,
  type Diff,
  type FileChange,
  type Hunk,
  type ChangedSymbol,
  type ImpactItem,
  type ImpactReason,
  type ImpactReport,
  type CompactImpactReport,
  type ImpactStreamSummaryReport,
  IMPACT_SCHEMA_VERSION,
  type ImpactOptions,
  type ImpactStreamingOptions,
  type DiffProviderOptions,
  type ImpactContext,
  type CandidateTestFile,
  type ImpactStreamChunk,
} from "./impact/index.js";

/** Stateful code-review sessions for repeated agent navigation calls. */
export {
  CodeReviewSession,
  SessionManager,
  createCodeReviewSession,
  type ICodeReviewSession,
  type SessionOptions,
  type SessionStatus,
  type SessionStats,
  type SessionStaleReason,
} from "./session.js";

/** Session preset helpers. */
export { getSessionPreset, mergePreset, SESSION_PRESETS, type PresetName } from "./presets.js";

/** Partial-result helpers for returning usable data with recoverable errors. */
export {
  type PartialResult,
  type PartialError,
  success,
  partial,
  failed,
  withPartialResults,
  combinePartialResults,
  mapPartialResult,
  filterErrorsBySeverity,
  summarizePartialResult,
} from "./util/partialResults.js";

/** Lazy project-index wrappers for deferred symbol materialization. */
export {
  LazyArray,
  LazyProjectIndex,
  createSymbolLoader,
  type LazyModuleIndex,
  type LazyLoadOptions,
} from "./util/lazySymbols.js";

/** Stable symbol hashing helpers used by manifests and change detection. */
export {
  computeSymbolHash,
  symbolIdentifier,
  detectSymbolChanges,
  computeFileSymbolHashes,
  type SymbolHash,
  type SymbolManifestEntry,
} from "./util/symbolHash.js";

/** SQLite graph persistence and query helpers. */
export {
  writeGraphSqlite,
  updateGraphSqlite,
  queryGraphSqlite,
  queryGraphSqliteRaw,
  SqliteQueryCancelledError,
  SqliteQueryDeadlineExceededError,
  SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY,
  type SqliteGraphOptions,
  type SqliteGraphUpdateOptions,
  type GraphQueryResult,
  type RawSqlResult,
} from "./sqlite.js";

/** SQL artifact facts, graph projection, and review-context helpers. */
export {
  classifySqlFile,
  extractSqlFactsFromSource,
  buildSqlArtifactGraphFromFiles,
  projectSqlFactsToGraph,
  collectSqlReviewContext,
  type SqlArtifactEdge,
  type SqlArtifactGraph,
  type SqlArtifactNode,
  type SqlBridgeReason,
  type SqlFactKind,
  type SqlFileRole,
  type SqlReviewContext,
  type SqlReviewContextEntry,
  type SqlStatementFact,
  type SqlTruthTier,
} from "./sql/index.js";

/** Source and text chunking helpers. */
export { chunkFile, type Chunk, type ChunkFileOptions } from "./chunking/chunkFile.js";
export { chunkTextFile, type TextChunkOptions } from "./chunking/chunkTextFile.js";
export { chunkSFCFile, type ChunkSFCOptions } from "./chunking/chunkSFC.js";

/** In-memory duplicate and near-duplicate code detection. */
export {
  findDuplicates,
  findDuplicateContext,
  findDuplicateContexts,
  type DuplicateCloneType,
  type DuplicateConfidence,
  type DuplicateDetectionOmittedCounts,
  type DuplicateDetectionOptions,
  type DuplicateContextResult,
  type DuplicateTarget,
  type DuplicateDetectionResult,
  type DuplicateDetectionStats,
  type DuplicateGroup,
  type DuplicateMetrics,
  type DuplicateSuggestion,
  type DuplicateSimilarityHint,
  type DuplicateUnitKind,
  type DuplicateUnitRef,
} from "./duplicates.js";

/** Architecture drift snapshots, comparisons, and report rendering. */
export {
  buildArchitectureSnapshot,
  analyzeArchitectureDrift,
  loadArchitectureSnapshotFromArtifact,
  compareArchitectureSnapshots,
  renderArchitectureDriftReport,
  ARCHITECTURE_DRIFT_FINDING_KINDS,
  DEFAULT_DRIFT_THRESHOLDS,
  type ArchitectureCycle,
  type ArchitectureDriftCompareOptions,
  type ArchitectureDriftFinding,
  type ArchitectureDriftFindingKind,
  type ArchitectureDriftFormat,
  type ArchitectureDriftGraphEdgesMode,
  type ArchitectureDriftOptions,
  type ArchitectureDriftProvider,
  type ArchitectureDriftPublicApiMode,
  type ArchitectureDriftReport,
  type ArchitectureDriftSeverity,
  type ArchitectureDriftSummary,
  type ArchitectureDriftThresholds,
  type ArchitectureDuplicateSummary,
  type ArchitectureGraphEdge,
  type ArchitectureHotspot,
  type ArchitecturePublicApiSymbol,
  type ArchitectureSnapshot,
  type ArchitectureSnapshotOptions,
  type ArchitectureSnapshotSummary,
  type ArchitectureUnresolvedImport,
} from "./drift/index.js";

/** Tree-sitter language configuration registry. */
export { LANG_CONFIGS, type LanguageConfig } from "./bootstrap/treeSitterLanguages.js";

/** Review report generation and review result types. */
export {
  buildReviewReport,
  type ReviewDepth,
  type ReviewDiagnostics,
  type ReviewReport,
  type ReviewRiskLevel,
  type ReviewRiskSummary,
  type ReviewTask,
  type ReviewTaskPriority,
  type ReviewBuildReport,
  type ReviewTimingReport,
} from "./review.js";

/** Native Tree-sitter runtime availability and language support helpers. */
export {
  type NativeRuntimeMode,
  type NativeQueryScope,
  isNativeTreeSitterAvailable,
  getNativeTreeSitterLoadError,
  getNativeTreeSitterSupportedLanguageIds,
} from "./native/treeSitterNative.js";
