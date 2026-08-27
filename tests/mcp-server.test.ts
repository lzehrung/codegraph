import { registerSessionInvalidationHook } from "../src/agent/sessionLifecycle.js";
import { ensureSessionQueryIndex } from "../src/agent/query-index/sessionStore.js";
import fs from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "../src/agent/session.js";
import {
  awaitMcpToolOperation,
  callMcpTool,
  createCodegraphMcpHandlers,
  createCodegraphMcpProtocolServer,
  createCodegraphMcpProtocolServerWithTracker,
  createParseErrorReportingStdin,
  listCodegraphMcpTools,
  startCodegraphMcpHttpServer,
  DEFAULT_MCP_HTTP_SESSION_MAX_COUNT,
  type CodegraphMcpHandlers,
  type McpToolConcurrencyTracker,
  type McpToolOperationTracker,
} from "../src/mcp/server.js";
import { SymbolKind, type ModuleIndex, type ProjectIndex } from "../src/indexer/types.js";
import { MCP_TOOL_REGISTRY } from "../src/mcp/tools.js";
import { DEFAULT_REVIEW_TRANSPORT_LIMITS } from "../src/review/types.js";
import type { Graph } from "../src/types.js";
import * as symbolGraphBuild from "../src/graphs/symbol-graph-detailed.js";
import { SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY } from "../src/sqlite.js";
import { countingSession } from "./helpers/agent.js";
import { createArtifactOutputWithStaleFile, createLinkedTempRoot, isSymlinkUnavailable } from "./helpers/filesystem.js";
import type { CodegraphRuntimeIdentity, InstalledVersionChecker } from "../src/runtimeIdentity.js";
import { getCodegraphVersion } from "../src/util/packageInfo.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { runGit } from "./helpers/git.js";

type JsonRpcObject = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

function readObject(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function readToolJsonResult(payload: JsonRpcObject): Record<string, unknown> {
  const result = readObject(payload.result);
  if (!Array.isArray(result.content) || !result.content.length) {
    throw new Error("MCP tool result did not contain text content.");
  }
  const text = readObject(result.content[0]).text;
  if (typeof text !== "string") throw new Error("MCP tool result content was not text.");
  return readObject(JSON.parse(text));
}
function readProtocolError(payload: JsonRpcObject): Record<string, unknown> {
  return readObject(payload.error);
}

function readToolExecutionError(payload: JsonRpcObject): string {
  expect(payload.error).toBeUndefined();
  const result = readObject(payload.result);
  expect(result.isError).toBe(true);
  if (!Array.isArray(result.content) || !result.content.length) {
    throw new Error("MCP tool error did not contain text content.");
  }
  const text = readObject(result.content[0]).text;
  if (typeof text !== "string") throw new Error("MCP tool error content was not text.");
  return text;
}

function readJsonRpcObject(value: unknown): JsonRpcObject {
  return readObject(value) as JsonRpcObject;
}

async function postMcpJson(
  url: string,
  body: Record<string, unknown>,
  sessionId?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response; payload: JsonRpcObject }> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...extraHeaders,
  };
  if (sessionId !== undefined) {
    headers["mcp-session-id"] = sessionId;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as unknown;
  return { response, payload: readObject(payload) };
}
async function openMcpSse(url: string, sessionId: string): Promise<IncomingMessage> {
  const endpoint = new URL(url);
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  const request = httpRequest(
    {
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": sessionId,
      },
    },
    (response) => resolve(response),
  );
  request.on("error", reject);
  request.end();
  return await promise;
}

async function postRawHttpJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<{ status: number; payload: unknown }> {
  const endpoint = new URL(url);
  const rawBody = JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.pathname,
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(rawBody)),
          ...headers,
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          try {
            const payload: unknown = JSON.parse(responseBody);
            resolve({ status: response.statusCode ?? 0, payload });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    request.on("error", (error) => reject(error));
    request.end(rawBody);
  });
}

