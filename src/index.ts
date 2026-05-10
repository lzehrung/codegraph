/** Language registry helpers and support metadata. */
export * from "./languages.js";

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
  goToDefinitionById,
  findReferencesById,
  getSymbolRange,
  type SymbolListItem,
  listSymbols,
  getApiSurface,
  type ApiSurface,
} from "./indexer.js";

/** Refactor edit primitives and APIs. */
export { applyEdits } from "./refactor/applyEdits.js";
export type {
  ApplyEditsOptions,
  ApplyEditsResult,
  RefactorResult,
  SymbolRangeOptions,
  TextEdit,
  TriviaMode,
} from "./refactor/types.js";

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
} from "./session.js";

/** Preset helpers for build, impact, and session defaults. */
export {
  getBuildPreset,
  getImpactPreset,
  getSessionPreset,
  mergePreset,
  BUILD_PRESETS,
  IMPACT_PRESETS,
  SESSION_PRESETS,
  type PresetName,
} from "./presets.js";

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

/** Agent-oriented JSON tool wrappers around the core codegraph APIs. */
export {
  tool_impactJSON,
  tool_impactFromDiffText,
  tool_getFileOverview,
  tool_findSymbol,
  tool_listProjectFiles,
  tool_getGraph,
  tool_getDependencies,
  tool_getReverseDependencies,
  tool_getHotspots,
  tool_goToDefinition,
  tool_findReferences,
  type ToolFileOverview,
  type ToolFileOverviewImport,
  type ToolFileOverviewDefinition,
  type ToolFileOverviewResult,
  type ToolSymbolMatch,
  type ToolDependencyEntry,
  type ToolHotspotEntry,
} from "./agent-tools.js";

/** SQLite graph persistence and query helpers. */
export {
  writeGraphSqlite,
  updateGraphSqlite,
  queryGraphSqlite,
  queryGraphSqliteRaw,
  type SqliteGraphOptions,
  type SqliteGraphUpdateOptions,
  type GraphQueryResult,
  type RawSqlResult,
} from "./sqlite.js";

/** Source and text chunking helpers. */
export { chunkFile, type Chunk, type ChunkFileOptions } from "./chunking/chunkFile.js";
export { chunkTextFile, type TextChunkOptions } from "./chunking/chunkTextFile.js";
export { chunkSFCFile, type ChunkSFCOptions } from "./chunking/chunkSFC.js";

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
