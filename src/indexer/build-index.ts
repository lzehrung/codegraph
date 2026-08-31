import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { languageExtensionPatterns, supportForFile, type LanguageSupport } from "../languages.js";
import { isJsTsLanguage } from "../languages/js-family.js";
import { loadWorkspaceConfig, resolveWorkspacePackage, type WorkspaceConfig } from "../util/workspace.js";
import {
  DEFAULT_PROJECT_PATTERNS,
  discoverProjectFilesWithGitCandidates,
  listProjectFilesWithGitCandidates,
  type GitCandidateSet,
  type ProjectFileInfo,
} from "../util/projectFiles.js";
import { getGitHead, isGitRepo, getGitBlobHashes, listChangedFiles } from "../util/git.js";
import {
  clearResolutionCaches,
  loadNearestTsconfigFor,
  resolveSpecifier,
  type MatchPathFn,
} from "../util/resolution.js";
import {
  fileIdentityKey,
  initializeFileIdentityCaseSensitivity,
  isFilePathWithinRoot,
  normalizePath,
} from "../util/paths.js";
import { mapLimit } from "../util/concurrency.js";
import { readConfinedUtf8File } from "../util/confinedFile.js";
import { resolveWorkerThreadCount } from "../util/workerThreads.js";
import { logWithLevel } from "../logging.js";
import { collectGraph } from "../graph-builder.js";
import { collectEdgesForFile } from "../graph-edge-collector.js";
import { buildGraphAdjacency } from "../graphs/adjacency.js";
import type { FallbackImportExtractionEvent } from "../graphs/specifiers.js";
import type { GraphBuildOptions, GraphCacheEntry } from "../graphs/types.js";
import { isGraphOnlyLanguage } from "../documentLinks.js";
import { attemptParsePreparedFileContext, type ParsedFileContext } from "./parse-context.js";
import { ProjectedSyntaxTree } from "../native/projectedTree.js";
import { collectImportsForFile } from "./imports.js";
import { collectLocalsAndExportsFromSource } from "./locals-and-exports.js";
import { compareEdges, edgeKey, toRelativeEdge } from "./shared.js";
import { BloomFilter, buildBloomFilterFromSource } from "../util/bloomFilter.js";
import { initNativeBackendReport } from "../native/nativeBackendReport.js";
import { closeDuplicateUnitCacheDatabase } from "../duplicates.js";
import { isNativeRequiredUnavailableError } from "../native/treeSitterNative.js";
import { isNodeSqliteUnavailableError } from "../sqlite-driver.js";
import type { SyntaxTreeLike } from "../languages/types.js";
import type { Edge, FileId, Graph } from "../types.js";
import {
  buildBloomFilterForFile,
  cacheSignatureForFile,
  closeDiskCacheDatabase,
  diskModuleCacheExists,
  collectWorkspaceManifestDependencyEdges,
  computeConfigHash,
  createFallbackImportExtractionHandler,
  diffBuildOptions,
  fileSignature,
  fileSignatureFromSource,
  graphOptionsEqual,
  initFileReport,
  initManifestReport,
  loadManifest,
  normalizeGraphOptions,
  normalizeIndexedFileInputs,
  normalizeIndexedFileInputsWithinRoot,
  normalizeLanguageExtensions,
  projectSnapshotFilesSignature,
  recordConfigHashResult,
  recordFileFailure,
  sanitizeManifestEntriesForRoot,
  sanitizeManifestTransientFilesForRoot,
  tryLoadFromCache,
  tryLoadPersistedBloomFilters,
  tryLoadProjectIndexSnapshot,
  tryLoadProjectSnapshotModules,
  verifyManifestEntries,
  writeModulesToCache,
  writeProjectIndexSnapshot,
  type FileSignature,
  type ManifestFileEntry,
  type PendingModuleCacheWrite,
} from "./build-cache.js";
import { computeResolverEnvironmentFingerprint } from "./build-cache/resolver-environment.js";
import { cacheRoot } from "./build-cache/location.js";
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
import { isUnsupportedParserInputError, type PreparedSFCEmbeddedBlock } from "../languages/filePrep.js";

import { buildSqlFactCache, buildSqlModuleIndex, sqlCorpusSignature, type SqlFactCache } from "../sql/sourceGraph.js";
import { finalizeProjectIndex } from "./finalize.js";
import { toManifestFileEntry, writeIndexManifestSnapshot } from "./build-manifest.js";
import {
  prepareFileContextForBuild,
  countNativeWorkerEligibleFiles,
  emptyWorkerPoolSetup,
  setupWorkerPool,
  teardownWorkerPool,
  type WorkerPoolSetupResult,
} from "./build-workers.js";
import {
  buildIncrementalGitDiffOptions,
  canUseIncrementalDiscoveryFastPath,
  buildTrackedFileReverseDependencies,
  collectDeletedTrackedFileDependents,
  collectTrackedFileDependents,
  isMissingGitRevisionError,
  listUntrackedProjectFiles,
  partitionTrackedManifestFiles,
  probePathExistence,
} from "./incremental-plan.js";
import { parsedCacheMaxEntries, setParsedCacheEntry } from "./parsed-cache.js";

type IndexedFileGraphContext = {
  source: string;
  sup: LanguageSupport;
  nativeQueries?: import("../native/treeSitterNative.js").NativeQueryResults | null;
  tree?: SyntaxTreeLike;
  embeddedBlocks?: PreparedSFCEmbeddedBlock[];
};

type IndexedFileModuleResult = {
  module: ModuleIndex;
  cacheWrite?: PendingModuleCacheWrite | undefined;
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

function isConfinedFileReadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /outside project root|possible path confinement race|changed between verification and open|confined file target/u.test(
      error.message,
    )
  );
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
  workspaceConfig: WorkspaceConfig | undefined,
  matchPath: MatchPathFn | undefined,
): Promise<void> {
  if (!support.supportsCrossModuleSymbols || !isJsTsLanguage(support.id)) return;
  const reexports = mod.exports.filter(
    (entry) => entry.type === "reexport" || entry.type === "exportStar" || entry.type === "namespaceReexport",
  );
  if (!reexports.length) return;
  for (const entry of reexports) {
    if (entry.fromModule.startsWith(".")) {
      entry.moduleSpecifier ??= entry.fromModule;
      const resolved = await resolveSpecifier(file, entry.fromModule, projectRoot, matchPath, workspaceConfig, {
        resolveNodeModules: !!graphOptions.resolveNodeModules,
        ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
      });
      if (typeof resolved === "string" && isFilePathWithinRoot(projectRoot, resolved)) entry.fromModule = resolved;
      continue;
    }
    const pkgResolved = await resolveWorkspacePackage(entry.fromModule, workspaceConfig);
    if (pkgResolved) {
      entry.moduleSpecifier ??= entry.fromModule;
      if (isFilePathWithinRoot(projectRoot, pkgResolved)) entry.fromModule = pkgResolved;
    }
  }
}

