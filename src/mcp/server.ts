import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import path from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";
import {
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  NodeStreamableHTTPServerTransport,
  originValidation,
  toNodeHandler,
  toWebRequest,
  type NodeIncomingMessageLike,
  type NodeMcpRequestHandler,
} from "@modelcontextprotocol/node";
import { z } from "zod";
import { buildCodegraphArtifactWithSession } from "../agent/artifact.js";
import type { CodegraphArtifactBuildResult } from "../agent/artifact.js";
import { explainCodegraphTargetWithSession } from "../agent/explain.js";
import type { AgentExplanation, AgentExplanationReference } from "../agent/explain.js";
import {
  getCodegraphFileViewWithSession,
  MAX_FILE_VIEW_BYTES,
  MAX_FILE_VIEW_LINES,
  type AgentFileViewResponse,
} from "../agent/fileView.js";
import { exploreCodegraphWithSession, type AgentExploreResponse } from "../agent/explore.js";
import { orientCodegraphWithSession, type AgentOrientBudget, type AgentOrientResponse } from "../agent/orient.js";
import { getCodegraphPacketWithSession, type AgentPacketResponse } from "../agent/packet.js";
import { MAX_GRAPH_DEPTH, searchCodegraphWithSession } from "../agent/search.js";
import type { AgentSearchMode, AgentSearchResponse } from "../agent/search.js";
import { workspaceSymbolsWithSession, type WorkspaceSymbolsResponse } from "../agent/workspaceSymbols.js";
import {
  findImplementationsWithSession,
  findSubtypesWithSession,
  findSupertypesWithSession,
  type ImplementationsResponse,
  type TypeHierarchyResponse,
} from "../agent/typeHierarchy.js";
import { findCalleesWithSession, findCallersWithSession, type CallHierarchyResponse } from "../agent/callHierarchy.js";
import { previewRenameWithSession, type RenamePreviewResponse } from "../agent/renamePreview.js";
import { buildRefactorPlanWithSession, type RefactorPlanResponse } from "../agent/refactorPlan.js";
import { parseAgentSymbolHandle } from "../agent/handles.js";
import { requireSemanticSymbol, resolveSemanticSymbol } from "../agent/semanticSymbols.js";
import { getDependencies, getReverseDependencies, getShortestPath, type DependencyNode } from "../graphs/queries.js";
import { findReferences, goToDefinition } from "../indexer/navigation.js";
import { parseQualifiedSymbolPath } from "../indexer/symbols.js";
import { analyzeImpactFromDiff, type CompactImpactReport } from "../impact/index.js";
import { DEFAULT_BOUNDED_IMPACT_BUDGETS } from "../impact/budgets.js";
import { buildReviewReport, type ReviewDepth } from "../review.js";
import { boundReviewReportForTransport, type ReviewReportForTransport } from "../review/types.js";
import { SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY, queryGraphSqliteRaw, type RawSqlResult } from "../sqlite.js";
import { boundList, countOmitted } from "../presentation/bounds.js";
import { isPlainRecord } from "../util/guards.js";
import { toProjectDisplayPath } from "../util/paths.js";
import { errorMessage } from "../util/errors.js";
import {
  assertNoPrebuiltSessionWithBuildOptions,
  createAgentSession,
  listAgentSessionFiles,
} from "../agent/session.js";
import { mapLimit } from "../util/concurrency.js";
import { assertRealPathCandidateWithinRoot, resolveProjectFile } from "../util/confinedFile.js";
import type { AgentFreshnessResult, AgentProjectSnapshot, AgentSession } from "../agent/session.js";
import { SymbolKind } from "../indexer/types.js";
import { DEFAULT_WORKSPACE_SYMBOL_LIMIT, MAX_WORKSPACE_SYMBOL_LIMIT } from "../indexer/workspace-symbols.js";
import type { BuildOptions, FindReferencesResult, GoToResult } from "../indexer/types.js";
import {
  assertMcpSqliteQueryResourceBounded,
  DEFAULT_SQLITE_BYTE_LIMIT,
  normalizeSqliteRowLimit,
} from "./sqliteGuard.js";
import {
  DEFAULT_CALL_HIERARCHY_LIMIT,
  MAX_CALL_HIERARCHY_LIMIT,
  DEFAULT_MCP_COLLECTION_LIMIT,
  DEFAULT_TYPE_HIERARCHY_LIMIT,
  listCodegraphMcpTools,
  MAX_TYPE_HIERARCHY_LIMIT,
  MAX_MCP_COLLECTION_LIMIT,
  MAX_RENAME_PREVIEW_EDITS,
  MCP_TOOL_REGISTRY,
  MAX_REFACTOR_PLAN_LIMIT,
} from "./tools.js";
import {
  buildAllowedHostHeaders,
  buildAllowedOriginHostnames,
  closeHttpServer,
  emptyAllowedHostHeaderRules,
  formatHostForUrl,
  getHeaderValue,
  getHttpServerPort,
  getRequestPath,
  isAllowedHostHeader,
  listenOnHttpServer,
  readJsonRequestBody,
  waitForHttpServerClose,
  writeJsonResponse,
  writeJsonRpcError,
  type AllowedHostHeaderRules,
} from "./http.js";
import { getCurrentNativeBindingOrigin } from "../native/runtime.js";
import {
  captureCodegraphRuntimeIdentity,
  createInstalledVersionChecker,
  type CodegraphRuntimeIdentity,
  type InstalledVersionChecker,
} from "../runtimeIdentity.js";

export { listCodegraphMcpTools } from "./tools.js";
import { assertWritableDirectoryRealPathWithinRoot, resolveArtifactSqlitePathCandidate } from "./security.js";
import { awaitStdioMcpLifecycle, DEFAULT_MCP_STDIO_IDLE_TIMEOUT_MS } from "./stdioLifecycle.js";

export type CodegraphMcpWarmupMode = "off" | "base" | "symbols";

export type CodegraphMcpHandlerOptions = {
  root: string;
  artifactPath?: string;
  readOnly?: boolean;
  session?: AgentSession;
  buildOptions?: BuildOptions;
};

export type CodegraphMcpServerOptions = CodegraphMcpHandlerOptions & {
  warmup?: CodegraphMcpWarmupMode;
  host?: string;
  port?: number;
  /** Stdio-only idle exit timeout in ms. Use 0 to disable. Defaults to 30 minutes. */
  idleTimeoutMs?: number;
  /** HTTP session idle eviction timeout in ms. Use 0 to disable. Defaults to 30 minutes. */
  httpSessionIdleMs?: number;
  /** Maximum concurrent legacy HTTP MCP sessions. Defaults to 32. */
  httpSessionMaxCount?: number;
  /** How often to scan for idle HTTP sessions in ms. Defaults to 60 seconds. */
  httpSessionEvictionIntervalMs?: number;
  /** Maximum concurrent tool calls per MCP protocol session. Defaults to 4. */
  mcpToolConcurrency?: number;
  /** Maximum time to receive an HTTP MCP request body in ms. Defaults to 30 seconds. */
  httpBodyTimeoutMs?: number;
  /** Maximum time to execute one MCP tool call in ms. Use 0 to disable. Defaults to 30 minutes. */
  mcpToolTimeoutMs?: number;
  onHttpListen?: ((info: CodegraphMcpHttpServerInfo) => void) | undefined;
  runtimeIdentity?: CodegraphRuntimeIdentity;
};

export type CodegraphMcpHttpServerInfo = {
  host: string;
  port: number;
  url: string;
};

export type CodegraphMcpHttpServer = CodegraphMcpHttpServerInfo & {
  server: HttpServer;
  close: () => Promise<void>;
};

export const DEFAULT_MCP_HTTP_SESSION_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_MCP_HTTP_SESSION_MAX_COUNT = 32;
export const DEFAULT_MCP_HTTP_SESSION_EVICTION_INTERVAL_MS = 60_000;
export const DEFAULT_MCP_HTTP_BODY_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_MCP_HTTP_BODY_TIMEOUT_MS = 2_147_483_647;
const MAX_MCP_STDIO_FRAME_BYTES = 10 * 1024 * 1024;
const MAX_MCP_TOOL_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_MCP_TOOL_CONCURRENCY = 4;
function normalizeMcpToolConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MCP_TOOL_CONCURRENCY;
  return Math.max(1, Math.floor(value));
}

function assertMcpHttpBodyTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MCP_HTTP_BODY_TIMEOUT_MS) {
    throw new RangeError(
      `httpBodyTimeoutMs must be a positive integer no greater than ${MAX_MCP_HTTP_BODY_TIMEOUT_MS}.`,
    );
  }
  return value;
}

function assertMcpToolTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MCP_TOOL_TIMEOUT_MS) {
    throw new RangeError(
      `mcpToolTimeoutMs must be a whole number from 0 through ${MAX_MCP_TOOL_TIMEOUT_MS}; 0 disables the deadline.`,
    );
  }
  return value;
}

type LegacyMcpSession = {
  server: Server;
  transport: NodeStreamableHTTPServerTransport;
  lastActivityAt: number;
  inFlightRequests: number;
  openSseStreams: number;
};

type OriginValidator = (request: IncomingMessage, response: ServerResponse) => boolean;
const legacyRequestAbortStorage = new AsyncLocalStorage<AbortSignal>();

export type CodegraphMcpFreshResult<T extends object> = T & { freshness: AgentFreshnessResult };

type McpToolExecutionOptions = {
  signal?: AbortSignal | undefined;
};

/**
 * Truncation metadata for a capped collection response, per finding #44:
 * lets a machine caller tell a complete result apart from a capped prefix.
 */
export type McpTruncationMeta = {
  limit: number;
  totalSeen: number;
  truncated: boolean;
  omitted: number;
};

type McpDependenciesResponse = CodegraphMcpFreshResult<
  McpTruncationMeta & { dependencies: Array<{ file: string; depth: number }> }
>;
type McpReverseDependenciesResponse = CodegraphMcpFreshResult<
  McpTruncationMeta & { reverseDependencies: Array<{ file: string; depth: number }> }
