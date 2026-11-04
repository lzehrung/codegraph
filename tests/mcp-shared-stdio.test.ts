import fsp from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { startCodegraphMcpHttpServer, type CodegraphMcpHttpServer } from "../src/mcp/http-transport.js";
import { qualifyWorkspaceValue } from "../src/mcp/workspace.js";
import { mkTmpDir, tryCreateDirectorySymlink } from "./helpers/filesystem.js";
import { runCliOrThrow } from "./helpers/cli.js";

const cli = path.resolve("dist/cli.js");

function stdioClient(
  root: string,
  mode: "legacy" | "auto" = "legacy",
  workspace?: string,
): { client: Client; transport: StdioClientTransport } {
  const client = new Client({ name: "shared-index-consumer", version: "1.0.0" }, { versionNegotiation: { mode } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cli,
      "mcp",
      "serve",
      "--stdio",
      "--root",
      root,
      "--no-warmup",
      ...(workspace ? ["--workspace", workspace] : []),
    ],
    stderr: "pipe",
  });
  return { client, transport };
}

async function names(client: Client, arguments_: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({
    name: "workspace_symbols",
    arguments: { query: "sharedTarget", ...arguments_ },
  });
  expect(result.isError).not.toBe(true);
  return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

type StartupGatedWorkspace = {
  client: Client;
  transport: StdioClientTransport;
  blocked: Promise<void>;
  release: () => void;
  toolRequests: () => Promise<unknown[]>;
  close: () => Promise<void>;
};

async function startupGatedWorkspace(
  root: string,
  scratch: string,
  mode: "legacy" | "auto" = "auto",
): Promise<StartupGatedWorkspace> {
  const requestLog = path.join(scratch, "owner-tool-calls.jsonl");
  const observer = path.join(scratch, "observe-owner-requests.mjs");
  await fsp.writeFile(requestLog, "");
  // Observe real owner requests without replacing the HTTP server or its tool handlers.
  await fsp.writeFile(
    observer,
    [
      'import { channel } from "node:diagnostics_channel";',
      'import { appendFileSync } from "node:fs";',
      'channel("http.server.request.start").subscribe(({ request }) => {',
      '  if (request.url?.split("?", 1)[0] !== "/mcp" || request.method !== "POST") return;',
      '  let body = "";',
      '  request.on("data", (chunk) => { body += chunk; });',
      '  request.on("end", () => {',
      "    const payload = JSON.parse(body);",
      '    if (payload.method === "tools/call") {',
      `      appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ pid: process.pid, name: payload.params.name }) + "\\n");`,
      "    }",
      "  });",
      "});",
    ].join("\n"),
  );
  const blocked = Promise.withResolvers<void>();
  const heldResponses = new Set<ServerResponse>();
  let released = false;
  const gate = createServer((_request, response) => {
    if (released) {
      response.end();
      return;
    }
    heldResponses.add(response);
    blocked.resolve();
  });
  const listening = Promise.withResolvers<void>();
  gate.once("error", listening.reject);
  gate.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = gate.address();
  if (!address || typeof address === "string") throw new Error("Workspace startup gate did not bind a port.");
  const gateUrl = `http://127.0.0.1:${address.port}`;
  const workspaceModule = pathToFileURL(path.resolve("dist/mcp/workspace.js")).href;
  const code = [
    `import { serveWorkspaceMcp } from ${JSON.stringify(workspaceModule)};`,
    "await serveWorkspaceMcp({",
    `  root: ${JSON.stringify(root)}, configPath: "workspace.json",`,
    '  ownerOptions: { warmup: "off", watch: false },',
    "  projectBuildOptions: async () => {",
    `    const response = await fetch(${JSON.stringify(gateUrl)});`,
    "    await response.arrayBuffer();",
    '    return { cache: "off" };',
    "  },",
    "});",
  ].join("\n");
  const client = new Client({ name: "startup-alias-consumer", version: "1.0.0" }, { versionNegotiation: { mode } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "--eval", code],
    env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(observer).href}`].filter(Boolean).join(" "),
    },
    stderr: "pipe",
  });
  const release = (): void => {
    released = true;
    for (const response of heldResponses) response.end();
    heldResponses.clear();
  };
  return {
    client,
    transport,
    blocked: blocked.promise,
    release,
    async toolRequests(): Promise<unknown[]> {
      const recorded = (await fsp.readFile(requestLog, "utf8")).trim();
      return recorded ? recorded.split("\n").map((line) => JSON.parse(line) as unknown) : [];
    },
    async close(): Promise<void> {
      release();
      try {
        await client.close();
      } finally {
        const closed = Promise.withResolvers<void>();
        gate.close((error) => {
          if (error) closed.reject(error);
          else closed.resolve();
        });
        await closed.promise;
      }
    },
  };
}

describe("shared stdio project ownership", () => {
  it("shares an owner across clients, preserves edits, and survives one client disconnect", async () => {
    const root = await mkTmpDir("cg-shared-stdio-");
    const first = stdioClient(root);
    const second = stdioClient(root, "auto");
    try {
      await fsp.writeFile(path.join(root, "main.ts"), "export function sharedTargetBefore() { return 1; }\n");
      await Promise.all([first.client.connect(first.transport), second.client.connect(second.transport)]);
      const firstResult = await names(first.client);
      expect(firstResult).toContain("sharedTargetBefore");
      const registry = JSON.parse(await fsp.readFile(path.join(root, ".codegraph/server.json"), "utf8")) as {
        pid: number;
        startedAt: string;
      };
      expect(await names(second.client)).toBe(firstResult);
      expect(registry.pid).not.toBe(first.transport.pid);
      expect(registry.pid).not.toBe(second.transport.pid);
      await first.client.close();
      await fsp.writeFile(path.join(root, "main.ts"), "export function sharedTargetAfter() { return 2; }\n");
      // Explicit refresh avoids depending on host watcher scheduling or the pull-check interval.
      await second.client.callTool({ name: "refresh_index", arguments: { warmup: "base" } });
      const changed = await names(second.client);
      expect(changed).toContain("sharedTargetAfter");
      expect(changed).not.toContain("sharedTargetBefore");
      expect(JSON.parse(await fsp.readFile(path.join(root, ".codegraph/server.json"), "utf8"))).toMatchObject(registry);
    } finally {
      await Promise.allSettled([first.client.close(), second.client.close()]);
      await runCliOrThrow(["server", "stop", "--root", root]);
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("preserves modern request logging and progress through the serving boundary", async () => {
    const root = await mkTmpDir("cg-shared-stdio-notify-");
    const { client, transport } = stdioClient(root, "auto");
    const levels: string[] = [];
    const progress: Array<{ progress: number; total?: number | undefined }> = [];
    client.setNotificationHandler("notifications/message", (notification) => {
      if (notification.params.logger === "codegraph") levels.push(notification.params.level);
    });
    try {
      await fsp.writeFile(path.join(root, "main.ts"), "export const notificationTarget = 1;\n");
      await client.connect(transport);
      const result = await client.callTool(
        {
          name: "get_file",
          arguments: { file: "main.ts" },
          _meta: { "io.modelcontextprotocol/logLevel": "info" },
        },
        {
          onprogress: (update) => {
            progress.push({ progress: update.progress, total: update.total });
          },
        },
      );
      expect(result.isError).not.toBe(true);
      expect(result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")).toContain(
        "notificationTarget",
      );
      expect(levels).toEqual(["info", "info"]);
      expect(progress).toEqual([
        { progress: 0, total: 1 },
        { progress: 1, total: 1 },
      ]);
    } finally {
      await client.close();
      await runCliOrThrow(["server", "stop", "--root", root]);
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
  it("shares physical ownership while preserving each client's logical root and source bytes", async () => {
    const root = await mkTmpDir("cg-shared-stdio-physical-");
    const parent = await mkTmpDir("cg-shared-stdio-logical-");
    const alias = path.join(parent, "selected");
    const physical = stdioClient(root);
    const logical = stdioClient(alias, "auto");
    let linked = false;
    try {
      linked = await tryCreateDirectorySymlink(root, alias);
      if (!linked) return;
      const source = `export function sharedTargetAlias() { return ${JSON.stringify(root.replace(/\\/g, "/"))}; }\n`;
      await fsp.writeFile(path.join(root, "main.ts"), source);
      await physical.client.connect(physical.transport);
      const physicalAnswer: unknown = JSON.parse(await names(physical.client));
      expect(physicalAnswer).toMatchObject({ root });
      const registry = JSON.parse(await fsp.readFile(path.join(root, ".codegraph/server.json"), "utf8")) as unknown;
      await logical.client.connect(logical.transport);
      const logicalAnswer: unknown = JSON.parse(await names(logical.client));
      expect(logicalAnswer).toMatchObject({ root: alias });
      const file = await logical.client.callTool({ name: "get_file", arguments: { file: "main.ts" } });
      expect(file.isError).not.toBe(true);
      const fileAnswer: unknown = JSON.parse(
        file.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
      );
      expect(fileAnswer).toMatchObject({ content: expect.stringContaining(source.trim()) });
      expect(JSON.parse(await fsp.readFile(path.join(root, ".codegraph/server.json"), "utf8"))).toEqual(registry);
    } finally {
      await Promise.allSettled([physical.client.close(), logical.client.close()]);
      await runCliOrThrow(["server", "stop", "--root", root]);
      if (linked) await fsp.unlink(alias);
      await fsp.rm(parent, { recursive: true, force: true });
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects live alias retargeting until the original logical root is restored", async (context) => {
    const root = await mkTmpDir("cg-shared-stdio-bound-root-");
    const otherRoot = await mkTmpDir("cg-shared-stdio-other-root-");
    const parent = await mkTmpDir("cg-shared-stdio-retarget-");
    const alias = path.join(parent, "selected");
    const { client, transport } = stdioClient(alias, "auto");
    let linked = false;
    try {
      linked = await tryCreateDirectorySymlink(root, alias);
      if (!linked) {
        context.skip();
        return;
      }
      await fsp.writeFile(path.join(root, "main.ts"), "export function sharedTargetOriginal() { return 1; }\n");
      await fsp.writeFile(path.join(otherRoot, "main.ts"), "export function sharedTargetOther() { return 2; }\n");
      await client.connect(transport);
      const initial = await names(client);
      expect(JSON.parse(initial) as unknown).toMatchObject({ root: alias });
      expect(initial).toContain("sharedTargetOriginal");
      expect(initial).not.toContain("sharedTargetOther");
      const registryPath = path.join(root, ".codegraph", "server.json");
      const registry = await fsp.readFile(registryPath, "utf8");

      await fsp.unlink(alias);
      linked = false;
      linked = await tryCreateDirectorySymlink(otherRoot, alias);
      expect(linked).toBe(true);
      await expect(names(client)).rejects.toThrow("project root changed");
      // A later explicit request must not silently bind this bridge to the alias's new project.
      await expect(names(client)).rejects.toThrow("project root changed");
      await expect(fsp.access(path.join(otherRoot, ".codegraph", "server.json"))).rejects.toThrow();
      expect(await fsp.readFile(registryPath, "utf8")).toBe(registry);

      await fsp.unlink(alias);
      linked = false;
      linked = await tryCreateDirectorySymlink(root, alias);
      expect(linked).toBe(true);
      const restored = await names(client);
      expect(JSON.parse(restored) as unknown).toMatchObject({ root: alias });
      expect(restored).toContain("sharedTargetOriginal");
      expect(restored).not.toContain("sharedTargetOther");
      expect(await fsp.readFile(registryPath, "utf8")).toBe(registry);
    } finally {
      await client.close();
      await runCliOrThrow(["server", "stop", "--root", root]);
      if (linked) await fsp.unlink(alias);
      await fsp.rm(parent, { recursive: true, force: true });
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(otherRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it.for([
    { selection: "selected alias", mode: "legacy" as const, arguments_: { project: "app-alias" } },
    {
      selection: "qualified secondary alias",
      mode: "auto" as const,
      arguments_: { project: "app", fileGlob: qualifyWorkspaceValue("app-alias", "**/*.ts") },
    },
    { selection: "fanout", mode: "auto" as const, arguments_: {} },
  ])("rejects $selection changes during owner startup", { timeout: 60_000 }, async (scenario, context) => {
    const root = await mkTmpDir("cg-workspace-startup-alias-");
    const otherRoot = await mkTmpDir("cg-workspace-startup-alias-other-");
    const scratch = await mkTmpDir("cg-workspace-startup-alias-gate-");
    const projectRoot = path.join(root, "app");
    const alias = path.join(root, "app-alias");
    let linked = false;
    let consumer: StartupGatedWorkspace | undefined;
    try {
      await fsp.mkdir(projectRoot);
      await fsp.writeFile(path.join(projectRoot, "main.ts"), "export function sharedTargetOriginal() { return 1; }\n");
      await fsp.writeFile(path.join(otherRoot, "main.ts"), "export function sharedTargetOther() { return 2; }\n");
      linked = await tryCreateDirectorySymlink(projectRoot, alias);
      if (!linked) {
        context.skip();
        return;
      }
      await fsp.writeFile(
        path.join(root, "workspace.json"),
        JSON.stringify({
          projects: [
            { id: "app", path: "app" },
            { id: "app-alias", path: "app-alias" },
          ],
        }),
      );
      consumer = await startupGatedWorkspace(root, scratch, scenario.mode);
      await consumer.client.connect(consumer.transport);
      const pending = names(consumer.client, scenario.arguments_);
      await consumer.blocked;
      await fsp.unlink(alias);
      linked = false;
      linked = await tryCreateDirectorySymlink(otherRoot, alias);
      expect(linked).toBe(true);
      consumer.release();
      const rejected = await pending;
      expect(await consumer.toolRequests()).toEqual([]);
      expect(JSON.parse(rejected) as unknown).toMatchObject({
        projects: [{ project: { id: "app" }, status: "error", error: expect.stringContaining("root changed") }],
        coverage: { selectedProjects: 1, completedProjects: 0, failedProjects: 1, complete: false },
      });
      expect(rejected).not.toContain("sharedTargetOriginal");
      expect(rejected).not.toContain("sharedTargetOther");
      await expect(fsp.access(path.join(otherRoot, ".codegraph", "server.json"))).rejects.toThrow();
      const registryPath = path.join(projectRoot, ".codegraph", "server.json");
      const registry = await fsp.readFile(registryPath, "utf8");
      const owner = JSON.parse(registry) as { pid: number };

      // A changed secondary declaration must not poison an explicitly selected unchanged canonical declaration.
      const canonical = await names(consumer.client, { project: "app" });
      expect(JSON.parse(canonical) as unknown).toMatchObject({
        projects: [{ project: { id: "app", path: "app" }, status: "ok" }],
      });
      expect(canonical).toContain("sharedTargetOriginal");
      expect(canonical).not.toContain("sharedTargetOther");
      expect(await consumer.toolRequests()).toEqual([{ pid: owner.pid, name: "workspace_symbols" }]);
      expect(await fsp.readFile(registryPath, "utf8")).toBe(registry);
    } finally {
      await consumer?.close();
      await runCliOrThrow(["server", "stop", "--root", projectRoot]);
      if (linked) await fsp.unlink(alias);
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(otherRoot, { recursive: true, force: true });
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a captured canonical root retargeted outside the workspace during owner startup", async (context) => {
    const root = await mkTmpDir("cg-workspace-startup-root-");
    const otherRoot = await mkTmpDir("cg-workspace-startup-root-other-");
    const scratch = await mkTmpDir("cg-workspace-startup-root-gate-");
    const projectRoot = path.join(root, "app");
    const savedRoot = path.join(root, "original-app");
    const alias = path.join(root, "app-alias");
    let aliasLinked = false;
    let rootLinked = false;
    let moved = false;
    let consumer: StartupGatedWorkspace | undefined;
    try {
      await fsp.mkdir(projectRoot);
      await fsp.writeFile(path.join(projectRoot, "main.ts"), "export function sharedTargetOriginal() { return 1; }\n");
      await fsp.writeFile(path.join(otherRoot, "main.ts"), "export function sharedTargetExternal() { return 2; }\n");
      aliasLinked = await tryCreateDirectorySymlink(projectRoot, alias);
      if (!aliasLinked) {
        context.skip();
        return;
      }
      await fsp.writeFile(
        path.join(root, "workspace.json"),
        JSON.stringify({
          projects: [
            { id: "app", path: "app" },
            { id: "app-alias", path: "app-alias" },
          ],
        }),
      );
      consumer = await startupGatedWorkspace(root, scratch);
      await consumer.client.connect(consumer.transport);
      const pending = names(consumer.client, { project: "app-alias" });
      await consumer.blocked;
      await fsp.rename(projectRoot, savedRoot);
      moved = true;
      rootLinked = await tryCreateDirectorySymlink(otherRoot, projectRoot);
      expect(rootLinked).toBe(true);
      consumer.release();
      const rejected = await pending;
      expect(await consumer.toolRequests()).toEqual([]);
      expect(JSON.parse(rejected) as unknown).toMatchObject({
        projects: [{ status: "error", error: expect.stringContaining("root changed during owner startup") }],
        coverage: { selectedProjects: 1, completedProjects: 0, failedProjects: 1, complete: false },
      });
      expect(rejected).not.toContain("sharedTargetOriginal");
      expect(rejected).not.toContain("sharedTargetExternal");
      await expect(fsp.access(path.join(savedRoot, ".codegraph", "server.json"))).rejects.toThrow();

      await fsp.unlink(projectRoot);
      rootLinked = false;
      await fsp.rename(savedRoot, projectRoot);
      moved = false;
      const canonical = await names(consumer.client, { project: "app" });
      expect(JSON.parse(canonical) as unknown).toMatchObject({
        projects: [{ project: { id: "app", path: "app" }, status: "ok" }],
      });
      expect(canonical).toContain("sharedTargetOriginal");
      expect(canonical).not.toContain("sharedTargetExternal");
      const owner = JSON.parse(await fsp.readFile(path.join(projectRoot, ".codegraph", "server.json"), "utf8")) as {
        pid: number;
      };
      expect(await consumer.toolRequests()).toEqual([{ pid: owner.pid, name: "workspace_symbols" }]);
    } finally {
      await consumer?.close();
      if (rootLinked) await fsp.unlink(projectRoot);
      if (moved) await fsp.rename(savedRoot, projectRoot);
      if (aliasLinked) await fsp.unlink(alias);
      await runCliOrThrow(["server", "stop", "--root", projectRoot]);
      await runCliOrThrow(["server", "stop", "--root", otherRoot]);
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(otherRoot, { recursive: true, force: true });
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  it.each(["legacy", "auto", "workspace"] as const)(
    "rejects a different MCP server reusing the captured endpoint without replay (%s)",
    async (mode) => {
      const root = await mkTmpDir("cg-shared-stdio-bound-endpoint-");
      const otherRoot = await mkTmpDir("cg-shared-stdio-replacement-");
      const { client, transport } = stdioClient(
        root,
        mode === "legacy" ? "legacy" : "auto",
        mode === "workspace" ? "workspace.json" : undefined,
      );
      const direct = new Client(
        { name: "replacement-endpoint-consumer", version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } },
      );
      let replacement: CodegraphMcpHttpServer | undefined;
      try {
        await fsp.writeFile(path.join(root, "main.ts"), "export function sharedTargetOriginal() { return 1; }\n");
        if (mode === "workspace") {
          await fsp.writeFile(
            path.join(root, "workspace.json"),
            JSON.stringify({ projects: [{ id: "project", path: "." }] }),
          );
        }
        await fsp.writeFile(
          path.join(otherRoot, "main.ts"),
          "export function sharedTargetReplacement() { return 2; }\n",
        );
        await client.connect(transport);
        expect(await names(client)).toContain("sharedTargetOriginal");
        const registry = JSON.parse(await fsp.readFile(path.join(root, ".codegraph", "server.json"), "utf8")) as {
          pid: number;
          url: string;
        };
        // An external exit leaves the old registry and credential in place, so the next dispatch must reprove health.
        process.kill(registry.pid, "SIGTERM");
        await expect
          .poll(
            () => {
              try {
                process.kill(registry.pid, 0);
                return false;
              } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
                throw error;
              }
            },
            { timeout: 10_000 },
          )
          .toBe(true);
        await expect
          .poll(
            async () => {
              try {
                replacement = await startCodegraphMcpHttpServer({
                  root: otherRoot,
                  host: "127.0.0.1",
                  port: Number(new URL(registry.url).port),
                  readOnly: false,
                  warmup: "off",
                  watch: false,
                });
                return true;
              } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") return false;
                throw error;
              }
            },
            { timeout: 10_000 },
          )
          .toBe(true);
        if (!replacement) throw new Error("Replacement endpoint did not start.");
        expect(replacement.url).toBe(registry.url);
        await direct.connect(new StreamableHTTPClientTransport(new URL(replacement.url)));
        const replacementResult = await names(direct);
        expect(replacementResult).toContain("sharedTargetReplacement");
        expect(replacementResult).not.toContain("sharedTargetOriginal");
        await direct.close();
        const replacementMcpRequests: string[] = [];
        replacement.server.on("request", (request) => {
          if (request.url?.split("?", 1)[0] === "/mcp") replacementMcpRequests.push(request.method ?? "");
        });

        if (mode === "workspace") {
          const rejected = await names(client);
          expect(rejected).toContain("captured shared Codegraph owner");
          expect(rejected).not.toContain("sharedTargetReplacement");
        } else {
          await expect(names(client)).rejects.toThrow("captured shared Codegraph owner");
        }
        expect(replacementMcpRequests).toEqual([]);
        await replacement.close();
        replacement = undefined;
        // Recovery belongs to the next explicit call, never a replay of the rejected request.
        const recovered = await names(client);
        expect(recovered).toContain("sharedTargetOriginal");
        expect(recovered).not.toContain("sharedTargetReplacement");
      } finally {
        await Promise.allSettled([client.close(), direct.close()]);
        await replacement?.close();
        // Coverage load can exceed the lifecycle health probe's deadline; retry only that transient refusal.
        await expect
          .poll(
            async () => {
              try {
                await runCliOrThrow(["server", "stop", "--root", root]);
                return true;
              } catch (error) {
                if (error instanceof Error && error.message.includes("health endpoint is temporarily unavailable"))
                  return false;
                throw error;
              }
            },
            { timeout: 10_000 },
          )
          .toBe(true);
        await fsp.rm(root, { recursive: true, force: true });
        await fsp.rm(otherRoot, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
