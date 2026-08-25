import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isPlainRecord } from "../src/util/guards.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(repoRoot, "dist", "cli.js");
const testRoots = new Set<string>();

type CliResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};
type ServerRegistry = {
  schemaVersion: number;
  pid: number;
  url: string;
  root: string;
  startedAt: string;
  version: string;
};

afterEach(async () => {
  for (const root of testRoots) {
    await runCli(["server", "stop", "--root", root]);
    await fs.rm(root, { recursive: true, force: true });
  }
  testRoots.clear();
});

describe("shared MCP server lifecycle", () => {
  it("writes the registry only after a same-root health response, reports live JSON status, and stops", async () => {
    const root = await createTestRoot();
    const port = await reservePort();

    const start = await runCli(["server", "start", "--root", root, "--port", String(port), "--warmup"]);

    expect(start.exitCode).toBe(0);
    expect(start.stdout).toContain(`http://127.0.0.1:${port}/mcp`);
    const registry = await readRegistry(root);
    expect(registry).toMatchObject({
      schemaVersion: 1,
      url: `http://127.0.0.1:${port}/mcp`,
      root: root.replace(/\\/g, "/"),
    });
    expect(registry.pid).toBeGreaterThan(0);

    const healthUrl = new URL(registry.url);
    healthUrl.pathname = "/health";
    const healthResponse = await fetch(healthUrl);
    const health: unknown = await healthResponse.json();
    expect(healthResponse.ok).toBe(true);
    expect(health).toMatchObject({
      service: "codegraph",
      schemaVersion: 1,
      pid: registry.pid,
      root: registry.root,
      version: registry.version,
      startedAt: registry.startedAt,
      update: { restartRequired: false, runningVersion: registry.version },
    });

    const status = await runCli(["server", "status", "--root", root, "--json"]);
    expect(status.exitCode).toBe(0);
    expect(parseJsonObject(status.stdout)).toMatchObject({ status: "live", registry });

    const stop = await runCli(["server", "stop", "--root", root]);
    expect(stop.exitCode).toBe(0);
    expect(stop.stdout).toContain("Stopped Codegraph server");
    await expect(fs.access(path.join(root, ".codegraph", "server.json"))).rejects.toThrow();
  });

  it("does not register a previous same-root server when its child cannot bind the port", async () => {
    const root = await createTestRoot();
    const port = await reservePort();
    const firstStart = await runCli(["server", "start", "--root", root, "--port", String(port)]);
    expect(firstStart.exitCode).toBe(0);
    const registryPath = path.join(root, ".codegraph", "server.json");
    const originalRegistry = await fs.readFile(registryPath, "utf8");
    await fs.rm(registryPath);

    try {
      const duplicateStart = await runCli(["server", "start", "--root", root, "--port", String(port)]);
      expect(duplicateStart.exitCode).toBe(1);
      expect(duplicateStart.stderr).toContain("process exited before accepting requests");
      await expect(fs.access(registryPath)).rejects.toThrow();
    } finally {
      await fs.writeFile(registryPath, originalRegistry, "utf8");
    }
  });

  it("uses a non-loopback bind only when --host explicitly supplies one", async () => {
    const root = await createTestRoot();
    const port = await reservePort();

    const start = await runCli(["server", "start", "--root", root, "--host", "0.0.0.0", "--port", String(port)]);

    expect(start.exitCode).toBe(0);
    expect((await readRegistry(root)).url).toBe(`http://0.0.0.0:${port}/mcp`);
  });

  it("reports and safely removes stale registry metadata", async () => {
    const root = await createTestRoot();
    const port = await reservePort();
    await writeRegistry(root, {
      schemaVersion: 1,
      pid: process.pid,
      url: `http://127.0.0.1:${port}/mcp`,
      root: root.replace(/\\/g, "/"),
      startedAt: "2026-08-25T00:00:00.000Z",
      version: "test",
    });

    const status = await runCli(["server", "status", "--root", root, "--json"]);
    expect(status.exitCode).toBe(0);
    expect(parseJsonObject(status.stdout)).toMatchObject({
      status: "stale",
      reason: "Server health endpoint did not respond.",
    });

    const stop = await runCli(["server", "stop", "--root", root]);
    expect(stop.exitCode).toBe(0);
    expect(stop.stdout).toContain("Removed stale Codegraph server registry.");
    await expect(fs.access(path.join(root, ".codegraph", "server.json"))).rejects.toThrow();
  });

  it("rejects stopping a live Codegraph server for another root", async () => {
    const targetRoot = await createTestRoot();
    const serverRoot = await createTestRoot();
    const port = await reservePort();
    const start = await runCli(["server", "start", "--root", serverRoot, "--port", String(port)]);
    expect(start.exitCode).toBe(0);

    const serverRegistry = await readRegistry(serverRoot);
    await writeRegistry(targetRoot, {
      ...serverRegistry,
      root: targetRoot.replace(/\\/g, "/"),
    });

    const stop = await runCli(["server", "stop", "--root", targetRoot]);
    expect(stop.exitCode).toBe(1);
    expect(stop.stderr).toContain("root does not match the requested root");
    await expect(fs.access(path.join(targetRoot, ".codegraph", "server.json"))).resolves.toBeUndefined();

    const healthUrl = new URL(serverRegistry.url);
    healthUrl.pathname = "/health";
    expect((await fetch(healthUrl)).ok).toBe(true);
  });

  it("refuses to signal a process when health identifies a different process", async () => {
    const root = await createTestRoot();
    const port = await reservePort();
    const start = await runCli(["server", "start", "--root", root, "--port", String(port)]);
    expect(start.exitCode).toBe(0);
    const originalRegistry = await readRegistry(root);
    await writeRegistry(root, { ...originalRegistry, pid: 2_147_483_647 });

    try {
      const status = await runCli(["server", "status", "--root", root, "--json"]);
      expect(status.exitCode).toBe(0);
      expect(parseJsonObject(status.stdout)).toMatchObject({
        status: "stale",
        reason: "Server process identifier does not match the registry.",
      });

      const stop = await runCli(["server", "stop", "--root", root]);
      expect(stop.exitCode).toBe(1);
      expect(stop.stderr).toContain("Refusing to stop a Codegraph server");
      const healthUrl = new URL(originalRegistry.url);
      healthUrl.pathname = "/health";
      expect((await fetch(healthUrl)).ok).toBe(true);
    } finally {
      await writeRegistry(root, originalRegistry);
    }
  });

  it("rejects an ephemeral server port before it starts", async () => {
    const root = await createTestRoot();

    const result = await runCli(["server", "start", "--root", root, "--port", "0"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Invalid --port value "0".');
    await expect(fs.access(path.join(root, ".codegraph", "server.json"))).rejects.toThrow();
  });
});

async function createTestRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-mcp-server-lifecycle-"));
  testRoots.add(root);
  return root;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a TCP port.");
  const { promise: closed, resolve: resolveClosed, reject: rejectClosed } = Promise.withResolvers<void>();
  server.close((error) => {
    if (error) {
      rejectClosed(error);
    } else {
      resolveClosed();
    }
  });
  await closed;
  return address.port;
}

async function runCli(args: string[]): Promise<CliResult> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  child.once("error", reject);
  child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  return await promise;
}

async function readRegistry(root: string): Promise<ServerRegistry> {
  const raw = await fs.readFile(path.join(root, ".codegraph", "server.json"), "utf8");
  const registry = parseJsonObject(raw);
  if (
    typeof registry.schemaVersion !== "number" ||
    typeof registry.pid !== "number" ||
    typeof registry.url !== "string" ||
    typeof registry.root !== "string" ||
    typeof registry.startedAt !== "string" ||
    typeof registry.version !== "string"
  ) {
    throw new Error("Server registry is invalid.");
  }
  return registry as ServerRegistry;
}

async function writeRegistry(root: string, registry: ServerRegistry): Promise<void> {
  const registryPath = path.join(root, ".codegraph", "server.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify(registry)}\n`, "utf8");
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isPlainRecord(parsed)) throw new Error("Expected JSON object.");
  return parsed;
}
