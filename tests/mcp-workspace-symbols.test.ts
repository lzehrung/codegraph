import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentSession, type AgentSession } from "../src/agent/session.js";
import { SymbolKind } from "../src/indexer/types.js";
import {
  createCodegraphMcpHandlers,
  listCodegraphMcpTools,
  startCodegraphMcpHttpServer,
} from "../src/mcp/server.js";
import { isPlainRecord } from "../src/util/guards.js";
import { countingSession } from "./helpers/agent.js";

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-mcp-symbols-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "service.ts"),
    "export class Service {}\nexport function buildService() { return new Service(); }\n",
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function postMcpRequest(
  url: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (sessionId !== undefined) headers["mcp-session-id"] = sessionId;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const payload: unknown = await response.json();
  if (!isPlainRecord(payload)) throw new Error("MCP response was not a JSON object");
  return { response, payload };
}

describe("workspace_symbols MCP tool", () => {
  it("lists a flat bounded schema distinct from hybrid search", () => {
    const tool = listCodegraphMcpTools().find((entry) => entry.name === "workspace_symbols");

    expect(tool).toBeDefined();
    expect(tool?.description).toContain("symbol-identity lookup");
    expect(tool?.description).toContain("hybrid search");
    const schema: unknown = tool?.inputSchema;
    expect(isPlainRecord(schema)).toBe(true);
    if (!isPlainRecord(schema)) throw new Error("workspace_symbols schema was not an object");
    expect(schema.required).toEqual(["query"]);
    expect(isPlainRecord(schema.properties)).toBe(true);
    if (!isPlainRecord(schema.properties)) throw new Error("workspace_symbols properties were not flat");
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["exportedOnly", "fileGlob", "includeImports", "kinds", "limit", "query"].sort(),
    );
    expect(isPlainRecord(schema.properties.limit)).toBe(true);
    if (!isPlainRecord(schema.properties.limit)) throw new Error("workspace_symbols limit schema was invalid");
    expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 0, maximum: 500, default: 50 });
  });

  it("uses the existing freshness gate and enforces the server limit", async () => {
    const baseSession = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
    const snapshot = await baseSession.loadProject({ symbolGraph: "skip" });
    const checkFreshness = vi.fn(async () => ({ state: "refreshed" as const, changedFiles: ["src/service.ts"] }));
    const session: AgentSession = {
      root,
      loadProject: async () => snapshot,
      checkFreshness,
      invalidate: () => undefined,
    };
    const handlers = createCodegraphMcpHandlers({ root, session });

    const response = await handlers.workspace_symbols({
      query: "Service",
      kinds: [SymbolKind.Class],
      exportedOnly: true,
      fileGlob: "src/service.ts",
      limit: 999,
    });

    expect(checkFreshness).toHaveBeenCalledTimes(1);
    expect(response.freshness).toEqual({ state: "refreshed", changedFiles: ["src/service.ts"] });
    expect(response.limits.symbols).toBe(500);
    expect(response.symbols).toEqual([
      expect.objectContaining({ name: "Service", kind: "class", location: { file: "src/service.ts", range: expect.any(Object) } }),
    ]);
  });

  it("registers and dispatches the tool through the MCP protocol", async () => {
    const httpServer = await startCodegraphMcpHttpServer({
      root,
      port: 0,
      buildOptions: { cache: "off" },
    });
    try {
      const initialized = await postMcpRequest(httpServer.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "workspace-symbol-test", version: "1.0.0" },
        },
      });
      const sessionId = initialized.response.headers.get("mcp-session-id");
      if (sessionId === null) throw new Error("MCP initialize response omitted its session id");
      const called = await postMcpRequest(
        httpServer.url,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "workspace_symbols", arguments: { query: "Service", limit: 1 } },
        },
        sessionId,
      );
      if (!isPlainRecord(called.payload.result)) throw new Error("MCP tool result was not an object");
      const content = called.payload.result.content;
      if (!Array.isArray(content) || !isPlainRecord(content[0]) || typeof content[0].text !== "string") {
        throw new Error("MCP tool result did not contain JSON text");
      }
      const response: unknown = JSON.parse(content[0].text);

      expect(isPlainRecord(response)).toBe(true);
      if (!isPlainRecord(response)) throw new Error("workspace_symbols result text was not an object");
      expect(response.symbols).toEqual([
        expect.objectContaining({ name: "Service", location: { file: "src/service.ts", range: expect.any(Object) } }),
      ]);
    } finally {
      await httpServer.close();
    }
  });

  it("reuses one warm session across repeated handler calls", async () => {
    const baseSession = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
    const counted = countingSession(baseSession);
    const handlers = createCodegraphMcpHandlers({ root, session: counted.session });

    const first = await handlers.workspace_symbols({ query: "Service" });
    const second = await handlers.workspace_symbols({ query: "buildService" });

    expect(first.symbols[0]?.name).toBe("Service");
    expect(second.symbols[0]?.name).toBe("buildService");
    expect(counted.loads()).toBe(1);
  });
});
