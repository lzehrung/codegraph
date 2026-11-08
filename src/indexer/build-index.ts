import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  languageExtensionPatterns,
  supportForFile,
  supportForFileWithoutHeaderSample,
  type LanguageSupport,
} from "../languages.js";
import { DECLARATION_RESOLVED_IMPORT_LANGUAGES } from "./import-resolution-tables.js";
import { loadWorkspaceConfig, type WorkspaceConfig } from "../util/workspace.js";
import {
  DEFAULT_PROJECT_PATTERNS,
  createProjectDiscoveryContext,
  discoverProjectFilesWithGitCandidates,
  listProjectFilesWithGitCandidates,
  type GitCandidateSet,
  type ProjectDiscoveryContext,
  type ProjectFileInfo,
} from "../util/project-files.js";
import { getGitHead, isGitRepo, getGitBlobHashes, listChangedFiles } from "../util/git.js";
import { clearResolutionCaches, loadNearestTsconfigFor, type MatchPathFn } from "../util/resolution.js";
import { collectCppDeclaredModules, isCppNamedModuleSpecifier } from "../util/resolution/cpp.js";
import { collectCsharpNamespaceFacts } from "../util/csharp-tree.js";
import { collectJvmFileFacts } from "../util/jvm-tree.js";
import { isJvmLanguage, readsSyntaxTree } from "../util/syntax-tree.js";
import { primeCsharpNamespaceFacts, setCsharpNamespaceFactsReader } from "../util/resolution/csharp.js";
import { primeJvmFileFacts, resolveJvmPackageImportPaths, setJvmFileFactsReader } from "../util/resolution/jvm.js";
import { primePhpModuleImportNames, setPhpModuleImportNamesReader } from "../util/resolution/php.js";
import { loadTsconfigResolutionInputsFor } from "../util/resolution/tsconfig.js";
import { resolveModuleSpecifierEdges } from "../graphs/edge-resolution.js";
import { resolveSpecifierTargets } from "../util/resolution/specifier-targets.js";
import {
  fileIdentityKey,
  initializeFileIdentityCaseSensitivity,
  isFilePathWithinRoot,
  normalizePath,
} from "../util/paths.js";
import { mapLimit } from "../util/concurrency.js";
import { pushAll } from "../util/collections.js";
import { readConfinedUtf8File } from "../util/confined-file.js";
import { resolveWorkerThreadCount } from "../util/worker-threads.js";
import { runWithProbeCache } from "../util/fs-probe-cache.js";
import { logWithLevel } from "../logging.js";
import { collectGraph } from "../graph-builder.js";
import { collectEdgesForFile, type FileEdgeSource } from "../graph-edge-collector.js";
import { buildGraphAdjacency } from "../graphs/adjacency.js";
import type { GraphBuildOptions, GraphCacheEntry } from "../graphs/types.js";
import { isGraphOnlyLanguage } from "../document-links.js";
import { attemptParsePreparedFileContext, type ParsedFileContext } from "./parse-context.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import { collectImportsForFile } from "./imports.js";
import type { ImportDegradedHook } from "./imports/context.js";
import { collectLocalsAndExportsFromSource } from "./locals-and-exports.js";
import {
  collectPhpModuleImportNames,
  phpDeclarationImportNames,
  phpModuleImportNamesFromDeclarations,
  type PhpModuleImportNames,
} from "./php-namespace-symbols.js";
import {
  buildModuleRecord,
  collectJsonDependencies,
  finishModuleRecord,
  isModuleRecordLanguage,
  resolveCrossModuleSymbolExports,
  type ModuleRecord,
  type ModuleRecordTask,
} from "./module-record.js";
import { collectParseErrorRanges } from "./parse-errors.js";
import { expandStarImports } from "./expand-star-imports.js";
import { compareEdges, edgeKey, toRelativeEdge } from "./shared.js";
import { BloomFilter, buildBloomFilterFromSource, type BloomFilterCache } from "../util/bloom-filter.js";
import type { NativeBloomFilterPayload } from "../worker/native-extract-worker.js";
import { initNativeBackendReport, recordParserBackendDegradation } from "../native/native-backend-report.js";
import { closeDuplicateUnitCacheDatabase } from "../duplicates.js";
import { assertNativeRequiredAvailable, isNativeRequiredUnavailableError } from "../native/tree-sitter-native.js";
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
  listDiskCachedModuleFiles,
  listMemoryCachedModuleFiles,
  loadModuleFromCache,
  memoryCacheEvictionSerial,
  memoryCacheLostPayloads,
  peekCachedModule,
  removeModulesFromCache,
  settleMemoryCacheEvictions,
  tryLoadFromCache,
  tryLoadPersistedBloomFilters,
  tryLoadProjectIndexSnapshot,
  tryLoadProjectSnapshotModules,
  verifyManifestEntries,
  writeModulesToCache,
  writeProjectIndexSnapshot,
  type FileSignature,
  type IndexManifest,
  type ManifestFileEntry,
  type PendingModuleCacheWrite,
} from "./build-cache.js";
import { computeResolverEnvironmentFingerprint } from "./build-cache/resolver-environment.js";
import { cacheRoot } from "./build-cache/location.js";
import {
  type BuildOptions,
  type BuildReport,
  type BuildTimingReport,
  type GraphDeltaReport,
  type ImportBinding,
  type IncrementalBuildOptions,
  type ModuleIndex,
  type ProjectIndex,
  type ProjectIndexManifestEntry,
  type SymbolDef,
  SymbolKind,
} from "./types.js";
import { isUnsupportedParserInputError } from "../languages/file-prep.js";

import { isSqlFilePath } from "../sql/classify-sql-file.js";
import { buildSqlFactCache, buildSqlModuleIndex, sqlCorpusSignature, type SqlFactCache } from "../sql/source-graph.js";
import { finalizeProjectIndex } from "./finalize.js";
import { toManifestFileEntry, writeIndexManifestSnapshot } from "./build-manifest.js";
import {
  prepareFileContextForBuild,
  countNativeWorkerEligibleFiles,
  emptyWorkerPoolSetup,
  preparedNativeOutcome,
  setupWorkerPool,
  shouldEnableNativeWorkers,
  teardownWorkerPool,
  type WorkerPoolSetupResult,
  preparedProjectFileFacts,
  readProjectFileFactsWithWorker,
  type PreparedFileContextWithWorkerBloomFilter,
} from "./build-workers.js";
import {
  buildIncrementalGitDiffOptions,
  canUseIncrementalDiscoveryFastPath,
  buildTrackedFileReverseDependencies,
  addedResolutionStems,
  collectDeletedTrackedFileDependents,
  collectDirectDependents,
  collectTrackedFileDependents,
  collectSpecifierEdgeCandidates,
  collectPythonPackageImporters,
  pythonImportersOfPackageInits,
  externalSpecifierMatchesAddedStem,
  tsconfigAliasMappedTails,
  isMissingGitRevisionError,
  listUntrackedProjectFiles,
  collectGitManifestChangeCandidates,
  filterIncrementalDiscoveryCandidates,
  partitionTrackedManifestFiles,
  probePathExistence,
} from "./incremental-plan.js";
import {
  declarationImportRecheck,
  declarationLanguageGroup,
  declarationNameChanges,
  deletedDeclarationNameChanges,
  propagateReexportSurfaceChanges,
  publicSurfaceKind,
  publicSurfaceSignature,
  recordDeclarationNameChanges,
  type DeclarationNameChanges,
} from "./public-surface.js";
import { parsedCacheMaxEntries, setParsedCacheEntry } from "./parsed-cache.js";

type IndexedFileModuleResult = {
  module: ModuleIndex;
  cacheWrite?: PendingModuleCacheWrite | undefined;
  graphContext: FileEdgeSource;
};

/**
 * How a build indexes JavaScript and TypeScript files through module records (`module-record.ts`): on the main thread
 * whenever it parses such a file there, and in the native workers when `inWorkers` is set.
 */
type ModuleRecordPolicy = { inWorkers: boolean };

type IndexedFileBuildArgs = {
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
  bloomFilterCache: BloomFilterCache | undefined;
  fileSignatures: Map<string, FileSignature>;
  cacheEnabled: boolean;
  resolverEnvironmentFingerprint?: string | null;
  confinedRoot?: string;
  trustedSource?: string | undefined;
  /** Index JavaScript and TypeScript files through module records; without it every file is indexed as before them. */
  moduleRecords?: ModuleRecordPolicy;
  preparedFile?: PreparedFileContextWithWorkerBloomFilter;
};

type ProjectFileExtraction = { prepared: PreparedFileContextWithWorkerBloomFilter } | { error: unknown };

function primePreparedPhpModule(
  prepared: PreparedFileContextWithWorkerBloomFilter,
  opts: BuildOptions | undefined,
): PhpModuleImportNames | null {
  const attempt = attemptParsePreparedFileContext(prepared);
  prepared.projectFactsParse = attempt;
  const parsed = attempt.parsed;
  if (!parsed || !prepared.nativeQueries) {
    primePhpModuleImportNames(prepared.file, null);
    return null;
  }
  const module = collectLocalsAndExportsFromSource(prepared.file, prepared.source, prepared.sup, [], {
    tree: parsed.tree,
    nativeQueries: prepared.nativeQueries,
    ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
  });
  if (parsed.tree instanceof ProjectedSyntaxTree) module.parseErrorRanges = collectParseErrorRanges(parsed.tree);
  const names = collectPhpModuleImportNames(module, parsed);
  module.phpDeclarationNames = phpDeclarationImportNames(names);
  prepared.phpModule = module;
  primePhpModuleImportNames(prepared.file, names);
  return names;
}

/** PHP proof and module construction share one extraction without a project-wide preparation barrier. */
function installPhpProjectFileReader(args: {
  files: Iterable<string>;
  opts: BuildOptions | undefined;
  workerSetup: () => WorkerPoolSetupResult;
  report: BuildReport | undefined;
  projectRoot: string;
  confinedRoot?: string;
  trustedSources?: ReadonlyMap<string, string> | undefined;
}): (file: string) => Promise<PreparedFileContextWithWorkerBloomFilter> {
  const phpFiles = new Map<string, string>();
  for (const file of args.files) {
    if (supportForFileWithoutHeaderSample(file, args.opts?.languageExtensions)?.id === "php") {
      phpFiles.set(fileIdentityKey(file), file);
    }
  }
  const pending = new Map<
    string,
    Promise<{ prepared: PreparedFileContextWithWorkerBloomFilter; names: PhpModuleImportNames | null }>
  >();
  const prepare = (file: string) => {
    const key = fileIdentityKey(file);
    const indexedFile = phpFiles.get(key);
    if (!indexedFile) return undefined;
    let extraction = pending.get(key);
    if (!extraction) {
      extraction = (async () => {
        const prepared = await prepareFileContextForBuild(
          indexedFile,
          supportForFileWithoutHeaderSample(indexedFile, args.opts?.languageExtensions)!,
          args.opts,
          args.workerSetup(),
          args.report,
          args.confinedRoot,
          args.projectRoot,
          args.trustedSources?.get(indexedFile),
          args.opts?.useBloomFilters ?? true,
        );
        const names = primePreparedPhpModule(prepared, args.opts);
        return { prepared, names };
      })();
      pending.set(key, extraction);
    }
    return extraction;
  };
  setPhpModuleImportNamesReader(async (file) => (await prepare(file))?.names);
  return async (file) => {
    const extraction = prepare(file);
    if (!extraction) throw new Error(`PHP file is outside the active extraction scope: ${file}`);
    const result = await extraction;
    pending.delete(fileIdentityKey(file));
    return result.prepared;
  };
}

/**
 * C#/JVM extraction finishes before any import lookup can scan the project. No capped task waits for an unstarted
 * file: workers return each file's own facts with its extraction, then the normal build consumes that extraction once.
 */
async function extractProjectFilesBeforeResolution(args: {
  files: readonly string[];
  opts: BuildOptions | undefined;
  report: BuildReport | undefined;
  workerSetup: WorkerPoolSetupResult;
  concurrency: number;
  projectRoot: string;
  confinedRoot?: string;
  trustedSources?: ReadonlyMap<string, string> | undefined;
}): Promise<Map<string, ProjectFileExtraction>> {
  const candidates = args.files.filter((file) =>
    readsSyntaxTree(supportForFileWithoutHeaderSample(file, args.opts?.languageExtensions)?.id),
  );
  const extracted = await mapLimit(candidates, args.concurrency, async (file) => {
    const support = supportForFileWithoutHeaderSample(file, args.opts?.languageExtensions)!;
    try {
      const prepared = await prepareFileContextForBuild(
        file,
        support,
        args.opts,
        args.workerSetup,
        args.report,
        args.confinedRoot,
        args.projectRoot,
        args.trustedSources?.get(file),
        args.opts?.useBloomFilters ?? true,
      );
      const facts = preparedProjectFileFacts(prepared);
      if (support.id === "csharp") {
        primeCsharpNamespaceFacts(file, facts?.csharpNamespaceFacts ?? null, args.opts?.languageExtensions);
      } else {
        primeJvmFileFacts(file, facts?.jvmFacts ?? null);
      }
      return [file, { prepared }] as const;
    } catch (error) {
      if (isNativeRequiredUnavailableError(error) || isNodeSqliteUnavailableError(error)) throw error;
      if (isConfinedFileReadError(error)) throw error;
      if (support.id === "csharp") primeCsharpNamespaceFacts(file, null, args.opts?.languageExtensions);
      else primeJvmFileFacts(file, null);
      return [file, { error }] as const;
    }
  });
  return new Map<string, ProjectFileExtraction>(extracted);
}

/** Unindexed project-scan candidates use facts-only tasks; indexed files have already primed their facts. */
function installProjectFileFactsReaders(workerSetup: WorkerPoolSetupResult, report: BuildReport | undefined): void {
  if (!workerSetup.pool) return;
  setJvmFileFactsReader(
    async (file, languageId) =>
      (await readProjectFileFactsWithWorker(file, languageId, workerSetup, report))?.jvmFacts ?? null,
  );
  setCsharpNamespaceFactsReader(
    async (file) =>
      (await readProjectFileFactsWithWorker(file, "csharp", workerSetup, report))?.csharpNamespaceFacts ?? null,
  );
}

function isConfinedFileReadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /outside project root|possible path confinement race|changed between verification and open|confined file target/u.test(
      error.message,
    )
  );
}
/** A placeholder module. `parseErrorRanges` stays unset: no parser ran, so its parse state is unknown. */
function createEmptyModuleIndex(file: string): ModuleIndex {
  return { file, exports: [], imports: [], locals: [] };
}

