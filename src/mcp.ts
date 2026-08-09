/**
 * MCP server and typed handler helpers for agent graph navigation.
 *
 * Import from `@lzehrung/codegraph/mcp`. The root package entrypoint does not
 * re-export these symbols.
 */
export { createCodegraphMcpHandlers, listCodegraphMcpTools, serveCodegraphMcp } from "./mcp/server.js";
export type { CodegraphMcpHandlers, CodegraphMcpServerOptions } from "./mcp/server.js";
