import fsp from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { mkTmpDir, tryCreateDirectorySymlink } from "./helpers/filesystem.js";
import { runCliOrThrow } from "./helpers/cli.js";

const cli = path.resolve("dist/cli.js");

function stdioClient(
  root: string,
  mode: "legacy" | "auto" = "legacy",
): { client: Client; transport: StdioClientTransport } {
  const client = new Client({ name: "shared-index-consumer", version: "1.0.0" }, { versionNegotiation: { mode } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "serve", "--stdio", "--root", root, "--no-warmup"],
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
});