/** A file with no language support: nothing is parsed, so it has no parse errors. */
function unparsedModuleIndex(file: string): ModuleIndex {
  return { ...createEmptyModuleIndex(file), parseErrorRanges: [] };
}

/**
 * A file whose processing failed. Its symbols are missing from the index, so it is flagged as parser-degraded: the flag
 * keeps the analysis summary incomplete, and marks a module that is never written to the module cache, so the project
 * snapshot embeds it instead of leaving its stale disk row to be restored.
 */
function failedModuleIndex(file: string): ModuleIndex {
  return { ...createEmptyModuleIndex(file), parserDegraded: true };
}

/**
 * Declared-container index (container name to declaring files) rebuilt from already-loaded
 * modules. Because `ModuleIndex.declaredContainers` is cached with the module, this reflects
 * unchanged files from cache and changed files from their fresh parse without rereading source.
 */
function declaredContainerIndexFromModules(modules: Iterable<ModuleIndex>): Map<string, string[]> {
  const byName = new Map<string, Set<string>>();
  for (const mod of modules) {
    if (!mod.declaredContainers?.length) continue;
    const file = normalizePath(mod.file);
    for (const name of mod.declaredContainers) {
      let files = byName.get(name);
      if (!files) {
        files = new Set<string>();
        byName.set(name, files);
      }
      files.add(file);
    }
  }
  const index = new Map<string, string[]>();
  for (const [name, files] of byName) {
    index.set(
      name,
      [...files].sort((left, right) => left.localeCompare(right)),
    );
  }
  return index;
}

/** Container names whose declaring-file set differs between two builds. */
function declaredContainerNamesChanged(previous: Map<string, string[]>, next: Map<string, string[]>): Set<string> {
  const changed = new Set<string>();
  for (const name of new Set([...previous.keys(), ...next.keys()])) {
    const previousFiles = previous.get(name) ?? [];
    const nextFiles = next.get(name) ?? [];
    if (previousFiles.length === nextFiles.length && previousFiles.every((file, i) => file === nextFiles[i])) {
      continue;
    }
    changed.add(name);
  }
  return changed;
}

/**
 * Files whose cached edges name a container declaration that changed. These consumers have no
 * content change of their own, so signature and reverse-dependency invalidation cannot see
 * them; the declared-container index has to.
 */
function collectDeclaredContainerConsumers(
  trackedEntries: Record<string, ManifestFileEntry>,
  changedNames: ReadonlySet<string>,
): Set<string> {
  const consumers = new Set<string>();
  if (!changedNames.size) return consumers;
  for (const [file, entry] of Object.entries(trackedEntries)) {
    if (entry.edges.some((edge) => edge.raw !== undefined && changedNames.has(edge.raw))) {
      consumers.add(file);
    }
  }
  return consumers;
}

function manifestDeclaredContainerIndex(manifest: IndexManifest | null): Map<string, string[]> {
  const entries = manifest?.declaredContainers;
  if (!entries) return new Map();
  return new Map(Object.entries(entries));
}

/**
 * Declared C++ modules of added or changed files. The cache cannot supply them.
 * A regex over the source finds them without a parse.
 * Without them, a second file that declares an existing module name goes unnoticed,
 * and the importer keeps its old target.
 */
async function collectCppMissDeclaredContainers(
  files: readonly string[],
  concurrency: number,
  confined?: {
    confinedRoot?: string;
    projectRoot?: string;
    trustedSources?: ReadonlyMap<string, string>;
  },
): Promise<Map<string, string[]>> {
  const byName = new Map<string, Set<string>>();
  await mapLimit([...files], concurrency, async (file) => {
    let source: string | undefined = confined?.trustedSources?.get(file);
    if (source === undefined) {
      try {
        source =
          confined?.confinedRoot && confined?.projectRoot
            ? await readConfinedUtf8File(confined.confinedRoot, confined.projectRoot, file)
            : await fsp.readFile(file, "utf8");
      } catch {
        return;
      }
    }
    for (const name of collectCppDeclaredModules(source)) {
      let bucket = byName.get(name);
      if (!bucket) byName.set(name, (bucket = new Set()));
      bucket.add(normalizePath(file));
    }
  });
  const index = new Map<string, string[]>();
  for (const [name, declaringFiles] of byName) {
    index.set(
      name,
      [...declaringFiles].sort((left, right) => left.localeCompare(right)),
    );
  }
  return index;
}

/** Declared C++ modules in the previous rows of changed files, as module name to declaring files. */
function previousCppDeclaredContainers(previousModules: ReadonlyMap<string, ModuleIndex>): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const [file, mod] of previousModules) mergeDeclaredContainers(byName, file, mod.declaredContainers);
  return byName;
}

/** Fold one file's declared containers into name-to-declaring-files buckets. */
function mergeDeclaredContainers(
  byName: Map<string, Set<string>>,
  file: string,
  declared: readonly string[] | undefined,
): void {
  if (!declared || !declared.length) return;
  const normalized = normalizePath(file);
  for (const name of declared) {
    let bucket = byName.get(name);
    if (!bucket) byName.set(name, (bucket = new Set()));
    bucket.add(normalized);
  }
}

/** Sort name-to-declaring-files buckets into the shape declaredContainerNamesChanged compares. */
function sortedDeclaredContainerIndex(byName: ReadonlyMap<string, ReadonlySet<string>>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [name, files] of byName) {
    index.set(
      name,
      [...files].sort((left, right) => left.localeCompare(right)),
    );
  }
  return index;
}

/** Whether a cached module has an import binding the previous build left unresolved. */
function cachedModuleHasExternalImport(mod: ModuleIndex): boolean {
  return mod.imports.some((binding) => typeof binding.resolved !== "string");
}

/**
 * Gives the C# namespace scan and the JVM package scan the facts a reused module holds, so they parse nothing for
 * that file. They come from the file's own tree and depend on no other file, so the module's matching signature
 * keeps them valid.
 */
function primeReusedFileFacts(file: string, mod: ModuleIndex, opts: BuildOptions | undefined): void {
  if (mod.csharpNamespaceFacts) primeCsharpNamespaceFacts(file, mod.csharpNamespaceFacts, opts?.languageExtensions);
  if (mod.jvmFacts) primeJvmFileFacts(file, mod.jvmFacts);
  if (mod.phpDeclarationNames) {
    primePhpModuleImportNames(file, phpModuleImportNamesFromDeclarations(mod.phpDeclarationNames, mod));
  }
}

/**
 * Files that have a cached row, are not in the build, and no longer exist.
 * A deleted file leaves no cache miss, so a later restoration could look like a hit instead of an addition.
 * The existence probe separates deleted files from files outside the build scope.
 * The manifest path does not need this: the manifest lists the previous files.
 */
async function collectNoManifestDeletedFiles(args: {
  files: readonly string[];
  projectRoot: string;
  opts: BuildOptions | undefined;
  concurrency: number;
}): Promise<Array<{ file: string; languageId: string | undefined; mod: ModuleIndex | null }>> {
  const live = new Set(args.files.map(fileIdentityKey));
  const rows = new Map<string, string>();
  for (const file of listMemoryCachedModuleFiles(args.projectRoot)) rows.set(fileIdentityKey(file), file);
  if ((args.opts?.cache ?? "off") === "disk") {
    const diskFiles = listDiskCachedModuleFiles(args.projectRoot, args.opts);
    if (diskFiles) {
      for (const relative of diskFiles) {
        const file = normalizePath(path.resolve(args.projectRoot, relative));
        // A cache row is persisted data. Ignore a row that names a path outside the project.
        if (!isFilePathWithinRoot(args.projectRoot, file)) continue;
        if (!rows.has(fileIdentityKey(file))) rows.set(fileIdentityKey(file), file);
      }
    }
  }
  const candidates: Array<{ file: string; languageId: string | undefined }> = [];
  for (const [key, file] of rows) {
    if (live.has(key)) continue;
    const languageId = supportForFileWithoutHeaderSample(file, args.opts?.languageExtensions)?.id;
    candidates.push({ file, languageId });
  }
  if (!candidates.length) return [];
  const existence = await probePathExistence(
    candidates.map((candidate) => candidate.file),
    args.concurrency,
  );
  return candidates
    .filter((candidate) => !existence.get(candidate.file))
    .map((candidate) => ({
      file: candidate.file,
      languageId: candidate.languageId,
      mod: peekCachedModule(args.projectRoot, candidate.file, args.opts)?.mod ?? null,
    }));
}

/** The signature a file's module is cached under; undefined when the build has no signature for the file. */
function moduleCacheSignature(args: IndexedFileBuildArgs): (() => Promise<string>) | undefined {
  const sigInfo = args.fileSignatures.get(args.file);
  if (!sigInfo) return undefined;
  return async () =>
    args.cacheEnabled
      ? await moduleCacheSignatureForFile(args.file, sigInfo, args.opts, args.resolverEnvironmentFingerprint)
      : sigInfo.cacheSig;
}

function bloomFilterFromWorker(payload: NativeBloomFilterPayload): BloomFilter {
  return BloomFilter.fromBuffer(Buffer.from(payload.bits), payload.size, payload.hashCount, payload.itemCount);
}

async function finishModuleRecordForBuild(
  args: IndexedFileBuildArgs,
  record: ModuleRecord,
  sup: LanguageSupport,
): Promise<IndexedFileModuleResult> {
  const cacheSignature = moduleCacheSignature(args);
  const finished = await finishModuleRecord(record, {
    file: args.file,
    support: sup,
    projectRoot: args.projectRoot,
    graphOptions: args.graphOptions,
    ...(args.workspaceConfig ? { workspaceConfig: args.workspaceConfig } : {}),
    ...(args.matchPath ? { matchPath: args.matchPath } : {}),
    ...(args.opts?.logLevel ? { logLevel: args.opts.logLevel } : {}),
    ...(args.opts?.languageExtensions ? { languageExtensions: args.opts.languageExtensions } : {}),
    ...(args.report ? { report: args.report } : {}),
    parsedFiles: args.parsedMap,
    jsonDependencies: args.jsonDependencies,
    ...(cacheSignature ? { cacheSignature } : {}),
  });
  return {
    module: finished.module,
    ...(finished.cacheWrite ? { cacheWrite: finished.cacheWrite } : {}),
    graphContext: finished.edgeSource,
  };
}

