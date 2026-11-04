import fsp from "node:fs/promises";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { startCodegraphMcpHttpServer, type CodegraphMcpHttpServer } from "../src/mcp/http-transport.js";
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

async function names(client: Client): Promise<string> {
  const result = await client.callTool({ name: "workspace_symbols", arguments: { query: "sharedTarget" } });
  expect(result.isError).not.toBe(true);
  return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
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