describe("codegraph MCP handlers", () => {
  describe("MCP stdio parse framing", () => {
    it("ignores blank lines, accepts CRLF frames, and recovers from malformed JSON", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-stdio-parse-"));
      const input = new PassThrough();
      const output = new PassThrough();
      const handlers = createCodegraphMcpHandlers({ root });
      const server = createCodegraphMcpProtocolServer(handlers);
      const transport = new StdioServerTransport(createParseErrorReportingStdin(input, output), output, {
        maxBufferSize: 10 * 1024 * 1024,
      });
      let frames = "";
      output.setEncoding("utf8");
      output.on("data", (chunk: string) => {
        frames += chunk;
      });

      try {
        await server.connect(transport);
        input.end(
          [
            "",
            "\r",
            "{bad}\r",
            '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}\r',
            '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
          ].join("\n"),
        );
        await vi.waitFor(() => {
          const responses = frames
            .trim()
            .split("\n")
            .map((frame) => readJsonRpcObject(JSON.parse(frame)));
          const parseErrors = responses.filter(
            (response) => response.id === null && readProtocolError(response).code === -32700,
          );
          expect(parseErrors).toHaveLength(1);
          expect(responses).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 2, result: expect.anything() })]),
          );
        });
      } finally {
        await server.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it("reports a malformed final frame without a newline before ending the input", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const filtered = createParseErrorReportingStdin(input, output);
      let response = "";
      output.setEncoding("utf8");
      output.on("data", (chunk: string) => {
        response += chunk;
      });
      const ended = new Promise<void>((resolve, reject) => {
        filtered.once("end", resolve);
        filtered.once("error", reject);
      });
      filtered.resume();

      input.end("{bad}");

      await ended;
      expect(response.trim()).toEqual(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      );
    });

    it("enforces the 10 MiB frame bound before passing data to the stdio transport", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const filtered = createParseErrorReportingStdin(input, output);
      const failure = new Promise<Error>((resolve) => filtered.once("error", resolve));

      input.end(Buffer.alloc(10 * 1024 * 1024 + 1));

      await expect(failure).resolves.toMatchObject({ message: "MCP stdio frame exceeded 10 MiB." });
    });
    it("serializes tool results compactly while preserving payload objects that resemble follow-ups", async () => {
      const handlers = createCodegraphMcpHandlers({ root: process.cwd() });
      const expected = { file: "fixture.ts", nested: { answer: 42 } };
      const agentResult = {
        followUps: [
          { tool: "chunk", arguments: { file: "fixture.ts" } },
          { tool: "duplicates", arguments: { files: ["a.ts", "b.ts"] } },
        ],
        anchors: [{ followUps: [{ tool: "chunk", arguments: { file: "anchor.ts" } }] }],
        packets: [{ followUps: [{ tool: "duplicates", arguments: { files: ["packet.ts"] } }] }],
        packet: { followUps: [{ tool: "duplicates", arguments: { files: ["nested-packet.ts"] } }] },
        focus: [{ followUps: [{ tool: "chunk", arguments: { file: "focus.ts" } }] }],
        results: [
          {
            source: { metadata: { tool: "chunk", arguments: { file: "source-snippet.ts" } } },
            followUps: [{ tool: "duplicates", arguments: { files: ["result.ts"] } }],
          },
        ],
      };
      const mappedResult = {
        followUps: [
          { tool: "get_file", arguments: { file: "fixture.ts" } },
          { tool: "packet_get", arguments: { target: "a.ts" } },
        ],
        anchors: [{ followUps: [{ tool: "get_file", arguments: { file: "anchor.ts" } }] }],
        packets: [{ followUps: [{ tool: "packet_get", arguments: { target: "packet.ts" } }] }],
        packet: { followUps: [{ tool: "packet_get", arguments: { target: "nested-packet.ts" } }] },
        focus: [{ followUps: [{ tool: "get_file", arguments: { file: "focus.ts" } }] }],
        results: [
          {
            source: { metadata: { tool: "chunk", arguments: { file: "source-snippet.ts" } } },
            followUps: [{ tool: "packet_get", arguments: { target: "result.ts" } }],
          },
        ],
      };
      handlers.get_file = async () => expected as never;
      const server = createCodegraphMcpProtocolServer(handlers);
      const sent: JsonRpcObject[] = [];
      const transport = {
        onclose: undefined,
        onerror: undefined,
        onmessage: undefined,
        async start() {},
        async send(message: unknown) {
          sent.push(readJsonRpcObject(message));
        },
        async close() {},
      } as Parameters<typeof server.connect>[0];
      try {
        await server.connect(transport);
        if (transport.onmessage === undefined) throw new Error("MCP transport did not start.");
        transport.onmessage({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        });
        await vi.waitFor(() => expect(sent.some((message) => message.id === 1)).toBe(true));
        transport.onmessage({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_file", arguments: { file: "fixture.ts" } },
        });
        await vi.waitFor(() => expect(sent.some((message) => message.id === 2)).toBe(true));
        const result = readObject(sent.find((message) => message.id === 2)?.result);
        const content = result.content;
        if (!Array.isArray(content) || !content.length)
          throw new Error("MCP tool result did not contain text content.");
        const serialized = readObject(content[0]).text;
        expect(serialized).toBeTypeOf("string");
        if (typeof serialized !== "string") throw new Error("MCP tool result content was not text.");
        expect(serialized).not.toContain("\n  ");
        const parsed = readObject(JSON.parse(serialized));
        expect(parsed).toEqual(expected);

        handlers.get_file = async () => agentResult as never;
        transport.onmessage({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "get_file", arguments: { file: "fixture.ts" } },
        });
        await vi.waitFor(() => expect(sent.some((message) => message.id === 3)).toBe(true));
        const mappedContent = readObject(sent.find((message) => message.id === 3)?.result).content;
        if (!Array.isArray(mappedContent) || !mappedContent.length)
          throw new Error("MCP tool result did not contain text content.");
        const mappedResultText = readObject(mappedContent[0]).text;
        if (typeof mappedResultText !== "string") throw new Error("MCP tool result content was not text.");
        const transportResult = readObject(JSON.parse(mappedResultText));
        expect(transportResult).toEqual(mappedResult);
        const responseShapes = [
          transportResult.followUps,
          readObject((transportResult.anchors as unknown[])[0]).followUps,
          readObject((transportResult.packets as unknown[])[0]).followUps,
          readObject(transportResult.packet).followUps,
          readObject((transportResult.focus as unknown[])[0]).followUps,
          readObject((transportResult.results as unknown[])[0]).followUps,
        ];
        const callableToolNames = new Set(MCP_TOOL_REGISTRY.map((tool) => tool.name));
        for (const followUps of responseShapes) {
          if (!Array.isArray(followUps)) throw new Error("MCP response shape did not contain follow-ups.");
          for (const followUp of followUps) {
            expect(callableToolNames).toContain(readObject(followUp).tool);
          }
        }
      } finally {
        await server.close();
      }
    });
  });

  it("honors cancellation notifications for request id zero", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-zero-cancel-"));
    const handlers = createCodegraphMcpHandlers({ root });
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    handlers.query_sqlite = async (_request, options?) => {
      started.resolve();
      // The body always rejects; returning the never satisfies the declared result type.
      return await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted.resolve();
          reject(new Error("cancelled"));
        });
      });
    };
    const server = createCodegraphMcpProtocolServer(handlers);
    const sent: JsonRpcObject[] = [];
    const transport = {
      onclose: undefined,
      onerror: undefined,
      onmessage: undefined,
      async start() {},
      async send(message: unknown) {
        sent.push(readJsonRpcObject(message));
      },
      async close() {},
    } as Parameters<typeof server.connect>[0];
    try {
      await server.connect(transport);
      if (transport.onmessage === undefined) throw new Error("MCP transport did not start.");
      transport.onmessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      transport.onmessage({
        jsonrpc: "2.0",
        id: 0,
        method: "tools/call",
        params: { name: "query_sqlite", arguments: { query: "SELECT 1;" } },
      });
      await started.promise;
      transport.onmessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 0 },
      });
      await aborted.promise;
    } finally {
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up a rejected tracked call during shutdown", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-shutdown-track-"));
    const handlers = createCodegraphMcpHandlers({ root });
    const toolOperations: McpToolOperationTracker = {
      isAccepting: () => true,
      track: <T>(_operation: () => Promise<T>): Promise<T> | undefined => undefined,
      stop() {},
      drain: async () => {},
    };
    const toolConcurrency: McpToolConcurrencyTracker = { inFlight: 0, maximum: 1 };
    const runtimeIdentity: CodegraphRuntimeIdentity = {
      startedAt: "2026-08-19T00:00:00.000Z",
      runningVersion: "test",
      packageRoot: root,
      packageJsonPath: path.join(root, "package.json"),
    };
    const installedVersion: InstalledVersionChecker = {
      check: () => ({ restartRequired: false, runningVersion: runtimeIdentity.runningVersion }),
    };
    const server = createCodegraphMcpProtocolServerWithTracker(
      handlers,
      runtimeIdentity,
      installedVersion,
      { firstToolCallPending: true },
      25,
      toolOperations,
      toolConcurrency,
    );
    const sent: JsonRpcObject[] = [];
    const transport = {
      onclose: undefined,
      onerror: undefined,
      onmessage: undefined,
      async start() {},
      async send(message: unknown) {
        sent.push(readJsonRpcObject(message));
      },
      async close() {},
    } as Parameters<typeof server.connect>[0];
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      await server.connect(transport);
      if (transport.onmessage === undefined) throw new Error("MCP transport did not start.");
      transport.onmessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      transport.onmessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "query_sqlite", arguments: { query: "SELECT 1;" } },
      });
      await vi.waitFor(() => expect(sent.some((message) => message.id === 2)).toBe(true));
      const response = sent.find((message) => message.id === 2);
      if (response === undefined) throw new Error("MCP server did not return a shutdown response.");
      expect(readProtocolError(response).message).toBe("MCP server is shutting down.");
      expect(toolConcurrency.inFlight).toBe(0);
      expect(clearTimeoutSpy).toHaveBeenCalled();

      abort.mockClear();
      transport.onmessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 2 },
      });
      expect(abort).not.toHaveBeenCalled();
      expect(toolConcurrency.inFlight).toBe(0);
    } finally {
      abort.mockRestore();
      clearTimeoutSpy.mockRestore();
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serves real MCP tool listing over a specified local HTTP port", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-http-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function ok(): number { return 1; }\n", "utf8");
    await fs.writeFile(
      path.join(root, "api.ts"),
      "import { ok } from './auth';\nexport function route(): number { return ok(); }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "duplicates.ts"),
      [
        "export class First { duplicate(): number { return 1; } }",
        "export class Second { duplicate(): number { return 2; } }",
        "",
      ].join("\n"),
      "utf8",
    );
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
    });

    try {
      expect(httpServer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

      const initialize = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-test", version: "1.0.0" },
        },
      });
      expect(initialize.response.status).toBe(200);
      const sessionId = initialize.response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      const initializeResult = readObject(initialize.payload.result);
      const serverInfo = readObject(initializeResult.serverInfo);
      expect(serverInfo.name).toBe("codegraph");
      expect(serverInfo.version).toBe(getCodegraphVersion());

      const toolsList = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        sessionId ?? undefined,
      );
      expect(toolsList.response.status).toBe(200);
      const toolsResult = readObject(toolsList.payload.result);
      const tools = toolsResult.tools;
      expect(Array.isArray(tools)).toBeTruthy();
      const listedTools = tools as Array<{ name?: unknown; description?: unknown }>;
      const toolNames = listedTools.map((tool) => tool.name);
      expect(toolNames).toContain("search");
      expect(toolNames).toContain("orient");
      expect(toolNames).toContain("packet_get");
      expect(toolNames).toContain("query_sqlite");
      expect(toolNames).toContain("refresh_index");
      expect(listedTools.find((tool) => tool.name === "refs")?.description).toContain("qualified file::symbol path");
      expect(listedTools.find((tool) => tool.name === "file_deps")?.description).toContain("portable handle");

      const gotoCall = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "goto", arguments: { handle: "auth.ts::ok" } },
        },
        sessionId ?? undefined,
      );
      expect(gotoCall.response.status).toBe(200);
      expect(readToolJsonResult(gotoCall.payload)).toMatchObject({ status: "ok", definition: { localName: "ok" } });

      const refsCall = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "refs", arguments: { handle: "auth.ts::ok" } },
        },
        sessionId ?? undefined,
      );
      expect(readToolJsonResult(refsCall.payload).references).toEqual(
        expect.arrayContaining([expect.objectContaining({ file: "api.ts" })]),
      );

      const depsCall = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "file_deps", arguments: { file: "api.ts::route", direction: "deps" } },
        },
        sessionId ?? undefined,
      );
      expect(readToolJsonResult(depsCall.payload).dependencies).toEqual(
        expect.arrayContaining([expect.objectContaining({ file: "auth.ts" })]),
      );

      const reverseDepsCall = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "file_deps", arguments: { file: "auth.ts::ok", direction: "rdeps" } },
        },
        sessionId ?? undefined,
      );
      expect(readToolJsonResult(reverseDepsCall.payload).reverseDependencies).toEqual(
        expect.arrayContaining([expect.objectContaining({ file: "api.ts" })]),
      );

      const missingCall = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "goto", arguments: { handle: "auth.ts::missing" } },
        },
        sessionId ?? undefined,
      );
      expect(readToolExecutionError(missingCall.payload)).toContain('Symbol path "auth.ts::missing" was not found');

      const ambiguousCall = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "file_deps", arguments: { file: "duplicates.ts::duplicate", direction: "deps" } },
        },
        sessionId ?? undefined,
      );
      expect(readToolExecutionError(ambiguousCall.payload)).toContain(
        'Ambiguous symbol target "duplicates.ts::duplicate"',
      );
      const invalidParams = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "search", arguments: { query: 42 } },
        },
        sessionId ?? undefined,
      );
      expect(readProtocolError(invalidParams.payload).code).toBe(-32602);

      const unknownTool = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "no_such_tool", arguments: {} },
        },
        sessionId ?? undefined,
      );
      expect(readProtocolError(unknownTool.payload).code).toBe(-32601);
      const missingFile = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "get_file", arguments: { file: "nope-missing.ts" } },
        },
        sessionId ?? undefined,
      );
      const missingFileError = readToolExecutionError(missingFile.payload);
      expect(missingFileError).not.toContain(root);
      expect(missingFileError).not.toMatch(/[A-Za-z]:[\\/]/);
    } finally {
      await httpServer.close();
    }
  });
  it("advertises logging and emits first-call cold-start notifications once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-first-call-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const handlers = createCodegraphMcpHandlers({ root });
    const server = createCodegraphMcpProtocolServer(handlers);
    const sent: JsonRpcObject[] = [];
    const transport = {
      onclose: undefined,
      onerror: undefined,
      onmessage: undefined,
      async start() {},
      async send(message: unknown) {
        sent.push(readJsonRpcObject(message));
      },
      async close() {},
    } as Parameters<typeof server.connect>[0];

    await server.connect(transport);
    if (transport.onmessage === undefined) {
      throw new Error("Connected MCP transport did not receive an onmessage handler.");
    }

    transport.onmessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "codegraph-test", version: "1.0.0" },
      },
    });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(readObject(readObject(sent[0].result).capabilities).logging).toEqual({});

    transport.onmessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "get_file",
        arguments: { file: "auth.ts" },
        _meta: { progressToken: 7 },
      },
    });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(6);
    });

    const firstCallMessages = sent.slice(1);
    const progressMessages = firstCallMessages.filter((message) => message.method === "notifications/progress");
    const logMessages = firstCallMessages.filter((message) => message.method === "notifications/message");
    expect(progressMessages).toHaveLength(2);
    expect(logMessages).toHaveLength(2);
    expect(
      progressMessages.some((message) => {
        const params = readObject(message.params);
        return params.progressToken === 7 && params.progress === 0 && params.total === 1;
      }),
    ).toBeTruthy();
    expect(
      progressMessages.some((message) => {
        const params = readObject(message.params);
        return params.progressToken === 7 && params.progress === 1 && params.total === 1;
      }),
    ).toBeTruthy();
    expect(logMessages.map((message) => readObject(message.params).data)).toContain(
      "Codegraph is warming the first tool call for 'get_file'.",
    );
    expect(logMessages.map((message) => readObject(message.params).data)).toContain(
      "Codegraph finished warming the first tool call for 'get_file'.",
    );

    const firstResult = firstCallMessages.at(-1);
    if (firstResult === undefined) {
      throw new Error("First MCP tool call did not return a final response.");
    }
    expect(firstResult.id).toBe(2);
    expect(firstResult.error).toBeUndefined();
    expect(readObject(firstResult.result).isError).not.toBeTruthy();

    transport.onmessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_file",
        arguments: { file: "auth.ts" },
        _meta: { progressToken: 8 },
      },
    });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(7);
    });

    const secondResult = sent.at(-1);
    if (secondResult === undefined) {
      throw new Error("Second MCP tool call did not return a final response.");
    }
    expect(secondResult.id).toBe(3);
    expect(secondResult.method).toBeUndefined();
    expect(secondResult.error).toBeUndefined();
    expect(readObject(secondResult.result).isError).not.toBeTruthy();
  });

  it("returns compact impact data while review keeps review-specific fields", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-impact-schema-"));
    runGit(root, ["init"]);
    await fs.writeFile(path.join(root, "auth.ts"), "export function authorize() { return false; }\n", "utf8");
    await fs.writeFile(
      path.join(root, "api.ts"),
      'import { authorize } from "./auth";\nexport const handle = () => authorize();\n',
      "utf8",
    );
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);
    const base = runGit(root, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(root, "auth.ts"), "export function authorize() { return true; }\n", "utf8");
    runGit(root, ["add", "auth.ts"]);
    runGit(root, ["commit", "-m", "change"]);

    const handlers = createCodegraphMcpHandlers({ root });
    const impact = await handlers.impact({ base, head: "HEAD" });
    const review = await handlers.review({ base, head: "HEAD" });

    expect(impact.format).toBe("compact");
    expect(impact.impacted).toBeDefined();
    expect(impact).not.toHaveProperty("riskSummary");
    expect(impact).not.toHaveProperty("reviewTasks");
    expect(review).toHaveProperty("riskSummary");
    expect(review).toHaveProperty("reviewTasks");
  });

  it("does not load the session index or duplicate analysis for no-change MCP review calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-review-no-changes-"));
    runGit(root, ["init"]);
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);
    const base = runGit(root, ["rev-parse", "HEAD"]);

    const backing = createAgentSession({ root });
    let projectLoads = 0;
    let duplicateComputations = 0;
    let duplicatePromise: ReturnType<NonNullable<AgentSession["loadDuplicateAnalysis"]>> | undefined;
    const session: AgentSession = {
      ...countingSession(backing).session,
      loadProject: async (options) => {
        projectLoads += 1;
        return await backing.loadProject(options);
      },
      loadDuplicateAnalysis: async () => {
        duplicatePromise ??= (async () => {
          duplicateComputations += 1;
          return await backing.loadDuplicateAnalysis!();
        })();
        return await duplicatePromise;
      },
    };
    const handlers = createCodegraphMcpHandlers({ root, session });
    const report = await handlers.review({ base, head: "HEAD" });

    expect(report.status).toBe("no_changes");
    expect(projectLoads).toBe(0);
    expect(duplicateComputations).toBe(0);
  });

  it("reuses the session project index and duplicate analysis across repeated review calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-review-reuse-"));
    runGit(root, ["init"]);
    const duplicateSource = [
      "export function normalizeInvoiceRows(rows) {",
      "  const totals = [];",
      "  const labels = [];",
      "  for (const row of rows) {",
      "    const subtotal = row.amount + row.tax;",
      "    const rounded = Math.round(subtotal * 100) / 100;",
      "    const label = rounded > 100 ? 'large' : 'small';",
      "    labels.push(label);",
      "    totals.push(rounded);",
      "  }",
      "  const encoded = totals.map((value, index) => labels[index] + ':' + value.toFixed(2));",
      "  return encoded.filter((value) => value.includes(':')).join(',');",
      "}",
      "",
    ].join("\n");
    await fs.writeFile(path.join(root, "a.ts"), duplicateSource, "utf8");
    await fs.writeFile(path.join(root, "b.ts"), duplicateSource, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);
    const base = runGit(root, ["rev-parse", "HEAD"]);
    await fs.writeFile(
      path.join(root, "a.ts"),
      duplicateSource.replace("row.amount", "row.amount /* changed */"),
      "utf8",
    );
    runGit(root, ["add", "a.ts"]);
    runGit(root, ["commit", "-m", "change"]);

    const backing = createAgentSession({ root });
    const counted = countingSession(backing);
    let duplicateComputations = 0;
    let duplicatePromise: ReturnType<NonNullable<AgentSession["loadDuplicateAnalysis"]>> | undefined;
    const session: AgentSession = {
      ...counted.session,
      loadDuplicateAnalysis: async () => {
        duplicatePromise ??= (async () => {
          duplicateComputations += 1;
          return await backing.loadDuplicateAnalysis!();
        })();
        return await duplicatePromise;
      },
    };
    const handlers = createCodegraphMcpHandlers({ root, session });

    const first = await handlers.review({ base, head: "HEAD" });
    const second = await handlers.review({ base, head: "HEAD" });

    expect(first.reviewTasks.some((task) => task.reason === "duplicate-sibling")).toBe(true);
    expect(second.reviewTasks.some((task) => task.reason === "duplicate-sibling")).toBe(true);
    expect(counted.loads()).toBe(1);
    expect(duplicateComputations).toBe(1);
  });

  it("keeps tool calls available when installed package metadata disappears", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-runtime-drift-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
      runtimeIdentity: {
        startedAt: "2026-07-14T00:00:00.000Z",
        runningVersion: "1.8.93",
        packageRoot: root.replace(/\\/g, "/"),
        packageJsonPath: path.join(root, "missing-package.json"),
      },
    });

    try {
      const initialize = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-test", version: "1.0.0" },
        },
      });
      const sessionId = initialize.response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      const toolCall = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_file", arguments: { file: "auth.ts" } },
        },
        sessionId ?? undefined,
      );

      expect(toolCall.response.status).toBe(200);
      expect(toolCall.payload.error).toBeUndefined();
      expect(readObject(toolCall.payload.result).isError).not.toBeTruthy();
    } finally {
      await httpServer.close();
    }
  });

  it("shares the tool concurrency cap across modern Streamable HTTP requests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-modern-concurrency-"));
    const backingSession = createAgentSession({ root });
    const release = Promise.withResolvers<void>();
    let entered = 0;
    const session: AgentSession = {
      ...backingSession,
      loadProject: async (options) => {
        entered += 1;
        await release.promise;
        return await backingSession.loadProject(options);
      },
    };
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      port: 0,
      session,
      mcpToolConcurrency: 2,
    });
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    };

    try {
      const calls = Array.from({ length: 5 }, (_, index) =>
        postMcpJson(
          httpServer.url,
          {
            jsonrpc: "2.0",
            id: index + 1,
            method: "tools/call",
            params: { name: "search", arguments: { query: "missing", mode: "symbol" }, _meta: meta },
          },
          undefined,
          {
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": "search",
          },
        ),
      );
      await vi.waitFor(() => expect(entered).toBe(2));

      release.resolve();
      const responses = await Promise.all(calls);
      expect(entered).toBe(2);
      expect(responses).toHaveLength(5);
      expect(responses.filter(({ payload }) => payload.error === undefined)).toHaveLength(2);
    } finally {
      release.resolve();
      await httpServer.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("advertises and enforces the search depth maximum over MCP HTTP", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-search-depth-"));
    const httpServer = await startCodegraphMcpHttpServer({ root, port: 0 });

    try {
      const initialize = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-search-depth-test", version: "1.0.0" },
        },
      });
      const sessionId = initialize.response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      const tools = await postMcpJson(
        httpServer.url,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        sessionId ?? undefined,
      );
      const listedTools = readObject(tools.payload.result).tools;
      expect(Array.isArray(listedTools)).toBe(true);
      const search = (listedTools as Array<Record<string, unknown>>).find((tool) => tool.name === "search");
      const depth = readObject(readObject(readObject(search).inputSchema).properties).depth;
      expect(readObject(depth)).toMatchObject({ minimum: 0, maximum: 5, default: 1 });

      const overLimit = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "search", arguments: { query: "missing", depth: 6 } },
        },
        sessionId ?? undefined,
      );
      expect(readProtocolError(overLimit.payload).code).toBe(-32602);
    } finally {
      await httpServer.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("evicts idle HTTP sessions and bounds the concurrent session count", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-session-evict-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const sessionIdleMs = 50;
    const sessionEvictionIntervalMs = 20;
    const sessionEvictionWaitMs = sessionIdleMs + sessionEvictionIntervalMs * 2;
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      port: 0,
      httpSessionIdleMs: sessionIdleMs,
      httpSessionMaxCount: 2,
      httpSessionEvictionIntervalMs: sessionEvictionIntervalMs,
    });

    const initialize = async (id: number): Promise<string> => {
      const result = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: `codegraph-test-${id}`, version: "1.0.0" },
        },
      });
      expect(result.response.status).toBe(200);
      const sessionId = result.response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      return sessionId!;
    };

    const probeSession = async (id: number, sessionId: string): Promise<number> => {
      const result = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id,
          method: "tools/list",
          params: {},
        },
        sessionId,
      );
      return result.response.status;
    };

    try {
      const first = await initialize(1);
      const second = await initialize(2);
      expect(await probeSession(101, first)).toBe(200);
      expect(await probeSession(102, second)).toBe(200);

      await initialize(3);
      expect(await probeSession(103, first)).toBe(400);

      // This integration test must wait for the real server interval; fake timers do not drive it.
      const wait = Promise.withResolvers<void>();
      setTimeout(wait.resolve, sessionEvictionWaitMs);
      await wait.promise;
      expect(await probeSession(104, second)).toBe(400);

      const replacement = await initialize(4);
      expect(await probeSession(105, replacement)).toBe(200);
      expect(DEFAULT_MCP_HTTP_SESSION_MAX_COUNT).toBeGreaterThan(0);
    } finally {
      await httpServer.close();
    }
  });

  it("refreshes legacy HTTP session activity after a request outlives its idle window", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-session-completion-touch-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const backingSession = createAgentSession({ root });
    const toolStarted = Promise.withResolvers<void>();
    const releaseTool = Promise.withResolvers<void>();
    let gateTool = false;
    const session: AgentSession = {
      ...backingSession,
      loadProject: async (options) => {
        if (gateTool) {
          toolStarted.resolve();
          await releaseTool.promise;
        }
        return await backingSession.loadProject(options);
      },
    };
    const idleMs = 50;
    const evictionIntervalMs = 10;
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      port: 0,
      session,
      httpSessionIdleMs: idleMs,
      httpSessionEvictionIntervalMs: evictionIntervalMs,
    });

    try {
      const initialize = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-completion-touch-test", version: "1.0.0" },
        },
      });
      const sessionId = initialize.response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      gateTool = true;
      const longCall = postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search", arguments: { query: "ok", mode: "symbol" } },
        },
        sessionId ?? undefined,
      );
      await toolStarted.promise;
      await vi.advanceTimersByTimeAsync(idleMs + evictionIntervalMs);
      releaseTool.resolve();
      expect((await longCall).response.status).toBe(200);

      await vi.advanceTimersByTimeAsync(evictionIntervalMs);
      const followup = await postMcpJson(
        httpServer.url,
        { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
        sessionId ?? undefined,
      );
      expect(followup.response.status).toBe(200);
    } finally {
      releaseTool.resolve();
      await httpServer.close();
      await fs.rm(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("rejects a new session instead of evicting an in-flight request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-session-capacity-active-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const backingSession = createAgentSession({ root });
    const loadStarted = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    const session: AgentSession = {
      ...backingSession,
      loadProject: async (options) => {
        loadStarted.resolve();
        await releaseLoad.promise;
        return await backingSession.loadProject(options);
      },
    };
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      port: 0,
      session,
      httpSessionIdleMs: 0,
      httpSessionMaxCount: 1,
    });

    const initialize = async (id: number): Promise<{ response: Response; payload: JsonRpcObject }> =>
      await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: `codegraph-test-${id}`, version: "1.0.0" },
        },
      });

    try {
      const first = await initialize(1);
      const firstSessionId = first.response.headers.get("mcp-session-id");
      expect(firstSessionId).toBeTruthy();
      const inFlight = postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search", arguments: { query: "ok", mode: "symbol" } },
        },
        firstSessionId ?? undefined,
      );
      await loadStarted.promise;

      const rejected = await initialize(3);
      expect(rejected.response.status).toBe(503);
      const error = readObject(rejected.payload.error);
      expect(error.code).toBe(-32000);
      expect(error.message).toMatch(/all configured sessions are active/);

      releaseLoad.resolve();
      expect((await inFlight).response.status).toBe(200);
      expect(
        (
          await postMcpJson(
            httpServer.url,
            { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
            firstSessionId ?? undefined,
          )
        ).response.status,
      ).toBe(200);
    } finally {
      releaseLoad.resolve();
      await httpServer.close();
    }
  });

  it("does not idle-evict a session holding an open SSE stream", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-session-sse-active-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      port: 0,
      httpSessionIdleMs: 30,
      httpSessionMaxCount: 1,
      httpSessionEvictionIntervalMs: 10,
    });

    try {
      const initialize = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-sse-test", version: "1.0.0" },
        },
      });
      const sessionId = initialize.response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      const stream = await openMcpSse(httpServer.url, sessionId ?? "");
      expect(stream.statusCode).toBe(200);
      // This integration test deliberately waits on the real eviction timer; fake timers do not control an interval
      // created while the HTTP server is serving real Node requests.
      const wait = Promise.withResolvers<void>();
      setTimeout(wait.resolve, 120);
      await wait.promise;

      const probe = await postMcpJson(
        httpServer.url,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        sessionId ?? undefined,
      );
      expect(probe.response.status).toBe(200);

      const streamClosed = Promise.withResolvers<void>();
      stream.once("close", streamClosed.resolve);
      stream.destroy();
      await streamClosed.promise;
    } finally {
      await httpServer.close();
    }
  });

  it("refreshes a long-lived Streamable HTTP session after workspace edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-http-freshness-"));
    await fs.writeFile(path.join(root, "initial.ts"), "export function initialSymbol() { return 1; }\n", "utf8");
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const initialize = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-test", version: "1.0.0" },
        },
      });
      const sessionId = initialize.response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      const firstCall = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "workspace_symbols", arguments: { query: "initialSymbol" } },
        },
        sessionId ?? undefined,
      );
      expect(readToolJsonResult(firstCall.payload).symbols).toEqual([
        expect.objectContaining({ name: "initialSymbol" }),
      ]);

      await fs.writeFile(path.join(root, "late.ts"), "export function lateSymbol() { return 2; }\n", "utf8");
      const refreshedCall = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "workspace_symbols", arguments: { query: "lateSymbol" } },
        },
        sessionId ?? undefined,
      );
      const refreshedResult = readToolJsonResult(refreshedCall.payload);
      expect(refreshedResult.freshness).toEqual({ state: "refreshed", changedFiles: ["late.ts"] });
      expect(refreshedResult.symbols).toEqual([
        expect.objectContaining({
          name: "lateSymbol",
          location: expect.objectContaining({ file: "late.ts" }),
        }),
      ]);
    } finally {
      await httpServer.close();
    }
  });
  it("rejects explore calls above the published MCP schema maximums over Streamable HTTP", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-explore-schema-max-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser() { return true; }\n", "utf8");
    const counted = countingSession(createAgentSession({ root }));
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
      session: counted.session,
    });

    try {
      const initialize = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-test", version: "1.0.0" },
        },
      });
      expect(initialize.response.status).toBe(200);
      const sessionId = initialize.response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      if (sessionId === null) {
        throw new Error("MCP initialize response did not include a session id.");
      }

      const toolsList = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        sessionId,
      );
      expect(toolsList.response.status).toBe(200);
      const toolsResult = readObject(toolsList.payload.result);
      const tools = toolsResult.tools;
      expect(Array.isArray(tools)).toBeTruthy();
      const exploreTool = (tools as Array<{ name?: unknown; inputSchema?: unknown }>).find(
        (tool) => tool.name === "explore",
      );
      expect(exploreTool).toBeTruthy();
      if (exploreTool === undefined) {
        throw new Error("MCP tools/list did not include the explore tool.");
      }
      const exploreSchema = readObject(exploreTool.inputSchema);
      const exploreProperties = readObject(exploreSchema.properties);
      const maxFields = [
        { name: "limit", maximum: 50 },
        { name: "maxPackets", maximum: 10 },
        { name: "maxPaths", maximum: 10 },
      ] as const;

      for (const [index, field] of maxFields.entries()) {
        const fieldSchema = readObject(exploreProperties[field.name]);
        expect(fieldSchema.maximum).toBe(field.maximum);

        const toolCall = await postMcpJson(
          httpServer.url,
          {
            jsonrpc: "2.0",
            id: 3 + index,
            method: "tools/call",
            params: {
              name: "explore",
              arguments: { query: "auth", [field.name]: field.maximum + 1 },
            },
          },
          sessionId,
        );
        expect(toolCall.response.status).toBe(200);
        expect(toolCall.payload.result).toBeUndefined();
        const error = readObject(toolCall.payload.error);
        expect(error.code).toEqual(expect.any(Number));
        expect(error.message).toEqual(expect.any(String));
        const serializedError = JSON.stringify(error);
        if (serializedError === undefined) {
          throw new Error("MCP validation error was not JSON serializable.");
        }
        expect(serializedError).toContain(field.name);
        expect(serializedError).toContain(String(field.maximum));
        expect(serializedError).toMatch(/too_big|maximum|max|Too big|less than or equal|at most|<=/i);
      }
      expect(counted.loads()).toBe(0);
    } finally {
      await httpServer.close();
    }
  });

  it("rejects HTTP MCP requests with an unexpected host header", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-http-host-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const response = await postRawHttpJson(
        httpServer.url,
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { host: "evil.example" },
      );
      const payload = readObject(response.payload);
      const error = readObject(payload.error);

      expect(response.status).toBe(403);
      expect(error.message).toBe("Forbidden host header");
    } finally {
      await httpServer.close();
    }
  });
  it("validates HTTP Origin headers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-http-origin-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const endpoint = new URL(httpServer.url);
      const initializeRequest = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-test", version: "1.0.0" },
        },
      };
      const missingOrigin = await postRawHttpJson(
        httpServer.url,
        { ...initializeRequest, id: 1 },
        { accept: "application/json, text/event-stream" },
      );
      const missingPayload = readObject(missingOrigin.payload);
      expect(missingOrigin.status).toBe(200);
      expect(missingPayload.result).toBeDefined();

      const matchingOrigin = await postRawHttpJson(
        httpServer.url,
        { ...initializeRequest, id: 2 },
        {
          accept: "application/json, text/event-stream",
          origin: `http://127.0.0.1:${endpoint.port}`,
        },
      );
      const matchingPayload = readObject(matchingOrigin.payload);
      expect(matchingOrigin.status).toBe(200);
      expect(matchingPayload.result).toBeDefined();

      const rejectedOrigins = ["http://evil.example", "not-an-origin", "null"];
      for (const [index, origin] of rejectedOrigins.entries()) {
        const rejected = await postRawHttpJson(httpServer.url, { ...initializeRequest, id: index + 3 }, { origin });
        const rejectedPayload = readObject(rejected.payload);
        const rejectedError = readObject(rejectedPayload.error);
        expect(rejected.status).toBe(403);
        expect(rejectedPayload.jsonrpc).toBe("2.0");
        expect(rejectedError.code).toBeTypeOf("number");
      }
    } finally {
      await httpServer.close();
    }
  });

  it("routes modern HTTP header claims to strict SDK validation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-http-modern-boundary-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const counted = countingSession(createAgentSession({ root }));
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
      session: counted.session,
    });

    try {
      const response = await postRawHttpJson(
        httpServer.url,
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { "mcp-protocol-version": "2026-07-28" },
      );
      const payload = readObject(response.payload);
      const error = readObject(payload.error);

      expect(response.status).toBe(400);
      expect(payload.jsonrpc).toBe("2.0");
      expect(error.code).toBe(-32602);
      expect(counted.loads()).toBe(0);
    } finally {
      await httpServer.close();
    }
  });

  it("caches installed-version health checks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-health-version-cache-"));
    const packageJsonPath = path.join(root, "package.json");
    await fs.writeFile(packageJsonPath, JSON.stringify({ version: "1.0.0" }), "utf8");
    const runtimeIdentity: CodegraphRuntimeIdentity = {
      startedAt: "2026-08-26T00:00:00.000Z",
      runningVersion: "1.0.0",
      packageRoot: root,
      packageJsonPath,
    };
    const httpServer = await startCodegraphMcpHttpServer({ root, port: 0, runtimeIdentity });

    try {
      const healthUrl = new URL(httpServer.url);
      healthUrl.pathname = "/health";
      const firstHealth = readObject(await (await fetch(healthUrl)).json());
      expect(readObject(firstHealth.update).installedVersion).toBe("1.0.0");

      await fs.writeFile(packageJsonPath, JSON.stringify({ version: "1.0.1" }), "utf8");

      const cachedHealth = readObject(await (await fetch(healthUrl)).json());
      expect(readObject(cachedHealth.update).installedVersion).toBe("1.0.0");
    } finally {
      await httpServer.close();
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("accepts loopback host and Origin headers on an all-interface HTTP bind", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-http-wildcard-host-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "0.0.0.0",
      port: 0,
    });

    try {
      const endpoint = new URL(httpServer.url);
      const loopbackUrl = `http://127.0.0.1:${endpoint.port}${endpoint.pathname}`;
      const initializeRequest = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-test", version: "1.0.0" },
        },
      };
      const response = await postRawHttpJson(
        loopbackUrl,
        {
          ...initializeRequest,
          id: 1,
        },
        {
          accept: "application/json, text/event-stream",
          host: `127.0.0.1:${endpoint.port}`,
          origin: `http://127.0.0.1:${endpoint.port}`,
        },
      );
      const payload = readObject(response.payload);

      expect(response.status).toBe(200);
      expect(payload.result).toBeDefined();

      const localhostResponse = await postRawHttpJson(
        loopbackUrl,
        {
          ...initializeRequest,
          id: 2,
        },
        {
          accept: "application/json, text/event-stream",
          host: `localhost:${endpoint.port}`,
          origin: `http://localhost:${endpoint.port}`,
        },
      );
      const localhostPayload = readObject(localhostResponse.payload);
      expect(localhostResponse.status).toBe(200);
      expect(localhostPayload.result).toBeDefined();

      const ipv6OriginResponse = await postRawHttpJson(
        loopbackUrl,
        {
          ...initializeRequest,
          id: 3,
        },
        {
          accept: "application/json, text/event-stream",
          host: `127.0.0.1:${endpoint.port}`,
          origin: `http://[::1]:${endpoint.port}`,
        },
      );
      const ipv6OriginPayload = readObject(ipv6OriginResponse.payload);
      expect(ipv6OriginResponse.status).toBe(200);
      expect(ipv6OriginPayload.result).toBeDefined();

      const rejectedOrigin = await postRawHttpJson(
        loopbackUrl,
        { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
        {
          host: `127.0.0.1:${endpoint.port}`,
          origin: "http://evil.example",
        },
      );
      const rejectedOriginPayload = readObject(rejectedOrigin.payload);
      const rejectedOriginError = readObject(rejectedOriginPayload.error);
      expect(rejectedOrigin.status).toBe(403);
      expect(rejectedOriginPayload.jsonrpc).toBe("2.0");
      expect(rejectedOriginError.code).toBeTypeOf("number");

      const rejected = await postRawHttpJson(
        loopbackUrl,
        { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
        { host: "evil.example" },
      );
      const rejectedPayload = readObject(rejected.payload);
      const rejectedError = readObject(rejectedPayload.error);
      expect(rejected.status).toBe(403);
      expect(rejectedError.message).toBe("Forbidden host header");
    } finally {
      await httpServer.close();
    }
  });

  it.each([Number.NaN, -1, 1.5, 2_147_483_648])(
    "rejects an invalid HTTP body timeout during server startup",
    async (httpBodyTimeoutMs) => {
      await expect(
        startCodegraphMcpHttpServer({
          root: process.cwd(),
          host: "127.0.0.1",
          port: 0,
          httpBodyTimeoutMs,
        }),
      ).rejects.toThrow("httpBodyTimeoutMs must be a positive integer no greater than 2147483647.");
    },
  );

  it("rejects a null HTTP body timeout during server startup", async () => {
    const options = {
      root: process.cwd(),
      host: "127.0.0.1",
      port: 0,
    };
    Object.defineProperty(options, "httpBodyTimeoutMs", { value: null });

    await expect(startCodegraphMcpHttpServer(options)).rejects.toThrow(
      "httpBodyTimeoutMs must be a positive integer no greater than 2147483647.",
    );
  });
  it.each([Number.NaN, -1, 1.5, 2_147_483_648])(
    "rejects an invalid MCP tool timeout during server startup",
    async (mcpToolTimeoutMs) => {
      await expect(
        startCodegraphMcpHttpServer({
          root: process.cwd(),
          host: "127.0.0.1",
          port: 0,
          mcpToolTimeoutMs,
        }),
      ).rejects.toThrow("mcpToolTimeoutMs must be a whole number from 0 through 2147483647; 0 disables the deadline.");
    },
  );

  it("rejects a null MCP tool timeout during server startup", async () => {
    const options = {
      root: process.cwd(),
      host: "127.0.0.1",
      port: 0,
    };
    Object.defineProperty(options, "mcpToolTimeoutMs", { value: null });

    await expect(startCodegraphMcpHttpServer(options)).rejects.toThrow(
      "mcpToolTimeoutMs must be a whole number from 0 through 2147483647; 0 disables the deadline.",
    );
  });

  it("accepts Node's maximum HTTP body timeout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-http-timeout-maximum-"));
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
      httpBodyTimeoutMs: 2_147_483_647,
    });

    try {
      expect(httpServer.port).toBeGreaterThan(0);
    } finally {
      await httpServer.close();
      await fs.rm(root, { force: true, recursive: true });
    }
  });
  it("rejects declared oversized HTTP MCP request bodies without buffering their payload", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-http-large-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const response = await fetch(httpServer.url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", padding: "x".repeat(1_000_000) }),
      });

      expect(response.status).toBe(413);
    } finally {
      await httpServer.close();
    }
  });

  it("returns a timeout response while draining an incomplete HTTP MCP body", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-http-timeout-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
      httpBodyTimeoutMs: 25,
    });

    try {
      const endpoint = new URL(httpServer.url);
      const partialBody = '{"jsonrpc":"2.0","id":1,"method":"initialize"';
      const response = await new Promise<{ status: number; payload: JsonRpcObject; connection: string | undefined }>(
        (resolve, reject) => {
          let responseReceived = false;
          const request = httpRequest(
            {
              hostname: endpoint.hostname,
              port: endpoint.port,
              path: endpoint.pathname,
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(partialBody) + 1),
              },
            },
            (incoming) => {
              let responseBody = "";
              incoming.setEncoding("utf8");
              incoming.on("data", (chunk: string) => {
                responseBody += chunk;
              });
              incoming.on("end", () => {
                responseReceived = true;
                try {
                  resolve({
                    status: incoming.statusCode ?? 0,
                    payload: readJsonRpcObject(JSON.parse(responseBody)),
                    connection: incoming.headers.connection,
                  });
                } catch (error) {
                  reject(error instanceof Error ? error : new Error(String(error)));
                } finally {
                  request.destroy();
                }
              });
            },
          );
          request.on("error", (error) => {
            if (!responseReceived) reject(error);
          });
          request.write(partialBody);
        },
      );

      expect([response.status, response.connection]).toEqual([408, "close"]);
      expect(readObject(response.payload.error).message).toBe("MCP request body timed out");
    } finally {
      await httpServer.close();
    }
  });

  it("invalidates prebuilt resources when HTTP server binding fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-listen-failure-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const occupiedServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
    });
    const session = createAgentSession({ root });
    let invalidated = false;
    registerSessionInvalidationHook(session, () => {
      invalidated = true;
    });

    try {
      await expect(
        startCodegraphMcpHttpServer({
          root,
          host: "127.0.0.1",
          port: occupiedServer.port,
          session,
        }),
      ).rejects.toThrow();
      expect(invalidated).toBe(true);
    } finally {
      await occupiedServer.close();
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("reuses one session across search, get_symbol, refs, and query_sqlite handlers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fs.writeFile(
      path.join(root, "api.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n",
    );

    const handlers = createCodegraphMcpHandlers({ root });
    const search = await handlers.search({ query: "validate user", limit: 5 });
    const first = search.results[0];

    expect(first?.handle).toBeTruthy();

    const symbol = await handlers.get_symbol({ handle: first!.handle });
    expect(symbol.label).toContain("validateUser");

    const refs = await handlers.refs({ handle: first!.handle });
    expect(refs.references.some((ref) => ref.file === "api.ts")).toBeTruthy();
  });

  it("resolves qualified symbol paths for goto, refs, and file dependencies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-qualified-symbol-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fs.writeFile(
      path.join(root, "api.ts"),
      "import { validateUser } from './auth';\nexport function route() { return validateUser(1); }\n",
    );

    const handlers = createCodegraphMcpHandlers({ root });
    const target = "auth.ts::validateUser";
    const goto = await handlers.goto({ handle: target });
    expect(goto).toMatchObject({ status: "ok", definition: { localName: "validateUser" } });

    const refs = await handlers.refs({ handle: target });
    expect(refs.references).toEqual(expect.arrayContaining([expect.objectContaining({ file: "api.ts" })]));

    const dependencies = await handlers.deps({ file: "api.ts::route" });
    expect(dependencies.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ file: "auth.ts" })]));

    const workspaceSymbols = await handlers.workspace_symbols({ query: "route", fileGlob: "api.ts" });
    const route = workspaceSymbols.symbols.find((symbol) => symbol.localName === "route");
    if (!route) throw new Error("Expected portable route handle.");
    const dependenciesByHandle = await handlers.deps({ file: route.handle });
    expect(dependenciesByHandle.dependencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ file: "auth.ts" })]),
    );
    await expect(handlers.deps({ file: "symbol:api.ts:route:99:0" })).rejects.toThrow(
      "Symbol handle is stale or missing",
    );
  });

  it("returns orientation and packet data through MCP handlers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-packet-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "run.ts"), "export function run() { return 1; }\n");

    const handlers = createCodegraphMcpHandlers({ root });
    const orient = await handlers.orient({ includeRoots: ["src"], budget: "small" });
    const fileFocus = orient.focus.find((focus) => focus.file);
    expect(fileFocus?.file).toBe("src/run.ts");

    const packet = await handlers.packet_get({ target: fileFocus!.file! });

    expect(packet.schemaVersion).toBe(2);
    expect(packet.kind).toBe("file");
    expect(JSON.stringify(packet.packet)).toContain("src/run.ts");
  });

  it("does not advertise MCP root overrides for orientation packet tools", () => {
    const orientTool = listCodegraphMcpTools().find((tool) => tool.name === "orient");
    const packetTool = listCodegraphMcpTools().find((tool) => tool.name === "packet_get");
    expect(orientTool).toBeTruthy();
    expect(packetTool).toBeTruthy();
    expect(packetTool?.description).toContain("symbol name");
    expect(packetTool?.description).toContain("SQL object name");

    const orientSchema = readObject(orientTool!.inputSchema);
    const packetSchema = readObject(packetTool!.inputSchema);
    const orientProperties = readObject(orientSchema.properties);
    const packetProperties = readObject(packetSchema.properties);

    expect(orientProperties.root).toBeUndefined();
    expect(packetProperties.root).toBeUndefined();
    expect(packetProperties.maxDuplicates).toBeTruthy();
    expect(packetProperties.target).toBeTruthy();
  });

  it("advertises get_file with the exact bounded file-view schema", () => {
    const getFileTool = listCodegraphMcpTools().find((tool) => tool.name === "get_file");
    expect(getFileTool).toBeTruthy();
    if (getFileTool === undefined) {
      throw new Error("MCP tools/list did not include the get_file tool.");
    }

    const getFileSchema = readObject(getFileTool.inputSchema);
    const getFileProperties = readObject(getFileSchema.properties);

    expect(getFileSchema.type).toBe("object");
    expect(getFileSchema.required).toEqual(["file"]);
    expect(Object.keys(getFileProperties).sort()).toEqual([
      "allowSensitive",
      "file",
      "includeGraphContext",
      "limit",
      "maxBytes",
      "offset",
    ]);
    expect(readObject(getFileProperties.file)).toEqual({ type: "string" });
    expect(readObject(getFileProperties.offset)).toEqual({ type: "integer", minimum: 1, default: 1 });
    expect(readObject(getFileProperties.limit)).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 10_000,
      default: 2_000,
    });
    expect(readObject(getFileProperties.maxBytes)).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 500_000,
      default: 80_000,
    });
    expect(readObject(getFileProperties.includeGraphContext)).toEqual({ type: "boolean", default: false });
    expect(readObject(getFileProperties.allowSensitive)).toEqual({ type: "boolean", default: false });
  });

  it("bounds refs by handle with the refs limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-refs-limit-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fs.writeFile(
      path.join(root, "api.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n",
    );
    await fs.writeFile(
      path.join(root, "other.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser(2);\n",
    );

    const handlers = createCodegraphMcpHandlers({ root });
    const search = await handlers.search({ query: "validate user", limit: 5 });
    const first = search.results[0];
    expect(first?.handle).toBeTruthy();

    const refs = await handlers.refs({ handle: first!.handle, limit: 1 });
    expect(refs.references).toHaveLength(1);
  });

  it("reports exact truncation metadata for capped deps, rdeps, and file_deps results", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-deps-truncation-"));
    await fs.writeFile(
      path.join(root, "a.ts"),
      'import { b } from "./b";\nimport { c } from "./c";\nexport const a = b + c;\n',
    );
    await fs.writeFile(path.join(root, "b.ts"), "export const b = 1;\n");
    await fs.writeFile(path.join(root, "c.ts"), "export const c = 2;\n");
    await fs.writeFile(path.join(root, "d.ts"), 'import { b } from "./b";\nexport const d = b;\n');

    const handlers = createCodegraphMcpHandlers({ root });

    const limited = await handlers.deps({ file: "a.ts", limit: 1 });
    expect(limited.dependencies).toHaveLength(1);
    expect(limited.limit).toBe(1);
    expect(limited.truncated).toBe(true);
    expect(limited.totalSeen).toBe(2);
    expect(limited.omitted).toBe(1);

    // Exactly-at-limit must read as complete: the handler probes one entry past the
    // cap, so a true count equal to the limit is not confused with "more exist".
    const atLimit = await handlers.deps({ file: "a.ts", limit: 2 });
    expect(atLimit.dependencies).toHaveLength(2);
    expect(atLimit.truncated).toBe(false);
    expect(atLimit.totalSeen).toBe(2);
    expect(atLimit.omitted).toBe(0);

    const complete = await handlers.deps({ file: "a.ts" });
    expect(complete.dependencies).toHaveLength(2);
    expect(complete.truncated).toBe(false);
    expect(complete.omitted).toBe(0);
    expect(complete.totalSeen).toBe(2);

    const limitedRdeps = await handlers.rdeps({ file: "b.ts", limit: 1 });
    expect(limitedRdeps.reverseDependencies).toHaveLength(1);
    expect(limitedRdeps.truncated).toBe(true);
    expect(limitedRdeps.omitted).toBe(1);

    const fileDeps = await handlers.file_deps({ file: "a.ts", direction: "deps", limit: 50 });
    expect(fileDeps.dependencies).toHaveLength(2);
    expect(fileDeps.truncated).toBe(false);
    expect(fileDeps.omitted).toBe(0);
  });

  it("reports exact truncation metadata for capped refs results", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-refs-truncation-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fs.writeFile(
      path.join(root, "api.ts"),
      "import { validateUser } from './auth';\nexport function route() { return validateUser(1); }\n",
    );

    const handlers = createCodegraphMcpHandlers({ root });

    const limited = await handlers.refs({ handle: "auth.ts::validateUser", limit: 1 });
    expect(limited.references).toHaveLength(1);
    expect(limited.limit).toBe(1);
    expect(limited.truncated).toBe(true);
    expect(limited.totalSeen).toBe(2);
    expect(limited.omitted).toBe(1);

    const complete = await handlers.refs({ handle: "auth.ts::validateUser", limit: 50 });
    expect(complete.references.length).toBeGreaterThan(1);
    expect(complete.truncated).toBe(false);
    expect(complete.omitted).toBe(0);
    expect(complete.totalSeen).toBe(complete.references.length);

    // The position-based form shares the same metadata contract.
    const byPosition = await handlers.refs({
      file: "auth.ts",
      line: 1,
      column: "export function ".length,
      limit: 1,
    });
    expect(byPosition.references).toHaveLength(1);
    expect(byPosition.truncated).toBe(true);
    expect(byPosition.omitted).toBe(1);
  });
  it("returns empty truncated pages with exact lower-bound metadata for zero limits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-zero-limit-"));
    await fs.writeFile(path.join(root, "a.ts"), 'import { b } from "./b";\nexport const a = b;\n');
    await fs.writeFile(path.join(root, "b.ts"), "export const b = 1;\n");
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fs.writeFile(
      path.join(root, "api.ts"),
      'import { validateUser } from "./auth";\nexport const ok = validateUser(1);\n',
    );

    const handlers = createCodegraphMcpHandlers({ root });

    const deps = await handlers.deps({ file: "a.ts", limit: 0 });
    expect(deps).toEqual({
      dependencies: [],
      limit: 0,
      totalSeen: 1,
      truncated: true,
      omitted: 1,
      freshness: { state: "fresh" },
    });

    const rdeps = await handlers.rdeps({ file: "b.ts", limit: 0 });
    expect(rdeps).toEqual({
      reverseDependencies: [],
      limit: 0,
      totalSeen: 1,
      truncated: true,
      omitted: 1,
      freshness: { state: "fresh" },
    });

    const refs = await handlers.refs({ handle: "auth.ts::validateUser", limit: 0 });
    expect(refs).toEqual({
      references: [],
      limit: 0,
      totalSeen: 1,
      truncated: true,
      omitted: 1,
      freshness: { state: "fresh" },
    });
  });

  it("bounds the MCP review report with explicit transport limits and omitted counts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-review-bounded-"));
    runGit(root, ["init"]);
    await fs.writeFile(path.join(root, "auth.ts"), "export function authorize() { return false; }\n", "utf8");
    await fs.writeFile(
      path.join(root, "api.ts"),
      'import { authorize } from "./auth";\nexport const handle = () => authorize();\n',
      "utf8",
    );
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);
    const base = runGit(root, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(root, "auth.ts"), "export function authorize() { return true; }\n", "utf8");
    runGit(root, ["add", "auth.ts"]);
    runGit(root, ["commit", "-m", "change"]);

    const handlers = createCodegraphMcpHandlers({ root });
    const report = await handlers.review({ base, head: "HEAD" });

    expect(report.status).toBe("ok");
    expect(report.limits).toEqual(DEFAULT_REVIEW_TRANSPORT_LIMITS);
    // A small report fits every collection, so nothing is omitted — but the
    // transport boundary is still explicit.
    expect(report.omittedCounts).toEqual({
      projectFiles: 0,
      changedFiles: 0,
      symbols: 0,
      graphDelta: 0,
      candidateTests: 0,
    });
    expect(report.changedFiles.length).toBeLessThanOrEqual(report.limits.changedFiles);
    expect(report.graphDelta.length).toBeLessThanOrEqual(report.limits.graphDelta);
    expect(report.candidateTests.length).toBeLessThanOrEqual(report.limits.candidateTests);
  });

  it("rejects unknown MCP tool arguments instead of silently stripping them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-unknown-args-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const handlers = createCodegraphMcpHandlers({ root });
    const server = createCodegraphMcpProtocolServer(handlers);
    const sent: JsonRpcObject[] = [];
    const transport = {
      onclose: undefined,
      onerror: undefined,
      onmessage: undefined,
      async start() {},
      async send(message: unknown) {
        sent.push(readJsonRpcObject(message));
      },
      async close() {},
    } as Parameters<typeof server.connect>[0];

    await server.connect(transport);
    if (transport.onmessage === undefined) {
      throw new Error("Connected MCP transport did not receive an onmessage handler.");
    }

    transport.onmessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "refs",
        arguments: {
          file: "auth.ts",
          line: 1,
          column: 0,
          maxReferencess: 5,
        },
      },
    });
    await vi.waitFor(() => {
      expect(sent.some((message) => message.id === 1)).toBeTruthy();
    });

    const result = sent.find((message) => message.id === 1);
    expect(result).toBeDefined();
    const error = readObject(result!.error);
    expect(String(error.message)).toMatch(/Invalid parameters for refs/i);
    expect(String(error.message)).toMatch(/maxReferencess|Unrecognized key/i);
  });

  it("advertises additionalProperties false for collection tools", () => {
    for (const name of ["search", "workspace_symbols", "file_deps", "review", "query_sqlite"] as const) {
      const tool = listCodegraphMcpTools().find((entry) => entry.name === name);
      expect(tool, name).toBeDefined();
      expect(readObject(tool!.inputSchema).additionalProperties).toBe(false);
    }
  });

  it("advertises goto and refs with mutually exclusive handle-or-complete-location schemas", () => {
    const gotoTool = listCodegraphMcpTools().find((tool) => tool.name === "goto");
    const refsTool = listCodegraphMcpTools().find((tool) => tool.name === "refs");
    const gotoSchema = readObject(gotoTool!.inputSchema);
    const refsSchema = readObject(refsTool!.inputSchema);
    const gotoProperties = readObject(gotoSchema.properties);
    const refsProperties = readObject(refsSchema.properties);
    const alternatives = [
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
    ];

    expect(gotoSchema.type).toBe("object");
    expect(gotoSchema.additionalProperties).toBe(false);
    expect(gotoSchema.required).toBeUndefined();
    expect(gotoSchema.oneOf).toEqual(alternatives);
    expect(Object.keys(gotoProperties).sort()).toEqual(["column", "file", "handle", "line"]);

    expect(refsSchema.type).toBe("object");
    expect(refsSchema.additionalProperties).toBe(false);

    expect(refsSchema.required).toBeUndefined();
    expect(refsSchema.oneOf).toEqual(alternatives);
    expect(Object.keys(refsProperties).sort()).toEqual(["column", "file", "handle", "limit", "line"]);
    expect(refsProperties.limit).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 500,
      default: 25,
    });
  });

  it("keeps refs handle-or-position validation in the handler", async () => {
    const handlers = createCodegraphMcpHandlers({ root: process.cwd() });

    // Deliberately omits column, which the request type forbids, so that the handler's
    // own runtime validation is what rejects it.
    const incompleteRefsRequest = { file: "src/index.ts", line: 1 } as Parameters<typeof handlers.refs>[0];
    await expect(handlers.refs(incompleteRefsRequest)).rejects.toThrow(
      "refs requires either handle or file, line, and column.",
    );
    await expect(
      handlers.refs({ handle: "symbol:src/index.ts#test", file: "src/index.ts", line: 1, column: 1 }),
    ).rejects.toThrow("refs requires either handle or file, line, and column.");
  });

  it("keeps query_sqlite read-only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true, graphJson: true });

    await expect(handlers.query_sqlite({ query: "DELETE FROM symbols RETURNING name;" })).rejects.toThrow(/read-only/i);
  });

  it("bounds query_sqlite rows for MCP responses", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-limit-"));
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
    await fs.writeFile(path.join(root, "two.ts"), "export const two = 2;\n");

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true });

    const result = await handlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;", limit: 1 });

    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBeTruthy();
    expect(result.rowLimit).toBe(1);
  });
  it("serializes concurrent forced artifact builds into one consistent SQLite bundle", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-write-lock-"));
    const outDir = path.join(root, "out");
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const backingSession = createAgentSession({ root });
    const firstBuildStarted = Promise.withResolvers<void>();
    const releaseFirstBuild = Promise.withResolvers<void>();
    let projectLoads = 0;
    const session: AgentSession = {
      ...backingSession,
      loadProject: async (options) => {
        projectLoads += 1;
        if (projectLoads === 1) {
          firstBuildStarted.resolve();
          await releaseFirstBuild.promise;
        }
        return await backingSession.loadProject(options);
      },
    };
    const handlers = createCodegraphMcpHandlers({ root, readOnly: false, session });

    try {
      const first = handlers.artifact_build({ outDir, sqlite: true, force: true });
      await firstBuildStarted.promise;
      const second = handlers.artifact_build({ outDir, sqlite: true, force: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(projectLoads).toBe(1);

      releaseFirstBuild.resolve();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      const manifest = JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8")) as {
        artifacts: { sqlite?: string };
      };
      expect(manifest.artifacts.sqlite).toBe("codegraph.sqlite");
      const sqliteResult = await handlers.query_sqlite({ query: "SELECT path FROM files;" });
      expect(sqliteResult.rows.some((row) => String(row[0]).endsWith("auth.ts"))).toBe(true);
    } finally {
      releaseFirstBuild.resolve();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes the SQLite artifact before query_sqlite after small workspace edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-fresh-"));
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true });

    await fs.writeFile(path.join(root, "two.ts"), "export const two = 2;\n");
    const result = await handlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" });
    const paths = result.rows.map((row) => normalizeSqlitePath(row[0]));

    expect(paths.some((file) => file.endsWith("two.ts"))).toBe(true);
    expect(result.freshness).toEqual({ state: "refreshed", changedFiles: ["two.ts"] });
  });

  it("refreshes the SQLite artifact before query_sqlite after edits and deletions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-fresh-edit-delete-"));
    const keptFile = path.join(root, "one.ts");
    const removedFile = path.join(root, "remove.ts");
    await fs.writeFile(keptFile, "export function oldName() { return 1; }\n");
    await fs.writeFile(removedFile, "export function removedName() { return 2; }\n");
    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true });

    await fs.writeFile(keptFile, "export function editedName() { return 3; }\n");
    await fs.unlink(removedFile);
    const result = await handlers.query_sqlite({ query: "SELECT name FROM symbols ORDER BY name;" });
    const names = result.rows.map((row) => String(row[0]));

    expect(names).toContain("editedName");
    expect(names).not.toContain("oldName");
    expect(names).not.toContain("removedName");
    expect(result.freshness).toEqual({ state: "refreshed", changedFiles: ["one.ts", "remove.ts"] });
  });

  it("guides stale SQLite rebuilds through refresh_index before artifact_build when the session is stale", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-stale-session-guidance-"));
    const outDir = path.join(root, "out");
    const removedFile = path.join(root, "remove.ts");
    await fs.writeFile(path.join(root, "keep.ts"), "export const keep = 1;\n");
    await fs.writeFile(removedFile, `export const payload = "${"x".repeat(64)}";\n`);
    const session = createAgentSession({ root, freshness: { policy: "auto", maxAutoRefreshBytes: 16 } });
    const handlers = createCodegraphMcpHandlers({ root, session, readOnly: false });
    await handlers.artifact_build({ outDir, sqlite: true });

    await fs.unlink(removedFile);
    let caught: unknown;
    try {
      await handlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new Error("query_sqlite should reject stale SQLite rebuilds with an Error");
    }
    expect(caught.message).toMatch(/SQLite artifact is stale/);
    expect(caught.message).toMatch(/refresh_index[\s\S]*artifact_build[\s\S]*query_sqlite/);
    expect(caught.message).toMatch(/changed byte count exceeds 16/);
    expect(caught.message).toMatch(/remove\.ts/);
    expect(caught.message.indexOf("refresh_index")).toBeLessThan(caught.message.indexOf("artifact_build"));
    expect(caught.message.indexOf("artifact_build")).toBeLessThan(caught.message.indexOf("query_sqlite"));
  });

  it("guides read-only stale SQLite artifacts to rebuild with write access enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-stale-artifact-"));
    const outDir = path.join(root, "out");
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
    const buildHandlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await buildHandlers.artifact_build({ outDir, sqlite: true });

    await fs.writeFile(path.join(root, "two.ts"), "export const two = 2;\n");
    const readHandlers = createCodegraphMcpHandlers({ root, artifactPath: outDir, readOnly: true });
    let caught: unknown;
    try {
      await readHandlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new Error("query_sqlite should reject stale SQLite artifacts with an Error");
    }
    expect(caught.message).toMatch(/SQLite artifact is stale/);
    expect(caught.message).toMatch(/rebuild[\s\S]*write access enabled/i);
    expect(caught.message).toMatch(/two\.ts/);
    expect(caught.message).not.toMatch(/artifact_build before query_sqlite/i);
  });

  it("guides read-only stale SQLite rebuilds through refresh_index when the session is stale", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-readonly-stale-session-"));
    const outDir = path.join(root, "out");
    const removedFile = path.join(root, "remove.ts");
    await fs.writeFile(path.join(root, "keep.ts"), "export const keep = 1;\n");
    await fs.writeFile(removedFile, `export const payload = "${"x".repeat(64)}";\n`);
    const session = createAgentSession({ root, freshness: { policy: "auto", maxAutoRefreshBytes: 16 } });
    const buildHandlers = createCodegraphMcpHandlers({ root, session, readOnly: false });
    await buildHandlers.artifact_build({ outDir, sqlite: true });

    await fs.unlink(removedFile);
    const readHandlers = createCodegraphMcpHandlers({ root, artifactPath: outDir, readOnly: true, session });
    let caught: unknown;
    try {
      await readHandlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new Error("query_sqlite should reject stale read-only rebuilds with an Error");
    }
    expect(caught.message).toMatch(/SQLite artifact is stale/);
    expect(caught.message).toMatch(/refresh_index/i);
    expect(caught.message).toMatch(/rebuild[\s\S]*write access enabled/i);
    expect(caught.message).toMatch(/changed byte count exceeds 16/);
    expect(caught.message).toMatch(/remove\.ts/);
    const writeAccessIndex = caught.message.toLowerCase().indexOf("write access enabled");
    expect(caught.message.indexOf("refresh_index")).toBeLessThan(writeAccessIndex);
    expect(caught.message).not.toMatch(/artifact_build before query_sqlite/i);
  });

  it("refuses older SQLite artifacts without freshness metadata in read-only mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-legacy-artifact-"));
    const outDir = path.join(root, "out");
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
    const buildHandlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await buildHandlers.artifact_build({ outDir, sqlite: true });
    const db = new DatabaseSync(path.join(outDir, "codegraph.sqlite"));
    try {
      db.prepare("DELETE FROM graph_metadata WHERE key = ?;").run(SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY);
    } finally {
      db.close();
    }
    const readHandlers = createCodegraphMcpHandlers({ root, artifactPath: outDir });

    await expect(readHandlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" })).rejects.toThrow(
      /SQLite artifact has no freshness baseline/,
    );
  });

  it("rebuilds stale configured SQLite artifact bundles in writable mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-writable-bundle-"));
    const outDir = path.join(root, "out");
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
    const buildHandlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await buildHandlers.artifact_build({ outDir, sqlite: true });
    const db = new DatabaseSync(path.join(outDir, "codegraph.sqlite"));
    try {
      db.prepare("DELETE FROM graph_metadata WHERE key = ?;").run(SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY);
    } finally {
      db.close();
    }
    await fs.writeFile(path.join(root, "two.ts"), "export const two = 2;\n");
    const readHandlers = createCodegraphMcpHandlers({ root, artifactPath: outDir, readOnly: false });
    const result = await readHandlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" });
    const paths = result.rows.map((row) => normalizeSqlitePath(row[0]));

    expect(paths.some((file) => file.endsWith("two.ts"))).toBe(true);
    expect(result.freshness).toEqual({ state: "refreshed", changedFiles: [] });
  });

  it("refuses stale explicit SQLite artifact files in writable mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-explicit-file-"));
    const outDir = path.join(root, "out");
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
    const buildHandlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await buildHandlers.artifact_build({ outDir, sqlite: true });

    await fs.writeFile(path.join(root, "two.ts"), "export const two = 2;\n");
    const readHandlers = createCodegraphMcpHandlers({
      root,
      artifactPath: path.join(outDir, "codegraph.sqlite"),
      readOnly: false,
    });

    await expect(readHandlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" })).rejects.toThrow(
      /SQLite artifact is stale[\s\S]*two\.ts/,
    );
  });

  it("uses prebuilt session discovery for SQLite artifact freshness", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-session-discovery-"));
    await fs.writeFile(path.join(root, "keep.ts"), "export const keep = 1;\n");
    await fs.writeFile(path.join(root, "ignored.ts"), "export const ignored = 2;\n");
    const session = createAgentSession({
      root,
      discovery: { ignoreGlobs: ["ignored.ts"] },
      freshness: { policy: "auto" },
    });
    const handlers = createCodegraphMcpHandlers({ root, session, readOnly: false });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true });

    const initial = await handlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" });
    await fs.writeFile(path.join(root, "late.ts"), "export const late = 3;\n");
    const refreshed = await handlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" });
    const initialPaths = initial.rows.map((row) => normalizeSqlitePath(row[0]));
    const refreshedPaths = refreshed.rows.map((row) => normalizeSqlitePath(row[0]));

    expect(initialPaths.some((file) => file.endsWith("keep.ts"))).toBe(true);
    expect(initialPaths.some((file) => file.endsWith("ignored.ts"))).toBe(false);
    expect(initial.freshness).toEqual({ state: "fresh" });
    expect(refreshedPaths.some((file) => file.endsWith("late.ts"))).toBe(true);
    expect(refreshedPaths.some((file) => file.endsWith("ignored.ts"))).toBe(false);
    expect(refreshed.freshness).toEqual({ state: "refreshed", changedFiles: ["late.ts"] });
  });

  it("rejects prebuilt SQLite sessions without live discovery", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-no-discovery-"));
    const outDir = path.join(root, "out");
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
    const buildHandlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await buildHandlers.artifact_build({ outDir, sqlite: true });
    const backingSession = createAgentSession({ root });
    const session: AgentSession = {
      loadProject: backingSession.loadProject,
      checkFreshness: async () => ({ state: "fresh" }),
      invalidate: backingSession.invalidate,
    };
    const readHandlers = createCodegraphMcpHandlers({ root, artifactPath: outDir, session });

    await expect(readHandlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" })).rejects.toThrow(
      /does not expose live file discovery/,
    );
  });

  it("serves a fresh SQLite artifact without checking session freshness", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-fresh-artifact-no-session-check-"));
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
    const outDir = path.join(root, "out");
    const buildHandlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await buildHandlers.artifact_build({ outDir, sqlite: true });

    const backingSession = createAgentSession({ root });
    let freshnessChecks = 0;
    const session: AgentSession = {
      ...backingSession,
      checkFreshness: async () => {
        freshnessChecks += 1;
        throw new Error("query_sqlite should inspect fresh SQLite artifact metadata before session freshness");
      },
    };
    const readHandlers = createCodegraphMcpHandlers({ root, artifactPath: outDir, session });

    const result = await readHandlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" });

    expect(result.rows.map((row) => normalizeSqlitePath(row[0])).some((file) => file.endsWith("one.ts"))).toBe(true);
    expect(result.freshness).toEqual({ state: "fresh" });
    expect(freshnessChecks).toBe(0);
  });
  it("bounds query_sqlite bytes for MCP responses", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-bytes-"));
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true });

    const result = await handlers.query_sqlite({ query: "SELECT ? AS big;", params: ["x".repeat(300000)] });

    expect(result.byteLimit).toBe(200000);
    expect(result.truncated).toBeTruthy();
    expect(result.rows).toHaveLength(1);
    expect(String(result.rows[0]?.[0]).length).toBeLessThan(9000);
  });

  it("rejects synthetic large SQLite payload functions before execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-large-function-"));
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true });

    await expect(handlers.query_sqlite({ query: "SELECT hex(randomblob(300000)) AS big;" })).rejects.toThrow(
      /unsupported SQLite function/i,
    );
  });

  it("rejects quoted synthetic large SQLite payload functions before execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-quoted-large-function-"));
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true });

    await expect(handlers.query_sqlite({ query: 'SELECT "randomblob"(300000) AS big;' })).rejects.toThrow(
      /unsupported SQLite function randomblob/i,
    );
    await expect(handlers.query_sqlite({ query: "SELECT `randomblob`(300000) AS big;" })).rejects.toThrow(
      /unsupported SQLite function randomblob/i,
    );
    await expect(handlers.query_sqlite({ query: "SELECT [randomblob](300000) AS big;" })).rejects.toThrow(
      /unsupported SQLite function randomblob/i,
    );
    await expect(handlers.query_sqlite({ query: "SELECT 'randomblob(300000)' AS text;" })).resolves.toEqual(
      expect.objectContaining({ rows: [["randomblob(300000)"]] }),
    );
    await expect(
      handlers.query_sqlite({ query: "SELECT 1 AS ok /* zeroblob(300000) */ -- randomblob(300000)" }),
    ).resolves.toEqual(expect.objectContaining({ rows: [[1]] }));
  });

  it("disables artifact builds in read-only mode before checking freshness", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-readonly-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    const backingSession = createAgentSession({ root });
    let freshnessChecks = 0;
    const session: AgentSession = {
      ...backingSession,
      checkFreshness: async () => {
        freshnessChecks += 1;
        throw new Error("checkFreshness should not run before read-only artifact_build rejection");
      },
    };

    const readOnlyHandlers = createCodegraphMcpHandlers({ root, readOnly: true, session });
    await expect(readOnlyHandlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true })).rejects.toThrow(
      /artifact_build is disabled in read-only MCP mode/i,
    );
    expect(freshnessChecks).toBe(0);
  });

  it("rejects artifact paths outside the root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-root-"));
    const outside = path.resolve(root, "..", "outside.sqlite");

    await expect(
      (async () => {
        const handlers = createCodegraphMcpHandlers({ root, artifactPath: outside });
        await handlers.query_sqlite({ query: "select 1" });
      })(),
    ).rejects.toThrow(/outside project root/);

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await expect(
      handlers.artifact_build({ outDir: path.resolve(root, "..", "outside"), sqlite: true }),
    ).rejects.toThrow(/outside project root/);
  });

  it("rejects get_file paths outside the root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-"));
    await expect(
      (async () => {
        const handlers = createCodegraphMcpHandlers({ root });
        await handlers.get_file({ file: path.resolve(root, "..", "outside.ts") });
      })(),
    ).rejects.toThrow(/outside project root/);
  });

  it("rejects get_file paths that escape through a directory link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "outside\n");
    const linkPath = path.join(root, "linked");
    try {
      await fs.symlink(outside, linkPath, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const handlers = createCodegraphMcpHandlers({ root });

    await expect(handlers.get_file({ file: path.join("linked", "secret.txt") })).rejects.toThrow(
      /outside project root/,
    );
  });

  it("bounds get_file reads before returning content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-bound-"));
    await fs.writeFile(path.join(root, "large.txt"), "abcdef", "utf8");
    const handlers = createCodegraphMcpHandlers({ root });

    const result = await handlers.get_file({ file: "large.txt", maxBytes: 5 });

    expect(result).toMatchObject({
      file: "large.txt",
      text: "abcde",
      truncated: true,
    });
  });

  it("returns numbered get_file content with stable line pagination", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-lines-"));
    await fs.writeFile(path.join(root, "notes.txt"), "one\ntwo\nthree\n", "utf8");
    const handlers = createCodegraphMcpHandlers({ root });

    const result = await handlers.get_file({ file: "notes.txt", offset: 2, limit: 2, includeGraphContext: false });

    expect(result).toMatchObject({
      schemaVersion: 1,
      file: "notes.txt",
      offset: 2,
      limit: 2,
      totalLines: 4,
      content: "2\ttwo\n3\tthree",
      lineFormat: "number-tab-line",
      page: { nextOffset: 4 },
    });
  });

  it("paginates complete lines beyond the initial byte window without hiding the full-file line count", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-window-page-"));
    await fs.writeFile(path.join(root, "notes.txt"), "one\ntwo\nthree\n", "utf8");
    const handlers = createCodegraphMcpHandlers({ root });

    const firstPage = await handlers.get_file({ file: "notes.txt", maxBytes: 7, limit: 2 });

    expect(firstPage).toMatchObject({
      text: "one\ntwo",
      content: "1\tone\n2\ttwo",
      totalLines: 4,
      truncated: false,
      page: { nextOffset: 3 },
    });

    const finalPage = await handlers.get_file({ file: "notes.txt", offset: 3, maxBytes: 7, limit: 2 });
    expect(finalPage).toMatchObject({
      text: "three\n",
      content: "3\tthree\n4\t",
      totalLines: 4,
      truncated: false,
    });
    expect(finalPage.page).toBeUndefined();
  });

  it("redacts environment files through get_file unless allowSensitive is true", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sensitive-file-"));
    const sensitiveText = "API_TOKEN=mcp-secret\nUSER=alice\n";
    await fs.writeFile(path.join(root, ".env.test"), sensitiveText, "utf8");
    const handlers = createCodegraphMcpHandlers({ root });

    const redacted = await handlers.get_file({ file: ".env.test" });

    expect(JSON.stringify(redacted)).not.toContain("mcp-secret");
    expect(redacted).toMatchObject({
      file: ".env.test",
      text: "Sensitive environment values omitted.\nKeys: API_TOKEN, USER",
      content: "1\tSensitive environment values omitted.\n2\tKeys: API_TOKEN, USER",
      sensitive: { kind: "environment", redacted: true, allowSensitiveRequired: true },
    });

    const allowed = await handlers.get_file({ file: ".env.test", allowSensitive: true });

    expect(allowed).toMatchObject({
      text: sensitiveText,
      content: "1\tAPI_TOKEN=mcp-secret\n2\tUSER=alice\n3\t",
      sensitive: { kind: "environment", redacted: false, allowSensitiveRequired: true },
    });
  });

  it("honors requested freshness and project loading while sensitive content stays redacted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sensitive-context-"));
    const rawSecret = "freshness-secret-value";
    await fs.writeFile(path.join(root, ".env.test"), `API_TOKEN=${rawSecret}\nUSER=alice\n`, "utf8");
    const backingSession = createAgentSession({ root });
    let freshnessChecks = 0;
    let projectLoads = 0;
    const session: AgentSession = {
      ...backingSession,
      checkFreshness: async () => {
        freshnessChecks += 1;
        return { state: "refreshed", changedFiles: [".env.test"] };
      },
      loadProject: async (options) => {
        projectLoads += 1;
        return await backingSession.loadProject(options);
      },
    };
    const handlers = createCodegraphMcpHandlers({ root, session });

    const redacted = await handlers.get_file({ file: ".env.test", includeGraphContext: true });

    expect(JSON.stringify(redacted)).not.toContain(rawSecret);
    expect(redacted).toMatchObject({
      text: "Sensitive environment values omitted.\nKeys: API_TOKEN, USER",
      content: "1\tSensitive environment values omitted.\n2\tKeys: API_TOKEN, USER",
      freshness: { state: "refreshed", changedFiles: [".env.test"] },
      sensitive: { kind: "environment", redacted: true, allowSensitiveRequired: true },
    });
    expect(freshnessChecks).toBe(1);
    expect(projectLoads).toBe(1);
  });

  it("keeps plain get_file index-free and opts into freshness and direct graph context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-graph-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "auth.ts"), "export function validateUser() { return true; }\n", "utf8");
    await fs.writeFile(
      path.join(root, "src", "server.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser();\n",
      "utf8",
    );
    const backingSession = createAgentSession({ root });
    let freshnessChecks = 0;
    let projectLoads = 0;
    const session: AgentSession = {
      ...backingSession,
      checkFreshness: async () => {
        freshnessChecks += 1;
        return { state: "fresh" };
      },
      loadProject: async (options) => {
        projectLoads += 1;
        return await backingSession.loadProject(options);
      },
    };
    const handlers = createCodegraphMcpHandlers({ root, session });

    const plain = await handlers.get_file({ file: "src/auth.ts", limit: 1 });

    expect(plain.content).toBe("1\texport function validateUser() { return true; }");
    expect(plain.graphContext).toBeUndefined();
    expect(freshnessChecks).toBe(0);
    expect(projectLoads).toBe(0);

    const contextual = await handlers.get_file({ file: "src/auth.ts", limit: 1, includeGraphContext: true });

    expect(contextual.graphContext?.usedBy).toContain("src/server.ts");
    expect(contextual.graphContext?.symbols).toContainEqual(
      expect.objectContaining({ name: "validateUser", kind: "function", line: 1 }),
    );
    expect(freshnessChecks).toBe(1);
    expect(projectLoads).toBe(1);
  });

  it("caps each get_file graph-context collection at 100 entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-graph-cap-"));
    const targetFile = path.join(root, "target.ts");
    await fs.writeFile(targetFile, "export const target = true;\n", "utf8");
    const unsortedIndexes = Array.from({ length: 101 }, (_, position) => {
      const offset = Math.floor(position / 2);
      if (position % 2) return offset;
      return 100 - offset;
    });
    const usedByFiles = unsortedIndexes.map((index) =>
      path.join(root, `consumer-${String(index).padStart(3, "0")}.ts`),
    );
    const moduleIndex: ModuleIndex = {
      file: targetFile,
      exports: [],
      imports: unsortedIndexes.map((index) => ({
        kind: "star",
        from: `package-${String(index).padStart(3, "0")}`,
      })),
      locals: unsortedIndexes.map((index) => ({
        file: targetFile,
        localName: `symbol-${String(index).padStart(3, "0")}`,
        kind: SymbolKind.Function,
        range: {
          start: { line: index + 1, column: 1 },
          end: { line: index + 1, column: 2 },
        },
      })),
    };
    const fileGraph: Graph = {
      nodes: new Set([targetFile, ...usedByFiles]),
      edges: usedByFiles.map((file) => ({ from: file, to: { type: "file", path: targetFile }, raw: "./target" })),
    };
    const index: ProjectIndex = {
      graph: fileGraph,
      modules: new Map([[fileIdentityKey(targetFile), moduleIndex]]),
      byFile: new Map([[fileIdentityKey(targetFile), moduleIndex]]),
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    const snapshot: AgentProjectSnapshot = {
      root,
      files: [targetFile],
      index,
      fileGraph,
      symbolGraph: { nodes: new Map(), edges: [] },
      analysis: {
        mode: "semantic",
        backend: "unknown",
        parserDegradedFiles: 0,
        fallbackImportExtractionFiles: 0,
        nativeFilesUsed: 0,
        nativeFilesFellBack: 0,
        label: "semantic",
      },
    };
    const session: AgentSession = {
      root,
      loadProject: async () => snapshot,
      invalidate: () => undefined,
    };
    const handlers = createCodegraphMcpHandlers({ root, session });

    const result = await handlers.get_file({ file: "target.ts", includeGraphContext: true });

    expect(result.graphContext?.usedBy).toHaveLength(100);
    expect(result.graphContext?.usedBy.slice(0, 2)).toEqual(["consumer-000.ts", "consumer-001.ts"]);
    expect(result.graphContext?.usedBy.slice(-2)).toEqual(["consumer-098.ts", "consumer-099.ts"]);
    expect(result.graphContext?.usedBy).not.toContain("consumer-100.ts");
    expect(result.graphContext?.imports).toHaveLength(100);
    expect(result.graphContext?.imports.slice(0, 2)).toEqual(["package-000", "package-001"]);
    expect(result.graphContext?.imports.slice(-2)).toEqual(["package-098", "package-099"]);
    expect(result.graphContext?.imports).not.toContain("package-100");
    expect(result.graphContext?.symbols).toHaveLength(100);
    expect(result.graphContext?.symbols.slice(0, 2)).toEqual([
      { name: "symbol-000", kind: SymbolKind.Function, line: 1 },
      { name: "symbol-001", kind: SymbolKind.Function, line: 2 },
    ]);
    expect(result.graphContext?.symbols.slice(-2)).toEqual([
      { name: "symbol-098", kind: SymbolKind.Function, line: 99 },
      { name: "symbol-099", kind: SymbolKind.Function, line: 100 },
    ]);
    expect(result.graphContext?.symbols.some((symbol) => symbol.name === "symbol-100")).toBe(false);
  });

  it("does not split multi-byte UTF-8 characters in bounded get_file reads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-utf8-bound-"));
    await fs.writeFile(path.join(root, "unicode.txt"), "abc😀def", "utf8");
    const handlers = createCodegraphMcpHandlers({ root });

    const result = await handlers.get_file({ file: "unicode.txt", maxBytes: 5 });

    expect(result).toMatchObject({
      file: "unicode.txt",
      text: "abc",
      truncated: true,
    });
  });

  it("accepts get_file paths through a symlinked root realpath", async () => {
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-real-file-root-"));
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-link-parent-"));
    const linkedRoot = path.join(parent, "repo-link");
    try {
      await fs.symlink(realRoot, linkedRoot, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const realFile = path.join(realRoot, "auth.ts");
    await fs.writeFile(realFile, "export const ok = 1;\n", "utf8");
    const handlers = createCodegraphMcpHandlers({ root: linkedRoot });

    const result = await handlers.get_file({ file: realFile });

    expect(result.file).toBe("auth.ts");
    expect(result.text).toContain("export const ok");
    expect(result.truncated).toBe(false);
  });

  it("rechecks final realpath confinement before reading MCP files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-final-realpath-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-final-outside-"));
    const insideFile = path.join(root, "auth.ts");
    const outsideFile = path.join(outside, "auth.ts");
    await fs.writeFile(insideFile, "export const ok = 1;\n", "utf8");
    await fs.writeFile(outsideFile, "outside\n", "utf8");
    const originalRealpath = fs.realpath.bind(fs);
    const realpath = vi.spyOn(fs, "realpath");
    let insideFileRealpathCalls = 0;
    realpath.mockImplementation(async (candidate) => {
      const resolved = path.resolve(String(candidate));
      if (resolved === insideFile) {
        insideFileRealpathCalls += 1;
        return insideFileRealpathCalls === 1 ? insideFile : outsideFile;
      }
      return await originalRealpath(candidate);
    });

    try {
      const handlers = createCodegraphMcpHandlers({ root });
      await expect(handlers.get_file({ file: insideFile })).rejects.toThrow(/outside project root/);
    } finally {
      realpath.mockRestore();
    }
  });

  it("accepts navigation and graph query paths through a symlinked root realpath", async () => {
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-real-nav-root-"));
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-nav-link-parent-"));
    const linkedRoot = path.join(parent, "repo-link");
    try {
      await fs.symlink(realRoot, linkedRoot, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const authPath = path.join(realRoot, "auth.ts");
    const apiPath = path.join(realRoot, "api.ts");
    const apiSource = "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n";
    await fs.writeFile(authPath, "export function validateUser(id: number) { return id > 0; }\n", "utf8");
    await fs.writeFile(apiPath, apiSource, "utf8");
    const handlers = createCodegraphMcpHandlers({ root: linkedRoot });

    const goto = await handlers.goto({
      file: apiPath,
      line: 2,
      column: apiSource.split("\n")[1]!.indexOf("validateUser"),
    });
    const refs = await handlers.refs({ file: authPath, line: 1, column: "export function ".length });
    const deps = await handlers.deps({ file: apiPath });
    const rdeps = await handlers.rdeps({ file: authPath });
    const graphPath = await handlers.path({ from: apiPath, to: authPath });

    expect(goto.status).toBe("ok");
    if (goto.status === "ok") expect(normalizeSqlitePath(goto.definition.file)).toMatch(/auth\.ts$/);
    expect(refs.references.some((reference) => reference.file === "api.ts")).toBeTruthy();
    expect(deps.dependencies.some((dependency) => dependency.file === "auth.ts")).toBeTruthy();
    expect(rdeps.reverseDependencies.some((dependency) => dependency.file === "api.ts")).toBeTruthy();
    expect(graphPath.path).toEqual(["api.ts", "auth.ts"]);
  });

  it("rejects artifact output directories that escape through a directory link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-outside-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");
    const linkPath = path.join(root, "linked-out");
    try {
      await fs.symlink(outside, linkPath, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });

    await expect(handlers.artifact_build({ outDir: linkPath, sqlite: true, force: true })).rejects.toThrow(
      /outside project root/,
    );
  });

  it("reuses one session snapshot across search and refs follow-up calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-session-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fs.writeFile(
      path.join(root, "api.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n",
    );
    const counted = countingSession(createAgentSession({ root }));
    const handlers = createCodegraphMcpHandlers({ root, session: counted.session });

    const search = await handlers.search({ query: "validate user", limit: 5 });
    const first = search.results[0];
    expect(first?.handle).toBeTruthy();
    await handlers.refs({ handle: first!.handle });

    expect(counted.loads()).toBe(1);
  });

  it("uses skipped symbol graph snapshots for each base navigation and graph tool", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-skipped-symbol-graph-"));
    const authPath = path.join(root, "auth.ts");
    const apiPath = path.join(root, "api.ts");
    const apiSource = "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n";
    await fs.writeFile(authPath, "export function validateUser(id: number) { return id > 0; }\n", "utf8");
    await fs.writeFile(apiPath, apiSource, "utf8");

    const scenarios: Array<{
      name: string;
      run: (handlers: CodegraphMcpHandlers) => Promise<void>;
    }> = [
      {
        name: "goto",
        run: async (handlers) => {
          const result = await handlers.goto({
            file: apiPath,
            line: 2,
            column: apiSource.split("\n")[1]!.indexOf("validateUser"),
          });
          expect(result.status).toBe("ok");
        },
      },
      {
        name: "position refs",
        run: async (handlers) => {
          const result = await handlers.refs({ file: authPath, line: 1, column: "export function ".length });
          expect(result.references.some((reference) => reference.file === "api.ts")).toBe(true);
        },
      },
      {
        name: "deps",
        run: async (handlers) => {
          const result = await handlers.deps({ file: apiPath });
          expect(result.dependencies.some((dependency) => dependency.file === "auth.ts")).toBe(true);
        },
      },
      {
        name: "rdeps",
        run: async (handlers) => {
          const result = await handlers.rdeps({ file: authPath });
          expect(result.reverseDependencies.some((dependency) => dependency.file === "api.ts")).toBe(true);
        },
      },
      {
        name: "path",
        run: async (handlers) => {
          const result = await handlers.path({ from: apiPath, to: authPath });
          expect(result.path).toEqual(["api.ts", "auth.ts"]);
        },
      },
    ];

    for (const scenario of scenarios) {
      const counted = countingSession(createAgentSession({ root }));
      const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");
      const handlers = createCodegraphMcpHandlers({ root, session: counted.session });

      await scenario.run(handlers);

      expect(symbolGraphSpy, scenario.name).not.toHaveBeenCalled();
      expect(counted.loads(), scenario.name).toBe(1);
      symbolGraphSpy.mockRestore();
    }
  });

  it("keeps MCP sessions lazy unless warmup is requested", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-warmup-off-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const counted = countingSession(createAgentSession({ root }));

    createCodegraphMcpHandlers({ root, session: counted.session });

    expect(counted.loads()).toBe(0);
  });

  it("auto-refreshes added files before MCP search", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-auto-fresh-add-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const handlers = createCodegraphMcpHandlers({ root });

    const before = await handlers.search({ query: "lateSymbol", mode: "symbol", limit: 5 });
    await fs.writeFile(path.join(root, "late.ts"), "export function lateSymbol() { return 1; }\n", "utf8");
    const after = await handlers.search({ query: "lateSymbol", mode: "symbol", limit: 5 });

    expect(before.results.some((result) => result.label === "lateSymbol")).toBe(false);
    expect(after.results.some((result) => result.label === "lateSymbol")).toBe(true);
    expect(after.freshness).toEqual({ state: "refreshed", changedFiles: ["late.ts"] });
  });

  it("auto-refreshes edited files before MCP search and reports root-relative changed paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-auto-fresh-edit-"));
    const filePath = path.join(root, "auth.ts");
    await fs.writeFile(filePath, "export function oldSymbol() { return 1; }\n", "utf8");
    const handlers = createCodegraphMcpHandlers({ root });

    const before = await handlers.search({ query: "oldSymbol", mode: "symbol", limit: 5 });
    await fs.writeFile(filePath, "export function editedSymbol() { return 2; }\n", "utf8");
    const after = await handlers.search({ query: "editedSymbol", mode: "symbol", limit: 5 });

    expect(before.results.some((result) => result.label === "oldSymbol")).toBe(true);
    expect(after.results.some((result) => result.label === "editedSymbol")).toBe(true);
    expect(after.freshness).toEqual({ state: "refreshed", changedFiles: ["auth.ts"] });
  });

  it("auto-refreshes deleted files before MCP search", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-auto-fresh-delete-"));
    const filePath = path.join(root, "remove.ts");
    await fs.writeFile(filePath, "export function removedSymbol() { return 1; }\n", "utf8");
    const handlers = createCodegraphMcpHandlers({ root });

    const before = await handlers.search({ query: "removedSymbol", mode: "symbol", limit: 5 });
    await fs.unlink(filePath);
    const after = await handlers.search({ query: "removedSymbol", mode: "symbol", limit: 5 });

    expect(before.results.some((result) => result.label === "removedSymbol")).toBe(true);
    expect(after.results.some((result) => result.label === "removedSymbol")).toBe(false);
    expect(after.freshness).toEqual({ state: "refreshed", changedFiles: ["remove.ts"] });
  });

  it("reports bounded stale metadata when MCP auto-refresh thresholds are exceeded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-auto-fresh-burst-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function cachedSymbol() { return 1; }\n", "utf8");
    const session = createAgentSession({ root, freshness: { policy: "auto", maxAutoRefreshFiles: 1 } });
    const handlers = createCodegraphMcpHandlers({ root, session });

    await handlers.search({ query: "cachedSymbol", mode: "symbol", limit: 5 });
    await Promise.all(
      Array.from({ length: 30 }, async (_, index) => {
        const suffix = String(index).padStart(2, "0");
        await fs.writeFile(path.join(root, `late-${suffix}.ts`), `export const late${suffix} = ${index};\n`, "utf8");
      }),
    );
    const after = await handlers.search({ query: "cachedSymbol", mode: "symbol", limit: 5 });

    expect(after.results.some((result) => result.label === "cachedSymbol")).toBe(true);
    expect(after.freshness).toEqual({
      state: "stale",
      changedFiles: Array.from({ length: 25 }, (_, index) => `late-${String(index).padStart(2, "0")}.ts`),
      changedFileCount: 30,
      omittedChangedFileCount: 5,
      reason: "changed file count exceeds 1",
    });
  });

  it("reports stale metadata when MCP auto-refresh byte thresholds are exceeded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-auto-fresh-bytes-"));
    const filePath = path.join(root, "auth.ts");
    await fs.writeFile(filePath, "export function cachedSymbol() { return 1; }\n", "utf8");
    const session = createAgentSession({ root, freshness: { policy: "auto", maxAutoRefreshBytes: 5 } });
    const handlers = createCodegraphMcpHandlers({ root, session });

    await handlers.search({ query: "cachedSymbol", mode: "symbol", limit: 5 });
    await fs.writeFile(filePath, `export function largeSymbol() { return "${"x".repeat(64)}"; }\n`, "utf8");
    const after = await handlers.search({ query: "cachedSymbol", mode: "symbol", limit: 5 });

    expect(after.results.some((result) => result.label === "cachedSymbol")).toBe(true);
    expect(after.freshness).toEqual({
      state: "stale",
      changedFiles: ["auth.ts"],
      changedFileCount: 1,
      omittedChangedFileCount: 0,
      reason: "changed byte count exceeds 5",
    });
  });

  it("returns live file bytes and freshness metadata after MCP file edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-auto-fresh-read-"));
    const filePath = path.join(root, "auth.ts");
    await fs.writeFile(filePath, "export function readBefore() { return 'old'; }\n", "utf8");
    const handlers = createCodegraphMcpHandlers({ root });

    await handlers.search({ query: "readBefore", mode: "symbol", limit: 5 });
    await fs.writeFile(filePath, "export function readAfter() { return 'new bytes'; }\n", "utf8");
    const read = await handlers.get_file({ file: "auth.ts" });

    expect(read).toMatchObject({
      schemaVersion: 1,
      file: "auth.ts",
      text: "export function readAfter() { return 'new bytes'; }\n",
      content: "1\texport function readAfter() { return 'new bytes'; }\n2\t",
      lineFormat: "number-tab-line",
      truncated: false,
      freshness: { state: "fresh" },
    });
  });

  it("refresh_index clears stale SQLite artifact state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-refresh-sqlite-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });

    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true });
    await expect(handlers.query_sqlite({ query: "select path from files order by path" })).resolves.toEqual(
      expect.objectContaining({ truncated: false }),
    );
    await handlers.refresh_index({});

    await expect(handlers.query_sqlite({ query: "select path from files order by path" })).rejects.toThrow(
      /No SQLite artifact/,
    );
  });

  it("refresh_index preserves configured SQLite artifact paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-refresh-artifact-path-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const outDir = path.join(root, "out");
    const buildHandlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await buildHandlers.artifact_build({ outDir, sqlite: true });
    const readHandlers = createCodegraphMcpHandlers({ root, artifactPath: path.join(outDir, "codegraph.sqlite") });

    await expect(readHandlers.query_sqlite({ query: "select path from files order by path" })).resolves.toEqual(
      expect.objectContaining({ truncated: false }),
    );
    await readHandlers.refresh_index({});

    await expect(readHandlers.query_sqlite({ query: "select path from files order by path" })).resolves.toEqual(
      expect.objectContaining({ truncated: false }),
    );
  });

  it("rejects mixed prebuilt session and build options", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-session-options-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");

    expect(() =>
      createCodegraphMcpHandlers({
        root,
        session: createAgentSession({ root }),
        buildOptions: { cache: "memory" },
      }),
    ).toThrow(/prebuilt session with buildOptions/);
  });

  it("warms the base MCP session snapshot before HTTP serving", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-warmup-base-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const counted = countingSession(createAgentSession({ root }));
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      port: 0,
      session: counted.session,
      warmup: "base",
    });

    try {
      expect(counted.loads()).toBe(1);
      await counted.session.loadProject({ symbolGraph: "skip" });
      expect(counted.loads()).toBe(1);
    } finally {
      await httpServer.close();
    }
  });

  it("warms the detailed symbol graph before HTTP serving", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-warmup-symbols-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser() { return true; }\n", "utf8");
    const counted = countingSession(createAgentSession({ root }));
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      port: 0,
      session: counted.session,
      warmup: "symbols",
    });

    try {
      expect(counted.loads()).toBe(1);
      await counted.session.loadProject();
      expect(counted.loads()).toBe(1);
    } finally {
      await httpServer.close();
    }
  });

  it("refuses artifact_build when the MCP session snapshot is stale before creating output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-session-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    const counted = countingSession(createAgentSession({ root }));
    const handlers = createCodegraphMcpHandlers({ root, readOnly: false, session: counted.session });

    await handlers.search({ query: "validate user", limit: 5 });
    await fs.writeFile(path.join(root, "late.ts"), "export const late = 1;\n");
    const outDir = path.join(root, "out");

    await expect(handlers.artifact_build({ outDir, graphJson: true })).rejects.toThrow(
      /Cannot build artifacts from a stale MCP index[\s\S]*late\.ts/,
    );
    await expect(fs.readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(counted.loads()).toBe(1);
  });

  it("omits stale files from an in-repo artifact output directory", async () => {
    const { root, outDir } = await createArtifactOutputWithStaleFile({
      prefix: "cg-mcp-artifact-ignore-",
      outDirName: "out",
      staleFileName: "old.ts",
      staleContents: "export const stale = true;\n",
    });
    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });

    await handlers.artifact_build({ outDir, graphJson: true, force: true });

    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as {
      graph: { files: string[] };
    };
    expect(graph.graph.files.some((file) => file.includes("/out/") || file.endsWith("/out/old.ts"))).toBe(false);
  });

  it("omits stale output files when the MCP root is a directory link", async () => {
    const linkedFixture = await createLinkedTempRoot({
      realRootPrefix: "cg-mcp-real-root-",
      parentPrefix: "cg-mcp-root-link-parent-",
      linkName: "repo-link",
    });
    if (!linkedFixture) return;
    const { linkedRoot } = linkedFixture;

    const outDir = path.join(linkedRoot, "out");
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(linkedRoot, "auth.ts"), "export const ok = 1;\n");
    await fs.writeFile(path.join(outDir, "old.ts"), "export const stale = true;\n");
    const handlers = createCodegraphMcpHandlers({ root: linkedRoot, readOnly: false });

    await handlers.artifact_build({ outDir, graphJson: true, force: true });

    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as {
      graph: { files: string[] };
    };
    expect(graph.graph.files.some((file) => file.includes("/out/") || file.endsWith("/out/old.ts"))).toBe(false);
  });

  it("accepts artifact paths and output directories through a symlinked root realpath", async () => {
    const linkedFixture = await createLinkedTempRoot({
      realRootPrefix: "cg-mcp-real-artifact-root-",
      parentPrefix: "cg-mcp-artifact-link-parent-",
      linkName: "repo-link",
    });
    if (!linkedFixture) return;
    const { realRoot, linkedRoot } = linkedFixture;

    await fs.writeFile(path.join(linkedRoot, "auth.ts"), "export const ok = 1;\n");
    const realOutDir = path.join(realRoot, "out");
    await fs.mkdir(realOutDir);
    await fs.writeFile(path.join(realOutDir, "old.ts"), "export const stale = true;\n");
    const buildHandlers = createCodegraphMcpHandlers({ root: linkedRoot, readOnly: false });

    await buildHandlers.artifact_build({ outDir: realOutDir, sqlite: true, graphJson: true, force: true });

    const graph = JSON.parse(await fs.readFile(path.join(realOutDir, "graph.json"), "utf8")) as {
      graph: { files: string[] };
    };
    expect(graph.graph.files.some((file) => file.includes("/out/") || file.endsWith("/out/old.ts"))).toBe(false);

    const readHandlers = createCodegraphMcpHandlers({
      root: linkedRoot,
      artifactPath: path.join(realOutDir, "codegraph.sqlite"),
    });
    const result = await readHandlers.query_sqlite({ query: "select path from files order by path" });
    const paths = result.rows.map((row) => normalizeSqlitePath(row[0]));

    expect(paths.some((file) => file.endsWith("auth.ts"))).toBeTruthy();
    expect(paths.some((file) => file.includes("/out/") || file.endsWith("/out/old.ts"))).toBe(false);
  });

  it("query_sqlite treats corrupted SQLite freshness metadata as a missing baseline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-corrupt-metadata-"));
    const outDir = path.join(root, "out");
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
    const buildHandlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await buildHandlers.artifact_build({ outDir, sqlite: true });

    const db = new DatabaseSync(path.join(outDir, "codegraph.sqlite"));
    try {
      const updated = db
        .prepare("UPDATE graph_metadata SET value = ? WHERE key = ?;")
        .run("this-is-not-json", SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY);
      if (Number(updated.changes) === 0) {
        db.prepare("INSERT OR REPLACE INTO graph_metadata (key, value) VALUES (?, ?);").run(
          SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY,
          "this-is-not-json",
        );
      }
    } finally {
      db.close();
    }

    const readHandlers = createCodegraphMcpHandlers({ root, artifactPath: outDir });

    await expect(readHandlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" })).rejects.toThrow(
      /no freshness baseline/i,
    );

    let caught: unknown;
    try {
      await readHandlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toMatch(/JSON|Unexpected token/i);
  });

  it("reports fresh when a prebuilt MCP session has no freshness check", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-session-no-freshness-check-"));
    await fs.writeFile(path.join(root, "one.ts"), "export function lonelySymbol() { return 1; }\n");
    const backingSession = createAgentSession({ root });
    const session: AgentSession = {
      loadProject: backingSession.loadProject,
      invalidate: backingSession.invalidate,
    };
    const handlers = createCodegraphMcpHandlers({ root, session });

    const result = await handlers.search({ query: "lonelySymbol", mode: "symbol", limit: 5 });

    expect(result.freshness).toEqual({ state: "fresh" });
  });
});