async function buildIndexedModuleForFile(args: IndexedFileBuildArgs): Promise<IndexedFileModuleResult> {
  const recordTask: ModuleRecordTask | undefined =
    args.moduleRecords && isModuleRecordLanguage(args.support.id)
      ? {
          projectRoot: args.projectRoot,
          dynamicImportHeuristics: !!args.graphOptions.dynamicImportHeuristics,
          ...(args.opts?.logLevel ? { logLevel: args.opts.logLevel } : {}),
        }
      : undefined;
  const prepared =
    args.preparedFile ??
    (await prepareFileContextForBuild(
      args.file,
      args.support,
      args.opts,
      args.workerSetup,
      args.report,
      args.confinedRoot,
      args.projectRoot,
      args.trustedSource,
      !!args.bloomFilterCache,
      args.moduleRecords?.inWorkers ? recordTask : undefined,
    ));
  if (prepared.moduleRecord) {
    if (args.bloomFilterCache && prepared.workerBloomFilter) {
      args.bloomFilterCache.set(args.file, bloomFilterFromWorker(prepared.workerBloomFilter));
    }
    return await finishModuleRecordForBuild(args, prepared.moduleRecord, prepared.sup);
  }
  const { source, sup, nativeQueries, embeddedBlocks } = prepared;
  let tree: SyntaxTreeLike | undefined;
  // Every degradation recorded below also marks the module, including a failed import extraction of the file's source
  // or of one of its embedded blocks. A later build that reuses the module from a cache has no report of this one, and
  // still counts the file.
  let parserDegraded = false;
  // Set when a lookup over other files, not this file's own extraction, left part of its imports unresolved.
  let importLookupIncomplete = false;
  const recordTreeUnavailable = (entry: Parameters<typeof recordParserBackendDegradation>[1]): void => {
    parserDegraded = true;
    recordParserBackendDegradation(args.report, entry);
  };
  const graphOnlyLanguage = isGraphOnlyLanguage(sup.id),
    nativeSourceLimitSkip = prepared.nativeFallbackReason === "sourceTooLarge";

  const extractionTree =
    prepared.projectFactsParse?.parsed?.tree ??
    (prepared.syntaxTree ? new ProjectedSyntaxTree(source, prepared.syntaxTree) : undefined);
  if (extractionTree) {
    const parsedTree = extractionTree;
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
  } else if (!nativeQueries && !graphOnlyLanguage && sup.id !== "sql" && !nativeSourceLimitSkip) {
    const parseAttempt = prepared.projectFactsParse ?? attemptParsePreparedFileContext(prepared);
    const parsed = parseAttempt.parsed;
    if (parsed) {
      tree = parsed.tree;
      setParsedCacheEntry(args.parsedMap, args.file, parsed, args.parsedCacheMaxEntries);
    } else {
      recordTreeUnavailable({
        file: args.file,
        languageId: prepared.sup.id,
        ...(parseAttempt.nativeFallbackReason ? { nativeFallbackReason: parseAttempt.nativeFallbackReason } : {}),
        ...(parseAttempt.nativeError ? { nativeError: parseAttempt.nativeError } : {}),
        ...(parseAttempt.jsError ? { jsError: parseAttempt.jsError } : {}),
      });
    }
  } else if (nativeQueries && !graphOnlyLanguage && sup.id !== "sql") {
    // A native query without a transferred tree can still use the native syntax tree.
    const parseAttempt = prepared.projectFactsParse ?? attemptParsePreparedFileContext(prepared);
    const parsed = parseAttempt.parsed;
    if (parsed) {
      tree = parsed.tree;
      setParsedCacheEntry(args.parsedMap, args.file, parsed, args.parsedCacheMaxEntries);
    } else {
      recordTreeUnavailable({
        file: args.file,
        languageId: sup.id,
        ...(parseAttempt.nativeFallbackReason ? { nativeFallbackReason: parseAttempt.nativeFallbackReason } : {}),
        ...(parseAttempt.nativeError ? { nativeError: parseAttempt.nativeError } : {}),
      });
    }
  }
  if (sup.id === "sql" && !tree) {
    recordTreeUnavailable({
      file: args.file,
      languageId: sup.id,
      ...(prepared.nativeFallbackReason ? { nativeFallbackReason: prepared.nativeFallbackReason } : {}),
      ...(prepared.nativeError ? { nativeError: prepared.nativeError } : {}),
    });
  }

  const jvmLanguageId = isJvmLanguage(sup.id) ? sup.id : undefined;
  const jvmFacts =
    jvmLanguageId && tree ? (prepared.projectFacts?.jvmFacts ?? collectJvmFileFacts(tree, jvmLanguageId)) : undefined;
  const csharpFacts =
    sup.id === "csharp" && tree
      ? (prepared.projectFacts?.csharpNamespaceFacts ?? collectCsharpNamespaceFacts(tree))
      : undefined;
  if (jvmFacts) primeJvmFileFacts(args.file, jvmFacts);
  if (csharpFacts) primeCsharpNamespaceFacts(args.file, csharpFacts, args.opts?.languageExtensions);

  const lacksParserContext = !graphOnlyLanguage && !nativeQueries;

  if (args.bloomFilterCache && !nativeSourceLimitSkip) {
    const filter = prepared.workerBloomFilter
      ? bloomFilterFromWorker(prepared.workerBloomFilter)
      : buildBloomFilterFromSource(source, sup);
    args.bloomFilterCache.set(args.file, filter);
  }

  // A file the main thread parsed is indexed through the same module record a worker would have built. A worker that
  // declined the record decided it from the file's content, so the main thread would decline it as well.
  if (
    recordTask &&
    !prepared.moduleRecordFallback &&
    tree instanceof ProjectedSyntaxTree &&
    !embeddedBlocks &&
    !prepared.nativeFallbackReason &&
    isModuleRecordLanguage(sup.id)
  ) {
    const outcome = await buildModuleRecord({
      ...recordTask,
      file: args.file,
      source,
      support: sup,
      nativeQueries,
      tree,
    });
    if ("record" in outcome) return await finishModuleRecordForBuild(args, outcome.record, sup);
  }

  // A failed extraction leaves this file's imports incomplete, so it marks the module like a missing syntax tree.
  const onDegraded: ImportDegradedHook = (cause) => {
    parserDegraded = true;
    if (cause === "lookup") importLookupIncomplete = true;
  };
  // Single builder so an option added here always reaches both the primary source and
  // every embedded (SFC) block, instead of one path silently missing a future option.
  const sharedImportOptions = {
    graphOptions: args.graphOptions,
    ...(args.workspaceConfig ? { workspaceConfig: args.workspaceConfig } : {}),
    ...(args.matchPath ? { matchPath: args.matchPath } : {}),
    ...(args.opts?.logLevel ? { logLevel: args.opts.logLevel } : {}),
    ...(args.opts?.languageExtensions ? { languageExtensions: args.opts.languageExtensions } : {}),
    ...(args.report ? { report: args.report } : {}),
    parsedFiles: args.parsedMap,
    onDegraded,
  };
  const imports =
    nativeSourceLimitSkip || sup.id === "sql"
      ? []
      : await collectImportsForFile(args.file, args.projectRoot, {
          source,
          sup,
          ...(readsSyntaxTree(sup.id) ? { tree: tree ?? null } : {}),
          ...(nativeQueries !== undefined ? { nativeQueries } : {}),
          ...sharedImportOptions,
        });
  if (!nativeSourceLimitSkip) {
    for (const block of embeddedBlocks ?? []) {
      pushAll(
        imports,
        await collectImportsForFile(args.file, args.projectRoot, {
          source: block.source,
          sup: block.sup,
          ...sharedImportOptions,
        }),
      );
    }
  }
  collectJsonDependencies(imports, args.jsonDependencies);
  let mod: ModuleIndex;
  if (sup.id === "sql") {
    mod = buildSqlModuleIndex(args.file, source);
  } else if (prepared.phpModule) {
    mod = prepared.phpModule;
  } else if (lacksParserContext) {
    mod = { ...createEmptyModuleIndex(args.file), imports };
  } else {
    mod = collectLocalsAndExportsFromSource(args.file, source, sup, imports, {
      ...(tree ? { tree } : {}),
      ...(nativeQueries !== undefined ? { nativeQueries } : {}),
      ...(args.opts?.logLevel ? { logLevel: args.opts.logLevel } : {}),
    });
  }
  mod.imports = imports;
  if (tree instanceof ProjectedSyntaxTree) {
    mod.parseErrorRanges = prepared.phpModule?.parseErrorRanges ?? collectParseErrorRanges(tree);
  } else if (graphOnlyLanguage) mod.parseErrorRanges = [];
  else delete mod.parseErrorRanges;
  const nativeOutcome = preparedNativeOutcome(prepared);
  if (nativeOutcome) mod.nativeOutcome = nativeOutcome;
  if (parserDegraded) mod.parserDegraded = true;
  if (importLookupIncomplete) mod.importLookupIncomplete = true;
  if (sup.id === "cpp") {
    const declaredContainers = collectCppDeclaredModules(source);
    if (declaredContainers.length) mod.declaredContainers = declaredContainers;
  }
  if (csharpFacts) mod.csharpNamespaceFacts = csharpFacts;
  if (jvmFacts) mod.jvmFacts = jvmFacts;
  if (sup.id === "php" && tree && nativeQueries && !mod.phpDeclarationNames) {
    mod.phpDeclarationNames = phpDeclarationImportNames(collectPhpModuleImportNames(mod, { source, tree, sup }));
  }
  if (sup.id === "php" && mod.phpDeclarationNames && mod.parserDegraded) {
    const names = phpModuleImportNamesFromDeclarations(mod.phpDeclarationNames, mod);
    mod.phpDeclarationNames = phpDeclarationImportNames(names);
    primePhpModuleImportNames(args.file, names);
  }
  await resolveCrossModuleSymbolExports(
    args.file,
    mod,
    sup,
    args.projectRoot,
    args.graphOptions,
    args.workspaceConfig,
    args.matchPath,
  );

  const cacheSignature = !prepared.nativeFallbackReason && !lacksParserContext ? moduleCacheSignature(args) : undefined;
  const cacheWrite: PendingModuleCacheWrite | undefined = cacheSignature
    ? { file: args.file, sig: await cacheSignature(), mod }
    : undefined;

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
    parseErrorRanges: [],
    locals: [symbol],
  });
}

function graphEdgeKey(edge: Edge): string {
  return edgeKey(edge, true, fileIdentityKey);
}

function externalEdgeTargetKey(to: Edge["to"]): string {
  return to.type === "file" ? `file:${fileIdentityKey(to.path)}` : `external:${to.name}`;
}

const PRECISE_SPECIFIER_RESOLUTION_LANGUAGES: Record<string, true> = {
  c: true,
  cpp: true,
  js: true,
  jsx: true,
  python: true,
  ts: true,
  tsx: true,
};

async function specifierResolutionChanged(
  file: string,
  entry: ManifestFileEntry,
  projectRoot: string,
  workspaceConfig: WorkspaceConfig | undefined,
  graphOptions: GraphBuildOptions,
  languageExtensions: BuildOptions["languageExtensions"],
  loadMatchPath: (file: string) => Promise<MatchPathFn | undefined>,
  addedFiles: readonly string[],
  addedStemsForLanguage: (languageId: string) => ReadonlySet<string>,
  loadTsconfigPaths: (file: string) => Promise<Record<string, readonly string[]> | undefined>,
): Promise<boolean> {
  const support = supportForFileWithoutHeaderSample(file, languageExtensions);
  if (!support) return false;
  // Declaration languages re-resolve through the extension rule in externalSpecifierMatchesAddedStem,
  // so no filename stems are needed here.
  const addedStems = addedStemsForLanguage(support.id);
  const addedFileLanguageId = (file: string): string | undefined =>
    supportForFileWithoutHeaderSample(file, languageExtensions)?.id;
  const specifierEdges = entry.edges;
  if (!specifierEdges.length) return false;

  const specifierOf = (edge: Edge): string => (edge.to.type === "external" ? edge.raw || edge.to.name : edge.raw);
  const matching: Edge[] = [];
  const needsAlias: Edge[] = [];
  for (const edge of specifierEdges) {
    const specifier = specifierOf(edge);
    if (externalSpecifierMatchesAddedStem(specifier, support.id, addedStems, [], addedFiles, addedFileLanguageId)) {
      matching.push(edge);
      continue;
    }
    const relative = specifier.startsWith(".") || specifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(specifier);
    if ((support.id === "ts" || support.id === "tsx") && specifier && !relative) needsAlias.push(edge);
  }
  if (needsAlias.length) {
    const paths = await loadTsconfigPaths(file);
    if (paths && Object.keys(paths).length) {
      for (const edge of needsAlias) {
        const mapped = tsconfigAliasMappedTails(specifierOf(edge), paths);
        if (
          mapped.length &&
          externalSpecifierMatchesAddedStem(
            specifierOf(edge),
            support.id,
            addedStems,
            mapped,
            addedFiles,
            addedFileLanguageId,
          )
        ) {
          matching.push(edge);
        }
      }
    }
  }
  if (!matching.length) return false;
  // Stylesheet, document, and other unstored per-occurrence inputs cannot be
  // re-resolved from the edge. The caller only reaches this on an add.
  if (!PRECISE_SPECIFIER_RESOLUTION_LANGUAGES[support.id]) return true;
  if (
    (support.id === "c" || support.id === "cpp") &&
    matching.some((edge) => edge.includeForm === undefined && !isCppNamedModuleSpecifier(edge.raw))
  ) {
    return true;
  }

  const matchPath = support.id === "ts" || support.id === "tsx" ? await loadMatchPath(file) : undefined;
  const groups = new Map<string, Edge[]>();
  for (const edge of matching) {
    const key = `${edge.raw}\0${edge.includeForm ?? ""}\0${edge.typeOnly ? 1 : 0}`;
    const group = groups.get(key);
    if (group) group.push(edge);
    else groups.set(key, [edge]);
  }
  for (const group of groups.values()) {
    const sample = group[0]!;
    const resolved = await resolveModuleSpecifierEdges(
      {
        spec: sample.raw,
        ...(sample.typeOnly ? { typeOnly: true } : {}),
        ...(sample.includeForm ? { includeForm: sample.includeForm } : {}),
      },
      {
        support,
        file,
        projectRoot,
        workspaceConfig,
        matchPath,
        resolveNodeModules: !!graphOptions.resolveNodeModules,
        ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
        ...(languageExtensions ? { languageExtensions } : {}),
      },
    );
    const resolvedKeys = (resolved ?? []).map((item) => externalEdgeTargetKey(item.to)).sort();
    const cachedKeys = group.map((edge) => externalEdgeTargetKey(edge.to)).sort();
    if (resolvedKeys.length !== cachedKeys.length) return true;
    for (let index = 0; index < resolvedKeys.length; index += 1) {
      if (resolvedKeys[index] !== cachedKeys[index]) return true;
    }
  }
  return false;
}

async function moduleCacheSignatureForFile(
  file: string,
  sigInfo: FileSignature,
  opts?: BuildOptions,
  resolverEnvironmentFingerprint?: string | null,
): Promise<string> {
  const baseSignature = await cacheSignatureForFile(file, sigInfo);
  const normalizedExtensions = normalizeLanguageExtensions(opts?.languageExtensions);
  const normalizedGraphOptions = normalizeGraphOptions(opts?.graph);
  const resolveNodeModules = normalizedGraphOptions.resolveNodeModules;
  const resolutionHints = normalizedGraphOptions.resolutionHints ?? [];
  if (
    !normalizedExtensions &&
    !resolveNodeModules &&
    !resolutionHints.length &&
    resolverEnvironmentFingerprint === undefined
  ) {
    return baseSignature;
  }
  // Combine via a hash rather than raw concatenation: the disk cache stores this string in a
  // SQLite TEXT column, and node:sqlite's DatabaseSync silently truncates TEXT bind parameters
  // at embedded NUL bytes, so a raw separator character risks the stored and freshly-computed
  // signatures never matching (permanent cache miss) if either baseSignature or the serialized
  // extensions ever contained one. A cached ModuleIndex's ImportBinding.resolved values differ
  // depending on whether resolveNodeModules was on at write time (resolved node_modules targets
  // vs. external), so that state and the environment that produced it must be part of the key.
  // The ordered resolutionHints list is likewise a resolution input: bare-specifier resolution
  // tries hints in order, so both the set and the order (e.g. `one` then `two` vs. reordered)
  // can change which file a specifier resolves to, and must invalidate the cache on any change.
  // Effective TypeScript paths/baseUrl and workspace exports also determine cached import targets.
  const hash = crypto.createHash("sha1");
  hash.update(baseSignature);
  hash.update(JSON.stringify(Object.entries(normalizedExtensions ?? {})));
  hash.update(resolveNodeModules ? "\0resolveNodeModules" : "");
  hash.update(resolutionHints.length ? `\0resolutionHints:${JSON.stringify(resolutionHints)}` : "");
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
  configHash?: { hash: string; error?: string };
  discoveryContext?: ProjectDiscoveryContext;
};

