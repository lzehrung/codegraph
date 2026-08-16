/**
 * Session management for conversation-aware caching
 * Maintains warm caches across multiple queries for better agent UX
 */

import fs from "node:fs";
import path from "node:path";
import {
  type ProjectIndex,
  type BuildOptions,
  type BuildReport,
  type GoToResult,
  type IncrementalBuildOptions,
  type Reference,
  type SymbolDef,
} from "./indexer/types.js";
import { buildProjectIndex, buildProjectIndexIncremental } from "./indexer/build-index.js";
import { normalizeLanguageExtensions } from "./indexer/build-cache.js";
import { findReferences, goToDefinition } from "./indexer/navigation.js";
import {
  analyzeImpactFromDiff,
  type ImpactOptions,
  type ImpactReport,
  type CompactImpactReport,
  type ImpactStreamingOptions,
} from "./impact/index.js";
import { analyzeImpactStreaming, type ImpactStreamChunk } from "./impact/streaming.js";
import { getSessionPreset, mergePreset, type PresetName } from "./presets.js";
import { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions, mergeGraphOptions } from "./config.js";
import { normalizePath, resolveFilePathWithinRoot } from "./util/paths.js";
import { listProjectFiles } from "./util/projectFiles.js";

export type SessionOptions = {
  /** Project root directory */
  root: string;

  /** Preset configuration (auto-configures buildOptions, timeout, incremental) */
  preset?: PresetName;

  /** Build options for the index (merged with preset if both provided) */
  buildOptions?: BuildOptions;

  /** Session timeout in milliseconds (default: 30 minutes or preset value) */
  timeout?: number;

  /** Whether to use incremental indexing (default: true or preset value) */
  incremental?: boolean;
};

export type SessionManagerOptions = {
  /** Maximum sessions, including sessions currently initializing. Defaults to 32. */
  maxSessions?: number;
  /** Idle-session scan interval in milliseconds. Defaults to 60 seconds. Use 0 to disable. */
  evictionIntervalMs?: number;
};

export const DEFAULT_SESSION_MANAGER_MAX_SESSIONS = 32;
export const DEFAULT_SESSION_MANAGER_EVICTION_INTERVAL_MS = 60_000;

export type SessionStatus = "initializing" | "ready" | "expired" | "error";

export type SessionStaleReason = "tracked_files_changed" | "config_changed";

export type SessionStats = {
  status: SessionStatus;
  fileCount: number;
  symbolCount: number;
  lastActivity: Date;
  timeUntilExpiration: number;
  stale: boolean;
  staleReason?: SessionStaleReason;
  lastRefreshAt?: Date;
  lastRefreshReason?: "initialization" | "manual" | "stale_check";
};

type SessionIdentity = {
  root: string;
  timeout: number;
  incremental: boolean;
  buildOptions?: Record<string, unknown>;
};

function normalizeStringArray(values?: string[]): string[] | undefined {
  if (!values?.length) return undefined;
  return [...values].sort();
}

function normalizeBuildOptions(options?: BuildOptions): Record<string, unknown> | undefined {
  if (!options) return undefined;
  return {
    cache: options.cache,
    cacheDir: options.cacheDir ? path.resolve(options.cacheDir) : undefined,
    cacheLocation: options.cacheLocation,
    cacheStrict: options.cacheStrict,
    useBloomFilters: options.useBloomFilters,
    graph: options.graph
      ? {
          fast: options.graph.fast,
          resolveNodeModules: options.graph.resolveNodeModules,
          dynamicImportHeuristics: options.graph.dynamicImportHeuristics,
          native: options.graph.native,
          logLevel: options.graph.logLevel,
          resolutionHints: normalizeStringArray(options.graph.resolutionHints),
          fastRegexDisabledLanguages: normalizeStringArray(options.graph.fastRegexDisabledLanguages),
        }
      : undefined,
    native: options.native,
    cacheVerify: options.cacheVerify,
    incrementalStrict: options.incrementalStrict,
    parsedCacheMaxEntries: options.parsedCacheMaxEntries,
    logLevel: options.logLevel,
    keepParsed: options.keepParsed,
    useNativeWorkers: options.useNativeWorkers,
    nativeThreads: options.nativeThreads,
    threads: options.threads,
    discovery: options.discovery
      ? {
          includeGlobs: normalizeStringArray(options.discovery.includeGlobs),
          ignoreGlobs: normalizeStringArray(options.discovery.ignoreGlobs),
          useGitignore: options.discovery.useGitignore,
          gitignoreRoot: options.discovery.gitignoreRoot ? path.resolve(options.discovery.gitignoreRoot) : undefined,
        }
      : undefined,
    languageExtensions: normalizeLanguageExtensions(options.languageExtensions),
  };
}

