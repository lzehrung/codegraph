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
  credentialId?: string;
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
      schemaVersion: 2,
      url: `http://127.0.0.1:${port}/mcp`,
      root: root.replace(/\\/g, "/"),
      credentialId: expect.any(String),
    });
    expect(registry.pid).toBeGreaterThan(0);

    const healthUrl = new URL(registry.url);
    healthUrl.pathname = "/health";
    const healthResponse = await fetch(healthUrl);
    const health: unknown = await healthResponse.json();
    expect(healthResponse.ok).toBe(true);
    expect(health).not.toHaveProperty("lifecycleProof");
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

    const formattedStatus = await runCli(["server", "status", "--root", root]);
    expect(formattedStatus.exitCode).toBe(0);
    expect(formattedStatus.stdout).toContain("Codegraph server status");
    expect(formattedStatus.stdout).toContain("Status: live");
    expect(formattedStatus.stdout).toContain(`URL: ${registry.url}`);
    expect(formattedStatus.stdout).toContain(`PID: ${registry.pid}`);

    const explicitPrettyStatus = await runCli(["server", "status", "--root", root, "--pretty"]);
    expect(explicitPrettyStatus.exitCode).toBe(0);
    expect(explicitPrettyStatus.stdout).toBe(formattedStatus.stdout);

    const stop = await runCli(["server", "stop", "--root", root]);
    expect(stop.exitCode).toBe(0);
    expect(stop.stdout).toContain("Stopped Codegraph server");
    await expect(fs.access(path.join(root, ".codegraph", "server.json"))).rejects.toThrow();
  });

  it("requires --replace before replacing a live server", async () => {
    const root = await createTestRoot();
    const initialPort = await reservePort();
    const initialStart = await runCli(["server", "start", "--root", root, "--port", String(initialPort)]);
    expect(initialStart.exitCode).toBe(0);
    const initialRegistry = await readRegistry(root);

    const refusedStart = await runCli(["server", "start", "--root", root, "--port", String(await reservePort())]);
    expect(refusedStart.exitCode).toBe(1);
    expect(refusedStart.stderr).toContain("Codegraph server is already live");
    expect(await readRegistry(root)).toEqual(initialRegistry);

    const replacementPort = await reservePort();
    const replacementStart = await runCli([
      "server",
      "start",
      "--root",
      root,
      "--port",
      String(replacementPort),
      "--replace",
    ]);
    expect(replacementStart.exitCode).toBe(0);
    const replacementRegistry = await readRegistry(root);
    expect(replacementRegistry).toMatchObject({
      url: `http://127.0.0.1:${replacementPort}/mcp`,
      root: initialRegistry.root,
    });
    expect(replacementRegistry.pid).not.toBe(initialRegistry.pid);
    expect(replacementRegistry.startedAt).not.toBe(initialRegistry.startedAt);
    const initialHealthUrl = new URL(initialRegistry.url);
    initialHealthUrl.pathname = "/health";
    await expect(fetch(initialHealthUrl)).rejects.toThrow();
  });

  it("emits the started registry and update state as JSON", async () => {
    const root = await createTestRoot();
    const port = await reservePort();

    const start = await runCli(["server", "start", "--root", root, "--port", String(port), "--json"]);

    expect(start.exitCode).toBe(0);
    expect(parseJsonObject(start.stdout)).toMatchObject({
      status: "started",
      schemaVersion: 2,
      url: `http://127.0.0.1:${port}/mcp`,
      root: root.replace(/\\/g, "/"),
      credentialId: expect.any(String),
      update: { restartRequired: false },
    });
  });

  it("preserves a live server registry during forced lifecycle cleanup", async () => {
    const root = await createTestRoot();
    const port = await reservePort();
    const start = await runCli(["server", "start", "--root", root, "--port", String(port)]);
    expect(start.exitCode).toBe(0);

    const uninit = await runCli(["uninit", "--root", root, "--force"]);
    expect(uninit.exitCode).toBe(0);
    const registry = await readRegistry(root);
    await expect(fs.access(path.join(root, ".codegraph", "server.log"))).resolves.toBeUndefined();
    const healthUrl = new URL(registry.url);
    healthUrl.pathname = "/health";
    expect((await fetch(healthUrl)).ok).toBe(true);

    const stop = await runCli(["server", "stop", "--root", root]);
    expect(stop.exitCode).toBe(0);
  });

  it("does not register a previous same-root server when its child cannot bind the port", async () => {
    const root = await createTestRoot();
    const port = await reservePort();
    const firstStart = await runCli(["server", "start", "--root", root, "--port", String(port)]);
    expect(firstStart.exitCode).toBe(0);
    const registryPath = path.join(root, ".codegraph", "server.json");
    const originalRegistry = await fs.readFile(registryPath, "utf8");
    const serverLogPath = path.join(root, ".codegraph", "server.log");
    await fs.appendFile(serverLogPath, "previous server diagnostics\n", "utf8");
    await fs.rm(registryPath);

    try {
      const duplicateStart = await runCli(["server", "start", "--root", root, "--port", String(port)]);
      expect(duplicateStart.exitCode).toBe(1);
      expect(duplicateStart.stderr).toContain("process exited before accepting requests");
      expect(duplicateStart.stderr).toContain("EADDRINUSE");
      const serverLog = await fs.readFile(serverLogPath, "utf8");
      expect(serverLog).toContain("EADDRINUSE");
      expect(serverLog).not.toContain("previous server diagnostics");
      await expect(fs.access(registryPath)).rejects.toThrow();
    } finally {
      await fs.writeFile(registryPath, originalRegistry, "utf8");
    }
  });

  it("rejects a structurally valid health response that cannot prove lifecycle ownership", async () => {
    const root = await createTestRoot();
    const serverPort = await reservePort();
    const start = await runCli(["server", "start", "--root", root, "--port", String(serverPort)]);
    expect(start.exitCode).toBe(0);
    const originalRegistry = await readRegistry(root);
    const impersonatorPort = await reservePort();
    const impersonator = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          service: "codegraph",
          schemaVersion: 1,
          pid: originalRegistry.pid,
          root: originalRegistry.root,
          version: originalRegistry.version,
          startedAt: originalRegistry.startedAt,
          update: { restartRequired: false, runningVersion: originalRegistry.version },
        }),
      );
    });
    const { promise: listening, resolve: resolveListening, reject: rejectListening } = Promise.withResolvers<void>();
    impersonator.once("error", rejectListening);
    impersonator.listen(impersonatorPort, "127.0.0.1", resolveListening);
    await listening;
    await writeRegistry(root, { ...originalRegistry, url: `http://127.0.0.1:${impersonatorPort}/mcp` });

    try {
      const status = await runCli(["server", "status", "--root", root, "--json"]);
      expect(status.exitCode).toBe(0);
      expect(parseJsonObject(status.stdout)).toMatchObject({
        status: "unreachable",
        reason: "Server health endpoint did not prove its lifecycle identity within 3000ms.",
      });
    } finally {
      await writeRegistry(root, originalRegistry);
      await new Promise<void>((resolve, reject) => {
        impersonator.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it("uses a non-loopback bind only when --host explicitly supplies one", async () => {
    const root = await createTestRoot();
    const port = await reservePort();

    const start = await runCli(["server", "start", "--root", root, "--host", "0.0.0.0", "--port", String(port)]);

    expect(start.exitCode).toBe(0);
    expect((await readRegistry(root)).url).toBe(`http://0.0.0.0:${port}/mcp`);
  });

  it("preserves caller-relative cache paths when starting a server", async () => {
    const root = await createTestRoot();
    const callerCwd = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-mcp-server-caller-"));
    const cacheDirectory = "relative-cache";
    await fs.writeFile(path.join(root, "input.ts"), "export const value = 1;\n", "utf8");

    try {
      const start = await runCli(
        [
          "server",
          "start",
          "--root",
          root,
          "--port",
          String(await reservePort()),
          "--cache",
          "disk",
          "--cache-dir",
          cacheDirectory,
          "--warmup",
        ],
        callerCwd,
      );
      expect(start.exitCode).toBe(0);
      await expect(fs.access(path.join(callerCwd, cacheDirectory))).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, cacheDirectory))).rejects.toThrow();
      const stop = await runCli(["server", "stop", "--root", root], callerCwd);
      expect(stop.exitCode).toBe(0);
    } finally {
      await fs.rm(callerCwd, { recursive: true, force: true });
    }
  });

  it("reports and safely removes stale registry metadata", async () => {
    const root = await createTestRoot();
    const port = await reservePort();
    await writeRegistry(root, {
      schemaVersion: 1,
      pid: 2_147_483_647,
      url: `http://127.0.0.1:${port}/mcp`,
      root: root.replace(/\\/g, "/"),
      startedAt: "2026-08-25T00:00:00.000Z",
      version: "test",
    });

    const status = await runCli(["server", "status", "--root", root, "--json"]);
    expect(status.exitCode).toBe(0);
    expect(parseJsonObject(status.stdout)).toMatchObject({
      status: "stale",
      reason: "Server process is not running.",
    });

    const formattedStatus = await runCli(["server", "status", "--root", root, "--pretty"]);
    expect(formattedStatus.exitCode).toBe(0);
    expect(formattedStatus.stdout).toContain("Status: stale");
    expect(formattedStatus.stdout).toContain("Remedy: run codegraph server stop --root .");

    const stop = await runCli(["server", "stop", "--root", root]);
    expect(stop.exitCode).toBe(0);
    expect(stop.stdout).toContain("Removed stale Codegraph server registry.");
    await expect(fs.access(path.join(root, ".codegraph", "server.json"))).rejects.toThrow();
  });

  it("retains a registry while its process is reachable but health is unavailable", async () => {
    const root = await createTestRoot();
    const port = await reservePort();
    const registryPath = path.join(root, ".codegraph", "server.json");
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
      status: "unreachable",
      reason: "Server registry predates lifecycle credentials. Stop the server manually, then start it again.",
    });

    const start = await runCli(["server", "start", "--root", root, "--port", String(await reservePort())]);
    expect(start.exitCode).toBe(1);
    expect(start.stderr).toContain("health endpoint is temporarily unavailable");
    await expect(fs.access(registryPath)).resolves.toBeUndefined();

    const formattedStatus = await runCli(["server", "status", "--root", root, "--pretty"]);
    expect(formattedStatus.exitCode).toBe(0);
    expect(formattedStatus.stdout).toContain("Status: unreachable");
    expect(formattedStatus.stdout).toContain("Remedy: verify the server process and /health endpoint before retrying.");

    const stop = await runCli(["server", "stop", "--root", root]);
    expect(stop.exitCode).toBe(1);
    expect(stop.stderr).toContain("health endpoint is temporarily unavailable");
    await expect(fs.access(registryPath)).resolves.toBeUndefined();
    await fs.rm(registryPath);
  });

  it("treats a live legacy registry as unreachable", async () => {
    const root = await createTestRoot();
    const port = await reservePort();
    const registryPath = path.join(root, ".codegraph", "server.json");
    const healthServer = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          service: "codegraph",
          schemaVersion: 2,
          pid: process.pid,
          root: root.replace(/\\/g, "/"),
          version: "test",
          startedAt: "2026-08-25T00:00:00.000Z",
          update: { restartRequired: false, runningVersion: "test" },
        }),
      );
    });
    const { promise: listening, resolve: resolveListening, reject: rejectListening } = Promise.withResolvers<void>();
    healthServer.once("error", rejectListening);
    healthServer.listen(port, "127.0.0.1", resolveListening);
    await listening;
    await writeRegistry(root, {
      schemaVersion: 1,
      pid: process.pid,
      url: "http://127.0.0.1:" + port + "/mcp",
      root: root.replace(/\\/g, "/"),
      startedAt: "2026-08-25T00:00:00.000Z",
      version: "test",
    });

    try {
      const status = await runCli(["server", "status", "--root", root, "--json"]);
      expect(status.exitCode).toBe(0);
      expect(parseJsonObject(status.stdout)).toMatchObject({
        status: "unreachable",
        reason: "Server registry predates lifecycle credentials. Stop the server manually, then start it again.",
      });
      await expect(fs.access(registryPath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(registryPath, { force: true });
      const { promise: closed, resolve: resolveClosed, reject: rejectClosed } = Promise.withResolvers<void>();
      healthServer.close((error) => {
        if (error) {
          rejectClosed(error);
        } else {
          resolveClosed();
        }
      });
      await closed;
    }
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

    const status = await runCli(["server", "status", "--root", targetRoot, "--pretty"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Remedy: verify the registry and live server identity before retrying.");

    const stop = await runCli(["server", "stop", "--root", targetRoot]);
    expect(stop.exitCode).toBe(1);
    expect(stop.stderr).toContain("identity does not match the requested root");
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

  it("refuses a registry with a different startup identity", async () => {
    const root = await createTestRoot();
    const port = await reservePort();
    const start = await runCli(["server", "start", "--root", root, "--port", String(port)]);
    expect(start.exitCode).toBe(0);
    const originalRegistry = await readRegistry(root);
    await writeRegistry(root, { ...originalRegistry, startedAt: "2026-08-25T00:00:00.000Z" });

    try {
      const status = await runCli(["server", "status", "--root", root, "--json"]);
      expect(status.exitCode).toBe(0);
      expect(parseJsonObject(status.stdout)).toMatchObject({
        status: "stale",
        reason: "Server startup time does not match the registry.",
      });

      const stop = await runCli(["server", "stop", "--root", root]);
      expect(stop.exitCode).toBe(1);
      expect(stop.stderr).toContain("identity does not match the requested root");
      const healthUrl = new URL(originalRegistry.url);
      healthUrl.pathname = "/health";
      expect((await fetch(healthUrl)).ok).toBe(true);
    } finally {
      await writeRegistry(root, originalRegistry);
    }
  });

  it("rejects subcommand options that would have no effect", async () => {
    const root = await createTestRoot();

    const status = await runCli(["server", "status", "--root", root, "--port", "9000"]);
    expect(status.exitCode).toBe(2);
    expect(status.stderr).toContain("--port is not valid for codegraph server status.");

    const stop = await runCli(["server", "stop", "--root", root, "--json"]);
    expect(stop.exitCode).toBe(2);
    expect(stop.stderr).toContain("--json is not valid for codegraph server stop.");

    const start = await runCli(["server", "start", "--root", root, "--startup-timeout-ms", "0"]);
    expect(start.exitCode).toBe(2);
    expect(start.stderr).toContain('Invalid --startup-timeout-ms value "0".');
  });

  it("does not start while another lifecycle command holds the project lock", async () => {
    const root = await createTestRoot();
    await fs.writeFile(
      path.join(root, ".codegraph-server.lock"),
      `${JSON.stringify({ owner: "test", pid: process.pid, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })}\n`,
      "utf8",
    );

    const start = await runCli(["server", "start", "--root", root, "--port", String(await reservePort())]);

    expect(start.exitCode).toBe(1);
    expect(start.stderr).toContain("Another Codegraph server lifecycle command is in progress");
    await expect(fs.access(path.join(root, ".codegraph", "server.json"))).rejects.toThrow();
  });

  it("rejects registry directories that resolve outside the project root", async (context) => {
    const root = await createTestRoot();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-mcp-server-registry-outside-"));
    const registryPath = path.join(outside, "server.json");
    const sentinel = "outside registry must remain unchanged\n";
    await fs.writeFile(registryPath, sentinel, "utf8");
    try {
      if (!(await tryCreateDirectorySymlink(outside, path.join(root, ".codegraph")))) {
        context.skip();
        return;
      }
      for (const args of [
        ["server", "status", "--root", root],
        ["server", "start", "--root", root, "--port", String(await reservePort())],
        ["server", "stop", "--root", root],
      ]) {
        const result = await runCli(args);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("registry directory resolves outside project root");
        expect(await fs.readFile(registryPath, "utf8")).toBe(sentinel);
      }
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("honors short startup timeouts without waiting for a fixed health request", async () => {
    const root = await createTestRoot();
    const startedAt = performance.now();

    const result = await runCli([
      "server",
      "start",
      "--root",
      root,
      "--port",
      String(await reservePort()),
      "--startup-timeout-ms",
      "1",
      "--warmup",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("did not become reachable");
    expect(performance.now() - startedAt).toBeLessThan(900);
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

async function runCli(args: string[], cwd = repoRoot): Promise<CliResult> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
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

async function tryCreateDirectorySymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isPlainRecord(parsed)) throw new Error("Expected JSON object.");
  return parsed;
}
