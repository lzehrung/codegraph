import fsp from "node:fs/promises";
import { connect as connectSocket } from "node:net";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler } from "@modelcontextprotocol/node";
import {
  createCodegraphMcpHandlers,
  createCodegraphMcpProtocolServer,
  DEFAULT_MCP_TOOL_CONCURRENCY,
  runWithLegacyRequestAbortSignal,
  type CodegraphMcpFreshResult,
} from "../src/mcp/server.js";
import type { RawSqlResult } from "../src/sqlite.js";

describe("MCP query_sqlite cancellation", () => {
  it("forwards a cancelled tool stream to the raw query handler", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-mcp-query-cancel-"));
    const handlers = createCodegraphMcpHandlers({ root });
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    handlers.query_sqlite = async (_request, executionOptions?): Promise<CodegraphMcpFreshResult<RawSqlResult>> => {
      const signal = executionOptions?.signal;
      if (!signal) throw new Error("MCP query_sqlite did not receive a cancellation signal.");
      started.resolve();
      return await new Promise<never>((_resolve, reject) => {
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
  it("aborts timed-out tool calls, releases their slot, and allows disabling the deadline", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-mcp-tool-deadline-"));
    const handlers = createCodegraphMcpHandlers({ root });
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    let calls = 0;
    handlers.query_sqlite = async (_request, executionOptions?): Promise<CodegraphMcpFreshResult<RawSqlResult>> => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await new Promise<never>((_resolve, reject) => {
          executionOptions?.signal?.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(new Error("deadline handler stopped"));
            },
            { once: true },
          );
        });
      }
      return { columns: [], rows: [], freshness: { state: "fresh" } };
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCodegraphMcpProtocolServer(handlers, undefined, undefined, undefined, 1, 20);
    const client = new Client({ name: "mcp-tool-deadline-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const timedOut = client.callTool({ name: "query_sqlite", arguments: { query: "SELECT 1;" } });
      await started.promise;
      await aborted.promise;
      await expect(timedOut).rejects.toThrow("MCP tool 'query_sqlite' exceeded the configured deadline of 20 ms.");
      await expect(client.callTool({ name: "query_sqlite", arguments: { query: "SELECT 1;" } })).resolves.toMatchObject(
        {
          content: expect.any(Array),
        },
      );

      const disabledStarted = Promise.withResolvers<void>();
      const disabledRelease = Promise.withResolvers<void>();
      let disabledSettled = false;
      let disabledAbortObserved = false;
      handlers.query_sqlite = async (_request, executionOptions?): Promise<CodegraphMcpFreshResult<RawSqlResult>> => {
        disabledStarted.resolve();
        executionOptions?.signal?.addEventListener(
          "abort",
          () => {
            disabledAbortObserved = true;
          },
          { once: true },
        );
        await disabledRelease.promise;
        return { columns: [], rows: [], freshness: { state: "fresh" } };
      };
      const disabledServer = createCodegraphMcpProtocolServer(handlers, undefined, undefined, undefined, 1, 0);
      const [disabledClientTransport, disabledServerTransport] = InMemoryTransport.createLinkedPair();
      const disabledClient = new Client({ name: "mcp-tool-deadline-disabled-test", version: "1.0.0" });
      try {
        await disabledServer.connect(disabledServerTransport);
        await disabledClient.connect(disabledClientTransport);
        const disabledCall = disabledClient.callTool({
          name: "query_sqlite",
          arguments: { query: "SELECT 1;" },
        });
        void disabledCall.then(() => {
          disabledSettled = true;
        });
        await disabledStarted.promise;
        await Promise.resolve();
        expect(disabledSettled).toBe(false);
        expect(disabledAbortObserved).toBe(false);
        disabledRelease.resolve();
        await expect(disabledCall).resolves.toMatchObject({ content: expect.any(Array) });
      } finally {
        disabledRelease.resolve();
        await Promise.allSettled([disabledClient.close(), disabledServer.close()]);
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it("aborts only the closed modern HTTP request", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-mcp-modern-socket-close-"));
    const handlers = createCodegraphMcpHandlers({ root });
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    let calls = 0;
    handlers.query_sqlite = async (_request, executionOptions?): Promise<CodegraphMcpFreshResult<RawSqlResult>> => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await new Promise<never>((_resolve, reject) => {
          executionOptions?.signal?.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(new Error("modern request closed"));
            },
            { once: true },
          );
        });
      }
      return { columns: [], rows: [], freshness: { state: "fresh" } };
    };
    const modernHandler = createMcpHandler(() => createCodegraphMcpProtocolServer(handlers), { legacy: "stateless" });
    const nodeHandler = toNodeHandler(modernHandler);
    const handlerFailures: unknown[] = [];
    const httpServer = createServer((request, response) => {
      const { method, url } = request;
      // Node types `method` and `url` as optional; the SDK handler requires both.
      // Reattach them as definite values on the same object so the stream keeps its
      // prototype.
      if (method === undefined || url === undefined) {
        throw new Error("HTTP request arrived without a method or url.");
      }
      void nodeHandler(Object.assign(request, { method, url }), response).catch((error: unknown) =>
        handlerFailures.push(error),
      );
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (address === null || typeof address === "string") throw new Error("Modern test server did not expose a port.");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "query_sqlite", arguments: { query: "SELECT 1;" } },
    });
    try {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/mcp",
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          "mcp-protocol-version": "2025-11-25",
        },
      });
      request.on("error", () => {});
      request.end(body);
      await started.promise;
      request.destroy();
      await aborted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(handlerFailures).toEqual([]);

      const followup = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
        },
        body,
      });
      expect(followup.status).toBe(200);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(handlerFailures).toEqual([]);
    } finally {
      await modernHandler.close();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it("aborts a closed legacy request without closing its session", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-mcp-legacy-socket-close-"));
    const handlers = createCodegraphMcpHandlers({ root });
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    let calls = 0;
    handlers.query_sqlite = async (_request, executionOptions?): Promise<CodegraphMcpFreshResult<RawSqlResult>> => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await new Promise<never>((_resolve, reject) => {
          executionOptions?.signal?.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(new Error("legacy request closed"));
            },
            { once: true },
          );
        });
      }
      return { columns: [], rows: [], freshness: { state: "fresh" } };
    };
    const protocolServer = createCodegraphMcpProtocolServer(handlers);
    const transport = new NodeStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => "legacy-socket-close-test",
    });
    await protocolServer.connect(transport);
    const handlerFailures: unknown[] = [];
    const httpServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        const body: unknown = raw.length ? JSON.parse(raw) : undefined;
        await runWithLegacyRequestAbortSignal(request, response, async () => {
          await transport.handleRequest(request, response, body);
        });
      })().catch((error: unknown) => handlerFailures.push(error));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (address === null || typeof address === "string") throw new Error("Legacy test server did not expose a port.");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    try {
      const initialize = await fetch(url, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "legacy-socket-close-test", version: "1.0.0" },
          },
        }),
      });
      expect(initialize.status).toBe(200);
      const sessionId = initialize.headers.get("mcp-session-id");
      if (!sessionId) throw new Error("Legacy test server did not issue a session ID.");
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "query_sqlite", arguments: { query: "SELECT 1;" } },
      });
      const socket = connectSocket(address.port, "127.0.0.1");
      socket.on("error", () => {});
      socket.write(
        [
          "POST /mcp HTTP/1.1",
          "Host: 127.0.0.1",
          "Accept: application/json, text/event-stream",
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(body)}`,
          `Mcp-Session-Id: ${sessionId}`,
          "",
          body,
        ].join("\r\n"),
      );
      await started.promise;
      socket.destroy();
      await aborted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(handlerFailures).toEqual([]);

      const followup = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
        body,
      });
      expect(followup.status).toBe(200);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(handlerFailures).toEqual([]);
    } finally {
      await transport.close();
      await protocolServer.close();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
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
      return { columns: [], rows: [], freshness: { state: "fresh" } };
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
