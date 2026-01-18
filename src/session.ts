/**
 * Session management for conversation-aware caching
 * Maintains warm caches across multiple queries for better agent UX
 */

import type { ProjectIndex, BuildOptions } from "./indexer.js";
import { buildProjectIndex, buildProjectIndexIncremental, findReferences, goToDefinition } from "./indexer.js";
import { analyzeImpactFromDiff, type ImpactOptions, type ImpactReport, type CompactImpactReport } from "./impact/index.js";
import { analyzeImpactStreaming, type ImpactStreamChunk } from "./impact/streaming.js";

export type SessionOptions = {
  /** Project root directory */
  root: string;

  /** Build options for the index */
  buildOptions?: BuildOptions;

  /** Session timeout in milliseconds (default: 30 minutes) */
  timeout?: number;

  /** Whether to use incremental indexing (default: true) */
  incremental?: boolean;
};

export type SessionStatus = "initializing" | "ready" | "expired" | "error";

/**
 * A code review session that maintains warm caches
 * Use this to avoid rebuilding the index for multiple queries
 */
export class CodeReviewSession {
  private index: ProjectIndex | null = null;
  private status: SessionStatus = "initializing";
  private lastActivity: number = Date.now();
  private timeout: number;
  private root: string;
  private buildOptions: BuildOptions | undefined;
  private incremental: boolean;
  private initPromise: Promise<void> | null = null;

  constructor(options: SessionOptions) {
    this.root = options.root;
    this.buildOptions = options.buildOptions;
    this.timeout = options.timeout ?? 30 * 60 * 1000; // 30 minutes default
    this.incremental = options.incremental ?? true;
  }

  /**
   * Initialize the session (builds the index)
   */
  async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        this.status = "initializing";

        if (this.incremental) {
          this.index = await buildProjectIndexIncremental(this.root, this.buildOptions);
        } else {
          this.index = await buildProjectIndex(this.root, this.buildOptions);
        }

        this.status = "ready";
        this.lastActivity = Date.now();
      } catch (error) {
        this.status = "error";
        throw error;
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

  /**
   * Analyze impact from a diff
   * Results are cached in the warm index
   */
  async analyzeImpact(
    options: Omit<ImpactOptions, "provider"> & { provider?: ImpactOptions["provider"] },
  ): Promise<ImpactReport | CompactImpactReport> {
    const index = this.getIndex();
    return await analyzeImpactFromDiff(this.root, index, options as ImpactOptions);
  }

  /**
   * Stream impact analysis results
   * Better for agents as they can start processing immediately
   */
  async *analyzeImpactStream(
    options: Omit<ImpactOptions, "provider"> & { provider?: ImpactOptions["provider"] },
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
    this.status = "initializing";
    try {
      if (this.incremental) {
        this.index = await buildProjectIndexIncremental(this.root, this.buildOptions);
      } else {
        this.index = await buildProjectIndex(this.root, this.buildOptions);
      }
      this.status = "ready";
      this.touch();
    } catch (error) {
      this.status = "error";
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

  /**
   * Create or get a session for a repository
   */
  async getOrCreateSession(
    sessionId: string,
    options: SessionOptions,
  ): Promise<CodeReviewSession> {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = new CodeReviewSession(options);
      this.sessions.set(sessionId, session);
      await session.init();
    } else if (!session.isReady()) {
      // Re-initialize if expired
      await session.init();
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
