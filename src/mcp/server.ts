import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import path from "node:path";
import {
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
  Server,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
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
import { searchCodegraphWithSession } from "../agent/search.js";
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
import { buildReviewReport, type ReviewDepth, type ReviewReport } from "../review.js";
import { SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY, queryGraphSqliteRaw, type RawSqlResult } from "../sqlite.js";
import { isPlainRecord } from "../util/guards.js";
import { toProjectDisplayPath } from "../util/paths.js";
import { errorMessage } from "../util/errors.js";
import { createAgentSession, listAgentSessionFiles } from "../agent/session.js";
import { mapLimit } from "../util/concurrency.js";
import { assertRealPathCandidateWithinRoot, resolveProjectFile } from "../util/confinedFile.js";
import type { AgentFreshnessResult, AgentProjectSnapshot, AgentSession } from "../agent/session.js";
import { SymbolKind } from "../indexer/types.js";
import { DEFAULT_WORKSPACE_SYMBOL_LIMIT, MAX_WORKSPACE_SYMBOL_LIMIT } from "../indexer/workspace-symbols.js";
import type { BuildOptions, GoToResult } from "../indexer/types.js";
import {
  assertMcpSqliteQueryResourceBounded,
  boundRawSqlResult,
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
  MCP_TOOLS,
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

type LegacyMcpSession = {
  server: Server;
  transport: NodeStreamableHTTPServerTransport;
};

type OriginValidator = (request: IncomingMessage, response: ServerResponse) => boolean;

export type CodegraphMcpFreshResult<T extends object> = T & { freshness: AgentFreshnessResult };

export type CodegraphMcpHandlers = {
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
    CodegraphMcpFreshResult<{
      dependencies?: Array<{ file: string; depth: number }>;
      reverseDependencies?: Array<{ file: string; depth: number }>;
    }>
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
  ) => Promise<CodegraphMcpFreshResult<{ references: AgentExplanationReference[] }>>;
  deps: (request: {
    file: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<CodegraphMcpFreshResult<{ dependencies: Array<{ file: string; depth: number }> }>>;
  rdeps: (request: {
    file: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<CodegraphMcpFreshResult<{ reverseDependencies: Array<{ file: string; depth: number }> }>>;
  path: (request: { from: string; to: string }) => Promise<CodegraphMcpFreshResult<{ path: string[] | null }>>;
  impact: (request: { base: string; head: string }) => Promise<CodegraphMcpFreshResult<CompactImpactReport>>;
  review: (request: {
    base: string;
    head: string;
    reviewDepth?: ReviewDepth | undefined;
  }) => Promise<CodegraphMcpFreshResult<ReviewReport>>;
  refresh_index: (request: { warmup?: CodegraphMcpWarmupMode | undefined }) => Promise<{
    refreshed: true;
    warmup: CodegraphMcpWarmupMode;
  }>;
  query_sqlite: (request: {
    query: string;
    params?: Array<string | number | null> | undefined;
    limit?: number | undefined;
  }) => Promise<CodegraphMcpFreshResult<RawSqlResult>>;
  artifact_build: (request: {
    outDir?: string | undefined;
    sqlite?: boolean | undefined;
    graphJson?: boolean | undefined;
    report?: boolean | undefined;
    questions?: boolean | undefined;
    force?: boolean | undefined;
  }) => Promise<CodegraphMcpFreshResult<CodegraphArtifactBuildResult>>;
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

type SqliteArtifactFileSignature = {
  path: string;
  size: number;
  mtimeMs: number;
};

const MAX_MCP_FRESHNESS_CHANGED_FILES = 25;
const SQLITE_ARTIFACT_STAT_CONCURRENCY = 64;

function assertMcpSessionOptions(options: CodegraphMcpHandlerOptions): void {
  if (options.session !== undefined && options.buildOptions !== undefined) {
    throw new Error("MCP server options cannot combine a prebuilt session with buildOptions.");
  }
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

async function createWarmedCodegraphMcpHandlers(options: CodegraphMcpServerOptions): Promise<CodegraphMcpHandlers> {
  const root = path.resolve(options.root);
  const session = createCodegraphMcpSession(options, root);
  await startCodegraphMcpWarmup(session, options.warmup);
  const { warmup, host, port, onHttpListen, ...handlerOptions } = options;
  void warmup;
  void host;
  void port;
  void onHttpListen;
  return createCodegraphMcpHandlersForSession({ ...handlerOptions, root }, session);
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
      omittedChangedFileCount: Math.max(0, changedFiles.length - boundedChangedFiles.length),
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
    const freshness = await checkMcpFreshness();
    const result = await run();
    return { ...result, freshness };
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
  const rebuildSqliteArtifactForQuery = async (): Promise<void> => {
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
  };
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
  ): Promise<McpDependencyEntry[]> => {
    const snapshot = await session.loadProject({ symbolGraph: "skip" });
    const queryOptions = {
      ...(request.depth !== undefined ? { depth: request.depth } : {}),
      limit: boundedLimit(request.limit, DEFAULT_MCP_COLLECTION_LIMIT, MAX_MCP_COLLECTION_LIMIT),
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
    return collectEntries(snapshot.fileGraph, targetFile, queryOptions).map((dependency) => ({
      file: relative(dependency.file),
      depth: dependency.depth,
    }));
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
  const fileDeps = async (request: {
    direction: "deps" | "rdeps";
    file: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }) =>
    await withFreshness(async () => {
      const entries = await collectMcpDependencyEntries(
        request,
        request.direction === "deps" ? getDependencies : getReverseDependencies,
      );
      return request.direction === "deps" ? { dependencies: entries } : { reverseDependencies: entries };
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

        if (handle !== undefined) {
          if (parseQualifiedSymbolPath(handle)) {
            const snapshot = await session.loadProject({ symbolGraph: "skip" });
            const resolved = requireSemanticSymbol(snapshot, handle);
            const result = await findReferences(
              snapshot.index,
              { def: resolved.def },
              {
                maxReferences: boundedLimit(request.limit, DEFAULT_MCP_COLLECTION_LIMIT, MAX_MCP_COLLECTION_LIMIT),
              },
            );
            return {
              references:
                result.status === "ok"
                  ? result.references.map((reference) => ({ file: relative(reference.file), range: reference.range }))
                  : [],
            };
          }
          const explanation = await explainCodegraphTargetWithSession(session, {
            root,
            target: handle,
            maxReferences: boundedLimit(request.limit, DEFAULT_MCP_COLLECTION_LIMIT, MAX_MCP_COLLECTION_LIMIT),
          });
          return { references: explanation.references };
        }
        if (file === undefined || line === undefined || column === undefined) {
          throw new Error("refs requires either handle or file, line, and column.");
        }

        const snapshot = await session.loadProject({ symbolGraph: "skip" });
        const referenceOptions = {
          maxReferences: boundedLimit(request.limit, DEFAULT_MCP_COLLECTION_LIMIT, MAX_MCP_COLLECTION_LIMIT),
        };
        const result = await findReferences(
          snapshot.index,
          {
            file: await resolveProjectFile(await realRoot, root, file),
            line,
            column,
          },
          referenceOptions,
        );
        if (result.status !== "ok") return { references: [] };
        return {
          references: result.references.map((reference) => ({
            file: relative(reference.file),
            range: reference.range,
          })),
        };
      }),

    deps: async (request) =>
      await withFreshness(async () => {
        const dependencies = await collectMcpDependencyEntries(request, getDependencies);
        return { dependencies };
      }),

    rdeps: async (request) =>
      await withFreshness(async () => {
        const reverseDependencies = await collectMcpDependencyEntries(request, getReverseDependencies);
        return { reverseDependencies };
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
        return await buildReviewReport(
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
      }),

    query_sqlite: async (request) => {
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
      });
      return { ...boundRawSqlResult(result, DEFAULT_SQLITE_BYTE_LIMIT), freshness: artifactFreshness };
    },

    refresh_index: async (request) => {
      const warmup = request.warmup ?? "off";
      session.invalidate();
      sqlitePath = configuredSqlitePath;
      sqliteOutDir = configuredSqliteOutDir;
      sqliteCanRefresh = configuredSqliteCanRefresh;
      await startCodegraphMcpWarmup(session, warmup);
      return { refreshed: true, warmup };
    },

    artifact_build: async (request) => {
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
    },
  };
}

export function createCodegraphMcpProtocolServer(
  handlers: CodegraphMcpHandlers,
  runtimeIdentity: CodegraphRuntimeIdentity = captureCodegraphRuntimeIdentity(getCurrentNativeBindingOrigin()),
  installedVersion: InstalledVersionChecker = createInstalledVersionChecker(runtimeIdentity),
  toolCallState: { firstToolCallPending: boolean } = { firstToolCallPending: true },
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

  server.setRequestHandler("tools/list", () => ({ tools: MCP_TOOLS }));
  server.setRequestHandler("tools/call", async (request, ctx): Promise<CallToolResult> => {
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
            params: {
              progressToken,
              progress,
              total: 1,
              message,
            },
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
      const result = await callMcpTool(handlers, request.params.name, request.params.arguments ?? {});
      await emitFirstToolCallVisibility(
        "info",
        1,
        `Codegraph finished warming the first tool call for '${request.params.name}'.`,
      );
      return toToolResult(result);
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

function createCodegraphMcpProtocolFactory(
  handlers: CodegraphMcpHandlers,
  runtimeIdentity: CodegraphRuntimeIdentity,
): () => Server {
  const installedVersion = createInstalledVersionChecker(runtimeIdentity);
  const toolCallState = { firstToolCallPending: true };
  return () => createCodegraphMcpProtocolServer(handlers, runtimeIdentity, installedVersion, toolCallState);
}

export async function serveCodegraphMcp(options: CodegraphMcpServerOptions): Promise<void> {
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

  const handlers = await createWarmedCodegraphMcpHandlers(options);
  const runtimeIdentity = options.runtimeIdentity ?? captureCodegraphRuntimeIdentity(getCurrentNativeBindingOrigin());
  const createProtocolServer = createCodegraphMcpProtocolFactory(handlers, runtimeIdentity);
  const handle = serveStdio(createProtocolServer, {
    legacy: "serve",
    onerror: (error) => {
      console.error(`[codegraph] MCP stdio error: ${error.message}`);
    },
  });
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_MCP_STDIO_IDLE_TIMEOUT_MS;
  await awaitStdioMcpLifecycle(handle, {
    idleTimeoutMs,
    onShutdown: (shutdownReason) => {
      console.error(`[codegraph] MCP stdio shutting down (${shutdownReason})`);
    },
  });
  // Ensure orphaned stdio servers do not linger after the client is gone.
  process.exitCode = 0;
}

export async function startCodegraphMcpHttpServer(
  options: CodegraphMcpServerOptions & { port: number },
): Promise<CodegraphMcpHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const handlers = await createWarmedCodegraphMcpHandlers(options);
  const runtimeIdentity = options.runtimeIdentity ?? captureCodegraphRuntimeIdentity(getCurrentNativeBindingOrigin());
  const createProtocolServer = createCodegraphMcpProtocolFactory(handlers, runtimeIdentity);
  const sessions = new Map<string, LegacyMcpSession>();
  const modernHandler = createMcpHandler(createProtocolServer, {
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
    closeResourcesPromise ??= closeMcpResources(sessions, modernHandler.close);
    return closeResourcesPromise;
  };

  const server = createServer((request, response) => {
    void handleMcpHttpRequest(
      request,
      response,
      sessions,
      () => allowedHostHeaders,
      validateOrigin,
      modernNodeHandler,
      createProtocolServer,
    );
  });

  server.on("close", () => {
    void closeResources();
  });

  await listenOnHttpServer(server, options.port, host);
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
      await closeLegacyMcpSessions(sessions);
    },
  };
}

async function handleMcpHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: Map<string, LegacyMcpSession>,
  getAllowedHostHeaders: () => AllowedHostHeaderRules,
  validateOrigin: OriginValidator,
  modernNodeHandler: NodeMcpRequestHandler,
  createProtocolServer: () => Server,
): Promise<void> {
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
      const parsedBody = await readJsonRequestBody(request, MAX_MCP_HTTP_BODY_BYTES);
      if (parsedBody.status === "too_large") {
        writeJsonRpcError(response, 413, "MCP request body is too large");
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
        await handleLegacyMcpHttpPost(request, response, parsedBody.body, sessions, createProtocolServer);
      } else {
        await modernNodeHandler(mcpRequest, response, parsedBody.body);
      }
      return;
    }

    if (request.method === "GET" || request.method === "DELETE") {
      await handleExistingMcpSessionRequest(request, response, sessions);
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
  sessions: Map<string, LegacyMcpSession>,
  createProtocolServer: () => Server,
): Promise<void> {
  const sessionId = getHeaderValue(request.headers["mcp-session-id"]);
  if (sessionId !== undefined) {
    const session = sessions.get(sessionId);
    if (!session) {
      writeJsonRpcError(response, 400, "Bad Request: No valid session ID provided");
      return;
    }
    await session.transport.handleRequest(request, response, body);
    return;
  }

  if (!isInitializeRequest(body)) {
    writeJsonRpcError(response, 400, "Bad Request: No valid session ID provided");
    return;
  }

  const protocolServer = createProtocolServer();
  let initializedSessionId: string | undefined;
  const transport = new NodeStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      initializedSessionId = newSessionId;
      sessions.set(newSessionId, { server: protocolServer, transport });
    },
    onsessionclosed: (closedSessionId) => {
      const session = sessions.get(closedSessionId);
      if (session) {
        sessions.delete(closedSessionId);
        void closeMcpSession(session);
      }
    },
  });

  try {
    await protocolServer.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    if (initializedSessionId !== undefined) {
      sessions.delete(initializedSessionId);
    }
    await closeMcpSession({ server: protocolServer, transport });
    throw error;
  }
}

async function handleExistingMcpSessionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: Map<string, LegacyMcpSession>,
): Promise<void> {
  const sessionId = getHeaderValue(request.headers["mcp-session-id"]);
  if (sessionId === undefined) {
    writeJsonRpcError(response, 400, "Invalid or missing session ID");
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    writeJsonRpcError(response, 400, "Invalid or missing session ID");
    return;
  }
  await session.transport.handleRequest(request, response);
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

async function callMcpTool(handlers: CodegraphMcpHandlers, name: string, input: unknown): Promise<unknown> {
  switch (name) {
    case "search":
      return await handlers.search(searchSchema.parse(input));
    case "workspace_symbols":
      return await handlers.workspace_symbols(workspaceSymbolsSchema.parse(input));
    case "rename_preview":
      return await handlers.rename_preview(renamePreviewSchema.parse(input));
    case "refactor_plan":
      return await handlers.refactor_plan(refactorPlanSchema.parse(input));
    case "calls":
      return await handlers.calls(callsSchema.parse(input));
    case "callers":
      return await handlers.calls({ ...callHierarchySchema.parse(input), direction: "callers" });
    case "callees":
      return await handlers.calls({ ...callHierarchySchema.parse(input), direction: "callees" });
    case "type_hierarchy":
      return await handlers.type_hierarchy(typeHierarchyUnifiedSchema.parse(input));
    case "supertypes":
      return await handlers.type_hierarchy({ ...typeHierarchySchema.parse(input), direction: "supertypes" });
    case "subtypes":
      return await handlers.type_hierarchy({ ...typeHierarchySchema.parse(input), direction: "subtypes" });
    case "implementations":
      return await handlers.implementations(implementationsSchema.parse(input));
    case "explore":
      return await handlers.explore(exploreSchema.parse(input));
    case "orient":
      return await handlers.orient(orientSchema.parse(input));
    case "packet_get":
      return await handlers.packet_get(packetGetSchema.parse(input));
    case "get_file":
      return await handlers.get_file(getFileSchema.parse(input));
    case "get_symbol":
      return await handlers.get_symbol(handleSchema.parse(input));
    case "goto":
      return await callGotoTool(handlers, input);
    case "refs":
      return await callRefsTool(handlers, input);
    case "file_deps":
      return await handlers.file_deps(fileDepsUnifiedSchema.parse(input));
    case "deps":
      return await handlers.file_deps({ ...fileGraphSchema.parse(input), direction: "deps" });
    case "rdeps":
      return await handlers.file_deps({ ...fileGraphSchema.parse(input), direction: "rdeps" });
    case "path":
      return await handlers.path(pathSchema.parse(input));
    case "impact":
      return await handlers.impact(gitRangeSchema.parse(input));
    case "review":
      return await handlers.review(reviewSchema.parse(input));
    case "query_sqlite":
      return await handlers.query_sqlite(querySqliteSchema.parse(input));
    case "refresh_index":
      return await handlers.refresh_index(refreshIndexSchema.parse(input));
    case "artifact_build":
      return await handlers.artifact_build(artifactBuildSchema.parse(input));
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

async function callGotoTool(handlers: CodegraphMcpHandlers, input: unknown): Promise<GoToResult> {
  const request = navigationSchema.parse(input);
  if (request.handle !== undefined) return await handlers.goto({ handle: request.handle });
  if (request.file === undefined || request.line === undefined || request.column === undefined) {
    throw new Error("goto requires either handle or file, line, and column.");
  }
  return await handlers.goto({ file: request.file, line: request.line, column: request.column });
}

async function callRefsTool(
  handlers: CodegraphMcpHandlers,
  input: unknown,
): Promise<{ references: AgentExplanationReference[] }> {
  const request = refsSchema.parse(input);
  if (request.handle !== undefined) {
    return await handlers.refs({
      handle: request.handle,
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    });
  }
  if (request.file === undefined || request.line === undefined || request.column === undefined) {
    throw new Error("refs requires either handle or file, line, and column.");
  }
  return await handlers.refs({
    file: request.file,
    line: request.line,
    column: request.column,
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  });
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

const searchSchema = z.object({
  query: z.string(),
  mode: z.enum(["hybrid", "symbol", "path", "text", "graph", "sql"]).optional(),
  from: z.string().optional(),
  depth: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
});

const workspaceSymbolsSchema = z.object({
  query: z.string(),
  kinds: z.array(z.nativeEnum(SymbolKind)).optional(),
  exportedOnly: z.boolean().optional(),
  includeImports: z.boolean().optional(),
  fileGlob: z.string().optional(),
  limit: z.number().int().nonnegative().max(MAX_WORKSPACE_SYMBOL_LIMIT).optional(),
});

const renamePreviewSchema = z.object({
  handle: z.string(),
  newName: z.string(),
  includeComments: z.boolean().optional(),
  includeStrings: z.boolean().optional(),
  includeFilenames: z.boolean().optional(),
  maxEdits: z.number().int().min(1).max(MAX_RENAME_PREVIEW_EDITS).optional(),
});

const refactorPlanSchema = z.object({
  handle: z.string(),
  renameTo: z.string().optional(),
  maxReferences: z.number().int().nonnegative().max(MAX_REFACTOR_PLAN_LIMIT).optional(),
  maxCallers: z.number().int().nonnegative().max(MAX_REFACTOR_PLAN_LIMIT).optional(),
  maxHierarchy: z.number().int().nonnegative().max(MAX_REFACTOR_PLAN_LIMIT).optional(),
  includeSource: z.boolean().optional(),
});

const callHierarchySchema = z.object({
  handle: z.string(),
  depth: z.number().int().min(1).max(5).optional(),
  limit: z.number().int().nonnegative().max(500).optional(),
  includeHeuristic: z.boolean().optional(),
});
const callsSchema = callHierarchySchema.extend({
  direction: z.enum(["callers", "callees"]),
});

const typeHierarchySchema = z.object({
  handle: z.string(),
  depth: z.number().int().min(1).max(10).optional(),
  limit: z.number().int().nonnegative().max(500).optional(),
});
const typeHierarchyUnifiedSchema = typeHierarchySchema.extend({
  direction: z.enum(["supertypes", "subtypes"]),
});

const implementationsSchema = z.object({
  handle: z.string(),
  limit: z.number().int().nonnegative().max(500).optional(),
});

const exploreSchema = z.object({
  query: z.string(),
  limit: z.number().int().nonnegative().max(50).optional(),
  maxPackets: z.number().int().nonnegative().max(10).optional(),
  maxPaths: z.number().int().nonnegative().max(10).optional(),
  includeSource: z.boolean().optional(),
});

const orientSchema = z.object({
  includeRoots: z.array(z.string()).optional(),
  budget: z.enum(["small", "medium", "large"]).optional(),
});

const packetGetSchema = z.object({
  target: z.string(),
  maxSymbols: z.number().int().positive().max(200).optional(),
  maxSnippets: z.number().int().positive().max(50).optional(),
  maxDuplicates: z.number().int().positive().max(20).optional(),
});

const getFileSchema = z.object({
  file: z.string(),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(MAX_FILE_VIEW_LINES).optional(),
  maxBytes: z.number().int().positive().max(MAX_FILE_VIEW_BYTES).optional(),
  includeGraphContext: z.boolean().optional(),
  allowSensitive: z.boolean().optional(),
});

const handleSchema = z.object({
  handle: z.string(),
});

const navigationSchema = z
  .object({
    handle: z.string().optional(),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().nonnegative().optional(),
  })
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

const fileGraphSchema = z.object({
  file: z.string(),
  depth: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
});
const fileDepsUnifiedSchema = fileGraphSchema.extend({
  direction: z.enum(["deps", "rdeps"]),
});

const pathSchema = z.object({
  from: z.string(),
  to: z.string(),
});

const gitRangeSchema = z.object({
  base: z.string(),
  head: z.string(),
});

const reviewSchema = z.object({
  base: z.string(),
  head: z.string(),
  reviewDepth: z.enum(["minimal", "standard", "deep"]).optional(),
});

const querySqliteSchema = z.object({
  query: z.string(),
  params: z.array(z.union([z.string(), z.number(), z.null()])).optional(),
  limit: z.number().int().nonnegative().optional(),
});

const refreshIndexSchema = z.object({
  warmup: z.enum(["off", "base", "symbols"]).optional(),
});

const artifactBuildSchema = z.object({
  outDir: z.string().optional(),
  sqlite: z.boolean().optional(),
  graphJson: z.boolean().optional(),
  report: z.boolean().optional(),
  questions: z.boolean().optional(),
  force: z.boolean().optional(),
});
