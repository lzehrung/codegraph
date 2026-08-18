import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  createCodegraphMcpHandlers,
  createCodegraphMcpProtocolServer,
  DEFAULT_MCP_TOOL_CONCURRENCY,
} from "../src/mcp/server.js";

describe("MCP query_sqlite cancellation", () => {
  it("forwards a cancelled tool stream to the raw query handler", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-mcp-query-cancel-"));
    const handlers = createCodegraphMcpHandlers({ root });
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    handlers.query_sqlite = async (_request, executionOptions) => {
      const signal = executionOptions?.signal;
      if (!signal) throw new Error("MCP query_sqlite did not receive a cancellation signal.");
      started.resolve();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
            reject(new Error("raw query cancelled"));
          },
          { once: true },
        );
      });
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCodegraphMcpProtocolServer(handlers);
    const client = new Client({ name: "mcp-stream-cancellation-test", version: "1.0.0" });
    const controller = new AbortController();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const call = client.callTool(
        { name: "query_sqlite", arguments: { query: "SELECT 1;" } },
        { signal: controller.signal },
      );
      await started.promise;
      controller.abort();

      await expect(call).rejects.toThrow();
      await cancelled.promise;
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the default tool concurrency for NaN", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-mcp-tool-concurrency-"));
    const handlers = createCodegraphMcpHandlers({ root });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let activeCalls = 0;
    handlers.query_sqlite = async () => {
      activeCalls += 1;
      if (activeCalls === DEFAULT_MCP_TOOL_CONCURRENCY) started.resolve();
      await release.promise;
      return { columns: [], rows: [] };
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCodegraphMcpProtocolServer(handlers, undefined, undefined, undefined, Number.NaN);
    const client = new Client({ name: "mcp-tool-concurrency-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const active = Array.from({ length: DEFAULT_MCP_TOOL_CONCURRENCY }, () =>
        client.callTool({ name: "query_sqlite", arguments: { query: "SELECT 1;" } }),
      );
      await started.promise;

      await expect(client.callTool({ name: "query_sqlite", arguments: { query: "SELECT 1;" } })).rejects.toThrow(
        /tool execution is busy/i,
      );
      release.resolve();
      await expect(Promise.all(active)).resolves.toHaveLength(DEFAULT_MCP_TOOL_CONCURRENCY);
    } finally {
      release.resolve();
      await Promise.allSettled([client.close(), server.close()]);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
