import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import {
  isJsFallbackAvailable,
  isJsFallbackUnavailableError,
  isJsSyntaxTree,
  parseWithJsLanguage,
  type JsSyntaxTree,
} from "./jsFallback.js";
import { supportForFile, type LanguageSupport } from "./languages.js";
import { buildBloomFilterFromSource } from "./util/bloomFilter.js";
import {
  isUnsupportedParserInputError,
  prepareSourceInput,
} from "./languages/filePrep.js";
import {
  parseCsharpUsingDirective,
  parseJavaImportStatement,
  parseKotlinImportStatement,
  parsePhpImportStatement,
  parseRustImportStatement,
} from "./languages/importStatementParsers.js";
import {
  assertFilePathWithinRoot,
  listProjectFiles,
  discoverProjectFiles,
  DEFAULT_PROJECT_MANIFESTS,
  sliceText,
  toRange,
  unquote,
  maskJsLikeCommentsAndStrings,
  stripJsLikeComments,
  stripPythonCommentsAndStrings,
  loadNearestTsconfigFor,
  loadWorkspaceConfig,
  getGraphOnlyResolutionExtensions,
  resolveSpecifier,
  resolveImportSpecifier,
  resolvePythonModule,
  resolveWorkspacePackage,
  getPhpComposerImplicitFiles,
  normalizeResolutionHints,
  normalizePath,
  resolveFilePathFromRoot,
  getGitHead,
  isGitRepo,
  getGitBlobHashes,
  listChangedFiles,
  clearImportResolutionCaches,
  mapLimit,
  stringifyUnknown,
  isFilePathWithinRoot,
  type ProjectFileDiscoveryOptions,
  type ProjectFileInfo,
} from "./util.js";
import { logWithLevel, type LogLevel } from "./logging.js";
import {
  collectGraph,
  collectEdgesForFile,
  type GraphCacheEntry,
  type GraphBuildOptions,
  type FallbackImportExtractionEvent,
  type FallbackImportExtractionReason,
  type SymbolGraph,
} from "./graphs.js";
import {
  extractGraphOnlyModuleSpecifiers,
  graphOnlyLanguageSupportsImportAliases,
  graphOnlySpecifierNeedsResolutionConfig,
  isGraphOnlyLanguage,
} from "./documentLinks.js";
import {
  attemptParsePreparedFileContext,
  ensureParsedContext as ensureParsedContextFromModule,
  parseFile as parseFileFromModule,
  parsePreparedFileContext,
  prepareFileForIndexing,
  type ParsedFileCacheEntry,
  type ParsedFileContext,
  type PreparedFileContext,
} from "./indexer/parse-context.js";
import { collectImportsForFile as collectImportsForFileFromImportsModule } from "./indexer/imports.js";
import { collectLocalsAndExportsFromSource as collectLocalsAndExportsFromLocalsModule } from "./indexer/locals-and-exports.js";
import {
  collectNamespaceMemberRefs,
  findReferences,
  goToDefinition,
  resolveExport,
  resolveImported,
} from "./indexer/navigation.js";
import {
  extractEnclosingBlock,
  extractLineContext,
  rangeContains,
  sameDef,
} from "./indexer/reference-context.js";
import {
  DEFAULT_REF_CONTEXT_LINES,
  QUERY_DRIVEN_LOCALS_LANGUAGES,
  compareEdges,
  edgeKey,
  parseGoImportAlias,
  toRelativeEdge,
} from "./indexer/shared.js";
import {
  buildScopeIndexFromSource as buildScopeIndexFromSourceFromModule,
  type ScopeIndex,
} from "./indexer/scope.js";
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
  type ResolvedExport,
  type SymbolDef,
  type SymbolHandle,
  type SymbolListItem,
  type WorkerPoolReport,
} from "./indexer/types.js";
import type { Edge, Range, FileId, Graph } from "./types.js";
import {
  executeJsQueryAsNativeMatches,
  getNativeSyntaxTreeExecution,
  isNativeQueryAuthoritative,
  isNativeQueryModified,
  isNativeRequiredUnavailableError,
  getCachedNormalizedQuery,
  isNativeBindingLoadedForLanguage,
  isNativeTreeSitterAvailable,
  shouldAvoidJsFallbackForLanguage,
  type NativeRuntimeMode,
  type NativeCapture,
  type NativeQueryResults,
} from "./native/treeSitterNative.js";
import { ProjectedSyntaxTree } from "./native/projectedTree.js";
import {
  initNativeBackendReport,
  recordNativeExecutionOutcome,
} from "./native/nativeBackendReport.js";
import {
  capturesByName,
  capturesNamed,
  rangeFromNativeCapture,
} from "./native/queryResults.js";
import type {
  NativeExtractResult,
  NativeExtractTask,
} from "./worker/nativeExtractWorker.js";
import type {
  JsLanguage,
  SyntaxNodeLike,
  SyntaxTreeLike,
} from "./languages/types.js";

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
  ResolvedExport,
  SymbolDef,
  SymbolHandle,
  SymbolListItem,
  WorkerPoolReport,
} from "./indexer/types.js";
export {
  collectNamespaceMemberRefs,
  findReferences,
  goToDefinition,
  resolveExport,
  resolveImported,
} from "./indexer/navigation.js";

type IndexedFileGraphContext = {
  source: string;
  sup: LanguageSupport;
  lang?: JsLanguage;
  nativeQueries?: NativeQueryResults | null;
  tree?: SyntaxTreeLike;
};

type IndexedFileModuleResult = {
  module: ModuleIndex;
  graphContext: IndexedFileGraphContext;
};

function initParserBackendDegradationReport(
  report: BuildReport | undefined,
): ParserBackendDegradationReport | undefined {
  if (!report) return undefined;
  initNativeBackendReport(report);
  report.backend ??= {
    native: {
      available: false,
      enabled: false,
      supportedLanguageIds: [],
      filesUsed: 0,
      filesFellBack: 0,
      fallbackReasons: {
        unavailable: 0,
        unsupportedLanguage: 0,
        queryFailure: 0,
      },
      byLanguage: {},
      errors: [],
    },
  };
  report.backend.parser ??= {
    total: 0,
    byLanguage: {},
    files: [],
  };
  return report.backend.parser;
}

function recordParserBackendDegradation(
  report: BuildReport | undefined,
  entry: {
    file: string;
    languageId: string;
    nativeFallbackReason?: NativeBackendFallbackReason;
    nativeError?: string;
    jsError?: string;
  },
): void {
  const parserReport = initParserBackendDegradationReport(report);
  if (!parserReport) return;
  parserReport.total += 1;
  parserReport.byLanguage[entry.languageId] =
    (parserReport.byLanguage[entry.languageId] ?? 0) + 1;
  if (parserReport.files.length >= 20) return;
  parserReport.files.push(entry);
}

function createEmptyModuleIndex(file: string): ModuleIndex {
  return {
    file,
    exports: [],
    imports: [],
    locals: [],
  };
}

async function prepareFileContextForBuild(
  file: string,
  support: LanguageSupport,
  opts: BuildOptions | undefined,
  workerSetup: WorkerPoolSetupResult,
  report: BuildReport | undefined,
): Promise<PreparedFileContext> {
  let prepared: PreparedFileContext;
  if (workerSetup.pool && !isSFCFile(file)) {
    if (workerSetup.report) workerSetup.report.tasksSubmitted++;
    try {
      const workerResult: NativeExtractResult = await workerSetup.pool.run(
        buildWorkerTask(file, support),
      );
      prepared = workerResultToPrepared(workerResult, support, file);
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
      if (workerSetup.report) workerSetup.report.tasksFailed++;
      if (workerSetup.report) {
        workerSetup.report.errors ??= [];
        if (workerSetup.report.errors.length < 20) {
          workerSetup.report.errors.push({
            file,
            message: stringifyUnknown(error),
          });
        }
      }
      prepared = await prepareFileForIndexing(file, opts?.native);
    }
  } else {
    prepared = await prepareFileForIndexing(file, opts?.native);
  }
  recordNativeExecutionOutcome(report, {
    file,
    support: prepared.sup,
    languageId: prepared.sup.id,
    results: prepared.nativeQueries,
    ...(prepared.nativeFallbackReason
      ? { fallbackReason: prepared.nativeFallbackReason }
      : {}),
    ...(prepared.nativeError ? { error: prepared.nativeError } : {}),
  });
  return prepared;
}

async function resolveCrossModuleSymbolExports(
  file: string,
  mod: ModuleIndex,
  support: LanguageSupport,
  projectRoot: string,
  graphOptions: GraphBuildOptions,
  workspaceConfig: Awaited<ReturnType<typeof loadWorkspaceConfig>>,
  logLevel: LogLevel | undefined,
): Promise<void> {
  if (!support.supportsCrossModuleSymbols) return;
  if (support.id !== "ts" && support.id !== "js") return;
  const { matchPath } = await loadNearestTsconfigFor(file, logLevel);
  for (const entry of mod.exports) {
    if (
      entry.type !== "reexport" &&
      entry.type !== "exportStar" &&
      entry.type !== "namespaceReexport"
    ) {
      continue;
    }
    if (entry.fromModule.startsWith(".")) {
      const resolved = await resolveSpecifier(
        file,
        entry.fromModule,
        projectRoot,
        matchPath,
        workspaceConfig,
        {
          resolveNodeModules: !!graphOptions.resolveNodeModules,
          ...(graphOptions.resolutionHints
            ? { resolutionHints: graphOptions.resolutionHints }
            : {}),
        },
      );
      if (typeof resolved === "string") entry.fromModule = resolved;
      continue;
    }
    const pkgResolved = await resolveWorkspacePackage(
      entry.fromModule,
      workspaceConfig,
    );
    if (pkgResolved) entry.fromModule = pkgResolved;
  }
}

async function buildIndexedModuleForFile(args: {
  file: string;
  support: LanguageSupport;
  projectRoot: string;
  opts: BuildOptions | undefined;
  report: BuildReport | undefined;
  graphOptions: GraphBuildOptions;
  workspaceConfig: Awaited<ReturnType<typeof loadWorkspaceConfig>>;
  workerSetup: WorkerPoolSetupResult;
  parsedMap: Map<string, ParsedFileContext>;
  parsedCacheMaxEntries: number;
  jsonDependencies: Set<string>;
  bloomFilterCache: import("./util/bloomFilter.js").BloomFilterCache | undefined;
  onFallbackImportExtraction:
    | ((event: FallbackImportExtractionEvent) => void)
    | undefined;
  fileSignatures: Map<string, FileSignature>;
  cacheEnabled: boolean;
}): Promise<IndexedFileModuleResult> {
  const prepared = await prepareFileContextForBuild(
    args.file,
    args.support,
    args.opts,
    args.workerSetup,
    args.report,
  );
  const { source, sup, nativeQueries } = prepared;
  let resolvedLang = prepared.lang;
  let tree: SyntaxTreeLike | undefined;
  const graphOnlyLanguage = isGraphOnlyLanguage(sup.id);

  if (!nativeQueries && !graphOnlyLanguage) {
    const parseAttempt = attemptParsePreparedFileContext(prepared);
    const parsed = parseAttempt.parsed;
    if (parsed) {
      tree = parsed.tree;
      resolvedLang = parsed.lang;
      setParsedCacheEntry(
        args.parsedMap,
        args.file,
        parsed,
        args.parsedCacheMaxEntries,
      );
    } else {
      recordParserBackendDegradation(args.report, {
        file: args.file,
        languageId: prepared.sup.id,
        ...(parseAttempt.nativeFallbackReason
          ? { nativeFallbackReason: parseAttempt.nativeFallbackReason }
          : {}),
        ...(parseAttempt.nativeError
          ? { nativeError: parseAttempt.nativeError }
          : {}),
        ...(parseAttempt.jsError ? { jsError: parseAttempt.jsError } : {}),
      });
    }
  }
  const lacksParserContext = !nativeQueries && !tree;

  if (args.bloomFilterCache) {
    const filter = buildBloomFilterFromSource(source, sup.id);
    args.bloomFilterCache.set(args.file, filter);
  }

  const imports = await collectImportsForFile(args.file, args.projectRoot, {
    source,
    ...(tree && isJsSyntaxTree(tree) ? { tree } : {}),
    sup,
    ...(resolvedLang ? { lang: resolvedLang } : {}),
    ...(nativeQueries !== undefined ? { nativeQueries } : {}),
    graphOptions: args.graphOptions,
    ...(args.opts?.logLevel ? { logLevel: args.opts.logLevel } : {}),
    ...(args.onFallbackImportExtraction
      ? { onFallbackImportExtraction: args.onFallbackImportExtraction }
      : {}),
  });
  collectJsonDependencies(imports, args.jsonDependencies);
  const mod = lacksParserContext
    ? { ...createEmptyModuleIndex(args.file), imports }
    : collectLocalsAndExportsFromSource(
        args.file,
        source,
        sup,
        resolvedLang,
        imports,
        {
          ...(tree ? { tree } : {}),
          ...(nativeQueries !== undefined ? { nativeQueries } : {}),
          ...(args.opts?.native ? { nativeMode: args.opts.native } : {}),
          ...(args.opts?.logLevel ? { logLevel: args.opts.logLevel } : {}),
        },
      );
  mod.imports = imports;
  await resolveCrossModuleSymbolExports(
    args.file,
    mod,
    sup,
    args.projectRoot,
    args.graphOptions,
    args.workspaceConfig,
    args.opts?.logLevel,
  );

  const sigInfo = args.fileSignatures.get(args.file);
  if (sigInfo) {
    const cacheSig = args.cacheEnabled
      ? await cacheSignatureForFile(args.file, sigInfo)
      : sigInfo.cacheSig;
    writeToCache(args.projectRoot, args.file, cacheSig, mod, args.opts);
  }

  return {
    module: mod,
    graphContext: {
      source,
      sup,
      ...(resolvedLang ? { lang: resolvedLang } : {}),
      ...(nativeQueries !== undefined ? { nativeQueries } : {}),
      ...(tree ? { tree } : {}),
    },
  };
}

