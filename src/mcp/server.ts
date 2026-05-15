import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildCodegraphArtifactWithSession } from "../agent/artifact.js";
import type { CodegraphArtifactBuildResult } from "../agent/artifact.js";
import { explainCodegraphTargetWithSession } from "../agent/explain.js";
import type { AgentExplanation, AgentExplanationReference } from "../agent/explain.js";
import { searchCodegraphWithSession } from "../agent/search.js";
import type { AgentSearchMode, AgentSearchResponse } from "../agent/search.js";
import { getDependencies, getReverseDependencies, getShortestPath } from "../graphs.js";
import { findReferences, goToDefinition } from "../indexer.js";
import { buildReviewReport, type ReviewDepth, type ReviewReport } from "../review.js";
import { queryGraphSqliteRaw, type RawSqlResult } from "../sqlite.js";
import { assertFilePathWithinRoot, isFilePathWithinRoot, normalizePath, toProjectRelativePath } from "../util.js";
import { createAgentSession } from "../agent/session.js";
import type { AgentSession } from "../agent/session.js";

export type CodegraphMcpServerOptions = {
  root: string;
  artifactPath?: string;
  readOnly?: boolean;
  session?: AgentSession;
};

export type CodegraphMcpHandlers = {
  search: (request: {
    query: string;
    mode?: AgentSearchMode | undefined;
    from?: string | undefined;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<AgentSearchResponse>;
  get_file: (request: {
    file: string;
    maxBytes?: number | undefined;
  }) => Promise<{ file: string; text: string; truncated: boolean }>;
  get_symbol: (request: { handle: string }) => Promise<AgentExplanation["target"]>;
  goto: (request: {
    file: string;
    line: number;
    column: number;
  }) => Promise<Awaited<ReturnType<typeof goToDefinition>>>;
  refs: (
    request:
      | { handle: string; limit?: number | undefined }
      | { file: string; line: number; column: number; limit?: number | undefined },
  ) => Promise<{ references: AgentExplanationReference[] }>;
  deps: (request: {
    file: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<{ dependencies: Array<{ file: string; depth: number }> }>;
  rdeps: (request: {
    file: string;
    depth?: number | undefined;
    limit?: number | undefined;
  }) => Promise<{ reverseDependencies: Array<{ file: string; depth: number }> }>;
  path: (request: { from: string; to: string }) => Promise<{ path: string[] | null }>;
  impact: (request: { base: string; head: string }) => Promise<ReviewReport>;
  review: (request: { base: string; head: string; reviewDepth?: ReviewDepth | undefined }) => Promise<ReviewReport>;
  query_sqlite: (request: {
    query: string;
    params?: Array<string | number | null> | undefined;
    limit?: number | undefined;
  }) => Promise<RawSqlResult>;
  artifact_build: (request: {
    outDir?: string | undefined;
    sqlite?: boolean | undefined;
    graphJson?: boolean | undefined;
    report?: boolean | undefined;
    questions?: boolean | undefined;
    force?: boolean | undefined;
  }) => Promise<CodegraphArtifactBuildResult>;
};

const DEFAULT_FILE_BYTES = 80_000;
const MAX_FILE_BYTES = 500_000;
const DEFAULT_SQLITE_ROW_LIMIT = 100;
const MAX_SQLITE_ROW_LIMIT = 500;
const DEFAULT_SQLITE_BYTE_LIMIT = 200_000;
const MAX_SQLITE_CELL_BYTES = 8_000;
const DEFAULT_MCP_COLLECTION_LIMIT = 100;
const MAX_MCP_COLLECTION_LIMIT = 500;

export function createCodegraphMcpHandlers(options: CodegraphMcpServerOptions): CodegraphMcpHandlers {
  const root = path.resolve(options.root);
  const readOnly = options.readOnly ?? true;
  const session = options.session ?? createAgentSession({ root });
  const realRoot = fs.realpath(root);
  let sqlitePath = options.artifactPath ? resolveArtifactSqlitePathCandidate(root, options.artifactPath) : undefined;

  const relative = (file: string): string => toProjectRelativePath(root, file) ?? normalizePath(path.resolve(file));
  const boundedLimit = (limit: number | undefined, fallback: number, max: number): number => {
    if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
    return Math.min(max, Math.max(0, Math.floor(limit)));
  };

  return {
    search: async (request) =>
      await searchCodegraphWithSession(session, {
        root,
        query: request.query,
        ...(request.mode !== undefined ? { mode: request.mode } : {}),
        ...(request.from !== undefined ? { from: request.from } : {}),
        ...(request.depth !== undefined ? { depth: request.depth } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
      }),

    get_file: async (request) => {
      const resolvedFile = await resolveReadableFile(await realRoot, root, request.file);
      const maxBytes = boundedLimit(request.maxBytes, DEFAULT_FILE_BYTES, MAX_FILE_BYTES);
      const read = await readFilePrefix(resolvedFile.realPath, maxBytes);
      return {
        file: resolvedFile.displayPath,
        text: read.text,
        truncated: read.truncated,
      };
    },

    get_symbol: async (request) => {
      const explanation = await explainCodegraphTargetWithSession(session, { root, target: request.handle });
      return explanation.target;
    },

    goto: async (request) => {
      const snapshot = await session.loadProject();
      return await goToDefinition(snapshot.index, {
        file: await resolveProjectFile(await realRoot, root, request.file),
        line: request.line,
        column: request.column,
      });
    },

    refs: async (request) => {
      if ("handle" in request) {
        const explanation = await explainCodegraphTargetWithSession(session, {
          root,
          target: request.handle,
          maxReferences: boundedLimit(request.limit, DEFAULT_MCP_COLLECTION_LIMIT, MAX_MCP_COLLECTION_LIMIT),
        });
        return { references: explanation.references };
      }

      const snapshot = await session.loadProject();
      const referenceOptions = {
        maxReferences: boundedLimit(request.limit, DEFAULT_MCP_COLLECTION_LIMIT, MAX_MCP_COLLECTION_LIMIT),
      };
      const result = await findReferences(
        snapshot.index,
        {
          file: await resolveProjectFile(await realRoot, root, request.file),
          line: request.line,
          column: request.column,
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
    },

    deps: async (request) => {
      const snapshot = await session.loadProject();
      const queryOptions = {
        ...(request.depth !== undefined ? { depth: request.depth } : {}),
        limit: boundedLimit(request.limit, DEFAULT_MCP_COLLECTION_LIMIT, MAX_MCP_COLLECTION_LIMIT),
      };
      const dependencies = getDependencies(
        snapshot.fileGraph,
        await resolveProjectFile(await realRoot, root, request.file),
        queryOptions,
      ).map(
        (dependency) => ({
          file: relative(dependency.file),
          depth: dependency.depth,
        }),
      );
      return { dependencies };
    },

    rdeps: async (request) => {
      const snapshot = await session.loadProject();
      const queryOptions = {
        ...(request.depth !== undefined ? { depth: request.depth } : {}),
        limit: boundedLimit(request.limit, DEFAULT_MCP_COLLECTION_LIMIT, MAX_MCP_COLLECTION_LIMIT),
      };
      const reverseDependencies = getReverseDependencies(
        snapshot.fileGraph,
        await resolveProjectFile(await realRoot, root, request.file),
        queryOptions,
      ).map((dependency) => ({
        file: relative(dependency.file),
        depth: dependency.depth,
      }));
      return { reverseDependencies };
    },

    path: async (request) => {
      const snapshot = await session.loadProject();
      const result = getShortestPath(
        snapshot.fileGraph,
        await resolveProjectFile(await realRoot, root, request.from),
        await resolveProjectFile(await realRoot, root, request.to),
      );
      return {
        path: result ? result.map(relative) : null,
      };
    },

    impact: async (request) =>
      await buildReviewReport(root, {
        gitBase: request.base,
        gitHead: request.head,
        reviewDepth: "minimal",
      }),

    review: async (request) =>
      await buildReviewReport(root, {
        gitBase: request.base,
        gitHead: request.head,
        ...(request.reviewDepth !== undefined ? { reviewDepth: request.reviewDepth } : {}),
      }),

    query_sqlite: async (request) => {
      if (!sqlitePath) {
        throw new Error("No SQLite artifact is available. Run artifact_build first or pass artifactPath.");
      }
      const realSqlitePath = await assertRealPathCandidateWithinRoot(
        await realRoot,
        sqlitePath,
        "SQLite artifact",
      );
      const result = await queryGraphSqliteRaw(realSqlitePath, request.query, request.params ?? [], {
        maxRows: normalizeSqliteRowLimit(request.limit),
      });
      return boundRawSqlResult(result, DEFAULT_SQLITE_BYTE_LIMIT);
    },

    artifact_build: async (request) => {
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
      }
      return result;
    },
  };
}

export async function serveCodegraphMcp(options: CodegraphMcpServerOptions): Promise<void> {
  const server = new McpServer({
    name: "codegraph",
    version: "1.0.0",
  });
  const handlers = createCodegraphMcpHandlers(options);

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: MCP_TOOLS }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const result = await callMcpTool(handlers, request.params.name, request.params.arguments ?? {});
    return toToolResult(result);
  });

  await server.connect(new StdioServerTransport());
}

async function callMcpTool(handlers: CodegraphMcpHandlers, name: string, input: unknown): Promise<unknown> {
  switch (name) {
    case "search":
      return await handlers.search(searchSchema.parse(input));
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

function resolveArtifactSqlitePathCandidate(root: string, artifactPath: string): string {
  const resolved = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(root, artifactPath);
  const sqlitePath =
    resolved.toLowerCase().endsWith(".sqlite") || resolved.toLowerCase().endsWith(".db")
      ? resolved
      : path.join(resolved, "codegraph.sqlite");
  return normalizePath(sqlitePath);
}

const searchSchema = z.object({
  query: z.string(),
  mode: z.enum(["hybrid", "symbol", "path", "text", "graph", "sql"]).optional(),
  from: z.string().optional(),
  depth: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
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

const artifactBuildSchema = z.object({
  outDir: z.string().optional(),
  sqlite: z.boolean().optional(),
  graphJson: z.boolean().optional(),
  report: z.boolean().optional(),
  questions: z.boolean().optional(),
  force: z.boolean().optional(),
});

function objectSchema(properties: Record<string, object>, required: string[] = []): Tool["inputSchema"] {
  return required.length > 0 ? { type: "object", properties, required } : { type: "object", properties };
}

const stringProperty = { type: "string" };
const booleanProperty = { type: "boolean" };

const MCP_TOOLS: Tool[] = [
  {
    name: "search",
    description: "Deterministic ranked search across files, symbols, chunks, SQL objects, and graph context.",
    inputSchema: objectSchema(
      {
        query: stringProperty,
        mode: { type: "string", enum: ["hybrid", "symbol", "path", "text", "graph", "sql"] },
        from: stringProperty,
        depth: { type: "integer", minimum: 0, default: 1, description: "Graph neighborhood depth." },
        limit: { type: "integer", minimum: 0, maximum: 100, default: 20 },
      },
      ["query"],
    ),
  },
  {
    name: "get_file",
    description: "Read a bounded project file by relative path.",
    inputSchema: objectSchema(
      { file: stringProperty, maxBytes: { type: "integer", minimum: 1, maximum: MAX_FILE_BYTES } },
      ["file"],
    ),
  },
  {
    name: "get_symbol",
    description: "Resolve a stable search or explain handle.",
    inputSchema: objectSchema({ handle: stringProperty }, ["handle"]),
  },
  {
    name: "goto",
    description: "Resolve the definition at a file position.",
    inputSchema: objectSchema(
      { file: stringProperty, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 0 } },
      ["file", "line", "column"],
    ),
  },
  {
    name: "refs",
    description: "Find references by stable handle or file position.",
    inputSchema: {
      type: "object",
      properties: {
        handle: stringProperty,
        file: stringProperty,
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 0 },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_MCP_COLLECTION_LIMIT,
          default: DEFAULT_MCP_COLLECTION_LIMIT,
        },
      },
      oneOf: [
        {
          required: ["handle"],
          not: {
            anyOf: [{ required: ["file"] }, { required: ["line"] }, { required: ["column"] }],
          },
        },
        {
          required: ["file", "line", "column"],
          not: { required: ["handle"] },
        },
      ],
    },
  },
  {
    name: "deps",
    description: "List file dependencies.",
    inputSchema: objectSchema(
      {
        file: stringProperty,
        depth: { type: "integer", minimum: 0, default: 1 },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_MCP_COLLECTION_LIMIT,
          default: DEFAULT_MCP_COLLECTION_LIMIT,
        },
      },
      ["file"],
    ),
  },
  {
    name: "rdeps",
    description: "List reverse file dependencies.",
    inputSchema: objectSchema(
      {
        file: stringProperty,
        depth: { type: "integer", minimum: 0, default: 1 },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_MCP_COLLECTION_LIMIT,
          default: DEFAULT_MCP_COLLECTION_LIMIT,
        },
      },
      ["file"],
    ),
  },
  {
    name: "path",
    description: "Find the shortest dependency path between two files.",
    inputSchema: objectSchema({ from: stringProperty, to: stringProperty }, ["from", "to"]),
  },
  {
    name: "impact",
    description: "Build compact impact context for a git range.",
    inputSchema: objectSchema({ base: stringProperty, head: stringProperty }, ["base", "head"]),
  },
  {
    name: "review",
    description: "Build review context for a git range.",
    inputSchema: objectSchema(
      {
        base: stringProperty,
        head: stringProperty,
        reviewDepth: { type: "string", enum: ["minimal", "standard", "deep"] },
      },
      ["base", "head"],
    ),
  },
  {
    name: "query_sqlite",
    description: "Run a read-only SQL query against the graph SQLite artifact.",
    inputSchema: objectSchema(
      {
        query: stringProperty,
        params: {
          type: "array",
          items: { oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
        },
        limit: { type: "integer", minimum: 0, maximum: MAX_SQLITE_ROW_LIMIT, default: DEFAULT_SQLITE_ROW_LIMIT },
      },
      ["query"],
    ),
  },
  {
    name: "artifact_build",
    description: "Build Codegraph artifacts when write tools are explicitly enabled.",
    inputSchema: objectSchema({
      outDir: stringProperty,
      sqlite: booleanProperty,
      graphJson: booleanProperty,
      report: booleanProperty,
      questions: booleanProperty,
      force: booleanProperty,
    }),
  },
];

export function listCodegraphMcpTools(): Tool[] {
  return MCP_TOOLS.map((tool) => ({ ...tool }));
}

function normalizeSqliteRowLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_SQLITE_ROW_LIMIT;
  return Math.min(MAX_SQLITE_ROW_LIMIT, Math.max(0, Math.floor(limit)));
}

function boundRawSqlResult(result: RawSqlResult, byteLimit: number): RawSqlResult {
  const rows: Array<Array<unknown>> = [];
  let bytes = Buffer.byteLength(JSON.stringify({ columns: result.columns, rows: [] }), "utf8");
  let truncated = result.truncated ?? false;

  for (const rawRow of result.rows) {
    if (rowContainsTruncatedValue(rawRow)) {
      truncated = true;
    }
    const row = rawRow.map(normalizeSqliteValue);
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (bytes + rowBytes > byteLimit) {
      truncated = true;
      break;
    }
    rows.push(row);
    bytes += rowBytes;
  }

  return {
    ...result,
    rows,
    byteLimit,
    bytes,
    truncated,
  };
}

function rowContainsTruncatedValue(row: Array<unknown>): boolean {
  return row.some(
    (value) =>
      (typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_SQLITE_CELL_BYTES) ||
      value instanceof Uint8Array,
  );
}

function normalizeSqliteValue(value: unknown): unknown {
  if (typeof value === "string") return truncateUtf8(value, MAX_SQLITE_CELL_BYTES);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  return value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    output += char;
    bytes += charBytes;
  }
  return `${output}...[truncated]`;
}

async function resolveReadableFile(
  realRoot: string,
  root: string,
  filePath: string,
): Promise<{ realPath: string; displayPath: string }> {
  const candidatePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  const realPath = await assertRealPathCandidateWithinRoot(realRoot, candidatePath, "File");
  const displayPath =
    toProjectRelativePath(root, candidatePath) ?? toProjectRelativePath(realRoot, realPath) ?? normalizePath(realPath);
  return { realPath, displayPath };
}

async function resolveProjectFile(realRoot: string, root: string, filePath: string): Promise<string> {
  const candidatePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  const realPath = await assertRealPathCandidateWithinRoot(realRoot, candidatePath, "File");
  const lexicalRelativePath = toProjectRelativePath(root, candidatePath);
  if (lexicalRelativePath) return normalizePath(candidatePath);
  const realRelativePath = toProjectRelativePath(realRoot, realPath);
  if (realRelativePath) return normalizePath(path.resolve(root, realRelativePath));
  throw new Error(`File is outside project root: ${normalizePath(realPath)} (root: ${normalizePath(realRoot)})`);
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await fs.open(filePath, "r");
  try {
    const readLimit = maxBytes + 1;
    const buffer = Buffer.alloc(readLimit);
    const { bytesRead } = await handle.read(buffer, 0, readLimit, 0);
    const outputBytes = Math.min(bytesRead, maxBytes);
    return {
      text: buffer.subarray(0, outputBytes).toString("utf8"),
      truncated: bytesRead > maxBytes,
    };
  } finally {
    await handle.close();
  }
}

async function assertRealPathCandidateWithinRoot(
  realRoot: string,
  filePath: string,
  label: string,
): Promise<string> {
  const existingPath = await nearestExistingPath(filePath);
  const realExistingPath = await fs.realpath(existingPath);
  const relativeSuffix = path.relative(existingPath, filePath);
  const realTargetPath = path.resolve(realExistingPath, relativeSuffix);
  if (!isFilePathWithinRoot(realRoot, realTargetPath)) {
    throw new Error(
      `${label} is outside project root: ${normalizePath(realTargetPath)} (root: ${normalizePath(realRoot)})`,
    );
  }
  return normalizePath(await fs.realpath(filePath));
}

async function assertWritableDirectoryRealPathWithinRoot(
  realRoot: string,
  root: string,
  requestedPath: string,
  label: string,
): Promise<string> {
  const lexicalPath = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(root, requestedPath);
  const existingPath = await nearestExistingPath(lexicalPath);
  const realExistingPath = await fs.realpath(existingPath);
  const relativeSuffix = path.relative(existingPath, lexicalPath);
  const realTargetPath = path.resolve(realExistingPath, relativeSuffix);
  if (!isFilePathWithinRoot(realRoot, realTargetPath)) {
    throw new Error(
      `${label} is outside project root: ${normalizePath(realTargetPath)} (root: ${normalizePath(realRoot)})`,
    );
  }
  return normalizePath(realTargetPath);
}

async function nearestExistingPath(filePath: string): Promise<string> {
  let current = filePath;
  while (current !== path.dirname(current)) {
    try {
      await fs.stat(current);
      return current;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      current = path.dirname(current);
    }
  }
  return current;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