function normalizeSqlitePath(value: unknown): string {
  return typeof value === "string" ? value.replace(/\\/g, "/") : "";
}

describe("MCP tool registry dispatch", () => {
  it("routes every registered tool without advertising legacy aliases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-registry-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function ok(): number { return 1; }\n", "utf8");
    runGit(root, ["init"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);
    const handlers = createCodegraphMcpHandlers({ root });
    const handlerSpies = {
      search: vi.spyOn(handlers, "search"),
      workspace_symbols: vi.spyOn(handlers, "workspace_symbols"),
      rename_preview: vi.spyOn(handlers, "rename_preview"),
      refactor_plan: vi.spyOn(handlers, "refactor_plan"),
      calls: vi.spyOn(handlers, "calls"),
      type_hierarchy: vi.spyOn(handlers, "type_hierarchy"),
      implementations: vi.spyOn(handlers, "implementations"),
      explore: vi.spyOn(handlers, "explore"),
      orient: vi.spyOn(handlers, "orient"),
      packet_get: vi.spyOn(handlers, "packet_get"),
      get_file: vi.spyOn(handlers, "get_file"),
      get_symbol: vi.spyOn(handlers, "get_symbol"),
      goto: vi.spyOn(handlers, "goto"),
      refs: vi.spyOn(handlers, "refs"),
      file_deps: vi.spyOn(handlers, "file_deps"),
      path: vi.spyOn(handlers, "path"),
      impact: vi.spyOn(handlers, "impact"),
      review: vi.spyOn(handlers, "review"),
      query_sqlite: vi.spyOn(handlers, "query_sqlite"),
      refresh_index: vi.spyOn(handlers, "refresh_index"),
      artifact_build: vi.spyOn(handlers, "artifact_build"),
    };
    const advertisedTools = listCodegraphMcpTools();
    expect(advertisedTools.map((tool) => tool.name)).toEqual(
      MCP_TOOL_REGISTRY.filter((tool) => tool.advertised !== false).map((tool) => tool.name),
    );
    expect(advertisedTools.some((tool) => "dispatch" in tool)).toBe(false);
    const handle = "auth.ts::ok";
    const toolInputs: Record<string, Record<string, unknown>> = {
      search: { query: "ok" },
      workspace_symbols: { query: "ok" },
      rename_preview: { handle, newName: "renamed" },
      refactor_plan: { handle },
      calls: { handle, direction: "callers" },
      type_hierarchy: { handle, direction: "supertypes" },
      implementations: { handle },
      explore: { query: "ok" },
      orient: {},
      packet_get: { target: "auth.ts" },
      get_file: { file: "auth.ts" },
      get_symbol: { handle },
      goto: { handle },
      refs: { handle },
      file_deps: { file: "auth.ts", direction: "deps" },
      path: { from: "auth.ts", to: "auth.ts" },
      impact: { base: "HEAD", head: "HEAD" },
      review: { base: "HEAD", head: "HEAD" },
      query_sqlite: { query: "SELECT 1" },
      refresh_index: {},
      artifact_build: {},
      callers: { handle },
      callees: { handle },
      supertypes: { handle },
      subtypes: { handle },
      deps: { file: "auth.ts" },
      rdeps: { file: "auth.ts" },
    };

    for (const tool of MCP_TOOL_REGISTRY) {
      const input = toolInputs[tool.name];
      expect(input, "missing valid input for " + tool.name).toBeDefined();
      try {
        await callMcpTool(handlers, tool.name, input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message, tool.name).not.toMatch(/Unknown MCP tool|Invalid parameters for/i);
      }
    }

    for (const [name, spy] of Object.entries(handlerSpies)) {
      expect(spy, name).toHaveBeenCalled();
    }
    expect(handlerSpies.calls).toHaveBeenCalledWith(expect.objectContaining({ direction: "callers" }), undefined);
    expect(handlerSpies.calls).toHaveBeenCalledWith(expect.objectContaining({ direction: "callees" }), undefined);
    expect(handlerSpies.type_hierarchy).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "supertypes" }),
      undefined,
    );
    expect(handlerSpies.type_hierarchy).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "subtypes" }),
      undefined,
    );
    expect(handlerSpies.file_deps).toHaveBeenCalledWith(expect.objectContaining({ direction: "deps" }), undefined);
    expect(handlerSpies.file_deps).toHaveBeenCalledWith(expect.objectContaining({ direction: "rdeps" }), undefined);
  });
});