function resolveSessionIdentity(options: SessionOptions): SessionIdentity {
  if (options.preset) {
    const presetOpts = getSessionPreset(options.preset, options.root);
    const buildOptions = options.buildOptions
      ? mergePreset(presetOpts.buildOptions ?? {}, options.buildOptions)
      : presetOpts.buildOptions;
    const normalizedBuildOptions = normalizeBuildOptions(buildOptions);
    return {
      root: path.resolve(options.root),
      timeout: options.timeout ?? presetOpts.timeout ?? 30 * 60 * 1000,
      incremental: options.incremental ?? presetOpts.incremental ?? true,
      ...(normalizedBuildOptions ? { buildOptions: normalizedBuildOptions } : {}),
    };
  }
  const normalizedBuildOptions = normalizeBuildOptions(options.buildOptions);
  return {
    root: path.resolve(options.root),
    timeout: options.timeout ?? 30 * 60 * 1000,
    incremental: options.incremental ?? true,
    ...(normalizedBuildOptions ? { buildOptions: normalizedBuildOptions } : {}),
  };
}

function sessionIdentityFingerprint(identity: SessionIdentity): string {
  return JSON.stringify(identity);
}

type SessionInputError = {
  status: "error";
  reason: "outside_project_root";
  error: string;
};

type SessionFindReferencesResult =
  | { status: "ok"; definition: SymbolDef; references: Reference[] }
  | { status: "not_found"; reason: string }
  | SessionInputError;

type SessionGoToDefinitionResult = GoToResult | SessionInputError;

function resolveSessionFileInput(
  root: string,
  file: string,
  label: string,
): { status: "ok"; file: string } | SessionInputError {
  return resolveFilePathWithinRoot(root, file, label);
}

function requireSessionImpactProvider(options: Partial<ImpactOptions>): void {
  if (!options.provider) {
    throw new Error("Impact provider is required. Set provider to 'git', 'github', or 'raw'.");
  }
}

/**
 * Interface for CodeReviewSession for TypeScript consumers.
 * Use this type when you need to type a session parameter without coupling to the class.
 */
export interface ICodeReviewSession {
  init(): Promise<void>;
  isReady(): boolean;
  getStatus(): SessionStatus;
  analyzeImpact(options: ImpactOptions): Promise<ImpactReport | CompactImpactReport>;
  findReferences(params: { file: string; line: number; column: number }): Promise<SessionFindReferencesResult>;
  analyzeImpactStream(options: ImpactStreamingOptions): AsyncGenerator<ImpactStreamChunk>;
  goToDefinition(params: { file: string; line: number; column: number }): Promise<SessionGoToDefinitionResult>;
  refresh(): Promise<void>;
  dispose(): void;
  getStats(): SessionStats;
}

/**
 * A code review session that maintains warm caches
 * Use this to avoid rebuilding the index for multiple queries
 */
export class CodeReviewSession implements ICodeReviewSession {
  private static readonly STALE_CHECK_INTERVAL_MS = 5_000;

  private index: ProjectIndex | null = null;
  private buildReport: BuildReport | undefined;
  private status: SessionStatus = "initializing";
  private lastActivity: number = Date.now();
  private timeout: number;
  private root: string;
  private buildOptions: BuildOptions | undefined;
  private incremental: boolean;
  private initPromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private identityFingerprint: string;
  private lifecycleVersion = 0;
  private trackedFileSignatures = new Map<string, string>();
  private configSignature: string | undefined;
  private trackedDirectorySignatures = new Map<string, string>();
  private staleReason: SessionStaleReason | undefined;
  private forceFullRefreshOnNextStaleCheck = false;
  private lastStaleCheckAt = 0;
  private lastTrackedFileScanAt = 0;
  private lastImpactProjectDriftCheckAt = 0;
  private lastPassiveStaleCheckAt = 0;
  private lastRefreshAt: number | undefined;
  private lastRefreshReason: "initialization" | "manual" | "stale_check" | undefined;

  constructor(options: SessionOptions) {
    const identity = resolveSessionIdentity(options);
    this.root = identity.root;
    if (options.preset) {
      const presetBuildOptions = getSessionPreset(options.preset, options.root).buildOptions;
      this.buildOptions = options.buildOptions
        ? mergePreset(presetBuildOptions ?? {}, options.buildOptions)
        : presetBuildOptions;
    } else {
      this.buildOptions = options.buildOptions;
    }
    this.timeout = identity.timeout;
    this.incremental = identity.incremental;
    this.identityFingerprint = sessionIdentityFingerprint(identity);
  }