// ---------------- Worker pool helpers ----------------

/** SFC files need source preprocessing the worker doesn't handle. */
function isSFCFile(filePath: string): boolean {
  return (
    filePath.endsWith(".vue") ||
    filePath.endsWith(".svelte") ||
    filePath.endsWith(".astro")
  );
}

type WorkerPoolSetupResult = {
  pool: import("piscina").Piscina | null;
  report: WorkerPoolReport | undefined;
  startTime: number;
};

async function setupWorkerPool(
  opts: BuildOptions | undefined,
): Promise<WorkerPoolSetupResult> {
  const shouldUseWorkers =
    !!opts?.useNativeWorkers &&
    opts?.native !== "off" &&
    isNativeTreeSitterAvailable(opts?.native);
  const report: WorkerPoolReport | undefined = opts?.useNativeWorkers
    ? {
        enabled: shouldUseWorkers,
        threads: 0,
        tasksSubmitted: 0,
        tasksFailed: 0,
      }
    : undefined;
  let pool: import("piscina").Piscina | null = null;
  if (shouldUseWorkers) {
    try {
      const { createNativeWorkerPool } =
        await import("./worker/nativeWorkerPool.js");
      const p = createNativeWorkerPool({
        threads: opts.nativeThreads,
      });
      pool = p;
      if (report) {
        report.threads = (p.options as { maxThreads?: number }).maxThreads ?? 0;
      }
    } catch (error) {
      pool = null;
      if (report) {
        report.enabled = false;
        report.startupError = stringifyUnknown(error);
      }
    }
  }
  return { pool, report, startTime: pool ? performance.now() : 0 };
}

async function teardownWorkerPool(
  setup: WorkerPoolSetupResult,
  buildReport: BuildReport | undefined,
): Promise<void> {
  if (setup.pool) {
    if (setup.report) {
      setup.report.wallClockMs = Math.round(
        performance.now() - setup.startTime,
      );
    }
    try {
      await setup.pool.destroy();
    } catch {
      // pool destruction failure is non-fatal
    }
    setup.pool = null;
  }
  if (buildReport && setup.report) {
    buildReport.workerPool = setup.report;
  }
}

function buildWorkerTask(
  filePath: string,
  sup: LanguageSupport,
): NativeExtractTask {
  return {
    filePath,
    languageId: sup.id,
    importsQuery: getCachedNormalizedQuery(sup, "imports"),
    exportsQuery: getCachedNormalizedQuery(sup, "exports"),
    localsQuery: getCachedNormalizedQuery(sup, "locals"),
    importBindingsQuery: getCachedNormalizedQuery(sup, "importBindings"),
  };
}

function workerResultToPrepared(
  result: NativeExtractResult,
  sup: LanguageSupport,
  filePath: string,
): PreparedFileContext {
  return {
    file: filePath,
    source: result.source,
    sup,
    nativeQueries: result.nativeResults,
    ...(result.fallbackReason
      ? { nativeFallbackReason: result.fallbackReason }
      : {}),
    ...(result.error ? { nativeError: result.error } : {}),
  };
}

// ---------------- Symbol handles (agent-friendly) ----------------
export function symbolId(def: SymbolDef): SymbolHandle {
  const idx = def?.range?.start?.index ?? 0;
  return `${def.file}::${def.localName}::${idx}`;
}

export function defFromSymbolId(
  index: ProjectIndex,
  id: SymbolHandle,
): SymbolDef | null {
  if (!id) return null;
  const parts = id.split("::");
  if (parts.length < 3) return null;
  const rawFile = parts[0]!;
  const localName = parts[1]!;
  const startStr = parts[2]!;
  const file = rawFile.replace(/\\/g, "/");
  const startIndex = Number(startStr);
  const mod = index.byFile.get(file);
  if (!mod) return null;
  const exact = mod.locals.find(
    (d) =>
      d.localName === localName && (d.range?.start?.index ?? 0) === startIndex,
  );
  if (exact) return exact;
  const byName = mod.locals.find((d) => d.localName === localName);
  return byName ?? null;
}

export function resolveSymbolId(
  index: ProjectIndex,
  id: SymbolHandle,
): SymbolDef | null {
  if (!id) return null;
  const parts = id.split("::");
  if (parts.length === 3 && parts[2] === "import") {
    const rawFile = parts[0]!;
    const alias = parts[1]!;
    const file = rawFile.replace(/\\/g, "/");
    const mod = index.byFile.get(file);
    if (!mod) return null;

    // Prefer named, then default, then namespace
    const named = mod.imports.find(
      (i): i is ImportBinding & { kind: "named" } =>
        i.kind === "named" && i.local === alias,
    );
    if (named) {
      const res = resolveImported(index, named, named.imported);
      if (res && !("namespace" in res)) return res;
      const target =
        typeof named.resolved === "string" ? named.resolved : undefined;
      if (target) {
        const hit = resolveExport(index, target, named.imported);
        if (hit?.kind === "resolved") return hit.def;
      }
    }

    const deflt = mod.imports.find(
      (i): i is ImportBinding & { kind: "default" } =>
        i.kind === "default" && i.local === alias,
    );
    if (deflt) {
      const res = resolveImported(index, deflt, "default");
      if (res && !("namespace" in res)) return res;
      const target =
        typeof deflt.resolved === "string" ? deflt.resolved : undefined;
      if (target) {
        const hit = resolveExport(index, target, "default");
        if (hit?.kind === "resolved") return hit.def;
        const tmod = index.byFile.get(target);
        const first = tmod?.exports.find(
          (e): e is ExportEntry & { type: "local" } => e.type === "local",
        );
        if (first) return first.target;
      }
    }

    const ns = mod.imports.find(
      (i) => i.kind === "namespace" && i.localNS === alias,
    );
    if (ns) {
      const target = typeof ns.resolved === "string" ? ns.resolved : undefined;
      if (target) {
        const tmod = index.byFile.get(target);
        const first = tmod?.exports.find(
          (e): e is ExportEntry & { type: "local" } => e.type === "local",
        );
        if (first) return first.target;
        const firstLocal = tmod?.locals?.[0];
        if (firstLocal) return firstLocal;
      }
    }

    return null;
  }

  // Otherwise treat as direct definition handle
  return defFromSymbolId(index, id);
}

function isJsonFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".json");
}

function collectJsonDependencies(
  imports: ImportBinding[],
  bucket: Set<string>,
) {
  for (const imp of imports) {
    const resolved =
      typeof imp.resolved === "string"
        ? imp.resolved.replace(/\\/g, "/")
        : null;
    if (resolved && isJsonFile(resolved)) bucket.add(resolved);
  }
}

function ensureJsonModule(modules: Map<FileId, ModuleIndex>, filePath: string) {
  const resolved = path.resolve(filePath);
  const normalized = resolved.replace(/\\/g, "/");
  if (modules.has(normalized)) return;
  if (!fs.existsSync(resolved)) return;
  const pos = { line: 1, column: 1, index: 0 };
  const sym: SymbolDef = {
    file: normalized,
    localName: "default",
    kind: SymbolKind.Default,
    range: { start: pos, end: pos },
  };
  const mod: ModuleIndex = {
    file: normalized,
    exports: [{ type: "local", exportedAs: "default", target: sym }],
    imports: [],
    locals: [sym],
  };
  modules.set(normalized, mod);
}

function expandStarImports(modules: Map<FileId, ModuleIndex>): void {
  const importAlreadyPresent = (
    imports: ImportBinding[],
    candidate: ImportBinding,
  ): boolean =>
    imports.some((existing) => {
      if (existing.kind !== candidate.kind) return false;
      if (existing.from !== candidate.from) return false;
      if (existing.resolved !== candidate.resolved) return false;
      if ((existing.typeOnly ?? false) !== (candidate.typeOnly ?? false)) {
        return false;
      }
      if (candidate.kind === "named" && existing.kind === "named") {
        return (
          existing.local === candidate.local &&
          existing.imported === candidate.imported
        );
      }
      if (candidate.kind === "namespace" && existing.kind === "namespace") {
        return existing.localNS === candidate.localNS;
      }
      return false;
    });

  for (const mod of modules.values()) {
    for (const imp of [...mod.imports]) {
      if (imp.kind !== "star" || typeof imp.resolved !== "string") continue;
      const target = modules.get(imp.resolved);
      if (!target) continue;
      const targetSup = supportForFile(imp.resolved);
      const exportedSymbols =
        target.exports.filter((entry) => entry.type === "local").length > 0
          ? target.exports
              .filter(
                (entry): entry is Extract<ExportEntry, { type: "local" }> =>
                  entry.type === "local",
              )
              .map((entry) => entry.target)
          : target.locals.filter((local) => !local.localName.startsWith("_"));
      const seen = new Set<string>();
      for (const sym of exportedSymbols) {
        if (!sym.localName || seen.has(sym.localName)) continue;
        seen.add(sym.localName);
        const treatAsNamespace =
          targetSup?.id === "ruby" && sym.kind === SymbolKind.Class;
        const expandedImport: ImportBinding = treatAsNamespace
          ? {
              kind: "namespace",
              localNS: sym.localName,
              from: imp.from,
              resolved: imp.resolved,
              ...(imp.typeOnly !== undefined ? { typeOnly: imp.typeOnly } : {}),
            }
          : {
              kind: "named",
              local: sym.localName,
              imported: sym.localName,
              from: imp.from,
              resolved: imp.resolved,
              ...(imp.typeOnly !== undefined ? { typeOnly: imp.typeOnly } : {}),
            };
        if (importAlreadyPresent(mod.imports, expandedImport)) continue;
        mod.imports.push(expandedImport);
      }
    }
  }
}

export function goToDefinitionById(
  index: ProjectIndex,
  id: SymbolHandle,
): GoToResult {
  const def = resolveSymbolId(index, id);
  if (def) return { status: "ok", definition: def };
  return { status: "not_found", reason: "No matching definition for handle" };
}