describe("MCP refresh coalescing", () => {
  it("serializes every queued request's requested warmup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-refresh-coalesce-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const backingSession = createAgentSession({ root });
    const firstWarmupReached = Promise.withResolvers<void>();
    const releaseFirstWarmup = Promise.withResolvers<void>();
    const secondWarmupReached = Promise.withResolvers<void>();
    const releaseSecondWarmup = Promise.withResolvers<void>();
    const loadModes: Array<"skip" | "full"> = [];
    let activeLoads = 0;
    let maxActiveLoads = 0;
    let fullWarmups = 0;
    const session: AgentSession = {
      ...backingSession,
      loadProject: async (options) => {
        const mode = options?.symbolGraph === "skip" ? "skip" : "full";
        loadModes.push(mode);
        activeLoads += 1;
        maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
        try {
          if (mode === "skip") {
            firstWarmupReached.resolve();
            await releaseFirstWarmup.promise;
          } else {
            fullWarmups += 1;
            if (fullWarmups === 1) {
              secondWarmupReached.resolve();
              await releaseSecondWarmup.promise;
            }
          }
          return await backingSession.loadProject(options);
        } finally {
          activeLoads -= 1;
        }
      },
    };
    const handlers = createCodegraphMcpHandlers({ root, session });

    const first = handlers.refresh_index({ warmup: "base" });
    await firstWarmupReached.promise;
    const second = handlers.refresh_index({ warmup: "symbols" });
    const third = handlers.refresh_index({ warmup: "symbols" });
    releaseFirstWarmup.resolve();

    try {
      await secondWarmupReached.promise;
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
      expect(loadModes).toEqual(["skip", "full"]);
      expect(maxActiveLoads).toBe(1);

      releaseSecondWarmup.resolve();
      await expect(first).resolves.toEqual({ refreshed: true, warmup: "base" });
      await expect(second).resolves.toEqual({ refreshed: true, warmup: "symbols" });
      await expect(third).resolves.toEqual({ refreshed: true, warmup: "symbols" });
      expect(loadModes).toEqual(["skip", "full", "full"]);
      expect(maxActiveLoads).toBe(1);
    } finally {
      releaseFirstWarmup.resolve();
      releaseSecondWarmup.resolve();
    }
  });

  it("bounds a request invalidated by repeated refreshes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-refresh-retry-bound-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const token = 1;\n", "utf8");
    const backingSession = createAgentSession({ root });
    let refreshes = 0;
    const session: AgentSession = {
      ...backingSession,
      loadProject: async (options) => {
        refreshes += 1;
        await handlers.refresh_index({ warmup: "off" });
        return await backingSession.loadProject(options);
      },
    };
    const handlers = createCodegraphMcpHandlers({ root, session });

    await expect(handlers.goto({ file: "auth.ts", line: 1, column: 14 })).rejects.toThrow(
      /Workspace refresh changed repeatedly while serving the request/i,
    );
    expect(refreshes).toBe(3);
  });
});