async function buildIndexedModuleForFile(args: {
  file: string;
  support: LanguageSupport;
  projectRoot: string;
  opts: BuildOptions | undefined;
  report: BuildReport | undefined;
  graphOptions: GraphBuildOptions;
  workspaceConfig?: WorkspaceConfig;
  matchPath?: MatchPathFn;
  workerSetup: WorkerPoolSetupResult;
  parsedMap: Map<string, ParsedFileContext>;
  parsedCacheMaxEntries: number;
  jsonDependencies: Map<string, string>;
  bloomFilterCache: import("../util/bloomFilter.js").BloomFilterCache | undefined;
  onFallbackImportExtraction: ((event: FallbackImportExtractionEvent) => void) | undefined;
  fileSignatures: Map<string, FileSignature>;
  cacheEnabled: boolean;
  resolverEnvironmentFingerprint?: string | null;
  confinedRoot?: string;
  trustedSource?: string | undefined;
}): Promise<IndexedFileModuleResult> {
  const prepared = await prepareFileContextForBuild(
    args.file,
    args.support,
    args.opts,
    args.workerSetup,
    args.report,
    args.confinedRoot,
    args.projectRoot,
    args.trustedSource,
    !!args.bloomFilterCache,
  );
  const { source, sup, nativeQueries, embeddedBlocks } = prepared;
  let tree: SyntaxTreeLike | undefined;
  const graphOnlyLanguage = isGraphOnlyLanguage(sup.id),
    nativeSourceLimitFallback =
      prepared.nativeFallbackReason === "queryFailure" &&
      !!prepared.nativeError?.startsWith("source exceeds native byte limit");

  if (prepared.syntaxTree) {
    const parsedTree = new ProjectedSyntaxTree(source, prepared.syntaxTree);
    tree = parsedTree;
    setParsedCacheEntry(
      args.parsedMap,
      args.file,
      {
        source,
        tree: parsedTree,
        sup,
        ...(embeddedBlocks ? { embeddedBlocks } : {}),
        nativeQueries,
      },
      args.parsedCacheMaxEntries,
    );
  } else if (!nativeQueries && !graphOnlyLanguage && sup.id !== "sql" && !nativeSourceLimitFallback) {
    const parseAttempt = attemptParsePreparedFileContext(prepared);
    const parsed = parseAttempt.parsed;
    if (parsed) {
      tree = parsed.tree;
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
  } else if (nativeQueries && !graphOnlyLanguage && sup.id !== "sql") {
    // Worker returned queries without a tree (older path/fallback): reconstruct once.
    const parseAttempt = attemptParsePreparedFileContext(prepared);
    const parsed = parseAttempt.parsed;
    if (parsed) {
      tree = parsed.tree;
      setParsedCacheEntry(args.parsedMap, args.file, parsed, args.parsedCacheMaxEntries);
    }
  }
  const lacksParserContext = !nativeQueries && !tree;

  if (args.bloomFilterCache && !nativeSourceLimitFallback) {
    const filter = prepared.workerBloomFilter
      ? BloomFilter.fromBuffer(
          Buffer.from(prepared.workerBloomFilter.bits),
          prepared.workerBloomFilter.size,
          prepared.workerBloomFilter.hashCount,
          prepared.workerBloomFilter.itemCount,
        )
      : buildBloomFilterFromSource(source, sup);
    args.bloomFilterCache.set(args.file, filter);
  }

  // Single builder so an option added here always reaches both the primary source and
  // every embedded (SFC) block, instead of one path silently missing a future option.
  const sharedImportOptions = {
    graphOptions: args.graphOptions,
    ...(args.workspaceConfig ? { workspaceConfig: args.workspaceConfig } : {}),
    ...(args.matchPath ? { matchPath: args.matchPath } : {}),
    ...(args.opts?.native ? { native: args.opts.native } : {}),
    ...(args.opts?.logLevel ? { logLevel: args.opts.logLevel } : {}),
    ...(args.opts?.languageExtensions ? { languageExtensions: args.opts.languageExtensions } : {}),
    ...(args.onFallbackImportExtraction ? { onFallbackImportExtraction: args.onFallbackImportExtraction } : {}),
  };
  const imports =
    nativeSourceLimitFallback || sup.id === "sql"
      ? []
      : await collectImportsForFile(args.file, args.projectRoot, {
          source,
          sup,
          ...(nativeQueries !== undefined ? { nativeQueries } : {}),
          ...sharedImportOptions,
        });
  for (const block of embeddedBlocks ?? []) {
    imports.push(
      ...(await collectImportsForFile(args.file, args.projectRoot, {
        source: block.source,
        sup: block.sup,
        ...sharedImportOptions,
      })),
    );
  }
  collectJsonDependencies(imports, args.jsonDependencies);
  let mod: ModuleIndex;
  if (sup.id === "sql") {
    mod = buildSqlModuleIndex(args.file, source);
  } else if (lacksParserContext) {
    mod = { ...createEmptyModuleIndex(args.file), imports };
  } else {
    mod = collectLocalsAndExportsFromSource(args.file, source, sup, imports, {
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
    args.matchPath,
  );

  const sigInfo = args.fileSignatures.get(args.file);
  const cacheable = !prepared.nativeFallbackReason && !lacksParserContext;
  let cacheWrite: PendingModuleCacheWrite | undefined;
  if (sigInfo && cacheable) {
    const cacheSig = args.cacheEnabled
      ? await moduleCacheSignatureForFile(args.file, sigInfo, args.opts, args.resolverEnvironmentFingerprint)
      : sigInfo.cacheSig;
    cacheWrite = { file: args.file, sig: cacheSig, mod };
  }

  return {
    module: mod,
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    graphContext: {
      source,
      sup,
      ...(nativeQueries !== undefined ? { nativeQueries } : {}),
      ...(tree ? { tree } : {}),
      ...(embeddedBlocks ? { embeddedBlocks } : {}),
    },
  };
}

function isJsonFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".json");
}

function collectJsonDependencies(imports: ImportBinding[], bucket: Map<string, string>): void {
  for (const imp of imports) {
    const resolved = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : null;
    if (resolved && isJsonFile(resolved)) bucket.set(fileIdentityKey(resolved), resolved);
  }
}

function ensureJsonModule(modules: Map<FileId, ModuleIndex>, filePath: string): void {
  const resolved = path.resolve(filePath);
  const normalized = normalizePath(resolved);
  const key = fileIdentityKey(normalized);
  if (modules.has(key)) return;
  if (!fs.existsSync(resolved)) return;
  const pos = { line: 1, column: 1, index: 0 };
  const symbol: SymbolDef = {
    file: normalized,
    localName: "default",
    kind: SymbolKind.Default,
    range: { start: pos, end: pos },
  };
  modules.set(key, {
    file: normalized,
    exports: [{ type: "local", exportedAs: "default", target: symbol }],
    imports: [],
    locals: [symbol],
  });
}

function graphEdgeKey(edge: Edge): string {
  const from = fileIdentityKey(edge.from);
  const target = edge.to.type === "file" ? `file:${fileIdentityKey(edge.to.path)}` : `external:${edge.to.name}`;
  return `${from}::${target}::${edge.raw ?? ""}::${edge.typeOnly ? 1 : 0}`;
}

async function moduleCacheSignatureForFile(
  file: string,
  sigInfo: FileSignature,
  opts?: BuildOptions,
  resolverEnvironmentFingerprint?: string | null,
): Promise<string> {
  const baseSignature = await cacheSignatureForFile(file, sigInfo, opts);
  const normalizedExtensions = normalizeLanguageExtensions(opts?.languageExtensions);
  const resolveNodeModules = normalizeGraphOptions(opts?.graph).resolveNodeModules;
  if (!normalizedExtensions && !resolveNodeModules) return baseSignature;
  // Combine via a hash rather than raw concatenation: the disk cache stores this string in a
  // SQLite TEXT column, and node:sqlite's DatabaseSync silently truncates TEXT bind parameters
  // at embedded NUL bytes, so a raw separator character risks the stored and freshly-computed
  // signatures never matching (permanent cache miss) if either baseSignature or the serialized
  // extensions ever contained one. A cached ModuleIndex's ImportBinding.resolved values differ
  // depending on whether resolveNodeModules was on at write time (resolved node_modules targets
  // vs. external), so that state and the environment that produced it must be part of the key.
  const hash = crypto.createHash("sha1");
  hash.update(baseSignature);
  hash.update(JSON.stringify(Object.entries(normalizedExtensions ?? {})));
  hash.update(resolveNodeModules ? "\0resolveNodeModules" : "");
  hash.update(
    resolverEnvironmentFingerprint === null ? "\0resolverEnvironmentTooLarge" : (resolverEnvironmentFingerprint ?? ""),
  );
  return hash.digest("hex");
}

function projectPatternsForLanguageExtensions(opts?: BuildOptions): string[] | undefined {
  const customPatterns = languageExtensionPatterns(opts?.languageExtensions);
  if (!customPatterns.length) return undefined;
  return [...DEFAULT_PROJECT_PATTERNS, ...customPatterns];
}

function expandStarImports(modules: Map<FileId, ModuleIndex>, opts?: BuildOptions): void {
  const expandedImportKey = (binding: ImportBinding): string | null => {
    const typeOnly = binding.typeOnly ?? false;
    if (binding.kind === "named") {
      return JSON.stringify(["named", binding.from, binding.resolved, typeOnly, binding.local, binding.imported]);
    }
    if (binding.kind === "namespace") {
      return JSON.stringify(["namespace", binding.from, binding.resolved, typeOnly, binding.localNS]);
    }
    return null;
  };

  for (const mod of modules.values()) {
    const expandedImportKeys = new Set<string>();
    for (const existing of mod.imports) {
      const key = expandedImportKey(existing);
      if (key) expandedImportKeys.add(key);
    }
    for (const imp of [...mod.imports]) {
      if (imp.kind !== "star" || typeof imp.resolved !== "string") continue;
      const target = modules.get(fileIdentityKey(imp.resolved));
      if (!target) continue;
      const targetSupport = supportForFile(imp.resolved, opts?.languageExtensions);
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
        const expandedImportKeyValue = expandedImportKey(expandedImport);
        if (!expandedImportKeyValue || expandedImportKeys.has(expandedImportKeyValue)) continue;
        expandedImportKeys.add(expandedImportKeyValue);
        mod.imports.push(expandedImport);
      }
    }
  }
}

function toProjectIndexManifestEntry(
  entry: Pick<ManifestFileEntry, "sig" | "gitSig"> & { cacheSig?: string },
): ProjectIndexManifestEntry {
  // A git signature alone is already a strong content identity (`fileSignature()` derives
  // `cacheSig` the same way: `gitSig ?? contentHash ?? sig`), so entries sourced from the disk
  // manifest (which does not persist `cacheSig`) still get one whenever `gitSig` is available.
  const cacheSig = entry.cacheSig ?? entry.gitSig;
  return {
    sig: entry.sig,
    ...(entry.gitSig ? { gitSig: entry.gitSig } : {}),
    ...(cacheSig ? { cacheSig } : {}),
  };
}