export async function findReferencesById(
  index: ProjectIndex,
  id: SymbolHandle,
) {
  const def = resolveSymbolId(index, id);
  if (!def)
    return {
      status: "not_found",
      reason: "No matching definition for handle",
    } as const;
  return await findReferences(index, { def });
}

export function listSymbols(
  index: ProjectIndex,
  opts?: { file?: FileId; includeImports?: boolean },
): SymbolListItem[] {
  const out: SymbolListItem[] = [];
  const files = opts?.file
    ? [opts.file.replace(/\\/g, "/")]
    : Array.from(index.byFile.keys());

  for (const f of files) {
    const mod = index.byFile.get(f);
    if (!mod) continue;
    for (const def of mod.locals) {
      out.push({
        id: symbolId(def),
        file: f,
        name: def.localName,
        kind: def.kind,
        range: def.range,
        ...(def.docstring ? { docstring: def.docstring } : {}),
      });
    }
    if (opts?.includeImports) {
      for (const imp of mod.imports) {
        if (imp.kind === "named")
          out.push({
            id: `${f}::${imp.local}::import`,
            file: f,
            name: imp.local,
            kind: "import",
          });
        else if (imp.kind === "default")
          out.push({
            id: `${f}::${imp.local}::import`,
            file: f,
            name: imp.local,
            kind: "import",
          });
        else if (imp.kind === "namespace")
          out.push({
            id: `${f}::${imp.localNS}::import`,
            file: f,
            name: imp.localNS,
            kind: "namespaceImport",
          });
      }
    }
  }

  return out;
}