  matchesOptions(options: SessionOptions): boolean {
    return this.identityFingerprint === sessionIdentityFingerprint(resolveSessionIdentity(options));
  }

  getRoot(): string {
    return this.root;
  }
  private async currentBuildOptions(): Promise<BuildOptions | undefined> {
    const config = await loadCodegraphConfig(this.root);
    const discovery = mergeDiscoveryOptions(config.discovery, this.buildOptions?.discovery);
    const graph = mergeGraphOptions(config.graph, this.buildOptions?.graph);
    const languageExtensions =
      normalizeLanguageExtensions(this.buildOptions?.languageExtensions) ?? config.languages?.extensions;
    const cacheLocation = this.buildOptions?.cacheLocation ?? config.cache?.location;
    if (
      !hasDiscoveryOptions(discovery) &&
      !config.graph &&
      !this.buildOptions?.graph &&
      !languageExtensions &&
      !cacheLocation
    ) {
      return this.buildOptions;
    }
    return {
      ...this.buildOptions,
      ...(hasDiscoveryOptions(discovery) ? { discovery } : {}),
      ...(config.graph || this.buildOptions?.graph ? { graph } : {}),
      ...(languageExtensions ? { languageExtensions } : {}),
      ...(cacheLocation ? { cacheLocation } : {}),
    };
  }

  private async buildIndex(options: { forceFull?: boolean } = {}): Promise<{
    index: ProjectIndex;
    report: BuildReport;
    projectFiles: string[];
  }> {
    const currentBuildOptions = await this.currentBuildOptions();
    if (options.forceFull && this.incremental) {
      const projectFiles = await this.currentProjectFiles(currentBuildOptions);
      const report: BuildReport = { timings: {} };
      const buildOptions: IncrementalBuildOptions = { ...currentBuildOptions, files: projectFiles, report };
      const index = await buildProjectIndexIncremental(this.root, buildOptions);
      return { index, report: index.buildReport ?? report, projectFiles };
    }
    if (options.forceFull) {
      const report: BuildReport = { timings: {} };
      const buildOptions: BuildOptions = { ...currentBuildOptions, report };
      const index = await buildProjectIndex(this.root, buildOptions);
      const projectFiles = this.indexedProjectFiles(index);
      return { index, report: index.buildReport ?? report, projectFiles };
    }
    const report: BuildReport = { timings: {} };
    const buildOptions: BuildOptions = { ...currentBuildOptions, report };
    const index = this.incremental
      ? await buildProjectIndexIncremental(this.root, buildOptions)
      : await buildProjectIndex(this.root, buildOptions);
    const projectFiles = this.indexedProjectFiles(index);
    const buildReport = index.buildReport ?? report;
    return { index, report: buildReport, projectFiles };
  }

  private createDisposedDuringOperationError(operation: string): Error {
    return new Error(`Session was disposed during ${operation}.`);
  }

  private assertLifecycleVersion(expectedLifecycleVersion: number, operation: string): void {
    if (this.lifecycleVersion !== expectedLifecycleVersion) {
      throw this.createDisposedDuringOperationError(operation);
    }
  }

  private trackedSignatureFromManifest(sig: string): string {
    const parts = sig.split(":");
    if (parts.length >= 2) {
      return `${parts[0]}:${parts[1]}`;
    }
    return sig;
  }