describe("MCP session teardown regressions (S2)", () => {
  it("closes sidecar query index handle and runs session invalidation hooks on server close", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-s2-teardown-"));
    await fs.writeFile(
      path.join(root, "auth.ts"),
      "export function validateUser(token: string) { return !!token; }\n",
      "utf8",
    );
    const session = createAgentSession({ root });
    let invalidationHookRan = false;
    registerSessionInvalidationHook(session, () => {
      invalidationHookRan = true;
    });

    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
      session,
    });

    try {
      const initialize = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-s2-test", version: "1.0.0" },
        },
      });
      const sessionId = initialize.response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      const searchCall = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search", arguments: { query: "validateUser", mode: "hybrid" } },
        },
        sessionId ?? undefined,
      );
      expect(searchCall.response.status).toBe(200);

      const snapshot = await session.loadProject();
      const handle = await ensureSessionQueryIndex(session, snapshot);
      expect(handle.store?.isClosed).toBe(false);
      expect(invalidationHookRan).toBe(false);

      await httpServer.close();

      expect(invalidationHookRan).toBe(true);
      expect(handle.store?.isClosed).toBe(true);
    } finally {
      await httpServer.close();
    }
  });

  it("drains active tool calls before invalidating the shared session during shutdown", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-shutdown-drain-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const backingSession = createAgentSession({ root });
    const loadStarted = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    const session: AgentSession = {
      ...backingSession,
      loadProject: async (options) => {
        loadStarted.resolve();
        await releaseLoad.promise;
        return await backingSession.loadProject(options);
      },
    };
    const invalidationSpy = vi.spyOn(session, "invalidate");
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
      session,
    });

    try {
      const initialize = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-shutdown-drain-test", version: "1.0.0" },
        },
      });
      const sessionId = initialize.response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      if (!sessionId) throw new Error("MCP session did not initialize.");
      const endpoint = new URL(httpServer.url);
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search", arguments: { query: "ok", mode: "symbol" } },
      });
      const request = httpRequest({
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.pathname,
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
      });
      request.on("error", () => {});
      request.end(body);
      await loadStarted.promise;

      const requestClosed = new Promise<void>((resolve) => request.once("close", resolve));
      request.destroy();
      await requestClosed;

      const closing = httpServer.close();
      await Promise.resolve();
      expect(invalidationSpy).not.toHaveBeenCalled();

      releaseLoad.resolve();
      await expect(closing).resolves.toBeUndefined();
      expect(invalidationSpy).toHaveBeenCalledTimes(1);
    } finally {
      releaseLoad.resolve();
      invalidationSpy.mockRestore();
      await httpServer.close();
    }
  });
  it("closes legacy protocol transports when session invalidation fails during server shutdown", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-invalidation-close-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const session = createAgentSession({ root });
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
      session,
    });
    const transportCloseSpy = vi.spyOn(NodeStreamableHTTPServerTransport.prototype, "close");
    const invalidationSpy = vi.spyOn(session, "invalidate").mockImplementation(() => {
      throw new Error("session invalidation failed");
    });

    try {
      const initialize = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-invalidation-close-test", version: "1.0.0" },
        },
      });
      expect(initialize.response.status).toBe(200);
      transportCloseSpy.mockClear();

      await expect(httpServer.close()).rejects.toThrow("session invalidation failed");
      expect(transportCloseSpy).toHaveBeenCalled();
    } finally {
      invalidationSpy.mockRestore();
      transportCloseSpy.mockRestore();
      await httpServer.close().catch(() => {});
    }
  });
});

