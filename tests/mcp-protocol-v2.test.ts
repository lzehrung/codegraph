import fsp from "node:fs/promises";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { getCodegraphVersion } from "../src/cli/packageInfo.js";
import { startCodegraphMcpHttpServer, type CodegraphMcpHttpServer } from "../src/mcp/server.js";
import { mkTmpDir } from "./helpers/filesystem.js";

const OPERATION_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const SEARCH_SYMBOL = "locateModernTarget";

type TextContent = {
  text: string;
};

function isTextContent(value: unknown): value is TextContent {
  if (typeof value !== "object" || value === null || !("text" in value)) return false;
  return typeof value.text === "string";
}

// These black-box process and network boundaries need a real deadline; fake timers cannot drive them.
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const expired = new Promise<never>((_, reject) => {
    timeout.addEventListener("abort", () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), { once: true });
  });
  return await Promise.race([operation, expired]);
}

async function createFixture(prefix: string): Promise<string> {
  const root = await mkTmpDir(prefix);
  try {
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(
      path.join(root, "src", "modern-target.ts"),
      `export function ${SEARCH_SYMBOL}() { return "modern MCP"; }\n`,
      "utf8",
    );
    return root;
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function assertModernConversation(client: Client): Promise<void> {
  expect(client.getProtocolEra()).toBe("modern");
  expect(client.getServerVersion()).toMatchObject({ name: "codegraph", version: getCodegraphVersion() });

  const tools = await withTimeout(client.listTools(), OPERATION_TIMEOUT_MS, "MCP tools/list");
  const toolNames = tools.tools.map((tool) => tool.name);
  expect(toolNames).toEqual(expect.arrayContaining(["search", "orient", "packet_get"]));

  const result = await withTimeout(
    client.callTool({
      name: "search",
      arguments: { query: SEARCH_SYMBOL, mode: "text", limit: 5 },
    }),
    OPERATION_TIMEOUT_MS,
    "MCP search tool call",
  );
  expect(result.isError).not.toBe(true);
  const text = result.content
    .filter(isTextContent)
    .map((entry) => entry.text)
    .join("\n");
  expect(text).toContain(SEARCH_SYMBOL);
}

describe("MCP protocol v2 interoperability", () => {
  it("negotiates the modern era over Streamable HTTP", async () => {
    const root = await createFixture("codegraph-mcp-v2-http-");
    let server: CodegraphMcpHttpServer | undefined;
    const client = new Client(
      { name: "codegraph-mcp-protocol-v2-http-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    let cleanupError: Error | undefined;
    try {
      server = await startCodegraphMcpHttpServer({
        root,
        host: "127.0.0.1",
        port: 0,
        buildOptions: { native: "off", cache: "off" },
      });
      const transport = new StreamableHTTPClientTransport(new URL(server.url));
      await withTimeout(client.connect(transport), OPERATION_TIMEOUT_MS, "MCP HTTP client connect");
      await assertModernConversation(client);
    } finally {
      const cleanupPromises: Promise<void>[] = [
        withTimeout(client.close(), CLEANUP_TIMEOUT_MS, "MCP HTTP client cleanup"),
      ];
      if (server) cleanupPromises.push(withTimeout(server.close(), CLEANUP_TIMEOUT_MS, "MCP HTTP server cleanup"));
      const cleanupResults = await Promise.allSettled(cleanupPromises);
      await withTimeout(fsp.rm(root, { recursive: true, force: true }), CLEANUP_TIMEOUT_MS, "HTTP temp root cleanup");
      const cleanupFailure = cleanupResults.find((result) => result.status === "rejected");
      if (cleanupFailure?.status === "rejected") {
        cleanupError =
          cleanupFailure.reason instanceof Error ? cleanupFailure.reason : new Error(String(cleanupFailure.reason));
      }
    }
    if (cleanupError) throw cleanupError;
  });

  it("negotiates the modern era over stdio", async () => {
    const root = await createFixture("codegraph-mcp-v2-stdio-");
    const client = new Client(
      { name: "codegraph-mcp-protocol-v2-stdio-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve("dist", "cli.js"),
        "mcp",
        "serve",
        "--root",
        root,
        "--stdio",
        "--native",
        "off",
        "--cache",
        "off",
      ],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    let childClosed: Promise<void> | undefined;
    let cleanupError: Error | undefined;
    try {
      await withTimeout(client.connect(transport), OPERATION_TIMEOUT_MS, "MCP stdio client connect");
      childClosed = new Promise<void>((resolve) => {
        transport.onclose = () => resolve();
      });
      expect(transport.pid).toBeTypeOf("number");
      await assertModernConversation(client);
    } finally {
      const cleanupPromises: Promise<void>[] = [
        withTimeout(client.close(), CLEANUP_TIMEOUT_MS, "MCP stdio client cleanup"),
      ];
      if (childClosed) cleanupPromises.push(withTimeout(childClosed, CLEANUP_TIMEOUT_MS, "MCP stdio child cleanup"));
      const cleanupResults = await Promise.allSettled(cleanupPromises);
      await withTimeout(fsp.rm(root, { recursive: true, force: true }), CLEANUP_TIMEOUT_MS, "stdio temp root cleanup");
      const cleanupFailure = cleanupResults.find((result) => result.status === "rejected");
      if (cleanupFailure?.status === "rejected") {
        cleanupError =
          cleanupFailure.reason instanceof Error ? cleanupFailure.reason : new Error(String(cleanupFailure.reason));
      }
    }
    expect(transport.pid).toBeNull();
    if (cleanupError) throw cleanupError;
  });
});