  private statSignature(file: string): string {
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "0:0";
    }
  }

  private directorySignature(directory: string): string {
    return this.statSignature(directory);
  }

  private configFilePath(): string {
    return path.join(this.root, "codegraph.config.json");
  }

  private async currentProjectFiles(buildOptions?: BuildOptions): Promise<string[]> {
    const discoveryOptions = {
      ...buildOptions?.discovery,
      ...(buildOptions?.logLevel ? { logLevel: buildOptions.logLevel } : {}),
    };
    return await listProjectFiles(this.root, undefined, discoveryOptions);
  }

  private indexedProjectFiles(index: ProjectIndex): string[] {
    const files = index.manifestEntries
      ? [...index.manifestEntries.keys()]
      : Array.from(index.byFile.values(), (module) => module.file);
    return files.map((file) => {
      if (path.isAbsolute(file)) {
        return file;
      }
      return path.resolve(this.root, file);
    });
  }

  private isPathInsideRoot(candidate: string): boolean {
    const relative = path.relative(this.root, candidate);
    return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private directoriesForProjectFiles(files: Iterable<string>): Set<string> {
    const directories = new Set<string>([this.root]);
    for (const file of files) {
      let directory = path.dirname(path.resolve(file));
      while (this.isPathInsideRoot(directory)) {
        directories.add(directory);
        if (directory === this.root) break;
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }

  private directorySignatures(files: Iterable<string>): Map<string, string> {
    const signatures = new Map<string, string>();
    for (const directory of this.directoriesForProjectFiles(files)) {
      signatures.set(directory, this.directorySignature(directory));
    }
    return signatures;
  }

  private projectDirectoriesChanged(): boolean {
    if (!this.trackedDirectorySignatures.size) {
      return true;
    }
    for (const [directory, signature] of this.trackedDirectorySignatures) {
      if (this.directorySignature(directory) !== signature) {
        return true;
      }
    }
    return false;
  }
  private captureFreshnessBaseline(
    index: ProjectIndex,
    reason: "initialization" | "manual" | "stale_check",
    projectFiles: string[],
  ): void {
    const trackedEntries = index.manifestEntries?.size
      ? [...index.manifestEntries].map(([file, entry]) => [file, this.trackedSignatureFromManifest(entry.sig)] as const)
      : [...index.byFile.values()].map((module) => [module.file, this.statSignature(module.file)] as const);
    this.trackedFileSignatures = new Map(trackedEntries);
    this.trackedDirectorySignatures = this.directorySignatures(projectFiles);
    this.configSignature = this.statSignature(this.configFilePath());
    this.staleReason = undefined;
    this.lastStaleCheckAt = Date.now();
    this.lastPassiveStaleCheckAt = 0;
    this.lastTrackedFileScanAt = 0;
    this.lastImpactProjectDriftCheckAt = 0;
    this.lastRefreshAt = this.lastStaleCheckAt;
    this.lastRefreshReason = reason;
  }

  private refreshNeededFromTrackedFiles(): SessionStaleReason | undefined {
    if (!this.trackedFileSignatures.size) {
      const configSignature = this.statSignature(this.configFilePath());
      if (configSignature !== this.configSignature) {
        return "config_changed";
      }
      return undefined;
    }
    for (const [file, signature] of this.trackedFileSignatures) {
      if (this.statSignature(file) !== signature) {
        return "tracked_files_changed";
      }
    }
    const configSignature = this.statSignature(this.configFilePath());
    if (configSignature !== this.configSignature) {
      return "config_changed";
    }
    return undefined;
  }

  private refreshNeededFromTrackedFile(file: string): SessionStaleReason | undefined {
    const resolved = normalizePath(path.resolve(file));
    const signature = this.trackedFileSignatures.get(resolved) ?? this.trackedFileSignatures.get(file);
    if (!signature) {
      return undefined;
    }
    return this.statSignature(resolved) !== signature ? "tracked_files_changed" : undefined;
  }

  private checkForStaleness(options: { force?: boolean } = {}): void {
    if (this.status !== "ready" || !this.index) return;
    const now = Date.now();
    if (!options.force && now - this.lastPassiveStaleCheckAt < CodeReviewSession.STALE_CHECK_INTERVAL_MS) return;
    this.lastPassiveStaleCheckAt = now;

    const configSignature = this.statSignature(this.configFilePath());
    if (configSignature !== this.configSignature) {
      this.staleReason = "config_changed";
      this.forceFullRefreshOnNextStaleCheck = false;
      return;
    }

    const projectFilesChanged = this.projectDirectoriesChanged();
    this.staleReason = projectFilesChanged ? "tracked_files_changed" : undefined;
    this.forceFullRefreshOnNextStaleCheck = projectFilesChanged;
  }

  private checkForStalenessNow(options: { force?: boolean; file?: string; scanTrackedFiles?: boolean } = {}): void {
    if (this.status !== "ready" || !this.index) return;
    const now = Date.now();
    const targetReason = options.file ? this.refreshNeededFromTrackedFile(options.file) : undefined;
    if (targetReason) {
      this.lastStaleCheckAt = now;
      this.staleReason = targetReason;
      this.forceFullRefreshOnNextStaleCheck = false;
      return;
    }

    const trackedScanDue =
      options.force ||
      (options.scanTrackedFiles && now - this.lastTrackedFileScanAt >= CodeReviewSession.STALE_CHECK_INTERVAL_MS);
    const navigationProjectDriftDue =
      options.force ||
      (!options.scanTrackedFiles && now - this.lastStaleCheckAt >= CodeReviewSession.STALE_CHECK_INTERVAL_MS);
    const impactProjectDriftDue =
      options.force ||
      (options.scanTrackedFiles &&
        now - this.lastImpactProjectDriftCheckAt >= CodeReviewSession.STALE_CHECK_INTERVAL_MS);
    if (!trackedScanDue && !navigationProjectDriftDue && !impactProjectDriftDue) return;

    if (trackedScanDue) {
      this.lastTrackedFileScanAt = now;
      const trackedReason = this.refreshNeededFromTrackedFiles();
      if (trackedReason) {
        this.staleReason = trackedReason;
        this.forceFullRefreshOnNextStaleCheck = false;
        return;
      }
    }

    if (!navigationProjectDriftDue && !impactProjectDriftDue) return;
    if (navigationProjectDriftDue) {
      this.lastStaleCheckAt = now;
    }
    if (impactProjectDriftDue) {
      this.lastImpactProjectDriftCheckAt = now;
    }
    const configSignature = this.statSignature(this.configFilePath());
    if (configSignature !== this.configSignature) {
      this.staleReason = "config_changed";
      this.forceFullRefreshOnNextStaleCheck = false;
      return;
    }
    const projectFilesChanged = this.projectDirectoriesChanged();
    this.staleReason = projectFilesChanged ? "tracked_files_changed" : undefined;
    this.forceFullRefreshOnNextStaleCheck = projectFilesChanged;
  }
  private commitReadyIndex(
    index: ProjectIndex,
    reason: "initialization" | "manual" | "stale_check",
    report: BuildReport,
    projectFiles: string[],
  ): void {
    this.index = index;
    this.buildReport = report;
    this.status = "ready";
    this.captureFreshnessBaseline(index, reason, projectFiles);
    this.forceFullRefreshOnNextStaleCheck = false;
    this.touch();
  }

  /**
   * Initialize the session (builds the index)
   */
  async init(): Promise<void> {
    if (this.status === "ready" && this.index) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    const lifecycleVersion = this.lifecycleVersion;
    const initState: { promise: Promise<void> | null } = { promise: null };
    const initPromise = (async () => {
      const previousStatus = this.status;
      try {
        this.status = "initializing";
        const nextBuild = await this.buildIndex();
        this.assertLifecycleVersion(lifecycleVersion, "initialization");
        this.commitReadyIndex(nextBuild.index, "initialization", nextBuild.report, nextBuild.projectFiles);
      } catch (error) {
        if (this.lifecycleVersion === lifecycleVersion) {
          this.status = previousStatus === "expired" ? "expired" : "error";
        }
        throw error;
      } finally {
        if (this.initPromise === initState.promise) {
          this.initPromise = null;
        }
      }
    })();
    initState.promise = initPromise;
    this.initPromise = initPromise;

    return this.initPromise;
  }

  /**
   * Check if session is ready
   */
  isReady(): boolean {
    this.checkExpiration();
    this.checkForStaleness();
    return this.status === "ready";
  }

  /**
   * Get the current status
   */
  getStatus(): SessionStatus {
    this.checkExpiration();
    this.checkForStaleness();
    return this.status;
  }

  /**
   * Update last activity timestamp
   */
  private touch(): void {
    this.lastActivity = Date.now();
  }

  /**
   * Check if session has expired
   */
  private checkExpiration(): void {
    if (this.status === "ready" && Date.now() - this.lastActivity > this.timeout) {
      this.status = "expired";
      this.index = null;
    }
  }

  /**
   * Get the project index (throws if not ready)
   */
  private getIndex(): ProjectIndex {
    this.checkExpiration();
    if (this.status !== "ready" || !this.index) {
      throw new Error(`Session not ready (status: ${this.status})`);
    }
    this.touch();
    return this.index;
  }

  private async ensureFreshIndex(
    options: { force?: boolean; file?: string; scanTrackedFiles?: boolean } = {},
  ): Promise<ProjectIndex> {
    this.checkExpiration();
    if (this.refreshPromise) {
      await this.refreshPromise;
      return this.getIndex();
    }
    this.checkForStalenessNow(options);
    const index = this.getIndex();
    if (!this.staleReason) {
      return index;
    }
    await this.refreshInternal("stale_check");
    return this.getIndex();
  }

  private async refreshForExistingUnindexedFile(file: string): Promise<ProjectIndex | undefined> {
    if (!fs.existsSync(file)) {
      return undefined;
    }
    this.staleReason = "tracked_files_changed";
    this.forceFullRefreshOnNextStaleCheck = true;
    await this.refreshInternal("stale_check");
    return this.getIndex();
  }

  /**
   * Analyze impact from a diff
   * Results are cached in the warm index
   */
  async analyzeImpact(options: ImpactOptions): Promise<ImpactReport | CompactImpactReport> {
    const index = await this.ensureFreshIndex({ scanTrackedFiles: true });
    requireSessionImpactProvider(options);
    return await analyzeImpactFromDiff(this.root, index, options, { buildReport: this.buildReport });
  }

  /**
   * Stream impact analysis results
   * Better for agents as they can start processing immediately
   */
  async *analyzeImpactStream(options: ImpactStreamingOptions): AsyncGenerator<ImpactStreamChunk> {
    const index = await this.ensureFreshIndex({ scanTrackedFiles: true });
    requireSessionImpactProvider(options);
    yield* analyzeImpactStreaming(this.root, index, options, { buildReport: this.buildReport });
  }

  /**
   * Find references to a symbol
   */
  async findReferences(params: { file: string; line: number; column: number }): Promise<SessionFindReferencesResult> {
    const resolved = resolveSessionFileInput(this.root, params.file, "Session file");
    if (resolved.status === "error") {
      return resolved;
    }
    const index = await this.ensureFreshIndex({ file: resolved.file });
    const result = await findReferences(index, {
      ...params,
      file: resolved.file,
    });
    if (result.status === "not_found" && result.reason === "File not indexed") {
      const refreshedIndex = await this.refreshForExistingUnindexedFile(resolved.file);
      if (refreshedIndex) {
        return await findReferences(refreshedIndex, {
          ...params,
          file: resolved.file,
        });
      }
    }
    return result;
  }

  /**
   * Go to definition of a symbol
   */
  async goToDefinition(params: { file: string; line: number; column: number }): Promise<SessionGoToDefinitionResult> {
    const resolved = resolveSessionFileInput(this.root, params.file, "Session file");
    if (resolved.status === "error") {
      return resolved;
    }
    const index = await this.ensureFreshIndex({ file: resolved.file });
    const result = await goToDefinition(index, {
      ...params,
      file: resolved.file,
    });
    if (result.status === "not_found" && result.reason === "File not indexed") {
      const refreshedIndex = await this.refreshForExistingUnindexedFile(resolved.file);
      if (refreshedIndex) {
        return await goToDefinition(refreshedIndex, {
          ...params,
          file: resolved.file,
        });
      }
    }
    return result;
  }

  /**
   * Refresh the index (manual full rebuild; stale checks full rebuild only after file-set drift)
   */
  private async refreshInternal(refreshReason: "manual" | "stale_check"): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }
    const refreshPromise = this.performRefresh(refreshReason);
    this.refreshPromise = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (this.refreshPromise === refreshPromise) {
        this.refreshPromise = null;
      }
    }
  }

  private async performRefresh(refreshReason: "manual" | "stale_check"): Promise<void> {
    const previousIndex = this.index;
    const previousStatus = this.status;
    const lifecycleVersion = this.lifecycleVersion;
    this.status = "initializing";
    try {
      const forceFull =
        refreshReason === "manual" || (refreshReason === "stale_check" && this.forceFullRefreshOnNextStaleCheck);
      const nextBuild = await this.buildIndex({ forceFull });
      this.assertLifecycleVersion(lifecycleVersion, "refresh");
      this.commitReadyIndex(nextBuild.index, refreshReason, nextBuild.report, nextBuild.projectFiles);
    } catch (error) {
      if (this.lifecycleVersion !== lifecycleVersion) {
        throw error;
      }
      if (previousIndex && previousStatus === "ready") {
        this.index = previousIndex;
        this.status = "ready";
      } else {
        this.status = "error";
      }
      throw error;
    }
  }

  async refresh(): Promise<void> {
    await this.refreshInternal("manual");
  }

  /**
   * Dispose of the session and free resources
   */
  dispose(): void {
    this.lifecycleVersion += 1;
    this.status = "expired";
    this.index = null;
    this.initPromise = null;
  }

  /**
   * Get session statistics
   */
  getStats(): SessionStats {
    this.checkExpiration();
    this.checkForStaleness();

    const index = this.index;
    const fileCount = index?.byFile.size ?? 0;
    const symbolCount = index ? Array.from(index.byFile.values()).reduce((sum, mod) => sum + mod.locals.length, 0) : 0;

    const ready = this.status === "ready";
    const staleReason = ready ? this.staleReason : undefined;

    return {
      status: this.status,
      fileCount,
      symbolCount,
      lastActivity: new Date(this.lastActivity),
      timeUntilExpiration: this.status === "ready" ? Math.max(0, this.timeout - (Date.now() - this.lastActivity)) : 0,
      stale: !!staleReason,
      ...(staleReason ? { staleReason } : {}),
      ...(this.lastRefreshAt ? { lastRefreshAt: new Date(this.lastRefreshAt) } : {}),
      ...(this.lastRefreshReason ? { lastRefreshReason: this.lastRefreshReason } : {}),
    };
  }
}