describe("MCP cancellation accounting", () => {
  it("keeps a tool-call slot reserved until a cancelled operation settles", async () => {
    const controller = new AbortController();
    const operation = Promise.withResolvers<string>();
    let released = 0;
    const pending = awaitMcpToolOperation(controller.signal, operation.promise, () => {
      released += 1;
    });

    controller.abort();
    await expect(pending).rejects.toThrow("MCP tool call was cancelled.");
    expect(released).toBe(0);

    operation.resolve("finished");
    await vi.waitFor(() => {
      expect(released).toBe(1);
    });
  });
});

describe("MCP transport isolation regressions (S8)", () => {
  it("preserves session and completes concurrent calls when one response connection is forcefully closed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-s8-transport-"));
    await fs.writeFile(
      path.join(root, "auth.ts"),
      "export function validateUser(token: string) { return !!token; }\nexport function secondarySymbol() { return true; }\n",
      "utf8",
    );
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const initialize = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-s8-test", version: "1.0.0" },
        },
      });
      const sessionId = initialize.response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      if (!sessionId) throw new Error("Missing sessionId");

      const endpoint = new URL(httpServer.url);
      const call1Payload = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "workspace_symbols", arguments: { query: "validateUser" } },
      });

      const call1Closed = Promise.withResolvers<void>();
      const req1 = httpRequest({
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.pathname,
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(call1Payload)),
          "mcp-session-id": sessionId,
        },
      });
      req1.on("error", () => {
        call1Closed.resolve();
      });
      req1.on("close", () => {
        call1Closed.resolve();
      });
      req1.write(call1Payload);
      req1.destroy(new Error("Forced client disconnect"));

      const call2Promise = postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "workspace_symbols", arguments: { query: "secondarySymbol" } },
        },
        sessionId,
      );

      await call1Closed.promise;
      const call2 = await call2Promise;
      expect(call2.response.status).toBe(200);
      expect(readToolJsonResult(call2.payload).symbols).toEqual([expect.objectContaining({ name: "secondarySymbol" })]);

      const call3 = await postMcpJson(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "workspace_symbols", arguments: { query: "validateUser" } },
        },
        sessionId,
      );
      expect(call3.response.status).toBe(200);
      expect(readToolJsonResult(call3.payload).symbols).toEqual([expect.objectContaining({ name: "validateUser" })]);
    } finally {
      await httpServer.close();
    }
  });
});

