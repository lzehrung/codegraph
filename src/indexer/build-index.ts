import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { supportForFile, type LanguageSupport } from "../languages.js";
import { loadWorkspaceConfig, resolveWorkspacePackage } from "../util/workspace.js";
import { discoverProjectFiles, listProjectFiles, type ProjectFileInfo } from "../util/projectFiles.js";
import { getGitHead, isGitRepo, getGitBlobHashes, listChangedFiles } from "../util/git.js";
import { clearImportResolutionCaches, resolveSpecifier } from "../util/resolution.js";
import { assertFilePathWithinRoot, normalizePath } from "../util/paths.js";
import { mapLimit } from "../util/concurrency.js";
import { logWithLevel, type LogLevel } from "../logging.js";
import { collectGraph } from "../graph-builder.js";
import { collectEdgesForFile } from "../graph-edge-collector.js";
import { buildGraphAdjacency } from "../graphs/adjacency.js";
import type { FallbackImportExtractionEvent } from "../graphs/specifiers.js";
import type { GraphBuildOptions, GraphCacheEntry } from "../graphs/types.js";
import { isGraphOnlyLanguage } from "../documentLinks.js";
import { attemptParsePreparedFileContext, type ParsedFileContext } from "./parse-context.js";
import { collectImportsForFile } from "./imports.js";
import { collectLocalsAndExportsFromSource } from "./locals-and-exports.js";
import { compareEdges, edgeKey, toRelativeEdge } from "./shared.js";
import { buildBloomFilterFromSource } from "../util/bloomFilter.js";
import { initNativeBackendReport } from "../native/nativeBackendReport.js";
import { closeDuplicateUnitCacheDatabase } from "../duplicates.js";
import { isNativeRequiredUnavailableError } from "../native/treeSitterNative.js";
import type { ParserLanguage, SyntaxTreeLike } from "../languages/types.js";
import type { Edge, FileId, Graph } from "../types.js";
import {
  buildBloomFilterForFile,
  cacheSignatureForFile,
  closeDiskCacheDatabase,
  collectWorkspaceManifestDependencyEdges,
  computeConfigHash,
  createFallbackImportExtractionHandler,
  diffBuildOptions,
  fileSignature,
  graphOptionsEqual,
  initFileReport,
  initManifestReport,
  loadManifest,
  normalizeGraphOptions,
  normalizeIndexedFileInputs,
  projectSnapshotFilesSignature,
  recordConfigHashResult,
  recordFileFailure,
  sanitizeManifestEntriesForRoot,
  sanitizeManifestTransientFilesForRoot,
  tryLoadFromCache,
  tryLoadPersistedBloomFilters,
  tryLoadProjectIndexSnapshot,
  verifyManifestEntries,
  writeProjectIndexSnapshot,
  writeToCache,
  type FileSignature,
  type ManifestFileEntry,
} from "./build-cache.js";
import { cacheRoot } from "./build-cache/module-cache.js";
import {
  type BuildOptions,
  type BuildReport,
  type GraphDeltaReport,
  type ImportBinding,
  type IncrementalBuildOptions,
  type ModuleIndex,
  type NativeBackendFallbackReason,
  type ParserBackendDegradationReport,
  type ProjectIndex,
  type ProjectIndexManifestEntry,
  type SymbolDef,
  SymbolKind,
} from "./types.js";
import { isNonNativeParserUnavailableError, isParserSyntaxTree } from "../parserBackend.js";
import { isUnsupportedParserInputError } from "../languages/filePrep.js";
import { buildSqlFactCache, buildSqlModuleIndex, sqlCorpusSignature, type SqlFactCache } from "../sql/sourceGraph.js";
import { finalizeProjectIndex } from "./finalize.js";
import { toManifestFileEntry, writeIndexManifestSnapshot } from "./build-manifest.js";
import {
  prepareFileContextForBuild,
  setupWorkerPool,
  teardownWorkerPool,
  type WorkerPoolSetupResult,
} from "./build-workers.js";
import {
  buildIncrementalGitDiffOptions,
  canUseIncrementalDiscoveryFastPath,
  collectDeletedTrackedFileDependents,
  collectTrackedFileDependents,
  isMissingGitRevisionError,
  listUntrackedProjectFiles,
  partitionTrackedManifestFiles,
} from "./incremental-plan.js";
import { parsedCacheMaxEntries, setParsedCacheEntry } from "./parsed-cache.js";

type IndexedFileGraphContext = {
  source: string;
  sup: LanguageSupport;
  lang?: ParserLanguage;
  nativeQueries?: import("../native/treeSitterNative.js").NativeQueryResults | null;
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
  parserReport.byLanguage[entry.languageId] = (parserReport.byLanguage[entry.languageId] ?? 0) + 1;
  if (parserReport.files.length >= 20) return;
  parserReport.files.push(entry);
}

function createEmptyModuleIndex(file: string): ModuleIndex {
  return { file, exports: [], imports: [], locals: [] };
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
  const { matchPath } = await import("../util/resolution.js").then((mod) => mod.loadNearestTsconfigFor(file, logLevel));
  for (const entry of mod.exports) {
    if (entry.type !== "reexport" && entry.type !== "exportStar" && entry.type !== "namespaceReexport") {
      continue;
    }
    if (entry.fromModule.startsWith(".")) {
      const resolved = await resolveSpecifier(file, entry.fromModule, projectRoot, matchPath, workspaceConfig, {
        resolveNodeModules: !!graphOptions.resolveNodeModules,
        ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
      });
      if (typeof resolved === "string") entry.fromModule = resolved;
      continue;
    }
    const pkgResolved = await resolveWorkspacePackage(entry.fromModule, workspaceConfig);
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
  bloomFilterCache: import("../util/bloomFilter.js").BloomFilterCache | undefined;
  onFallbackImportExtraction: ((event: FallbackImportExtractionEvent) => void) | undefined;
  fileSignatures: Map<string, FileSignature>;
  cacheEnabled: boolean;
}): Promise<IndexedFileModuleResult> {
  const prepared = await prepareFileContextForBuild(args.file, args.support, args.opts, args.workerSetup, args.report);
  const { source, sup, nativeQueries } = prepared;
  let resolvedLang = prepared.lang;
  let tree: SyntaxTreeLike | undefined;
  const graphOnlyLanguage = isGraphOnlyLanguage(sup.id);

  if (!nativeQueries && !graphOnlyLanguage && sup.id !== "sql") {
    const parseAttempt = attemptParsePreparedFileContext(prepared);
    const parsed = parseAttempt.parsed;
    if (parsed) {
      tree = parsed.tree;
      resolvedLang = parsed.lang;
      setParsedCacheEntry(args.parsedMap, args.file, parsed, args.parsedCacheMaxEntries);
    } else {
      recordParserBackendDegradation(args.report, {
        file: args.file,
        languageId: prepared.sup.id,
        ...(parseAttempt.nativeFallbackReason ? { nativeFallbackReason: parseAttempt.nativeFallbackReason } : {}),
        ...(parseAttempt.nativeError ? { nativeError: parseAttempt.nativeError } : {}),
        ...(parseAttempt.jsError ? { jsError: parseAttempt.jsError } : {}),
      });
    }
  }
  const lacksParserContext = !nativeQueries && !tree;

  if (args.bloomFilterCache) {
    const filter = buildBloomFilterFromSource(source, sup.id);
    args.bloomFilterCache.set(args.file, filter);
  }

  const imports =
    sup.id === "sql"
      ? []
      : await collectImportsForFile(args.file, args.projectRoot, {
          source,
          ...(tree && isParserSyntaxTree(tree) ? { tree } : {}),
          sup,
          ...(resolvedLang ? { lang: resolvedLang } : {}),
          ...(nativeQueries !== undefined ? { nativeQueries } : {}),
          graphOptions: args.graphOptions,
          ...(args.opts?.native ? { native: args.opts.native } : {}),
          ...(args.opts?.logLevel ? { logLevel: args.opts.logLevel } : {}),
          ...(args.onFallbackImportExtraction ? { onFallbackImportExtraction: args.onFallbackImportExtraction } : {}),
        });
  collectJsonDependencies(imports, args.jsonDependencies);
  let mod: ModuleIndex;
  if (sup.id === "sql") {
    mod = buildSqlModuleIndex(args.file, source);
  } else if (lacksParserContext) {
    mod = { ...createEmptyModuleIndex(args.file), imports };
  } else {
    mod = collectLocalsAndExportsFromSource(args.file, source, sup, resolvedLang, imports, {
      ...(tree ? { tree } : {}),
      ...(nativeQueries !== undefined ? { nativeQueries } : {}),
      ...(args.opts?.native ? { nativeMode: args.opts.native } : {}),
      ...(args.opts?.logLevel ? { logLevel: args.opts.logLevel } : {}),
    });
  }
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
    const cacheSig = args.cacheEnabled ? await cacheSignatureForFile(args.file, sigInfo, args.opts) : sigInfo.cacheSig;
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

function isJsonFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".json");
}

