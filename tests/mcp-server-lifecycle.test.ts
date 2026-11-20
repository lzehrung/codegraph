import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlainRecord } from "../src/util/guards.js";
import { withInstallerLeaseLock } from "../src/installer/locks.js";
import { createExpiredLifecycleLease, startLifecycleLeaseHolder } from "./helpers/lifecycle-lease.js";

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

  it("describes only current lifecycle state in help", async () => {
    const help = await runCli(["help", "server"]);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("per-user Codegraph state directory");
    expect(help.stdout).not.toContain("v1 registry");
    expect(help.stdout).not.toContain("v2 registry");
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

  it("refuses lifecycle credentials rooted in the project", async () => {
    const root = await createTestRoot();
    const env = process.platform === "win32" ? { LOCALAPPDATA: root } : { XDG_STATE_HOME: root };

    const start = await runCli(
      ["server", "start", "--root", root, "--port", String(await reservePort())],
      repoRoot,
      env,
    );

    expect(start.exitCode).toBe(1);
    expect(start.stderr).toContain("lifecycle credentials must resolve outside project root");
    await expect(fs.access(path.join(root, ".codegraph", "server.json"))).rejects.toThrow();
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

  it("starts a server that accepts --no-watch", async () => {
    const root = await createTestRoot();
    const port = await reservePort();

    const start = await runCli(["server", "start", "--root", root, "--port", String(port), "--no-watch"]);

    expect(start.exitCode).toBe(0);
    expect((await readRegistry(root)).url).toBe(`http://127.0.0.1:${port}/mcp`);
  });

  it("starts a server that accepts --index-wait-ms", async () => {
    const root = await createTestRoot();
    const port = await reservePort();

    const start = await runCli(["server", "start", "--root", root, "--port", String(port), "--index-wait-ms", "5000"]);

    expect(start.exitCode).toBe(0);
    expect((await readRegistry(root)).url).toBe(`http://127.0.0.1:${port}/mcp`);
  });

  it("forwards --index-wait-ms to the server it starts, which rejects an invalid value", async () => {
    const root = await createTestRoot();
    const port = await reservePort();

    const start = await runCli(["server", "start", "--root", root, "--port", String(port), "--index-wait-ms", "soon"]);

    expect(start.exitCode).toBe(1);
    expect(start.stderr).toContain("--index-wait-ms");
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
      // The warmup runs in the background, so wait until it has written the search index, its last step, in the cache
      // directory that the caller named. Stopped sooner, the server would still hold files there.
      await vi.waitFor(
        async () => {
          const written = await fs.readdir(path.join(callerCwd, cacheDirectory), { recursive: true });
          expect(written.some((entry) => path.basename(entry) === "search-v1.sqlite")).toBe(true);
        },
        { timeout: 30_000 },
      );
      await expect(fs.access(path.join(root, cacheDirectory))).rejects.toThrow();
      const { pid } = await readRegistry(root);
      const stop = await runCli(["server", "stop", "--root", root], callerCwd);
      expect(stop.exitCode).toBe(0);
      // The server's working directory is `callerCwd`, so the directory stays busy while the process lives.
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 20_000 });
    } finally {
      // Best effort, as `createTempRootRegistry` does: a stopped server's files can stay busy a moment on Windows.
      await fs.rm(callerCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  it("reports and safely removes stale registry metadata", async () => {
    const root = await createTestRoot();
    const callerCwd = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-mcp-server-status-caller-"));
    const port = await reservePort();
    await writeRegistry(root, {
      schemaVersion: 1,
      pid: 2_147_483_647,
      url: `http://127.0.0.1:${port}/mcp`,
      root: root.replace(/\\/g, "/"),
      startedAt: "2026-08-25T00:00:00.000Z",
      version: "test",
    });

    try {
      const status = await runCli(["server", "status", "--root", root, "--json"], callerCwd);
      expect(status.exitCode).toBe(0);
      expect(parseJsonObject(status.stdout)).toMatchObject({
        status: "stale",
        requestedRoot: root.replace(/\\/g, "/"),
        safeToRemove: true,
        reason: "Server process is not running.",
      });

      const formattedStatus = await runCli(["server", "status", "--root", root, "--pretty"], callerCwd);
      expect(formattedStatus.exitCode).toBe(0);
      expect(formattedStatus.stdout).toContain("Status: stale");
      expect(formattedStatus.stdout).toContain(
        `Remedy: run codegraph server stop --root ${JSON.stringify(root.replace(/\\/g, "/"))}`,
      );

      const stop = await runCli(["server", "stop", "--root", root], callerCwd);
      expect(stop.exitCode).toBe(0);
      expect(stop.stdout).toContain("Removed stale Codegraph server registry.");
      await expect(fs.access(path.join(root, ".codegraph", "server.json"))).rejects.toThrow();
    } finally {
      await fs.rm(callerCwd, { recursive: true, force: true });
    }
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

  it("keeps lifecycle credentials isolated by root", async () => {
    const serverRoot = await createTestRoot();
    const forgedRoot = await createTestRoot();
    const start = await runCli(["server", "start", "--root", serverRoot, "--port", String(await reservePort())]);
    expect(start.exitCode).toBe(0);
    const serverRegistry = await readRegistry(serverRoot);
    if (!serverRegistry.credentialId) throw new Error("Expected a lifecycle credential.");

    await writeRegistry(forgedRoot, {
      ...serverRegistry,
      pid: 2_147_483_647,
      url: `http://127.0.0.1:${await reservePort()}/mcp`,
      root: forgedRoot.replace(/\\/g, "/"),
    });

    const staleStop = await runCli(["server", "stop", "--root", forgedRoot]);
    expect(staleStop.exitCode).toBe(0);
    expect(staleStop.stdout).toContain("Removed stale Codegraph server registry.");

    const liveStop = await runCli(["server", "stop", "--root", serverRoot]);
    expect(liveStop.exitCode).toBe(0);
    expect(liveStop.stdout).toContain("Stopped Codegraph server");
  });

  it("rejects a server registry with a credential from another root", async () => {
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
    expect(status.stdout).toContain("Status: unreachable");

    const stop = await runCli(["server", "stop", "--root", targetRoot]);
    expect(stop.exitCode).toBe(1);
    expect(stop.stderr).toContain("health endpoint is temporarily unavailable");
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
        safeToRemove: false,
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
        safeToRemove: false,
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
      `${JSON.stringify({
        owner: "test",
        pid: process.pid,
        host: os.hostname(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })}\n`,
      "utf8",
    );

    const start = await runCli(["server", "start", "--root", root, "--port", String(await reservePort())]);

    expect(start.exitCode).toBe(1);
    expect(start.stderr).toContain("Another Codegraph server lifecycle command is in progress");
    await expect(fs.access(path.join(root, ".codegraph", "server.json"))).rejects.toThrow();
  });

  it("reclaims a hard-killed local lifecycle holder before its lease expires when stopping", async () => {
    const root = await createTestRoot();
    const holder = await startLifecycleLeaseHolder(root);
    try {
      const lockPath = path.join(root, ".codegraph-server.lock");
      const lease = parseJsonObject(await fs.readFile(lockPath, "utf8"));
      expect(lease).toMatchObject({ pid: holder.pid, host: os.hostname(), platform: process.platform });
      if (process.platform === "linux") {
        expect(lease.pidNamespace).toBe(await fs.readlink("/proc/self/ns/pid"));
        expect(lease.bootId).toBe((await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim());
      }
      await holder.kill();

      const stopped = await runCli(["server", "stop", "--root", root]);

      expect(stopped.exitCode, stopped.stderr).toBe(0);
      expect(stopped.stdout).toContain("No Codegraph server registry exists");
      expect(Date.parse(String(lease.leaseExpiresAt))).toBeGreaterThan(Date.now());
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await holder.kill();
    }
  });

  it.for([
    { kind: "foreign host", key: "host", value: `${os.hostname()}-other` },
    { kind: "legacy without host", key: "host", value: undefined },
    { kind: "foreign platform", key: "platform", value: process.platform === "win32" ? "linux" : "win32" },
    { kind: "legacy without platform", key: "platform", value: undefined },
    { kind: "foreign PID namespace", key: "pidNamespace", value: "pid:[foreign]" },
    { kind: "legacy without PID namespace", key: "pidNamespace", value: undefined },
    { kind: "foreign Linux boot", key: "bootId", value: "foreign-boot" },
    { kind: "legacy without Linux boot", key: "bootId", value: undefined },
  ] as const)("retains an unexpired dead lease from a $kind", async ({ kind, key, value }, context) => {
    const requiresLinux = kind === "legacy without PID namespace" || kind === "legacy without Linux boot";
    if (requiresLinux && process.platform !== "linux") {
      context.skip();
      return;
    }
    const root = await createTestRoot();
    const holder = await startLifecycleLeaseHolder(root);
    const lockPath = path.join(root, ".codegraph-server.lock");
    const lease = parseJsonObject(await fs.readFile(lockPath, "utf8"));
    await holder.kill();
    if (value === undefined) delete lease[key];
    else lease[key] = value;
    lease.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const metadata = JSON.stringify(lease);
    await fs.writeFile(lockPath, metadata);
    try {
      const stopped = await runCli(["server", "stop", "--root", root]);
      expect(stopped.exitCode).toBe(1);
      expect(stopped.stderr).toContain("Another Codegraph server lifecycle command is in progress");
      expect(await fs.readFile(lockPath, "utf8")).toBe(metadata);
    } finally {
      await fs.rm(lockPath);
    }
  });

  it.each(["expired", "unexpired"])("keeps a stale claim until its %s lease is eligible for expiry", async (kind) => {
    const root = await createTestRoot();
    const holder = await startLifecycleLeaseHolder(root);
    const lockPath = path.join(root, ".codegraph-server.lock");
    const lease = parseJsonObject(await fs.readFile(lockPath, "utf8"));
    await holder.kill();
    lease.leaseExpiresAt = new Date(Date.now() + (kind === "expired" ? -1 : 60_000)).toISOString();
    const metadata = `${JSON.stringify(lease)}\n`;
    await fs.writeFile(lockPath, metadata);
    const oldMtime = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, oldMtime, oldMtime);
    const claimPath = `${lockPath}.reclaim-dead-${createHash("sha256").update(metadata).digest("hex")}`;
    await fs.link(lockPath, claimPath);
    const operation = vi.fn(async () => "acquired");
    try {
      const acquired = withInstallerLeaseLock(lockPath, "stale recovery claim", operation, {
        reclaimDeadLocalOwner: true,
      });
      if (kind === "unexpired") {
        await expect(acquired).rejects.toThrow("Another Codegraph installer");
        expect(operation).not.toHaveBeenCalled();
        expect(await fs.readFile(lockPath, "utf8")).toBe(metadata);
        expect(await fs.readFile(claimPath, "utf8")).toBe(metadata);
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(String(lease.leaseExpiresAt)) + 1);
        try {
          await withInstallerLeaseLock(lockPath, "expiry after a blocking claim", operation, {
            reclaimDeadLocalOwner: true,
          });
        } finally {
          clock.mockRestore();
        }
      } else {
        await expect(acquired).resolves.toBe("acquired");
      }
      expect(operation).toHaveBeenCalledOnce();
      await expect(fs.access(lockPath)).rejects.toThrow();
      await expect(fs.access(claimPath)).rejects.toThrow();
    } finally {
      await fs.rm(lockPath, { force: true });
      await fs.rm(claimPath, { force: true });
    }
  });

  it("keeps expiry recovery compatible with inode identifiers that change across rename", async () => {
    const root = await createTestRoot();
    const { lockPath } = await createExpiredLifecycleLease(root);
    const originalLstat = fs.lstat.bind(fs);
    let detachedChecks = 0;
    const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
      const stats = await originalLstat(candidate, options as { bigint: true });
      if (String(candidate).startsWith(`${lockPath}.reclaim-`)) {
        detachedChecks += 1;
        const alternateInode = Number(stats.ino) === 1 ? 2 : 1;
        Object.defineProperty(stats, "ino", { value: alternateInode });
      }
      return stats;
    });
    const operation = vi.fn(async () => "acquired");
    try {
      await expect(withInstallerLeaseLock(lockPath, "unstable inode expiry", operation)).resolves.toBe("acquired");
      expect(detachedChecks).toBe(1);
      expect(operation).toHaveBeenCalledOnce();
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      lstat.mockRestore();
    }
  });

  it("keeps the expiry winner when claim cleanup races a live claimant", async () => {
    const root = await createTestRoot();
    const holder = await startLifecycleLeaseHolder(root);
    const lockPath = path.join(root, ".codegraph-server.lock");
    const originalMetadata = await fs.readFile(lockPath, "utf8");
    const original = parseJsonObject(originalMetadata);
    const claimPath = `${lockPath}.reclaim-dead-${createHash("sha256").update(originalMetadata).digest("hex")}`;
    await holder.kill();
    const contexts = new AsyncLocalStorage<string>();
    const stalled = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const expiryEntered = Promise.withResolvers<void>();
    const releaseExpiry = Promise.withResolvers<void>();
    const claimCleanup = Promise.withResolvers<void>();
    const resumeCleanup = Promise.withResolvers<void>();
    let paused = false;
    let entries = 0;
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (contexts.getStore() === "early" && String(source) === lockPath && !paused) {
        paused = true;
        stalled.resolve();
        await resume.promise;
      }
      await originalRename(source, destination);
    });
    const originalUnlink = fs.unlink.bind(fs);
    const unlink = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      // The old blind-unlink path must reach the same barrier in the counterfactual regression.
      if (contexts.getStore() === "early" && String(candidate) === lockPath && !paused) {
        paused = true;
        stalled.resolve();
        await resume.promise;
      }
      await originalUnlink(candidate);
    });
    const originalRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (candidate, options) => {
      if (contexts.getStore() === "expiry" && String(candidate) === claimPath) {
        claimCleanup.resolve();
        await resumeCleanup.promise;
      }
      await originalRm(candidate, options);
    });
    const clock = vi.spyOn(Date, "now");
    const earlyOperation = vi.fn(async () => {
      entries += 1;
    });
    const early = contexts.run("early", () =>
      withInstallerLeaseLock(lockPath, "stalled claimed detach", earlyOperation, { reclaimDeadLocalOwner: true }),
    );
    const earlySettled = Promise.allSettled([early]);
    let expiry: Promise<void> | undefined;
    try {
      await stalled.promise;
      // Keep the exact bytes and claim hash while making this lease eligible for normal expiry.
      clock.mockReturnValue(Date.parse(String(original.leaseExpiresAt)) + 1);
      expiry = contexts.run("expiry", () =>
        withInstallerLeaseLock(
          lockPath,
          "expiry contender",
          async () => {
            entries += 1;
            expiryEntered.resolve();
            await releaseExpiry.promise;
          },
          { reclaimDeadLocalOwner: true },
        ),
      );
      const checkpoint = await Promise.race([
        claimCleanup.promise.then(() => "cleanup"),
        expiryEntered.promise.then(() => "entered"),
      ]);
      expect(checkpoint).toBe("cleanup");
      expect(await fs.readFile(claimPath, "utf8")).toBe(originalMetadata);
      resumeCleanup.resolve();
      await expiryEntered.promise;
      const ownedMetadata = await fs.readFile(lockPath, "utf8");
      expect(parseJsonObject(ownedMetadata).owner).not.toBe(original.owner);
      await expect(fs.access(claimPath)).rejects.toThrow();
      resume.resolve();
      expect((await earlySettled)[0].status).toBe("rejected");
      const thirdOperation = vi.fn(async () => {
        entries += 1;
      });
      await expect(
        withInstallerLeaseLock(lockPath, "third contender", thirdOperation, { reclaimDeadLocalOwner: true }),
      ).rejects.toThrow("Another Codegraph installer");
      expect(entries).toBe(1);
      expect(earlyOperation).not.toHaveBeenCalled();
      expect(thirdOperation).not.toHaveBeenCalled();
      expect(await fs.readFile(lockPath, "utf8")).toBe(ownedMetadata);
    } finally {
      resume.resolve();
      resumeCleanup.resolve();
      releaseExpiry.resolve();
      await Promise.allSettled([early, ...(expiry ? [expiry] : [])]);
      rename.mockRestore();
      unlink.mockRestore();
      rm.mockRestore();
      clock.mockRestore();
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("does not delete a replacement claim when two stale-claim contenders cross", async () => {
    const root = await createTestRoot();
    const { lockPath, metadata } = await createExpiredLifecycleLease(root);
    const claimPath = `${lockPath}.reclaim-dead-${createHash("sha256").update(metadata).digest("hex")}`;
    const oldMtime = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, oldMtime, oldMtime);
    await fs.link(lockPath, claimPath);
    const contexts = new AsyncLocalStorage<string>();
    const secondPaused = Promise.withResolvers<void>();
    const resumeSecond = Promise.withResolvers<void>();
    const firstReady = Promise.withResolvers<void>();
    const resumeFirst = Promise.withResolvers<void>();
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const thirdEntered = Promise.withResolvers<void>();
    const releaseThird = Promise.withResolvers<void>();
    let paused = false;
    let initialClaim = true;
    let owners = 0;
    let maxOwners = 0;
    const originalLstat = fs.lstat.bind(fs);
    const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
      const stats = await originalLstat(candidate, options as { bigint: true });
      if (String(candidate) === claimPath && initialClaim) {
        // Age only the original claim in the retirement counterfactual; fresh claims keep their real ctime.
        Object.defineProperty(stats, "ctimeMs", { value: Date.now() - 60_000 });
      }
      return stats;
    });
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (contexts.getStore() === "second" && String(source) === lockPath && !paused) {
        paused = true;
        secondPaused.resolve();
        await resumeSecond.promise;
      }
      await originalRename(source, destination);
    });
    const originalUnlink = fs.unlink.bind(fs);
    const unlink = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      const actor = contexts.getStore();
      if (actor === "second" && String(candidate) === claimPath && !paused) {
        paused = true;
        secondPaused.resolve();
        await resumeSecond.promise;
      }
      if (actor === "first" && String(candidate) === claimPath) initialClaim = false;
      if (actor === "first" && String(candidate) === lockPath) {
        firstReady.resolve();
        await resumeFirst.promise;
      }
      await originalUnlink(candidate);
    });
    const secondOperation = vi.fn(async () => undefined);
    const second = contexts.run("second", () =>
      withInstallerLeaseLock(lockPath, "second stale contender", secondOperation, { reclaimDeadLocalOwner: true }),
    );
    const secondSettled = Promise.allSettled([second]);
    let first: Promise<void> | undefined;
    let third: Promise<void> | undefined;
    try {
      await secondPaused.promise;
      first = contexts.run("first", () =>
        withInstallerLeaseLock(
          lockPath,
          "first stale contender",
          async () => {
            owners += 1;
            maxOwners = Math.max(maxOwners, owners);
            firstReady.resolve();
            firstEntered.resolve();
            try {
              await releaseFirst.promise;
            } finally {
              owners -= 1;
            }
          },
          { reclaimDeadLocalOwner: true },
        ),
      );
      await firstReady.promise;
      resumeSecond.resolve();
      await secondSettled;
      third = withInstallerLeaseLock(
        lockPath,
        "third stale contender",
        async () => {
          owners += 1;
          maxOwners = Math.max(maxOwners, owners);
          thirdEntered.resolve();
          try {
            await releaseThird.promise;
          } finally {
            owners -= 1;
          }
        },
        { reclaimDeadLocalOwner: true },
      );
      const thirdSettled = Promise.allSettled([third]);
      const transition = await Promise.race([
        thirdEntered.promise.then(() => "entered"),
        thirdSettled.then(() => "settled"),
      ]);
      resumeFirst.resolve();
      await firstEntered.promise;
      expect(transition).toBe("settled");
      expect((await secondSettled)[0].status).toBe("rejected");
      expect((await thirdSettled)[0].status).toBe("rejected");
      expect(secondOperation).not.toHaveBeenCalled();
      expect(maxOwners).toBe(1);
      expect(parseJsonObject(await fs.readFile(lockPath, "utf8")).pid).toBe(process.pid);
    } finally {
      resumeSecond.resolve();
      resumeFirst.resolve();
      releaseFirst.resolve();
      releaseThird.resolve();
      await Promise.allSettled([second, ...(first ? [first] : []), ...(third ? [third] : [])]);
      lstat.mockRestore();
      rename.mockRestore();
      unlink.mockRestore();
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("serializes a barrier of unexpired dead-holder claims", async () => {
    const root = await createTestRoot();
    const { lockPath, metadata: expiredMetadata } = await createExpiredLifecycleLease(root);
    const lease = parseJsonObject(expiredMetadata);
    lease.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const metadata = `${JSON.stringify(lease)}\n`;
    await fs.writeFile(lockPath, metadata);
    const claimPath = `${lockPath}.reclaim-dead-${createHash("sha256").update(metadata).digest("hex")}`;
    const contexts = new AsyncLocalStorage<number>();
    const ready = new Set<number>();
    const barrier = Promise.withResolvers<void>();
    let activeOwners = 0;
    let maxOwners = 0;
    let entries = 0;
    const originalLink = fs.link.bind(fs);
    const link = vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
      const contender = contexts.getStore();
      if (contender !== undefined && String(destination) === claimPath && !ready.has(contender)) {
        ready.add(contender);
        if (ready.size === 8) barrier.resolve();
        await barrier.promise;
      }
      await originalLink(source, destination);
    });
    const contenders = Array.from({ length: 8 }, (_, contender) =>
      contexts.run(contender, () =>
        withInstallerLeaseLock(
          lockPath,
          "expired barrier race",
          async () => {
            activeOwners += 1;
            maxOwners = Math.max(maxOwners, activeOwners);
            entries += 1;
            try {
              const owned = await fs.readFile(lockPath, "utf8");
              await nextTurn();
              expect(await fs.readFile(lockPath, "utf8")).toBe(owned);
            } finally {
              activeOwners -= 1;
            }
          },
          { reclaimDeadLocalOwner: true },
        ),
      ),
    );
    try {
      await Promise.all(contenders);
      expect(ready.size).toBe(8);
      expect(entries).toBe(8);
      expect(maxOwners).toBe(1);
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      barrier.resolve();
      await Promise.allSettled(contenders);
      link.mockRestore();
    }
  });

  it("retains an unexpired lease when the PID probe is denied", async () => {
    const root = await createTestRoot();
    const holder = await startLifecycleLeaseHolder(root);
    const lockPath = path.join(root, ".codegraph-server.lock");
    const metadata = await fs.readFile(lockPath, "utf8");
    await holder.kill();
    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === holder.pid && signal === 0) {
        throw Object.assign(new Error("PID probe denied"), { code: "EPERM" });
      }
      return originalKill(pid, signal);
    });
    const operation = vi.fn(async () => "acquired");
    try {
      await expect(
        withInstallerLeaseLock(lockPath, "denied PID probe", operation, { reclaimDeadLocalOwner: true }),
      ).rejects.toThrow("Another Codegraph installer");
      expect(kill).toHaveBeenCalledWith(holder.pid, 0);
      expect(operation).not.toHaveBeenCalled();
      expect(await fs.readFile(lockPath, "utf8")).toBe(metadata);
    } finally {
      kill.mockRestore();
      await fs.rm(lockPath);
    }
  });

  it("retains a lease naming a live unrelated PID as a PID-reuse stand-in", async () => {
    const holderRoot = await createTestRoot();
    const root = await createTestRoot();
    const holder = await startLifecycleLeaseHolder(holderRoot);
    const lockPath = path.join(root, ".codegraph-server.lock");
    const lease = parseJsonObject(await fs.readFile(path.join(holderRoot, ".codegraph-server.lock"), "utf8"));
    lease.owner = "previous-unrelated-owner";
    lease.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const metadata = JSON.stringify(lease);
    await fs.writeFile(lockPath, metadata);
    try {
      const stopped = await runCli(["server", "stop", "--root", root]);
      expect(stopped.exitCode).toBe(1);
      expect(stopped.stderr).toContain("Another Codegraph server lifecycle command is in progress");
      expect(process.kill(holder.pid, 0)).toBe(true);
      expect(await fs.readFile(lockPath, "utf8")).toBe(metadata);
    } finally {
      await holder.kill();
      await fs.rm(lockPath);
    }
  });

  it("admits only one concurrent reclaimer while its replacement lifecycle lease is held", async () => {
    const root = await createTestRoot();
    const holder = await startLifecycleLeaseHolder(root);
    await holder.kill();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let owners = 0;
    const contend = () =>
      withInstallerLeaseLock(
        path.join(root, ".codegraph-server.lock"),
        "concurrent lifecycle recovery",
        async () => {
          owners += 1;
          entered.resolve();
          await release.promise;
          return "acquired";
        },
        { reclaimDeadLocalOwner: true },
      ).catch((error: unknown) => String(error));
    const contenders = [contend(), contend()];
    try {
      await entered.promise;
      await expect(Promise.race(contenders)).resolves.toContain("Another Codegraph installer");
      expect(owners).toBe(1);
    } finally {
      release.resolve();
      await Promise.all(contenders);
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("uses stable nonzero hard-link identity while reclaiming a lifecycle lease", async () => {
    const root = await createTestRoot();
    const holder = await startLifecycleLeaseHolder(root);
    await holder.kill();
    const lockPath = path.join(root, ".codegraph-server.lock");
    const identities: Array<{ claim: number; published: number; sameDevice: boolean }> = [];
    const originalLink = fs.link.bind(fs);
    const link = vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
      await originalLink(source, destination);
      if (!String(destination).includes(".reclaim-dead-")) return;
      const claim = await fs.lstat(destination);
      const published = await fs.lstat(lockPath);
      identities.push({ claim: claim.ino, published: published.ino, sameDevice: claim.dev === published.dev });
    });
    try {
      await expect(
        withInstallerLeaseLock(lockPath, "nonzero file identity", async () => "acquired", {
          reclaimDeadLocalOwner: true,
        }),
      ).resolves.toBe("acquired");
      expect(identities).toHaveLength(1);
      expect(identities[0].claim).not.toBe(0);
      expect(identities[0].published).toBe(identities[0].claim);
      expect(identities[0].sameDevice).toBe(true);
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      link.mockRestore();
    }
  });

  it.each(["unchanged", "changed content"])("verifies %s through the zero-inode fallback", async (kind) => {
    const root = await createTestRoot();
    const holder = await startLifecycleLeaseHolder(root);
    await holder.kill();
    const lockPath = path.join(root, ".codegraph-server.lock");
    const metadata = await fs.readFile(lockPath, "utf8");
    const observedMtime = (await fs.lstat(lockPath)).mtimeMs;
    let zeroInodeReads = 0;
    let changed = false;
    const originalLstat = fs.lstat.bind(fs);
    const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
      const stats = await originalLstat(candidate, options as { bigint: true });
      const isClaim = String(candidate).startsWith(`${lockPath}.reclaim-dead-`);
      if (String(candidate) !== lockPath && !isClaim) return stats;
      zeroInodeReads += 1;
      Object.defineProperty(stats, "ino", { value: 0 });
      Object.defineProperty(stats, "mtimeMs", { value: observedMtime });
      if (isClaim && kind === "changed content" && !changed) {
        changed = true;
        await fs.writeFile(candidate, metadata.replace('"owner":', '"OWNER":'));
      }
      return stats;
    });
    const operation = vi.fn(async () => "acquired");
    try {
      const acquired = withInstallerLeaseLock(lockPath, "zero file identity", operation, {
        reclaimDeadLocalOwner: true,
      });
      if (kind === "unchanged") {
        await expect(acquired).resolves.toBe("acquired");
        expect(operation).toHaveBeenCalledOnce();
        await expect(fs.access(lockPath)).rejects.toThrow();
      } else {
        await expect(acquired).rejects.toThrow("existing lock");
        expect(operation).not.toHaveBeenCalled();
        expect(await fs.readFile(lockPath, "utf8")).toBe(metadata.replace('"owner":', '"OWNER":'));
      }
      expect(zeroInodeReads).toBeGreaterThanOrEqual(2);
      expect((await fs.readdir(root)).some((name) => name.includes(".reclaim-dead-"))).toBe(false);
    } finally {
      lstat.mockRestore();
      await fs.rm(lockPath, { force: true });
    }
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

async function runCli(args: string[], cwd = repoRoot, env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
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
