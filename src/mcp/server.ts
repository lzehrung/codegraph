import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { getCurrentNativeBindingOrigin } from "../native/runtime.js";
import { captureCodegraphRuntimeIdentity } from "../runtimeIdentity.js";
import { createWarmedCodegraphMcpResources, type CodegraphMcpServerOptions } from "./handlers.js";
import {
  assertMcpToolTimeout,
  createCodegraphMcpProtocolFactory,
  createCodegraphMcpStdioTransport,
  DEFAULT_MCP_TOOL_CONCURRENCY,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
} from "./protocol.js";
import { startCodegraphMcpHttpServer } from "./httpTransport.js";
import { waitForHttpServerClose } from "./http.js";
import { awaitStdioMcpLifecycle, DEFAULT_MCP_STDIO_IDLE_TIMEOUT_MS } from "./stdioLifecycle.js";

export { listCodegraphMcpTools } from "./tools.js";
export { createCodegraphMcpHandlers } from "./handlers.js";
export type {
  CodegraphMcpFreshResult,
  CodegraphMcpHandlerOptions,
  CodegraphMcpHandlers,
  CodegraphMcpHttpServerInfo,
  CodegraphMcpServerOptions,
  CodegraphMcpWarmupMode,
  McpTruncationMeta,
} from "./handlers.js";
export {
  awaitMcpToolOperation,
  callMcpTool,
  createCodegraphMcpProtocolServer,
  createCodegraphMcpProtocolServerWithTracker,
  createParseErrorReportingStdin,
  DEFAULT_MCP_TOOL_CONCURRENCY,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
} from "./protocol.js";
export type { McpToolConcurrencyTracker, McpToolOperationTracker } from "./protocol.js";
export { startCodegraphMcpHttpServer } from "./httpTransport.js";
export type { CodegraphMcpHttpServer } from "./httpTransport.js";
export {
  DEFAULT_MCP_HTTP_BODY_TIMEOUT_MS,
  DEFAULT_MCP_HTTP_SESSION_EVICTION_INTERVAL_MS,
  DEFAULT_MCP_HTTP_SESSION_IDLE_MS,
  DEFAULT_MCP_HTTP_SESSION_MAX_COUNT,
} from "./httpTransport.js";
export { runWithLegacyRequestAbortSignal } from "./legacySessions.js";

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
  const transport = createCodegraphMcpStdioTransport(process.stdin, process.stdout);
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