function normalizeSessionManagerCapacity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SESSION_MANAGER_MAX_SESSIONS;
  return Math.max(1, Math.floor(value));
}

function normalizeSessionManagerEvictionInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SESSION_MANAGER_EVICTION_INTERVAL_MS;
  return Math.max(0, Math.floor(value));
}

/**
 * Session manager for multiple concurrent sessions
 * Useful for agents handling multiple repositories or PRs
 */
export class SessionManager {
  private sessions = new Map<string, CodeReviewSession>();
  private pendingSessions = new Map<
    string,
    {
      cancelled: boolean;
      fingerprint: string;
      retainPending: boolean;
      promise: Promise<CodeReviewSession>;
    }
  >();
  private readonly maxSessions: number;
  private readonly evictionTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: SessionManagerOptions = {}) {
    this.maxSessions = normalizeSessionManagerCapacity(options.maxSessions);
    const evictionIntervalMs = normalizeSessionManagerEvictionInterval(options.evictionIntervalMs);
    if (evictionIntervalMs) {
      this.evictionTimer = setInterval(() => this.cleanupExpired(), evictionIntervalMs);
      this.evictionTimer.unref?.();
    }
  }

  private assertCapacityForNewSession(): void {
    this.cleanupExpired();
    if (this.sessions.size + this.pendingSessions.size >= this.maxSessions) {
      throw new Error(
        `Session capacity reached (${this.maxSessions}). Dispose an existing session before creating another.`,
      );
    }
  }

  private createSessionConfigurationError(
    sessionId: string,
    existing: CodeReviewSession,
    options: SessionOptions,
  ): Error {
    return new Error(
      `Session "${sessionId}" already exists for a different configuration (existing root: ${existing.getRoot()}, requested root: ${path.resolve(options.root)}). Use a different session id or dispose the existing session first.`,
    );
  }

  private ensureSessionIdCompatible(sessionId: string, options: SessionOptions): CodeReviewSession | undefined {
    const existing = this.sessions.get(sessionId);
    if (!existing) return undefined;
    if (!existing.matchesOptions(options)) {
      throw this.createSessionConfigurationError(sessionId, existing, options);
    }
    return existing;
  }

  private getPendingCompatibleSession(
    sessionId: string,
    options: SessionOptions,
  ): Promise<CodeReviewSession> | undefined {
    const pending = this.pendingSessions.get(sessionId);
    if (!pending) return undefined;
    const requestedFingerprint = sessionIdentityFingerprint(resolveSessionIdentity(options));
    if (pending.fingerprint !== requestedFingerprint) {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        throw this.createSessionConfigurationError(sessionId, existing, options);
      }
      throw new Error(`Session "${sessionId}" is already initializing with a different configuration.`);
    }
    return pending.promise;
  }

  private trackSession(
    sessionId: string,
    options: SessionOptions,
    session: CodeReviewSession,
    retainPending: boolean,
    onReady: (session: CodeReviewSession) => void,
  ): Promise<CodeReviewSession> {
    const fingerprint = sessionIdentityFingerprint(resolveSessionIdentity(options));
    const pendingSession = {
      cancelled: false,
      fingerprint,
      retainPending,
      promise: Promise.resolve(session),
    };
    const promise = (async () => {
      try {
        await session.init();
        if (pendingSession.cancelled) {
          session.dispose();
          throw new Error(`Session "${sessionId}" was disposed during initialization.`);
        }
        onReady(session);
        return session;
      } catch (error) {
        session.dispose();
        throw error;
      }
    })();
    pendingSession.promise = promise;
    this.pendingSessions.set(sessionId, pendingSession);
    promise
      .finally(() => {
        const pending = this.pendingSessions.get(sessionId);
        if (pending?.promise === promise && !pending.retainPending) {
          this.pendingSessions.delete(sessionId);
        }
      })
      .catch(() => {});
    return promise;
  }

  /**
   * Create or get a session for a repository
   */
  async getOrCreateSession(sessionId: string, options: SessionOptions): Promise<CodeReviewSession> {
    const pending = this.getPendingCompatibleSession(sessionId, options);
    if (pending) {
      return await pending;
    }

    let session = this.ensureSessionIdCompatible(sessionId, options);

    if (!session) {
      this.assertCapacityForNewSession();
      session = new CodeReviewSession(options);
      return await this.trackSession(sessionId, options, session, false, (readySession) => {
        this.sessions.set(sessionId, readySession);
      });
    } else if (!session.isReady()) {
      try {
        await session.init();
      } catch (error) {
        this.sessions.delete(sessionId);
        session.dispose();
        throw error;
      }
    }

    return session;
  }

  /**
   * Get an existing session
   */
  getSession(sessionId: string): CodeReviewSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Dispose of a session
   */
  disposeSession(sessionId: string): void {
    const pending = this.pendingSessions.get(sessionId);
    if (pending) {
      pending.cancelled = true;
      this.pendingSessions.delete(sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      session.dispose();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Dispose of all sessions
   */
  disposeAll(): void {
    for (const pending of this.pendingSessions.values()) {
      pending.cancelled = true;
    }
    this.pendingSessions.clear();
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    clearInterval(this.evictionTimer);
  }

  /**
   * Get all session IDs
   */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpired(): void {
    const toRemove: string[] = [];
    for (const [id, session] of this.sessions.entries()) {
      if (session.getStatus() === "expired") {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.disposeSession(id);
    }
  }

  /**
   * Get statistics for all sessions
   */
  getAllStats(): Record<string, ReturnType<CodeReviewSession["getStats"]>> {
    const stats: Record<string, ReturnType<CodeReviewSession["getStats"]>> = {};
    for (const [id, session] of this.sessions.entries()) {
      stats[id] = session.getStats();
    }
    return stats;
  }

  /**
   * Pre-warm sessions for faster initial queries.
   * Useful for Lambda/serverless cold start optimization.
   * @param sessions - Array of session configs to pre-warm
   */
  async warmup(sessions: Array<{ id: string; options: SessionOptions }>): Promise<void> {
    const requestedFingerprints = new Map<string, string>();
    const replacementSessions: Array<{
      id: string;
      existing?: CodeReviewSession;
      session: CodeReviewSession;
    }> = [];
    const warmupPromises: Promise<CodeReviewSession>[] = [];
    try {
      for (const { id, options } of sessions) {
        const requestedFingerprint = sessionIdentityFingerprint(resolveSessionIdentity(options));
        const existingFingerprint = requestedFingerprints.get(id);
        if (existingFingerprint && existingFingerprint !== requestedFingerprint) {
          throw new Error(`Warmup requested conflicting configurations for session "${id}".`);
        }
        if (existingFingerprint === requestedFingerprint) {
          continue;
        }
        requestedFingerprints.set(id, requestedFingerprint);

        const pending = this.getPendingCompatibleSession(id, options);
        if (pending) {
          warmupPromises.push(pending);
          continue;
        }

        const existing = this.ensureSessionIdCompatible(id, options);
        if (existing?.isReady()) {
          continue;
        }
        if (!existing) this.assertCapacityForNewSession();
        const session = new CodeReviewSession(options);
        replacementSessions.push(existing ? { id, existing, session } : { id, session });
        warmupPromises.push(this.trackSession(id, options, session, true, () => {}));
      }
      await Promise.all(warmupPromises);
    } catch (error) {
      for (const replacement of replacementSessions) {
        const pending = this.pendingSessions.get(replacement.id);
        if (pending) {
          pending.cancelled = true;
          pending.retainPending = false;
          void pending.promise
            .finally(() => {
              if (this.pendingSessions.get(replacement.id) === pending && !pending.retainPending) {
                this.pendingSessions.delete(replacement.id);
              }
            })
            .catch(() => {});
        }
        replacement.session.dispose();
      }
      throw error;
    }
    for (const replacement of replacementSessions) {
      const pending = this.pendingSessions.get(replacement.id);
      if (!pending || pending.cancelled) {
        replacement.session.dispose();
        continue;
      }
      replacement.existing?.dispose();
      this.sessions.set(replacement.id, replacement.session);
      this.pendingSessions.delete(replacement.id);
    }
  }
}

/**
 * Create a new code review session
 * Convenience function for creating a session
 */
export async function createCodeReviewSession(options: SessionOptions): Promise<CodeReviewSession> {
  const session = new CodeReviewSession(options);
  await session.init();
  return session;
}
