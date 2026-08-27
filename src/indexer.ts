import type { FallbackImportExtractionEvent } from "./graphs/specifiers.js";
import type { GraphBuildOptions } from "./graphs/types.js";
import { parseFile as parseFileFromModule, type ParsedFileContext } from "./indexer/parse-context.js";
import { collectImportsForFile as collectImportsForFileFromImportsModule } from "./indexer/imports.js";
import { collectLocalsAndExportsFromSource as collectLocalsAndExportsFromLocalsModule } from "./indexer/locals-and-exports.js";
import { type ImportBinding, type ModuleIndex } from "./indexer/types.js";
import { buildScopeIndexFromSource as buildScopeIndexFromSourceFromModule, type ScopeIndex } from "./indexer/scope.js";
import type { LanguageSupport } from "./languages.js";
import type { SyntaxTreeLike } from "./languages/types.js";
import type { NativeQueryResults, NativeRuntimeMode } from "./native/treeSitterNative.js";

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
  findCallHierarchy,
  type CallHierarchyDirection,
  type CallHierarchyMatch,
  type CallHierarchyResult,
  type CallHierarchySite,
} from "./indexer/call-hierarchy.js";

export {
  buildGraphDelta,
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
} from "./indexer/build-index.js";

export { findReferences, goToDefinition, resolveExport, resolveImported } from "./indexer/navigation.js";

export {
  defFromSymbolId,
  findReferencesById,
  getApiSurface,
  goToDefinitionById,
  listSymbols,
  resolveSymbolId,
  resolveSymbolTarget,
  symbolId,
} from "./indexer/symbols.js";
export type { ResolvedSymbolTarget, SymbolTargetResolution } from "./indexer/symbols.js";

export function collectLocalsAndExportsFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  imports: ImportBinding[] = [],
  opts?: {
    tree?: SyntaxTreeLike;
    nativeQueries?: NativeQueryResults | null;
    nativeMode?: NativeRuntimeMode;
    logLevel?: import("./logging.js").LogLevel;
  },
): ModuleIndex {
  return collectLocalsAndExportsFromLocalsModule(file, source, support, imports, opts);
}

export async function collectImportsForFile(
  file: string,
  projectRoot: string,
  opts?: {
    source?: string;
    sup?: LanguageSupport;
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

export function buildScopeIndexFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  imports: ImportBinding[] = [],
  opts?: { tree?: SyntaxTreeLike; nativeMode?: NativeRuntimeMode },
): ScopeIndex {
  return buildScopeIndexFromSourceFromModule(file, source, support, imports, opts);
}
