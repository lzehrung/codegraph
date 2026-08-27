import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Transform, type Readable, type Writable } from "node:stream";
import { ProtocolError, ProtocolErrorCode, Server, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentExplanationReference } from "../agent/explain.js";
import { MAX_FILE_VIEW_BYTES, MAX_FILE_VIEW_LINES } from "../agent/fileView.js";
import { MAX_GRAPH_DEPTH } from "../agent/search.js";
import { errorMessage } from "../util/errors.js";
import { SymbolKind } from "../indexer/types.js";
import { MAX_WORKSPACE_SYMBOL_LIMIT } from "../indexer/workspace-symbols.js";
import type { GoToResult } from "../indexer/types.js";
import {
  listCodegraphMcpTools,
  MAX_RENAME_PREVIEW_EDITS,
  MCP_TOOL_REGISTRY,
  MAX_REFACTOR_PLAN_LIMIT,
} from "./tools.js";
import { getCurrentNativeBindingOrigin } from "../native/runtime.js";
import {
  captureCodegraphRuntimeIdentity,
  createInstalledVersionChecker,
  type CodegraphRuntimeIdentity,
  type InstalledVersionChecker,
} from "../runtimeIdentity.js";
import type { CodegraphMcpHandlers, McpTruncationMeta } from "./handlers.js";
import { getLegacyRequestAbortSignal } from "./legacySessions.js";

export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_MCP_TOOL_TIMEOUT_MS = 2_147_483_647;
const MAX_MCP_STDIO_FRAME_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MCP_TOOL_CONCURRENCY = 4;
function normalizeMcpToolConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MCP_TOOL_CONCURRENCY;
  return Math.max(1, Math.floor(value));
}

export function assertMcpToolTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MCP_TOOL_TIMEOUT_MS) {
    throw new RangeError(
      `mcpToolTimeoutMs must be a whole number from 0 through ${MAX_MCP_TOOL_TIMEOUT_MS}; 0 disables the deadline.`,
    );
  }
  return value;
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
        [ctx.mcpReq.signal, getLegacyRequestAbortSignal()],
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

export type McpProtocolFactory = {
  create: () => Server;
  stop: () => void;
  drain: () => Promise<void>;
};

export function createCodegraphMcpProtocolFactory(
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
        text: JSON.stringify(value),
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

export function createCodegraphMcpStdioTransport(input: Readable, output: Writable): StdioServerTransport {
  return new StdioServerTransport(createParseErrorReportingStdin(input, output), output, {
    maxBufferSize: MAX_MCP_STDIO_FRAME_BYTES,
  });
}
