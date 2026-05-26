import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../src/agent/session.js";
import { createCodegraphMcpHandlers, listCodegraphMcpTools, startCodegraphMcpHttpServer } from "../src/mcp/server.js";
import { countingSession } from "./helpers/agent.js";
import { isSymlinkUnavailable } from "./helpers/filesystem.js";

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
    const fileHandle = orient.handles.find((handle) => handle.kind === "file");
    expect(fileHandle?.handle).toBeTruthy();

    const packet = await handlers.packet_get({ handle: fileHandle!.handle });

    expect(packet.schemaVersion).toBe(1);
    expect(packet.kind).toBe("file");
    expect(JSON.stringify(packet.packet)).toContain("src/run.ts");
  });

  it("does not advertise MCP root overrides for orientation packet tools", () => {
    const orientTool = listCodegraphMcpTools().find((tool) => tool.name === "orient");
    const packetTool = listCodegraphMcpTools().find((tool) => tool.name === "packet_get");
    expect(orientTool).toBeTruthy();
    expect(packetTool).toBeTruthy();

    const orientSchema = readObject(orientTool!.inputSchema);
    const packetSchema = readObject(packetTool!.inputSchema);
    const orientProperties = readObject(orientSchema.properties);
    const packetProperties = readObject(packetSchema.properties);

    expect(orientProperties.root).toBeUndefined();
    expect(packetProperties.root).toBeUndefined();
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

  it("advertises refs as either handle or file position input", () => {
    const refsTool = listCodegraphMcpTools().find((tool) => tool.name === "refs");
    expect(refsTool?.inputSchema).toEqual(
      expect.objectContaining({
        oneOf: [
          expect.objectContaining({
            required: ["handle"],
            not: expect.objectContaining({
              anyOf: [{ required: ["file"] }, { required: ["line"] }, { required: ["column"] }],
            }),
          }),
          expect.objectContaining({
            required: ["file", "line", "column"],
            not: { required: ["handle"] },
          }),
        ],
      }),
    );
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

  it("disables artifact builds by default and in explicit read-only mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-readonly-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");

    const defaultHandlers = createCodegraphMcpHandlers({ root });
    await expect(defaultHandlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true })).rejects.toThrow(
      /read-only/i,
    );

    const readOnlyHandlers = createCodegraphMcpHandlers({ root, readOnly: true });
    await expect(readOnlyHandlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true })).rejects.toThrow(
      /read-only/i,
    );
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

    expect(result).toEqual({
      file: "large.txt",
      text: "abcde",
      truncated: true,
    });
  });

  it("does not split multi-byte UTF-8 characters in bounded get_file reads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-utf8-bound-"));
    await fs.writeFile(path.join(root, "unicode.txt"), "abc😀def", "utf8");
    const handlers = createCodegraphMcpHandlers({ root });

    const result = await handlers.get_file({ file: "unicode.txt", maxBytes: 5 });

    expect(result).toEqual({
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

  it("uses the MCP session snapshot when artifact_build is enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-session-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    const counted = countingSession(createAgentSession({ root }));
    const handlers = createCodegraphMcpHandlers({ root, readOnly: false, session: counted.session });

    await handlers.search({ query: "validate user", limit: 5 });
    await fs.writeFile(path.join(root, "late.ts"), "export const late = 1;\n");
    await handlers.artifact_build({ outDir: path.join(root, "out"), graphJson: true });

    const graph = JSON.parse(await fs.readFile(path.join(root, "out", "graph.json"), "utf8")) as {
      graph: { files: string[] };
    };
    expect(graph.graph.files.some((file) => file.endsWith("late.ts"))).toBe(false);
    expect(counted.loads()).toBe(1);
  });

  it("omits stale files from an in-repo artifact output directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-ignore-"));
    const outDir = path.join(root, "out");
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");
    await fs.writeFile(path.join(outDir, "old.ts"), "export const stale = true;\n");
    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });

    await handlers.artifact_build({ outDir, graphJson: true, force: true });

    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as {
      graph: { files: string[] };
    };
    expect(graph.graph.files.some((file) => file.includes("/out/") || file.endsWith("/out/old.ts"))).toBe(false);
  });

  it("omits stale output files when the MCP root is a directory link", async () => {
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-real-root-"));
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-root-link-parent-"));
    const linkedRoot = path.join(parent, "repo-link");
    try {
      await fs.symlink(realRoot, linkedRoot, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

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
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-real-artifact-root-"));
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-link-parent-"));
    const linkedRoot = path.join(parent, "repo-link");
    try {
      await fs.symlink(realRoot, linkedRoot, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

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
});

function normalizeSqlitePath(value: unknown): string {
  return typeof value === "string" ? value.replace(/\\/g, "/") : "";
}
