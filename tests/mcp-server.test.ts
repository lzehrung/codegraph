import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "../src/agent/session.js";
import {
  DEFAULT_FILE_VIEW_BYTES,
  DEFAULT_FILE_VIEW_LINES,
  MAX_FILE_VIEW_BYTES,
  MAX_FILE_VIEW_LINES,
} from "../src/agent/fileView.js";
import {
  createCodegraphMcpHandlers,
  listCodegraphMcpTools,
  startCodegraphMcpHttpServer,
  type CodegraphMcpHandlers,
} from "../src/mcp/server.js";
import { SymbolKind, type ModuleIndex, type ProjectIndex } from "../src/indexer/types.js";
import type { Graph } from "../src/types.js";
import * as symbolGraphBuild from "../src/graphs/symbol-graph-detailed.js";
import { SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY } from "../src/sqlite.js";
import { countingSession } from "./helpers/agent.js";
import { createArtifactOutputWithStaleFile, createLinkedTempRoot, isSymlinkUnavailable } from "./helpers/filesystem.js";

type JsonRpcObject = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

function readObject(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

async function postMcpJson(
  url: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ response: Response; payload: JsonRpcObject }> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
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
  it("serves real MCP tool listing over a specified local HTTP port", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-http-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
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
      const toolNames = (tools as Array<{ name?: unknown }>).map((tool) => tool.name);
      expect(toolNames).toContain("search");
      expect(toolNames).toContain("orient");
      expect(toolNames).toContain("packet_get");
      expect(toolNames).toContain("query_sqlite");
      expect(toolNames).toContain("refresh_index");
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
        expect(serializedError).toMatch(/too_big|maximum|max|less than or equal|at most/i);
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

  it("accepts loopback host headers when HTTP MCP binds to all IPv4 interfaces", async () => {
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
        },
      );
      const localhostPayload = readObject(localhostResponse.payload);
      expect(localhostResponse.status).toBe(200);
      expect(localhostPayload.result).toBeDefined();

      const rejected = await postRawHttpJson(
        loopbackUrl,
        { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
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

  it("rejects oversized HTTP MCP request bodies before parsing", async () => {
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
      const payload = readObject((await response.json()) as unknown);
      const error = readObject(payload.error);

      expect(response.status).toBe(413);
      expect(error.message).toBe("MCP request body is too large");
    } finally {
      await httpServer.close();
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
      maximum: MAX_FILE_VIEW_LINES,
      default: DEFAULT_FILE_VIEW_LINES,
    });
    expect(readObject(getFileProperties.maxBytes)).toEqual({
      type: "integer",
      minimum: 1,
      maximum: MAX_FILE_VIEW_BYTES,
      default: DEFAULT_FILE_VIEW_BYTES,
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

  it("advertises refs with an OpenAI-compatible flat object schema", () => {
    const refsTool = listCodegraphMcpTools().find((tool) => tool.name === "refs");
    const refsSchema = readObject(refsTool!.inputSchema);
    const refsProperties = readObject(refsSchema.properties);

    expect(refsSchema.type).toBe("object");
    expect(refsSchema.required).toBeUndefined();
    expect(refsSchema.oneOf).toBeUndefined();
    expect(refsSchema.anyOf).toBeUndefined();
    expect(refsSchema.allOf).toBeUndefined();
    expect(refsSchema.not).toBeUndefined();
    expect(refsProperties.handle).toEqual(expect.objectContaining({ type: "string" }));
    expect(refsProperties.file).toEqual(expect.objectContaining({ type: "string" }));
    expect(refsProperties.line).toEqual(expect.objectContaining({ type: "integer", minimum: 1 }));
    expect(refsProperties.column).toEqual(expect.objectContaining({ type: "integer", minimum: 0 }));
  });

  it("keeps refs handle-or-position validation in the handler", async () => {
    const handlers = createCodegraphMcpHandlers({ root: process.cwd() });

    await expect(handlers.refs({ file: "src/index.ts", line: 1 })).rejects.toThrow(
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
      modules: new Map([[targetFile, moduleIndex]]),
      byFile: new Map([[targetFile, moduleIndex]]),
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