function projectIndexManifestEntries(
  entries: Iterable<readonly [string, Pick<ManifestFileEntry, "sig" | "gitSig"> & { cacheSig?: string }]>,
): Map<string, ProjectIndexManifestEntry> {
  return new Map(Array.from(entries, ([file, entry]) => [file, toProjectIndexManifestEntry(entry)]));
}

type ManifestMode = "off" | "read-only" | "read-write";

type BuildIndexHelperOptions = {
  manifestMode?: ManifestMode;
  warnNoFilesMessage?: string;
  ignoreExistingManifest?: boolean;
  reportDiscoveryProgress?: boolean;
  projectFiles?: ProjectFileInfo[] | Promise<ProjectFileInfo[]>;
  transientFiles?: string[];
  symlinkDirectories?: string[];
  confineReads?: boolean;
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
  const report = opts?.report ?? { timings: {} };
  initNativeBackendReport(report);
  const cacheMode = opts?.cache ?? "off";
  return {
    normalizedProjectRoot: normalizePath(path.resolve(projectRoot)),
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

function emitIndexCheckActivity(
  opts: BuildOptions | undefined,
  activity: string,
  current: number = 0,
  total: number = 0,
): void {
  opts?.onProgress?.({
    type: "progress",
    phase: "update",
    mode: "check",
    message: activity,
    activity,
    current,
    total,
  });
}

function buildConcurrency(opts: BuildOptions | undefined): number {
  return resolveWorkerThreadCount({ requested: Number(opts?.threads || 0), defaultCount: 8, max: 64 });
}

async function prepareFileSignatures(args: {
  projectRoot: string;
  files: string[];
  gitSigMap: Map<string, string>;
  cacheEnabled: boolean;
  signatureStrict: boolean | undefined;
  concurrency: number;
  confinedRoot?: string;
  trustedSources?: Map<string, string> | undefined;
}): Promise<Map<string, FileSignature>> {
  const entries = await mapLimit(args.files, args.concurrency, async (file) => {
    const gitSig = args.gitSigMap.get(file);
    const source = args.confinedRoot
      ? await readConfinedUtf8File(args.confinedRoot, args.projectRoot, file)
      : undefined;
    if (source !== undefined) {
      args.trustedSources?.set(file, source);
      return [file, fileSignatureFromSource(source, gitSig)] as const;
    }
    const sigInfo = await fileSignature(file, args.signatureStrict, gitSig, {
      forceContentHash: args.cacheEnabled && !gitSig,
    });
    return [file, sigInfo] as const;
  });
  return new Map(entries);
}

type FullDiscoveryBuildOptions = BuildOptions & Pick<IncrementalBuildOptions, "additionalFiles">;

async function buildProjectIndexFromExport(
  projectRoot: string,
  opts?: FullDiscoveryBuildOptions,
  helperOpts?: Pick<BuildIndexHelperOptions, "ignoreExistingManifest" | "reportDiscoveryProgress">,
): Promise<ProjectIndex> {
  return buildProjectIndexWithManifestOptions(projectRoot, opts, helperOpts);
}

async function buildIndexFromFileListShared(
  projectRoot: string,
  rawFiles: readonly string[],
  opts?: BuildOptions,
  helperOpts?: BuildIndexHelperOptions,
): Promise<ProjectIndex> {
  clearResolutionCaches();
  await initializeFileIdentityCaseSensitivity(projectRoot);
  const { normalizedProjectRoot, report, timings, totalStart, cacheEnabled, graphOptions, onFallbackImportExtraction } =
    createIndexBuildRunState(projectRoot, opts);
  const manifestMode: ManifestMode = helperOpts?.manifestMode ?? "off";
  const useManifest = manifestMode !== "off";
  const shouldWriteManifest = manifestMode === "read-write";
  const projectFiles = helperOpts?.projectFiles;
  initManifestReport(report, useManifest, false);
  const confinedRoot = helperOpts?.confineReads ? await fsp.realpath(projectRoot) : undefined;
  const [trustedSources, normalizedFiles] = [
    confinedRoot ? new Map<string, string>() : undefined,
    Array.from(new Set(normalizeIndexedFileInputs(projectRoot, rawFiles ?? [], "Index file"))),
  ] as const;
  if (!normalizedFiles.length && helperOpts?.warnNoFilesMessage) {
    logWithLevel(opts?.logLevel, "warn", helperOpts.warnNoFilesMessage);
  }
  const fileReport = initFileReport(report);
  if (fileReport) fileReport.total = normalizedFiles.length;
  const manifestStart = performance.now();
  const manifest =
    useManifest && !helperOpts?.ignoreExistingManifest ? await loadManifest(projectRoot, opts, report) : null;
  const manifestFiles = sanitizeManifestEntriesForRoot(projectRoot, manifest?.files);
  const manifestOptionDiffs = manifest ? diffBuildOptions(manifest.buildOptions, opts) : [];
  const languageExtensionsChanged = manifestOptionDiffs.includes("languageExtensions");
  const implementationChanged = manifestOptionDiffs.includes("implementation");
  let resolverEnvironmentFingerprint: string | null | undefined;
  let resolverEnvironmentMatchesManifest = true;
  if (cacheEnabled && graphOptions.resolveNodeModules) {
    resolverEnvironmentFingerprint = await computeResolverEnvironmentFingerprint(projectRoot, normalizedFiles);
    if (useManifest) {
      resolverEnvironmentMatchesManifest =
        resolverEnvironmentFingerprint !== null &&
        manifest?.resolverEnvironmentFingerprint === resolverEnvironmentFingerprint;
    }
  }
  if (timings && useManifest) {
    timings.manifestMs = Math.round(performance.now() - manifestStart);
  }
  const edgeProbeConcurrency = buildConcurrency(opts);
  const staleCachedEdgeFiles = new Set<string>();
  if (manifest) {
    const edgeTargetPaths: string[] = [];
    for (const entry of Object.values(manifestFiles)) {
      for (const edge of entry.edges) {
        if (edge.to.type === "file") edgeTargetPaths.push(edge.to.path);
      }
    }
    const edgeTargetExistence = await probePathExistence(edgeTargetPaths, edgeProbeConcurrency);
    for (const [file, entry] of Object.entries(manifestFiles)) {
      if (entry.edges.some((edge) => edge.to.type === "file" && !edgeTargetExistence.get(edge.to.path))) {
        staleCachedEdgeFiles.add(file);
      }
    }
  }
  const cachedGraphEntries =
    manifest &&
    !languageExtensionsChanged &&
    !implementationChanged &&
    resolverEnvironmentMatchesManifest &&
    graphOptionsEqual(manifest.graphOptions, graphOptions)
      ? new Map<string, ManifestFileEntry>(
          Object.entries(manifestFiles).filter(([file]) => !staleCachedEdgeFiles.has(file)),
        )
      : undefined;
  const manifestEntries = shouldWriteManifest ? new Map<string, ManifestFileEntry>() : undefined;
  if (report?.manifest) {
    report.manifest.reused = !!cachedGraphEntries;
  }
  const manifestEntriesForIndex = useManifest
    ? projectIndexManifestEntries(cachedGraphEntries ?? [])
    : new Map<string, ProjectIndexManifestEntry>();
  const modules = new Map<FileId, ModuleIndex>();
  const gitAvailable = await isGitRepo(projectRoot);
  const needsPersistentSignatures = cacheEnabled || useManifest;
  const useGitSignatures = gitAvailable && needsPersistentSignatures;
  const gitSigMap = useGitSignatures
    ? await getGitBlobHashes(projectRoot, normalizedFiles, {
        gitAvailable,
        ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
      })
    : new Map<string, string>();
  const signatureStrict = needsPersistentSignatures ? opts?.cacheStrict : false;
  const conc = edgeProbeConcurrency;
  const languageExtensions = normalizeLanguageExtensions(opts?.languageExtensions);
  const sqlFiles = normalizedFiles
    .filter((file) => {
      if (!languageExtensions) return path.extname(file).toLowerCase() === ".sql";
      return supportForFile(file, languageExtensions)?.id === "sql";
    })
    .sort((left, right) => left.localeCompare(right));
  const fileSignatures = await prepareFileSignatures({
    projectRoot,
    files: sqlFiles,
    gitSigMap,
    cacheEnabled,
    signatureStrict,
    concurrency: conc,
    ...(confinedRoot ? { confinedRoot, trustedSources } : {}),
  });
  const sqlCorpusSig = sqlCorpusSignature(sqlFiles, fileSignatures);
  let sqlFactCachePromise: Promise<SqlFactCache> | undefined;
  const getSqlFactCache = (): Promise<SqlFactCache> => {
    sqlFactCachePromise ??= buildSqlFactCache(normalizedFiles, opts?.languageExtensions);
    return sqlFactCachePromise;
  };
  const shouldProvideSqlFactCache = (
    file: string,
    sigInfo: FileSignature,
    cachedEdgesEntry: ManifestFileEntry | undefined,
  ): boolean => {
    if (supportForFile(file, opts?.languageExtensions)?.id !== "sql") return false;
    if (!cachedEdgesEntry || !sqlCorpusSig || cachedEdgesEntry.sqlCorpusSig !== sqlCorpusSig) return true;
    const matchesGitSig = !!sigInfo.gitSig && !!cachedEdgesEntry.gitSig && cachedEdgesEntry.gitSig === sigInfo.gitSig;
    return !(matchesGitSig || cachedEdgesEntry.sig === sigInfo.sig);
  };
  const jsonDependencies = new Map<string, string>();
  type ModuleCacheProbe = { sigInfo: FileSignature; mod: ModuleIndex | null } | { error: unknown };
  // Cache lookup determines the work a full build will actually parse. Complete that cheap phase
  // before starting Piscina, so a warm build does not bootstrap workers and partial hits bound
  // the pool to real parse misses rather than the input file list.
  const moduleCacheAvailable = opts?.cache !== "disk" || diskModuleCacheExists(projectRoot, opts);
  const cacheProbes = new Map<string, ModuleCacheProbe>(
    await mapLimit(normalizedFiles, conc, async (file) => {
      try {
        let sigInfo = fileSignatures.get(file);
        if (!sigInfo) {
          const gitSig = gitSigMap.get(file);
          const source = confinedRoot ? await readConfinedUtf8File(confinedRoot, projectRoot, file) : undefined;
          if (source !== undefined) {
            trustedSources?.set(file, source);
            sigInfo = fileSignatureFromSource(source, gitSig);
          } else {
            sigInfo = await fileSignature(file, signatureStrict, gitSig, {
              forceContentHash: cacheEnabled && !gitSig,
            });
          }
          fileSignatures.set(file, sigInfo);
        }
        manifestEntriesForIndex.set(file, toProjectIndexManifestEntry(sigInfo));
        if (manifestEntries) {
          const initialManifestEntry = toManifestFileEntry({ ...sigInfo, edges: [] });
          if (initialManifestEntry) manifestEntries.set(file, initialManifestEntry);
        }
        const cacheSig = cacheEnabled
          ? await moduleCacheSignatureForFile(file, sigInfo, opts, resolverEnvironmentFingerprint)
          : sigInfo.cacheSig;
        const canReuseModuleCache =
          cacheEnabled && (!graphOptions.resolveNodeModules || resolverEnvironmentFingerprint !== null);
        const mod = canReuseModuleCache
          ? tryLoadFromCache(projectRoot, file, cacheSig, opts, report, moduleCacheAvailable)
          : null;
        return [file, { sigInfo, mod }] as const;
      } catch (error) {
        return [file, { error }] as const;
      }
    }),
  );
  const cacheMisses = Array.from(cacheProbes, ([file, probe]) =>
    !("error" in probe) && !probe.mod ? file : null,
  ).filter((file): file is string => file !== null);
  const workerSetup = await setupWorkerPool(
    opts,
    countNativeWorkerEligibleFiles(cacheMisses, opts?.languageExtensions),
  );
  try {
    const useBloomFilters = opts?.useBloomFilters ?? true;
    const bloomFilterCache = useBloomFilters
      ? new (await import("../util/bloomFilter.js")).BloomFilterCache()
      : undefined;
    const persistedBloomFilters = bloomFilterCache
      ? await tryLoadPersistedBloomFilters(projectRoot, opts, report)
      : null;
    const parsedMap = new Map<string, ParsedFileContext>();
    const workspaceConfig = await loadWorkspaceConfig(projectRoot);
    const tsconfigMatchPathByDirectory = new Map<string, Promise<MatchPathFn | undefined>>();
    const loadMatchPathForFile = (file: string): Promise<MatchPathFn | undefined> => {
      const directory = path.dirname(file);
      let matchPath = tsconfigMatchPathByDirectory.get(directory);
      if (!matchPath) {
        matchPath = loadNearestTsconfigFor(file, projectRoot, opts?.logLevel).then((tsconfig) => tsconfig.matchPath);
        tsconfigMatchPathByDirectory.set(directory, matchPath);
      }
      return matchPath;
    };
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
        const cacheProbe = cacheProbes.get(file);
        if (!cacheProbe) throw new Error(`Missing module cache probe for ${file}`);
        if ("error" in cacheProbe) throw cacheProbe.error;
        const { sigInfo } = cacheProbe;
        let mod = cacheProbe.mod;
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
            ...(opts?.languageExtensions ? { languageExtensions: opts.languageExtensions } : {}),
            ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
            ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
            fileSignature: sigInfo,
            ...(sqlCorpusSig ? { sqlCorpusSig } : {}),
            ...(cachedEdgesEntry ? { cachedFileEdges: cachedEdgesEntry } : {}),
            ...(manifest?.projectRoot ? { cachedFileEdgesProjectRoot: manifest.projectRoot } : {}),
            ...(onFileEdges ? { onFileEdges } : {}),
            ...(onFallbackImportExtraction ? { onFallbackImportExtraction } : {}),
            allFiles: normalizedFiles,
            ...(sqlFactCache ? { sqlFactCache } : {}),
          });
          if (bloomFilterCache) {
            const persistedFilter = persistedBloomFilters?.get(file, sigInfo);
            if (persistedFilter) {
              bloomFilterCache.set(file, persistedFilter);
            } else {
              const filter = await buildBloomFilterForFile(file, opts);
              if (filter) bloomFilterCache.set(file, filter);
            }
          }
          return [file, mod, edges, undefined] as const;
        }
        if (fileReport) fileReport.parsed = (fileReport.parsed ?? 0) + 1;
        const support = supportForFile(file, opts?.languageExtensions);
        if (!support) return [file, createEmptyModuleIndex(file), [], undefined] as const;
        ensureBuildProgressStarted();
        let graphContext: IndexedFileGraphContext | undefined;
        let cacheWrite: PendingModuleCacheWrite | undefined;
        const matchPath = support.id === "ts" || support.id === "tsx" ? await loadMatchPathForFile(file) : undefined;
        if (!mod) {
          const built = await buildIndexedModuleForFile({
            file,
            support,
            projectRoot,
            opts,
            report,
            graphOptions,
            ...(workspaceConfig ? { workspaceConfig } : {}),
            ...(matchPath ? { matchPath } : {}),
            workerSetup,
            ...(resolverEnvironmentFingerprint !== undefined ? { resolverEnvironmentFingerprint } : {}),
            parsedMap,
            parsedCacheMaxEntries: parsedCacheMaxEntries(opts),
            jsonDependencies,
            bloomFilterCache,
            onFallbackImportExtraction,
            fileSignatures,
            cacheEnabled,
            ...(confinedRoot ? { confinedRoot, trustedSource: trustedSources?.get(file) } : {}),
          });
          mod = built.module;
          graphContext = built.graphContext;
          cacheWrite = built.cacheWrite;
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
          ...(opts?.languageExtensions ? { languageExtensions: opts.languageExtensions } : {}),
          ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
          ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
          fileSignature: sigInfo,
          ...(sqlCorpusSig ? { sqlCorpusSig } : {}),
          ...(cachedEdgesEntry ? { cachedFileEdges: cachedEdgesEntry } : {}),
          ...(manifest?.projectRoot ? { cachedFileEdgesProjectRoot: manifest.projectRoot } : {}),
          ...(onFileEdges ? { onFileEdges } : {}),
          ...(onFallbackImportExtraction ? { onFallbackImportExtraction } : {}),
          allFiles: normalizedFiles,
          ...(sqlFactCache ? { sqlFactCache } : {}),
        });
        return [file, mod ?? createEmptyModuleIndex(file), edges, cacheWrite] as const;
      } catch (error) {
        if (isNativeRequiredUnavailableError(error) || isNodeSqliteUnavailableError(error)) throw error;
        if (isConfinedFileReadError(error)) throw error;
        if (isUnsupportedParserInputError(error)) {
          return [file, createEmptyModuleIndex(file), [], undefined] as const;
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
    const pendingCacheWrites: PendingModuleCacheWrite[] = [];
    for (const [file, mod, edges, cacheWrite] of fileResults) {
      modules.set(fileIdentityKey(file), mod);
      appendUniqueGraphEdges(edges);
      if (cacheWrite) pendingCacheWrites.push(cacheWrite);
    }
    if (pendingCacheWrites.length) {
      writeModulesToCache(projectRoot, pendingCacheWrites, opts);
    }
    const workspaceManifestEdges = await collectWorkspaceManifestDependencyEdges(
      projectRoot,
      normalizedFiles.filter((file) => path.basename(file) === "package.json"),
      opts?.discovery,
      opts?.logLevel,
    );
    appendUniqueGraphEdges(workspaceManifestEdges);
    if (timings) timings.graphMs = Math.round(performance.now() - graphStart);
    for (const jsonPath of jsonDependencies.values()) {
      ensureJsonModule(modules, jsonPath);
    }
    expandStarImports(modules, opts);
    if (manifestEntries) {
      for (const [file, signature] of fileSignatures) {
        if (manifestEntries.has(file)) continue;
        manifestEntries.set(file, {
          sig: signature.sig,
          ...(signature.gitSig ? { gitSig: signature.gitSig } : {}),
          edges: [],
        });
      }
    }
    if (manifestEntries) {
      await writeIndexManifestSnapshot({
        projectRoot,
        opts,
        graphOptions,
        ...(resolverEnvironmentFingerprint ? { resolverEnvironmentFingerprint } : {}),
        files: manifestEntries,
        timings,
        manifestReport: report?.manifest,
        ...(helperOpts?.transientFiles !== undefined ? { transientFiles: helperOpts.transientFiles } : {}),
        ...(helperOpts?.symlinkDirectories !== undefined ? { symlinkDirectories: helperOpts.symlinkDirectories } : {}),
      });
    }
    const indexManifestEntries = manifestEntries
      ? projectIndexManifestEntries(
          Array.from(manifestEntries, ([file, entry]) => {
            const cacheSig = fileSignatures.get(file)?.cacheSig;
            return [file, { ...entry, ...(cacheSig ? { cacheSig } : {}) }] as const;
          }),
        )
      : manifestEntriesForIndex;
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
      manifestEntries: indexManifestEntries,
    });
    if (manifestEntries) {
      await writeProjectIndexSnapshot(
        projectRoot,
        opts,
        index,
        projectSnapshotFilesSignature(manifestEntries, projectRoot),
      );
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
  helperOpts?: Pick<BuildIndexHelperOptions, "ignoreExistingManifest" | "reportDiscoveryProgress">,
): Promise<ProjectIndex> {
  const timings = opts?.report ? (opts.report.timings ??= {}) : undefined;
  await initializeFileIdentityCaseSensitivity(projectRoot);
  try {
    const useDiskCache = (opts?.cache ?? "off") === "disk";
    // With disk caching enabled, reuse the previous full scan's symlinked-directory
    // list so the file-discovery and project-file walks below can skip their own
    // full-tree symlink probe. Off and memory modes never read or write this disk
    // manifest, keeping read-only builds from mutating the project root. A missing or
    // unusable manifest falls back to probing once.
    // The manifest records the project-root directory mtime alongside symlink hints. A changed
    // root mtime triggers the cheap full-tree probe, while strict modes always probe.
    const wantsMaxSymlinkCorrectness = !!opts?.cacheStrict || !!opts?.cacheVerify;
    const symlinkHintManifest =
      helperOpts?.ignoreExistingManifest || wantsMaxSymlinkCorrectness || !useDiskCache
        ? null
        : await loadManifest(projectRoot, opts);
    const rootMtime = symlinkHintManifest ? (await fsp.stat(projectRoot)).mtimeMs : undefined;
    const symlinkHintIsFresh =
      symlinkHintManifest?.symlinkDirectoriesRootMtimeMs !== undefined &&
      rootMtime === symlinkHintManifest.symlinkDirectoriesRootMtimeMs;
    const knownSymlinkDirectories = symlinkHintIsFresh ? symlinkHintManifest?.symlinkDirectories : undefined;
    let discoveredSymlinkDirectories = knownSymlinkDirectories;
    const onSymlinkDirectoriesDiscovered = (directories: readonly string[]) => {
      discoveredSymlinkDirectories = Array.from(directories);
    };
    let discoveredGitCandidates: GitCandidateSet | null | undefined;
    const onGitCandidatesDiscovered = (candidates: GitCandidateSet | null) => {
      discoveredGitCandidates = candidates;
    };
    const onDiscoveryProgress = helperOpts?.reportDiscoveryProgress
      ? (progress: { activity: string; current: number; total: number }) =>
          emitIndexCheckActivity(opts, progress.activity, progress.current, progress.total)
      : undefined;
    // When the hint is unknown, listProjectFiles() and discoverProjectFiles() must run
    // sequentially rather than in Promise.all to avoid duplicate full-tree probes. The Git
    // candidate callback below reuses that same listing so metadata discovery does not spawn
    // Git a second time.
    if (helperOpts?.reportDiscoveryProgress) emitIndexCheckActivity(opts, "Discovering source files");
    const sourceDiscoveryStart = performance.now();
    const discoveredFiles = await listProjectFilesWithGitCandidates(
      projectRoot,
      projectPatternsForLanguageExtensions(opts),
      {
        ...opts?.discovery,
        ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
        ...(knownSymlinkDirectories !== undefined ? { knownSymlinkDirectories } : {}),
        onSymlinkDirectoriesDiscovered,
        onGitCandidatesDiscovered,
        ...(onDiscoveryProgress ? { onDiscoveryProgress } : {}),
      },
    );
    if (timings) timings.sourceDiscoveryMs = Math.round(performance.now() - sourceDiscoveryStart);
    const additionalFileCandidates = await normalizeIndexedFileInputsWithinRoot(
      projectRoot,
      opts?.additionalFiles ?? [],
      "Additional index file",
    );
    const additionalFileExistence = await probePathExistence(additionalFileCandidates, buildConcurrency(opts));
    const additionalFiles = additionalFileCandidates.filter((file) => additionalFileExistence.get(file));
    const discoveredFileSet = new Set(discoveredFiles);
    const files = Array.from(new Set([...discoveredFiles, ...additionalFiles]));
    const transientFiles = additionalFiles.filter((file) => !discoveredFileSet.has(file));
    if (helperOpts?.reportDiscoveryProgress) emitIndexCheckActivity(opts, "Discovering project metadata");
    const metadataDiscoveryStart = performance.now();
    const projectFiles = await discoverProjectFilesWithGitCandidates(projectRoot, {
      ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
      ...(discoveredSymlinkDirectories !== undefined ? { knownSymlinkDirectories: discoveredSymlinkDirectories } : {}),
      ...(discoveredGitCandidates !== undefined ? { knownGitCandidates: discoveredGitCandidates } : {}),
      ...(onDiscoveryProgress ? { onDiscoveryProgress } : {}),
    });
    if (timings) timings.metadataDiscoveryMs = Math.round(performance.now() - metadataDiscoveryStart);
    return await buildIndexFromFileListShared(projectRoot, files, opts, {
      manifestMode: useDiskCache ? "read-write" : "off",
      warnNoFilesMessage: `Warning: No files found in project root: ${projectRoot}. Check codegraph.config.json globs and CLI --include-glob/--ignore-glob filters. Diagnostic: codegraph doctor`,
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
    const normalizedInputFiles = await normalizeIndexedFileInputsWithinRoot(projectRoot, inputFiles, "Index file");

    return await buildIndexFromFileListShared(projectRoot, normalizedInputFiles, opts, {
      manifestMode: useDiskCache ? "read-only" : "off",
      warnNoFilesMessage: `Warning: No files provided for indexing in ${projectRoot}. Check the explicit file list and include/ignore filters. Diagnostic: codegraph doctor`,
      confineReads: true,
    });
  } finally {
    if ((opts?.cache ?? "off") === "disk") {
      closeDiskCacheDatabase(projectRoot, opts);
      closeDuplicateUnitCacheDatabase(projectRoot, opts);
    }
  }
}

/**
 * Build exactly the file list a caller declared as the current project scope.
 *
 * Identical to {@link buildProjectIndexFromFiles} except that an empty list is a valid
 * query result (a scope whose filters matched nothing), not the missing-file-list operator
 * error that variant warns about. The manifest stays read-only either way, so a scoped
 * build never rewrites project-wide state.
 */
async function buildDeclaredScopeIndex(
  projectRoot: string,
  scopeFiles: readonly string[],
  opts?: BuildOptions,
): Promise<ProjectIndex> {
  try {
    const useDiskCache = (opts?.cache ?? "off") === "disk";
    return await buildIndexFromFileListShared(projectRoot, [...scopeFiles], opts, {
      manifestMode: useDiskCache ? "read-only" : "off",
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
  await initializeFileIdentityCaseSensitivity(projectRoot);
  clearResolutionCaches();
  const graphOptions = normalizeGraphOptions(opts?.graph);
  const strictIncremental = opts?.incrementalStrict ?? false;
  if (strictIncremental && graphOptions.fast) graphOptions.fast = false;
  const { normalizedProjectRoot, report, timings, totalStart, cacheMode, cacheEnabled, onFallbackImportExtraction } =
    createIndexBuildRunState(projectRoot, opts, graphOptions);
  const discoveryTimings = opts?.report ? (opts.report.timings ??= {}) : undefined;
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
    const declaredScope = opts?.filesAreProjectScope ? opts.files : undefined;
    // A declared project scope is the whole truth for this build, including when it is
    // empty: full discovery would silently widen a scoped query. Scoped builds go through
    // the shared finalization path with a read-only manifest, so they never rewrite
    // project-wide state.
    if (declaredScope && !declaredScope.length) {
      return await buildDeclaredScopeIndex(projectRoot, declaredScope, opts);
    }
    if (cacheMode !== "disk") {
      if (declaredScope) {
        return await buildDeclaredScopeIndex(projectRoot, declaredScope, opts);
      }
      return await buildProjectIndexFromExport(projectRoot, opts, { ignoreExistingManifest: true });
    }
    startCheckProgress();
    const manifestStart = performance.now();
    const manifest = await loadManifest(projectRoot, opts, report);
    if (timings) timings.manifestMs = Math.round(performance.now() - manifestStart);
    const manifestUsed = !!manifest;
    const manifestReport = initManifestReport(report, manifestUsed, false);
    if (manifestReport && !manifestUsed) manifestReport.reason = "missing";
    const optionDiffs = diffBuildOptions(manifest?.buildOptions, opts);
    const warningOptionDiffs = optionDiffs.filter((diff) => diff !== "cache");
    if (manifest && warningOptionDiffs.length) {
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
    const configChanged =
      !!currentConfigHashResult.error || !manifest?.configHash || currentConfigHash !== manifest.configHash;
    let resolverEnvironmentFingerprint: string | null | undefined;
    let resolverEnvironmentMatchesManifest = true;
    if (manifest && graphOptions.resolveNodeModules) {
      resolverEnvironmentFingerprint = await computeResolverEnvironmentFingerprint(
        projectRoot,
        Object.keys(manifest.files),
      );
      resolverEnvironmentMatchesManifest =
        resolverEnvironmentFingerprint !== null &&
        manifest.resolverEnvironmentFingerprint === resolverEnvironmentFingerprint;
    }
    const requiresFullRebuild = optionDiffs.some(
      (diff) => diff === "discovery" || diff === "native" || diff === "implementation" || diff === "languageExtensions",
    );
    const graphOptionsChanged = !graphOptionsEqual(manifest?.graphOptions, graphOptions);
    if (
      !manifest ||
      graphOptionsChanged ||
      configChanged ||
      requiresFullRebuild ||
      !resolverEnvironmentMatchesManifest
    ) {
      if (manifest && configChanged) {
        logWithLevel(opts?.logLevel, "warn", "Configuration changed, rebuilding index...");
      }
      if (manifestReport && manifest) {
        let reason = "graphOptionsMismatch";
        if (requiresFullRebuild) {
          reason = "buildOptionsMismatch";
        } else if (configChanged) {
          reason = "configChanged";
        } else if (!graphOptionsChanged && !resolverEnvironmentMatchesManifest) {
          reason = "resolverEnvironmentChanged";
        }
        manifestReport.reason = reason;
        manifestReport.reused = false;
      }
      return await buildProjectIndexFromExport(projectRoot, opts, {
        ignoreExistingManifest: true,
        reportDiscoveryProgress: true,
      });
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
    let sourceDiscoveryMs = 0;
    let sourceDiscoveryPerformed = false;
    const measureSourceDiscovery = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (!discoveryTimings || opts?.filesAreProjectScope) return await operation();
      sourceDiscoveryPerformed = true;
      const start = performance.now();
      try {
        return await operation();
      } finally {
        sourceDiscoveryMs += performance.now() - start;
      }
    };
    let manifestDiffFiles: string[] = [];
    if (shouldDiffAgainstWorkingTree) {
      try {
        const reconciledWorkingTreeDiffFiles = canReuseReconciliation
          ? opts?.reconciledWorkingTreeDiffFiles
          : undefined;
        if (reconciledWorkingTreeDiffFiles !== undefined) {
          manifestDiffFiles = reconciledWorkingTreeDiffFiles;
        } else {
          manifestDiffFiles = await measureSourceDiscovery(() =>
            listChangedFiles(projectRoot, {
              base: manifest.lastCommit,
              head: "WORKTREE",
            }),
          );
        }
      } catch (error) {
        if (!isMissingGitRevisionError(error)) throw error;
        if (manifestReport) {
          manifestReport.reason = "staleGitCommit";
          manifestReport.reused = false;
        }
        logWithLevel(opts?.logLevel, "warn", "Warning: Manifest commit is no longer available; rebuilding full index.");
        const rebuiltIndex = await buildProjectIndexFromExport(projectRoot, opts, {
          ignoreExistingManifest: true,
          reportDiscoveryProgress: true,
        });
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
        return await buildProjectIndexFromExport(projectRoot, opts, {
          ignoreExistingManifest: true,
          reportDiscoveryProgress: true,
        });
      }
    }
    const trackedEntries = sanitizeManifestEntriesForRoot(projectRoot, manifest.files);
    const manifestFileKeys = Object.keys(manifest.files);
    const trackedEntryKeys = Object.keys(trackedEntries);
    let manifestRequiresSanitization =
      manifestFileKeys.length !== trackedEntryKeys.length ||
      manifestFileKeys.some((file) => !Object.hasOwn(trackedEntries, file));
    const explicitFiles = await normalizeIndexedFileInputsWithinRoot(
      projectRoot,
      opts?.files ?? [],
      "Incremental file",
    );
    const additionalFiles = await normalizeIndexedFileInputsWithinRoot(
      projectRoot,
      opts?.additionalFiles ?? [],
      "Additional index file",
    );
    const previousTransientFiles = sanitizeManifestTransientFilesForRoot(
      projectRoot,
      projectRoot,
      manifest.transientFiles,
    ).filter((file) => Object.hasOwn(trackedEntries, file));
    const previousTransientFileSet = new Set(previousTransientFiles);
    const needsGitScan = !!opts?.gitBase || !!opts?.changedSince;
    let gitFiles: string[] = [];
    if (needsGitScan) {
      gitFiles = await measureSourceDiscovery(() =>
        listChangedFiles(projectRoot, buildIncrementalGitDiffOptions(opts)),
      );
    }
    // New files that were never committed, staged, or passed explicitly have no tracked
    // manifest entry and no working-tree-diff record, so they would otherwise stay
    // invisible to an incremental build until the next full rebuild. Detecting them via
    // `git ls-files --others` is far cheaper than a full recursive directory scan and
    // keeps this path correct without requiring callers to pre-scan the project
    // themselves. A failure here cannot be treated as "no untracked files": that would
    // silently produce an incomplete index, so it falls back to a full rebuild instead,
    // the same way a stale manifest commit does above.
    let untrackedFiles: string[] = [];
    // Without that cheap Git signal -- no repository at all, or `--cache-strict` asking for
    // maximum certainty over speed -- the manifest file list cannot prove that no new file
    // appeared, so rediscover the project instead of trusting it. Per-file signature checks
    // below still keep unchanged files cached, so this costs one directory walk, not a
    // full reparse. Callers that already resolved the complete scope (`filesAreProjectScope`)
    // need no rescan.
    let rediscoveredFiles: string[] = [];
    let discoveredGitCandidates: GitCandidateSet | null | undefined;
    if (canUseIncrementalDiscoveryFastPath(gitAvailable, opts?.cacheStrict)) {
      try {
        const reconciledUntrackedFiles = canReuseReconciliation ? opts?.reconciledUntrackedFiles : undefined;
        if (reconciledUntrackedFiles !== undefined) {
          untrackedFiles = reconciledUntrackedFiles;
        } else {
          untrackedFiles = await measureSourceDiscovery(() =>
            listUntrackedProjectFiles(projectRoot, opts?.discovery, gitAvailable),
          );
        }
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
        return await buildProjectIndexFromExport(projectRoot, opts, {
          ignoreExistingManifest: true,
          reportDiscoveryProgress: true,
        });
      }
    } else if (!opts?.filesAreProjectScope) {
      rediscoveredFiles = await measureSourceDiscovery(() =>
        listProjectFilesWithGitCandidates(projectRoot, projectPatternsForLanguageExtensions(opts), {
          ...opts?.discovery,
          ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
          ...(!opts?.cacheStrict && manifest.symlinkDirectories !== undefined
            ? { knownSymlinkDirectories: manifest.symlinkDirectories }
            : {}),
          onGitCandidatesDiscovered: (candidates) => {
            discoveredGitCandidates = candidates;
          },
        }),
      );
    }
    if (discoveryTimings && sourceDiscoveryPerformed) {
      discoveryTimings.sourceDiscoveryMs = Math.round(sourceDiscoveryMs);
    }
    const candidateFiles = [
      ...explicitFiles,
      ...additionalFiles,
      ...manifestDiffFiles,
      ...gitFiles,
      ...untrackedFiles,
      ...rediscoveredFiles,
    ];
    const candidateExistence = await probePathExistence(candidateFiles, buildConcurrency(opts));
    const existsInCandidateSnapshot = (file: string): boolean => candidateExistence.get(file) ?? false;
    const additionalFileSet = new Set(additionalFiles.filter(existsInCandidateSnapshot));
    const transientFiles = [...additionalFileSet].filter(
      (file) => previousTransientFileSet.has(file) || !Object.hasOwn(trackedEntries, file),
    );
    const retiredTransientFiles = previousTransientFiles.filter((file) => !additionalFileSet.has(file));
    const { trackedFiles, deletedTrackedFiles } = await partitionTrackedManifestFiles(trackedEntries);
    for (const file of retiredTransientFiles) {
      trackedFiles.delete(file);
      deletedTrackedFiles.add(file);
      delete trackedEntries[file];
    }
    if (retiredTransientFiles.length) manifestRequiresSanitization = true;
    const fileReport = initFileReport(report);
    if (fileReport) fileReport.total = trackedFiles.size;
    const allFiles = new Set<string>([
      ...trackedFiles,
      ...explicitFiles.filter(existsInCandidateSnapshot),
      ...additionalFiles.filter(existsInCandidateSnapshot),
      ...manifestDiffFiles.filter(existsInCandidateSnapshot),
      ...gitFiles.filter(existsInCandidateSnapshot),
      ...untrackedFiles.filter(existsInCandidateSnapshot),
      ...rediscoveredFiles.filter(existsInCandidateSnapshot),
    ]);
    if (fileReport) fileReport.total = allFiles.size;
    const dependentFilesOfDeletedTracked = collectDeletedTrackedFileDependents(trackedEntries, deletedTrackedFiles);
    if (allFiles.size === 0) {
      completeCheckProgress(0);
      await writeIndexManifestSnapshot({
        projectRoot,
        opts,
        graphOptions,
        ...(resolverEnvironmentFingerprint ? { resolverEnvironmentFingerprint } : {}),
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
    if (!resolverEnvironmentMatchesManifest) {
      for (const file of allFiles) changedFiles.add(file);
    }
    const markAsChanged = (file: string): void => {
      if (allFiles.has(file)) changedFiles.add(file);
    };
    // Git working-tree diffs are change *candidates*, not proof the indexed bytes are
    // stale. `lastCommit...WORKTREE` stays dirty across warm runs after we index the
    // dirty tree, so force-marking these files caused perpetual "Updated N files"
    // reparses even when signatures already matched the on-disk content. Keep them in
    // `allFiles` above so signature validation can decide; only skip the early snapshot
    // fast-path while candidates exist.
    const gitChangeCandidates = new Set<string>();
    for (const file of manifestDiffFiles) {
      if (existsInCandidateSnapshot(file)) gitChangeCandidates.add(file);
    }
    for (const file of gitFiles) {
      if (existsInCandidateSnapshot(file)) gitChangeCandidates.add(file);
    }
    const explicitFileSet = new Set(explicitFiles);
    const explicitFilesCoverAllFiles =
      explicitFileSet.size === allFiles.size && [...allFiles].every((file) => explicitFileSet.has(file));
    const explicitFilesAreChangeInputs = !opts?.filesAreProjectScope;
    if (explicitFileSet.size && explicitFilesAreChangeInputs && (!explicitFilesCoverAllFiles || opts?.report)) {
      explicitFileSet.forEach(markAsChanged);
    }
    dependentFilesOfDeletedTracked.forEach(markAsChanged);
    if (fileReport) fileReport.changed = changedFiles.size;

    const reuseUnchangedSnapshot = async (): Promise<ProjectIndex | null> => {
      if (changedFiles.size || deletedTrackedFiles.size || manifestRequiresSanitization) return null;
      const manifestEntryMap = new Map(Object.entries(trackedEntries));
      const snapshotLoad = await tryLoadProjectIndexSnapshot(projectRoot, opts, manifestEntryMap, report);
      if (!snapshotLoad) return null;

      const snapshot = snapshotLoad.index;
      // The early Git fast path does not stat tracked files. Its persisted mtime:size
      // values can therefore be stale after a byte-identical rewrite; lifecycle must
      // re-stat until the validated path below replaces every signature.
      snapshot.manifestSignaturesFresh = false;
      if (snapshot.projectFiles === undefined) {
        const metadataDiscoveryStart = performance.now();
        snapshot.projectFiles = await discoverProjectFilesWithGitCandidates(projectRoot, {
          ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
          ...(discoveredGitCandidates !== undefined ? { knownGitCandidates: discoveredGitCandidates } : {}),
        });
        if (discoveryTimings)
          discoveryTimings.metadataDiscoveryMs = Math.round(performance.now() - metadataDiscoveryStart);
      }
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
    const tsconfigMatchPathByDirectory = new Map<string, Promise<MatchPathFn | undefined>>();
    const loadMatchPathForFile = (file: string): Promise<MatchPathFn | undefined> => {
      const directory = path.dirname(file);
      let matchPath = tsconfigMatchPathByDirectory.get(directory);
      if (!matchPath) {
        matchPath = loadNearestTsconfigFor(file, projectRoot, opts?.logLevel).then((tsconfig) => tsconfig.matchPath);
        tsconfigMatchPathByDirectory.set(directory, matchPath);
      }
      return matchPath;
    };
    const conc = buildConcurrency(opts);
    // Created below, once the changed-file set is known. Building it here would spawn a full
    // pool before the signature pass and the unchanged-snapshot early return, so a warm
    // no-change run paid for threads that never received a task.
    let workerSetup = emptyWorkerPoolSetup();
    try {
      const useGitSignatures = gitAvailable;
      const gitSigMap = useGitSignatures
        ? await getGitBlobHashes(projectRoot, Array.from(allFiles), {
            gitAvailable,
            ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
          })
        : new Map<string, string>();
      const fileSignatures = await prepareFileSignatures({
        projectRoot,
        files: Array.from(allFiles),
        gitSigMap,
        cacheEnabled,
        signatureStrict: opts?.cacheStrict,
        concurrency: conc,
      });
      const modules = new Map<FileId, ModuleIndex>();
      const parsedMap = new Map<string, ParsedFileContext>();
      const jsonDependencies = new Map<string, string>();
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
      const reverseDeps = buildTrackedFileReverseDependencies(trackedEntries);
      const invalidateCachedDependents = () => {
        const dependentFilesOfChanged = collectTrackedFileDependents(trackedEntries, changedFiles, reverseDeps);
        for (const file of dependentFilesOfChanged) {
          const key = fileIdentityKey(file);
          if (modules.has(key)) {
            modules.delete(key);
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
        unchangedSnapshot.manifestEntries = new Map(
          Array.from(fileSignatures, ([file, signature]) => [file, toProjectIndexManifestEntry(signature)]),
        );
        unchangedSnapshot.manifestSignaturesFresh = true;
        if (timings) timings.totalMs = Math.round(performance.now() - totalStart);
        completeCheckProgress(allFiles.size);
        return unchangedSnapshot;
      }
      const snapshotModules = cacheEnabled
        ? await tryLoadProjectSnapshotModules(projectRoot, opts, fileSignatures, report)
        : null;
      const persistedBloomFilters = bloomFilterCache
        ? await tryLoadPersistedBloomFilters(projectRoot, opts, report)
        : null;
      for (const file of allFiles) {
        if (changedFiles.has(file)) continue;
        const sigInfo = fileSignatures.get(file)!;
        let cached: ModuleIndex | null = null;
        const snapshotMod = snapshotModules?.get(fileIdentityKey(file));
        if (snapshotMod) {
          cached = snapshotMod;
        } else if (cacheEnabled) {
          const cacheSig = await moduleCacheSignatureForFile(file, sigInfo, opts, resolverEnvironmentFingerprint);
          cached = tryLoadFromCache(projectRoot, file, cacheSig, opts, report);
        }
        if (cached) {
          if (fileReport) fileReport.cached = (fileReport.cached ?? 0) + 1;
          modules.set(fileIdentityKey(file), cached);
          collectJsonDependencies(cached.imports, jsonDependencies);
          if (bloomFilterCache) {
            const persistedFilter = persistedBloomFilters?.get(file, sigInfo);
            if (persistedFilter) {
              bloomFilterCache.set(file, persistedFilter);
            } else {
              const filter = await buildBloomFilterForFile(file, opts);
              if (filter) bloomFilterCache.set(file, filter);
            }
          }
        } else {
          changedFiles.add(file);
        }
      }
      invalidateCachedDependents();
      const changedList = Array.from(changedFiles);
      // Sized by the work that remains rather than the size of the project: an incremental build
      // touching a handful of files gets a handful of threads, or none.
      workerSetup = await setupWorkerPool(opts, countNativeWorkerEligibleFiles(changedList, opts?.languageExtensions));
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
            const support = supportForFile(file, opts?.languageExtensions);
            if (!support) return [file, createEmptyModuleIndex(file)] as const;
            const matchPath =
              support.id === "ts" || support.id === "tsx" ? await loadMatchPathForFile(file) : undefined;
            const built = await buildIndexedModuleForFile({
              file,
              support,
              projectRoot,
              opts,
              report,
              graphOptions,
              ...(workspaceConfig ? { workspaceConfig } : {}),
              ...(matchPath ? { matchPath } : {}),
              workerSetup,
              parsedMap,
              parsedCacheMaxEntries: parsedCacheMaxEntries(opts),
              jsonDependencies,
              bloomFilterCache,
              onFallbackImportExtraction,
              fileSignatures,
              cacheEnabled,
              ...(resolverEnvironmentFingerprint !== undefined ? { resolverEnvironmentFingerprint } : {}),
            });
            return [file, built.module, built.cacheWrite] as const;
          } catch (error) {
            if (isNativeRequiredUnavailableError(error) || isNodeSqliteUnavailableError(error)) throw error;
            if (isUnsupportedParserInputError(error)) {
              return [file, createEmptyModuleIndex(file)] as const;
            }
            recordFileFailure(report, file, error);
            logWithLevel(opts?.logLevel, "warn", `Warning: Failed to process file ${file}:`, error);
            return [file, createEmptyModuleIndex(file), undefined] as const;
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
        const pendingIncrementalCacheWrites: PendingModuleCacheWrite[] = [];
        for (const [file, mod, cacheWrite] of fileResults) {
          modules.set(fileIdentityKey(file), mod);
          if (cacheWrite) pendingIncrementalCacheWrites.push(cacheWrite);
        }
        if (pendingIncrementalCacheWrites.length) {
          writeModulesToCache(projectRoot, pendingIncrementalCacheWrites, opts);
        }
        if (timings) timings.parseMs = Math.round(performance.now() - parseStart);
      }
      for (const jsonPath of jsonDependencies.values()) {
        ensureJsonModule(modules, jsonPath);
      }
      expandStarImports(modules, opts);
      const retainedTrackedEntries = Object.entries(trackedEntries).filter(([file]) => !deletedTrackedFiles.has(file));
      const cachedGraphEntries = resolverEnvironmentMatchesManifest
        ? new Map<string, ManifestFileEntry>(retainedTrackedEntries)
        : new Map<string, ManifestFileEntry>();
      const manifestEntries = new Map<string, ManifestFileEntry>(cachedGraphEntries);
      const baseGraph: Graph | undefined =
        cachedGraphEntries.size > 0 ? { nodes: new Set<string>(), edges: [] } : undefined;
      if (baseGraph) {
        const baseGraphEdgeTargets: string[] = [];
        for (const entry of cachedGraphEntries.values()) {
          for (const edge of entry.edges) {
            if (edge.to.type === "file") baseGraphEdgeTargets.push(edge.to.path);
          }
        }
        const baseGraphEdgeExistence = await probePathExistence(baseGraphEdgeTargets, conc);
        for (const [file, entry] of cachedGraphEntries) {
          baseGraph.nodes.add(file);
          for (const edge of entry.edges) {
            baseGraph.edges.push(edge);
            if (edge.to.type === "file" && baseGraphEdgeExistence.get(edge.to.path)) {
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
              ...(opts?.languageExtensions ? { languageExtensions: opts.languageExtensions } : {}),
              threads: conc,
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
      for (const file of new Set([...changedFiles, ...transientFiles])) {
        const signature = fileSignatures.get(file);
        if (!signature || manifestEntries.has(file)) continue;
        manifestEntries.set(file, {
          sig: signature.sig,
          ...(signature.gitSig ? { gitSig: signature.gitSig } : {}),
          edges: [],
        });
      }
      // A Git blob match proves source bytes, not mtime. Refresh every retained
      // entry from the stat signatures computed above before declaring lifecycle
      // signatures fresh.
      for (const [file, entry] of manifestEntries) {
        const signature = fileSignatures.get(file);
        if (!signature) continue;
        const { gitSig: _previousGitSig, ...entryWithoutGitSig } = entry;
        manifestEntries.set(file, {
          ...entryWithoutGitSig,
          sig: signature.sig,
          ...(signature.gitSig ? { gitSig: signature.gitSig } : {}),
        });
      }
      await writeIndexManifestSnapshot({
        projectRoot,
        opts,
        graphOptions,
        ...(resolverEnvironmentFingerprint ? { resolverEnvironmentFingerprint } : {}),
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
        ...(discoveredGitCandidates !== undefined ? { knownGitCandidates: discoveredGitCandidates } : {}),
        manifestEntries: projectIndexManifestEntries(
          // `manifestEntries` (a `ManifestFileEntry`) never carries `cacheSig` -- that field
          // only lives on `FileSignature`. Overlay each entry with the `cacheSig` this build
          // actually computed (content-hash-derived for non-git files, since caching is enabled
          // whenever this path runs) so incremental writes preserve the same strong identity a
          // cold build produces, instead of leaving snapshot/bloom reuse to fall back to the
          // weak `mtime:size` `sig`.
          Array.from(manifestEntries, ([file, entry]) => {
            const cacheSig = fileSignatures.get(file)?.cacheSig;
            return [file, { ...entry, ...(cacheSig ? { cacheSig } : {}) }] as const;
          }),
        ),
        buildReport: report,
      });
      await writeProjectIndexSnapshot(
        projectRoot,
        opts,
        index,
        projectSnapshotFilesSignature(manifestEntries, projectRoot),
      );
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
  const previousLanguageExtensions = normalizeLanguageExtensions(manifest?.buildOptions?.languageExtensions);
  const currentLanguageExtensions = normalizeLanguageExtensions(opts?.languageExtensions);
  const languageExtensionsChanged = manifest
    ? diffBuildOptions(manifest.buildOptions, opts).includes("languageExtensions")
    : false;
  const languageSupportChangedForFile = (file: string): boolean =>
    supportForFile(file, previousLanguageExtensions)?.id !== supportForFile(file, currentLanguageExtensions)?.id;
  const strictIncremental = opts?.incrementalStrict ?? false;
  if (strictIncremental && graphOptions.fast) graphOptions.fast = false;
  const explicitFiles = await normalizeIndexedFileInputsWithinRoot(projectRoot, opts?.files ?? [], "Graph delta file");
  const additionalFiles = await normalizeIndexedFileInputsWithinRoot(
    projectRoot,
    opts?.additionalFiles ?? [],
    "Additional graph delta file",
  );
  const needsGitScan = !!opts?.gitBase || !!opts?.changedSince;
  const gitFiles = needsGitScan ? await listChangedFiles(projectRoot, buildIncrementalGitDiffOptions(opts)) : [];
  const { trackedFiles } = await partitionTrackedManifestFiles(trackedEntries);
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
  const candidateExistence = await probePathExistence(
    [...explicitFiles, ...additionalFiles, ...manifestDiffFiles, ...gitFiles],
    buildConcurrency(opts),
  );
  const existsInCandidateSnapshot = (file: string): boolean => candidateExistence.get(file) ?? false;
  const normalizeChangedFiles = (files: readonly string[]): string[] =>
      files.map((file) => {
        if (!existsInCandidateSnapshot(file)) return file;
        const [normalizedFile] = normalizeIndexedFileInputs(projectRoot, [file], "Graph delta file");
        return normalizedFile ?? file;
      }),
    normalizedManifestDiffFiles = normalizeChangedFiles(manifestDiffFiles),
    normalizedGitFiles = normalizeChangedFiles(gitFiles),
    existingExplicitFiles = explicitFiles.filter(existsInCandidateSnapshot);
  const existingAdditionalFiles = additionalFiles.filter(existsInCandidateSnapshot);

  const allFiles = new Set<string>([
    ...trackedFiles,
    ...existingExplicitFiles,
    ...existingAdditionalFiles,
    ...normalizedManifestDiffFiles.filter((_, index) => existsInCandidateSnapshot(manifestDiffFiles[index]!)),
    ...normalizedGitFiles.filter((_, index) => existsInCandidateSnapshot(gitFiles[index]!)),
  ]);
  const changedFiles = new Set<string>();
  const changedFileKeys = new Set<string>();
  const addChangedFile = (file: string): void => {
    const key = fileIdentityKey(file);
    if (changedFileKeys.has(key)) return;
    changedFileKeys.add(key);
    changedFiles.add(file);
  };
  existingExplicitFiles.forEach(addChangedFile);
  normalizedManifestDiffFiles.forEach(addChangedFile);
  normalizedGitFiles.forEach(addChangedFile);
  if (languageExtensionsChanged) {
    for (const file of trackedFiles) {
      if (languageSupportChangedForFile(file)) addChangedFile(file);
    }
  }
  if (!languageExtensionsChanged && allFiles.size === 0 && changedFiles.size === 0) {
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
        addChangedFile(file);
      }
    }
  }
  const beforeEdges = new Map<string, Edge>();
  if (manifest) {
    for (const file of changedFiles) {
      const entry = trackedEntries[file];
      if (!entry?.edges) continue;
      for (const edge of entry.edges) {
        beforeEdges.set(edgeKey(edge), edge);
      }
    }
  }
  const index = await buildProjectIndexIncremental(projectRoot, opts);
  if (languageExtensionsChanged) {
    for (const file of index.modules.keys()) {
      if (!languageSupportChangedForFile(file)) continue;
      const displayFile = index.byFile.get(fileIdentityKey(file))?.file ?? file;
      addChangedFile(displayFile);
    }
  }
  const changedList = Array.from(changedFiles);
  const afterEdges = new Map<string, Edge>();
  for (const edge of index.graph.edges) {
    if (changedFileKeys.has(fileIdentityKey(edge.from))) afterEdges.set(edgeKey(edge), edge);
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
