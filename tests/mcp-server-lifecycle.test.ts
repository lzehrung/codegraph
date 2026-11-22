import { setImmediate as nextTurn } from "node:timers/promises";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlainRecord } from "../src/util/guards.js";
import { lifecycleKernelLockPath, withInstallerLeaseLock } from "../src/installer/locks.js";
import { loadBinding } from "../src/native/runtime.js";
import {
  createExpiredLifecycleLease,
  startLifecycleLeaseHolder,
  type LifecycleLeaseHolder,
} from "./helpers/lifecycle-lease.js";

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
    await fs.rm(await lifecycleKernelLockPath(root), { force: true });
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

  it.each(["plain", "initialized"])("adds no untracked lock path in a %s Git project", async (kind) => {
    const root = await createTestRoot();
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    const created = git("init", "--quiet");
    expect(created.status, created.stderr).toBe(0);
    if (kind === "initialized") {
      await fs.writeFile(path.join(root, "sample.ts"), "export const value = 1;\n");
      const initialized = await runCli(["init", "--root", root]);
      expect(initialized.exitCode, initialized.stderr).toBe(0);
    }
    const before = git("status", "--porcelain", "--untracked-files=all");
    expect(before.status, before.stderr).toBe(0);
    const stopped = await runCli(["server", "stop", "--root", root]);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    const after = git("status", "--porcelain", "--untracked-files=all");
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toBe(before.stdout);
    expect((await fs.stat(await lifecycleKernelLockPath(root))).isFile()).toBe(true);
  });

  it("falls back to a renewable lease when the state root is not a directory", async () => {
    const root = await createTestRoot();
    const stateRoot = path.join(root, "not-a-directory");
    await fs.writeFile(stateRoot, "unchanged");
    const stateVariable = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_STATE_HOME";
    const stateEnv = { [stateVariable]: stateRoot };
    const stopped = await runCli(["server", "stop", "--root", root], repoRoot, { ...stateEnv, NODE_DEBUG: "" });
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain("No Codegraph server registry exists");
    expect(stopped.stderr).not.toContain("using renewable lease only");
    const debug = await runCli(["server", "stop", "--root", root], repoRoot, {
      ...stateEnv,
      NODE_DEBUG: "codegraph",
    });
    expect(debug.exitCode, debug.stderr).toBe(0);
    expect(debug.stdout).toContain("No Codegraph server registry exists");
    expect(debug.stderr.match(/using renewable lease only/gu)).toHaveLength(1);
    expect(await fs.readFile(stateRoot, "utf8")).toBe("unchanged");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["existing", "missing"])(
    "stops with a read-only state directory and %s anchor",
    async (kind) => {
      const root = await createTestRoot();
      const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-readonly-state-"));
      const stateEnv = { XDG_STATE_HOME: stateRoot, NODE_DEBUG: "codegraph" };
      const digest = createHash("sha256")
        .update(await fs.realpath(root))
        .digest("hex");
      const directory = path.join(stateRoot, "codegraph", "server-locks");
      const anchor = path.join(directory, `${digest}.lock`);
      await fs.mkdir(directory, { recursive: true });
      if (kind === "existing") {
        await fs.writeFile(anchor, "");
        await fs.chmod(anchor, 0o444);
      }
      await fs.chmod(directory, 0o555);
      try {
        if (kind === "existing") {
          const state = loadBinding();
          if (!state.loaded || !state.binding.tryLockExclusive) throw new Error("Native kernel locks are required.");
          const held = state.binding.tryLockExclusive(anchor);
          if (!held) throw new Error("Expected the read-only anchor lock to succeed.");
          try {
            const busy = await runCli(["server", "stop", "--root", root], repoRoot, stateEnv);
            expect(busy.exitCode).toBe(1);
            expect(busy.stderr).toContain("Another Codegraph server lifecycle command is in progress");
          } finally {
            held.unlock();
          }
        }
        const stopped = await runCli(["server", "stop", "--root", root], repoRoot, stateEnv);
        expect(stopped.exitCode, stopped.stderr).toBe(0);
        expect(stopped.stdout).toContain("No Codegraph server registry exists");
        if (kind === "missing") expect(stopped.stderr).toContain("using renewable lease only");
        else expect(stopped.stderr).not.toContain("using renewable lease only");
      } finally {
        await fs.chmod(directory, 0o700);
        await fs.rm(stateRoot, { recursive: true, force: true });
      }
    },
  );

  it.each(["invalid expiry", "directory"])("omits the expiry remedy for a blocked %s lock", async (kind) => {
    const root = await createTestRoot();
    const lockPath = path.join(root, ".codegraph-server.lock");
    if (kind === "directory") await fs.mkdir(lockPath);
    else
      await fs.writeFile(lockPath, JSON.stringify({ owner: "blocked", pid: process.pid, leaseExpiresAt: "invalid" }));
    try {
      const stopped = await runCli(["server", "stop", "--root", root]);
      expect(stopped.exitCode).toBe(1);
      expect(stopped.stderr).toContain("remove the lock file and retry");
      expect(stopped.stderr).not.toContain("Wait for the lease to expire");
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  });

  it("uses one lifecycle anchor for aliases of the same physical root", async () => {
    const root = await createTestRoot();
    const alias = `${root}-alias`;
    await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      const anchor = await lifecycleKernelLockPath(root);
      expect(await lifecycleKernelLockPath(alias)).toBe(anchor);
      if (process.platform === "win32") expect(await lifecycleKernelLockPath(root.toUpperCase())).toBe(anchor);
    } finally {
      await fs.rm(alias, { force: true });
    }
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
    expect(start.stderr).toContain(path.join(root, ".codegraph-server.lock").replaceAll("\\", "/"));
    expect(start.stderr).toContain(`Holder: PID ${process.pid}`);
    expect(start.stderr).toContain("remove the lock file and retry");
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

  it("keeps a live holder exclusive even when its lease has expired", async () => {
    const root = await createTestRoot();
    const holder = await startLifecycleLeaseHolder(root);
    const lockPath = path.join(root, ".codegraph-server.lock");
    try {
      const lease = parseJsonObject(await fs.readFile(lockPath, "utf8"));
      lease.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString();
      const metadata = JSON.stringify(lease);
      await fs.writeFile(lockPath, metadata);
      const stopped = await runCli(["server", "stop", "--root", root]);
      expect(stopped.exitCode).toBe(1);
      expect(stopped.stderr).toContain("Another Codegraph server lifecycle command is in progress");
      expect(await fs.readFile(lockPath, "utf8")).toBe(metadata);
      expect(process.kill(holder.pid, 0)).toBe(true);
    } finally {
      await holder.kill();
    }
  });

  it("uses renewed leases between processes with different state roots", async () => {
    const root = await createTestRoot();
    const states = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-distinct-lock-state-"));
    const stateVariable = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_STATE_HOME";
    const holderEnv = { [stateVariable]: path.join(states, "holder") };
    const contenderEnv = { [stateVariable]: path.join(states, "contender") };
    const lockPath = path.join(root, ".codegraph-server.lock");
    let holder: LifecycleLeaseHolder | undefined;
    try {
      holder = await startLifecycleLeaseHolder(root, { env: holderEnv });
      const metadata = await fs.readFile(lockPath, "utf8");
      const parsed = parseJsonObject(metadata);
      expect(typeof parsed.kernelId).toBe("string");
      const live = await runCli(["server", "stop", "--root", root], repoRoot, contenderEnv);
      expect(live.exitCode).toBe(1);
      expect(live.stderr).toContain("Another Codegraph server lifecycle command is in progress");
      const retained = parseJsonObject(await fs.readFile(lockPath, "utf8"));
      expect(retained.owner).toBe(parsed.owner);
      expect(retained.kernelId).toBe(parsed.kernelId);
      expect(process.kill(holder.pid, 0)).toBe(true);

      await holder.kill();
      const deadMetadata = await fs.readFile(lockPath, "utf8");
      const unexpired = await runCli(["server", "stop", "--root", root], repoRoot, contenderEnv);
      expect(unexpired.exitCode).toBe(1);
      expect(await fs.readFile(lockPath, "utf8")).toBe(deadMetadata);
      const deadLease = parseJsonObject(deadMetadata);
      deadLease.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString();
      await fs.writeFile(lockPath, JSON.stringify(deadLease));
      const expired = await runCli(["server", "stop", "--root", root], repoRoot, contenderEnv);
      expect(expired.exitCode, expired.stderr).toBe(0);
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await holder?.kill();
      await fs.rm(states, { recursive: true, force: true });
    }
  });

  it("waits for expiry when a local kernel lease lacks an anchor identity", async () => {
    const root = await createTestRoot();
    const { lockPath, metadata } = await createExpiredLifecycleLease(root);
    const lease = parseJsonObject(metadata);
    expect(lease.kernelLock).toBe(true);
    delete lease.kernelId;
    lease.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const unexpired = JSON.stringify(lease);
    await fs.writeFile(lockPath, unexpired);
    const blocked = await runCli(["server", "stop", "--root", root]);
    expect(blocked.exitCode).toBe(1);
    expect(await fs.readFile(lockPath, "utf8")).toBe(unexpired);
    lease.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString();
    await fs.writeFile(lockPath, JSON.stringify(lease));
    const recovered = await runCli(["server", "stop", "--root", root]);
    expect(recovered.exitCode, recovered.stderr).toBe(0);
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("recognizes a canonical state-directory alias for immediate recovery", async () => {
    const root = await createTestRoot();
    const states = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-alias-lock-state-"));
    const stateVariable = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_STATE_HOME";
    const realState = path.join(states, "real");
    const aliasState = path.join(states, "alias");
    let holder: LifecycleLeaseHolder | undefined;
    try {
      await fs.mkdir(realState);
      await fs.symlink(realState, aliasState, process.platform === "win32" ? "junction" : "dir");
      holder = await startLifecycleLeaseHolder(root, { env: { [stateVariable]: realState } });
      await holder.kill();
      const stopped = await runCli(["server", "stop", "--root", root], repoRoot, { [stateVariable]: aliasState });
      expect(stopped.exitCode, stopped.stderr).toBe(0);
      await expect(fs.access(path.join(root, ".codegraph-server.lock"))).rejects.toThrow();
    } finally {
      await holder?.kill();
      await fs.rm(states, { recursive: true, force: true });
    }
  });

  it.each(["kernel", "lease-only"])("renews %s lifecycle lease metadata while held", async (mode) => {
    const root = await createTestRoot();
    const lockPath = path.join(root, ".codegraph-server.lock");
    const blocker = path.join(root, "state-blocker");
    if (mode === "lease-only") await fs.writeFile(blocker, "not a directory");
    const options = mode === "lease-only" ? { kernelPath: path.join(blocker, "anchor") } : undefined;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const holder = withInstallerLeaseLock(
      lockPath,
      "renewal test holder",
      async () => {
        entered.resolve();
        await release.promise;
      },
      options,
    );
    try {
      await entered.promise;
      const initial = parseJsonObject(await fs.readFile(lockPath, "utf8"));
      if (mode === "kernel") expect(initial.kernelLock).toBe(true);
      else {
        expect(initial).not.toHaveProperty("kernelLock");
        expect(initial).not.toHaveProperty("kernelId");
      }
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(async () => {
        const renewed = parseJsonObject(await fs.readFile(lockPath, "utf8"));
        expect(Date.parse(String(renewed.leaseExpiresAt))).toBeGreaterThan(Date.parse(String(initial.leaseExpiresAt)));
      });
    } finally {
      release.resolve();
      await holder;
      vi.useRealTimers();
    }
  });

  it("does not reclaim a live lease-only holder with an available kernel anchor", async () => {
    const root = await createTestRoot();
    const blocker = path.join(root, "state-blocker");
    await fs.writeFile(blocker, "not a directory");
    const lockPath = path.join(root, ".codegraph-server.lock");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withInstallerLeaseLock(
      lockPath,
      "lease-only holder",
      async () => {
        entered.resolve();
        await release.promise;
      },
      { kernelPath: path.join(blocker, "anchor") },
    );
    const contender = vi.fn(async () => undefined);
    try {
      await entered.promise;
      await expect(withInstallerLeaseLock(lockPath, "kernel contender", contender)).rejects.toThrow(
        "Another Codegraph installer",
      );
      expect(contender).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await holder;
    }
  });

  it("does not hide native lock failures after the anchor was opened", async () => {
    const root = await createTestRoot();
    const state = loadBinding();
    if (!state.loaded || !state.binding.tryLockExclusive) throw new Error("Native kernel locks are required.");
    const nativeLock = vi.spyOn(state.binding, "tryLockExclusive").mockImplementation(() => {
      throw Object.assign(new Error("Kernel lock failed"), { code: "CODEGRAPH_LOCK_IO_FAILED" });
    });
    const operation = vi.fn(async () => undefined);
    try {
      await expect(
        withInstallerLeaseLock(path.join(root, ".codegraph-server.lock"), "lock failure", operation),
      ).rejects.toThrow("Kernel lock failed");
      expect(operation).not.toHaveBeenCalled();
    } finally {
      nativeLock.mockRestore();
    }
  });

  it.each(["host", "platform", "pidNamespace", "bootId"])(
    "reclaims an expired lease with a foreign %s",
    async (field) => {
      const root = await createTestRoot();
      const { lockPath, metadata: previous } = await createExpiredLifecycleLease(root);
      const lease = parseJsonObject(previous);
      lease[field] = field === "platform" && process.platform !== "win32" ? "win32" : "foreign";
      await fs.writeFile(lockPath, JSON.stringify(lease));
      const stopped = await runCli(["server", "stop", "--root", root]);
      expect(stopped.exitCode, stopped.stderr).toBe(0);
      await expect(fs.access(lockPath)).rejects.toThrow();
    },
  );

  it("keeps a delayed stale observer from racing a replacement", async () => {
    const root = await createTestRoot();
    const { lockPath } = await createExpiredLifecycleLease(root);
    const observed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const firstBlocked = Promise.withResolvers<void>();
    const secondBlocked = Promise.withResolvers<void>();
    const state = loadBinding();
    if (!state.loaded || !state.binding.tryLockExclusive) throw new Error("Native kernel locks are required.");
    const tryLockExclusive = state.binding.tryLockExclusive;
    let blockedAttempts = 0;
    const nativeLock = vi.spyOn(state.binding, "tryLockExclusive").mockImplementation((file) => {
      const lock = tryLockExclusive(file);
      if (!lock) {
        blockedAttempts += 1;
        if (blockedAttempts === 1) firstBlocked.resolve();
        else secondBlocked.resolve();
      }
      return lock;
    });
    const originalLstat = fs.lstat.bind(fs);
    let paused = false;
    let active = 0;
    let maxActive = 0;
    let secondEntries = 0;
    const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
      const stats = await originalLstat(candidate, options as { bigint: true });
      if (String(candidate) === lockPath && !paused) {
        paused = true;
        observed.resolve();
        await resume.promise;
      }
      return stats;
    });
    const first = withInstallerLeaseLock(lockPath, "delayed stale observer", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      firstEntered.resolve();
      try {
        await releaseFirst.promise;
      } finally {
        active -= 1;
      }
    });
    let second: Promise<void> | undefined;
    try {
      await observed.promise;
      second = withInstallerLeaseLock(lockPath, "replacement contender", async () => {
        secondEntries += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await releaseSecond.promise;
        } finally {
          active -= 1;
        }
      });
      await firstBlocked.promise;
      expect(secondEntries).toBe(0);
      resume.resolve();
      await firstEntered.promise;
      const ownedMetadata = await fs.readFile(lockPath, "utf8");
      await secondBlocked.promise;
      expect(secondEntries).toBe(0);
      expect(await fs.readFile(lockPath, "utf8")).toBe(ownedMetadata);
      releaseFirst.resolve();
      releaseSecond.resolve();
      await Promise.all([first, second]);
      expect(secondEntries).toBe(1);
      expect(maxActive).toBe(1);
    } finally {
      resume.resolve();
      releaseFirst.resolve();
      releaseSecond.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      lstat.mockRestore();
      nativeLock.mockRestore();
    }
  });

  it("serializes eight contenders recovering the same expired local lease", async () => {
    const root = await createTestRoot();
    const { lockPath } = await createExpiredLifecycleLease(root);
    let activeOwners = 0;
    let maxOwners = 0;
    let entries = 0;
    const contenders = Array.from({ length: 8 }, () =>
      withInstallerLeaseLock(lockPath, "expired lifecycle lease", async () => {
        activeOwners += 1;
        maxOwners = Math.max(maxOwners, activeOwners);
        entries += 1;
        try {
          const metadata = await fs.readFile(lockPath, "utf8");
          await nextTurn();
          expect(await fs.readFile(lockPath, "utf8")).toBe(metadata);
        } finally {
          activeOwners -= 1;
        }
      }),
    );
    await Promise.all(contenders);
    expect(entries).toBe(8);
    expect(maxOwners).toBe(1);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("retains an unexpired legacy lease even when its PID is absent", async () => {
    const root = await createTestRoot();
    const holder = await startLifecycleLeaseHolder(root);
    const lockPath = path.join(root, ".codegraph-server.lock");
    const lease = parseJsonObject(await fs.readFile(lockPath, "utf8"));
    delete lease.kernelLock;
    const metadata = JSON.stringify(lease);
    await holder.kill();
    await fs.writeFile(lockPath, metadata);
    const operation = vi.fn(async () => "acquired");
    try {
      await expect(withInstallerLeaseLock(lockPath, "unexpired legacy lease", operation)).rejects.toThrow(
        "Another Codegraph installer",
      );
      expect(operation).not.toHaveBeenCalled();
      expect(await fs.readFile(lockPath, "utf8")).toBe(metadata);
    } finally {
      await fs.rm(lockPath);
    }
  });

  it("reclaims an expired legacy lease even when its PID has been reused", async () => {
    const holderRoot = await createTestRoot();
    const root = await createTestRoot();
    const holder = await startLifecycleLeaseHolder(holderRoot);
    const lockPath = path.join(root, ".codegraph-server.lock");
    const lease = parseJsonObject(await fs.readFile(path.join(holderRoot, ".codegraph-server.lock"), "utf8"));
    delete lease.kernelLock;
    lease.owner = "previous-unrelated-owner";
    lease.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString();
    const metadata = JSON.stringify(lease);
    await fs.writeFile(lockPath, metadata);
    try {
      const stopped = await runCli(["server", "stop", "--root", root]);
      expect(stopped.exitCode, stopped.stderr).toBe(0);
      expect(process.kill(holder.pid, 0)).toBe(true);
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await holder.kill();
      await fs.rm(lockPath, { force: true });
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
      withInstallerLeaseLock(path.join(root, ".codegraph-server.lock"), "concurrent lifecycle recovery", async () => {
        owners += 1;
        entered.resolve();
        await release.promise;
        return "acquired";
      }).catch((error: unknown) => String(error));
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