type IndexBuildRunState = {
  normalizedProjectRoot: string;
  report: BuildReport | undefined;
  timings: BuildReport["timings"] | undefined;
  totalStart: number;
  cacheMode: NonNullable<BuildOptions["cache"]>;
  cacheEnabled: boolean;
  graphOptions: GraphBuildOptions;
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
    // Delegated rebuilds mint a fresh run state after the preamble; reuse the caller's
    // origin so totalMs covers the whole wait, matching progress completion.
    totalStart: opts?.progressStartedAt ?? performance.now(),
    cacheMode,
    cacheEnabled: cacheMode !== "off",
    graphOptions,
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

export function emitIndexCheckStart(opts: BuildOptions | undefined, activity: string = "Checking project index"): void {
  opts?.onProgress?.({
    type: "progress",
    phase: "start",
    mode: "check",
    message: activity,
    activity,
    current: 0,
    total: 0,
  });
}

export function emitIndexCheckActivity(
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

function emitIndexBuildActivity(
  opts: BuildOptions | undefined,
  activity: string,
  current: number,
  total: number,
  mode: IndexProgressMode = "build",
): void {
  opts?.onProgress?.({
    type: "progress",
    phase: "update",
    mode,
    message: activity,
    activity,
    current,
    total,
  });
}

/**
 * Names and times a post-parse persistence phase (cache write, manifest, graph finalize,
 * snapshot write) so the interactive spinner shows what is happening instead of freezing at
 * the last "Indexed N/N files" count, and so `--report` exposes each phase's cost.
 */
async function timeIndexBuildPhase<T>(args: {
  opts: BuildOptions | undefined;
  timings: BuildTimingReport | undefined;
  buildStartedAt: number | undefined;
  stepName: string;
  activity: string;
  current: number;
  total: number;
  mode?: IndexProgressMode;
  fn: () => Promise<T> | T;
}): Promise<T> {
  if (args.buildStartedAt !== undefined) {
    emitIndexBuildActivity(args.opts, args.activity, args.current, args.total, args.mode ?? "build");
  }
  const startedAt = performance.now();
  const result = await args.fn();
  recordBuildTimingStep(args.timings, { name: args.stepName, ms: Math.round(performance.now() - startedAt) });
  return result;
}

function createCountedCheckProgress(opts: BuildOptions | undefined, activity: string, total: number): () => void {
  emitIndexCheckActivity(opts, activity, 0, total);
  let completed = 0;
  return () => {
    completed += 1;
    if (completed === total || completed % 100 === 0) {
      emitIndexCheckActivity(opts, activity, completed, total);
    }
  };
}

const TRANSIENT_BUILD_TIMING_STEP_NAMES: Record<string, true> = {
  "git-list": true,
  "git-ignore": true,
  "filesystem-scan": true,
  "cache-probe": true,
  "persist-cache": true,
  "workspace-manifests": true,
  "index-manifest": true,
  "file-identity": true,
  "clear-resolution-caches": true,
  "load-manifest": true,
  "diff-build-options": true,
  "git-head": true,
  "config-hash": true,
  "manifest-transform": true,
  "manifest-write": true,
  "cache-prune": true,
  "metadata-discovery": true,
  finalize: true,
  "snapshot-write": true,
};

/**
 * Clears named step timings and coarse discovery fields left over from a prior build that
 * reused the same `BuildReport` object (for example an MCP session's `buildOptions.report`
 * across `refresh_index` calls), so a reused report never mixes this build's steps with a
 * previous one's.
 */
function resetTransientBuildTimings(timings: BuildTimingReport | undefined): void {
  if (!timings) return;
  delete timings.gitListMs;
  delete timings.filesystemScanMs;
  delete timings.sourceDiscoveryMs;
  delete timings.metadataDiscoveryMs;
  delete timings.cacheProbeMs;
  const remaining = (timings.steps ?? []).filter(
    (step) => !Object.hasOwn(TRANSIENT_BUILD_TIMING_STEP_NAMES, step.name),
  );
  if (remaining.length) {
    timings.steps = remaining;
    return;
  }
  delete timings.steps;
}

function recordBuildTimingStep(timings: BuildTimingReport | undefined, step: { name: string; ms: number }): void {
  if (!timings) return;
  (timings.steps ??= []).push(step);
  if (step.name === "git-list") {
    timings.gitListMs = step.ms;
    return;
  }
  if (step.name === "filesystem-scan") timings.filesystemScanMs = step.ms;
}

async function recordTimedBuildStep<T>(
  timings: BuildTimingReport | undefined,
  name: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const startedAt = performance.now();
  const result = await fn();
  recordBuildTimingStep(timings, { name, ms: Math.round(performance.now() - startedAt) });
  return result;
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
  helperOpts?: Pick<
    BuildIndexHelperOptions,
    "ignoreExistingManifest" | "reportDiscoveryProgress" | "configHash" | "discoveryContext"
  >,
): Promise<ProjectIndex> {
  return buildProjectIndexWithManifestOptions(projectRoot, opts, helperOpts);
}

/**
 * Cached modules to extract again because something they depend on changed.
 * A cached module is keyed by its own content, but its import bindings depend on other files.
 * A module is stale when:
 * - it changed;
 * - an import or re-export target no longer exists;
 * - an added file can satisfy one of its specifiers;
 * - it resolves imports through namespace or package declarations, and a file it depends on changed;
 * - a lookup of its imports over other files could not read one of them (`importLookupIncomplete`). Nothing records
 *   that file when no module covers it, so the file reading again changes no signature, manifest edge, or cache row.
 *
 * With a manifest, the manifest gives the previous files and edges.
 * Without one (a memory cache, or a disk cache that no manifest-writing build has seen),
 * the cached import bindings replace the edges.
 */
async function collectStaleCachedModules(args: {
  files: readonly string[];
  cachedModules: ReadonlyMap<string, { sigInfo: FileSignature; mod: ModuleIndex }>;
  /** Cache misses: files the cache held at another signature, and files it has not seen. */
  cacheMisses: { changed: readonly string[]; added: readonly string[] };
  /** Previous-build modules of changed files, keyed by file, for declaration diffing. */
  previousModules: ReadonlyMap<string, ModuleIndex>;
  /** Changed files whose previous row could not be decoded, so their old declarations are unknown. */
  previousUnavailable: readonly string[];
  /** Current signature of every file in the build. */
  signatures: ReadonlyMap<string, FileSignature>;
  manifestFiles: Record<string, ManifestFileEntry> | null;
  manifest: IndexManifest | null;
  projectRoot: string;
  workspaceConfig: WorkspaceConfig | undefined;
  graphOptions: GraphBuildOptions;
  opts: BuildOptions | undefined;
  loadMatchPathForFile: (file: string) => Promise<MatchPathFn | undefined>;
  concurrency: number;
  confinedRoot?: string | undefined;
  trustedSources?: ReadonlyMap<string, string> | undefined;
}): Promise<{ stale: Set<string>; deletedFiles: string[] }> {
  const { cachedModules, manifestFiles } = args;
  if (!cachedModules.size) return { stale: new Set<string>(), deletedFiles: [] };
  const stale = await cachedModulesWithMissingTargets(cachedModules, args.concurrency);
  for (const [file, { mod }] of cachedModules) {
    if (mod.importLookupIncomplete) stale.add(file);
  }
  const resolvesFromDeclarations = (file: string): boolean =>
    DECLARATION_RESOLVED_IMPORT_LANGUAGES.has(
      supportForFileWithoutHeaderSample(file, args.opts?.languageExtensions)?.id ?? "",
    );
  const loadTsconfigPaths = (importer: string) =>
    loadTsconfigResolutionInputsFor(importer, args.projectRoot, args.opts?.logLevel).then((inputs) => inputs?.paths);
  // The no-manifest path retires confirmed deletions after a full-discovery build.
  const deletedFiles: string[] = [];
  if (manifestFiles) {
    const currentKeys = new Set(args.files.map(fileIdentityKey));
    // A cache miss proves a change, even when a non-strict manifest signature (mtime:size) matches.
    const changed = new Set<string>(args.cacheMisses.changed);
    const added: string[] = [];
    for (const file of args.files) {
      const entry = manifestFiles[file];
      if (!entry) added.push(file);
      const sigInfo = args.signatures.get(file);
      if (!sigInfo) continue;
      const matchesGitSig = !!entry?.gitSig && !!sigInfo.gitSig && entry.gitSig === sigInfo.gitSig;
      if (!entry || !(matchesGitSig || entry.sig === sigInfo.sig)) changed.add(file);
    }
    // Cache hits do not hold the declarations of added or changed files.
    // Add the C++ module declarations of those files before the comparison.
    // Otherwise a second file that declares an existing module name changes nothing,
    // and the importer keeps its old target.
    const nextDeclaredContainers = declaredContainerIndexFromModules(
      [...cachedModules.values()].map((cached) => cached.mod),
    );
    const cppMisses = [...new Set([...added, ...changed])].filter(
      (file) => supportForFileWithoutHeaderSample(file, args.opts?.languageExtensions)?.id === "cpp",
    );
    if (cppMisses.length) {
      const missDeclaredContainers = await collectCppMissDeclaredContainers(cppMisses, args.concurrency, {
        ...(args.confinedRoot ? { confinedRoot: args.confinedRoot, projectRoot: args.projectRoot } : {}),
        ...(args.trustedSources ? { trustedSources: args.trustedSources } : {}),
      });
      for (const [name, declaringFiles] of missDeclaredContainers) {
        const merged = new Set([...(nextDeclaredContainers.get(name) ?? []), ...declaringFiles]);
        nextDeclaredContainers.set(
          name,
          [...merged].sort((left, right) => left.localeCompare(right)),
        );
      }
    }
    const declaredContainerConsumers = collectDeclaredContainerConsumers(
      manifestFiles,
      declaredContainerNamesChanged(manifestDeclaredContainerIndex(args.manifest), nextDeclaredContainers),
    );
    const missingFromBuild = Object.keys(manifestFiles).filter((file) => !currentKeys.has(fileIdentityKey(file)));
    const existence = await probePathExistence(missingFromBuild, args.concurrency);
    const deleted = new Set(missingFromBuild.filter((file) => !existence.get(file)));
    for (const file of [
      ...changed,
      ...collectDeletedTrackedFileDependents(manifestFiles, deleted),
      ...declaredContainerConsumers,
    ]) {
      stale.add(file);
    }
    for (const file of collectTrackedFileDependents(manifestFiles, changed)) {
      if (resolvesFromDeclarations(file)) stale.add(file);
    }
    // A changed or deleted declaration-language file can change which files declare a namespace
    // or package that an importer names. A deleted duplicate can resolve an ambiguous import.
    // Treat these files like added files.
    const resolutionInputs = [...added, ...[...changed, ...deleted].filter((file) => resolvesFromDeclarations(file))];
    if (resolutionInputs.length) {
      const stemsByLanguage = new Map<string, ReadonlySet<string>>();
      const addedStemsForLanguage = (languageId: string): ReadonlySet<string> => {
        let stems = stemsByLanguage.get(languageId);
        if (!stems) stemsByLanguage.set(languageId, (stems = addedResolutionStems(resolutionInputs, languageId)));
        return stems;
      };
      const candidates = [...collectSpecifierEdgeCandidates(manifestFiles, true)].filter(
        (file) => cachedModules.has(file) && !stale.has(file),
      );
      const changedResolution = await mapLimit(candidates, args.concurrency, async (candidate) =>
        specifierResolutionChanged(
          candidate,
          manifestFiles[candidate]!,
          args.projectRoot,
          args.workspaceConfig,
          args.graphOptions,
          args.opts?.languageExtensions,
          args.loadMatchPathForFile,
          resolutionInputs,
          addedStemsForLanguage,
          loadTsconfigPaths,
        ),
      );
      candidates.forEach((candidate, index) => {
        if (changedResolution[index]) stale.add(candidate);
      });
      for (const importer of collectPythonPackageImporters(manifestFiles, added)) stale.add(importer);
    }
  } else {
    const added = [
      ...args.cacheMisses.added,
      ...args.cacheMisses.changed.filter((file) => resolvesFromDeclarations(file)),
    ];
    if (added.length) {
      const stemsByLanguage = new Map<string, ReadonlySet<string>>();
      for (const [file, { mod }] of cachedModules) {
        if (stale.has(file)) continue;
        const languageId = supportForFileWithoutHeaderSample(file, args.opts?.languageExtensions)?.id ?? "default";
        let stems = stemsByLanguage.get(languageId);
        if (!stems) stemsByLanguage.set(languageId, (stems = addedResolutionStems(added, languageId)));
        const tsconfigPaths = languageId === "ts" || languageId === "tsx" ? await loadTsconfigPaths(file) : undefined;
        const addedCanSatisfy = cachedModuleSpecifiers(mod).some((specifier) =>
          externalSpecifierMatchesAddedStem(
            specifier,
            languageId,
            stems,
            tsconfigPaths ? tsconfigAliasMappedTails(specifier, tsconfigPaths) : [],
            added,
            (file) => supportForFileWithoutHeaderSample(file, args.opts?.languageExtensions)?.id,
          ),
        );
        if (addedCanSatisfy) stale.add(file);
      }
      // `from . import mod` targets `__init__.py`, so no specifier names an added `mod.py`.
      // Find these importers through their cached targets.
      const packageImporters = pythonImportersOfPackageInits(
        Array.from(cachedModules, ([file, { mod }]) => [file, cachedModuleTargets(mod)] as const),
        added,
      );
      for (const file of packageImporters) stale.add(file);
    }
    // C++ module specifiers name declarations, not file stems. The stem check cannot see
    // a second declarer, a file that stopped declaring a module, or a deleted declarer.
    // A deleted file leaves no cache miss, so the rows of omitted files are scanned separately.
    // Cache hits cancel out of the comparison. Only stale rows, deleted files, and misses change it.
    const cppPrevious = previousCppDeclaredContainers(args.previousModules);
    const unknownDeclarationLanguages = new Set<string>();
    for (const deleted of await collectNoManifestDeletedFiles({
      files: args.files,
      projectRoot: args.projectRoot,
      opts: args.opts,
      concurrency: args.concurrency,
    })) {
      deletedFiles.push(deleted.file);
      if (deleted.languageId === "cpp" && deleted.mod && deleted.mod.declaredContainers) {
        mergeDeclaredContainers(cppPrevious, deleted.file, deleted.mod.declaredContainers);
      } else if (deleted.languageId && DECLARATION_RESOLVED_IMPORT_LANGUAGES.has(deleted.languageId)) {
        unknownDeclarationLanguages.add(declarationLanguageGroup(deleted.languageId));
      }
    }
    // Some previous declarations are unknown when a payload was evicted,
    // or when the old row of a changed file cannot be decoded.
    // Re-resolve every cached importer of the affected languages.
    // This is rare: eviction starts past the cache limit, where builds miss the cache anyway.
    const unknownDeclarationHistory = new Set<string>();
    if ((args.opts?.cache ?? "off") === "memory" && memoryCacheLostPayloads(args.projectRoot)) {
      for (const languageId of DECLARATION_RESOLVED_IMPORT_LANGUAGES) {
        unknownDeclarationHistory.add(declarationLanguageGroup(languageId));
      }
    }
    // An unmapped `.h` file is C or C++ by its content, so classify with `supportForFile`.
    for (const file of args.previousUnavailable) {
      const languageId = supportForFile(file, args.opts?.languageExtensions)?.id;
      if (languageId && DECLARATION_RESOLVED_IMPORT_LANGUAGES.has(languageId)) {
        unknownDeclarationHistory.add(declarationLanguageGroup(languageId));
      }
    }
    if (unknownDeclarationHistory.size) {
      for (const [file, { mod }] of cachedModules) {
        if (stale.has(file) || !mod.imports.length) continue;
        const languageId = supportForFile(file, args.opts?.languageExtensions)?.id ?? "";
        if (unknownDeclarationHistory.has(declarationLanguageGroup(languageId))) stale.add(file);
      }
    }
    const cppAdded = added.filter(
      (file) => supportForFileWithoutHeaderSample(file, args.opts?.languageExtensions)?.id === "cpp",
    );
    const missDeclaredContainers = cppAdded.length
      ? await collectCppMissDeclaredContainers(cppAdded, args.concurrency, {
          ...(args.confinedRoot ? { confinedRoot: args.confinedRoot, projectRoot: args.projectRoot } : {}),
          ...(args.trustedSources ? { trustedSources: args.trustedSources } : {}),
        })
      : new Map<string, string[]>();
    const changedContainers = declaredContainerNamesChanged(
      sortedDeclaredContainerIndex(cppPrevious),
      missDeclaredContainers,
    );
    if (changedContainers.size || unknownDeclarationLanguages.size) {
      for (const [file, { mod }] of cachedModules) {
        if (stale.has(file)) continue;
        if (
          changedContainers.size &&
          cachedModuleSpecifiers(mod).some((specifier) => changedContainers.has(specifier))
        ) {
          stale.add(file);
          continue;
        }
        if (unknownDeclarationLanguages.size) {
          const languageId = supportForFile(file, args.opts?.languageExtensions)?.id ?? "default";
          const group = declarationLanguageGroup(languageId);
          if (unknownDeclarationLanguages.has(group) && cachedModuleHasExternalImport(mod)) stale.add(file);
        }
      }
    }
    // The cached modules' own targets are the reverse dependencies.
    const reverseDependencies = new Map<string, Set<string>>();
    for (const [file, { mod }] of cachedModules) {
      for (const target of cachedModuleTargets(mod)) {
        const key = fileIdentityKey(target);
        let dependents = reverseDependencies.get(key);
        if (!dependents) reverseDependencies.set(key, (dependents = new Set()));
        dependents.add(file);
      }
    }
    const queue = args.cacheMisses.changed.map(fileIdentityKey);
    const enqueued = new Set(queue);
    for (let head = 0; head < queue.length; head += 1) {
      for (const dependent of reverseDependencies.get(queue[head]!) ?? []) {
        if (resolvesFromDeclarations(dependent)) stale.add(dependent);
        const key = fileIdentityKey(dependent);
        if (enqueued.has(key)) continue;
        enqueued.add(key);
        queue.push(key);
      }
    }
  }
  // A package star depends on every package file, not just its representative edge. A type
  // wildcard (`import p.C.*` naming class `p.C`) turns into a package star once package `p.C` exists.
  const isJvmFile = (file: string): boolean => {
    const languageId = supportForFileWithoutHeaderSample(file, args.opts?.languageExtensions)?.id;
    return languageId === "java" || languageId === "kotlin";
  };
  const dependsOnJvmPackage = (imp: ImportBinding): boolean =>
    imp.kind === "star" && (!!imp.jvmPackageFiles || !!imp.jvmTypeWildcardName || typeof imp.resolved !== "string");
  if (args.cacheMisses.added.some(isJvmFile) || args.cacheMisses.changed.some(isJvmFile)) {
    const packageImporters: Array<readonly [string, ModuleIndex]> = [];
    for (const [file, cached] of cachedModules) {
      if (stale.has(file) || !isJvmFile(file)) continue;
      if (cached.mod.imports.some(dependsOnJvmPackage)) packageImporters.push([file, cached.mod]);
    }
    const changed = await mapLimit(packageImporters, args.concurrency, async ([file, mod]) => {
      for (const imp of mod.imports) {
        if (imp.kind !== "star" || !dependsOnJvmPackage(imp)) continue;
        const current = await resolveJvmPackageImportPaths(args.projectRoot, imp.from, file);
        const previous = imp.jvmPackageFiles ?? [];
        if (
          current.length !== previous.length ||
          current.some((target, index) => fileIdentityKey(target) !== fileIdentityKey(previous[index]!))
        ) {
          return true;
        }
      }
      return false;
    });
    packageImporters.forEach(([file], index) => {
      if (changed[index]) stale.add(file);
    });
  }
  return { stale, deletedFiles };
}

/** Files a cached module depends on, including every JVM wildcard package file. */
function cachedModuleTargets(mod: ModuleIndex): string[] {
  const targets: string[] = [];
  for (const binding of mod.imports) {
    if (typeof binding.resolved === "string") targets.push(binding.resolved);
    if (binding.kind !== "star" || !binding.jvmPackageFiles) continue;
    for (const file of binding.jvmPackageFiles) {
      if (file !== binding.resolved) targets.push(file);
    }
  }
  for (const entry of mod.exports) {
    if (entry.type === "local" || !entry.moduleSpecifier || entry.fromModule === entry.moduleSpecifier) continue;
    targets.push(entry.fromModule);
  }
  return targets;
}

/** Specifiers a cached module wrote: import sources and re-export sources. */
function cachedModuleSpecifiers(mod: ModuleIndex): string[] {
  const specifiers = mod.imports.map((binding) => binding.from);
  for (const entry of mod.exports) {
    if (entry.type !== "local") specifiers.push(entry.moduleSpecifier ?? entry.fromModule);
  }
  return specifiers;
}

/** Cached modules with a resolved import or re-export target that no longer exists. */
async function cachedModulesWithMissingTargets(
  cachedModules: ReadonlyMap<string, { mod: ModuleIndex }>,
  concurrency: number,
): Promise<Set<string>> {
  const targetsByFile = new Map<string, string[]>();
  for (const [file, { mod }] of cachedModules) {
    const targets = cachedModuleTargets(mod);
    if (targets.length) targetsByFile.set(file, targets);
  }
  const targetExistence = await probePathExistence([...new Set([...targetsByFile.values()].flat())], concurrency);
  const missing = new Set<string>();
  for (const [file, targets] of targetsByFile) {
    if (targets.some((target) => !targetExistence.get(target))) missing.add(file);
  }
  return missing;
}

/** Resolution probes read one file system snapshot per build: `runWithProbeCache` gives the build its own cache. */
function buildIndexFromFileListShared(
  projectRoot: string,
  rawFiles: readonly string[],
  opts?: BuildOptions,
  helperOpts?: BuildIndexHelperOptions,
): Promise<ProjectIndex> {
  return runWithProbeCache(() => buildIndexFromFileListInProbeCache(projectRoot, rawFiles, opts, helperOpts));
}

async function buildIndexFromFileListInProbeCache(
  projectRoot: string,
  rawFiles: readonly string[],
  opts?: BuildOptions,
  helperOpts?: BuildIndexHelperOptions,
): Promise<ProjectIndex> {
  assertNativeRequiredAvailable();
  clearResolutionCaches();
  await initializeFileIdentityCaseSensitivity(projectRoot);
  const { normalizedProjectRoot, report, timings, totalStart, cacheEnabled, graphOptions } = createIndexBuildRunState(
    projectRoot,
    opts,
  );
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
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);
  let resolverEnvironmentFingerprint: string | null | undefined;
  let resolverEnvironmentMatchesManifest = true;
  if (cacheEnabled) {
    resolverEnvironmentFingerprint = await computeResolverEnvironmentFingerprint(
      projectRoot,
      normalizedFiles,
      opts ?? {},
      workspaceConfig,
    );
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
  const moduleCacheAvailable = opts?.cache !== "disk" || diskModuleCacheExists(projectRoot, opts);
  const shouldReportFileCacheCheck = Boolean(helperOpts?.reportDiscoveryProgress);
  const reportFileCacheCheck = shouldReportFileCacheCheck
    ? createCountedCheckProgress(opts, "Checking file cache", normalizedFiles.length)
    : () => undefined;
  const cacheProbeStart = performance.now();
  const evictionSerialAtStart = memoryCacheEvictionSerial();
  const gitAvailable = await isGitRepo(projectRoot, helperOpts?.discoveryContext?.git);
  const needsPersistentSignatures = cacheEnabled || useManifest;
  const useGitSignatures = gitAvailable && needsPersistentSignatures;
  const gitSigMap = useGitSignatures
    ? await getGitBlobHashes(projectRoot, normalizedFiles, {
        gitAvailable,
        ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
        ...(opts?.cacheStrict ? { strict: true } : {}),
      })
    : new Map<string, string>();
  const signatureStrict = needsPersistentSignatures ? opts?.cacheStrict : false;
  const conc = edgeProbeConcurrency;
  const languageExtensions = normalizeLanguageExtensions(opts?.languageExtensions);
  const sqlFiles = normalizedFiles
    .filter((file) => isSqlFilePath(file, languageExtensions))
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
    if (!isSqlFilePath(file, opts?.languageExtensions)) return false;
    if (!cachedEdgesEntry || !sqlCorpusSig || cachedEdgesEntry.sqlCorpusSig !== sqlCorpusSig) return true;
    const matchesGitSig = !!sigInfo.gitSig && !!cachedEdgesEntry.gitSig && cachedEdgesEntry.gitSig === sigInfo.gitSig;
    return !(matchesGitSig || cachedEdgesEntry.sig === sigInfo.sig);
  };
  const jsonDependencies = new Map<string, string>();
  type ModuleCacheProbe =
    | { sigInfo: FileSignature; mod: ModuleIndex | null; previouslyCached: boolean; staleMod: ModuleIndex | null }
    | { error: unknown };
  // Cache lookup determines the work a full build will actually parse. Complete that cheap phase
  // before starting Piscina, so a warm build does not bootstrap workers and partial hits bound
  // the pool to real parse misses rather than the input file list.
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
        const loaded = canReuseModuleCache
          ? loadModuleFromCache(projectRoot, file, cacheSig, opts, report, moduleCacheAvailable)
          : { mod: null, previouslyCached: false, staleMod: null };
        return [file, { sigInfo, ...loaded }] as const;
      } catch (error) {
        return [file, { error }] as const;
      } finally {
        reportFileCacheCheck();
      }
    }),
  );
  if (timings) {
    const cacheProbeMs = Math.round(performance.now() - cacheProbeStart);
    timings.cacheProbeMs = cacheProbeMs;
    recordBuildTimingStep(timings, { name: "cache-probe", ms: cacheProbeMs });
  }
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
  let workerSetup = emptyWorkerPoolSetup();
  try {
    const initialCacheMisses = Array.from(cacheProbes, ([file, probe]) =>
      !("error" in probe) && !probe.mod ? file : null,
    ).filter((file): file is string => file !== null);
    for (const [file, probe] of cacheProbes) {
      if (!("error" in probe) && probe.mod) primeReusedFileFacts(file, probe.mod, opts);
    }
    const hasProjectFactMisses = initialCacheMisses.some((file) =>
      readsSyntaxTree(supportForFileWithoutHeaderSample(file, opts?.languageExtensions)?.id),
    );
    let projectFileExtractions = new Map<string, ProjectFileExtraction>();
    let projectExtractionMs = 0;
    let projectExtractionStartedAt: number | undefined;
    if (hasProjectFactMisses) {
      workerSetup = await setupWorkerPool(
        opts,
        countNativeWorkerEligibleFiles(initialCacheMisses, opts?.languageExtensions),
      );
      installProjectFileFactsReaders(workerSetup, report);
      projectExtractionStartedAt = performance.now();
      emitIndexLifecycleProgress(opts, "start", "build", normalizedFiles.length);
      projectFileExtractions = await extractProjectFilesBeforeResolution({
        files: initialCacheMisses,
        opts,
        report,
        workerSetup,
        concurrency: conc,
        projectRoot,
        ...(confinedRoot ? { confinedRoot, trustedSources } : {}),
      });
      projectExtractionMs = performance.now() - projectExtractionStartedAt;
    }
    const preparePhpFile = installPhpProjectFileReader({
      files: normalizedFiles,
      opts,
      workerSetup: () => workerSetup,
      report,
      projectRoot,
      ...(confinedRoot ? { confinedRoot, trustedSources } : {}),
    });
    let retiredDeletionFiles: string[] = [];
    // Set when a stale importer row could not be deleted. The build then keeps its previous disk
    // state (manifest, snapshot, deletion evidence), so the next build finds the same staleness.
    let staleRowRemovalFailed = false;
    if (cacheEnabled) {
      const cachedModules = new Map<string, { sigInfo: FileSignature; mod: ModuleIndex }>();
      const cacheMissesByState = { changed: [] as string[], added: [] as string[] };
      // The stale rows of changed files hold the previous declarations.
      // Deleted files leave no miss. The build finds their rows separately.
      const previousModules = new Map<string, ModuleIndex>();
      const previousUnavailable: string[] = [];
      for (const [file, probe] of cacheProbes) {
        if ("error" in probe) continue;
        if (probe.mod) cachedModules.set(file, { sigInfo: probe.sigInfo, mod: probe.mod });
        else if (probe.previouslyCached) {
          cacheMissesByState.changed.push(file);
          if (probe.staleMod) previousModules.set(file, probe.staleMod);
          else previousUnavailable.push(file);
        } else cacheMissesByState.added.push(file);
      }
      const { stale: staleCachedModules, deletedFiles: retiredDeletions } = await collectStaleCachedModules({
        files: normalizedFiles,
        cachedModules,
        cacheMisses: cacheMissesByState,
        previousModules,
        previousUnavailable,
        signatures: new Map(
          Array.from(cacheProbes, ([file, probe]) =>
            "error" in probe ? null : ([file, probe.sigInfo] as const),
          ).filter((entry): entry is readonly [string, FileSignature] => entry !== null),
        ),
        manifestFiles: manifest ? manifestFiles : null,
        manifest,
        projectRoot,
        workspaceConfig,
        graphOptions,
        opts,
        loadMatchPathForFile,
        concurrency: conc,
        ...(confinedRoot ? { confinedRoot, trustedSources } : {}),
      });
      retiredDeletionFiles = retiredDeletions;
      // A stale importer's row still matches its source signature.
      // If the rebuild or the cache write fails, a later build would reuse the row. Delete it now.
      staleRowRemovalFailed = !removeModulesFromCache(
        projectRoot,
        [...staleCachedModules].filter((file) => cachedModules.has(file)),
        opts,
      );
      for (const file of staleCachedModules) {
        const probe = cacheProbes.get(file);
        if (probe && !("error" in probe)) cacheProbes.set(file, { ...probe, mod: null });
        cachedGraphEntries?.delete(file);
      }
    }
    const cacheMisses = Array.from(cacheProbes, ([file, probe]) =>
      !("error" in probe) && !probe.mod ? file : null,
    ).filter((file): file is string => file !== null);
    if (!workerSetup.pool) {
      workerSetup = await setupWorkerPool(opts, countNativeWorkerEligibleFiles(cacheMisses, opts?.languageExtensions));
    }
    installProjectFileFactsReaders(workerSetup, report);
    // A worker that builds a file's module record keeps the file's syntax tree. Count only misses that can retain a
    // parsed tree; unsupported and graph-only files cannot use the parsed-file cache.
    let parsedCacheMisses = 0;
    if (opts?.keepParsed) {
      for (const file of cacheMisses) {
        const support = supportForFileWithoutHeaderSample(file, opts.languageExtensions);
        if (support && !isGraphOnlyLanguage(support.id)) parsedCacheMisses += 1;
      }
    }
    const moduleRecords: ModuleRecordPolicy = {
      inWorkers: !opts?.keepParsed || parsedCacheMisses > parsedCacheMaxEntries(opts),
    };
    // With module records, twice the pool's files in flight keep workers busy while the main thread finishes the
    // others. An explicit `threads` keeps its own limit, even when smaller than the worker pool.
    const threadsRequested = Number(opts?.threads || 0) > 0;
    const parseConcurrency = workerSetup.pool && !threadsRequested ? 2 * (workerSetup.report?.threads ?? 0) : conc;
    const useBloomFilters = opts?.useBloomFilters ?? true;
    const bloomFilterCache = useBloomFilters
      ? new (await import("../util/bloom-filter.js")).BloomFilterCache()
      : undefined;
    const persistedBloomFilters = bloomFilterCache
      ? await tryLoadPersistedBloomFilters(projectRoot, opts, report)
      : null;
    const parsedMap = new Map<string, ParsedFileContext>();
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
    let buildStartedAt: number | undefined = projectExtractionStartedAt;
    const ensureBuildProgressStarted = (): void => {
      if (buildStartedAt !== undefined) return;
      buildStartedAt = performance.now();
      emitIndexLifecycleProgress(opts, "start", "build", totalFiles);
    };
    if (cacheMisses.length) ensureBuildProgressStarted();
    const fileResults = await mapLimit(normalizedFiles, parseConcurrency, async (file) => {
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
            resolveNodeModules: !!graphOptions.resolveNodeModules,
            dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
            ...(opts?.languageExtensions ? { languageExtensions: opts.languageExtensions } : {}),
            ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
            ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
            fileSignature: sigInfo,
            ...(sqlCorpusSig ? { sqlCorpusSig } : {}),
            ...(cachedEdgesEntry ? { cachedFileEdges: cachedEdgesEntry } : {}),
            ...(manifest?.projectRoot ? { cachedFileEdgesProjectRoot: manifest.projectRoot } : {}),
            ...(onFileEdges ? { onFileEdges } : {}),
            allFiles: normalizedFiles,
            parsedFiles: parsedMap,
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
        if (!support) return [file, unparsedModuleIndex(file), [], undefined] as const;
        ensureBuildProgressStarted();
        let graphContext: FileEdgeSource | undefined;
        let cacheWrite: PendingModuleCacheWrite | undefined;
        const matchPath = support.id === "ts" || support.id === "tsx" ? await loadMatchPathForFile(file) : undefined;
        if (!mod) {
          const extraction = projectFileExtractions.get(file);
          projectFileExtractions.delete(file);
          if (extraction && "error" in extraction) throw extraction.error;
          let preparedFile = extraction && "prepared" in extraction ? extraction.prepared : undefined;
          if (support.id === "php") preparedFile = await preparePhpFile(file);
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
            fileSignatures,
            cacheEnabled,
            ...(confinedRoot ? { confinedRoot, trustedSource: trustedSources?.get(file) } : {}),
            moduleRecords,
            ...(preparedFile ? { preparedFile } : {}),
          });
          mod = built.module;
          graphContext = built.graphContext;
          cacheWrite = built.cacheWrite;
        } else {
          collectJsonDependencies(mod.imports, jsonDependencies);
        }
        edges = await collectEdgesForFile(file, projectRoot, workspaceConfig, {
          ...(graphContext ? { parsed: graphContext } : {}),
          resolveNodeModules: !!graphOptions.resolveNodeModules,
          dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
          ...(opts?.languageExtensions ? { languageExtensions: opts.languageExtensions } : {}),
          ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
          ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
          fileSignature: sigInfo,
          ...(sqlCorpusSig ? { sqlCorpusSig } : {}),
          ...(cachedEdgesEntry ? { cachedFileEdges: cachedEdgesEntry } : {}),
          ...(manifest?.projectRoot ? { cachedFileEdgesProjectRoot: manifest.projectRoot } : {}),
          ...(onFileEdges ? { onFileEdges } : {}),
          allFiles: normalizedFiles,
          parsedFiles: parsedMap,
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
        return [file, failedModuleIndex(file), []] as const;
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
    if (timings) timings.parseMs = Math.round(projectExtractionMs + performance.now() - parseStart);
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
      if (opts?.cache === "disk") {
        await timeIndexBuildPhase({
          opts,
          timings,
          buildStartedAt,
          stepName: "persist-cache",
          activity: "Writing disk cache",
          current: totalFiles,
          total: totalFiles,
          fn: () => writeModulesToCache(projectRoot, pendingCacheWrites, opts),
        });
      } else {
        writeModulesToCache(projectRoot, pendingCacheWrites, opts);
      }
    }
    // A full-discovery build re-resolved every importer and wrote its modules back.
    // Clear the eviction state, unless another payload was evicted during the build.
    if (opts?.cache === "memory" && projectFiles !== undefined) {
      settleMemoryCacheEvictions(projectRoot, evictionSerialAtStart);
    }
    // Retire confirmed-deleted rows so restored files count as additions and re-resolve their importers.
    // Only a full-discovery build does this. A build over a file list can omit importers that still need the deletion.
    if (!manifest && projectFiles !== undefined && retiredDeletionFiles.length && !staleRowRemovalFailed) {
      removeModulesFromCache(projectRoot, retiredDeletionFiles, opts);
    }
    const workspaceManifestEdges = await timeIndexBuildPhase({
      opts,
      timings,
      buildStartedAt,
      stepName: "workspace-manifests",
      activity: "Resolving workspace manifests",
      current: totalFiles,
      total: totalFiles,
      fn: () =>
        collectWorkspaceManifestDependencyEdges(
          projectRoot,
          normalizedFiles.filter((file) => path.basename(file) === "package.json"),
          opts?.discovery,
          opts?.logLevel,
        ),
    });
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
      // The next incremental build reads each file's public surface to decide which importers to extract again.
      for (const [file, entry] of manifestEntries) {
        const mod = modules.get(fileIdentityKey(file));
        const surface = mod ? publicSurfaceSignature(file, mod, projectRoot, opts?.languageExtensions) : undefined;
        if (surface !== undefined) manifestEntries.set(file, { ...entry, surface });
      }
    }
    if (manifestEntries && !staleRowRemovalFailed) {
      await timeIndexBuildPhase({
        opts,
        timings,
        buildStartedAt,
        stepName: "index-manifest",
        activity: "Writing index manifest",
        current: totalFiles,
        total: totalFiles,
        fn: () =>
          writeIndexManifestSnapshot({
            projectRoot,
            opts,
            graphOptions,
            ...(resolverEnvironmentFingerprint ? { resolverEnvironmentFingerprint } : {}),
            files: manifestEntries,
            timings,
            manifestReport: report?.manifest,
            declaredContainers: declaredContainerIndexFromModules(modules.values()),
            ...(helperOpts?.configHash ? { configHash: helperOpts.configHash } : {}),
            ...(helperOpts?.discoveryContext ? { discoveryContext: helperOpts.discoveryContext } : {}),
            ...(helperOpts?.transientFiles !== undefined ? { transientFiles: helperOpts.transientFiles } : {}),
            ...(helperOpts?.symlinkDirectories !== undefined
              ? { symlinkDirectories: helperOpts.symlinkDirectories }
              : {}),
          }),
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
    const discoveredInsideFinalize = projectFiles === undefined;
    const finalizeStartedAt = performance.now();
    if (buildStartedAt !== undefined) {
      emitIndexBuildActivity(opts, "Finalizing project graph", totalFiles, totalFiles);
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
      ...(helperOpts?.discoveryContext ? { discoveryContext: helperOpts.discoveryContext } : {}),
      buildReport: report,
      manifestEntries: indexManifestEntries,
    });
    if (timings) {
      const elapsed = Math.round(performance.now() - finalizeStartedAt);
      const discoveryMs = discoveredInsideFinalize ? (timings.metadataDiscoveryMs ?? 0) : 0;
      const finalizeMs = discoveredInsideFinalize ? Math.max(0, elapsed - discoveryMs) : elapsed;
      recordBuildTimingStep(timings, { name: "finalize", ms: finalizeMs });
    }
    if (manifestEntries && !staleRowRemovalFailed) {
      await timeIndexBuildPhase({
        opts,
        timings,
        buildStartedAt,
        stepName: "snapshot-write",
        activity: "Writing project snapshot",
        current: totalFiles,
        total: totalFiles,
        fn: () =>
          writeProjectIndexSnapshot(
            projectRoot,
            opts,
            index,
            projectSnapshotFilesSignature(manifestEntries, projectRoot),
          ),
      });
    }
    if (buildStartedAt !== undefined) {
      // Report the whole operation the caller waited on. Discovery runs before the first
      // file is processed - inside this build for full discovery, and in the agent session
      // for lifecycle and agent commands - so timing from `buildStartedAt` alone reported a
      // fraction of the elapsed time and made a slow discovery look free.
      const progressStartedAt = opts?.progressStartedAt ?? buildStartedAt;
      emitIndexLifecycleProgress(opts, "complete", "build", index.byFile.size, performance.now() - progressStartedAt);
    }
    return index;
  } finally {
    setJvmFileFactsReader(undefined);
    setCsharpNamespaceFactsReader(undefined);
    setPhpModuleImportNamesReader(undefined);
    await teardownWorkerPool(workerSetup, report);
  }
}

async function buildProjectIndexWithManifestOptions(
  projectRoot: string,
  opts?: FullDiscoveryBuildOptions,
  helperOpts?: Pick<
    BuildIndexHelperOptions,
    "ignoreExistingManifest" | "reportDiscoveryProgress" | "configHash" | "discoveryContext"
  >,
): Promise<ProjectIndex> {
  assertNativeRequiredAvailable();
  const timings = opts?.report ? (opts.report.timings ??= {}) : undefined;
  const discoveryContext = helperOpts?.discoveryContext;
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
      !helperOpts?.ignoreExistingManifest && !wantsMaxSymlinkCorrectness && useDiskCache
        ? await loadManifest(projectRoot, opts)
        : null;
    const rootMtime = symlinkHintManifest ? (await fsp.stat(projectRoot)).mtimeMs : undefined;
    const symlinkHintIsFresh =
      symlinkHintManifest?.symlinkDirectoriesRootMtimeMs !== undefined &&
      rootMtime === symlinkHintManifest.symlinkDirectoriesRootMtimeMs;
    if (!helperOpts?.reportDiscoveryProgress && !symlinkHintIsFresh) {
      emitIndexCheckStart(opts, "Discovering source files");
    }
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
    const onDiscoveryTiming = timings
      ? (step: { name: string; ms: number }) => recordBuildTimingStep(timings, step)
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
        ...(onDiscoveryTiming ? { onDiscoveryTiming } : {}),
        ...(discoveryContext ? { discoveryContext } : {}),
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
      ...(onDiscoveryTiming ? { onDiscoveryTiming } : {}),
      ...(discoveryContext ? { discoveryContext } : {}),
    });
    if (timings) timings.metadataDiscoveryMs = Math.round(performance.now() - metadataDiscoveryStart);
    return await buildIndexFromFileListShared(projectRoot, files, opts, {
      manifestMode: useDiskCache ? "read-write" : "off",
      warnNoFilesMessage: `Warning: No files found in project root: ${projectRoot}. Check codegraph.config.json globs and CLI --include-glob/--ignore-glob filters. Diagnostic: codegraph doctor`,
      ...(helperOpts?.ignoreExistingManifest ? { ignoreExistingManifest: true } : {}),
      ...(helperOpts?.reportDiscoveryProgress ? { reportDiscoveryProgress: true } : {}),
      ...(helperOpts?.configHash ? { configHash: helperOpts.configHash } : {}),
      ...(discoveryContext ? { discoveryContext } : {}),
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
 *
 * Progress `complete` events report elapsed time from the start of this call, including
 * discovery, so a caller rendering progress reports the wait the user observed.
 */
export async function buildProjectIndex(projectRoot: string, opts?: BuildOptions): Promise<ProjectIndex> {
  const progressStartedAt = opts?.progressStartedAt ?? performance.now();
  const timings = opts?.report ? (opts.report.timings ??= {}) : undefined;
  resetTransientBuildTimings(timings);
  return buildProjectIndexWithManifestOptions(
    projectRoot,
    {
      ...opts,
      progressStartedAt,
    },
    { discoveryContext: createProjectDiscoveryContext(projectRoot) },
  );
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
  rawOpts?: BuildOptions,
): Promise<ProjectIndex> {
  assertNativeRequiredAvailable();
  // Discovery, manifest loading, and cache checks all precede file processing, so stamp the
  // operation origin here and let the completion event report the caller's whole wait.
  const opts: BuildOptions = { ...rawOpts, progressStartedAt: rawOpts?.progressStartedAt ?? performance.now() };
  // A caller can reuse one BuildReport across repeated calls here, the same way an MCP
  // session reuses `buildOptions.report`, so clear the prior call's transient steps.
  const timings = opts.report ? (opts.report.timings ??= {}) : undefined;
  resetTransientBuildTimings(timings);
  try {
    const useDiskCache = (opts?.cache ?? "off") === "disk";
    const normalizedInputFiles = await normalizeIndexedFileInputsWithinRoot(projectRoot, inputFiles, "Index file");

    return await buildIndexFromFileListShared(projectRoot, normalizedInputFiles, opts, {
      manifestMode: useDiskCache ? "read-only" : "off",
      warnNoFilesMessage: `Warning: No files provided for indexing in ${projectRoot}. Check the explicit file list and include/ignore filters. Diagnostic: codegraph doctor`,
      confineReads: true,
      discoveryContext: createProjectDiscoveryContext(projectRoot),
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
  helperOpts?: Pick<BuildIndexHelperOptions, "discoveryContext">,
): Promise<ProjectIndex> {
  try {
    const useDiskCache = (opts?.cache ?? "off") === "disk";
    return await buildIndexFromFileListShared(projectRoot, [...scopeFiles], opts, {
      manifestMode: useDiskCache ? "read-only" : "off",
      ...(helperOpts?.discoveryContext ? { discoveryContext: helperOpts.discoveryContext } : {}),
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
export function buildProjectIndexIncremental(
  projectRoot: string,
  rawOpts?: IncrementalBuildOptions,
): Promise<ProjectIndex> {
  return runWithProbeCache(() => buildProjectIndexIncrementalInProbeCache(projectRoot, rawOpts));
}

async function buildProjectIndexIncrementalInProbeCache(
  projectRoot: string,
  rawOpts?: IncrementalBuildOptions,
): Promise<ProjectIndex> {
  assertNativeRequiredAvailable();
  const opts: IncrementalBuildOptions = {
    ...rawOpts,
    progressStartedAt: rawOpts?.progressStartedAt ?? performance.now(),
  };
  const discoveryContext = opts.discoveryContext ?? createProjectDiscoveryContext(projectRoot);
  const discoveryTimings = opts.report ? (opts.report.timings ??= {}) : undefined;
  resetTransientBuildTimings(discoveryTimings);
  await recordTimedBuildStep(discoveryTimings, "file-identity", () =>
    initializeFileIdentityCaseSensitivity(projectRoot),
  );
  await recordTimedBuildStep(discoveryTimings, "clear-resolution-caches", () => {
    clearResolutionCaches();
  });
  const graphOptions = normalizeGraphOptions(opts?.graph);
  const { normalizedProjectRoot, report, timings, totalStart, cacheMode, cacheEnabled } = createIndexBuildRunState(
    projectRoot,
    opts,
    graphOptions,
  );
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
      return await buildDeclaredScopeIndex(projectRoot, declaredScope, opts, { discoveryContext });
    }
    if (cacheMode !== "disk") {
      if (declaredScope) {
        return await buildDeclaredScopeIndex(projectRoot, declaredScope, opts, { discoveryContext });
      }
      return await buildProjectIndexFromExport(projectRoot, opts, { ignoreExistingManifest: true, discoveryContext });
    }
    startCheckProgress();
    const manifestStart = performance.now();
    const manifest = await recordTimedBuildStep(timings, "load-manifest", () =>
      loadManifest(projectRoot, opts, report),
    );
    if (timings) timings.manifestMs = Math.round(performance.now() - manifestStart);
    const manifestUsed = !!manifest;
    const manifestReport = initManifestReport(report, manifestUsed, false);
    if (manifestReport && !manifestUsed) manifestReport.reason = "missing";
    const optionDiffs = await recordTimedBuildStep(timings, "diff-build-options", () =>
      diffBuildOptions(manifest?.buildOptions, opts),
    );
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
    const currentConfigHashResult = await recordTimedBuildStep(timings, "config-hash", () =>
      computeConfigHash(projectRoot, opts?.logLevel, discoveryContext, {
        onDiscoveryProgress: (progress) =>
          emitIndexCheckActivity(opts, progress.activity, progress.current, progress.total),
        ...(timings
          ? { onDiscoveryTiming: (step: { name: string; ms: number }) => recordBuildTimingStep(timings, step) }
          : {}),
      }),
    );
    const currentConfigHash = recordConfigHashResult(manifestReport, currentConfigHashResult, opts?.logLevel);
    const configChanged =
      !!currentConfigHashResult.error || !manifest?.configHash || currentConfigHash !== manifest.configHash;
    const workspaceConfig = manifest ? await loadWorkspaceConfig(projectRoot) : undefined;
    let resolverEnvironmentFingerprint: string | null | undefined;
    let resolverEnvironmentMatchesManifest = true;
    if (manifest) {
      resolverEnvironmentFingerprint = await computeResolverEnvironmentFingerprint(
        projectRoot,
        Object.keys(manifest.files),
        opts,
        workspaceConfig,
      );
      resolverEnvironmentMatchesManifest =
        resolverEnvironmentFingerprint !== null &&
        manifest.resolverEnvironmentFingerprint === resolverEnvironmentFingerprint;
    }
    const requiresFullRebuild = optionDiffs.some(
      (diff) =>
        diff === "discovery" ||
        diff === "native" ||
        diff === "implementation" ||
        diff === "coreAlgorithm" ||
        diff === "languageExtensions",
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
        configHash: currentConfigHashResult,
        discoveryContext,
      });
    }
    const gitAvailable = await isGitRepo(projectRoot, discoveryContext.git);
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
              includeRenameSources: true,
              discoveryCache: discoveryContext.git,
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
          configHash: currentConfigHashResult,
          discoveryContext,
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
          configHash: currentConfigHashResult,
          discoveryContext,
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
    let gitManifestCandidates: string[] = [];
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
            listUntrackedProjectFiles(projectRoot, opts?.discovery, gitAvailable, discoveryContext),
          );
        }
        if (!canReuseReconciliation || opts?.reconciledWorkingTreeDiffFiles === undefined) {
          gitManifestCandidates = await measureSourceDiscovery(() =>
            collectGitManifestChangeCandidates(projectRoot, trackedEntries, discoveryContext, manifest.gitDirtyFiles),
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
          "Warning: Failed to reconcile project files via Git; rebuilding full index.",
          error,
        );
        return await buildProjectIndexFromExport(projectRoot, opts, {
          ignoreExistingManifest: true,
          reportDiscoveryProgress: true,
          configHash: currentConfigHashResult,
          discoveryContext,
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
          ...(discoveryTimings
            ? {
                onDiscoveryTiming: (step: { name: string; ms: number }) =>
                  recordBuildTimingStep(discoveryTimings, step),
              }
            : {}),
          ...(discoveryContext ? { discoveryContext } : {}),
        }),
      );
    }
    manifestDiffFiles = [...new Set([...manifestDiffFiles, ...gitManifestCandidates])];
    const projectCandidates = new Set(
      await filterIncrementalDiscoveryCandidates(
        projectRoot,
        [...manifestDiffFiles, ...gitFiles],
        trackedEntries,
        opts,
        discoveryContext,
      ),
    );
    manifestDiffFiles = manifestDiffFiles.filter((file) => projectCandidates.has(file));
    gitFiles = gitFiles.filter((file) => projectCandidates.has(file));
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
      await timeIndexBuildPhase({
        opts,
        timings,
        buildStartedAt: undefined,
        stepName: "index-manifest",
        activity: "Writing index manifest",
        current: 0,
        total: 0,
        fn: () =>
          writeIndexManifestSnapshot({
            projectRoot,
            opts,
            graphOptions,
            ...(resolverEnvironmentFingerprint ? { resolverEnvironmentFingerprint } : {}),
            files: {},
            timings,
            manifestReport,
            allowEmpty: true,
            transientFiles,
            declaredContainers: new Map(),
            configHash: currentConfigHashResult,
            discoveryContext,
            ...(manifest.symlinkDirectories !== undefined ? { symlinkDirectories: manifest.symlinkDirectories } : {}),
          }),
      });
      return {
        graph: { nodes: new Set(), edges: [] },
        graphAdjacency: buildGraphAdjacency({ nodes: new Set(), edges: [] }),
        modules: new Map(),
        byFile: new Map(),
        projectRoot: normalizedProjectRoot,
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
          ...(discoveryContext ? { discoveryContext } : {}),
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
        if (!report.backend) initNativeBackendReport(report);
        snapshot.buildReport = report;
      }
      return snapshot;
    };

    // The manifest/blob reconciliation above covers tracked files even when their current bytes match HEAD.
    // Untracked files have no Git content identity, so independently check their manifest metadata.
    // An already indexed untracked file (a build artifact or scratch file, for example) can reuse its snapshot
    // when its stat still matches; an unseen or changed file must pass ordinary signature validation.
    // `entry.sig` starts with `${mtimeMs}:${size}` (`fileStatSignature` in build-cache/module-cache.ts).
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
            discoveryCache: discoveryContext.git,
            ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
            ...(opts?.cacheStrict ? { strict: true } : {}),
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
        ? new (await import("../util/bloom-filter.js")).BloomFilterCache()
        : undefined;
      const addedFiles: string[] = [];
      for (const file of allFiles) {
        const sigInfo = fileSignatures.get(file);
        if (!sigInfo) continue;
        const entry = trackedEntries[file];
        const hasMatchingSignature =
          entry?.gitSig && sigInfo.gitSig ? entry.gitSig === sigInfo.gitSig : entry?.sig === sigInfo.sig;
        if (!entry) addedFiles.push(file);
        if (!entry || !hasMatchingSignature) {
          changedFiles.add(file);
        }
      }
      const reverseDeps = buildTrackedFileReverseDependencies(trackedEntries);
      // Dependents rebuilt only because a file they depend on changed: their own source may be unchanged.
      const dependentsToPrime = new Set<string>();
      // Loaded modules dropped for a rebuild: their public surface stands in for a manifest that recorded none.
      const retiredModules = new Map<string, ModuleIndex>();
      const rebuildDependent = (file: string): void => {
        const key = fileIdentityKey(file);
        const loaded = modules.get(key);
        if (loaded) {
          retiredModules.set(key, loaded);
          modules.delete(key);
          if (fileReport) {
            fileReport.cached = Math.max(0, (fileReport.cached ?? 0) - 1);
          }
        } else if (!changedFiles.has(file)) {
          dependentsToPrime.add(file);
        }
        markAsChanged(file);
      };
      // A changed file with a content surface (see public-surface.ts) can move what its importers resolved from its
      // declarations, so every transitive importer extracts again. Any other file rebuilds its importers only when its
      // public surface changed, which is known once it is extracted: see the extraction waves below.
      const invalidateCachedDependents = () => {
        const contentSurfaceFiles = new Set<string>();
        for (const file of changedFiles) {
          if (publicSurfaceKind(file, opts?.languageExtensions) === "content") contentSurfaceFiles.add(file);
        }
        for (const file of collectTrackedFileDependents(trackedEntries, contentSurfaceFiles, reverseDeps)) {
          rebuildDependent(file);
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
        if (changedFiles.has(file)) {
          const dependentLanguage = dependentsToPrime.has(file)
            ? supportForFileWithoutHeaderSample(file, opts?.languageExtensions)?.id
            : undefined;
          if (readsSyntaxTree(dependentLanguage)) {
            const key = fileIdentityKey(file);
            const sigInfo = fileSignatures.get(file)!;
            const reusable =
              snapshotModules?.get(key) ??
              (cacheEnabled
                ? tryLoadFromCache(
                    projectRoot,
                    file,
                    await moduleCacheSignatureForFile(file, sigInfo, opts, resolverEnvironmentFingerprint),
                    opts,
                  )
                : null);
            if (reusable) primeReusedFileFacts(file, reusable, opts);
          }
          continue;
        }
        const sigInfo = fileSignatures.get(file)!;
        let cached: ModuleIndex | null = null;
        const snapshotMod = snapshotModules?.get(fileIdentityKey(file));
        if (snapshotMod) {
          cached = snapshotMod;
        } else if (cacheEnabled) {
          const cacheSig = await moduleCacheSignatureForFile(file, sigInfo, opts, resolverEnvironmentFingerprint);
          cached = tryLoadFromCache(projectRoot, file, cacheSig, opts, report);
        }
        if (cached?.importLookupIncomplete) {
          // See collectStaleCachedModules: extract this importer again. Its own file facts stay valid, so the
          // project scan reads them from the cached module instead of parsing the file.
          primeReusedFileFacts(file, cached, opts);
          changedFiles.add(file);
        } else if (cached) {
          if (fileReport) fileReport.cached = (fileReport.cached ?? 0) + 1;
          modules.set(fileIdentityKey(file), cached);
          primeReusedFileFacts(file, cached, opts);
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
      let projectFileExtractions = new Map<string, ProjectFileExtraction>();
      let projectExtractionMs = 0;
      let updateStartedAt: number | undefined;
      const initialChangedFiles = Array.from(changedFiles);
      // Preserve changed declarers before their fresh rows replace the cached name surface.
      for (const file of initialChangedFiles) {
        if (!trackedEntries[file]) continue;
        const support = supportForFileWithoutHeaderSample(file, opts?.languageExtensions);
        if (!support || !DECLARATION_RESOLVED_IMPORT_LANGUAGES.has(support.id)) continue;
        const key = fileIdentityKey(file);
        if (retiredModules.has(key)) continue;
        const previous = peekCachedModule(projectRoot, file, opts);
        if (previous) retiredModules.set(key, previous.mod);
      }
      // A deleted declarer leaves no fresh module. Its last cached module names what its importers can no longer
      // find there, so a binding left ambiguous by it can resolve.
      const deletedDeclarationNames = new Map<string, DeclarationNameChanges>();
      for (const file of deletedTrackedFiles) {
        const support = supportForFileWithoutHeaderSample(file, opts?.languageExtensions);
        if (!support || !DECLARATION_RESOLVED_IMPORT_LANGUAGES.has(support.id)) continue;
        const previous = peekCachedModule(projectRoot, file, opts);
        recordDeclarationNameChanges(
          deletedDeclarationNames,
          support,
          deletedDeclarationNameChanges(previous?.mod, support),
        );
      }
      if (
        initialChangedFiles.some((file) =>
          readsSyntaxTree(supportForFileWithoutHeaderSample(file, opts?.languageExtensions)?.id),
        )
      ) {
        workerSetup = await setupWorkerPool(
          opts,
          countNativeWorkerEligibleFiles(initialChangedFiles, opts?.languageExtensions),
        );
        installProjectFileFactsReaders(workerSetup, report);
        updateStartedAt = performance.now();
        emitIndexLifecycleProgress(opts, "start", "update", initialChangedFiles.length);
        projectFileExtractions = await extractProjectFilesBeforeResolution({
          files: initialChangedFiles,
          opts,
          report,
          workerSetup,
          concurrency: conc,
          projectRoot,
        });
        projectExtractionMs = performance.now() - updateStartedAt;
      }
      const preparePhpFile = installPhpProjectFileReader({
        files: allFiles,
        opts,
        workerSetup: () => workerSetup,
        report,
        projectRoot,
      });
      const reparseCachedFile = (candidate: string): void => {
        const key = fileIdentityKey(candidate);
        if (modules.has(key)) {
          modules.delete(key);
          if (fileReport) {
            fileReport.cached = Math.max(0, (fileReport.cached ?? 0) - 1);
          }
        }
        markAsChanged(candidate);
      };
      // An added file can satisfy a specifier whose stem matches it. Edges that cannot
      // round-trip (unstored resolution kind, or a C/C++ include with no form) are reparsed.
      if (addedFiles.length) {
        const addedStemsByLanguage = new Map<string, ReadonlySet<string>>();
        const addedStemsForLanguage = (languageId: string): ReadonlySet<string> => {
          const existing = addedStemsByLanguage.get(languageId);
          if (existing) return existing;
          const stems = addedResolutionStems(addedFiles, languageId);
          addedStemsByLanguage.set(languageId, stems);
          return stems;
        };
        const specifierEdgeCandidates = collectSpecifierEdgeCandidates(trackedEntries, true);
        if (specifierEdgeCandidates.size) {
          const candidateFiles = Array.from(specifierEdgeCandidates);
          const staleResolutions = await mapLimit(candidateFiles, conc, async (candidate) => {
            if (!allFiles.has(candidate) || changedFiles.has(candidate)) return false;
            const entry = trackedEntries[candidate];
            if (!entry) return false;
            return specifierResolutionChanged(
              candidate,
              entry,
              projectRoot,
              workspaceConfig,
              graphOptions,
              opts?.languageExtensions,
              loadMatchPathForFile,
              addedFiles,
              addedStemsForLanguage,
              (importer) =>
                loadTsconfigResolutionInputsFor(importer, projectRoot, opts?.logLevel).then((inputs) => inputs?.paths),
            );
          });
          for (let index = 0; index < candidateFiles.length; index += 1) {
            if (staleResolutions[index]) reparseCachedFile(candidateFiles[index]!);
          }
        }
        for (const importer of collectPythonPackageImporters(trackedEntries, addedFiles)) {
          if (allFiles.has(importer) && !changedFiles.has(importer)) reparseCachedFile(importer);
        }
      }
      // Declaration imports resolve through the files that declare their names. A body edit changes no names and
      // never visits a cached importer. An edited, added, or deleted declarer rechecks only the bindings that name
      // what it started or stopped declaring (see `declarationImportRecheck`).
      const collectRecheckedDeclarationImporters = async (
        changesByLanguage: ReadonlyMap<string, DeclarationNameChanges>,
      ): Promise<string[]> => {
        if (!changesByLanguage.size) return [];
        const candidates = Array.from(collectSpecifierEdgeCandidates(trackedEntries, true));
        const rechecked = await mapLimit(candidates, conc, async (candidate) => {
          if (!allFiles.has(candidate) || changedFiles.has(candidate)) return false;
          const support = supportForFileWithoutHeaderSample(candidate, opts?.languageExtensions);
          if (!support) return false;
          const changes = changesByLanguage.get(declarationLanguageGroup(support.id));
          if (!changes) return false;
          const mod = modules.get(fileIdentityKey(candidate));
          if (!mod) return false;
          for (const binding of mod.imports) {
            const recheck = declarationImportRecheck(binding, support, changes);
            if (recheck === "none") continue;
            if (recheck === "reextract") return true;
            const packageWildcard = binding.kind === "star" && !!binding.jvmTypeWildcardName;
            const targets = await resolveSpecifierTargets(candidate, binding.from, support.id, {
              projectRoot,
              resolveNodeModules: !!graphOptions.resolveNodeModules,
              ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
              ...(opts?.languageExtensions ? { languageExtensions: opts.languageExtensions } : {}),
              ...(packageWildcard ? { jvmPackageWildcard: true } : {}),
              ...(binding.kind === "named" && binding.phpImportType ? { phpImportType: binding.phpImportType } : {}),
            });
            if (targets.files.length) return true;
          }
          return false;
        });
        return candidates.filter((_, index) => rechecked[index]);
      };
      const changedList = Array.from(changedFiles);
      // Sized by the work that remains rather than the size of the project: an incremental build
      // touching a handful of files gets a handful of threads, or none.
      if (!workerSetup.pool) {
        workerSetup = await setupWorkerPool(
          opts,
          countNativeWorkerEligibleFiles(changedList, opts?.languageExtensions),
        );
      }
      installProjectFileFactsReaders(workerSetup, report);
      if (updateStartedAt === undefined && (changedList.length || deletedTrackedFiles.size)) {
        updateStartedAt = performance.now();
        emitIndexLifecycleProgress(opts, "start", "update", changedList.length);
      }
      if (fileReport) fileReport.changed = changedList.length;
      // Public surfaces of the files extracted in this build, by identity key. Content-surface files have none.
      const extractedFiles = new Map<string, string>();
      const freshSurfaces = new Map<string, string>();
      let processedFiles = 0;
      let plannedFiles = changedList.length;
      let parseMs = projectExtractionMs;
      // Importers that must extract again because a file in `extractedFiles` changed what an importer can cache from it:
      // its public surface differs from the one the previous build recorded in the manifest (a dropped loaded module
      // supplies it when the manifest has none), or neither is known. A file that re-exports from such a file exposes
      // different names itself, so its importers count too. Content-surface files rebuilt their importers above.
      const collectSurfaceDependents = (): string[] => {
        const surfaceChanged = new Set<string>();
        for (const [key, file] of extractedFiles) {
          const surface = freshSurfaces.get(key);
          if (surface === undefined) continue;
          const retired = retiredModules.get(key);
          const previous =
            trackedEntries[file]?.surface ??
            (retired ? publicSurfaceSignature(file, retired, projectRoot, opts?.languageExtensions) : undefined);
          if (previous !== surface) surfaceChanged.add(key);
        }
        if (!surfaceChanged.size) return [];
        propagateReexportSurfaceChanges(modules, surfaceChanged);
        return Array.from(collectDirectDependents(reverseDeps, surfaceChanged)).filter(
          (file) => allFiles.has(file) && !changedFiles.has(file),
        );
      };
      let wave = changedList;
      // A deleted declarer needs no extraction to name what it stopped declaring, so the first recheck reads it and a
      // build that only deletes files still resolves the imports that file left ambiguous.
      let pendingNameChanges = deletedDeclarationNames;
      while (wave.length || pendingNameChanges.size) {
        const parseStart = performance.now();
        const unpreparedProjectFiles = wave.filter((file) => !projectFileExtractions.has(file));
        const nextExtractions = await extractProjectFilesBeforeResolution({
          files: unpreparedProjectFiles,
          opts,
          report,
          workerSetup,
          concurrency: conc,
          projectRoot,
        });
        for (const [file, extraction] of nextExtractions) projectFileExtractions.set(file, extraction);
        const fileResults = await mapLimit(wave, conc, async (file) => {
          try {
            if (fileReport) fileReport.parsed = (fileReport.parsed ?? 0) + 1;
            const support = supportForFile(file, opts?.languageExtensions);
            if (!support) return [file, unparsedModuleIndex(file)] as const;
            const matchPath =
              support.id === "ts" || support.id === "tsx" ? await loadMatchPathForFile(file) : undefined;
            const extraction = projectFileExtractions.get(file);
            projectFileExtractions.delete(file);
            if (extraction && "error" in extraction) throw extraction.error;
            let preparedFile = extraction && "prepared" in extraction ? extraction.prepared : undefined;
            if (support.id === "php") preparedFile = await preparePhpFile(file);
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
              fileSignatures,
              cacheEnabled,
              ...(resolverEnvironmentFingerprint !== undefined ? { resolverEnvironmentFingerprint } : {}),
              ...(preparedFile ? { preparedFile } : {}),
            });
            return [file, built.module, built.cacheWrite] as const;
          } catch (error) {
            if (isNativeRequiredUnavailableError(error) || isNodeSqliteUnavailableError(error)) throw error;
            if (isUnsupportedParserInputError(error)) {
              return [file, createEmptyModuleIndex(file)] as const;
            }
            recordFileFailure(report, file, error);
            logWithLevel(opts?.logLevel, "warn", `Warning: Failed to process file ${file}:`, error);
            return [file, failedModuleIndex(file), undefined] as const;
          } finally {
            if (opts?.onProgress) {
              opts.onProgress({
                type: "progress",
                phase: "update",
                mode: "update",
                message: `Indexed ${file}`,
                current: ++processedFiles,
                total: plannedFiles,
              });
            }
          }
        });
        const pendingIncrementalCacheWrites: PendingModuleCacheWrite[] = [];
        const nameChanges = pendingNameChanges;
        pendingNameChanges = new Map<string, DeclarationNameChanges>();
        for (const [file, mod, cacheWrite] of fileResults) {
          const key = fileIdentityKey(file);
          modules.set(key, mod);
          extractedFiles.set(key, file);
          const surface = publicSurfaceSignature(file, mod, projectRoot, opts?.languageExtensions);
          if (surface !== undefined) freshSurfaces.set(key, surface);
          const support = supportForFileWithoutHeaderSample(file, opts?.languageExtensions);
          if (support && DECLARATION_RESOLVED_IMPORT_LANGUAGES.has(support.id)) {
            const changes = declarationNameChanges(retiredModules.get(key), mod, support, projectRoot);
            if (changes) recordDeclarationNameChanges(nameChanges, support, changes);
          }
          if (cacheWrite) pendingIncrementalCacheWrites.push(cacheWrite);
        }
        if (pendingIncrementalCacheWrites.length) {
          writeModulesToCache(projectRoot, pendingIncrementalCacheWrites, opts);
        }
        parseMs += performance.now() - parseStart;
        const recheckedImporters = await collectRecheckedDeclarationImporters(nameChanges);
        wave = collectSurfaceDependents();
        if (recheckedImporters.length) wave = [...new Set([...wave, ...recheckedImporters])];
        if (!wave.length) break;
        for (const file of wave) rebuildDependent(file);
        plannedFiles += wave.length;
        if (fileReport) fileReport.changed = changedFiles.size;
        if (!workerSetup.pool) {
          const eligibleFiles = countNativeWorkerEligibleFiles(wave, opts?.languageExtensions);
          if (shouldEnableNativeWorkers(opts, eligibleFiles)) workerSetup = await setupWorkerPool(opts, eligibleFiles);
        }
      }
      if (timings && changedList.length) timings.parseMs = Math.round(parseMs);
      for (const jsonPath of jsonDependencies.values()) {
        ensureJsonModule(modules, jsonPath);
      }
      expandStarImports(modules, opts);
      // The declared-container index is rebuilt from modules already in memory, so this costs no
      // extra file reads. A container whose declaring-file set changed invalidates the consumers
      // whose cached edges name it: their content is unchanged, so signature matching alone leaves
      // them resolved against a declaration that moved, disappeared, appeared, or became ambiguous.
      const declaredContainers = declaredContainerIndexFromModules(modules.values());
      const declaredContainerConsumers = collectDeclaredContainerConsumers(
        trackedEntries,
        declaredContainerNamesChanged(manifestDeclaredContainerIndex(manifest), declaredContainers),
      );
      for (const file of declaredContainerConsumers) markAsChanged(file);
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
              resolveNodeModules: !!graphOptions.resolveNodeModules,
              dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
              ...(opts?.languageExtensions ? { languageExtensions: opts.languageExtensions } : {}),
              threads: conc,
              ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
              ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
              allFiles: Array.from(allFiles),
              fileSignatures,
              cachedFileEdges: cachedGraphEntries,
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
      // signatures fresh. The next build reads each entry's public surface to decide which importers to extract again:
      // an extracted file takes its new one, and a file that never recorded one gets it from its loaded module.
      for (const [file, entry] of manifestEntries) {
        const signature = fileSignatures.get(file);
        if (!signature) continue;
        const { gitSig: _previousGitSig, surface: retainedSurface, ...entryWithoutGitSig } = entry;
        const key = fileIdentityKey(file);
        let surface = freshSurfaces.get(key);
        if (surface === undefined && publicSurfaceKind(file, opts?.languageExtensions) === "api") {
          const loaded = modules.get(key);
          surface =
            retainedSurface ??
            (loaded ? publicSurfaceSignature(file, loaded, projectRoot, opts?.languageExtensions) : undefined);
        }
        manifestEntries.set(file, {
          ...entryWithoutGitSig,
          sig: signature.sig,
          ...(signature.gitSig ? { gitSig: signature.gitSig } : {}),
          ...(surface !== undefined ? { surface } : {}),
        });
      }
      await timeIndexBuildPhase({
        opts,
        timings,
        buildStartedAt: updateStartedAt,
        stepName: "index-manifest",
        activity: "Writing index manifest",
        current: allFiles.size,
        total: allFiles.size,
        mode: "update",
        fn: () =>
          writeIndexManifestSnapshot({
            projectRoot,
            opts,
            graphOptions,
            ...(resolverEnvironmentFingerprint ? { resolverEnvironmentFingerprint } : {}),
            files: manifestEntries,
            timings,
            manifestReport,
            transientFiles,
            declaredContainers,
            configHash: currentConfigHashResult,
            discoveryContext,
            ...(manifest.symlinkDirectories !== undefined ? { symlinkDirectories: manifest.symlinkDirectories } : {}),
          }),
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
        ...(discoveryContext ? { discoveryContext } : {}),
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
      await timeIndexBuildPhase({
        opts,
        timings,
        buildStartedAt: updateStartedAt,
        stepName: "snapshot-write",
        activity: "Writing project snapshot",
        current: allFiles.size,
        total: allFiles.size,
        mode: "update",
        fn: () =>
          writeProjectIndexSnapshot(
            projectRoot,
            opts,
            index,
            projectSnapshotFilesSignature(manifestEntries, projectRoot),
          ),
      });
      if (updateStartedAt !== undefined) {
        emitIndexLifecycleProgress(opts, "complete", "update", index.byFile.size, performance.now() - updateStartedAt);
      } else {
        completeCheckProgress(allFiles.size);
      }
      return index;
    } finally {
      setJvmFileFactsReader(undefined);
      setCsharpNamespaceFactsReader(undefined);
      setPhpModuleImportNamesReader(undefined);
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
  assertNativeRequiredAvailable();
  const manifest = await loadManifest(projectRoot, opts);
  const trackedEntries = sanitizeManifestEntriesForRoot(projectRoot, manifest?.files);
  const graphOptions = normalizeGraphOptions(opts?.graph);
  const discoveryContext = opts?.discoveryContext ?? createProjectDiscoveryContext(projectRoot);
  const previousLanguageExtensions = normalizeLanguageExtensions(manifest?.buildOptions?.languageExtensions);
  const currentLanguageExtensions = normalizeLanguageExtensions(opts?.languageExtensions);
  const languageExtensionsChanged = manifest
    ? diffBuildOptions(manifest.buildOptions, opts).includes("languageExtensions")
    : false;
  const languageSupportChangedForFile = (file: string): boolean =>
    supportForFile(file, previousLanguageExtensions)?.id !== supportForFile(file, currentLanguageExtensions)?.id;
  const explicitFiles = await normalizeIndexedFileInputsWithinRoot(projectRoot, opts?.files ?? [], "Graph delta file");
  const additionalFiles = await normalizeIndexedFileInputsWithinRoot(
    projectRoot,
    opts?.additionalFiles ?? [],
    "Additional graph delta file",
  );
  const needsGitScan = !!opts?.gitBase || !!opts?.changedSince;
  let gitFiles = needsGitScan ? await listChangedFiles(projectRoot, buildIncrementalGitDiffOptions(opts)) : [];
  const { trackedFiles, deletedTrackedFiles } = await partitionTrackedManifestFiles(trackedEntries);
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
  const projectCandidates = new Set(
    await filterIncrementalDiscoveryCandidates(
      projectRoot,
      [...manifestDiffFiles, ...gitFiles],
      trackedEntries,
      opts,
      discoveryContext,
    ),
  );
  manifestDiffFiles = manifestDiffFiles.filter((file) => projectCandidates.has(file));
  gitFiles = gitFiles.filter((file) => projectCandidates.has(file));
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
  deletedTrackedFiles.forEach(addChangedFile);
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
          ...(opts?.cacheStrict ? { strict: true } : {}),
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
  const index = await buildProjectIndexIncremental(projectRoot, { ...opts, discoveryContext });
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
