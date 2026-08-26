import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createMcpHandler, isLegacyRequest, Server } from "@modelcontextprotocol/server";
import {
  originValidation,
  toNodeHandler,
  toWebRequest,
  type NodeIncomingMessageLike,
  type NodeMcpRequestHandler,
} from "@modelcontextprotocol/node";
import {
  buildAllowedHostHeaders,
  buildAllowedOriginHostnames,
  closeHttpServer,
  emptyAllowedHostHeaderRules,
  formatHostForUrl,
  getHttpServerPort,
  getRequestPath,
  isAllowedHostHeader,
  listenOnHttpServer,
  readJsonRequestBody,
  writeJsonResponse,
  writeJsonRpcError,
  type AllowedHostHeaderRules,
} from "./http.js";
import { getCurrentNativeBindingOrigin } from "../native/runtime.js";
import { captureCodegraphRuntimeIdentity, createInstalledVersionChecker } from "../runtimeIdentity.js";
import {
  createWarmedCodegraphMcpResources,
  type CodegraphMcpHttpServerInfo,
  type CodegraphMcpServerOptions,
} from "./handlers.js";
import {
  assertMcpToolTimeout,
  createCodegraphMcpProtocolFactory,
  DEFAULT_MCP_TOOL_CONCURRENCY,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
} from "./protocol.js";
import {
  closeLegacyMcpSessions,
  closeMcpResources,
  createLegacyMcpSessionStore,
  handleExistingMcpSessionRequest,
  handleLegacyMcpHttpPost,
  type LegacyMcpSessionStore,
} from "./legacySessions.js";

export type CodegraphMcpHttpServer = CodegraphMcpHttpServerInfo & {
  server: HttpServer;
  close: () => Promise<void>;
};
export const DEFAULT_MCP_HTTP_SESSION_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_MCP_HTTP_SESSION_MAX_COUNT = 32;
export const DEFAULT_MCP_HTTP_SESSION_EVICTION_INTERVAL_MS = 60_000;
export const DEFAULT_MCP_HTTP_BODY_TIMEOUT_MS = 30_000;
const MAX_MCP_HTTP_BODY_TIMEOUT_MS = 2_147_483_647;
function assertMcpHttpBodyTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MCP_HTTP_BODY_TIMEOUT_MS) {
    throw new RangeError(
      `httpBodyTimeoutMs must be a positive integer no greater than ${MAX_MCP_HTTP_BODY_TIMEOUT_MS}.`,
    );
  }
  return value;
}
const MCP_HTTP_PATH = "/mcp";
const MAX_MCP_HTTP_BODY_BYTES = 1_000_000;
type OriginValidator = (request: IncomingMessage, response: ServerResponse) => boolean;
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
  const installedVersionChecker = createInstalledVersionChecker(runtimeIdentity, { warn: () => {} });
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
      () => ({
        service: "codegraph" as const,
        schemaVersion: 1,
        pid: process.pid,
        root: options.root,
        version: runtimeIdentity.runningVersion,
        startedAt: runtimeIdentity.startedAt,
        update: installedVersionChecker.check(),
      }),
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
  getHealth: () => object,
): Promise<void> {
  const writeClosingJsonRpcError = (statusCode: number, message: string): void => {
    response.setHeader("connection", "close");

    writeJsonRpcError(response, statusCode, message);
  };

  const requestPath = getRequestPath(request);
  if (!isAllowedHostHeader(request, getAllowedHostHeaders())) {
    writeJsonRpcError(response, 403, "Forbidden host header");
    return;
  }
  if (!validateOrigin(request, response)) return;
  if (requestPath === "/health") {
    if (request.method === "GET") {
      writeJsonResponse(response, 200, getHealth());
    } else {
      writeJsonResponse(response, 405, { error: "Method not allowed" });
    }
    return;
  }
  if (requestPath !== MCP_HTTP_PATH) {
    writeJsonResponse(response, 404, { error: "Not found" });
    return;
  }

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

function isMcpNodeRequest(request: IncomingMessage): request is IncomingMessage & NodeIncomingMessageLike {
  return request.method !== undefined && request.url !== undefined;
}
