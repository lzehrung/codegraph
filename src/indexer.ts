import type { FallbackImportExtractionEvent } from "./graphs/specifiers.js";
import { buildSymbolGraphDetailed } from "./graphs/symbol-graph-detailed.js";
import type { SymbolGraph } from "./graphs/symbol-graph.js";
import type { GraphBuildOptions } from "./graphs/types.js";
import {
  ensureParsedContext as ensureParsedContextFromModule,
  parseFile as parseFileFromModule,
  type ParsedFileCacheEntry,
  type ParsedFileContext,
} from "./indexer/parse-context.js";
import { collectImportsForFile as collectImportsForFileFromImportsModule } from "./indexer/imports.js";
import { collectLocalsAndExportsFromSource as collectLocalsAndExportsFromLocalsModule } from "./indexer/locals-and-exports.js";
import {
  buildGraphDelta,
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
} from "./indexer/build-index.js";
import {
  collectNamespaceMemberRefs,
  findReferences,
  goToDefinition,
  resolveExport,
  resolveImported,
} from "./indexer/navigation.js";
import {
  defFromSymbolId,
  findReferencesById,
  getApiSurface,
  goToDefinitionById,
  listSymbols,
  resolveSymbolId,
  symbolId,
} from "./indexer/symbols.js";
import {
  SymbolKind,
  type ApiSurface,
  type BackendReport,
  type BuildFileReport,
  type BuildOptions,
  type BuildReport,
  type BuildTimingReport,
  type CacheReport,
  type ExportEntry,
  type FindReferencesResult,
  type FallbackImportExtractionReport,
  type GoToRequest,
  type GoToResult,
  type GraphDeltaReport,
  type GraphReport,
  type ImportBinding,
  type IncrementalBuildOptions,
  type ManifestReport,
  type ModuleIndex,
  type NativeBackendFallbackReason,
  type NativeBackendLanguageReport,
  type NativeBackendReport,
  type ParserBackendDegradationReport,
  type ProjectIndex,
  type Reference,
  type ResolutionProvenance,
  type ResolvedExport,
  type SymbolDef,
  type SymbolHandle,
  type SymbolListItem,
  type WorkerPoolReport,
} from "./indexer/types.js";
import { buildScopeIndexFromSource as buildScopeIndexFromSourceFromModule, type ScopeIndex } from "./indexer/scope.js";
import type { LanguageSupport } from "./languages.js";
import type { ParserLanguage, SyntaxTreeLike } from "./languages/types.js";
import type { NativeQueryResults, NativeRuntimeMode } from "./native/treeSitterNative.js";
import type { FileId } from "./types.js";
import type { ParserSyntaxTree } from "./parserBackend.js";

export { SymbolKind } from "./indexer/types.js";
export type {
  ApiSurface,
  BackendReport,
  BuildFileReport,
  BuildOptions,
  BuildReport,
  BuildTimingReport,
  CacheReport,
  ExportEntry,
  FindReferencesResult,
  FallbackImportExtractionReport,
  GoToRequest,
  GoToResult,
  GraphDeltaReport,
  GraphReport,
  ImportBinding,
  IncrementalBuildOptions,
  ManifestReport,
  ModuleIndex,
  NativeBackendFallbackReason,
  NativeBackendLanguageReport,
  NativeBackendReport,
  ParserBackendDegradationReport,
  ProjectIndex,
  Reference,
  ResolutionProvenance,
  ResolvedExport,
  SymbolDef,
  SymbolHandle,
  SymbolListItem,
  WorkerPoolReport,
} from "./indexer/types.js";

export {
  DEFAULT_WORKSPACE_SYMBOL_LIMIT,
  MAX_WORKSPACE_SYMBOL_LIMIT,
  workspaceSymbols,
  type WorkspaceSymbolMatch,
  type WorkspaceSymbolsRequest,
  type WorkspaceSymbolsResult,
} from "./indexer/workspace-symbols.js";

export {
  findImplementations,
  findTypeHierarchy,
  type ImplementationMatch,
  type ImplementationsResult,
  type TypeHierarchyDirection,
  type TypeHierarchyRelationKind,
  type TypeHierarchyRelationMatch,
  type TypeHierarchyResult,
} from "./indexer/type-hierarchy.js";

export {
  buildGraphDelta,
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
} from "./indexer/build-index.js";

export {
  collectNamespaceMemberRefs,
  findReferences,
  goToDefinition,
  resolveExport,
  resolveImported,
} from "./indexer/navigation.js";

export {
  defFromSymbolId,
  findReferencesById,
  getApiSurface,
  goToDefinitionById,
  listSymbols,
  resolveSymbolId,
  symbolId,
} from "./indexer/symbols.js";

export function collectLocalsAndExportsFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  lang?: ParserLanguage,
  imports: ImportBinding[] = [],
  opts?: {
    tree?: SyntaxTreeLike;
    nativeQueries?: NativeQueryResults | null;
    nativeMode?: NativeRuntimeMode;
    logLevel?: import("./logging.js").LogLevel;
  },
): ModuleIndex {
  return collectLocalsAndExportsFromLocalsModule(file, source, support, lang, imports, opts);
}

export async function collectImportsForFile(
  file: string,
  projectRoot: string,
  opts?: {
    source?: string;
    tree?: ParserSyntaxTree;
    sup?: LanguageSupport;
    lang?: ParserLanguage;
    nativeQueries?: NativeQueryResults | null;
    graphOptions?: GraphBuildOptions;
    native?: import("./native/treeSitterNative.js").NativeRuntimeMode;
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
    logLevel?: import("./logging.js").LogLevel;
  },
): Promise<ImportBinding[]> {
  return await collectImportsForFileFromImportsModule(file, projectRoot, opts);
}

export async function parseFile(file: string): Promise<ParsedFileContext> {
  return await parseFileFromModule(file);
}

export async function ensureParsedContext(
  file: string,
  parsedEntry?: ParsedFileCacheEntry,
): Promise<ParsedFileContext> {
  return await ensureParsedContextFromModule(file, parsedEntry);
}

export function buildScopeIndexFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  lang?: ParserLanguage,
  imports: ImportBinding[] = [],
  opts?: { tree?: SyntaxTreeLike; nativeMode?: NativeRuntimeMode },
): ScopeIndex {
  return buildScopeIndexFromSourceFromModule(file, source, support, lang, imports, opts);
}

export async function __buildSymbolGraphDetailedCompat(index: ProjectIndex): Promise<SymbolGraph> {
  return await buildSymbolGraphDetailed(index);
}
