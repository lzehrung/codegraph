import fs from "node:fs/promises";
import path from "node:path";
import { Client, LOG_LEVEL_META_KEY, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ProtocolError, Server, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { getCodegraphVersion } from "../util/package-info.js";
import { errorMessage } from "../util/errors.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { isPlainRecord } from "../util/guards.js";
import { createCodegraphMcpStdioTransport } from "./stdio-transport.js";
import {
  assertSharedOwnerConnection,
  ensureSharedOwner,
  type SharedOwnerConnection,
  type SharedOwnerOptions,
} from "./shared-owner.js";
import { awaitStdioMcpLifecycle } from "./stdio-lifecycle.js";
import { DEFAULT_MCP_TOOL_CONCURRENCY } from "./runtime-limits.js";
import { listCodegraphMcpTools } from "./tools.js";

/** A stdio connection owns protocol state, never the project's index or watcher. */
export async function serveSharedStdioMcp(
  options: SharedOwnerOptions & { idleTimeoutMs?: number | undefined },
): Promise<void> {
  const version = getCodegraphVersion();
  const logicalRoot = normalizePath(path.resolve(options.root));
  const physicalRoot = normalizePath(await fs.realpath(logicalRoot));
  const assertLogicalRoot = async (): Promise<void> => {
    if (fileIdentityKey(await fs.realpath(logicalRoot)) !== fileIdentityKey(physicalRoot)) {
      throw new Error("Shared MCP stdio project root changed after startup.");
    }
  };
  const clients = new Set<Client>();
  const active = new Map<string | number, AbortController>();
  let closed = false;
  let ownerPromise: Promise<SharedOwnerConnection> | undefined;
  const connectOwner = (): Promise<SharedOwnerConnection> => {
    if (ownerPromise) return ownerPromise;
    const pending = (async () => {
      await assertLogicalRoot();
      const owner = await ensureSharedOwner(options);
      if (fileIdentityKey(owner.root) !== fileIdentityKey(physicalRoot)) {
        throw new Error("Shared MCP stdio project root changed during owner startup.");
      }
      return owner;
    })();
    ownerPromise = pending;
    void pending.catch(() => {
      if (ownerPromise === pending) ownerPromise = undefined;
    });
    return pending;
  };
  const handle = serveStdio(
    () => {
      const server = new Server({ name: "codegraph", version }, { capabilities: { tools: {}, logging: {} } });
      server.setRequestHandler("tools/list", () => ({ tools: listCodegraphMcpTools() }));
      server.setNotificationHandler("notifications/cancelled", (notification) => {
        const requestId = notification.params.requestId;
        if (requestId !== undefined) active.get(requestId)?.abort(new Error("MCP tool call was cancelled."));
      });
      server.setRequestHandler("tools/call", async (request, ctx) => {
        if (closed) throw new Error("MCP stdio connection is closed.");
        if (active.size >= DEFAULT_MCP_TOOL_CONCURRENCY) {
          throw new Error("MCP tool execution is busy; retry shortly.");
        }
        const controller = new AbortController();
        active.set(ctx.mcpReq.id, controller);
        const signal = AbortSignal.any([controller.signal, ctx.mcpReq.signal]);
        const pending = connectOwner();
        // One protocol client per in-flight call prevents logs, cancellation, or closing one request from crossing
        // into another. These connections all reach the same owner/session/index; none owns analysis state.
        const client = new Client({ name: "codegraph-stdio", version }, { versionNegotiation: { mode: "auto" } });
        clients.add(client);
        client.setNotificationHandler("notifications/message", async (notification) => {
          const params = notification.params;
          await ctx.mcpReq.log(params.level, params.data, params.logger);
        });
        try {
          const owner = await pending;
          signal.throwIfAborted();
          await assertLogicalRoot();
          await assertSharedOwnerConnection(owner);
          signal.throwIfAborted();
          await client.connect(new StreamableHTTPClientTransport(new URL(owner.url)), { signal });
          await assertSharedOwnerConnection(owner);
          await assertLogicalRoot();
          signal.throwIfAborted();
          const envelope: Record<string, unknown> = ctx.mcpReq.envelope ?? {};
          // Legacy clients use the connection's logging threshold. Modern clients opt in per request.
          const logLevel = ctx.mcpReq.envelope ? envelope[LOG_LEVEL_META_KEY] : "info";
          const progressToken = request.params._meta?.progressToken;
          const result = await client.callTool(
            {
              ...request.params,
              arguments: rebaseRequestPaths(request.params.arguments, logicalRoot, owner.root),
              _meta: {
                ...request.params._meta,
                ...(logLevel !== undefined ? { [LOG_LEVEL_META_KEY]: logLevel } : {}),
              },
            },
            {
              signal,
              // The owner enforces its tool deadline; do not impose the SDK's shorter default.
              timeout: 2_147_483_647,
              ...(progressToken !== undefined
                ? {
                    onprogress: (progress) => {
                      void ctx.mcpReq
                        .notify({ method: "notifications/progress", params: { ...progress, progressToken } })
                        .catch(() => undefined);
                    },
                  }
                : {}),
            },
          );
          return rebaseResponseRoot(result, owner.root, path.resolve(options.root));
        } catch (error) {
          // Do not replay a request: artifact_build may already have written output. A later call can recover a dead
          // or idle-expired owner. Protocol argument errors and cancellation do not retire a healthy owner.
          if (!signal.aborted && !(error instanceof ProtocolError) && ownerPromise === pending)
            ownerPromise = undefined;
          throw error;
        } finally {
          active.delete(ctx.mcpReq.id);
          clients.delete(client);
          await client.close().catch(() => undefined);
        }
      });
      return server;
    },
    {
      transport: createCodegraphMcpStdioTransport(process.stdin, process.stdout),
      legacy: "serve",
      onerror: (error) => console.error(`[codegraph] MCP stdio bridge: ${error.message}`),
    },
  );
  // Attach stdin first: initialization and the local tool catalog never wait for owner startup.
  void connectOwner().catch((error: unknown) => {
    if (!closed) console.error(`[codegraph] Shared index owner unavailable: ${errorMessage(error)}`);
  });
  try {
    await awaitStdioMcpLifecycle(handle, {
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    });
  } finally {
    closed = true;
    for (const controller of active.values()) controller.abort(new Error("MCP stdio connection closed."));
    await Promise.allSettled([...clients].map((client) => client.close()));
  }
}

function rebaseRequestPaths(
  args: Record<string, unknown> | undefined,
  logicalRoot: string,
  physicalRoot: string,
): Record<string, unknown> | undefined {
  if (!args || logicalRoot === physicalRoot) return args;
  const compare = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
  const prefix = `${logicalRoot}/`;
  const rebase = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const normalized = normalizePath(value);
    if (compare(normalized) === compare(logicalRoot)) return physicalRoot;
    if (compare(normalized).startsWith(compare(prefix))) return `${physicalRoot}/${normalized.slice(prefix.length)}`;
    return value;
  };
  const translated = { ...args };
  for (const field of ["file", "from", "to", "target", "handle", "outDir"]) {
    if (field in translated) translated[field] = rebase(translated[field]);
  }
  if (Array.isArray(translated.includeRoots)) translated.includeRoots = translated.includeRoots.map(rebase);
  return translated;
}

function rebaseResponseRoot(result: CallToolResult, physicalRoot: string, logicalRoot: string): CallToolResult {
  if (physicalRoot === logicalRoot) return result;
  const physicalRootKey = fileIdentityKey(physicalRoot);
  const rebasePayload = (value: Record<string, unknown>): Record<string, unknown> => {
    if (typeof value.root !== "string" || fileIdentityKey(value.root) !== physicalRootKey) return value;
    return { ...value, root: logicalRoot };
  };
  const content = result.content.map((block) => {
    if (block.type !== "text") return block;
    let payload: unknown;
    try {
      payload = JSON.parse(block.text);
    } catch {
      return block;
    }
    if (!isPlainRecord(payload)) return block;
    const rebased = rebasePayload(payload);
    return rebased === payload ? block : { ...block, text: JSON.stringify(rebased) };
  });
  return {
    ...result,
    content,
    ...(isPlainRecord(result.structuredContent) ? { structuredContent: rebasePayload(result.structuredContent) } : {}),
  };
}
