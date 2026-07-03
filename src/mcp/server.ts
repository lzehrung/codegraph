import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { buildCodegraphArtifactWithSession } from "../agent/artifact.js";
import type { CodegraphArtifactBuildResult } from "../agent/artifact.js";
import { explainCodegraphTargetWithSession } from "../agent/explain.js";
import type { AgentExplanation, AgentExplanationReference } from "../agent/explain.js";
import { orientCodegraphWithSession, type AgentOrientBudget, type AgentOrientResponse } from "../agent/orient.js";
import { getCodegraphPacketWithSession, type AgentPacketResponse } from "../agent/packet.js";
import { searchCodegraphWithSession } from "../agent/search.js";
import type { AgentSearchMode, AgentSearchResponse } from "../agent/search.js";
import { getDependencies, getReverseDependencies, getShortestPath, type DependencyNode } from "../graphs/queries.js";
import { findReferences, goToDefinition } from "../indexer/navigation.js";
import { buildReviewReport, type ReviewDepth, type ReviewReport } from "../review.js";
import { SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY, queryGraphSqliteRaw, type RawSqlResult } from "../sqlite.js";
import { isPlainRecord } from "../util/guards.js";
import { toProjectDisplayPath } from "../util/paths.js";
import { createAgentSession, listAgentSessionFiles } from "../agent/session.js";
import type { AgentFreshnessResult, AgentProjectSnapshot, AgentSession } from "../agent/session.js";
import type { BuildOptions, GoToResult } from "../indexer/types.js";
import {
  assertMcpSqliteQueryResourceBounded,
  boundRawSqlResult,
  DEFAULT_SQLITE_BYTE_LIMIT,
  normalizeSqliteRowLimit,
} from "./sqliteGuard.js";
import {
  DEFAULT_FILE_BYTES,
  DEFAULT_MCP_COLLECTION_LIMIT,
  listCodegraphMcpTools,
  MAX_FILE_BYTES,
  MAX_MCP_COLLECTION_LIMIT,
  MCP_TOOLS,
} from "./tools.js";
import {
  buildAllowedHostHeaders,
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

export { listCodegraphMcpTools } from "./tools.js";
import {
  assertRealPathCandidateWithinRoot,
  assertWritableDirectoryRealPathWithinRoot,
  readFilePrefix,
  resolveArtifactSqlitePathCandidate,
  resolveProjectFile,
  resolveReadableFile,
} from "./security.js";

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
  onHttpListen?: ((info: CodegraphMcpHttpServerInfo) => void) | undefined;
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

export type CodegraphMcpFreshResult<T extends object> = T & { freshness: AgentFreshnessResult };

export type CodegraphMcpHandlers = {
  search: (request: {
    query: string;
    mode?: AgentSearchMode | undefined;
    from?: string | undefined;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<CodegraphMcpFreshResult<AgentSearchResponse>>;
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
    maxBytes?: number | undefined;
  }) => Promise<CodegraphMcpFreshResult<{ file: string; text: string; truncated: boolean }>>;
  get_symbol: (request: { handle: string }) => Promise<CodegraphMcpFreshResult<AgentExplanation["target"]>>;
  goto: (request: { file: string; line: number; column: number }) => Promise<CodegraphMcpFreshResult<GoToResult>>;
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
  impact: (request: { base: string; head: string }) => Promise<CodegraphMcpFreshResult<ReviewReport>>;
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
    return staleFreshness([], "freshness check unavailable");
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
    return `SQLite artifact is stale; run artifact_build before query_sqlite. ${reason}.${changed}${omitted}`;
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
    const parsed: unknown = JSON.parse(rawValue);
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
    const currentFiles = (
      await listAgentSessionFiles({
        root,
        ...(options.buildOptions ? { buildOptions: options.buildOptions } : {}),
      })
    ).filter((file) => !outputDirectories.some((directory) => isFileInsideDirectory(file, directory)));
    const signatures = new Map<string, SqliteArtifactFileSignature>();
    await Promise.all(
      currentFiles.map(async (file) => {
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
      }),
    );
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
    return collectEntries(
      snapshot.fileGraph,
      await resolveProjectFile(await realRoot, root, request.file),
      queryOptions,
    ).map((dependency) => ({
      file: relative(dependency.file),
      depth: dependency.depth,
    }));
  };

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
      await withFreshness(async () => {
        const resolvedFile = await resolveReadableFile(await realRoot, root, request.file);
        const maxBytes = boundedLimit(request.maxBytes, DEFAULT_FILE_BYTES, MAX_FILE_BYTES);
        const read = await readFilePrefix(resolvedFile.realPath, maxBytes);
        return {
          file: resolvedFile.displayPath,
          text: read.text,
          truncated: read.truncated,
        };
      }),

    get_symbol: async (request) =>
      await withFreshness(async () => {
        const explanation = await explainCodegraphTargetWithSession(session, { root, target: request.handle });
        return explanation.target;
      }),

    goto: async (request) =>
      await withFreshness(async () => {
        const snapshot = await session.loadProject({ symbolGraph: "skip" });
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
      await withFreshness(
        async () =>
          await buildReviewReport(root, {
            ...options.buildOptions,
            gitBase: request.base,
            gitHead: request.head,
            reviewDepth: "minimal",
          }),
      ),

    review: async (request) =>
      await withFreshness(
        async () =>
          await buildReviewReport(root, {
            ...options.buildOptions,
            gitBase: request.base,
            gitHead: request.head,
            ...(request.reviewDepth !== undefined ? { reviewDepth: request.reviewDepth } : {}),
          }),
      ),

    query_sqlite: async (request) => {
      if (!sqlitePath) {
        throw new Error("No SQLite artifact is available. Run artifact_build first or pass artifactPath.");
      }
      assertMcpSqliteQueryResourceBounded(request.query);
      let freshness = await checkMcpFreshness();
      freshness = await refreshSqliteArtifactForQuery(freshness);
      let realSqlitePath = await assertRealPathCandidateWithinRoot(await realRoot, sqlitePath, "SQLite artifact");
      const artifactFreshness = await checkSqliteArtifactFreshness(realSqlitePath);
      if (artifactFreshness.state !== "fresh") {
        freshness = await refreshSqliteArtifactForQuery(artifactFreshness, { allowStaleRebuild: true });
        realSqlitePath = await assertRealPathCandidateWithinRoot(await realRoot, sqlitePath, "SQLite artifact");
      }
      const result = await queryGraphSqliteRaw(realSqlitePath, request.query, request.params ?? [], {
        maxRows: normalizeSqliteRowLimit(request.limit),
      });
      return { ...boundRawSqlResult(result, DEFAULT_SQLITE_BYTE_LIMIT), freshness };
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

    artifact_build: async (request) =>
      await withFreshness(async () => {
        if (readOnly) {
          throw new Error("artifact_build is disabled in read-only MCP mode.");
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
        return result;
      }),
  };
}

function createCodegraphMcpProtocolServer(handlers: CodegraphMcpHandlers): McpServer {
  const server = new McpServer(
    {
      name: "codegraph",
      version: "1.0.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: MCP_TOOLS }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const result = await callMcpTool(handlers, request.params.name, request.params.arguments ?? {});
    return toToolResult(result);
  });

  return server;
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
  const server = createCodegraphMcpProtocolServer(handlers);
  await server.connect(new StdioServerTransport());
}

export async function startCodegraphMcpHttpServer(
  options: CodegraphMcpServerOptions & { port: number },
): Promise<CodegraphMcpHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const handlers = await createWarmedCodegraphMcpHandlers(options);
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();
  let allowedHostHeaders = emptyAllowedHostHeaderRules();

  const server = createServer((request, response) => {
    void handleMcpHttpRequest(request, response, handlers, sessions, () => allowedHostHeaders);
  });

  server.on("close", () => {
    for (const [sessionId, session] of sessions) {
      sessions.delete(sessionId);
      void closeMcpSession(session);
    }
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
      for (const [sessionId, session] of sessions) {
        sessions.delete(sessionId);
        await closeMcpSession(session);
      }
      await closeHttpServer(server);
    },
  };
}

async function handleMcpHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handlers: CodegraphMcpHandlers,
  sessions: Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>,
  getAllowedHostHeaders: () => AllowedHostHeaderRules,
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
      await handleMcpHttpPost(request, response, parsedBody.body, handlers, sessions);
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

async function handleMcpHttpPost(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  handlers: CodegraphMcpHandlers,
  sessions: Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>,
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

  const protocolServer = createCodegraphMcpProtocolServer(handlers);
  let initializedSessionId: string | undefined;
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      if (transport !== undefined) {
        initializedSessionId = newSessionId;
        sessions.set(newSessionId, { server: protocolServer, transport });
      }
    },
    onsessionclosed: (closedSessionId) => {
      const session = sessions.get(closedSessionId);
      if (session) {
        sessions.delete(closedSessionId);
        void closeMcpSession(session);
      }
    },
  });

  // The SDK class implements Transport, but its declarations widen optional callbacks under exactOptionalPropertyTypes.
  try {
    await protocolServer.connect(transport as Transport);
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
  sessions: Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>,
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

async function closeMcpSession(session: {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}): Promise<void> {
  await Promise.allSettled([session.transport.close(), session.server.close()]);
}

async function callMcpTool(handlers: CodegraphMcpHandlers, name: string, input: unknown): Promise<unknown> {
  switch (name) {
    case "search":
      return await handlers.search(searchSchema.parse(input));
    case "orient":
      return await handlers.orient(orientSchema.parse(input));
    case "packet_get":
      return await handlers.packet_get(packetGetSchema.parse(input));
    case "get_file":
      return await handlers.get_file(getFileSchema.parse(input));
    case "get_symbol":
      return await handlers.get_symbol(handleSchema.parse(input));
    case "goto":
      return await handlers.goto(navigationSchema.parse(input));
    case "refs":
      return await callRefsTool(handlers, input);
    case "deps":
      return await handlers.deps(fileGraphSchema.parse(input));
    case "rdeps":
      return await handlers.rdeps(fileGraphSchema.parse(input));
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

const searchSchema = z.object({
  query: z.string(),
  mode: z.enum(["hybrid", "symbol", "path", "text", "graph", "sql"]).optional(),
  from: z.string().optional(),
  depth: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
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
  maxBytes: z.number().int().positive().optional(),
});

const handleSchema = z.object({
  handle: z.string(),
});

const navigationSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
});

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