>;
type CodegraphMcpHandlerDefinitions = {
  search: (request: {
    query: string;
    mode?: AgentSearchMode | undefined;
    from?: string | undefined;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<CodegraphMcpFreshResult<AgentSearchResponse>>;
  workspace_symbols: (request: {
    query: string;
    kinds?: SymbolKind[] | undefined;
    exportedOnly?: boolean | undefined;
    includeImports?: boolean | undefined;
    fileGlob?: string | undefined;
    limit?: number | undefined;
  }) => Promise<WorkspaceSymbolsResponse>;
  rename_preview: (request: {
    handle: string;
    newName: string;
    includeComments?: boolean | undefined;
    includeStrings?: boolean | undefined;
    includeFilenames?: boolean | undefined;
    maxEdits?: number | undefined;
  }) => Promise<RenamePreviewResponse>;
  refactor_plan: (request: {
    handle: string;
    renameTo?: string | undefined;
    maxReferences?: number | undefined;
    maxCallers?: number | undefined;
    maxHierarchy?: number | undefined;
    includeSource?: boolean | undefined;
  }) => Promise<RefactorPlanResponse>;
  calls: (request: {
    direction: "callers" | "callees";
    handle: string;
    depth?: number | undefined;
    limit?: number | undefined;
    includeHeuristic?: boolean | undefined;
  }) => Promise<CallHierarchyResponse>;
  type_hierarchy: (request: {
    direction: "supertypes" | "subtypes";
    handle: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<TypeHierarchyResponse>;
  file_deps: (request: {
    direction: "deps" | "rdeps";
    file: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<
    CodegraphMcpFreshResult<
      McpTruncationMeta & {
        dependencies?: Array<{ file: string; depth: number }>;
        reverseDependencies?: Array<{ file: string; depth: number }>;
      }
    >
  >;
  callers: (request: {
    handle: string;
    depth?: number | undefined;
    limit?: number | undefined;
    includeHeuristic?: boolean | undefined;
  }) => Promise<CallHierarchyResponse>;
  callees: (request: {
    handle: string;
    depth?: number | undefined;
    limit?: number | undefined;
    includeHeuristic?: boolean | undefined;
  }) => Promise<CallHierarchyResponse>;
  supertypes: (request: {
    handle: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<TypeHierarchyResponse>;
  subtypes: (request: {
    handle: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<TypeHierarchyResponse>;
  implementations: (request: { handle: string; limit?: number | undefined }) => Promise<ImplementationsResponse>;
  explore: (request: {
    query: string;
    limit?: number | undefined;
    maxPackets?: number | undefined;
    maxPaths?: number | undefined;
    includeSource?: boolean | undefined;
  }) => Promise<CodegraphMcpFreshResult<AgentExploreResponse>>;
  orient: (request: {
    includeRoots?: string[] | undefined;
    budget?: AgentOrientBudget | undefined;
  }) => Promise<CodegraphMcpFreshResult<AgentOrientResponse>>;
  packet_get: (request: {
    target: string;
    maxSymbols?: number | undefined;
    maxSnippets?: number | undefined;
    maxDuplicates?: number | undefined;
  }) => Promise<CodegraphMcpFreshResult<AgentPacketResponse>>;
  get_file: (request: {
    file: string;
    offset?: number | undefined;
    limit?: number | undefined;
    maxBytes?: number | undefined;
    includeGraphContext?: boolean | undefined;
    allowSensitive?: boolean | undefined;
  }) => Promise<CodegraphMcpFreshResult<AgentFileViewResponse>>;
  get_symbol: (request: { handle: string }) => Promise<CodegraphMcpFreshResult<AgentExplanation["target"]>>;
  goto: (
    request: { handle: string } | { file: string; line: number; column: number },
  ) => Promise<CodegraphMcpFreshResult<GoToResult>>;
  refs: (
    request:
      | { handle: string; limit?: number | undefined }
      | { file: string; line: number; column: number; limit?: number | undefined },
  ) => Promise<CodegraphMcpFreshResult<McpTruncationMeta & { references: AgentExplanationReference[] }>>;
  deps: (request: {
    file: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<McpDependenciesResponse>;
  rdeps: (request: {
    file: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<McpReverseDependenciesResponse>;
  path: (request: { from: string; to: string }) => Promise<CodegraphMcpFreshResult<{ path: string[] | null }>>;
  impact: (request: { base: string; head: string }) => Promise<CodegraphMcpFreshResult<CompactImpactReport>>;
  review: (request: {
    base: string;
    head: string;
    reviewDepth?: ReviewDepth | undefined;
  }) => Promise<CodegraphMcpFreshResult<ReviewReportForTransport>>;
  refresh_index: (request: { warmup?: CodegraphMcpWarmupMode | undefined }) => Promise<{
    refreshed: true;
    warmup: CodegraphMcpWarmupMode;
  }>;
  query_sqlite: (
    request: {
      query: string;
      params?: Array<string | number | null> | undefined;
      limit?: number | undefined;
    },
    options?: McpToolExecutionOptions,
  ) => Promise<CodegraphMcpFreshResult<RawSqlResult>>;
  artifact_build: (request: {
    outDir?: string | undefined;
    sqlite?: boolean | undefined;
    graphJson?: boolean | undefined;
    report?: boolean | undefined;
    questions?: boolean | undefined;
    force?: boolean | undefined;
  }) => Promise<CodegraphMcpFreshResult<CodegraphArtifactBuildResult>>;
};

type WithAbortSignal<T extends { query_sqlite: unknown }> = {
  [K in Exclude<keyof T, "query_sqlite">]: T[K] extends (request: infer Request) => Promise<infer Result>
    ? (request: Request, signal?: AbortSignal) => Promise<Result>
    : never;
} & Pick<T, "query_sqlite">;

export type CodegraphMcpHandlers = WithAbortSignal<CodegraphMcpHandlerDefinitions> & {
  dispose(): void;
};

type McpDependencyRequest = {
  file: string;
  depth?: number | undefined;
  limit?: number | undefined;
};

type McpDependencyEntry = {
  file: string;
  depth: number;
};

type McpDependencyCollection = McpTruncationMeta & {
  entries: McpDependencyEntry[];
};

type SqliteArtifactFileSignature = {
  path: string;
  size: number;
  mtimeMs: number;
};

const MAX_MCP_FRESHNESS_CHANGED_FILES = 25;
const MAX_MCP_FRESHNESS_RETRIES = 3;
const SQLITE_ARTIFACT_STAT_CONCURRENCY = 64;

function assertMcpSessionOptions(options: CodegraphMcpHandlerOptions): void {
  assertNoPrebuiltSessionWithBuildOptions(options, "MCP server options");
}

function createCodegraphMcpSession(options: CodegraphMcpHandlerOptions, root: string): AgentSession {
  assertMcpSessionOptions(options);
  return (
    options.session ??
    createAgentSession({
      root,
      ...(options.buildOptions ? { buildOptions: options.buildOptions } : {}),
      freshness: { policy: "auto" },
    })
  );
}

function startCodegraphMcpWarmup(
  session: AgentSession,
  warmup: CodegraphMcpWarmupMode | undefined,
): Promise<AgentProjectSnapshot> | undefined {
  if (warmup === "base") {
    return session.loadProject({ symbolGraph: "skip" });
  }
  if (warmup === "symbols") {
    return session.loadProject();
  }
  return undefined;
}

type WarmedCodegraphMcpResources = {
  handlers: CodegraphMcpHandlers;
  session: AgentSession;
};

async function createWarmedCodegraphMcpResources(
  options: CodegraphMcpServerOptions,
): Promise<WarmedCodegraphMcpResources> {
  const root = path.resolve(options.root);
  const session = createCodegraphMcpSession(options, root);
  await startCodegraphMcpWarmup(session, options.warmup);
  const { warmup, host, port, onHttpListen, ...handlerOptions } = options;
  void warmup;
  void host;
  void port;
  void onHttpListen;
  return {
    handlers: createCodegraphMcpHandlersForSession({ ...handlerOptions, root }, session),
    session,
  };
}

const MCP_HTTP_PATH = "/mcp";
const MAX_MCP_HTTP_BODY_BYTES = 1_000_000;

export function createCodegraphMcpHandlers(options: CodegraphMcpHandlerOptions): CodegraphMcpHandlers {
  const root = path.resolve(options.root);
  const session = createCodegraphMcpSession(options, root);
  return createCodegraphMcpHandlersForSession(options, session);
}

function createCodegraphMcpHandlersForSession(
  options: CodegraphMcpHandlerOptions,
  session: AgentSession,
): CodegraphMcpHandlers {
  const root = path.resolve(options.root);
  const readOnly = options.readOnly ?? true;
  const realRoot = fs.realpath(root);
  const configuredSqlitePath = options.artifactPath
    ? resolveArtifactSqlitePathCandidate(root, options.artifactPath)
    : undefined;
  const configuredSqliteOutDir = configuredSqlitePath ? path.dirname(configuredSqlitePath) : undefined;
  const configuredSqliteCanRefresh = options.artifactPath ? !/\.(sqlite|db)$/i.test(options.artifactPath) : false;
  let sqlitePath = configuredSqlitePath;
  let sqliteOutDir = configuredSqliteOutDir;
  let sqliteCanRefresh = configuredSqliteCanRefresh;
  let refreshPromise: Promise<void> | undefined;
  let refreshEpoch = 0;

  let artifactWritePromise: Promise<void> | undefined;
  const withArtifactWriteLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = artifactWritePromise;
    const complete = Promise.withResolvers<void>();
    artifactWritePromise = complete.promise;
    try {
      if (previous) await previous.catch(() => undefined);
      return await operation();
    } finally {
      complete.resolve();
      if (artifactWritePromise === complete.promise) artifactWritePromise = undefined;
    }
  };
  const relative = (file: string): string => toProjectDisplayPath(root, file);
  const boundedLimit = (limit: number | undefined, fallback: number, max: number): number => {
    if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
    return Math.min(max, Math.max(0, Math.floor(limit)));
  };
  const staleFreshness = (files: readonly string[], reason: string): AgentFreshnessResult => {
    const changedFiles = [...files].sort();
    const boundedChangedFiles = changedFiles.slice(0, MAX_MCP_FRESHNESS_CHANGED_FILES);
    return {
      state: "stale",
      changedFiles: boundedChangedFiles,
      changedFileCount: changedFiles.length,
      omittedChangedFileCount: countOmitted(changedFiles.length, boundedChangedFiles.length),
      reason,
    };
  };
  const checkMcpFreshness = async (): Promise<AgentFreshnessResult> => {
    if (session.checkFreshness) return await session.checkFreshness();
    return { state: "fresh" };
  };
  const withFreshness = async <T extends object>(
    run: () => Promise<T>,
  ): Promise<T & { freshness: AgentFreshnessResult }> => {
    for (let attempt = 0; attempt < MAX_MCP_FRESHNESS_RETRIES; attempt += 1) {
      if (refreshPromise) await refreshPromise;
      const epoch = refreshEpoch;
      const freshness = await checkMcpFreshness();
      const result = await run();
      if (epoch === refreshEpoch && !refreshPromise) return { ...result, freshness };
    }
    throw new Error("Workspace refresh changed repeatedly while serving the request; retry after refresh completes.");
  };
  const formatSqliteFreshnessError = (freshness: AgentFreshnessResult): string => {
    if (freshness.state === "fresh") return "SQLite artifact freshness check unexpectedly failed.";
    const reason = freshness.state === "stale" ? freshness.reason : "workspace changed after artifact build";
    const changed = freshness.changedFiles.length ? ` Changed files: ${freshness.changedFiles.join(", ")}.` : "";
    const omitted =
      freshness.state === "stale" && freshness.omittedChangedFileCount
        ? ` Omitted changed files: ${freshness.omittedChangedFileCount}.`
        : "";
    let action = "run artifact_build";
    if (readOnly) {
      action = "rebuild the artifact with write access enabled";
    }
    if (freshness.state === "stale") {
      action = `run refresh_index, then ${action}`;
    }
    return `SQLite artifact is stale; ${action} before query_sqlite. ${reason}.${changed}${omitted}`;
  };
  const canRefreshSqliteArtifact = (): boolean => {
    if (!sqlitePath || !sqliteOutDir || readOnly || !sqliteCanRefresh) return false;
    return path.basename(sqlitePath) === "codegraph.sqlite";
  };
  const rebuildSqliteArtifactForQuery = async (): Promise<void> =>
    await withArtifactWriteLock(async () => {
      if (!sqliteOutDir) throw new Error("SQLite artifact output directory is unavailable.");
      const outDir = await assertWritableDirectoryRealPathWithinRoot(
        await realRoot,
        root,
        sqliteOutDir,
        "Artifact output directory",
      );
      const result = await buildCodegraphArtifactWithSession(session, {
        root,
        outDir,
        filterOutDir: outDir,
        sqlite: true,
        force: true,
      });
      const sqliteArtifact = result.artifacts.sqlite;
      if (!sqliteArtifact) throw new Error("SQLite artifact refresh did not produce a SQLite file.");
      sqlitePath = path.join(result.outDir, sqliteArtifact);
      sqliteOutDir = result.outDir;
    });
  const refreshSqliteArtifactForQuery = async (
    freshness: AgentFreshnessResult,
    refreshOptions?: { allowStaleRebuild?: boolean },
  ): Promise<AgentFreshnessResult> => {
    if (freshness.state === "fresh") return freshness;
    if (freshness.state === "stale" && !refreshOptions?.allowStaleRebuild) {
      throw new Error(formatSqliteFreshnessError(freshness));
    }
    if (!canRefreshSqliteArtifact()) throw new Error(formatSqliteFreshnessError(freshness));
    await rebuildSqliteArtifactForQuery();
    return { state: "refreshed", changedFiles: freshness.changedFiles };
  };
  const readSqliteArtifactSignatures = async (
    realSqlitePath: string,
  ): Promise<SqliteArtifactFileSignature[] | null> => {
    const result = await queryGraphSqliteRaw(
      realSqlitePath,
      "SELECT value FROM graph_metadata WHERE key = ?;",
      [SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY],
      { maxRows: 1 },
    );
    const rawValue = result.rows[0]?.[0];
    if (typeof rawValue !== "string") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const signatures: SqliteArtifactFileSignature[] = [];
    for (const value of parsed) {
      if (!isPlainRecord(value)) continue;
      if (typeof value.path !== "string") continue;
      if (typeof value.size !== "number" || typeof value.mtimeMs !== "number") continue;
      signatures.push({ path: value.path, size: value.size, mtimeMs: value.mtimeMs });
    }
    return signatures;
  };
  const isFileInsideDirectory = (file: string, directory: string): boolean => {
    const relativeFile = path.relative(directory, file);
    if (!relativeFile) return true;
    return !relativeFile.startsWith("..") && !path.isAbsolute(relativeFile);
  };
  const collectCurrentSqliteArtifactSignatures = async (): Promise<Map<string, SqliteArtifactFileSignature>> => {
    const outputDirectories: string[] = [];
    if (sqliteOutDir) {
      outputDirectories.push(sqliteOutDir);
      const lexicalOutDir = path.resolve(root, path.relative(await realRoot, sqliteOutDir));
      outputDirectories.push(lexicalOutDir);
    }
    let discoveredFiles: string[];
    if (session.discoverFiles) {
      discoveredFiles = await session.discoverFiles();
    } else if (options.session) {
      throw new Error("MCP session does not expose live file discovery for SQLite freshness.");
    } else {
      discoveredFiles = await listAgentSessionFiles({
        root,
        ...(options.buildOptions ? { buildOptions: options.buildOptions } : {}),
      });
    }
    const currentFiles = discoveredFiles.filter(
      (file) => !outputDirectories.some((directory) => isFileInsideDirectory(file, directory)),
    );
    const signatures = new Map<string, SqliteArtifactFileSignature>();
    await mapLimit(currentFiles, SQLITE_ARTIFACT_STAT_CONCURRENCY, async (file) => {
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) return;
        signatures.set(relative(file), { path: file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
          return;
        }
        throw error;
      }
    });
    return signatures;
  };
  const checkSqliteArtifactFreshness = async (realSqlitePath: string): Promise<AgentFreshnessResult> => {
    const storedSignatures = await readSqliteArtifactSignatures(realSqlitePath);
    if (!storedSignatures) return staleFreshness([], "SQLite artifact has no freshness baseline");
    const storedByFile = new Map<string, SqliteArtifactFileSignature>();
    for (const signature of storedSignatures) {
      storedByFile.set(relative(signature.path), signature);
    }
    const currentByFile = await collectCurrentSqliteArtifactSignatures();
    const changedFiles: string[] = [];
    for (const [file, currentSignature] of currentByFile.entries()) {
      const storedSignature = storedByFile.get(file);
      if (!storedSignature) {
        changedFiles.push(file);
        continue;
      }
      if (storedSignature.size !== currentSignature.size || storedSignature.mtimeMs !== currentSignature.mtimeMs) {
        changedFiles.push(file);
      }
    }
    for (const file of storedByFile.keys()) {
      if (currentByFile.has(file)) continue;
      changedFiles.push(file);
    }
    if (!changedFiles.length) return { state: "fresh" };
    return staleFreshness(changedFiles, "SQLite artifact is older than files on disk");
  };

  const collectMcpDependencyEntries = async (
    request: McpDependencyRequest,
    collectEntries: (
      graph: AgentProjectSnapshot["fileGraph"],
      file: string,
      options: { depth?: number; limit: number },
    ) => DependencyNode[],
  ): Promise<McpDependencyCollection> => {
    const snapshot = await session.loadProject({ symbolGraph: "skip" });
    const limit = boundedLimit(request.limit, DEFAULT_MCP_COLLECTION_LIMIT, MAX_MCP_COLLECTION_LIMIT);
    const queryOptions = {
      ...(request.depth !== undefined ? { depth: request.depth } : {}),
      // Probe one entry past the display limit so `truncated` is exact
      // rather than a `results.length === limit` heuristic (which cannot
      // tell "exactly limit reachable files" apart from "more exist"),
      // without re-walking the whole reachable graph for an exact total -
      // see finding #44.
      limit: limit + 1,
    };
    const resolvedSymbol = resolveSemanticSymbol(snapshot, request.file);
    let targetFile: string;
    if (resolvedSymbol) {
      targetFile = resolvedSymbol.def.file;
    } else if (parseAgentSymbolHandle(request.file) || parseQualifiedSymbolPath(request.file)) {
      targetFile = requireSemanticSymbol(snapshot, request.file).def.file;
    } else {
      targetFile = await resolveProjectFile(await realRoot, root, request.file);
    }
    const collected = collectEntries(snapshot.fileGraph, targetFile, queryOptions);
    const { items, omitted } = boundList(collected, limit);
    const entries = items.map((dependency) => ({
      file: relative(dependency.file),
      depth: dependency.depth,
    }));
    return {
      entries,
      limit,
      totalSeen: collected.length,
      truncated: Boolean(omitted),
      omitted,
    };
  };
  const calls = async (request: {
    direction: "callers" | "callees";
    handle: string;
    depth?: number | undefined;
    limit?: number | undefined;
    includeHeuristic?: boolean | undefined;
  }): Promise<CallHierarchyResponse> => {
    const findCalls = request.direction === "callers" ? findCallersWithSession : findCalleesWithSession;
    return await findCalls(session, {
      root,
      handle: request.handle,
      ...(request.depth !== undefined ? { depth: request.depth } : {}),
      limit: boundedLimit(request.limit, DEFAULT_CALL_HIERARCHY_LIMIT, MAX_CALL_HIERARCHY_LIMIT),
      ...(request.includeHeuristic !== undefined ? { includeHeuristic: request.includeHeuristic } : {}),
    });
  };
  const typeHierarchy = async (request: {
    direction: "supertypes" | "subtypes";
    handle: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }): Promise<TypeHierarchyResponse> => {
    const findTypes = request.direction === "supertypes" ? findSupertypesWithSession : findSubtypesWithSession;
    return await findTypes(session, {
      root,
      handle: request.handle,
      ...(request.depth !== undefined ? { depth: request.depth } : {}),
      limit: boundedLimit(request.limit, DEFAULT_TYPE_HIERARCHY_LIMIT, MAX_TYPE_HIERARCHY_LIMIT),
    });
  };
  const boundedReferencesFromResult = (
    result: FindReferencesResult,
    limit: number,
  ): McpTruncationMeta & { references: AgentExplanationReference[] } => {
    if (result.status !== "ok") {
      return { references: [], limit, totalSeen: 0, truncated: false, omitted: 0 };
    }
    const { items, omitted } = boundList(result.references, limit);
    const references = items.map((reference) => ({ file: relative(reference.file), range: reference.range }));
    return {
      references,
      limit,
      totalSeen: result.references.length,
      truncated: Boolean(omitted),
      omitted,
    };
  };
  const fileDeps = async (request: {
    direction: "deps" | "rdeps";
    file: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }) =>
    await withFreshness(async () => {
      const { entries, ...meta } = await collectMcpDependencyEntries(
        request,
        request.direction === "deps" ? getDependencies : getReverseDependencies,
      );
      return request.direction === "deps"
        ? { dependencies: entries, ...meta }
        : { reverseDependencies: entries, ...meta };
    });

  return {
    search: async (request) =>
      await withFreshness(
        async () =>
          await searchCodegraphWithSession(session, {
            root,
            query: request.query,
            ...(request.mode !== undefined ? { mode: request.mode } : {}),
            ...(request.from !== undefined ? { from: request.from } : {}),
            ...(request.depth !== undefined ? { depth: request.depth } : {}),
            ...(request.limit !== undefined ? { limit: request.limit } : {}),
          }),
      ),

    workspace_symbols: async (request) =>
      await workspaceSymbolsWithSession(session, {
        root,
        query: request.query,
        ...(request.kinds !== undefined ? { kinds: request.kinds } : {}),
        ...(request.exportedOnly !== undefined ? { exportedOnly: request.exportedOnly } : {}),
        ...(request.includeImports !== undefined ? { includeImports: request.includeImports } : {}),
        ...(request.fileGlob !== undefined ? { fileGlob: request.fileGlob } : {}),
        limit: boundedLimit(request.limit, DEFAULT_WORKSPACE_SYMBOL_LIMIT, MAX_WORKSPACE_SYMBOL_LIMIT),
      }),

    rename_preview: async (request) =>
      await previewRenameWithSession(session, {
        root,
        handle: request.handle,
        newName: request.newName,
        ...(request.includeComments !== undefined ? { includeComments: request.includeComments } : {}),
        ...(request.includeStrings !== undefined ? { includeStrings: request.includeStrings } : {}),
        ...(request.includeFilenames !== undefined ? { includeFilenames: request.includeFilenames } : {}),
        ...(request.maxEdits !== undefined ? { maxEdits: request.maxEdits } : {}),
      }),

    refactor_plan: async (request) =>
      await buildRefactorPlanWithSession(session, {
        root,
        handle: request.handle,
        ...(request.renameTo !== undefined ? { renameTo: request.renameTo } : {}),
        ...(request.maxReferences !== undefined ? { maxReferences: request.maxReferences } : {}),
        ...(request.maxCallers !== undefined ? { maxCallers: request.maxCallers } : {}),
        ...(request.maxHierarchy !== undefined ? { maxHierarchy: request.maxHierarchy } : {}),
        ...(request.includeSource !== undefined ? { includeSource: request.includeSource } : {}),
      }),

    calls,
    type_hierarchy: typeHierarchy,
    file_deps: fileDeps,
    callers: async (request) => await calls({ direction: "callers", ...request }),
    callees: async (request) => await calls({ direction: "callees", ...request }),
    supertypes: async (request) => await typeHierarchy({ direction: "supertypes", ...request }),
    subtypes: async (request) => await typeHierarchy({ direction: "subtypes", ...request }),

    implementations: async (request) =>
      await findImplementationsWithSession(session, {
        root,
        handle: request.handle,
        limit: boundedLimit(request.limit, DEFAULT_TYPE_HIERARCHY_LIMIT, MAX_TYPE_HIERARCHY_LIMIT),
      }),

    explore: async (request) =>
      await withFreshness(
        async () =>
          await exploreCodegraphWithSession(session, {
            root,
            query: request.query,
            ...(request.limit !== undefined ? { limit: request.limit } : {}),
            ...(request.maxPackets !== undefined ? { maxPackets: request.maxPackets } : {}),
            ...(request.maxPaths !== undefined ? { maxPaths: request.maxPaths } : {}),
            ...(request.includeSource !== undefined ? { includeSource: request.includeSource } : {}),
          }),
      ),

    orient: async (request) =>
      await withFreshness(
        async () =>
          await orientCodegraphWithSession(session, {
            root,
            ...(request.includeRoots !== undefined ? { includeRoots: request.includeRoots } : {}),
            ...(request.budget !== undefined ? { budget: request.budget } : {}),
          }),
      ),

    packet_get: async (request) =>
      await withFreshness(
        async () =>
          await getCodegraphPacketWithSession(session, {
            root,
            target: request.target,
            ...(request.maxSymbols !== undefined ? { maxSymbols: request.maxSymbols } : {}),
            ...(request.maxSnippets !== undefined ? { maxSnippets: request.maxSnippets } : {}),
            ...(request.maxDuplicates !== undefined ? { maxDuplicates: request.maxDuplicates } : {}),
          }),
      ),

    get_file: async (request) =>
      await getCodegraphFileViewWithSession(session, {
        root,
        file: request.file,
        ...(request.offset !== undefined ? { offset: request.offset } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
        ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
        ...(request.includeGraphContext !== undefined ? { includeGraphContext: request.includeGraphContext } : {}),
        ...(request.allowSensitive !== undefined ? { allowSensitive: request.allowSensitive } : {}),
        ...(options.buildOptions ? { buildOptions: options.buildOptions } : {}),
      }),

    get_symbol: async (request) =>
      await withFreshness(async () => {
        const explanation = await explainCodegraphTargetWithSession(session, { root, target: request.handle });
        return explanation.target;
      }),
    goto: async (request) =>
      await withFreshness(async () => {
        const snapshot = await session.loadProject({ symbolGraph: "skip" });
        if ("handle" in request) {
          const resolved = requireSemanticSymbol(snapshot, request.handle);
          return { status: "ok", definition: resolved.def };
        }
        return await goToDefinition(snapshot.index, {
          file: await resolveProjectFile(await realRoot, root, request.file),
          line: request.line,
          column: request.column,
        });
      }),

    refs: async (request) =>
      await withFreshness(async () => {
        const handle = "handle" in request ? request.handle : undefined;
        const file = "file" in request ? request.file : undefined;
        const line = "line" in request ? request.line : undefined;
        const column = "column" in request ? request.column : undefined;
        const hasAnyPosition = file !== undefined || line !== undefined || column !== undefined;
        const hasCompletePosition = file !== undefined && line !== undefined && column !== undefined;
        if (handle !== undefined && hasAnyPosition) {
          throw new Error("refs requires either handle or file, line, and column.");
        }
        if (handle === undefined && !hasCompletePosition) {
          throw new Error("refs requires either handle or file, line, and column.");
        }

        const limit = boundedLimit(request.limit, DEFAULT_MCP_COLLECTION_LIMIT, MAX_MCP_COLLECTION_LIMIT);

        if (handle !== undefined) {
          if (parseQualifiedSymbolPath(handle)) {
            const snapshot = await session.loadProject({ symbolGraph: "skip" });
            const resolved = requireSemanticSymbol(snapshot, handle);
            // Probe one reference past the display limit so `truncated` is exact - see
            // `collectMcpDependencyEntries` for the rationale (finding #44).
            const result = await findReferences(snapshot.index, { def: resolved.def }, { maxReferences: limit + 1 });
            return boundedReferencesFromResult(result, limit);
          }
          const explanation = await explainCodegraphTargetWithSession(session, {
            root,
            target: handle,
            maxReferences: limit,
          });
          return {
            references: explanation.references,
            limit: explanation.limits.references,
            totalSeen: explanation.references.length + explanation.omittedCounts.references,
            truncated: explanation.omittedCounts.references > 0,
            omitted: explanation.omittedCounts.references,
          };
        }
        if (file === undefined || line === undefined || column === undefined) {
          throw new Error("refs requires either handle or file, line, and column.");
        }

        const snapshot = await session.loadProject({ symbolGraph: "skip" });
        const result = await findReferences(
          snapshot.index,
          {
            file: await resolveProjectFile(await realRoot, root, file),
            line,
            column,
          },
          { maxReferences: limit + 1 },
        );
        return boundedReferencesFromResult(result, limit);
      }),

    deps: async (request) =>
      await withFreshness(async () => {
        const { entries, ...meta } = await collectMcpDependencyEntries(request, getDependencies);
        return { dependencies: entries, ...meta };
      }),

    rdeps: async (request) =>
      await withFreshness(async () => {
        const { entries, ...meta } = await collectMcpDependencyEntries(request, getReverseDependencies);
        return { reverseDependencies: entries, ...meta };
      }),

    path: async (request) =>
      await withFreshness(async () => {
        const snapshot = await session.loadProject({ symbolGraph: "skip" });
        const result = getShortestPath(
          snapshot.fileGraph,
          await resolveProjectFile(await realRoot, root, request.from),
          await resolveProjectFile(await realRoot, root, request.to),
        );
        return {
          path: result ? result.map(relative) : null,
        };
      }),

    impact: async (request) =>
      await withFreshness(async () => {
        const snapshot = await session.loadProject({ symbolGraph: "skip" });
        return (await analyzeImpactFromDiff(root, snapshot.index, {
          ...options.buildOptions,
          provider: "git",
          base: request.base,
          head: request.head,
          cwd: root,
          compact: true,
          depth: 2,
          maxRefs: 200,
          ...DEFAULT_BOUNDED_IMPACT_BUDGETS,
        })) as CompactImpactReport;
      }),

    review: async (request) =>
      await withFreshness(async () => {
        const report = await buildReviewReport(
          root,
          {
            ...options.buildOptions,
            gitBase: request.base,
            gitHead: request.head,
            ...(request.reviewDepth !== undefined ? { reviewDepth: request.reviewDepth } : {}),
          },
          {
            ...(session.loadProject
              ? {
                  loadIndex: async () => (await session.loadProject({ symbolGraph: "skip" })).index,
                }
              : {}),
            ...(session.loadDuplicateAnalysis ? { loadDuplicateAnalysis: session.loadDuplicateAnalysis } : {}),
          },
        );
        // MCP is a bounded transport (finding #45); library callers that need the
        // complete, unbounded report should call `buildReviewReport` directly.
        return boundReviewReportForTransport(report);
      }),

    query_sqlite: async (request, executionOptions) => {
      if (!sqlitePath) {
        throw new Error("No SQLite artifact is available. Run artifact_build first or pass artifactPath.");
      }
      assertMcpSqliteQueryResourceBounded(request.query);
      // The artifact's own baseline decides whether the query can be served; session freshness
      // only decides whether an automatic rebuild is safe. A fresh artifact is served even when
      // the in-memory session snapshot is stale, and an unsafe session refresh burst blocks the
      // automatic rebuild instead of silently rebuilding from stale in-memory state.
      let realSqlitePath = await assertRealPathCandidateWithinRoot(await realRoot, sqlitePath, "SQLite artifact");
      let artifactFreshness = await checkSqliteArtifactFreshness(realSqlitePath);
      if (artifactFreshness.state !== "fresh") {
        const sessionFreshness = await checkMcpFreshness();
        if (sessionFreshness.state === "stale") {
          throw new Error(formatSqliteFreshnessError(sessionFreshness));
        }
        artifactFreshness = await refreshSqliteArtifactForQuery(artifactFreshness, { allowStaleRebuild: true });
        realSqlitePath = await assertRealPathCandidateWithinRoot(await realRoot, sqlitePath, "SQLite artifact");
      }
      const result = await queryGraphSqliteRaw(realSqlitePath, request.query, request.params ?? [], {
        maxRows: normalizeSqliteRowLimit(request.limit),
        maxBytes: DEFAULT_SQLITE_BYTE_LIMIT,
        ...(executionOptions?.signal ? { signal: executionOptions.signal } : {}),
      });
      return { ...result, truncated: Boolean(result.truncated), freshness: artifactFreshness };
    },

    refresh_index: async (request) =>
      await withArtifactWriteLock(async () => {
        const warmup = request.warmup ?? "off";
        const previousRefresh = refreshPromise;
        const refresh = (async () => {
          if (previousRefresh) await previousRefresh.catch(() => undefined);
          ++refreshEpoch;
          session.invalidate();
          sqlitePath = configuredSqlitePath;
          sqliteOutDir = configuredSqliteOutDir;
          sqliteCanRefresh = configuredSqliteCanRefresh;
          await startCodegraphMcpWarmup(session, warmup);
        })();
        refreshPromise = refresh;
        try {
          await refresh;
        } finally {
          if (refreshPromise === refresh) refreshPromise = undefined;
        }
        return { refreshed: true, warmup };
      }),

    artifact_build: async (request) =>
      await withArtifactWriteLock(async () => {
        if (readOnly) {
          throw new Error("artifact_build is disabled in read-only MCP mode.");
        }
        const freshness = await checkMcpFreshness();
        if (freshness.state === "stale") {
          const changed = freshness.changedFiles.length ? ` Changed files: ${freshness.changedFiles.join(", ")}.` : "";
          const omitted = freshness.omittedChangedFileCount
            ? ` Omitted changed files: ${freshness.omittedChangedFileCount}.`
            : "";
          throw new Error(
            `Cannot build artifacts from a stale MCP index; run refresh_index first. ${freshness.reason}.${changed}${omitted}`,
          );
        }
        const outDir =
          request.outDir !== undefined
            ? await assertWritableDirectoryRealPathWithinRoot(
                await realRoot,
                root,
                request.outDir,
                "Artifact output directory",
              )
            : undefined;
        const result = await buildCodegraphArtifactWithSession(session, {
          root,
          ...(outDir !== undefined ? { outDir } : {}),
          ...(request.outDir !== undefined ? { filterOutDir: request.outDir } : {}),
          ...(request.sqlite !== undefined ? { sqlite: request.sqlite } : {}),
          ...(request.graphJson !== undefined ? { graphJson: request.graphJson } : {}),
          ...(request.report !== undefined ? { report: request.report } : {}),
          ...(request.questions !== undefined ? { questions: request.questions } : {}),
          ...(request.force !== undefined ? { force: request.force } : {}),
        });
        const sqliteArtifact = result.artifacts.sqlite;
        if (sqliteArtifact) {
          sqlitePath = path.join(result.outDir, sqliteArtifact);
          sqliteOutDir = result.outDir;
          sqliteCanRefresh = true;
        }
        return { ...result, freshness };
      }),
    dispose: () => {
      if (!options.session) session.invalidate();
    },
  };
}

export type McpToolOperationTracker = {
  isAccepting: () => boolean;
  track: <T>(operation: () => Promise<T>) => Promise<T> | undefined;
  stop: () => void;
  drain: () => Promise<void>;
};

function createMcpToolOperationTracker(): McpToolOperationTracker {
  let accepting = true;
  const operations = new Set<Promise<unknown>>();
  return {
    isAccepting: () => accepting,
    track: <T>(operation: () => Promise<T>): Promise<T> | undefined => {
      if (!accepting) return undefined;
      const tracked = operation();
      operations.add(tracked);
      void tracked.then(
        () => operations.delete(tracked),
        () => operations.delete(tracked),
      );
      return tracked;
    },
    stop: () => {
      accepting = false;
    },
    drain: async () => {
      accepting = false;
      await Promise.allSettled([...operations]);
    },
  };
}

export type McpToolConcurrencyTracker = {
  inFlight: number;
  maximum: number;
};

function createMcpToolConcurrencyTracker(maximum: number): McpToolConcurrencyTracker {
  return { inFlight: 0, maximum: normalizeMcpToolConcurrency(maximum) };
}

export function createCodegraphMcpProtocolServer(
  handlers: CodegraphMcpHandlers,
  runtimeIdentity: CodegraphRuntimeIdentity = captureCodegraphRuntimeIdentity(getCurrentNativeBindingOrigin()),
  installedVersion: InstalledVersionChecker = createInstalledVersionChecker(runtimeIdentity),
  toolCallState: { firstToolCallPending: boolean } = { firstToolCallPending: true },
  maxConcurrentToolCalls = DEFAULT_MCP_TOOL_CONCURRENCY,
  mcpToolTimeoutMs = DEFAULT_MCP_TOOL_TIMEOUT_MS,
): Server {
  return createCodegraphMcpProtocolServerWithTracker(
    handlers,
    runtimeIdentity,
    installedVersion,
    toolCallState,
    assertMcpToolTimeout(mcpToolTimeoutMs),
    createMcpToolOperationTracker(),
    createMcpToolConcurrencyTracker(maxConcurrentToolCalls),
  );
}

export function createCodegraphMcpProtocolServerWithTracker(
  handlers: CodegraphMcpHandlers,
  runtimeIdentity: CodegraphRuntimeIdentity,
  installedVersion: InstalledVersionChecker,
  toolCallState: { firstToolCallPending: boolean },
  mcpToolTimeoutMs: number,
  toolOperations: McpToolOperationTracker,
  toolConcurrency: McpToolConcurrencyTracker,
): Server {
  const server = new Server(
    {
      name: "codegraph",
      version: runtimeIdentity.runningVersion,
    },
    {
      capabilities: { tools: {}, logging: {} },
    },
  );
  const activeToolCalls = new Map<string | number, McpToolAbort>();
  server.setNotificationHandler("notifications/cancelled", (notification) => {
    const requestId = notification.params.requestId;
    if (requestId !== undefined) {
      activeToolCalls.get(requestId)?.abort(new Error("MCP tool call was cancelled."));
    }
  });

  server.setRequestHandler("tools/list", () => ({ tools: listCodegraphMcpTools() }));
  server.setRequestHandler("tools/call", async (request, ctx): Promise<CallToolResult> => {
    if (!toolOperations.isAccepting()) {
      throw new Error("MCP server is shutting down.");
    }
    if (toolConcurrency.inFlight >= toolConcurrency.maximum) {
      throw new Error("MCP tool execution is busy; retry shortly.");
    }
    toolConcurrency.inFlight += 1;
    const isFirstToolCall = toolCallState.firstToolCallPending;
    toolCallState.firstToolCallPending = false;
    const progressToken = isFirstToolCall ? getToolCallProgressToken(request.params) : undefined;
    const emitFirstToolCallVisibility = async (
      level: "info" | "error",
      progress: number,
      message: string,
    ): Promise<void> => {
      if (!isFirstToolCall) return;
      try {
        await ctx.mcpReq.log(level, message, "codegraph");
        if (progressToken !== undefined) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken, progress, total: 1, message },
          });
        }
      } catch (error) {
        console.error(`[codegraph] MCP cold-start visibility failed: ${errorMessage(error)}`);
      }
    };
    await emitFirstToolCallVisibility(
      "info",
      0,
      `Codegraph is warming the first tool call for '${request.params.name}'.`,
    );
    try {
      installedVersion.check();
    } catch (error) {
      console.error(`[codegraph] installed-version check failed: ${errorMessage(error)}`);
    }
    try {
      const toolCallAbort = createMcpToolAbortSignal(
        [ctx.mcpReq.signal, legacyRequestAbortStorage.getStore()],
        request.params.name,
        mcpToolTimeoutMs,
      );
      activeToolCalls.set(ctx.mcpReq.id, toolCallAbort);
      try {
        const operation = toolOperations.track(() =>
          callMcpTool(handlers, request.params.name, request.params.arguments ?? {}, toolCallAbort.signal),
        );
        if (operation === undefined) {
          toolConcurrency.inFlight -= 1;
          throw new Error("MCP server is shutting down.");
        }
        const releaseToolCall = (): void => {
          toolConcurrency.inFlight -= 1;
        };
        try {
          const result = await awaitMcpToolOperation(toolCallAbort.signal, operation, releaseToolCall);
          await emitFirstToolCallVisibility(
            "info",
            1,
            `Codegraph finished warming the first tool call for '${request.params.name}'.`,
          );
          return toToolResult(result);
        } catch (error) {
          if (error instanceof ProtocolError || toolCallAbort.signal.aborted) throw error;
          return toToolErrorResult(error);
        }
      } finally {
        activeToolCalls.delete(ctx.mcpReq.id);
        toolCallAbort.dispose();
      }
    } catch (error) {
      await emitFirstToolCallVisibility(
        "error",
        1,
        `Codegraph failed while warming the first tool call for '${request.params.name}'.`,
      );
      throw error;
    }
  });

  return server;
}

type McpProtocolFactory = {
  create: () => Server;
  stop: () => void;
  drain: () => Promise<void>;
};

function createCodegraphMcpProtocolFactory(
  handlers: CodegraphMcpHandlers,
  runtimeIdentity: CodegraphRuntimeIdentity,
  maxConcurrentToolCalls = DEFAULT_MCP_TOOL_CONCURRENCY,
  mcpToolTimeoutMs = DEFAULT_MCP_TOOL_TIMEOUT_MS,
): McpProtocolFactory {
  const toolConcurrency = createMcpToolConcurrencyTracker(maxConcurrentToolCalls);
  const installedVersion = createInstalledVersionChecker(runtimeIdentity);
  const toolCallState = { firstToolCallPending: true };
  const toolOperations = createMcpToolOperationTracker();
  const timeout = assertMcpToolTimeout(mcpToolTimeoutMs);
  return {
    create: () =>
      createCodegraphMcpProtocolServerWithTracker(
        handlers,
        runtimeIdentity,
        installedVersion,
        toolCallState,
        timeout,
        toolOperations,
        toolConcurrency,
      ),
    stop: () => toolOperations.stop(),
    drain: () => toolOperations.drain(),
  };
}

export function createParseErrorReportingStdin(input: Readable, output: Writable): Readable {
  let pending = Buffer.alloc(0);
  const processFrame = (rawFrame: Buffer, stream: Transform): Error | undefined => {
    const frame = rawFrame.at(-1) === 13 ? rawFrame.subarray(0, -1) : rawFrame;
    if (!frame.length) return;
    if (frame.length > MAX_MCP_STDIO_FRAME_BYTES) {
      return new Error("MCP stdio frame exceeded 10 MiB.");
    }
    try {
      JSON.parse(frame.toString("utf8"));
      stream.push(frame);
      stream.push("\n");
    } catch {
      output.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: ProtocolErrorCode.ParseError, message: "Parse error" },
        })}\n`,
      );
    }
  };
  const filter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending = Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(10);
      while (newline >= 0) {
        const error = processFrame(pending.subarray(0, newline), this);
        pending = pending.subarray(newline + 1);
        if (error !== undefined) {
          callback(error);
          return;
        }
        newline = pending.indexOf(10);
      }
      if (pending.length > MAX_MCP_STDIO_FRAME_BYTES) {
        callback(new Error("MCP stdio frame exceeded 10 MiB."));
        return;
      }
      callback();
    },
    flush(callback) {
      const error = processFrame(pending, this);
      pending = Buffer.alloc(0);
      callback(error);
    },
  });
  input.pipe(filter);
  return filter;
}

export async function serveCodegraphMcp(options: CodegraphMcpServerOptions): Promise<void> {
  const configuredMcpToolTimeout =
    options.mcpToolTimeoutMs === undefined ? DEFAULT_MCP_TOOL_TIMEOUT_MS : options.mcpToolTimeoutMs;
  const mcpToolTimeoutMs = assertMcpToolTimeout(configuredMcpToolTimeout);
  const port = options.port;
  if (port !== undefined) {
    const started = await startCodegraphMcpHttpServer({ ...options, port });
    options.onHttpListen?.({
      host: started.host,
      port: started.port,
      url: started.url,
    });
    await waitForHttpServerClose(started.server);
    return;
  }

  const { handlers, session } = await createWarmedCodegraphMcpResources(options);
  const runtimeIdentity = options.runtimeIdentity ?? captureCodegraphRuntimeIdentity(getCurrentNativeBindingOrigin());
  const protocolFactory = createCodegraphMcpProtocolFactory(
    handlers,
    runtimeIdentity,
    options.mcpToolConcurrency ?? DEFAULT_MCP_TOOL_CONCURRENCY,
    mcpToolTimeoutMs,
  );
  const transport = new StdioServerTransport(
    createParseErrorReportingStdin(process.stdin, process.stdout),
    process.stdout,
    { maxBufferSize: MAX_MCP_STDIO_FRAME_BYTES },
  );
  const handle = serveStdio(protocolFactory.create, {
    transport,
    legacy: "serve",
    onerror: (error) => {
      console.error(`[codegraph] MCP stdio error: ${error.message}`);
    },
  });
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_MCP_STDIO_IDLE_TIMEOUT_MS;
  try {
    await awaitStdioMcpLifecycle(handle, {
      idleTimeoutMs,
      onShutdown: (shutdownReason) => {
        console.error(`[codegraph] MCP stdio shutting down (${shutdownReason})`);
      },
    });
  } finally {
    protocolFactory.stop();
    await protocolFactory.drain();
    session.invalidate();
  }
  process.exitCode = 0;
}

export async function startCodegraphMcpHttpServer(
  options: CodegraphMcpServerOptions & { port: number },
): Promise<CodegraphMcpHttpServer> {
  const httpBodyTimeoutMs = assertMcpHttpBodyTimeout(
    options.httpBodyTimeoutMs === undefined ? DEFAULT_MCP_HTTP_BODY_TIMEOUT_MS : options.httpBodyTimeoutMs,
  );
  const configuredMcpToolTimeout =
    options.mcpToolTimeoutMs === undefined ? DEFAULT_MCP_TOOL_TIMEOUT_MS : options.mcpToolTimeoutMs;
  const mcpToolTimeoutMs = assertMcpToolTimeout(configuredMcpToolTimeout);
  const host = options.host ?? "127.0.0.1";
  const { handlers, session } = await createWarmedCodegraphMcpResources(options);
  const runtimeIdentity = options.runtimeIdentity ?? captureCodegraphRuntimeIdentity(getCurrentNativeBindingOrigin());
  const protocolFactory = createCodegraphMcpProtocolFactory(
    handlers,
    runtimeIdentity,
    options.mcpToolConcurrency ?? DEFAULT_MCP_TOOL_CONCURRENCY,
    mcpToolTimeoutMs,
  );
  const sessionStore = createLegacyMcpSessionStore({
    idleMs: options.httpSessionIdleMs ?? DEFAULT_MCP_HTTP_SESSION_IDLE_MS,
    maxCount: options.httpSessionMaxCount ?? DEFAULT_MCP_HTTP_SESSION_MAX_COUNT,
    evictionIntervalMs: options.httpSessionEvictionIntervalMs ?? DEFAULT_MCP_HTTP_SESSION_EVICTION_INTERVAL_MS,
  });
  const modernHandler = createMcpHandler(protocolFactory.create, {
    legacy: "reject",
    onerror: (error) => {
      console.error(`[codegraph] MCP HTTP error: ${error.message}`);
    },
  });
  const modernNodeHandler = toNodeHandler(modernHandler, {
    onerror: (error) => {
      console.error(`[codegraph] MCP HTTP adapter error: ${error.message}`);
    },
  });
  const validateOrigin = originValidation(buildAllowedOriginHostnames(host));
  let allowedHostHeaders = emptyAllowedHostHeaderRules();
  let closeResourcesPromise: Promise<void> | undefined;
  const closeResources = (): Promise<void> => {
    closeResourcesPromise ??= (async () => {
      protocolFactory.stop();
      sessionStore.stop();
      try {
        await closeMcpResources(sessionStore.sessions, modernHandler.close);
      } finally {
        await protocolFactory.drain();
        session.invalidate();
      }
    })();
    return closeResourcesPromise;
  };

  const server = createServer((request, response) => {
    void handleMcpHttpRequest(
      request,
      response,
      sessionStore,
      () => allowedHostHeaders,
      validateOrigin,
      modernNodeHandler,
      protocolFactory.create,
      httpBodyTimeoutMs,
    );
  });

  server.on("close", () => {
    void closeResources();
  });

  try {
    await listenOnHttpServer(server, options.port, host);
  } catch (error) {
    await closeResources();
    throw error;
  }
  const address = server.address();
  const actualPort = getHttpServerPort(address);
  const urlHost = formatHostForUrl(host);
  const url = `http://${urlHost}:${actualPort}${MCP_HTTP_PATH}`;
  allowedHostHeaders = buildAllowedHostHeaders(host, actualPort);

  return {
    server,
    host,
    port: actualPort,
    url,
    close: async () => {
      const requestsDrained = closeHttpServer(server);
      await closeResources();
      await requestsDrained;
      // An initialize accepted before closeHttpServer() can register after closeResources() snapshots the session map.
      await closeLegacyMcpSessions(sessionStore.sessions);
    },
  };
}

async function handleMcpHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sessionStore: LegacyMcpSessionStore,
  getAllowedHostHeaders: () => AllowedHostHeaderRules,
  validateOrigin: OriginValidator,
  modernNodeHandler: NodeMcpRequestHandler,
  createProtocolServer: () => Server,
  bodyTimeoutMs: number,
): Promise<void> {
  const writeClosingJsonRpcError = (statusCode: number, message: string): void => {
    response.setHeader("connection", "close");

    writeJsonRpcError(response, statusCode, message);
  };

  const requestPath = getRequestPath(request);
  if (requestPath !== MCP_HTTP_PATH) {
    writeJsonResponse(response, 404, { error: "Not found" });
    return;
  }

  if (!isAllowedHostHeader(request, getAllowedHostHeaders())) {
    writeJsonRpcError(response, 403, "Forbidden host header");
    return;
  }
  if (!validateOrigin(request, response)) return;

  try {
    if (request.method === "POST") {
      const parsedBody = await readJsonRequestBody(request, MAX_MCP_HTTP_BODY_BYTES, bodyTimeoutMs);
      if (parsedBody.status === "too_large") {
        writeJsonRpcError(response, 413, "MCP request body is too large");
        return;
      }
      if (parsedBody.status === "timeout") {
        writeClosingJsonRpcError(408, "MCP request body timed out");
        return;
      }
      if (parsedBody.status === "invalid_json") {
        writeJsonRpcError(response, 400, "Invalid JSON request body");
        return;
      }
      if (!isMcpNodeRequest(request)) {
        writeJsonRpcError(response, 400, "Invalid MCP request target");
        return;
      }

      const mcpRequest: NodeIncomingMessageLike = request;
      const webRequest = await toWebRequest(mcpRequest, parsedBody.body);
      if (await isLegacyRequest(webRequest, parsedBody.body)) {
        await handleLegacyMcpHttpPost(request, response, parsedBody.body, sessionStore, createProtocolServer);
      } else {
        await modernNodeHandler(mcpRequest, response, parsedBody.body);
      }
      return;
    }

    if (request.method === "GET" || request.method === "DELETE") {
      await handleExistingMcpSessionRequest(request, response, sessionStore);
      return;
    }

    writeJsonRpcError(response, 405, "Method not allowed");
  } catch {
    if (!response.headersSent) {
      writeJsonRpcError(response, 500, "Internal server error", -32603);
    }
  }
}

async function handleLegacyMcpHttpPost(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  sessionStore: LegacyMcpSessionStore,
  createProtocolServer: () => Server,
): Promise<void> {
  const sessionId = getHeaderValue(request.headers["mcp-session-id"]);
  if (sessionId !== undefined) {
    const session = sessionStore.get(sessionId);
    if (!session) {
      writeJsonRpcError(response, 400, "Bad Request: No valid session ID provided");
      return;
    }
    sessionStore.touch(sessionId);
    await handleLegacyMcpSessionRequest(session, request, response, body);
    return;
  }

  if (!isInitializeRequest(body)) {
    writeJsonRpcError(response, 400, "Bad Request: No valid session ID provided");
    return;
  }

  const hasCapacity = await sessionStore.ensureCapacityForNewSession();
  if (!hasCapacity) {
    writeJsonRpcError(
      response,
      503,
      "MCP session capacity reached: all configured sessions are active; close an existing session and retry.",
    );
    return;
  }
  let capacityReservationHeld = true;
  const releaseCapacityReservation = (): void => {
    if (!capacityReservationHeld) return;
    capacityReservationHeld = false;
    sessionStore.releaseCapacityReservation();
  };
  const protocolServer = createProtocolServer();
  let initializedSessionId: string | undefined;
  // The transport callbacks close over the session, but the session needs the
  // transport, so the binding is resolved through a ref rather than a mutable let.
  const sessionRef: { current: LegacyMcpSession | undefined } = { current: undefined };
  const transport = new NodeStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      initializedSessionId = newSessionId;
      const initialized = sessionRef.current;
      if (initialized === undefined) {
        throw new Error("MCP session state was not initialized before the transport session.");
      }
      sessionStore.set(newSessionId, initialized);
      releaseCapacityReservation();
    },
    onsessionclosed: (closedSessionId) => {
      void sessionStore.delete(closedSessionId);
    },
  });
  const session: LegacyMcpSession = {
    server: protocolServer,
    transport,
    lastActivityAt: Date.now(),
    inFlightRequests: 0,
    openSseStreams: 0,
  };
  sessionRef.current = session;
  // The SDK transport reports every per-request validation rejection through onerror
  // too (bad Accept header, wrong Content-Type, malformed JSON, an unsupported
  // protocol version, ...) - each of those already answered its own request with a
  // 4xx response and left the transport fully usable. Deleting the session here would
  // tear down an otherwise healthy session over one malformed follow-up request. Only
  // onclose reflects the transport actually shutting down (an explicit DELETE, an
  // eviction we triggered, or a real fatal failure), so session teardown is driven by
  // onclose alone; onerror only logs.
  transport.onerror = (error) => {
    console.error(`[codegraph] MCP HTTP session transport error: ${error.message}`);
  };
  transport.onclose = () => {
    if (initializedSessionId !== undefined) void sessionStore.delete(initializedSessionId);
  };

  try {
    await protocolServer.connect(transport);
    await handleLegacyMcpSessionRequest(session, request, response, body);
    if (initializedSessionId === undefined) {
      // The transport answered a pre-session 4xx (invalid Accept header, wrong
      // Content-Type, malformed JSON, ...) without throwing and without ever reaching
      // onsessioninitialized, so nothing else releases this capacity reservation or
      // closes this ad hoc protocol server/transport pair.
      releaseCapacityReservation();
      await closeMcpSession(session);
    }
  } catch (error) {
    if (initializedSessionId !== undefined) {
      await sessionStore.delete(initializedSessionId);
    } else {
      await closeMcpSession(session);
    }
    releaseCapacityReservation();
    throw error;
  }
}

async function handleExistingMcpSessionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sessionStore: LegacyMcpSessionStore,
): Promise<void> {
  const sessionId = getHeaderValue(request.headers["mcp-session-id"]);
  if (sessionId === undefined) {
    writeJsonRpcError(response, 400, "Invalid or missing session ID");
    return;
  }
  const session = sessionStore.get(sessionId);
  if (!session) {
    writeJsonRpcError(response, 400, "Invalid or missing session ID");
    return;
  }
  sessionStore.touch(sessionId);
  await handleLegacyMcpSessionRequest(session, request, response);
}

/**
 * Runs one legacy HTTP request with a signal that aborts when its connection closes.
 * The signal is scoped to this request and is available to nested MCP tool dispatch.
 */
export async function runWithLegacyRequestAbortSignal<T>(
  request: IncomingMessage,
  response: ServerResponse,
  operation: () => Promise<T>,
): Promise<T> {
  const abortController = new AbortController();
  let completed = false;
  const abortDisconnectedRequest = (): void => {
    if (completed) return;
    if (request.aborted || (!response.writableFinished && response.destroyed)) {
      abortController.abort(new Error("MCP HTTP request connection closed."));
    }
  };
  request.on("aborted", abortDisconnectedRequest);
  request.on("close", abortDisconnectedRequest);
  response.on("close", abortDisconnectedRequest);
  try {
    return await legacyRequestAbortStorage.run(abortController.signal, operation);
  } finally {
    completed = true;
    request.off("aborted", abortDisconnectedRequest);
    request.off("close", abortDisconnectedRequest);
    response.off("close", abortDisconnectedRequest);
  }
}

async function handleLegacyMcpSessionRequest(
  session: LegacyMcpSession,
  request: IncomingMessage,
  response: ServerResponse,
  body?: unknown,
): Promise<void> {
  const tracksSseStream = isLegacySseRequest(request);
  session.inFlightRequests += 1;
  if (tracksSseStream) session.openSseStreams += 1;
  try {
    await runWithLegacyRequestAbortSignal(request, response, async () => {
      await session.transport.handleRequest(request, response, body);
    });
  } finally {
    session.inFlightRequests -= 1;
    if (tracksSseStream) session.openSseStreams -= 1;
    session.lastActivityAt = Date.now();
  }
}

function isLegacySseRequest(request: IncomingMessage): boolean {
  if (request.method !== "GET") return false;
  return getHeaderValue(request.headers.accept)?.includes("text/event-stream") ?? false;
}

type LegacyMcpSessionStoreOptions = {
  idleMs: number;
  maxCount: number;
  evictionIntervalMs: number;
};

type LegacyMcpSessionStore = {
  sessions: Map<string, LegacyMcpSession>;
  get(sessionId: string): LegacyMcpSession | undefined;
  set(sessionId: string, session: LegacyMcpSession): void;
  touch(sessionId: string): void;
  delete(sessionId: string): Promise<void>;
  ensureCapacityForNewSession(): Promise<boolean>;
  releaseCapacityReservation(): void;
  stop(): void;
};

function createLegacyMcpSessionStore(options: LegacyMcpSessionStoreOptions): LegacyMcpSessionStore {
  const sessions = new Map<string, LegacyMcpSession>();
  let stopped = false;
  let evictionTimer: ReturnType<typeof setInterval> | undefined;
  let pendingInitializations = 0;

  const store: LegacyMcpSessionStore = {
    sessions,
    get(sessionId) {
      return sessions.get(sessionId);
    },
    set(sessionId, session) {
      sessions.set(sessionId, session);
    },
    touch(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.lastActivityAt = Date.now();
    },
    async delete(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.delete(sessionId);
      await closeMcpSession(session);
    },
    async ensureCapacityForNewSession() {
      await evictIdleLegacyMcpSessions(store, options.idleMs);
      if (sessions.size + pendingInitializations < options.maxCount) {
        pendingInitializations += 1;
        return true;
      }
      const oldest = [...sessions.entries()]
        .filter(([, session]) => !session.inFlightRequests && !session.openSseStreams)
        .sort((left, right) => left[1].lastActivityAt - right[1].lastActivityAt);
      while (sessions.size + pendingInitializations >= options.maxCount && oldest.length) {
        const oldestSession = oldest.shift();
        if (oldestSession === undefined) break;
        const [sessionId, session] = oldestSession;
        if (session.inFlightRequests || session.openSseStreams) continue;
        await store.delete(sessionId);
      }
      if (sessions.size + pendingInitializations >= options.maxCount) return false;
      pendingInitializations += 1;
      return true;
    },
    releaseCapacityReservation() {
      if (pendingInitializations) pendingInitializations -= 1;
    },
    stop() {
      stopped = true;
      if (evictionTimer !== undefined) {
        clearInterval(evictionTimer);
        evictionTimer = undefined;
      }
    },
  };

  if (options.idleMs > 0 && options.evictionIntervalMs > 0) {
    evictionTimer = setInterval(() => {
      if (stopped) return;
      void evictIdleLegacyMcpSessions(store, options.idleMs).catch((error) => {
        console.error(`[codegraph] MCP HTTP session eviction failed: ${errorMessage(error)}`);
      });
    }, options.evictionIntervalMs);
    evictionTimer.unref?.();
  }

  return store;
}

async function evictIdleLegacyMcpSessions(store: LegacyMcpSessionStore, idleMs: number): Promise<void> {
  if (idleMs <= 0) return;
  const cutoff = Date.now() - idleMs;
  for (const [sessionId, session] of store.sessions) {
    if (session.lastActivityAt > cutoff || session.inFlightRequests || session.openSseStreams) continue;
    await store.delete(sessionId);
  }
}

async function closeMcpSession(session: LegacyMcpSession): Promise<void> {
  await Promise.allSettled([session.transport.close(), session.server.close()]);
}

async function closeLegacyMcpSessions(sessions: Map<string, LegacyMcpSession>): Promise<void> {
  const legacySessions = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(legacySessions.map((session) => closeMcpSession(session)));
}

async function closeMcpResources(
  sessions: Map<string, LegacyMcpSession>,
  closeModernHandler: () => Promise<void>,
): Promise<void> {
  await Promise.allSettled([closeLegacyMcpSessions(sessions), closeModernHandler()]);
}

function isMcpNodeRequest(request: IncomingMessage): request is IncomingMessage & NodeIncomingMessageLike {
  return request.method !== undefined && request.url !== undefined;
}

type McpToolAbort = {
  signal: AbortSignal;
  abort: (reason: unknown) => void;
  dispose: () => void;
};

function createMcpToolAbortSignal(
  requestSignals: readonly (AbortSignal | undefined)[],
  toolName: string,
  timeoutMs: number,
): McpToolAbort {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; onAbort: () => void }> = [];
  for (const requestSignal of requestSignals) {
    if (requestSignal === undefined) continue;
    const onAbort = (): void => {
      controller.abort(requestSignal.reason);
    };
    listeners.push({ signal: requestSignal, onAbort });
    if (requestSignal.aborted) onAbort();
    else requestSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timeout =
    timeoutMs > 0
      ? setTimeout(() => {
          controller.abort(new Error(`MCP tool '${toolName}' exceeded the configured deadline of ${timeoutMs} ms.`));
        }, timeoutMs)
      : undefined;
  timeout?.unref?.();
  return {
    signal: controller.signal,
    abort: (reason: unknown) => controller.abort(reason),
    dispose: () => {
      clearTimeout(timeout);
      for (const listener of listeners) listener.signal.removeEventListener("abort", listener.onAbort);
    },
  };
}

export function awaitMcpToolOperation<T>(
  signal: AbortSignal | undefined,
  operation: Promise<T>,
  onSettled: () => void,
): Promise<T> {
  void operation.then(onSettled, onSettled);
  return withAbortSignal(signal, operation);
}

function withAbortSignal<T>(signal: AbortSignal | undefined, operation: Promise<T>): Promise<T> {
  if (!signal) return operation;
  const cancellationError = (): Error => {
    const reason = signal.reason;
    if (reason instanceof Error && reason.name !== "AbortError") return reason;
    return new Error("MCP tool call was cancelled.");
  };
  if (signal.aborted) return Promise.reject(cancellationError());
  const cancellation = Promise.withResolvers<never>();
  const onAbort = (): void => cancellation.reject(cancellationError());
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([operation, cancellation.promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

export async function callMcpTool(
  handlers: CodegraphMcpHandlers,
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const tool = MCP_TOOL_REGISTRY.find((entry) => entry.name === name);
  if (!tool) throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown MCP tool: ${name}`);

  switch (tool.dispatch.handler) {
    case "search":
      return await handlers.search(parseMcpToolInput(searchSchema, input, name), signal);
    case "workspace_symbols":
      return await handlers.workspace_symbols(parseMcpToolInput(workspaceSymbolsSchema, input, name), signal);
    case "rename_preview":
      return await handlers.rename_preview(parseMcpToolInput(renamePreviewSchema, input, name), signal);
    case "refactor_plan":
      return await handlers.refactor_plan(parseMcpToolInput(refactorPlanSchema, input, name), signal);
    case "calls":
      if (tool.dispatch.direction) {
        return await handlers.calls(
          { ...parseMcpToolInput(callHierarchySchema, input, name), direction: tool.dispatch.direction },
          signal,
        );
      }
      return await handlers.calls(parseMcpToolInput(callsSchema, input, name), signal);
    case "type_hierarchy":
      if (tool.dispatch.direction) {
        return await handlers.type_hierarchy(
          { ...parseMcpToolInput(typeHierarchySchema, input, name), direction: tool.dispatch.direction },
          signal,
        );
      }
      return await handlers.type_hierarchy(parseMcpToolInput(typeHierarchyUnifiedSchema, input, name), signal);
    case "implementations":
      return await handlers.implementations(parseMcpToolInput(implementationsSchema, input, name), signal);
    case "explore":
      return await handlers.explore(parseMcpToolInput(exploreSchema, input, name), signal);
    case "orient":
      return await handlers.orient(parseMcpToolInput(orientSchema, input, name), signal);
    case "packet_get":
      return await handlers.packet_get(parseMcpToolInput(packetGetSchema, input, name), signal);
    case "get_file":
      return await handlers.get_file(parseMcpToolInput(getFileSchema, input, name), signal);
    case "get_symbol":
      return await handlers.get_symbol(parseMcpToolInput(handleSchema, input, name), signal);
    case "goto":
      return await callGotoTool(handlers, input, signal);
    case "refs":
      return await callRefsTool(handlers, input, signal);
    case "file_deps":
      if (tool.dispatch.direction) {
        return await handlers.file_deps(
          { ...parseMcpToolInput(fileGraphSchema, input, name), direction: tool.dispatch.direction },
          signal,
        );
      }
      return await handlers.file_deps(parseMcpToolInput(fileDepsUnifiedSchema, input, name), signal);
    case "path":
      return await handlers.path(parseMcpToolInput(pathSchema, input, name), signal);
    case "impact":
      return await handlers.impact(parseMcpToolInput(gitRangeSchema, input, name), signal);
    case "review":
      return await handlers.review(parseMcpToolInput(reviewSchema, input, name), signal);
    case "query_sqlite":
      return await handlers.query_sqlite(parseMcpToolInput(querySqliteSchema, input, name), {
        ...(signal ? { signal } : {}),
      });
    case "refresh_index":
      return await handlers.refresh_index(parseMcpToolInput(refreshIndexSchema, input, name), signal);
    case "artifact_build":
      return await handlers.artifact_build(parseMcpToolInput(artifactBuildSchema, input, name), signal);
  }
}

async function callGotoTool(handlers: CodegraphMcpHandlers, input: unknown, signal?: AbortSignal): Promise<GoToResult> {
  const request = parseMcpToolInput(navigationSchema, input, "goto");
  if (request.handle !== undefined) return await handlers.goto({ handle: request.handle }, signal);
  if (request.file === undefined || request.line === undefined || request.column === undefined) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "goto requires either handle or file, line, and column.");
  }
  return await handlers.goto({ file: request.file, line: request.line, column: request.column }, signal);
}

async function callRefsTool(
  handlers: CodegraphMcpHandlers,
  input: unknown,
  signal?: AbortSignal,
): Promise<McpTruncationMeta & { references: AgentExplanationReference[] }> {
  const request = parseMcpToolInput(refsSchema, input, "refs");
  if (request.handle !== undefined) {
    return await handlers.refs(
      { handle: request.handle, ...(request.limit !== undefined ? { limit: request.limit } : {}) },
      signal,
    );
  }
  if (request.file === undefined || request.line === undefined || request.column === undefined) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "refs requires either handle or file, line, and column.");
  }
  return await handlers.refs(
    {
      file: request.file,
      line: request.line,
      column: request.column,
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    },
    signal,
  );
}

function toToolResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function toToolErrorResult(error: unknown): CallToolResult {
  const message = errorMessage(error).replace(/(?:[A-Za-z]:)?[/\\][^'"\n]*?(?=(?:[/\\][^'"\n]*)?['"]|$)/g, "<path>");
  return { isError: true, content: [{ type: "text", text: message }] };
}
const mcpProgressTokenSchema = z.union([z.string(), z.number()]);
const toolCallMetaSchema = z
  .object({
    _meta: z.object({ progressToken: mcpProgressTokenSchema.optional() }).passthrough().optional(),
    progressToken: mcpProgressTokenSchema.optional(),
  })
  .passthrough();

function getToolCallProgressToken(params: unknown): string | number | undefined {
  const parsed = toolCallMetaSchema.safeParse(params);
  if (!parsed.success) return undefined;
  return parsed.data._meta?.progressToken ?? parsed.data.progressToken;
}

function formatMcpInvalidParams(toolName: string, error: z.ZodError): string {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `Invalid parameters for ${toolName}: ${details}`;
}

function parseMcpToolInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, formatMcpInvalidParams(toolName, parsed.error));
}

const searchSchema = z
  .object({
    query: z.string(),
    mode: z.enum(["hybrid", "symbol", "path", "text", "graph", "sql"]).optional(),
    from: z.string().optional(),
    depth: z.number().int().nonnegative().max(MAX_GRAPH_DEPTH).optional(),
    limit: z.number().int().nonnegative().optional(),
  })
  .strict();

const workspaceSymbolsSchema = z
  .object({
    query: z.string(),
    kinds: z.array(z.nativeEnum(SymbolKind)).optional(),
    exportedOnly: z.boolean().optional(),
    includeImports: z.boolean().optional(),
    fileGlob: z.string().optional(),
    limit: z.number().int().nonnegative().max(MAX_WORKSPACE_SYMBOL_LIMIT).optional(),
  })
  .strict();

const renamePreviewSchema = z
  .object({
    handle: z.string(),
    newName: z.string(),
    includeComments: z.boolean().optional(),
    includeStrings: z.boolean().optional(),
    includeFilenames: z.boolean().optional(),
    maxEdits: z.number().int().min(1).max(MAX_RENAME_PREVIEW_EDITS).optional(),
  })
  .strict();

const refactorPlanSchema = z
  .object({
    handle: z.string(),
    renameTo: z.string().optional(),
    maxReferences: z.number().int().nonnegative().max(MAX_REFACTOR_PLAN_LIMIT).optional(),
    maxCallers: z.number().int().nonnegative().max(MAX_REFACTOR_PLAN_LIMIT).optional(),
    maxHierarchy: z.number().int().nonnegative().max(MAX_REFACTOR_PLAN_LIMIT).optional(),
    includeSource: z.boolean().optional(),
  })
  .strict();

const callHierarchySchema = z
  .object({
    handle: z.string(),
    depth: z.number().int().min(1).max(5).optional(),
    limit: z.number().int().nonnegative().max(500).optional(),
    includeHeuristic: z.boolean().optional(),
  })
  .strict();
const callsSchema = callHierarchySchema
  .extend({
    direction: z.enum(["callers", "callees"]),
  })
  .strict();

const typeHierarchySchema = z
  .object({
    handle: z.string(),
    depth: z.number().int().min(1).max(10).optional(),
    limit: z.number().int().nonnegative().max(500).optional(),
  })
  .strict();
const typeHierarchyUnifiedSchema = typeHierarchySchema
  .extend({
    direction: z.enum(["supertypes", "subtypes"]),
  })
  .strict();

const implementationsSchema = z
  .object({
    handle: z.string(),
    limit: z.number().int().nonnegative().max(500).optional(),
  })
  .strict();

const exploreSchema = z
  .object({
    query: z.string(),
    limit: z.number().int().nonnegative().max(50).optional(),
    maxPackets: z.number().int().nonnegative().max(10).optional(),
    maxPaths: z.number().int().nonnegative().max(10).optional(),
    includeSource: z.boolean().optional(),
  })
  .strict();

const orientSchema = z
  .object({
    includeRoots: z.array(z.string()).optional(),
    budget: z.enum(["small", "medium", "large"]).optional(),
  })
  .strict();

const packetGetSchema = z
  .object({
    target: z.string(),
    maxSymbols: z.number().int().positive().max(200).optional(),
    maxSnippets: z.number().int().positive().max(50).optional(),
    maxDuplicates: z.number().int().positive().max(20).optional(),
  })
  .strict();

const getFileSchema = z
  .object({
    file: z.string(),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(MAX_FILE_VIEW_LINES).optional(),
    maxBytes: z.number().int().positive().max(MAX_FILE_VIEW_BYTES).optional(),
    includeGraphContext: z.boolean().optional(),
    allowSensitive: z.boolean().optional(),
  })
  .strict();

const handleSchema = z
  .object({
    handle: z.string(),
  })
  .strict();

const navigationSchema = z
  .object({
    handle: z.string().optional(),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (request) => {
      const hasHandle = request.handle !== undefined;
      const hasAnyPosition = request.file !== undefined || request.line !== undefined || request.column !== undefined;
      const hasCompletePosition =
        request.file !== undefined && request.line !== undefined && request.column !== undefined;
      return hasHandle ? !hasAnyPosition : hasCompletePosition;
    },
    { message: "goto requires either handle or file, line, and column." },
  );

const refsSchema = z
  .object({
    handle: z.string().optional(),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().nonnegative().optional(),
    limit: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (request) => {
      const hasHandle = request.handle !== undefined;
      const hasAnyPosition = request.file !== undefined || request.line !== undefined || request.column !== undefined;
      const hasCompletePosition =
        request.file !== undefined && request.line !== undefined && request.column !== undefined;
      return hasHandle ? !hasAnyPosition : hasCompletePosition;
    },
    {
      message: "refs requires either handle or file, line, and column.",
    },
  );

const fileGraphSchema = z
  .object({
    file: z.string(),
    depth: z.number().int().nonnegative().optional(),
    limit: z.number().int().nonnegative().optional(),
  })
  .strict();
const fileDepsUnifiedSchema = fileGraphSchema
  .extend({
    direction: z.enum(["deps", "rdeps"]),
  })
  .strict();

const pathSchema = z
  .object({
    from: z.string(),
    to: z.string(),
  })
  .strict();

const gitRangeSchema = z
  .object({
    base: z.string(),
    head: z.string(),
  })
  .strict();

const reviewSchema = z
  .object({
    base: z.string(),
    head: z.string(),
    reviewDepth: z.enum(["minimal", "standard", "deep"]).optional(),
  })
  .strict();

const querySqliteSchema = z
  .object({
    query: z.string(),
    params: z.array(z.union([z.string(), z.number(), z.null()])).optional(),
    limit: z.number().int().nonnegative().optional(),
  })
  .strict();

const refreshIndexSchema = z
  .object({
    warmup: z.enum(["off", "base", "symbols"]).optional(),
  })
  .strict();

const artifactBuildSchema = z
  .object({
    outDir: z.string().optional(),
    sqlite: z.boolean().optional(),
    graphJson: z.boolean().optional(),
    report: z.boolean().optional(),
    questions: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict();