function appendJsLikeRegexFallbackExports(
  file: string,
  source: string,
  locals: SymbolDef[],
  exports: ExportEntry[],
): void {
  const maskedSource = maskJsLikeCommentsAndStrings(source);
  const reDecl =
    /\bexport\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  const reDefault = /\bexport\s+default\s+([A-Za-z_$][\w$]*)/g;
  const reExportAssign = /\bexport\s*=\s*([A-Za-z_$][\w$]*)/g;
  const reReexport = /\bexport\s*\{\s*([^}]+)\}\s*from\s*("|')([^"']*)\2/g;
  const reReexportNs =
    /\bexport\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*("|')([^"']*)\2/g;
  const reStar = /\bexport\s*\*\s*from\s*("|')([^"']*)\1/g;
  const reCjsFn =
    /(?:^|[;\n\r])\s*(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=\s*(function\b|\([^)]*\)\s*=>)/g;
  const reCjsObjFn = /([A-Za-z_$][\w$]*)\s*:\s*(function\b|\([^)]*\)\s*=>)/g;
  const moduleExportsObject = /module\.exports\s*=\s*\{([^}]*)\}/s;
  let match: RegExpExecArray | null;

  while ((match = reDecl.exec(maskedSource))) {
    const name = match[1]!;
    if (!exports.some((entry) => entry.type === "local" && entry.exportedAs === name)) {
      const local = locals.find((def) => def.localName === name);
      if (local) exports.push({ type: "local", exportedAs: name, target: local });
    }
  }

  while ((match = reDefault.exec(maskedSource))) {
    const name = match[1]!;
    if (!exports.some((entry) => entry.type === "local" && entry.exportedAs === "default")) {
      const local = locals.find((def) => def.localName === name);
      if (local) {
        exports.push({
          type: "local",
          exportedAs: "default",
          target: { ...local, kind: SymbolKind.Default },
        });
      }
    }
  }

  while ((match = reExportAssign.exec(maskedSource))) {
    const name = match[1]!;
    if (!exports.some((entry) => entry.type === "local" && entry.exportedAs === "default")) {
      const local = locals.find((def) => def.localName === name);
      if (local) {
        exports.push({
          type: "local",
          exportedAs: "default",
          target: { ...local, kind: SymbolKind.Default },
        });
      }
    }
  }

  while ((match = reReexport.exec(maskedSource))) {
    const list = match[1]!
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const from = source.slice(match.index, reReexport.lastIndex).match(/from\s*("|')([^"']+)\1/)?.[2];
    if (!from) continue;
    for (const spec of list) {
      const entryMatch = spec.match(
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
      );
      if (!entryMatch) continue;
      const srcName = entryMatch[1]!;
      const alias = entryMatch[2] ?? srcName;
      if (
        !exports.some(
          (entry) =>
            entry.type === "reexport" &&
            entry.exportedAs === alias &&
            entry.fromModule === from,
        )
      ) {
        exports.push({
          type: "reexport",
          exportedAs: alias,
          fromModule: from,
          sourceSpecifier: srcName,
        });
      }
    }
  }

  while ((match = reReexportNs.exec(maskedSource))) {
    const alias = match[1]!;
    const from = source.slice(match.index, reReexportNs.lastIndex).match(/from\s*("|')([^"']+)\1/)?.[2];
    if (!from) continue;
    if (
      !exports.some(
        (entry) =>
          (entry.type === "reexport" || entry.type === "namespaceReexport") &&
          entry.exportedAs === alias &&
          entry.fromModule === from,
      )
    ) {
      exports.push({
        type: "namespaceReexport",
        exportedAs: alias,
        fromModule: from,
      });
    }
  }

  while ((match = reStar.exec(maskedSource))) {
    const from = source.slice(match.index, reStar.lastIndex).match(/("|')([^"']+)\1/)?.[2];
    if (!from) continue;
    if (!exports.some((entry) => entry.type === "exportStar" && entry.fromModule === from)) {
      exports.push({
        type: "exportStar",
        fromModule: from,
        sourceSpecifier: from,
      });
    }
  }

  while ((match = reCjsFn.exec(maskedSource))) {
    const exportedAs = match[1]!;
    let local = locals.find((def) => def.localName === exportedAs);
    if (!local) {
      const idx = match.index + match[0].indexOf(exportedAs);
      const pos = { line: 1, column: 1, index: idx };
      local = {
        file,
        localName: exportedAs,
        kind: SymbolKind.Function,
        range: { start: pos, end: pos },
      };
      locals.push(local);
    }
    if (!exports.some((entry) => entry.type === "local" && entry.exportedAs === exportedAs)) {
      exports.push({ type: "local", exportedAs, target: local });
    }
  }

  const moduleExportsObjMatch = moduleExportsObject.exec(maskedSource);
  if (!moduleExportsObjMatch || moduleExportsObjMatch.index === undefined) {
    return;
  }

  const objContent = moduleExportsObjMatch[1]!;
  let objectMatch: RegExpExecArray | null;
  while ((objectMatch = reCjsObjFn.exec(objContent))) {
    const exportedAs = objectMatch[1]!;
    let local = locals.find((def) => def.localName === exportedAs);
    if (!local) {
      const idx =
        moduleExportsObjMatch.index + moduleExportsObjMatch[0].indexOf(exportedAs);
      const pos = { line: 1, column: 1, index: idx };
      local = {
        file,
        localName: exportedAs,
        kind: SymbolKind.Function,
        range: { start: pos, end: pos },
      };
      locals.push(local);
    }
    if (!exports.some((entry) => entry.type === "local" && entry.exportedAs === exportedAs)) {
      exports.push({ type: "local", exportedAs, target: local });
    }
  }
}

export function getApiSurface(index: ProjectIndex): ApiSurface {
  const out: ApiSurface = [];
  for (const [file, mod] of index.byFile) {
    const exports = mod.exports.map((e) => {
      if (e.type === "local") {
        return {
          name: e.target.localName,
          kind: e.target.kind,
          exportedAs: e.exportedAs,
        };
      } else if (e.type === "reexport") {
        return {
          name: e.sourceSpecifier,
          kind: "reexport",
          exportedAs: e.exportedAs,
          target: { file: e.fromModule, name: e.sourceSpecifier },
        };
      } else if (e.type === "namespaceReexport") {
        return {
          name: "*",
          kind: "namespaceReexport",
          exportedAs: e.exportedAs,
          target: { file: e.fromModule, name: "*" },
        };
      } else {
        return {
          name: "*",
          kind: "exportStar",
          exportedAs: "*",
          target: { file: e.fromModule, name: "*" },
        };
      }
    });
    if (exports.length > 0) {
      out.push({ file, exports });
    }
  }
  return out;
}

// ---------------- Incremental cache (memory/disk) ----------------
const PARSED_CACHE_VERSION = 1;
type ModuleCacheEntry = {
  version: number;
  sig: string;
  mod: ModuleIndex;
};
const memoryCache = new Map<string, ModuleCacheEntry>();

type BetterSqliteDatabase = import("better-sqlite3").Database;

type PackageJsonDependencyInfo = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

async function collectWorkspaceManifestDependencyEdges(
  projectRoot: string,
  discovery?: ProjectFileDiscoveryOptions,
  allowedManifestFiles?: ReadonlySet<string>,
  logLevel?: LogLevel,
): Promise<Edge[]> {
  const manifestPaths = await listProjectFiles(
    projectRoot,
    ["**/package.json"],
    {
      ...discovery,
      ...(logLevel ? { logLevel } : {}),
    },
  );
  const scopedManifestPaths = allowedManifestFiles
    ? manifestPaths.filter((manifestPath) =>
        allowedManifestFiles.has(manifestPath),
      )
    : manifestPaths;
  if (scopedManifestPaths.length === 0) return [];

  const manifestByPackageName = new Map<string, string>();
  const parsedByPath = new Map<string, PackageJsonDependencyInfo>();

  for (const manifestPath of scopedManifestPaths) {
    try {
      const raw = await fsp.readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as PackageJsonDependencyInfo;
      parsedByPath.set(manifestPath, parsed);
      if (typeof parsed.name === "string" && parsed.name.trim()) {
        manifestByPackageName.set(parsed.name, manifestPath);
      }
    } catch {
      continue;
    }
  }

  const edges: Edge[] = [];
  for (const [fromManifest, parsed] of parsedByPath.entries()) {
    const dependencySets = [
      parsed.dependencies,
      parsed.devDependencies,
      parsed.peerDependencies,
      parsed.optionalDependencies,
    ];
    for (const dependencySet of dependencySets) {
      if (!dependencySet) continue;
      for (const dependencyName of Object.keys(dependencySet)) {
        const toManifest = manifestByPackageName.get(dependencyName);
        if (!toManifest) continue;
        edges.push({
          from: fromManifest,
          to: { type: "file", path: toManifest },
          raw: dependencyName,
        });
      }
    }
  }

  return edges;
}

const loadBetterSqlite3 = () => {
  const require = createRequire(import.meta.url);
  return require("better-sqlite3") as typeof import("better-sqlite3");
};

const diskCacheDatabases = new Map<string, BetterSqliteDatabase>();

function diskCacheDatabasePath(
  projectRoot: string,
  opts?: BuildOptions,
): string {
  return normalizePath(
    path.join(cacheRoot(projectRoot, opts), "index-cache.sqlite"),
  );
}

function getDiskCacheDatabase(
  projectRoot: string,
  opts?: BuildOptions,
): BetterSqliteDatabase {
  const dbPath = diskCacheDatabasePath(projectRoot, opts);
  const existing = diskCacheDatabases.get(dbPath);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const BetterSqlite3 = loadBetterSqlite3();
  const db = new BetterSqlite3(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_cache (
      file TEXT PRIMARY KEY,
      sig TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_module_cache_sig ON module_cache(sig);
  `);
  diskCacheDatabases.set(dbPath, db);
  return db;
}

function closeDiskCacheDatabase(
  projectRoot: string,
  opts?: BuildOptions,
): void {
  const dbPath = diskCacheDatabasePath(projectRoot, opts);
  const db = diskCacheDatabases.get(dbPath);
  if (!db) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* checkpoint best-effort */
  }
  try {
    db.close();
    diskCacheDatabases.delete(dbPath);
  } catch {
    // If close fails, keep the handle in the map so a later attempt can retry.
  }
}

const MANIFEST_VERSION = 1;

type ManifestFileEntry = GraphCacheEntry;

type ManifestBuildOptions = {
  cache?: BuildOptions["cache"];
  cacheStrict?: boolean;
  useBloomFilters?: boolean;
  preset?: BuildOptions["preset"];
  incrementalStrict?: boolean;
  discovery?: {
    includeGlobs?: string[];
    ignoreGlobs?: string[];
    useGitignore: boolean;
  };
};

type IndexManifest = {
  version: number;
  projectRoot: string;
  updatedAt: number;
  lastCommit?: string;
  configHash?: string;
  graphOptions?: GraphBuildOptions;
  buildOptions?: ManifestBuildOptions;
  files: Record<string, ManifestFileEntry>;
};

type ConfigHashResult = {
  hash: string;
  error?: string;
};

function normalizeIndexedFileInputs(
  projectRoot: string,
  files: readonly string[],
  label: string,
): string[] {
  return Array.from(
    new Set(
      files
        .filter(Boolean)
        .map((file) => assertFilePathWithinRoot(projectRoot, file, label)),
    ),
  );
}

function sanitizeManifestEntriesForRoot(
  projectRoot: string,
  files: Record<string, ManifestFileEntry> | undefined,
): Record<string, ManifestFileEntry> {
  const sanitizedEntries: Record<string, ManifestFileEntry> = {};
  for (const [file, entry] of Object.entries(files ?? {})) {
    if (!isFilePathWithinRoot(projectRoot, file)) continue;
    sanitizedEntries[file] = entry;
  }
  return sanitizedEntries;
}

async function computeConfigHash(
  projectRoot: string,
  logLevel?: LogLevel,
): Promise<ConfigHashResult> {
  try {
    const configFiles = await fg(
      [...DEFAULT_PROJECT_MANIFESTS, "**/.gitignore"],
      {
        cwd: projectRoot,
        absolute: true,
        dot: true,
        ignore: [
          "**/node_modules/**",
          "**/.git/**",
          "**/dist/**",
          "**/build/**",
          "**/target/**",
          "**/.venv/**",
          "**/__pycache__/**",
        ],
      },
    );
    configFiles.sort();
    const hash = crypto.createHash("sha1");
    let firstError: string | undefined;
    for (const file of configFiles) {
      try {
        const content = await fsp.readFile(file, "utf8");
        const rel = path.relative(projectRoot, file).replace(/\\/g, "/");
        hash.update(rel);
        hash.update(content);
      } catch (err) {
        const message = `Failed to read config file "${file}": ${stringifyUnknown(err)}`;
        if (!firstError) {
          firstError = message;
        }
        logWithLevel(logLevel, "debug", "computeConfigHash:", message);
      }
    }
    return {
      hash: hash.digest("hex"),
      ...(firstError ? { error: firstError } : {}),
    };
  } catch (error) {
    return {
      hash: "",
      error: `Failed to enumerate config files: ${stringifyUnknown(error)}`,
    };
  }
}

function recordConfigHashResult(
  manifestReport: ManifestReport | undefined,
  configHashResult: ConfigHashResult,
  logLevel: LogLevel | undefined,
): string {
  if (!configHashResult.error) return configHashResult.hash;
  if (manifestReport) {
    manifestReport.configHashError = configHashResult.error;
  }
  logWithLevel(logLevel, "warn", `Warning: ${configHashResult.error}`);
  return configHashResult.hash;
}

function cacheRoot(projectRoot: string, opts?: BuildOptions): string {
  return (
    opts?.cacheDir || path.join(projectRoot, ".codegraph-cache", "index-v1")
  );
}

type FileSignature = {
  sig: string;
  gitSig?: string;
  cacheSig: string;
  contentHash?: string;
};

function initCacheReport(
  report: BuildReport | undefined,
  mode: BuildOptions["cache"] | undefined,
): CacheReport | undefined {
  if (!report) return undefined;
  if (!report.cache) {
    report.cache = { mode: mode ?? "off", hits: 0, misses: 0 };
  }
  return report.cache;
}

function initFileReport(
  report: BuildReport | undefined,
): BuildFileReport | undefined {
  if (!report) return undefined;
  if (!report.files) {
    report.files = { total: 0, cached: 0, parsed: 0 };
  }
  return report.files;
}

function recordFileFailure(
  report: BuildReport | undefined,
  file: string,
  error: unknown,
): void {
  const fileReport = initFileReport(report);
  if (!fileReport) return;
  fileReport.failed = (fileReport.failed ?? 0) + 1;
  const errors = fileReport.errors ?? [];
  if (errors.length < 20) {
    errors.push({
      file: file.replace(/\\/g, "/"),
      message: stringifyUnknown(error),
    });
  }
  fileReport.errors = errors;
}

function initFallbackImportExtractionReport(
  report: BuildReport | undefined,
): FallbackImportExtractionReport | undefined {
  if (!report) return undefined;
  if (!report.graph) {
    report.graph = {
      fallbackImportExtraction: {
        total: 0,
        byLanguage: {},
        byReason: {
          fast: 0,
          "js-fallback-unavailable": 0,
          "query-error": 0,
          "query-empty": 0,
        },
        files: {},
      },
    };
  } else if (!report.graph.fallbackImportExtraction) {
    report.graph.fallbackImportExtraction = {
      total: 0,
      byLanguage: {},
      byReason: {
        fast: 0,
        "js-fallback-unavailable": 0,
        "query-error": 0,
        "query-empty": 0,
      },
      files: {},
    };
  }
  return report.graph.fallbackImportExtraction;
}

function createFallbackImportExtractionHandler(
  report: BuildReport | undefined,
  opts?: BuildOptions,
): ((event: FallbackImportExtractionEvent) => void) | undefined {
  const fallbackReport = initFallbackImportExtractionReport(report);
  const warned = new Set<string>();
  const logLevel = opts?.logLevel ?? "warn";
  const shouldLog = logLevel !== "silent" && logLevel !== "error";

  return (event: FallbackImportExtractionEvent) => {
    const filePath = event.file ? event.file.replace(/\\/g, "/") : "unknown";
    if (fallbackReport) {
      if (!fallbackReport.files[filePath]) {
        fallbackReport.total += 1;
        fallbackReport.byLanguage[event.language] =
          (fallbackReport.byLanguage[event.language] ?? 0) + 1;
        fallbackReport.byReason ??= {
          fast: 0,
          "js-fallback-unavailable": 0,
          "query-error": 0,
          "query-empty": 0,
        };
        fallbackReport.byReason[event.reason] += 1;
      }
      fallbackReport.files[filePath] = {
        language: event.language,
        reason: event.reason,
      };
    }
    if (!shouldLog) return;
    const warningKey = `${event.language}:${event.reason}`;
    if (warned.has(warningKey)) return;
    warned.add(warningKey);
    const severity =
      event.reason === "fast" ||
      event.reason === "js-fallback-unavailable" ||
      shouldAvoidJsFallbackForLanguage(event.language)
        ? "debug"
        : "warn";
    const message =
      event.reason === "js-fallback-unavailable"
        ? `JS fallback unavailable for ${event.language} query recovery; using regex import extraction.`
        : shouldAvoidJsFallbackForLanguage(event.language)
          ? `Native import recovery degraded for ${event.language}; using native-owned fallback extraction.`
        : "Regex fallback import extraction";
    logWithLevel(opts?.logLevel, severity, message, {
      language: event.language,
      reason: event.reason,
    });
  };
}

function initManifestReport(
  report: BuildReport | undefined,
  used: boolean,
  reused: boolean,
): ManifestReport | undefined {
  if (!report) return undefined;
  if (!report.manifest) {
    report.manifest = { used, reused };
  } else {
    report.manifest.used = used;
    report.manifest.reused = reused;
  }
  return report.manifest;
}

async function fileContentHash(file: string): Promise<string> {
  const buf = await fsp.readFile(file);
  const h = crypto.createHash("sha1");
  h.update(buf);
  return h.digest("hex");
}

async function fileStatSignature(
  file: string,
  strict?: boolean,
  opts?: { includeContentHash?: boolean },
): Promise<{ sig: string; contentHash?: string }> {
  try {
    const st = await fsp.stat(file);
    // Default to strict mode (content-hash) for reliability
    // This is more reliable than mtime, especially with git operations
    const useStrict = strict !== false; // True unless explicitly set to false
    const shouldHash = useStrict || !!opts?.includeContentHash;
    const contentHash = shouldHash ? await fileContentHash(file) : undefined;
    if (!useStrict) {
      return contentHash
        ? { sig: `${st.mtimeMs}:${st.size}`, contentHash }
        : { sig: `${st.mtimeMs}:${st.size}` };
    }
    if (contentHash) {
      return {
        sig: `${st.mtimeMs}:${st.size}:${contentHash}`,
        contentHash,
      };
    }
    return { sig: `${st.mtimeMs}:${st.size}` };
  } catch {
    return { sig: "0:0" };
  }
}

async function fileSignature(
  file: string,
  strict?: boolean,
  gitSig?: string,
  opts?: { forceContentHash?: boolean },
): Promise<FileSignature> {
  const includeContentHash = !!opts?.forceContentHash;
  const statOpts = includeContentHash
    ? { includeContentHash: true }
    : undefined;
  const { sig, contentHash } = await fileStatSignature(file, strict, statOpts);
  const cacheSig = gitSig ?? contentHash ?? sig;
  if (gitSig) {
    return {
      sig,
      gitSig,
      cacheSig,
      ...(contentHash ? { contentHash } : {}),
    };
  }
  return { sig, cacheSig, ...(contentHash ? { contentHash } : {}) };
}

async function cacheSignatureForFile(
  file: string,
  sigInfo: FileSignature,
): Promise<string> {
  if (sigInfo.gitSig) return sigInfo.gitSig;
  if (sigInfo.contentHash) return sigInfo.contentHash;
  const contentHash = await fileContentHash(file);
  sigInfo.contentHash = contentHash;
  return contentHash;
}

async function buildBloomFilterForFile(
  file: string,
): Promise<import("./util/bloomFilter.js").BloomFilter | null> {
  try {
    const source = await fsp.readFile(file, "utf8");
    const sup = supportForFile(file);
    if (!sup) return null;
    return buildBloomFilterFromSource(source, sup.id);
  } catch {
    return null;
  }
}

function isModuleIndex(value: unknown): value is ModuleIndex {
  if (!value || typeof value !== "object") return false;
  const mod = value as {
    file?: unknown;
    exports?: unknown;
    imports?: unknown;
    locals?: unknown;
  };
  return (
    typeof mod.file === "string" &&
    Array.isArray(mod.exports) &&
    Array.isArray(mod.imports) &&
    Array.isArray(mod.locals)
  );
}

function tryLoadFromCache(
  projectRoot: string,
  file: string,
  sig: string,
  opts?: BuildOptions,
  report?: BuildReport,
): ModuleIndex | null {
  const mode = opts?.cache ?? "off";
  const cacheReport = initCacheReport(report, mode);
  const cacheEnabled = mode !== "off";
  if (mode === "memory") {
    const ent = memoryCache.get(file);
    if (ent && ent.sig === sig) {
      if (cacheEnabled && cacheReport) cacheReport.hits += 1;
      return ent.mod;
    }
    if (cacheEnabled && cacheReport) cacheReport.misses += 1;
    return null;
  }
  if (mode === "disk") {
    try {
      const db = getDiskCacheDatabase(projectRoot, opts);
      const row = db
        .prepare(
          "SELECT sig, version, payload FROM module_cache WHERE file = ?",
        )
        .get(file) as
        | { sig: string; version: number; payload: string }
        | undefined;
      if (row && row.sig === sig && row.version === PARSED_CACHE_VERSION) {
        const parsed = JSON.parse(row.payload) as unknown;
        if (isModuleIndex(parsed)) {
          if (cacheEnabled && cacheReport) cacheReport.hits += 1;
          return parsed;
        }
      }
    } catch {
      /* cache read failed */
    }
    if (cacheEnabled && cacheReport) cacheReport.misses += 1;
  }
  return null;
}

function writeToCache(
  projectRoot: string,
  file: string,
  sig: string,
  mod: ModuleIndex,
  opts?: BuildOptions,
): void {
  const mode = opts?.cache ?? "off";
  if (mode === "memory") {
    memoryCache.set(file, { version: PARSED_CACHE_VERSION, sig, mod });
  } else if (mode === "disk") {
    try {
      const db = getDiskCacheDatabase(projectRoot, opts);
      db.prepare(
        `INSERT INTO module_cache (file, sig, version, payload, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(file) DO UPDATE SET
           sig = excluded.sig,
           version = excluded.version,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
      ).run(file, sig, PARSED_CACHE_VERSION, JSON.stringify(mod), Date.now());
    } catch (error) {
      logWithLevel(
        opts?.logLevel,
        "warn",
        "Warning: Failed to write to cache:",
        error,
      );
    }
  }
}

function manifestFilePath(projectRoot: string, opts?: BuildOptions): string {
  return path.join(cacheRoot(projectRoot, opts), "manifest.json");
}

async function loadManifest(
  projectRoot: string,
  opts?: BuildOptions,
): Promise<IndexManifest | null> {
  try {
    const mf = manifestFilePath(projectRoot, opts);
    const raw = await fsp.readFile(mf, "utf8");
    const parsed = JSON.parse(raw) as IndexManifest;
    if (parsed.version !== MANIFEST_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeManifest(
  projectRoot: string,
  opts: BuildOptions | undefined,
  manifest: IndexManifest,
) {
  try {
    const mf = manifestFilePath(projectRoot, opts);
    await fsp.mkdir(path.dirname(mf), { recursive: true });
    await fsp.writeFile(mf, JSON.stringify(manifest, null, 2), "utf8");
  } catch (error) {
    logWithLevel(
      opts?.logLevel,
      "warn",
      "Warning: Failed to write manifest:",
      error,
    );
  }
}

async function verifyManifestEntries(
  projectRoot: string,
  manifest: IndexManifest,
  opts: BuildOptions | undefined,
  gitAvailable: boolean,
): Promise<{ mismatches: number; missing: number }> {
  const entries = manifest.files ?? {};
  const files = Object.keys(entries);
  const existingFiles = files.filter((file) => fs.existsSync(file));
  const missing = files.length - existingFiles.length;
  const gitSigMap = gitAvailable
    ? await getGitBlobHashes(projectRoot, existingFiles, { gitAvailable })
    : new Map<string, string>();
  let mismatches = 0;
  for (const file of existingFiles) {
    const entry = entries[file];
    if (!entry) continue;
    const sigInfo = await fileSignature(
      file,
      opts?.cacheStrict,
      gitSigMap.get(file),
    );
    const matchesGitSig =
      !!entry.gitSig && !!sigInfo.gitSig && entry.gitSig === sigInfo.gitSig;
    const matchesSig = entry.sig === sigInfo.sig;
    if (!matchesGitSig && !matchesSig) mismatches += 1;
  }
  return { mismatches, missing };
}

async function buildProjectIndexFromExport(
  projectRoot: string,
  opts?: BuildOptions,
): Promise<ProjectIndex> {
  return buildProjectIndex(projectRoot, opts);
}

function graphOptionsEqual(
  a?: GraphBuildOptions,
  b?: GraphBuildOptions,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const normA = normalizeGraphOptions(a);
  const normB = normalizeGraphOptions(b);
  if (!!normA.fast !== !!normB.fast) return false;
  if (!!normA.resolveNodeModules !== !!normB.resolveNodeModules) return false;
  if (!!normA.dynamicImportHeuristics !== !!normB.dynamicImportHeuristics)
    return false;
  const disabledA = normA.fastRegexDisabledLanguages ?? [];
  const disabledB = normB.fastRegexDisabledLanguages ?? [];
  if (disabledA.length !== disabledB.length) return false;
  for (let i = 0; i < disabledA.length; i++) {
    if (disabledA[i] !== disabledB[i]) return false;
  }
  const hintsA = normA.resolutionHints ?? [];
  const hintsB = normB.resolutionHints ?? [];
  if (hintsA.length !== hintsB.length) return false;
  for (let i = 0; i < hintsA.length; i++) {
    if (hintsA[i] !== hintsB[i]) return false;
  }
  return true;
}

function normalizeManifestBuildOptions(
  opts?: ManifestBuildOptions,
): ManifestBuildOptions {
  return {
    cache: opts?.cache ?? "off",
    cacheStrict: opts?.cacheStrict ?? true,
    useBloomFilters: opts?.useBloomFilters ?? true,
    preset: opts?.preset,
    incrementalStrict: opts?.incrementalStrict ?? false,
    ...(opts?.discovery ? { discovery: opts.discovery } : {}),
  };
}

function normalizeDiscoveryOptions(
  discovery?: ProjectFileDiscoveryOptions,
): ManifestBuildOptions["discovery"] {
  if (!discovery) return undefined;
  const includeGlobs = Array.from(
    new Set(
      (discovery.includeGlobs ?? []).map((glob) => glob.trim()).filter(Boolean),
    ),
  ).sort();
  const ignoreGlobs = Array.from(
    new Set(
      (discovery.ignoreGlobs ?? []).map((glob) => glob.trim()).filter(Boolean),
    ),
  ).sort();
  const useGitignore = discovery.useGitignore !== false;
  if (includeGlobs.length === 0 && ignoreGlobs.length === 0 && useGitignore) {
    return undefined;
  }
  return {
    ...(includeGlobs.length > 0 ? { includeGlobs } : {}),
    ...(ignoreGlobs.length > 0 ? { ignoreGlobs } : {}),
    useGitignore,
  };
}

function normalizeBuildOptions(opts?: BuildOptions): ManifestBuildOptions {
  const discovery = normalizeDiscoveryOptions(opts?.discovery);
  return {
    cache: opts?.cache ?? "off",
    cacheStrict: opts?.cacheStrict ?? true,
    useBloomFilters: opts?.useBloomFilters ?? true,
    preset: opts?.preset,
    incrementalStrict: opts?.incrementalStrict ?? false,
    ...(discovery ? { discovery } : {}),
  };
}

function summarizeBuildOptions(opts?: BuildOptions): ManifestBuildOptions {
  return normalizeBuildOptions(opts);
}

function normalizeLanguageList(list?: string[]): string[] {
  // Normalize language IDs for stable comparisons (trim, lowercase, dedupe, sort).
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of list ?? []) {
    const normalized = entry.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  out.sort();
  return out;
}

function diffBuildOptions(
  manifestOpts: ManifestBuildOptions | undefined,
  currentOpts: BuildOptions | undefined,
): string[] {
  if (!manifestOpts) return [];
  const normalizedManifest = normalizeManifestBuildOptions(manifestOpts);
  const normalizedCurrent = normalizeBuildOptions(currentOpts);
  const diffs: string[] = [];
  if (normalizedManifest.cache !== normalizedCurrent.cache) diffs.push("cache");
  if (normalizedManifest.cacheStrict !== normalizedCurrent.cacheStrict)
    diffs.push("cacheStrict");
  if (normalizedManifest.useBloomFilters !== normalizedCurrent.useBloomFilters)
    diffs.push("useBloomFilters");
  if (normalizedManifest.preset !== normalizedCurrent.preset)
    diffs.push("preset");
  if (
    normalizedManifest.incrementalStrict !== normalizedCurrent.incrementalStrict
  )
    diffs.push("incrementalStrict");
  if (
    !normalizedDiscoveryOptionsEqual(
      normalizedManifest.discovery,
      normalizedCurrent.discovery,
    )
  ) {
    diffs.push("discovery");
  }
  return diffs;
}

function normalizedDiscoveryOptionsEqual(
  a: ManifestBuildOptions["discovery"],
  b: ManifestBuildOptions["discovery"],
): boolean {
  const normalizedA = a ?? { useGitignore: true };
  const normalizedB = b ?? { useGitignore: true };
  if (normalizedA.useGitignore !== normalizedB.useGitignore) return false;
  const includeA = normalizedA.includeGlobs ?? [];
  const includeB = normalizedB.includeGlobs ?? [];
  if (includeA.length !== includeB.length) return false;
  for (let i = 0; i < includeA.length; i++) {
    if (includeA[i] !== includeB[i]) return false;
  }
  const ignoreA = normalizedA.ignoreGlobs ?? [];
  const ignoreB = normalizedB.ignoreGlobs ?? [];
  if (ignoreA.length !== ignoreB.length) return false;
  for (let i = 0; i < ignoreA.length; i++) {
    if (ignoreA[i] !== ignoreB[i]) return false;
  }
  return true;
}

function normalizeGraphOptions(opts?: GraphBuildOptions): GraphBuildOptions {
  const resolutionHints = normalizeResolutionHints(opts?.resolutionHints);
  const fastRegexDisabledLanguages = normalizeLanguageList(
    opts?.fastRegexDisabledLanguages,
  );
  return {
    fast: !!opts?.fast,
    ...(fastRegexDisabledLanguages.length > 0
      ? { fastRegexDisabledLanguages }
      : {}),
    resolveNodeModules: !!opts?.resolveNodeModules,
    dynamicImportHeuristics: !!opts?.dynamicImportHeuristics,
    ...(resolutionHints.length > 0 ? { resolutionHints } : {}),
  };
}

export function collectLocalsAndExportsFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  lang?: JsLanguage,
  imports: ImportBinding[] = [],
  opts?: {
    tree?: SyntaxTreeLike;
    nativeQueries?: NativeQueryResults | null;
    nativeMode?: NativeRuntimeMode;
    logLevel?: LogLevel;
  },
): ModuleIndex {
  return collectLocalsAndExportsFromLocalsModule(
    file,
    source,
    support,
    lang,
    imports,
    opts,
  );
}

export async function collectImportsForFile(
  file: string,
  projectRoot: string,
  opts?: {
    source?: string;
    tree?: JsSyntaxTree;
    sup?: LanguageSupport;
    lang?: JsLanguage;
    nativeQueries?: NativeQueryResults | null;
    graphOptions?: GraphBuildOptions;
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
    logLevel?: LogLevel;
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

type ManifestMode = "off" | "read-only" | "read-write";

type BuildIndexHelperOptions = {
  manifestMode?: ManifestMode;
  warnNoFilesMessage?: string;
};

async function buildIndexFromFileListShared(
  projectRoot: string,
  rawFiles: string[],
  opts?: BuildOptions,
  helperOpts?: BuildIndexHelperOptions,
): Promise<ProjectIndex> {
  clearImportResolutionCaches();
  const normalizedProjectRoot = normalizePath(projectRoot);
  const report = opts?.report;
  const timings = report?.timings;
  const totalStart = performance.now();
  const manifestMode: ManifestMode = helperOpts?.manifestMode ?? "off";
  const useManifest = manifestMode !== "off";
  const shouldWriteManifest = manifestMode === "read-write";
  const cacheMode = opts?.cache ?? "off";
  const cacheEnabled = cacheMode !== "off";
  const graphOptions = normalizeGraphOptions(opts?.graph);
  initManifestReport(report, useManifest, false);
  initNativeBackendReport(report);
  const normalizedFiles = Array.from(
    new Set(
      normalizeIndexedFileInputs(projectRoot, rawFiles ?? [], "Index file"),
    ),
  );
  if (normalizedFiles.length === 0 && helperOpts?.warnNoFilesMessage) {
    logWithLevel(opts?.logLevel, "warn", helperOpts.warnNoFilesMessage);
  }
  const fileReport = initFileReport(report);
  const onFallbackImportExtraction = createFallbackImportExtractionHandler(
    report,
    opts,
  );
  if (fileReport) {
    fileReport.total = normalizedFiles.length;
  }
  const manifestStart = performance.now();
  const manifest = useManifest ? await loadManifest(projectRoot, opts) : null;
  const manifestFiles = sanitizeManifestEntriesForRoot(
    projectRoot,
    manifest?.files,
  );
  if (timings && useManifest) {
    timings.manifestMs = Math.round(performance.now() - manifestStart);
  }
  const staleCachedEdgeFiles = new Set<string>();
  if (manifest) {
    for (const [file, entry] of Object.entries(manifestFiles)) {
      if (
        entry.edges.some(
          (edge) => edge.to.type === "file" && !fs.existsSync(edge.to.path),
        )
      ) {
        staleCachedEdgeFiles.add(file);
      }
    }
  }
  const cachedGraphEntries =
    manifest && graphOptionsEqual(manifest.graphOptions, graphOptions)
      ? new Map<string, ManifestFileEntry>(
          Object.entries(manifestFiles).filter(
            ([file]) => !staleCachedEdgeFiles.has(file),
          ),
        )
      : undefined;
  if (report?.manifest) {
    report.manifest.reused = !!cachedGraphEntries;
  }
  const manifestEntries = shouldWriteManifest
    ? new Map<string, ManifestFileEntry>()
    : undefined;
  const modules = new Map<FileId, ModuleIndex>();
  const fileSignatures = new Map<string, FileSignature>();
  const gitAvailable = await isGitRepo(projectRoot);
  const useGitSignatures =
    gitAvailable && (cacheMode !== "off" || opts?.cacheStrict);
  const gitSigMap = useGitSignatures
    ? await getGitBlobHashes(projectRoot, normalizedFiles, {
        gitAvailable,
      })
    : new Map<string, string>();
  const jsonDependencies = new Set<string>();
  const conc = Math.max(1, Math.min(Number(opts?.threads || 0) || 8, 64));

  // Worker pool setup: create a Piscina pool for native extraction when requested
  const workerSetup = await setupWorkerPool(opts);
  try {
    const useBloomFilters = opts?.useBloomFilters ?? true; // Default to true for performance
    const bloomFilterCache = useBloomFilters
      ? new (await import("./util/bloomFilter.js")).BloomFilterCache()
      : undefined;
    const parsedMap = new Map<string, ParsedFileContext>();
    const workspaceConfig = await loadWorkspaceConfig(projectRoot);
    const parseStart = performance.now();
    const graph: Graph = { nodes: new Set(normalizedFiles), edges: [] };
    const onFileEdges = manifestEntries
      ? (file: string, entry: GraphCacheEntry) => {
          if (!entry?.sig) return;
          manifestEntries.set(file, {
            sig: entry.sig,
            ...(entry.gitSig ? { gitSig: entry.gitSig } : {}),
            edges: entry.edges,
          });
        }
      : undefined;
    let processedFiles = 0;
    const totalFiles = normalizedFiles.length;
    const fileResults = await mapLimit(normalizedFiles, conc, async (f) => {
      try {
        const sigInfo = await fileSignature(
          f,
          opts?.cacheStrict,
          gitSigMap.get(f),
          { forceContentHash: cacheEnabled },
        );
        fileSignatures.set(f, sigInfo);

        const cacheSig = cacheEnabled
          ? await cacheSignatureForFile(f, sigInfo)
          : sigInfo.cacheSig;
        let mod: ModuleIndex | null = cacheEnabled
          ? tryLoadFromCache(projectRoot, f, cacheSig, opts, report)
          : null;
        if (mod && fileReport) {
          fileReport.cached = (fileReport.cached ?? 0) + 1;
        }

        // Check if edges are cached (via collectEdgesForFile logic essentially)
        // We manually check here to decide if we need to parse
        const cachedEdgesEntry = cachedGraphEntries?.get(f);
        const edgesCached =
          !!cachedEdgesEntry &&
          ((cachedEdgesEntry.gitSig &&
            cachedEdgesEntry.gitSig === sigInfo.gitSig) ||
            cachedEdgesEntry.sig === sigInfo.sig);

        let edges: import("./types.js").Edge[] = [];

        if (mod && edgesCached) {
          // Both cached, no need to parse
          edges = await collectEdgesForFile(f, projectRoot, workspaceConfig, {
            fast: !!graphOptions.fast,
            ...(graphOptions.fastRegexDisabledLanguages
              ? {
                  fastRegexDisabledLanguages:
                    graphOptions.fastRegexDisabledLanguages,
                }
              : {}),
            resolveNodeModules: !!graphOptions.resolveNodeModules,
            dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
            ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
            ...(graphOptions.resolutionHints
              ? { resolutionHints: graphOptions.resolutionHints }
              : {}),
            fileSignature: sigInfo,
            ...(cachedEdgesEntry ? { cachedFileEdges: cachedEdgesEntry } : {}),
            ...(onFileEdges ? { onFileEdges } : {}),
            ...(onFallbackImportExtraction
              ? { onFallbackImportExtraction }
              : {}),
          });
          if (bloomFilterCache) {
            const filter = await buildBloomFilterForFile(f);
            if (filter) bloomFilterCache.set(f, filter);
          }
          return [f, mod, edges] as const;
        }

        if (fileReport) fileReport.parsed = (fileReport.parsed ?? 0) + 1;

        // FIX: Check support before parsing to avoid throwing errors for non-code files
        const supCheck = supportForFile(f);
        if (!supCheck) {
          const mod: ModuleIndex = {
            file: f,
            exports: [],
            imports: [],
            locals: [],
          };
          return [f, mod, []] as const;
        }

        let graphContext: IndexedFileGraphContext | undefined;
        // 1. Recompute ModuleIndex if needed
        if (!mod) {
          const built = await buildIndexedModuleForFile({
            file: f,
            support: supCheck,
            projectRoot,
            opts,
            report,
            graphOptions,
            workspaceConfig,
            workerSetup,
            parsedMap,
            parsedCacheMaxEntries: Math.max(
              1,
              opts?.parsedCacheMaxEntries ?? 1024,
            ),
            jsonDependencies,
            bloomFilterCache,
            onFallbackImportExtraction,
            fileSignatures,
            cacheEnabled,
          });
          mod = built.module;
          graphContext = built.graphContext;
        } else {
          // If mod was cached but edges weren't, we still need to collect json deps from mod
          collectJsonDependencies(mod.imports, jsonDependencies);
        }

        // 2. Recompute Edges (using the parsed tree)
        edges = await collectEdgesForFile(f, projectRoot, workspaceConfig, {
          ...(graphContext ? { parsed: graphContext } : {}),
          fast: !!graphOptions.fast,
          ...(graphOptions.fastRegexDisabledLanguages
            ? {
                fastRegexDisabledLanguages:
                  graphOptions.fastRegexDisabledLanguages,
              }
            : {}),
          resolveNodeModules: !!graphOptions.resolveNodeModules,
          dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
          ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
          ...(graphOptions.resolutionHints
            ? { resolutionHints: graphOptions.resolutionHints }
            : {}),
          fileSignature: sigInfo,
          ...(cachedEdgesEntry ? { cachedFileEdges: cachedEdgesEntry } : {}),
          ...(onFileEdges ? { onFileEdges } : {}),
          ...(onFallbackImportExtraction ? { onFallbackImportExtraction } : {}),
        });

        if (!mod) {
          mod = {
            file: f,
            exports: [],
            imports: [],
            locals: [],
          };
        }

        return [f, mod, edges] as const;
      } catch (error) {
        if (isNativeRequiredUnavailableError(error)) throw error;
        if (isUnsupportedParserInputError(error)) {
          const modUnsupported: ModuleIndex = {
            file: f,
            exports: [],
            imports: [],
            locals: [],
          };
          return [f, modUnsupported, []] as const;
        }
        if (isJsFallbackUnavailableError(error)) {
          const modFallbackUnavailable: ModuleIndex = {
            file: f,
            exports: [],
            imports: [],
            locals: [],
          };
          return [f, modFallbackUnavailable, []] as const;
        }
        recordFileFailure(report, f, error);
        logWithLevel(
          opts?.logLevel,
          "warn",
          `Warning: Failed to process file ${f}:`,
          error,
        );
        const modError: ModuleIndex = {
          file: f,
          exports: [],
          imports: [],
          locals: [],
        };
        return [f, modError, []] as const;
      } finally {
        if (opts?.onProgress) {
          opts.onProgress({
            type: "progress",
            message: `Indexed ${f}`,
            current: ++processedFiles,
            total: totalFiles,
          });
        }
      }
    });

    if (timings) timings.parseMs = Math.round(performance.now() - parseStart);

    const graphStart = performance.now();
    const appendUniqueGraphEdges = (edges: Edge[]) => {
      if (edges.length === 0) return;
      const seen = new Set(
        graph.edges.map(
          (edge) =>
            `${edge.from}::${edge.to.type === "file" ? edge.to.path : edge.to.name}::${edge.raw ?? ""}::${edge.typeOnly ? 1 : 0}`,
        ),
      );
      for (const edge of edges) {
        const key = `${edge.from}::${edge.to.type === "file" ? edge.to.path : edge.to.name}::${edge.raw ?? ""}::${edge.typeOnly ? 1 : 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        graph.edges.push(edge);
        if (edge.to.type === "file") graph.nodes.add(edge.to.path);
      }
    };

    for (const [file, mod, edges] of fileResults) {
      modules.set(file, mod);
      for (const e of edges) {
        graph.edges.push(e);
        if (e.to.type === "file") graph.nodes.add(e.to.path);
      }
    }

    appendUniqueGraphEdges(
      await collectWorkspaceManifestDependencyEdges(
        projectRoot,
        opts?.discovery,
        new Set(normalizedFiles),
        opts?.logLevel,
      ),
    );
    if (timings) timings.graphMs = Math.round(performance.now() - graphStart);

    for (const jsonPath of jsonDependencies) {
      ensureJsonModule(modules, jsonPath);
    }

    expandStarImports(modules);

    if (manifestEntries && manifestEntries.size > 0) {
      const writeManifestStart = performance.now();
      const lastCommit = await getGitHead(projectRoot);
      const configHashResult = await computeConfigHash(
        projectRoot,
        opts?.logLevel,
      );
      const configHash = recordConfigHashResult(
        report?.manifest,
        configHashResult,
        opts?.logLevel,
      );
      const manifestData: IndexManifest = {
        version: MANIFEST_VERSION,
        projectRoot: path.resolve(projectRoot).replace(/\\/g, "/"),
        updatedAt: Date.now(),
        ...(lastCommit ? { lastCommit } : {}),
        ...(configHash ? { configHash } : {}),
        graphOptions,
        buildOptions: summarizeBuildOptions(opts),
        files: Object.fromEntries(manifestEntries),
      };
      await writeManifest(projectRoot, opts, manifestData);
      if (timings)
        timings.writeManifestMs = Math.round(
          performance.now() - writeManifestStart,
        );
    }

    if (timings) timings.totalMs = Math.round(performance.now() - totalStart);
    const projectFiles = await discoverProjectFiles(projectRoot, {
      ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
    });

    const keepParsed = opts?.keepParsed ?? false;
    const maxParsedEntries = Math.max(1, opts?.parsedCacheMaxEntries ?? 1024);
    if (!keepParsed) {
      parsedMap.clear();
    } else {
      while (parsedMap.size > maxParsedEntries) {
        const oldest = parsedMap.keys().next().value;
        if (!oldest) break;
        parsedMap.delete(oldest);
      }
    }

    return {
      graph,
      modules,
      byFile: modules,
      projectRoot: normalizedProjectRoot,
      ...(opts?.native ? { nativeMode: opts.native } : {}),
      exportCache: new Map(),
      scopeCache: new Map(),
      parsed: keepParsed ? parsedMap : undefined,
      ...(bloomFilterCache ? { bloomFilters: bloomFilterCache } : {}),
      projectFiles,
    };
  } finally {
    await teardownWorkerPool(workerSetup, report);
  }
}

export async function buildProjectIndex(
  projectRoot: string,
  opts?: BuildOptions,
): Promise<ProjectIndex> {
  try {
    const files = await listProjectFiles(projectRoot, undefined, {
      ...opts?.discovery,
      ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
    });
    return buildIndexFromFileListShared(projectRoot, files, opts, {
      manifestMode: "read-write",
      warnNoFilesMessage: `Warning: No files found in project root: ${projectRoot}`,
    });
  } finally {
    if ((opts?.cache ?? "off") === "disk")
      closeDiskCacheDatabase(projectRoot, opts);
  }
}

export async function buildProjectIndexFromFiles(
  projectRoot: string,
  inputFiles: string[],
  opts?: BuildOptions,
): Promise<ProjectIndex> {
  try {
    return buildIndexFromFileListShared(projectRoot, inputFiles, opts, {
      manifestMode: "read-only",
      warnNoFilesMessage: `Warning: No files provided for indexing in ${projectRoot}`,
    });
  } finally {
    if ((opts?.cache ?? "off") === "disk")
      closeDiskCacheDatabase(projectRoot, opts);
  }
}

export async function buildProjectIndexIncremental(
  projectRoot: string,
  opts?: IncrementalBuildOptions,
): Promise<ProjectIndex> {
  clearImportResolutionCaches();
  const normalizedProjectRoot = normalizePath(projectRoot);
  const report = opts?.report;
  initNativeBackendReport(report);
  const timings = report?.timings;
  const totalStart = performance.now();
  const cacheMode = opts?.cache ?? "off";
  const cacheEnabled = cacheMode !== "off";
  try {
    const onFallbackImportExtraction = createFallbackImportExtractionHandler(
      report,
      opts,
    );
    const manifestStart = performance.now();
    const manifest = await loadManifest(projectRoot, opts);
    if (timings)
      timings.manifestMs = Math.round(performance.now() - manifestStart);
    const graphOptions = normalizeGraphOptions(opts?.graph);
    const strictIncremental = opts?.incrementalStrict ?? false;
    if (strictIncremental && graphOptions.fast) {
      graphOptions.fast = false;
    }
    const manifestUsed = !!manifest;
    const manifestReport = initManifestReport(report, manifestUsed, false);
    if (manifestReport && !manifestUsed) {
      manifestReport.reason = "missing";
    }
    const optionDiffs = diffBuildOptions(manifest?.buildOptions, opts);
    const warningOptionDiffs = optionDiffs.filter((diff) => diff !== "cache");
    if (warningOptionDiffs.length > 0) {
      logWithLevel(
        opts?.logLevel,
        "warn",
        `Warning: Manifest options differ from current build options: ${warningOptionDiffs.join(
          ", ",
        )}`,
      );
    }
    if (manifestReport && optionDiffs.length > 0) {
      manifestReport.optionsMismatch = optionDiffs;
    }

    // Check config hash
    const currentConfigHashResult = await computeConfigHash(
      projectRoot,
      opts?.logLevel,
    );
    const currentConfigHash = recordConfigHashResult(
      manifestReport,
      currentConfigHashResult,
      opts?.logLevel,
    );
    const configChanged =
      !!currentConfigHash &&
      (!manifest?.configHash || currentConfigHash !== manifest.configHash);

    if (
      !manifest ||
      !graphOptionsEqual(manifest.graphOptions, graphOptions) ||
      configChanged
    ) {
      if (configChanged) {
        logWithLevel(
          opts?.logLevel,
          "warn",
          "Configuration changed, rebuilding index...",
        );
      }
      if (manifestReport && manifest) {
        manifestReport.reason = "graphOptionsMismatch";
      }
      return await buildProjectIndexFromExport(projectRoot, opts);
    }

    const gitAvailable = await isGitRepo(projectRoot);
    const currentHead = gitAvailable ? await getGitHead(projectRoot) : null;
    const hasExplicitGitRange = !!opts?.gitBase || !!opts?.gitHead;
    const manifestCommitMismatch =
      !hasExplicitGitRange &&
      !!manifest.lastCommit &&
      !!currentHead &&
      manifest.lastCommit !== currentHead;
    const manifestDiffFiles = manifestCommitMismatch
      ? await listChangedFiles(projectRoot, {
          base: manifest.lastCommit,
          head: currentHead,
        })
      : [];
    if (manifestReport) manifestReport.reused = true;
    if (opts?.cacheVerify) {
      const { mismatches, missing } = await verifyManifestEntries(
        projectRoot,
        manifest,
        opts,
        gitAvailable,
      );
      if (manifestReport) {
        manifestReport.mismatches = mismatches;
        manifestReport.missing = missing;
      }
      if (mismatches > 0 || missing > 0) {
        logWithLevel(
          opts?.logLevel,
          "warn",
          `Warning: Manifest verification failed (mismatches: ${mismatches}, missing: ${missing}). Rebuilding full index.`,
        );
        return await buildProjectIndexFromExport(projectRoot, opts);
      }
    }

    const normalizeFilePath = (file: string): string =>
      assertFilePathWithinRoot(projectRoot, file, "Incremental file");

    const trackedEntries = sanitizeManifestEntriesForRoot(
      projectRoot,
      manifest.files,
    );
    const trackedFileList = Object.keys(trackedEntries);
    const trackedFiles = new Set(
      trackedFileList.filter((file) => fs.existsSync(file)),
    );
    const deletedTrackedFiles = new Set(
      trackedFileList.filter((file) => !fs.existsSync(file)),
    );
    const fileReport = initFileReport(report);
    if (fileReport) {
      fileReport.total = trackedFiles.size;
    }

    const explicitFiles = normalizeIndexedFileInputs(
      projectRoot,
      opts?.files ?? [],
      "Incremental file",
    );
    const needsGitScan = !!opts?.gitBase || !!opts?.changedSince;
    const gitOpts: { base?: string; head?: string; changedSince?: string } = {};
    if (opts?.gitBase) gitOpts.base = opts.gitBase;
    if (opts?.gitHead) gitOpts.head = opts.gitHead;
    if (!opts?.gitBase && opts?.changedSince)
      gitOpts.changedSince = opts.changedSince;

    const gitFiles = needsGitScan
      ? await listChangedFiles(projectRoot, gitOpts)
      : [];

    const allFiles = new Set<string>([
      ...trackedFiles,
      ...explicitFiles.filter((f) => fs.existsSync(f)),
      ...manifestDiffFiles.filter((f) => fs.existsSync(f)),
      ...gitFiles.filter((f) => fs.existsSync(f)),
    ]);
    if (fileReport) {
      fileReport.total = allFiles.size;
    }

    const workspaceConfig = await loadWorkspaceConfig(projectRoot);
    const dependentFilesOfDeletedTracked = new Set<string>();
    if (deletedTrackedFiles.size > 0) {
      for (const [file, entry] of Object.entries(trackedEntries)) {
        if (deletedTrackedFiles.has(file)) continue;
        if (
          entry.edges.some(
            (edge) =>
              edge.to.type === "file" && deletedTrackedFiles.has(edge.to.path),
          )
        ) {
          dependentFilesOfDeletedTracked.add(file);
        }
      }
    }

    if (allFiles.size === 0) {
      const writeManifestStart = performance.now();
      const lastCommit = await getGitHead(projectRoot);
      const configHashResult = await computeConfigHash(
        projectRoot,
        opts?.logLevel,
      );
      const configHash = recordConfigHashResult(
        manifestReport,
        configHashResult,
        opts?.logLevel,
      );
      const manifestData: IndexManifest = {
        version: MANIFEST_VERSION,
        projectRoot: path.resolve(projectRoot).replace(/\\/g, "/"),
        updatedAt: Date.now(),
        ...(lastCommit ? { lastCommit } : {}),
        ...(configHash ? { configHash } : {}),
        graphOptions,
        buildOptions: summarizeBuildOptions(opts),
        files: {},
      };
      await writeManifest(projectRoot, opts, manifestData);
      if (timings) {
        timings.writeManifestMs = Math.round(
          performance.now() - writeManifestStart,
        );
      }
      return {
        graph: { nodes: new Set(), edges: [] },
        modules: new Map(),
        byFile: new Map(),
        projectRoot: normalizedProjectRoot,
        ...(opts?.native ? { nativeMode: opts.native } : {}),
        exportCache: new Map(),
        scopeCache: new Map(),
        parsed: new Map(),
      };
    }

    const conc = Math.max(1, Math.min(Number(opts?.threads || 0) || 8, 64));

    // Worker pool setup for incremental builds
    const workerSetupIncr = await setupWorkerPool(opts);
    try {
      const fileSignatures = new Map<string, FileSignature>();
      const useGitSignatures = gitAvailable;
      const gitSigMap = useGitSignatures
        ? await getGitBlobHashes(projectRoot, Array.from(allFiles), {
            gitAvailable,
          })
        : new Map<string, string>();
      const changedFiles = new Set<string>();
      const modules = new Map<FileId, ModuleIndex>();
      const parsedMap = new Map<string, ParsedFileContext>();
      const jsonDependencies = new Set<string>();
      const useBloomFilters = opts?.useBloomFilters ?? true; // Default to true for performance
      const bloomFilterCache = useBloomFilters
        ? new (await import("./util/bloomFilter.js")).BloomFilterCache()
        : undefined;

      const markAsChanged = (file: string) => {
        if (fs.existsSync(file)) changedFiles.add(file);
      };
      explicitFiles.forEach(markAsChanged);
      manifestDiffFiles.forEach(markAsChanged);
      gitFiles.forEach(markAsChanged);
      dependentFilesOfDeletedTracked.forEach(markAsChanged);
      if (fileReport) {
        fileReport.changed = changedFiles.size;
      }

      for (const file of allFiles) {
        const sigInfo = await fileSignature(
          file,
          opts?.cacheStrict,
          gitSigMap.get(file),
          { forceContentHash: cacheEnabled },
        );
        fileSignatures.set(file, sigInfo);
        const entry = trackedEntries[file];
        const hasMatchingGitSig =
          !!entry?.gitSig &&
          !!sigInfo.gitSig &&
          entry.gitSig === sigInfo.gitSig;
        const hasMatchingSig = entry?.sig === sigInfo.sig;
        if (!entry || !(hasMatchingGitSig || hasMatchingSig)) {
          changedFiles.add(file);
        }
      }

      for (const file of allFiles) {
        if (changedFiles.has(file)) continue;
        const sigInfo = fileSignatures.get(file)!;
        const cacheSig = cacheEnabled
          ? await cacheSignatureForFile(file, sigInfo)
          : sigInfo.cacheSig;
        const cached = cacheEnabled
          ? tryLoadFromCache(projectRoot, file, cacheSig, opts, report)
          : null;
        if (cached) {
          if (fileReport) fileReport.cached = (fileReport.cached ?? 0) + 1;
          modules.set(file, cached);
          collectJsonDependencies(cached.imports, jsonDependencies);
          if (bloomFilterCache) {
            const filter = await buildBloomFilterForFile(file);
            if (filter) bloomFilterCache.set(file, filter);
          }
        } else {
          changedFiles.add(file);
        }
      }

      const changedList = Array.from(changedFiles);
      if (fileReport) {
        fileReport.changed = changedList.length;
      }
      if (changedList.length > 0) {
        const parseStart = performance.now();
        let processedFiles = 0;
        const totalFiles = changedList.length;
        const fileResults = await mapLimit(changedList, conc, async (f) => {
          try {
            if (fileReport) fileReport.parsed = (fileReport.parsed ?? 0) + 1;

            // FIX: Check support before parsing to avoid throwing errors for non-code files
            const supCheck = supportForFile(f);
            if (!supCheck) {
              const mod: ModuleIndex = {
                file: f,
                exports: [],
                imports: [],
                locals: [],
              };
              return [f, mod] as const;
            }

            const built = await buildIndexedModuleForFile({
              file: f,
              support: supCheck,
              projectRoot,
              opts,
              report,
              graphOptions,
              workspaceConfig,
              workerSetup: workerSetupIncr,
              parsedMap,
              parsedCacheMaxEntries: Math.max(
                1,
                opts?.parsedCacheMaxEntries ?? 1024,
              ),
              jsonDependencies,
              bloomFilterCache,
              onFallbackImportExtraction,
              fileSignatures,
              cacheEnabled,
            });
            return [f, built.module] as const;
          } catch (error) {
            if (isNativeRequiredUnavailableError(error)) throw error;
            if (isUnsupportedParserInputError(error)) {
              const modUnsupported: ModuleIndex = {
                file: f,
                exports: [],
                imports: [],
                locals: [],
              };
              return [f, modUnsupported] as const;
            }
            if (isJsFallbackUnavailableError(error)) {
              const modFallbackUnavailable: ModuleIndex = {
                file: f,
                exports: [],
                imports: [],
                locals: [],
              };
              return [f, modFallbackUnavailable] as const;
            }
            recordFileFailure(report, f, error);
            logWithLevel(
              opts?.logLevel,
              "warn",
              `Warning: Failed to process file ${f}:`,
              error,
            );
            const modError: ModuleIndex = {
              file: f,
              exports: [],
              imports: [],
              locals: [],
            };
            return [f, modError] as const;
          } finally {
            if (opts?.onProgress) {
              opts.onProgress({
                type: "progress",
                message: `Indexed ${f}`,
                current: ++processedFiles,
                total: totalFiles,
              });
            }
          }
        });
        for (const [f, mod] of fileResults) {
          modules.set(f.replace(/\\/g, "/"), mod);
        }
        if (timings)
          timings.parseMs = Math.round(performance.now() - parseStart);
      }

      for (const jsonPath of jsonDependencies) {
        ensureJsonModule(modules, jsonPath);
      }

      expandStarImports(modules);

      const cachedGraphEntries = new Map<string, ManifestFileEntry>(
        Object.entries(trackedEntries).filter(
          ([file]) => !deletedTrackedFiles.has(file),
        ),
      );
      const manifestEntries = new Map<string, ManifestFileEntry>(
        cachedGraphEntries,
      );

      const baseGraph: Graph | undefined =
        cachedGraphEntries.size > 0
          ? {
              nodes: new Set<string>(),
              edges: [],
            }
          : undefined;

      if (baseGraph) {
        for (const [file, entry] of cachedGraphEntries) {
          baseGraph.nodes.add(file);
          for (const edge of entry.edges) {
            baseGraph.edges.push(edge);
            if (edge.to.type === "file" && fs.existsSync(edge.to.path)) {
              baseGraph.nodes.add(edge.to.path);
            }
          }
        }
      }

      const filesList = Array.from(changedFiles);
      const graphStart = performance.now();
      const graph =
        filesList.length === 0 && baseGraph
          ? { nodes: new Set(baseGraph.nodes), edges: [...baseGraph.edges] }
          : await collectGraph(projectRoot, filesList, {
              parsed: parsedMap,
              fast: !!graphOptions.fast,
              ...(graphOptions.fastRegexDisabledLanguages
                ? {
                    fastRegexDisabledLanguages:
                      graphOptions.fastRegexDisabledLanguages,
                  }
                : {}),
              resolveNodeModules: !!graphOptions.resolveNodeModules,
              dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
              ...(opts?.native ? { native: opts.native } : {}),
              ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
              ...(graphOptions.resolutionHints
                ? { resolutionHints: graphOptions.resolutionHints }
                : {}),
              fileSignatures,
              cachedFileEdges: cachedGraphEntries,
              ...(onFallbackImportExtraction
                ? { onFallbackImportExtraction }
                : {}),
              ...(baseGraph ? { baseGraph } : {}),
              replaceFiles: new Set<string>(changedFiles),
              onFileEdges: (file, entry) => {
                if (!entry?.sig) return;
                manifestEntries.set(file, {
                  sig: entry.sig,
                  ...(entry.gitSig ? { gitSig: entry.gitSig } : {}),
                  edges: entry.edges,
                });
              },
            });
      if (timings) timings.graphMs = Math.round(performance.now() - graphStart);

      if (manifestEntries.size > 0) {
        const writeManifestStart = performance.now();
        const lastCommit = await getGitHead(projectRoot);
        const configHashResult = await computeConfigHash(
          projectRoot,
          opts?.logLevel,
        );
        const configHash = recordConfigHashResult(
          manifestReport,
          configHashResult,
          opts?.logLevel,
        );
        const manifestData: IndexManifest = {
          version: MANIFEST_VERSION,
          projectRoot: path.resolve(projectRoot).replace(/\\/g, "/"),
          updatedAt: Date.now(),
          ...(lastCommit ? { lastCommit } : {}),
          ...(configHash ? { configHash } : {}),
          graphOptions,
          buildOptions: summarizeBuildOptions(opts),
          files: Object.fromEntries(manifestEntries),
        };
        await writeManifest(projectRoot, opts, manifestData);
        if (timings)
          timings.writeManifestMs = Math.round(
            performance.now() - writeManifestStart,
          );
      }

      if (timings) timings.totalMs = Math.round(performance.now() - totalStart);
      const projectFiles = await discoverProjectFiles(projectRoot, {
        ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
      });

      const keepParsed = opts?.keepParsed ?? false;
      const maxParsedEntries = Math.max(1, opts?.parsedCacheMaxEntries ?? 1024);
      if (!keepParsed) {
        parsedMap.clear();
      } else {
        while (parsedMap.size > maxParsedEntries) {
          const oldest = parsedMap.keys().next().value;
          if (!oldest) break;
          parsedMap.delete(oldest);
        }
      }

      return {
        graph,
        modules,
        byFile: modules,
        projectRoot: normalizedProjectRoot,
        ...(opts?.native ? { nativeMode: opts.native } : {}),
        exportCache: new Map(),
        scopeCache: new Map(),
        parsed: keepParsed ? parsedMap : undefined,
        ...(bloomFilterCache ? { bloomFilters: bloomFilterCache } : {}),
        projectFiles,
      };
    } finally {
      await teardownWorkerPool(workerSetupIncr, report);
    }
  } finally {
    if (cacheMode === "disk") closeDiskCacheDatabase(projectRoot, opts);
  }
}

export async function buildGraphDelta(
  projectRoot: string,
  opts?: IncrementalBuildOptions,
): Promise<GraphDeltaReport> {
  const manifest = await loadManifest(projectRoot, opts);
  const trackedEntries = sanitizeManifestEntriesForRoot(
    projectRoot,
    manifest?.files,
  );
  const graphOptions = normalizeGraphOptions(opts?.graph);
  const strictIncremental = opts?.incrementalStrict ?? false;
  if (strictIncremental && graphOptions.fast) {
    graphOptions.fast = false;
  }

  const explicitFiles = normalizeIndexedFileInputs(
    projectRoot,
    opts?.files ?? [],
    "Graph delta file",
  ).filter((file) => fs.existsSync(file));
  const needsGitScan = !!opts?.gitBase || !!opts?.changedSince;
  const gitOpts: { base?: string; head?: string; changedSince?: string } = {};
  if (opts?.gitBase) gitOpts.base = opts.gitBase;
  if (opts?.gitHead) gitOpts.head = opts.gitHead;
  if (!opts?.gitBase && opts?.changedSince)
    gitOpts.changedSince = opts.changedSince;
  const gitFiles = needsGitScan
    ? await listChangedFiles(projectRoot, gitOpts)
    : [];

  const trackedFiles = new Set(
    Object.keys(trackedEntries).filter((file) => fs.existsSync(file)),
  );

  const gitAvailable = await isGitRepo(projectRoot);
  const currentHead = gitAvailable ? await getGitHead(projectRoot) : null;
  const hasExplicitGitRange = !!opts?.gitBase || !!opts?.gitHead;
  const manifestCommitMismatch =
    !hasExplicitGitRange &&
    !!manifest?.lastCommit &&
    !!currentHead &&
    manifest.lastCommit !== currentHead;
  const manifestDiffFiles = manifestCommitMismatch
    ? await listChangedFiles(projectRoot, {
        base: manifest?.lastCommit,
        head: currentHead,
      })
    : [];

  const allFiles = new Set<string>([
    ...trackedFiles,
    ...explicitFiles,
    ...manifestDiffFiles.filter((file) => fs.existsSync(file)),
    ...gitFiles.filter((file) => fs.existsSync(file)),
  ]);

  if (allFiles.size === 0) {
    return { changedFiles: [], added: [], removed: [] };
  }

  const changedFiles = new Set<string>();
  explicitFiles.forEach((file) => changedFiles.add(file));
  manifestDiffFiles.forEach((file) => changedFiles.add(file));
  gitFiles.forEach((file) => changedFiles.add(file));

  if (manifest && graphOptionsEqual(manifest.graphOptions, graphOptions)) {
    const gitSigMap = gitAvailable
      ? await getGitBlobHashes(projectRoot, Array.from(allFiles), {
          gitAvailable,
        })
      : new Map<string, string>();
    for (const file of allFiles) {
      const sigInfo = await fileSignature(
        file,
        opts?.cacheStrict,
        gitSigMap.get(file),
      );
      const entry = trackedEntries[file];
      const hasMatchingGitSig =
        !!entry?.gitSig && !!sigInfo.gitSig && entry.gitSig === sigInfo.gitSig;
      const hasMatchingSig = entry?.sig === sigInfo.sig;
      if (!entry || !(hasMatchingGitSig || hasMatchingSig)) {
        changedFiles.add(file);
      }
    }
  }

  const changedList = Array.from(changedFiles);
  const beforeEdges = new Map<string, Edge>();
  if (manifest) {
    for (const file of changedList) {
      const entry = trackedEntries[file];
      if (!entry?.edges) continue;
      for (const edge of entry.edges) {
        beforeEdges.set(edgeKey(edge), edge);
      }
    }
  }

  const index = await buildProjectIndexIncremental(projectRoot, opts);
  const afterEdges = new Map<string, Edge>();
  for (const edge of index.graph.edges) {
    if (changedFiles.has(edge.from)) {
      afterEdges.set(edgeKey(edge), edge);
    }
  }

  const added: Edge[] = [];
  const removed: Edge[] = [];
  for (const [key, edge] of afterEdges) {
    if (!beforeEdges.has(key)) added.push(edge);
  }
  for (const [key, edge] of beforeEdges) {
    if (!afterEdges.has(key)) removed.push(edge);
  }

  const changedFilesRelative = changedList.map((file) =>
    normalizePath(path.relative(projectRoot, file)),
  );
  const addedRelative = added.map((edge) => toRelativeEdge(projectRoot, edge));
  const removedRelative = removed.map((edge) =>
    toRelativeEdge(projectRoot, edge),
  );

  return {
    changedFiles: changedFilesRelative.sort(),
    added: addedRelative.sort(compareEdges),
    removed: removedRelative.sort(compareEdges),
  };
}

function setParsedCacheEntry(
  parsedMap: Map<string, ParsedFileContext>,
  file: string,
  entry: ParsedFileContext,
  maxEntries: number,
): void {
  if (parsedMap.has(file)) parsedMap.delete(file);
  parsedMap.set(file, entry);
  while (parsedMap.size > maxEntries) {
    const oldest = parsedMap.keys().next().value;
    if (!oldest) break;
    parsedMap.delete(oldest);
  }
}

export function buildScopeIndexFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  lang?: JsLanguage,
  imports: ImportBinding[] = [],
  opts?: { tree?: SyntaxTreeLike; nativeMode?: NativeRuntimeMode },
): ScopeIndex {
  return buildScopeIndexFromSourceFromModule(
    file,
    source,
    support,
    lang,
    imports,
    opts,
  );
}

// Detailed symbol graph re-export compatibility
export async function __buildSymbolGraphDetailedCompat(
  index: ProjectIndex,
): Promise<SymbolGraph> {
  // Defer to original algorithm via barrel import after refactor; this placeholder will be overridden.
  const { buildSymbolGraphDetailed } = await import("./index.js");
  return await buildSymbolGraphDetailed(index);
}