function collectJsonDependencies(imports: ImportBinding[], bucket: Set<string>): void {
  for (const imp of imports) {
    const resolved = typeof imp.resolved === "string" ? imp.resolved.replace(/\\/g, "/") : null;
    if (resolved && isJsonFile(resolved)) bucket.add(resolved);
  }
}

function ensureJsonModule(modules: Map<FileId, ModuleIndex>, filePath: string): void {
  const resolved = path.resolve(filePath);
  const normalized = resolved.replace(/\\/g, "/");
  if (modules.has(normalized)) return;
  if (!fs.existsSync(resolved)) return;
  const pos = { line: 1, column: 1, index: 0 };
  const symbol: SymbolDef = {
    file: normalized,
    localName: "default",
    kind: SymbolKind.Default,
    range: { start: pos, end: pos },
  };
  modules.set(normalized, {
    file: normalized,
    exports: [{ type: "local", exportedAs: "default", target: symbol }],
    imports: [],
    locals: [symbol],
  });
}

function graphEdgeKey(edge: Edge): string {
  const target = edge.to.type === "file" ? `file:${edge.to.path}` : `external:${edge.to.name}`;
  return `${edge.from}::${target}::${edge.raw ?? ""}::${edge.typeOnly ? 1 : 0}`;
}

function expandStarImports(modules: Map<FileId, ModuleIndex>): void {
  const importAlreadyPresent = (imports: ImportBinding[], candidate: ImportBinding): boolean =>
    imports.some((existing) => {
      if (existing.kind !== candidate.kind) return false;
      if (existing.from !== candidate.from) return false;
      if (existing.resolved !== candidate.resolved) return false;
      if ((existing.typeOnly ?? false) !== (candidate.typeOnly ?? false)) {
        return false;
      }
      if (candidate.kind === "named" && existing.kind === "named") {
        return existing.local === candidate.local && existing.imported === candidate.imported;
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
      const targetSupport = supportForFile(imp.resolved);
      const exportedSymbols = target.exports.filter((entry) => entry.type === "local").length
        ? target.exports
            .filter((entry): entry is Extract<typeof entry, { type: "local" }> => entry.type === "local")
            .map((entry) => entry.target)
        : target.locals.filter((local) => !local.localName.startsWith("_"));
      const seen = new Set<string>();
      for (const symbol of exportedSymbols) {
        if (!symbol.localName || seen.has(symbol.localName)) continue;
        seen.add(symbol.localName);
        const treatAsNamespace = targetSupport?.id === "ruby" && symbol.kind === SymbolKind.Class;
        const expandedImport: ImportBinding = treatAsNamespace
          ? {
              kind: "namespace",
              localNS: symbol.localName,
              from: imp.from,
              resolved: imp.resolved,
              ...(imp.typeOnly !== undefined ? { typeOnly: imp.typeOnly } : {}),
            }
          : {
              kind: "named",
              local: symbol.localName,
              imported: symbol.localName,
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

function toProjectIndexManifestEntry(entry: Pick<ManifestFileEntry, "sig" | "gitSig">): ProjectIndexManifestEntry {
  return {
    sig: entry.sig,
    ...(entry.gitSig ? { gitSig: entry.gitSig } : {}),
  };
}

function projectIndexManifestEntries(
  entries: Iterable<readonly [string, Pick<ManifestFileEntry, "sig" | "gitSig">]>,
): Map<string, ProjectIndexManifestEntry> {
  return new Map(Array.from(entries, ([file, entry]) => [file, toProjectIndexManifestEntry(entry)]));
}

type ManifestMode = "off" | "read-only" | "read-write";

type BuildIndexHelperOptions = {
  manifestMode?: ManifestMode;
  warnNoFilesMessage?: string;
  ignoreExistingManifest?: boolean;
  projectFiles?: ProjectFileInfo[] | Promise<ProjectFileInfo[]>;
  transientFiles?: string[];
  symlinkDirectories?: string[];
};

type IndexBuildRunState = {
  normalizedProjectRoot: string;
  report: BuildReport | undefined;
  timings: BuildReport["timings"] | undefined;
  totalStart: number;
  cacheMode: NonNullable<BuildOptions["cache"]>;
  cacheEnabled: boolean;
  graphOptions: GraphBuildOptions;
  onFallbackImportExtraction: ((event: FallbackImportExtractionEvent) => void) | undefined;
};

function createIndexBuildRunState(
  projectRoot: string,
  opts: BuildOptions | undefined,
  graphOptions = normalizeGraphOptions(opts?.graph),
): IndexBuildRunState {
  const report = opts?.report;
  if (report) initNativeBackendReport(report);
  const cacheMode = opts?.cache ?? "off";
  return {
    normalizedProjectRoot: normalizePath(projectRoot),
    report,
    timings: report?.timings,
    totalStart: performance.now(),
    cacheMode,
    cacheEnabled: cacheMode !== "off",
    graphOptions,
    onFallbackImportExtraction: createFallbackImportExtractionHandler(report, opts),
  };
}
type IndexProgressMode = "build" | "update";

function emitIndexLifecycleProgress(
  opts: BuildOptions | undefined,
  phase: "start" | "complete",
  mode: IndexProgressMode,
  total: number,
  elapsedMs?: number,
): void {
  let message = "Index ready";
  if (phase === "start") {
    const action = mode === "build" ? "Building" : "Updating";
    message = `${action} project index`;
  }
  opts?.onProgress?.({
    type: "progress",
    phase,
    mode,
    message,
    current: phase === "complete" ? total : 0,
    total,
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  });
}

function buildConcurrency(opts: BuildOptions | undefined): number {
  return Math.max(1, Math.min(Number(opts?.threads || 0) || 8, 64));
}

async function prepareFileSignatures(args: {
  files: string[];
  opts: BuildOptions | undefined;
  gitSigMap: Map<string, string>;
  cacheEnabled: boolean;
  concurrency: number;
}): Promise<Map<string, FileSignature>> {
  const entries = await mapLimit(args.files, args.concurrency, async (file) => {
    const sigInfo = await fileSignature(file, args.opts?.cacheStrict, args.gitSigMap.get(file), {
      forceContentHash: args.cacheEnabled,
    });
    return [file, sigInfo] as const;
  });
  return new Map(entries);
}

type FullDiscoveryBuildOptions = BuildOptions & Pick<IncrementalBuildOptions, "additionalFiles">;

async function buildProjectIndexFromExport(
  projectRoot: string,
  opts?: FullDiscoveryBuildOptions,
  helperOpts?: Pick<BuildIndexHelperOptions, "ignoreExistingManifest">,
): Promise<ProjectIndex> {
  return buildProjectIndexWithManifestOptions(projectRoot, opts, helperOpts);
}

async function buildIndexFromFileListShared(
  projectRoot: string,
  rawFiles: readonly string[],
  opts?: BuildOptions,
  helperOpts?: BuildIndexHelperOptions,
): Promise<ProjectIndex> {
  clearImportResolutionCaches();
  const {
    normalizedProjectRoot,
    report,
    timings,
    totalStart,
    cacheMode,
    cacheEnabled,
    graphOptions,
    onFallbackImportExtraction,
  } = createIndexBuildRunState(projectRoot, opts);
  const manifestMode: ManifestMode = helperOpts?.manifestMode ?? "off";
  const useManifest = manifestMode !== "off";
  const shouldWriteManifest = manifestMode === "read-write";
  const projectFiles = helperOpts?.projectFiles;
  initManifestReport(report, useManifest, false);
  const normalizedFiles = Array.from(new Set(normalizeIndexedFileInputs(projectRoot, rawFiles ?? [], "Index file")));
  if (!normalizedFiles.length && helperOpts?.warnNoFilesMessage) {
    logWithLevel(opts?.logLevel, "warn", helperOpts.warnNoFilesMessage);
  }
  const fileReport = initFileReport(report);
  if (fileReport) fileReport.total = normalizedFiles.length;
  const manifestStart = performance.now();
  const manifest = useManifest && !helperOpts?.ignoreExistingManifest ? await loadManifest(projectRoot, opts) : null;
  const manifestFiles = sanitizeManifestEntriesForRoot(projectRoot, manifest?.files);
  if (timings && useManifest) {
    timings.manifestMs = Math.round(performance.now() - manifestStart);
  }
  const staleCachedEdgeFiles = new Set<string>();
  if (manifest) {
    for (const [file, entry] of Object.entries(manifestFiles)) {
      if (entry.edges.some((edge) => edge.to.type === "file" && !fs.existsSync(edge.to.path))) {
        staleCachedEdgeFiles.add(file);
      }
    }
  }
  const cachedGraphEntries =
    manifest && graphOptionsEqual(manifest.graphOptions, graphOptions)
      ? new Map<string, ManifestFileEntry>(
          Object.entries(manifestFiles).filter(([file]) => !staleCachedEdgeFiles.has(file)),
        )
      : undefined;
  if (report?.manifest) {
    report.manifest.reused = !!cachedGraphEntries;
  }
  const manifestEntries = shouldWriteManifest ? new Map<string, ManifestFileEntry>() : undefined;
  const manifestEntriesForIndex = useManifest
    ? projectIndexManifestEntries(cachedGraphEntries ?? [])
    : new Map<string, ProjectIndexManifestEntry>();
  const modules = new Map<FileId, ModuleIndex>();
  const gitAvailable = await isGitRepo(projectRoot);
  const useGitSignatures = gitAvailable && (cacheMode !== "off" || opts?.cacheStrict);
  const gitSigMap = useGitSignatures
    ? await getGitBlobHashes(projectRoot, normalizedFiles, {
        gitAvailable,
        ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
      })
    : new Map<string, string>();
  const conc = buildConcurrency(opts);
  const sqlFiles = normalizedFiles
    .filter((file) => path.extname(file).toLowerCase() === ".sql")
    .sort((left, right) => left.localeCompare(right));
  const fileSignatures = await prepareFileSignatures({
    files: sqlFiles,
    opts,
    gitSigMap,
    cacheEnabled,
    concurrency: conc,
  });
  const sqlCorpusSig = sqlCorpusSignature(sqlFiles, fileSignatures);
  let sqlFactCachePromise: Promise<SqlFactCache> | undefined;
  const getSqlFactCache = (): Promise<SqlFactCache> => {
    sqlFactCachePromise ??= buildSqlFactCache(normalizedFiles);
    return sqlFactCachePromise;
  };
  const shouldProvideSqlFactCache = (
    file: string,
    sigInfo: FileSignature,
    cachedEdgesEntry: ManifestFileEntry | undefined,
  ): boolean => {
    if (path.extname(file).toLowerCase() !== ".sql") return false;
    if (!cachedEdgesEntry || !sqlCorpusSig || cachedEdgesEntry.sqlCorpusSig !== sqlCorpusSig) return true;
    const matchesGitSig = !!sigInfo.gitSig && !!cachedEdgesEntry.gitSig && cachedEdgesEntry.gitSig === sigInfo.gitSig;
    return !(matchesGitSig || cachedEdgesEntry.sig === sigInfo.sig);
  };
  const jsonDependencies = new Set<string>();
  const workerSetup = await setupWorkerPool(opts);
  try {
    const useBloomFilters = opts?.useBloomFilters ?? true;
    const bloomFilterCache = useBloomFilters
      ? new (await import("../util/bloomFilter.js")).BloomFilterCache()
      : undefined;
    const persistedBloomFilters = bloomFilterCache ? await tryLoadPersistedBloomFilters(projectRoot, opts) : null;
    const parsedMap = new Map<string, ParsedFileContext>();
    const workspaceConfig = await loadWorkspaceConfig(projectRoot);
    const parseStart = performance.now();
    const graph: Graph = { nodes: new Set(normalizedFiles), edges: [] };
    const onFileEdges = manifestEntries
      ? (file: string, entry: GraphCacheEntry) => {
          const manifestEntry = toManifestFileEntry(entry);
          if (!manifestEntry) return;
          manifestEntries.set(file, manifestEntry);
        }
      : undefined;
    let processedFiles = 0;
    const totalFiles = normalizedFiles.length;
    let buildStartedAt: number | undefined;
    const ensureBuildProgressStarted = (): void => {
      if (buildStartedAt !== undefined) return;
      buildStartedAt = performance.now();
      emitIndexLifecycleProgress(opts, "start", "build", totalFiles);
    };
    const fileResults = await mapLimit(normalizedFiles, conc, async (file) => {
      try {
        let sigInfo = fileSignatures.get(file);
        if (!sigInfo) {
          sigInfo = await fileSignature(file, opts?.cacheStrict, gitSigMap.get(file), {
            forceContentHash: cacheEnabled,
          });
          fileSignatures.set(file, sigInfo);
        }
        manifestEntriesForIndex.set(file, toProjectIndexManifestEntry(sigInfo));
        if (manifestEntries) {
          const initialManifestEntry = toManifestFileEntry({ ...sigInfo, edges: [] });
          if (initialManifestEntry) manifestEntries.set(file, initialManifestEntry);
        }
        const cacheSig = cacheEnabled ? await cacheSignatureForFile(file, sigInfo, opts) : sigInfo.cacheSig;
        let mod: ModuleIndex | null = cacheEnabled ? tryLoadFromCache(projectRoot, file, cacheSig, opts, report) : null;
        if (mod && fileReport) {
          fileReport.cached = (fileReport.cached ?? 0) + 1;
        }
        const cachedEdgesEntry = cachedGraphEntries?.get(file);
        const edgesCached =
          !!cachedEdgesEntry &&
          ((cachedEdgesEntry.gitSig && cachedEdgesEntry.gitSig === sigInfo.gitSig) ||
            cachedEdgesEntry.sig === sigInfo.sig);
        const sqlFactCache = shouldProvideSqlFactCache(file, sigInfo, cachedEdgesEntry)
          ? await getSqlFactCache()
          : undefined;
        let edges: Edge[] = [];
        if (mod && edgesCached) {
          edges = await collectEdgesForFile(file, projectRoot, workspaceConfig, {
            fast: !!graphOptions.fast,
            ...(graphOptions.fastRegexDisabledLanguages
              ? { fastRegexDisabledLanguages: graphOptions.fastRegexDisabledLanguages }
              : {}),
            resolveNodeModules: !!graphOptions.resolveNodeModules,
            dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
            ...(opts?.native ? { native: opts.native } : {}),
            ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
            ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
            fileSignature: sigInfo,
            ...(sqlCorpusSig ? { sqlCorpusSig } : {}),
            ...(cachedEdgesEntry ? { cachedFileEdges: cachedEdgesEntry } : {}),
            ...(onFileEdges ? { onFileEdges } : {}),
            ...(onFallbackImportExtraction ? { onFallbackImportExtraction } : {}),
            allFiles: normalizedFiles,
            ...(sqlFactCache ? { sqlFactCache } : {}),
          });
          if (bloomFilterCache) {
            const persistedFilter = persistedBloomFilters?.get(file);
            if (persistedFilter) {
              bloomFilterCache.set(file, persistedFilter);
            } else {
              const filter = await buildBloomFilterForFile(file);
              if (filter) bloomFilterCache.set(file, filter);
            }
          }
          return [file, mod, edges] as const;
        }
        if (fileReport) fileReport.parsed = (fileReport.parsed ?? 0) + 1;
        const support = supportForFile(file);
        if (!support) return [file, createEmptyModuleIndex(file), []] as const;
        ensureBuildProgressStarted();
        let graphContext: IndexedFileGraphContext | undefined;
        if (!mod) {
          const built = await buildIndexedModuleForFile({
            file,
            support,
            projectRoot,
            opts,
            report,
            graphOptions,
            workspaceConfig,
            workerSetup,
            parsedMap,
            parsedCacheMaxEntries: parsedCacheMaxEntries(opts),
            jsonDependencies,
            bloomFilterCache,
            onFallbackImportExtraction,
            fileSignatures,
            cacheEnabled,
          });
          mod = built.module;
          graphContext = built.graphContext;
        } else {
          collectJsonDependencies(mod.imports, jsonDependencies);
        }
        edges = await collectEdgesForFile(file, projectRoot, workspaceConfig, {
          ...(graphContext ? { parsed: graphContext } : {}),
          fast: !!graphOptions.fast,
          ...(graphOptions.fastRegexDisabledLanguages
            ? { fastRegexDisabledLanguages: graphOptions.fastRegexDisabledLanguages }
            : {}),
          resolveNodeModules: !!graphOptions.resolveNodeModules,
          dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
          ...(opts?.native ? { native: opts.native } : {}),
          ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
          ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
          fileSignature: sigInfo,
          ...(sqlCorpusSig ? { sqlCorpusSig } : {}),
          ...(cachedEdgesEntry ? { cachedFileEdges: cachedEdgesEntry } : {}),
          ...(onFileEdges ? { onFileEdges } : {}),
          ...(onFallbackImportExtraction ? { onFallbackImportExtraction } : {}),
          allFiles: normalizedFiles,
          ...(sqlFactCache ? { sqlFactCache } : {}),
        });
        return [file, mod ?? createEmptyModuleIndex(file), edges] as const;
      } catch (error) {
        if (isNativeRequiredUnavailableError(error)) throw error;
        if (isUnsupportedParserInputError(error) || isNonNativeParserUnavailableError(error)) {
          return [file, createEmptyModuleIndex(file), []] as const;
        }
        recordFileFailure(report, file, error);
        logWithLevel(opts?.logLevel, "warn", `Warning: Failed to process file ${file}:`, error);
        return [file, createEmptyModuleIndex(file), []] as const;
      } finally {
        processedFiles += 1;
        if (opts?.onProgress && buildStartedAt !== undefined) {
          opts.onProgress({
            type: "progress",
            phase: "update",
            mode: "build",
            message: `Indexed ${file}`,
            current: processedFiles,
            total: totalFiles,
          });
        }
      }
    });
    if (timings) timings.parseMs = Math.round(performance.now() - parseStart);
    const graphStart = performance.now();
    const seenGraphEdges = new Set<string>();
    const appendUniqueGraphEdges = (edges: readonly Edge[]) => {
      if (!edges.length) return;
      for (const edge of edges) {
        const key = graphEdgeKey(edge);
        if (seenGraphEdges.has(key)) continue;
        seenGraphEdges.add(key);
        graph.edges.push(edge);
        if (edge.to.type === "file") graph.nodes.add(edge.to.path);
      }
    };
    for (const [file, mod, edges] of fileResults) {
      modules.set(file, mod);
      appendUniqueGraphEdges(edges);
    }
    const workspaceManifestEdges = await collectWorkspaceManifestDependencyEdges(
      projectRoot,
      opts?.discovery,
      new Set(normalizedFiles),
      opts?.logLevel,
    );
    appendUniqueGraphEdges(workspaceManifestEdges);
    if (timings) timings.graphMs = Math.round(performance.now() - graphStart);
    for (const jsonPath of jsonDependencies) {
      ensureJsonModule(modules, jsonPath);
    }
    expandStarImports(modules);
    if (manifestEntries) {
      await writeIndexManifestSnapshot({
        projectRoot,
        opts,
        graphOptions,
        files: manifestEntries,
        timings,
        manifestReport: report?.manifest,
        ...(helperOpts?.transientFiles !== undefined ? { transientFiles: helperOpts.transientFiles } : {}),
        ...(helperOpts?.symlinkDirectories !== undefined ? { symlinkDirectories: helperOpts.symlinkDirectories } : {}),
      });
    }
    const index = await finalizeProjectIndex({
      projectRoot,
      normalizedProjectRoot,
      opts,
      timings,
      totalStart,
      graph,
      modules,
      parsedMap,
      bloomFilterCache,
      ...(projectFiles !== undefined ? { projectFiles } : {}),
      buildReport: report,
      manifestEntries: manifestEntriesForIndex,
    });
    if (manifestEntries) {
      await writeProjectIndexSnapshot(projectRoot, opts, index, projectSnapshotFilesSignature(manifestEntries));
    }
    if (buildStartedAt !== undefined) {
      emitIndexLifecycleProgress(opts, "complete", "build", index.byFile.size, performance.now() - buildStartedAt);
    }
    return index;
  } finally {
    await teardownWorkerPool(workerSetup, report);
  }
}

async function buildProjectIndexWithManifestOptions(
  projectRoot: string,
  opts?: FullDiscoveryBuildOptions,
  helperOpts?: Pick<BuildIndexHelperOptions, "ignoreExistingManifest">,
): Promise<ProjectIndex> {
  try {
    const useDiskCache = (opts?.cache ?? "off") === "disk";
    // With disk caching enabled, reuse the previous full scan's symlinked-directory
    // list so the file-discovery and project-file walks below can skip their own
    // full-tree symlink probe. Off and memory modes never read or write this disk
    // manifest, keeping read-only builds from mutating the project root. A missing or
    // unusable manifest falls back to probing once.
    // A symlink hint never expires on its own: `knownSymlinkDirectories` disables probing entirely, so
    // a directory symlinked in after the hint was recorded (e.g. `npm link`) would
    // otherwise never be discovered. `--cache-strict`/`--cache-verify` are explicit asks
    // for maximum correctness over speed, so both force a fresh probe here too.
    const wantsMaxSymlinkCorrectness = !!opts?.cacheStrict || !!opts?.cacheVerify;
    const symlinkHintManifest =
      helperOpts?.ignoreExistingManifest || wantsMaxSymlinkCorrectness || !useDiskCache
        ? null
        : await loadManifest(projectRoot, opts);
    const knownSymlinkDirectories = symlinkHintManifest?.symlinkDirectories;
    let discoveredSymlinkDirectories = knownSymlinkDirectories;
    const onSymlinkDirectoriesDiscovered = (directories: readonly string[]) => {
      discoveredSymlinkDirectories = Array.from(directories);
    };
    // When the hint is unknown, listProjectFiles() and discoverProjectFiles() must run
    // sequentially rather than in Promise.all: both would otherwise start their own
    // full-tree symlink probe concurrently, since the callback only reports back after
    // listProjectFiles() resolves, too late to inform a probe discoverProjectFiles()
    // already started on its own. Sequencing costs a little parallelism on that one
    // cold-start case, but avoids paying for two full-tree walks instead of one. Once a
    // hint is known (the common warm case), both calls skip probing entirely, so running
    // them sequentially here costs no meaningful time either way.
    const discoveredFiles = await listProjectFiles(projectRoot, undefined, {
      ...opts?.discovery,
      ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
      ...(knownSymlinkDirectories !== undefined ? { knownSymlinkDirectories } : {}),
      onSymlinkDirectoriesDiscovered,
    });
    const additionalFiles = normalizeIndexedFileInputs(
      projectRoot,
      opts?.additionalFiles ?? [],
      "Additional index file",
    ).filter((file) => fs.existsSync(file));
    const discoveredFileSet = new Set(discoveredFiles);
    const files = Array.from(new Set([...discoveredFiles, ...additionalFiles]));
    const transientFiles = additionalFiles.filter((file) => !discoveredFileSet.has(file));
    const projectFiles = await discoverProjectFiles(projectRoot, {
      ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
      ...(discoveredSymlinkDirectories !== undefined ? { knownSymlinkDirectories: discoveredSymlinkDirectories } : {}),
    });
    return await buildIndexFromFileListShared(projectRoot, files, opts, {
      manifestMode: useDiskCache ? "read-write" : "off",
      warnNoFilesMessage: `Warning: No files found in project root: ${projectRoot}`,
      ...(helperOpts?.ignoreExistingManifest ? { ignoreExistingManifest: true } : {}),
      projectFiles,
      transientFiles,
      ...(discoveredSymlinkDirectories !== undefined ? { symlinkDirectories: discoveredSymlinkDirectories } : {}),
    });
  } finally {
    if ((opts?.cache ?? "off") === "disk") {
      closeDiskCacheDatabase(projectRoot, opts);
      closeDuplicateUnitCacheDatabase(projectRoot, opts);
    }
  }
}

/**
 * Build a complete project index for a repo root.
 *
 * The returned index contains the file dependency graph, per-file module indexes,
 * symbol definitions, imports, exports, and project-file metadata. Build it once
 * and pass it to navigation, review, impact, or agent-tool APIs when composing
 * deterministic packets from the same repo snapshot.
 */
export async function buildProjectIndex(projectRoot: string, opts?: BuildOptions): Promise<ProjectIndex> {
  return buildProjectIndexWithManifestOptions(projectRoot, opts);
}

/**
 * Build a project index from an explicit file list.
 *
 * Use this when a caller already has a scoped manifest, sparse checkout, or
 * deterministic pack boundary and does not want Codegraph to discover every file
 * under the project root.
 */
export async function buildProjectIndexFromFiles(
  projectRoot: string,
  inputFiles: string[],
  opts?: BuildOptions,
): Promise<ProjectIndex> {
  try {
    const useDiskCache = (opts?.cache ?? "off") === "disk";
    return await buildIndexFromFileListShared(projectRoot, inputFiles, opts, {
      manifestMode: useDiskCache ? "read-only" : "off",
      warnNoFilesMessage: `Warning: No files provided for indexing in ${projectRoot}`,
    });
  } finally {
    if ((opts?.cache ?? "off") === "disk") {
      closeDiskCacheDatabase(projectRoot, opts);
      closeDuplicateUnitCacheDatabase(projectRoot, opts);
    }
  }
}

/**
 * Build or refresh a project index using the on-disk manifest when available.
 *
 * Incremental options can target explicit files, `changedSince`, or a
 * `gitBase`/`gitHead` range. `gitHead` accepts `WORKTREE`, `STAGED`, and `INDEX`
 * sentinels for review-agent workflows that analyze uncommitted changes.
 */
export async function buildProjectIndexIncremental(
  projectRoot: string,
  opts?: IncrementalBuildOptions,
): Promise<ProjectIndex> {
  clearImportResolutionCaches();
  const graphOptions = normalizeGraphOptions(opts?.graph);
  const strictIncremental = opts?.incrementalStrict ?? false;
  if (strictIncremental && graphOptions.fast) graphOptions.fast = false;
  const { normalizedProjectRoot, report, timings, totalStart, cacheMode, cacheEnabled, onFallbackImportExtraction } =
    createIndexBuildRunState(projectRoot, opts, graphOptions);
  let checkProgressActive = false;
  const startCheckProgress = (): void => {
    if (checkProgressActive) return;
    checkProgressActive = true;
    opts?.onProgress?.({
      type: "progress",
      phase: "start",
      mode: "check",
      message: "Checking project index",
      current: 0,
      total: 0,
    });
  };
  const completeCheckProgress = (total: number): void => {
    if (!checkProgressActive) return;
    checkProgressActive = false;
    opts?.onProgress?.({
      type: "progress",
      phase: "complete",
      mode: "check",
      message: "Checked project index",
      current: total,
      total,
      elapsedMs: performance.now() - totalStart,
    });
  };
  try {
    if (cacheMode !== "disk") {
      return await buildProjectIndexFromExport(projectRoot, opts, { ignoreExistingManifest: true });
    }
    startCheckProgress();
    const manifestStart = performance.now();
    const manifest = await loadManifest(projectRoot, opts);
    if (timings) timings.manifestMs = Math.round(performance.now() - manifestStart);
    const manifestUsed = !!manifest;
    const manifestReport = initManifestReport(report, manifestUsed, false);
    if (manifestReport && !manifestUsed) manifestReport.reason = "missing";
    const optionDiffs = diffBuildOptions(manifest?.buildOptions, opts);
    const warningOptionDiffs = optionDiffs.filter((diff) => diff !== "cache");
    if (warningOptionDiffs.length) {
      logWithLevel(
        opts?.logLevel,
        "warn",
        `Warning: Manifest options differ from current build options: ${warningOptionDiffs.join(", ")}`,
      );
    }
    if (manifestReport && optionDiffs.length) {
      manifestReport.optionsMismatch = optionDiffs;
    }
    const currentConfigHashResult = await computeConfigHash(projectRoot, opts?.logLevel);
    const currentConfigHash = recordConfigHashResult(manifestReport, currentConfigHashResult, opts?.logLevel);
    const configChanged = !!currentConfigHash && (!manifest?.configHash || currentConfigHash !== manifest.configHash);
    const requiresFullRebuild = optionDiffs.includes("discovery") || optionDiffs.includes("native");
    if (!manifest || !graphOptionsEqual(manifest.graphOptions, graphOptions) || configChanged || requiresFullRebuild) {
      if (configChanged) {
        logWithLevel(opts?.logLevel, "warn", "Configuration changed, rebuilding index...");
      }
      if (manifestReport && manifest) {
        manifestReport.reason = requiresFullRebuild ? "buildOptionsMismatch" : "graphOptionsMismatch";
        manifestReport.reused = false;
      }
      return await buildProjectIndexFromExport(projectRoot, opts, { ignoreExistingManifest: true });
    }
    const gitAvailable = await isGitRepo(projectRoot);
    const hasExplicitGitRange = !!opts?.gitBase || !!opts?.gitHead;
    // Diff against the working tree, not just the last-indexed commit: a file that was
    // `git add`ed but never committed is neither a tracked manifest entry nor reported
    // by `git ls-files --others` (it stops being "untracked" once staged), so comparing
    // only committed history would miss it whenever HEAD has not moved. Diffing against
    // WORKTREE captures staged and unstaged tracked-file changes together, and still
    // covers ordinary new-commit history when the working tree is clean at the new HEAD.
    const shouldDiffAgainstWorkingTree = !hasExplicitGitRange && gitAvailable && !!manifest.lastCommit;
    const canReuseReconciliation = opts?.reconciledManifestUpdatedAt === manifest.updatedAt;
    let manifestDiffFiles: string[] = [];
    if (shouldDiffAgainstWorkingTree) {
      try {
        manifestDiffFiles =
          (canReuseReconciliation ? opts?.reconciledWorkingTreeDiffFiles : undefined) ??
          (await listChangedFiles(projectRoot, {
            base: manifest.lastCommit,
            head: "WORKTREE",
          }));
      } catch (error) {
        if (!isMissingGitRevisionError(error)) throw error;
        if (manifestReport) {
          manifestReport.reason = "staleGitCommit";
          manifestReport.reused = false;
        }
        logWithLevel(opts?.logLevel, "warn", "Warning: Manifest commit is no longer available; rebuilding full index.");
        const rebuiltIndex = await buildProjectIndexFromExport(projectRoot, opts, { ignoreExistingManifest: true });
        if (manifestReport) {
          manifestReport.reason = "staleGitCommit";
          manifestReport.reused = false;
        }
        return rebuiltIndex;
      }
    }
    if (manifestReport) manifestReport.reused = true;
    if (opts?.cacheVerify) {
      const { mismatches, missing } = await verifyManifestEntries(projectRoot, manifest, opts, gitAvailable);
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
        return await buildProjectIndexFromExport(projectRoot, opts, { ignoreExistingManifest: true });
      }
    }
    const trackedEntries = sanitizeManifestEntriesForRoot(projectRoot, manifest.files);
    const manifestFileKeys = Object.keys(manifest.files);
    const trackedEntryKeys = Object.keys(trackedEntries);
    let manifestRequiresSanitization =
      manifestFileKeys.length !== trackedEntryKeys.length ||
      manifestFileKeys.some((file) => !Object.hasOwn(trackedEntries, file));
    const explicitFiles = normalizeIndexedFileInputs(projectRoot, opts?.files ?? [], "Incremental file");
    const additionalFiles = normalizeIndexedFileInputs(
      projectRoot,
      opts?.additionalFiles ?? [],
      "Additional index file",
    );
    const previousTransientFiles = sanitizeManifestTransientFilesForRoot(projectRoot, manifest.transientFiles).filter(
      (file) => Object.hasOwn(trackedEntries, file),
    );
    const previousTransientFileSet = new Set(previousTransientFiles);
    const additionalFileSet = new Set(additionalFiles.filter((file) => fs.existsSync(file)));
    const transientFiles = [...additionalFileSet].filter(
      (file) => previousTransientFileSet.has(file) || !Object.hasOwn(trackedEntries, file),
    );
    const retiredTransientFiles = previousTransientFiles.filter((file) => !additionalFileSet.has(file));
    const { trackedFiles, deletedTrackedFiles } = partitionTrackedManifestFiles(trackedEntries);
    for (const file of retiredTransientFiles) {
      trackedFiles.delete(file);
      deletedTrackedFiles.add(file);
      delete trackedEntries[file];
    }
    if (retiredTransientFiles.length) manifestRequiresSanitization = true;
    const fileReport = initFileReport(report);
    if (fileReport) fileReport.total = trackedFiles.size;
    const needsGitScan = !!opts?.gitBase || !!opts?.changedSince;
    const gitFiles = needsGitScan ? await listChangedFiles(projectRoot, buildIncrementalGitDiffOptions(opts)) : [];
    // New files that were never committed, staged, or passed explicitly have no tracked
    // manifest entry and no working-tree-diff record, so they would otherwise stay
    // invisible to an incremental build until the next full rebuild. Detecting them via
    // `git ls-files --others` is far cheaper than a full recursive directory scan and
    // keeps this path correct without requiring callers to pre-scan the project
    // themselves. A failure here cannot be treated as "no untracked files": that would
    // silently produce an incomplete index, so it falls back to a full rebuild instead,
    // the same way a stale manifest commit does above.
    let untrackedFiles: string[] = [];
    if (canUseIncrementalDiscoveryFastPath(gitAvailable, opts?.cacheStrict)) {
      try {
        untrackedFiles =
          (canReuseReconciliation ? opts?.reconciledUntrackedFiles : undefined) ??
          (await listUntrackedProjectFiles(projectRoot, opts?.discovery, gitAvailable));
      } catch (error) {
        if (manifestReport) {
          manifestReport.reason = "gitUntrackedScanFailed";
          manifestReport.reused = false;
        }
        logWithLevel(
          opts?.logLevel,
          "warn",
          "Warning: Failed to list untracked project files via Git; rebuilding full index.",
          error,
        );
        return await buildProjectIndexFromExport(projectRoot, opts, { ignoreExistingManifest: true });
      }
    }
    const allFiles = new Set<string>([
      ...trackedFiles,
      ...explicitFiles.filter((file) => fs.existsSync(file)),
      ...additionalFiles.filter((file) => fs.existsSync(file)),
      ...manifestDiffFiles.filter((file) => fs.existsSync(file)),
      ...gitFiles.filter((file) => fs.existsSync(file)),
      ...untrackedFiles.filter((file) => fs.existsSync(file)),
    ]);
    if (fileReport) fileReport.total = allFiles.size;
    const dependentFilesOfDeletedTracked = collectDeletedTrackedFileDependents(trackedEntries, deletedTrackedFiles);
    if (allFiles.size === 0) {
      completeCheckProgress(0);
      await writeIndexManifestSnapshot({
        projectRoot,
        opts,
        graphOptions,
        files: {},
        timings,
        manifestReport,
        allowEmpty: true,
        transientFiles,
        ...(manifest.symlinkDirectories !== undefined ? { symlinkDirectories: manifest.symlinkDirectories } : {}),
      });
      return {
        graph: { nodes: new Set(), edges: [] },
        graphAdjacency: buildGraphAdjacency({ nodes: new Set(), edges: [] }),
        modules: new Map(),
        byFile: new Map(),
        projectRoot: normalizedProjectRoot,
        ...(opts?.native ? { nativeMode: opts.native } : {}),
        exportCache: new Map(),
        scopeCache: new Map(),
        parsed: new Map(),
      };
    }
    const changedFiles = new Set<string>();
    const markAsChanged = (file: string): void => {
      if (fs.existsSync(file)) changedFiles.add(file);
    };
    // Git working-tree diffs are change *candidates*, not proof the indexed bytes are
    // stale. `lastCommit...WORKTREE` stays dirty across warm runs after we index the
    // dirty tree, so force-marking these files caused perpetual "Updated N files"
    // reparses even when signatures already matched the on-disk content. Keep them in
    // `allFiles` above so signature validation can decide; only skip the early snapshot
    // fast-path while candidates exist.
    const gitChangeCandidates = new Set<string>();
    for (const file of manifestDiffFiles) if (fs.existsSync(file)) gitChangeCandidates.add(file);
    for (const file of gitFiles) if (fs.existsSync(file)) gitChangeCandidates.add(file);
    const explicitFileSet = new Set(explicitFiles);
    const explicitFilesCoverAllFiles =
      explicitFileSet.size === allFiles.size && [...allFiles].every((file) => explicitFileSet.has(file));
    const explicitFilesAreChangeInputs = !opts?.filesAreProjectScope;
    if (explicitFileSet.size && explicitFilesAreChangeInputs && (!explicitFilesCoverAllFiles || report)) {
      explicitFileSet.forEach(markAsChanged);
    }
    dependentFilesOfDeletedTracked.forEach(markAsChanged);
    if (fileReport) fileReport.changed = changedFiles.size;

    const reuseUnchangedSnapshot = async (): Promise<ProjectIndex | null> => {
      if (changedFiles.size || deletedTrackedFiles.size || manifestRequiresSanitization) return null;
      const manifestEntryMap = new Map(Object.entries(trackedEntries));
      const snapshotLoad = await tryLoadProjectIndexSnapshot(projectRoot, opts, manifestEntryMap);
      if (!snapshotLoad) return null;

      const snapshot = snapshotLoad.index;
      snapshot.projectFiles ??= await discoverProjectFiles(projectRoot, {
        ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
      });
      if (opts?.cache) {
        snapshot.cacheMode = opts.cache;
        snapshot.cacheRootDir = cacheRoot(projectRoot, opts);
      }
      if (fileReport) fileReport.cached = allFiles.size;
      if (timings) timings.graphMs = 0;
      if (report) {
        if (snapshotLoad.analysisReport?.backend) report.backend = snapshotLoad.analysisReport.backend;
        if (snapshotLoad.analysisReport?.graph) report.graph = snapshotLoad.analysisReport.graph;
        if (!report.backend) initNativeBackendReport(report);
        snapshot.buildReport = report;
      }
      return snapshot;
    };

    // A file can only hide from the incremental scan by being genuinely unseen: absent from
    // both the manifest and any git diff signal. An untracked file that already has a
    // manifest entry (a build artifact or scratch file indexed once and never committed, for
    // example) is not automatically "unknown" -- but unlike a tracked file, git has no diff
    // history for it, so its manifest signature cannot be trusted without independent proof
    // it is still current. `entry.sig` always starts with `${mtimeMs}:${size}` (see
    // `fileStatSignature` in build-cache/module-cache.ts), so a single cheap `stat()` per
    // already-known untracked file proves freshness without reading its content. Unseen files
    // (no manifest entry) and files whose stat no longer matches both still block the fast
    // path, exactly as before; only "already indexed and provably unchanged" now qualifies.
    const hasStaleOrUnseenUntrackedFile = untrackedFiles.length
      ? (
          await Promise.all(
            untrackedFiles.map(async (file) => {
              const entry = trackedEntries[file];
              if (!entry?.sig) return true;
              try {
                const stat = await fsp.stat(file);
                // Non-strict signatures are `${mtimeMs}:${size}`; strict ones append
                // `:${contentHash}`. Match either form so the fast path works when
                // `cacheStrict: false` (where this gate itself only runs).
                const prefix = `${stat.mtimeMs}:${stat.size}`;
                return !(entry.sig === prefix || entry.sig.startsWith(`${prefix}:`));
              } catch {
                return true;
              }
            }),
          )
        ).some(Boolean)
      : false;
    const canSkipFileValidation =
      gitAvailable &&
      !opts?.cacheStrict &&
      !hasStaleOrUnseenUntrackedFile &&
      !additionalFiles.length &&
      !gitChangeCandidates.size;
    if (canSkipFileValidation) {
      const snapshot = await reuseUnchangedSnapshot();
      if (snapshot) {
        if (timings) timings.totalMs = Math.round(performance.now() - totalStart);
        completeCheckProgress(allFiles.size);
        return snapshot;
      }
    }

    const workspaceConfig = await loadWorkspaceConfig(projectRoot);
    const conc = buildConcurrency(opts);
    const workerSetup = await setupWorkerPool(opts);
    try {
      const useGitSignatures = gitAvailable;
      const gitSigMap = useGitSignatures
        ? await getGitBlobHashes(projectRoot, Array.from(allFiles), {
            gitAvailable,
            ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
          })
        : new Map<string, string>();
      const fileSignatures = await prepareFileSignatures({
        files: Array.from(allFiles),
        opts,
        gitSigMap,
        cacheEnabled,
        concurrency: conc,
      });
      const modules = new Map<FileId, ModuleIndex>();
      const parsedMap = new Map<string, ParsedFileContext>();
      const jsonDependencies = new Set<string>();
      const useBloomFilters = opts?.useBloomFilters ?? true;
      const bloomFilterCache = useBloomFilters
        ? new (await import("../util/bloomFilter.js")).BloomFilterCache()
        : undefined;
      for (const file of allFiles) {
        const sigInfo = fileSignatures.get(file);
        if (!sigInfo) continue;
        const entry = trackedEntries[file];
        const hasMatchingGitSig = !!entry?.gitSig && !!sigInfo.gitSig && entry.gitSig === sigInfo.gitSig;
        const hasMatchingSig = entry?.sig === sigInfo.sig;
        if (!entry || !(hasMatchingGitSig || hasMatchingSig)) {
          changedFiles.add(file);
        }
      }
      const invalidateCachedDependents = () => {
        const dependentFilesOfChanged = collectTrackedFileDependents(trackedEntries, changedFiles);
        for (const file of dependentFilesOfChanged) {
          if (modules.has(file)) {
            modules.delete(file);
            if (fileReport) {
              fileReport.cached = Math.max(0, (fileReport.cached ?? 0) - 1);
            }
          }
          markAsChanged(file);
        }
      };
      invalidateCachedDependents();
      if (fileReport) fileReport.changed = changedFiles.size;
      const unchangedSnapshot = await reuseUnchangedSnapshot();
      if (unchangedSnapshot) {
        if (timings) timings.totalMs = Math.round(performance.now() - totalStart);
        completeCheckProgress(allFiles.size);
        return unchangedSnapshot;
      }
      const persistedBloomFilters = bloomFilterCache ? await tryLoadPersistedBloomFilters(projectRoot, opts) : null;
      for (const file of allFiles) {
        if (changedFiles.has(file)) continue;
        const sigInfo = fileSignatures.get(file)!;
        const cacheSig = cacheEnabled ? await cacheSignatureForFile(file, sigInfo, opts) : sigInfo.cacheSig;
        const cached = cacheEnabled ? tryLoadFromCache(projectRoot, file, cacheSig, opts, report) : null;
        if (cached) {
          if (fileReport) fileReport.cached = (fileReport.cached ?? 0) + 1;
          modules.set(file, cached);
          collectJsonDependencies(cached.imports, jsonDependencies);
          if (bloomFilterCache) {
            const persistedFilter = persistedBloomFilters?.get(file);
            if (persistedFilter) {
              bloomFilterCache.set(file, persistedFilter);
            } else {
              const filter = await buildBloomFilterForFile(file);
              if (filter) bloomFilterCache.set(file, filter);
            }
          }
        } else {
          changedFiles.add(file);
        }
      }
      invalidateCachedDependents();
      const changedList = Array.from(changedFiles);
      let updateStartedAt: number | undefined;
      if (changedList.length || deletedTrackedFiles.size) {
        updateStartedAt = performance.now();
        emitIndexLifecycleProgress(opts, "start", "update", changedList.length);
      }
      if (fileReport) fileReport.changed = changedList.length;
      if (changedList.length) {
        const parseStart = performance.now();
        let processedFiles = 0;
        const totalFiles = changedList.length;
        const fileResults = await mapLimit(changedList, conc, async (file) => {
          try {
            if (fileReport) fileReport.parsed = (fileReport.parsed ?? 0) + 1;
            const support = supportForFile(file);
            if (!support) return [file, createEmptyModuleIndex(file)] as const;
            const built = await buildIndexedModuleForFile({
              file,
              support,
              projectRoot,
              opts,
              report,
              graphOptions,
              workspaceConfig,
              workerSetup,
              parsedMap,
              parsedCacheMaxEntries: parsedCacheMaxEntries(opts),
              jsonDependencies,
              bloomFilterCache,
              onFallbackImportExtraction,
              fileSignatures,
              cacheEnabled,
            });
            return [file, built.module] as const;
          } catch (error) {
            if (isNativeRequiredUnavailableError(error)) throw error;
            if (isUnsupportedParserInputError(error) || isNonNativeParserUnavailableError(error)) {
              return [file, createEmptyModuleIndex(file)] as const;
            }
            recordFileFailure(report, file, error);
            logWithLevel(opts?.logLevel, "warn", `Warning: Failed to process file ${file}:`, error);
            return [file, createEmptyModuleIndex(file)] as const;
          } finally {
            if (opts?.onProgress) {
              opts.onProgress({
                type: "progress",
                phase: "update",
                mode: "update",
                message: `Indexed ${file}`,
                current: ++processedFiles,
                total: totalFiles,
              });
            }
          }
        });
        for (const [file, mod] of fileResults) {
          modules.set(file.replace(/\\/g, "/"), mod);
        }
        if (timings) timings.parseMs = Math.round(performance.now() - parseStart);
      }
      for (const jsonPath of jsonDependencies) {
        ensureJsonModule(modules, jsonPath);
      }
      expandStarImports(modules);
      const retainedTrackedEntries = Object.entries(trackedEntries).filter(([file]) => !deletedTrackedFiles.has(file));
      const cachedGraphEntries = new Map<string, ManifestFileEntry>(retainedTrackedEntries);
      const manifestEntries = new Map<string, ManifestFileEntry>(cachedGraphEntries);
      const baseGraph: Graph | undefined =
        cachedGraphEntries.size > 0 ? { nodes: new Set<string>(), edges: [] } : undefined;
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
        !filesList.length && baseGraph
          ? { nodes: new Set(baseGraph.nodes), edges: [...baseGraph.edges] }
          : await collectGraph(projectRoot, filesList, {
              parsed: parsedMap,
              fast: !!graphOptions.fast,
              ...(graphOptions.fastRegexDisabledLanguages
                ? { fastRegexDisabledLanguages: graphOptions.fastRegexDisabledLanguages }
                : {}),
              resolveNodeModules: !!graphOptions.resolveNodeModules,
              dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
              ...(opts?.native ? { native: opts.native } : {}),
              ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
              ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
              allFiles: Array.from(allFiles),
              fileSignatures,
              cachedFileEdges: cachedGraphEntries,
              ...(onFallbackImportExtraction ? { onFallbackImportExtraction } : {}),
              ...(baseGraph ? { baseGraph } : {}),
              replaceFiles: new Set<string>(changedFiles),
              onFileEdges: (file, entry) => {
                const manifestEntry = toManifestFileEntry(entry);
                if (!manifestEntry) return;
                manifestEntries.set(file, manifestEntry);
              },
            });
      if (timings) timings.graphMs = Math.round(performance.now() - graphStart);
      await writeIndexManifestSnapshot({
        projectRoot,
        opts,
        graphOptions,
        files: manifestEntries,
        timings,
        manifestReport,
        transientFiles,
        ...(manifest.symlinkDirectories !== undefined ? { symlinkDirectories: manifest.symlinkDirectories } : {}),
      });
      const index = await finalizeProjectIndex({
        projectRoot,
        normalizedProjectRoot,
        opts,
        timings,
        totalStart,
        graph,
        modules,
        parsedMap,
        bloomFilterCache,
        manifestEntries: projectIndexManifestEntries(manifestEntries),
        buildReport: report,
      });
      await writeProjectIndexSnapshot(projectRoot, opts, index, projectSnapshotFilesSignature(manifestEntries));
      if (updateStartedAt !== undefined) {
        emitIndexLifecycleProgress(opts, "complete", "update", index.byFile.size, performance.now() - updateStartedAt);
      } else {
        completeCheckProgress(allFiles.size);
      }
      return index;
    } finally {
      await teardownWorkerPool(workerSetup, report);
    }
  } finally {
    if (cacheMode === "disk") {
      closeDiskCacheDatabase(projectRoot, opts);
      closeDuplicateUnitCacheDatabase(projectRoot, opts);
    }
  }
}

export async function buildGraphDelta(projectRoot: string, opts?: IncrementalBuildOptions): Promise<GraphDeltaReport> {
  const manifest = await loadManifest(projectRoot, opts);
  const trackedEntries = sanitizeManifestEntriesForRoot(projectRoot, manifest?.files);
  const graphOptions = normalizeGraphOptions(opts?.graph);
  const strictIncremental = opts?.incrementalStrict ?? false;
  if (strictIncremental && graphOptions.fast) graphOptions.fast = false;
  const explicitFiles = normalizeIndexedFileInputs(projectRoot, opts?.files ?? [], "Graph delta file").filter((file) =>
    fs.existsSync(file),
  );
  const additionalFiles = normalizeIndexedFileInputs(
    projectRoot,
    opts?.additionalFiles ?? [],
    "Additional graph delta file",
  ).filter((file) => fs.existsSync(file));
  const needsGitScan = !!opts?.gitBase || !!opts?.changedSince;
  const gitFiles = needsGitScan ? await listChangedFiles(projectRoot, buildIncrementalGitDiffOptions(opts)) : [];
  const { trackedFiles } = partitionTrackedManifestFiles(trackedEntries);
  const gitAvailable = await isGitRepo(projectRoot);
  const currentHead = gitAvailable ? await getGitHead(projectRoot) : null;
  const hasExplicitGitRange = !!opts?.gitBase || !!opts?.gitHead;
  const manifestCommitMismatch =
    !hasExplicitGitRange && !!manifest?.lastCommit && !!currentHead && manifest.lastCommit !== currentHead;
  let manifestDiffFiles: string[] = [];
  if (manifestCommitMismatch) {
    try {
      manifestDiffFiles = await listChangedFiles(projectRoot, {
        base: manifest?.lastCommit,
        head: currentHead,
      });
    } catch (error) {
      if (!isMissingGitRevisionError(error)) throw error;
      manifestDiffFiles = Object.keys(trackedEntries);
      logWithLevel(
        opts?.logLevel,
        "warn",
        "Warning: Manifest commit is no longer available; using tracked manifest files for graph delta.",
      );
    }
  }
  const allFiles = new Set<string>([
    ...trackedFiles,
    ...explicitFiles,
    ...additionalFiles,
    ...manifestDiffFiles.filter((file) => fs.existsSync(file)),
    ...gitFiles.filter((file) => fs.existsSync(file)),
  ]);
  const changedFiles = new Set<string>();
  explicitFiles.forEach((file) => changedFiles.add(file));
  manifestDiffFiles.forEach((file) => changedFiles.add(file));
  gitFiles.forEach((file) => changedFiles.add(file));
  if (allFiles.size === 0 && changedFiles.size === 0) {
    return { changedFiles: [], added: [], removed: [] };
  }
  if (manifest && graphOptionsEqual(manifest.graphOptions, graphOptions)) {
    const gitSigMap = gitAvailable
      ? await getGitBlobHashes(projectRoot, Array.from(allFiles), {
          gitAvailable,
          ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
        })
      : new Map<string, string>();
    for (const file of allFiles) {
      const sigInfo = await fileSignature(file, opts?.cacheStrict, gitSigMap.get(file));
      const entry = trackedEntries[file];
      const hasMatchingGitSig = !!entry?.gitSig && !!sigInfo.gitSig && entry.gitSig === sigInfo.gitSig;
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
    if (changedFiles.has(edge.from)) afterEdges.set(edgeKey(edge), edge);
  }
  const added: Edge[] = [];
  const removed: Edge[] = [];
  for (const [key, edge] of afterEdges) {
    if (!beforeEdges.has(key)) added.push(edge);
  }
  for (const [key, edge] of beforeEdges) {
    if (!afterEdges.has(key)) removed.push(edge);
  }
  const changedFilesRelative = changedList.map((file) => normalizePath(path.relative(projectRoot, file)));
  const addedRelative = added.map((edge) => toRelativeEdge(projectRoot, edge));
  const removedRelative = removed.map((edge) => toRelativeEdge(projectRoot, edge));
  return {
    changedFiles: changedFilesRelative.sort(),
    added: addedRelative.sort(compareEdges),
    removed: removedRelative.sort(compareEdges),
  };
}
