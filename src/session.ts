/**
 * Session management for conversation-aware caching
 * Maintains warm caches across multiple queries for better agent UX
 */

import path from "node:path";
import type { ProjectIndex, BuildOptions } from "./indexer.js";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  findReferences,
  goToDefinition,
} from "./indexer.js";
import {
  analyzeImpactFromDiff,
  type ImpactOptions,
  type ImpactReport,
  type CompactImpactReport,
} from "./impact/index.js";
import {
  analyzeImpactStreaming,
  type ImpactStreamChunk,
} from "./impact/streaming.js";
import { getSessionPreset, mergePreset, type PresetName } from "./presets.js";

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

export type SessionStatus = "initializing" | "ready" | "expired" | "error";

type SessionIdentity = {
  root: string;
  timeout: number;
  incremental: boolean;
  buildOptions?: Record<string, unknown>;
};

function normalizeStringArray(values?: string[]): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  return [...values].sort();
}

function normalizeBuildOptions(
  options?: BuildOptions,
): Record<string, unknown> | undefined {
  if (!options) return undefined;
  return {
    cache: options.cache,
    cacheDir: options.cacheDir ? path.resolve(options.cacheDir) : undefined,
    cacheStrict: options.cacheStrict,
    useBloomFilters: options.useBloomFilters,
    preset: options.preset,
    graph: options.graph
      ? {
          fast: options.graph.fast,
          resolveNodeModules: options.graph.resolveNodeModules,
          dynamicImportHeuristics: options.graph.dynamicImportHeuristics,
          native: options.graph.native,
          logLevel: options.graph.logLevel,
          resolutionHints: normalizeStringArray(options.graph.resolutionHints),
          fastRegexDisabledLanguages: normalizeStringArray(
            options.graph.fastRegexDisabledLanguages,
          ),
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
          gitignoreRoot: options.discovery.gitignoreRoot
            ? path.resolve(options.discovery.gitignoreRoot)
            : undefined,
        }
      : undefined,
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
      ...(normalizedBuildOptions
        ? { buildOptions: normalizedBuildOptions }
        : {}),
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

/**
 * Interface for CodeReviewSession for TypeScript consumers.
 * Use this type when you need to type a session parameter without coupling to the class.
 */
export interface ICodeReviewSession {
  init(): Promise<void>;
  isReady(): boolean;
  getStatus(): SessionStatus;
  analyzeImpact(
    options: Omit<ImpactOptions, "provider"> & {
      provider?: ImpactOptions["provider"];
    },
  ): Promise<ImpactReport | CompactImpactReport>;
  findReferences(params: {
    file: string;
    line: number;
    column: number;
  }): Promise<unknown>;
  goToDefinition(params: {
    file: string;
    line: number;
    column: number;
  }): Promise<unknown>;
  refresh(): Promise<void>;
  dispose(): void;
  getStats(): {
    status: SessionStatus;
    fileCount: number;
    symbolCount: number;
    lastActivity: Date;
    timeUntilExpiration: number;
  };
}

/**
 * A code review session that maintains warm caches
 * Use this to avoid rebuilding the index for multiple queries
 */
export class CodeReviewSession implements ICodeReviewSession {
  private index: ProjectIndex | null = null;
  private status: SessionStatus = "initializing";
  private lastActivity: number = Date.now();
  private timeout: number;
  private root: string;
  private buildOptions: BuildOptions | undefined;
  private incremental: boolean;
  private initPromise: Promise<void> | null = null;
  private identityFingerprint: string;

  constructor(options: SessionOptions) {
    const identity = resolveSessionIdentity(options);
    this.root = identity.root;
    this.buildOptions = options.preset
      ? (options.buildOptions
          ? mergePreset(
              getSessionPreset(options.preset, options.root).buildOptions ?? {},
              options.buildOptions,
            )
          : getSessionPreset(options.preset, options.root).buildOptions)
      : options.buildOptions;
    this.timeout = identity.timeout;
    this.incremental = identity.incremental;
    this.identityFingerprint = sessionIdentityFingerprint(identity);
  }

  matchesOptions(options: SessionOptions): boolean {
    return (
      this.identityFingerprint ===
      sessionIdentityFingerprint(resolveSessionIdentity(options))
    );
  }

  getRoot(): string {
    return this.root;
  }

  private async buildIndex(): Promise<ProjectIndex> {
    if (this.incremental) {
      return await buildProjectIndexIncremental(this.root, this.buildOptions);
    }
    return await buildProjectIndex(this.root, this.buildOptions);
  }

  private commitReadyIndex(index: ProjectIndex): void {
    this.index = index;
    this.status = "ready";
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

    this.initPromise = (async () => {
      const previousStatus = this.status;
      try {
        this.status = "initializing";
        const nextIndex = await this.buildIndex();
        this.commitReadyIndex(nextIndex);
      } catch (error) {
        this.status = previousStatus === "expired" ? "expired" : "error";
        throw error;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Check if session is ready
   */
  isReady(): boolean {
    this.checkExpiration();
    return this.status === "ready";
  }

  /**
   * Get the current status
   */
  getStatus(): SessionStatus {
    this.checkExpiration();
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
    if (
      this.status === "ready" &&
      Date.now() - this.lastActivity > this.timeout
    ) {
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

  /**
   * Analyze impact from a diff
   * Results are cached in the warm index
   */
  async analyzeImpact(
    options: Omit<ImpactOptions, "provider"> & {
      provider?: ImpactOptions["provider"];
    },
  ): Promise<ImpactReport | CompactImpactReport> {
    const index = this.getIndex();
    return await analyzeImpactFromDiff(
      this.root,
      index,
      options as ImpactOptions,
    );
  }

  /**
   * Stream impact analysis results
   * Better for agents as they can start processing immediately
   */
  async *analyzeImpactStream(
    options: Omit<ImpactOptions, "provider"> & {
      provider?: ImpactOptions["provider"];
    },
  ): AsyncGenerator<ImpactStreamChunk> {
    const index = this.getIndex();
    yield* analyzeImpactStreaming(this.root, index, options as ImpactOptions);
  }

  /**
   * Find references to a symbol
   */
  async findReferences(params: { file: string; line: number; column: number }) {
    const index = this.getIndex();
    return await findReferences(index, params);
  }

  /**
   * Go to definition of a symbol
   */
  async goToDefinition(params: { file: string; line: number; column: number }) {
    const index = this.getIndex();
    return await goToDefinition(index, params);
  }

  /**
   * Refresh the index (incremental rebuild)
   */
  async refresh(): Promise<void> {
    const previousIndex = this.index;
    const previousStatus = this.status;
    this.status = "initializing";
    try {
      const nextIndex = await this.buildIndex();
      this.commitReadyIndex(nextIndex);
    } catch (error) {
      if (previousIndex && previousStatus === "ready") {
        this.index = previousIndex;
        this.status = "ready";
      } else {
        this.status = "error";
      }
      throw error;
    }
  }

  /**
   * Dispose of the session and free resources
   */
  dispose(): void {
    this.status = "expired";
    this.index = null;
  }

  /**
   * Get session statistics
   */
  getStats(): {
    status: SessionStatus;
    fileCount: number;
    symbolCount: number;
    lastActivity: Date;
    timeUntilExpiration: number;
  } {
    this.checkExpiration();

    const index = this.index;
    const fileCount = index?.byFile.size ?? 0;
    const symbolCount = index
      ? Array.from(index.byFile.values()).reduce(
          (sum, mod) => sum + mod.locals.length,
          0,
        )
      : 0;

    return {
      status: this.status,
      fileCount,
      symbolCount,
      lastActivity: new Date(this.lastActivity),
      timeUntilExpiration: Math.max(
        0,
        this.timeout - (Date.now() - this.lastActivity),
      ),
    };
  }
}

/**
 * Session manager for multiple concurrent sessions
 * Useful for agents handling multiple repositories or PRs
 */
export class SessionManager {
  private sessions = new Map<string, CodeReviewSession>();

  private ensureSessionIdCompatible(
    sessionId: string,
    options: SessionOptions,
  ): CodeReviewSession | undefined {
    const existing = this.sessions.get(sessionId);
    if (!existing) return undefined;
    if (!existing.matchesOptions(options)) {
      throw new Error(
        `Session "${sessionId}" already exists for a different configuration (existing root: ${existing.getRoot()}, requested root: ${path.resolve(options.root)}). Use a different session id or dispose the existing session first.`,
      );
    }
    return existing;
  }

  /**
   * Create or get a session for a repository
   */
  async getOrCreateSession(
    sessionId: string,
    options: SessionOptions,
  ): Promise<CodeReviewSession> {
    let session = this.ensureSessionIdCompatible(sessionId, options);

    if (!session) {
      session = new CodeReviewSession(options);
      try {
        await session.init();
      } catch (error) {
        session.dispose();
        throw error;
      }
      this.sessions.set(sessionId, session);
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
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
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
  async warmup(
    sessions: Array<{ id: string; options: SessionOptions }>,
  ): Promise<void> {
    const requestedFingerprints = new Map<string, string>();
    const replacementSessions: Array<{
      id: string;
      existing?: CodeReviewSession;
      session: CodeReviewSession;
    }> = [];
    const initializedSessions: Array<{ id: string; session: CodeReviewSession }> =
      [];
    try {
      for (const { id, options } of sessions) {
        const requestedFingerprint = sessionIdentityFingerprint(
          resolveSessionIdentity(options),
        );
        const existingFingerprint = requestedFingerprints.get(id);
        if (existingFingerprint && existingFingerprint !== requestedFingerprint) {
          throw new Error(
            `Warmup requested conflicting configurations for session "${id}".`,
          );
        }
        if (existingFingerprint === requestedFingerprint) {
          continue;
        }
        requestedFingerprints.set(id, requestedFingerprint);

        const existing = this.ensureSessionIdCompatible(id, options);
        if (existing?.isReady()) {
          continue;
        }
        const session = new CodeReviewSession(options);
        await session.init();
        initializedSessions.push({ id, session });
        replacementSessions.push(
          existing ? { id, existing, session } : { id, session },
        );
      }
    } catch (error) {
      for (const { session } of initializedSessions) {
        session.dispose();
      }
      throw error;
    }
    for (const replacement of replacementSessions) {
      replacement.existing?.dispose();
      this.sessions.set(replacement.id, replacement.session);
    }
  }
}

/**
 * Create a new code review session
 * Convenience function for creating a session
 */
export async function createCodeReviewSession(
  options: SessionOptions,
): Promise<CodeReviewSession> {
  const session = new CodeReviewSession(options);
  await session.init();
  return session;
}