describe("MCP legacy session capacity and error-handling regressions", () => {
  it("releases the initialization capacity reservation when legacy Accept header validation rejects the request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-capacity-accept-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      port: 0,
      httpSessionIdleMs: 0,
      httpSessionMaxCount: 1,
    });

    const initializeRequest = {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "codegraph-capacity-test", version: "1.0.0" },
      },
    };

    try {
      // No override supplies an Accept header, so postRawHttpJson's default
      // ("application/json" without "text/event-stream") trips the legacy transport's
      // own 406 validation before any session is created.
      const rejected = await postRawHttpJson(httpServer.url, { ...initializeRequest, id: 1 }, {});
      expect(rejected.status).toBe(406);

      // With httpSessionMaxCount 1, a leaked capacity reservation from the rejected
      // attempt would make this second initialize 503 instead of succeeding.
      const accepted = await postMcpJson(httpServer.url, { ...initializeRequest, id: 2 });
      expect(accepted.response.status).toBe(200);
      expect(accepted.response.headers.get("mcp-session-id")).toBeTruthy();
    } finally {
      await httpServer.close();
    }
  });

  it("keeps a healthy session usable after a request-scoped SDK validation error on a follow-up request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-session-request-error-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function ok(): number { return 1; }\n", "utf8");
    const httpServer = await startCodegraphMcpHttpServer({ root, port: 0 });

    try {
      const initialize = await postMcpJson(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codegraph-session-error-test", version: "1.0.0" },
        },
      });
      const sessionId = initialize.response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      if (!sessionId) throw new Error("Missing sessionId");

      // A follow-up request against the same session with a bad Accept header trips
      // the transport's own request-scoped validation (406) through onerror, without
      // throwing and without the transport ever closing.
      const badAccept = await postRawHttpJson(
        httpServer.url,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "mcp-session-id": sessionId },
      );
      expect(badAccept.status).toBe(406);

      // The session must still be usable: a prior bug deleted it from the store on
      // every onerror, which would turn this into a 400 "Invalid or missing session ID".
      const followUp = await postMcpJson(
        httpServer.url,
        { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
        sessionId,
      );
      expect(followUp.response.status).toBe(200);
    } finally {
      await httpServer.close();
    }
  });
});
