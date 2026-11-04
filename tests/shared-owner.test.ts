import { execFile } from "node:child_process";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Socket } from "node:net";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSharedOwner, installSharedOwnerIdleTimeout, type SharedOwnerOptions } from "../src/mcp/shared-owner.js";
import { createMcpLifecycleHealthProof, matchesMcpLifecycleHealthProof } from "../src/mcp/lifecycle-health.js";
import { isPlainRecord } from "../src/util/guards.js";
import { isSymlinkUnavailable } from "./helpers/filesystem.js";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(packageRoot, "dist", "cli.js");
const ownerModule = pathToFileURL(path.join(packageRoot, "dist", "mcp", "shared-owner.js")).href;
const roots = new Set<string>();

afterEach(async () => {
  vi.useRealTimers();
  for (const root of [...roots].sort((left, right) => right.length - left.length)) {
    await execFileAsync(process.execPath, [cli, "server", "stop", "--root", root], { windowsHide: true }).catch(
      () => undefined,
    );
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  roots.clear();
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-shared-owner-"));
  roots.add(root);
  await fs.writeFile(path.join(root, "example.ts"), "export const originalSharedValue = 1;\n");
  return root;
}

async function ensureInAnotherProcess(options: SharedOwnerOptions, module = ownerModule): Promise<unknown> {
  const code = [
    "const { ensureSharedOwner } = await import(process.argv[1]);",
    "console.log(JSON.stringify(await ensureSharedOwner(JSON.parse(process.argv[2]))));",
  ].join(" ");
  const result = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", code, module, JSON.stringify(options)],
    { windowsHide: true, timeout: 60_000 },
  );
  return JSON.parse(result.stdout) as unknown;
}

function resultText(result: unknown): string {
  if (!isPlainRecord(result) || !Array.isArray(result.content)) return "";
  return result.content
    .map((entry: unknown) => (isPlainRecord(entry) && typeof entry.text === "string" ? entry.text : ""))
    .join("\n");
}

async function newClient(url: string): Promise<Client> {
  const client = new Client({ name: "shared-owner-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

describe("shared MCP owner", () => {
  it("serializes concurrent processes onto one verified dynamic-port owner and serves independent clients", async () => {
    const root = await makeRoot();
    const options: SharedOwnerOptions = { root, warmup: "off", watch: false, buildOptions: { cache: "off" } };
    const [owner, other, third] = await Promise.all([
      ensureSharedOwner(options),
      ensureInAnotherProcess(options),
      ensureInAnotherProcess(options),
    ]);
    expect(other).toEqual(owner);
    expect(third).toEqual(owner);
    expect(owner.pid).toBeGreaterThan(0);
    expect(owner.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(owner.identity).toMatch(/^[a-f0-9]{64}$/);
    const registry: unknown = JSON.parse(await fs.readFile(path.join(root, ".codegraph", "server.json"), "utf8"));
    expect(registry).toMatchObject({ pid: owner.pid, url: owner.url, ownerIdentity: owner.identity });
    const status = await execFileAsync(process.execPath, [cli, "server", "status", "--root", root, "--json"], {
      windowsHide: true,
    });
    expect(JSON.parse(status.stdout) as unknown).toMatchObject({ status: "live", registry: { pid: owner.pid } });

    const first = await newClient(owner.url);
    const second = await newClient(owner.url);
    try {
      const tools = await first.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("get_file");
      const initial = await first.callTool({ name: "get_file", arguments: { file: "example.ts" } });
      expect(resultText(initial)).toContain("originalSharedValue");
      await first.close();
      await fs.writeFile(path.join(root, "example.ts"), "export const updatedSharedValue = 2;\n");
      const updated = await second.callTool({ name: "get_file", arguments: { file: "example.ts" } });
      expect(resultText(updated)).toContain("updatedSharedValue");
      expect(resultText(updated)).not.toContain("originalSharedValue");
      expect(await ensureSharedOwner(options)).toEqual(owner);
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  }, 90_000);

  it("shares a physical root through an alias while preserving discovery root identity", async (context) => {
    const container = await makeRoot();
    const root = path.join(container, "project");
    const alias = path.join(container, "alias");
    await fs.mkdir(root);
    roots.add(root);
    try {
      await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (!isSymlinkUnavailable(error)) throw error;
      context.skip();
      return;
    }
    try {
      const direct = await ensureSharedOwner({
        root,
        warmup: "off",
        watch: false,
        buildOptions: { discovery: { globRoot: root }, cacheDir: root },
      });
      const viaAlias = await ensureSharedOwner({
        root: alias,
        warmup: "off",
        watch: false,
        buildOptions: { discovery: { globRoot: alias }, cacheDir: alias },
      });
      expect(viaAlias).toEqual(direct);
      expect(direct.root).toBe((await fs.realpath(root)).replace(/\\/g, "/"));
    } finally {
      await fs.unlink(alias);
    }
  }, 60_000);

  it("rejects security, runtime-option, and config changes rather than starting a second owner", async () => {
    const root = await makeRoot();
    const options: SharedOwnerOptions = { root, warmup: "off", watch: false };
    const owner = await ensureSharedOwner(options);
    await expect(ensureSharedOwner({ ...options, readOnly: false })).rejects.toThrow("incompatible");
    await expect(ensureSharedOwner({ ...options, watch: true })).rejects.toThrow("incompatible");
    await fs.writeFile(
      path.join(root, "codegraph.config.json"),
      JSON.stringify({ discovery: { ignoreGlobs: ["ignored/**"] } }),
    );
    await expect(ensureSharedOwner(options)).rejects.toThrow("incompatible");
    await fs.rm(path.join(root, "codegraph.config.json"));
    expect(await ensureSharedOwner(options)).toEqual(owner);
    await expect(ensureSharedOwner({ ...options, buildOptions: { onProgress: () => {} } })).rejects.toThrow(
      "callbacks",
    );
  }, 60_000);

  it.each(["automatic", "direct"] as const)(
    "keeps %s owner configuration semantics after a config edit",
    async (mode) => {
      const root = await makeRoot();
      await fs.mkdir(path.join(root, "ignored"));
      await fs.writeFile(path.join(root, "ignored", "hidden.ts"), "export const newlyIncludedValue = 2;\n");
      const configPath = path.join(root, "codegraph.config.json");
      await fs.writeFile(configPath, JSON.stringify({ discovery: { ignoreGlobs: ["ignored/**"] } }));
      const options: SharedOwnerOptions = { root, warmup: "off", watch: false, buildOptions: { cache: "off" } };
      const { startCodegraphMcpHttpServer } = await import("../src/mcp/http-transport.js");
      const owner =
        mode === "automatic"
          ? await ensureSharedOwner(options)
          : await startCodegraphMcpHttpServer({ ...options, port: 0 });
      const client = await newClient(owner.url);
      const names = async (): Promise<string[]> => {
        const result: unknown = JSON.parse(
          resultText(
            await client.callTool({
              name: "workspace_symbols",
              arguments: { query: "", fileGlob: "**/*.ts" },
            }),
          ),
        );
        if (!isPlainRecord(result) || !Array.isArray(result.symbols)) throw new Error("Missing workspace symbols.");
        return result.symbols
          .map((symbol: unknown) => {
            if (!isPlainRecord(symbol) || typeof symbol.name !== "string") throw new Error("Invalid workspace symbol.");
            return symbol.name;
          })
          .sort();
      };
      try {
        expect(await names()).toEqual(["originalSharedValue"]);
        await fs.writeFile(configPath, JSON.stringify({ discovery: { ignoreGlobs: [] } }));
        await client.callTool({ name: "refresh_index", arguments: { warmup: "base" } });
        if (mode === "automatic") {
          expect(await names()).toEqual(["originalSharedValue"]);
          await expect(ensureSharedOwner(options)).rejects.toThrow("incompatible");
        } else {
          expect(await names()).toEqual(["newlyIncludedValue", "originalSharedValue"]);
        }
        await fs.writeFile(configPath, JSON.stringify({ discovery: { ignoreGlobs: ["**/*.ts"] } }));
        await client.callTool({ name: "refresh_index", arguments: { warmup: "base" } });
        expect(await names()).toEqual(mode === "automatic" ? ["originalSharedValue"] : []);
      } finally {
        await client.close();
        if ("close" in owner) await owner.close();
      }
    },
    60_000,
  );

  it("requires an explicit restart after same-version transitive runtime code changes", async () => {
    const root = await makeRoot();
    const scratch = path.join(packageRoot, ".vitest");
    await fs.mkdir(scratch, { recursive: true });
    const runtime = await fs.mkdtemp(path.join(scratch, "shared-owner-runtime-"));
    const module = pathToFileURL(path.join(runtime, "dist", "mcp", "shared-owner.js")).href;
    const options: SharedOwnerOptions = { root, warmup: "off", watch: false };
    const clients: Client[] = [];
    try {
      // A real private distribution inherits installed dependencies through its parent, without links or mocks.
      await fs.copyFile(path.join(packageRoot, "package.json"), path.join(runtime, "package.json"));
      await fs.cp(path.join(packageRoot, "dist"), path.join(runtime, "dist"), { recursive: true });
      const original = await ensureInAnotherProcess(options, module);
      if (!isPlainRecord(original) || typeof original.url !== "string") throw new Error("Owner endpoint missing.");
      const first = await newClient(original.url);
      clients.push(first);
      expect((await first.listTools()).tools.some((tool) => tool.name === "get_file")).toBe(true);

      // Change valid transitive implementation code, not package/native versions or the owner entrypoint.
      await fs.appendFile(path.join(runtime, "dist", "mcp", "tools.js"), "\nlistCodegraphMcpTools = () => [];\n");
      await expect(ensureInAnotherProcess(options, module)).rejects.toThrow("incompatible");
      const registry = JSON.parse(await fs.readFile(path.join(root, ".codegraph", "server.json"), "utf8")) as unknown;
      expect(registry).toMatchObject({ pid: original.pid, ownerIdentity: original.identity });
      expect((await first.listTools()).tools.some((tool) => tool.name === "get_file")).toBe(true);

      await execFileAsync(process.execPath, [cli, "server", "stop", "--root", root], { windowsHide: true });
      const replacement = await ensureInAnotherProcess(options, module);
      if (!isPlainRecord(replacement) || typeof replacement.url !== "string")
        throw new Error("Owner endpoint missing.");
      expect(replacement.pid).not.toBe(original.pid);
      expect(replacement.identity).not.toBe(original.identity);
      const restarted = await newClient(replacement.url);
      clients.push(restarted);
      expect((await restarted.listTools()).tools).toEqual([]);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await execFileAsync(process.execPath, [cli, "server", "stop", "--root", root], { windowsHide: true }).catch(
        () => undefined,
      );
      await fs.rm(runtime, { recursive: true, force: true });
    }
  }, 90_000);

  it("reuses an owner when workspace-explicit options match CLI-expanded project config", async () => {
    const root = await makeRoot();
    await fs.writeFile(
      path.join(root, "codegraph.config.json"),
      JSON.stringify({
        discovery: { ignoreGlobs: ["ignored/**"] },
        languages: { extensions: { ".example": "ts" } },
        graph: { resolutionHints: ["src"] },
        cache: { location: "project" },
      }),
    );
    const options: SharedOwnerOptions = { root, warmup: "off", watch: false };
    const owner = await ensureSharedOwner(options);
    const expanded = await ensureSharedOwner({
      ...options,
      buildOptions: {
        discovery: { ignoreGlobs: ["ignored/**"], globRoot: root },
        languageExtensions: { ".example": "ts" },
        graph: { resolveNodeModules: false, dynamicImportHeuristics: false, resolutionHints: ["src"] },
        cacheLocation: "project",
      },
    });
    expect(expanded).toEqual(owner);
    await expect(
      ensureSharedOwner({ ...options, buildOptions: { discovery: { ignoreGlobs: ["extra/**"] } } }),
    ).rejects.toThrow("incompatible");
  }, 60_000);

  it("does not trust a relayed health proof for a different registry endpoint", async () => {
    const root = await makeRoot();
    const options: SharedOwnerOptions = { root, warmup: "off", watch: false };
    const owner = await ensureSharedOwner(options);
    const registryPath = path.join(root, ".codegraph", "server.json");
    const original = await fs.readFile(registryPath, "utf8");
    const registry: unknown = JSON.parse(original);
    if (!isPlainRecord(registry)) throw new Error("Invalid test registry.");
    const health = new URL("/health", owner.url);
    const proxy = createServer((request, response) => {
      const challenge = request.headers["x-codegraph-health-challenge"];
      const headers: Record<string, string> = {};
      if (typeof challenge === "string") headers["x-codegraph-health-challenge"] = challenge;
      void fetch(health, { headers })
        .then(async (upstream) => {
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(await upstream.text());
        })
        .catch(() => {
          response.writeHead(502);
          response.end();
        });
    });
    const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
    await listening;
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Proxy did not bind a port.");
    try {
      await fs.writeFile(registryPath, JSON.stringify({ ...registry, url: `http://127.0.0.1:${address.port}/mcp` }));
      await expect(ensureSharedOwner(options)).rejects.toThrow("Cannot safely recover");
    } finally {
      await fs.writeFile(registryPath, original);
      const { promise: closed, resolve: resolveClose, reject: rejectClose } = Promise.withResolvers<void>();
      proxy.close((error) => (error ? rejectClose(error) : resolveClose()));
      await closed;
    }
    expect(await ensureSharedOwner(options)).toEqual(owner);
  }, 60_000);

  it("refuses corrupt live registries but safely recovers a confirmed dead owner", async () => {
    const root = await makeRoot();
    const options: SharedOwnerOptions = { root, warmup: "off", watch: false };
    const owner = await ensureSharedOwner(options);
    const registryPath = path.join(root, ".codegraph", "server.json");
    const original = await fs.readFile(registryPath, "utf8");
    try {
      await fs.writeFile(registryPath, "not a registry");
      await expect(ensureSharedOwner(options)).rejects.toThrow("Cannot safely recover");
      await expect(
        execFileAsync(process.execPath, [cli, "server", "stop", "--root", root], { windowsHide: true }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("invalid registry") });
      await expect(
        execFileAsync(process.execPath, [cli, "server", "start", "--root", root], { windowsHide: true }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("invalid registry") });
      expect(await fs.readFile(registryPath, "utf8")).toBe("not a registry");
    } finally {
      await fs.writeFile(registryPath, original);
    }
    process.kill(owner.pid, "SIGTERM");
    // A different OS process must really exit; fake timers cannot drive its termination.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") break;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const replacement = await ensureSharedOwner(options);
    expect(replacement.pid).not.toBe(owner.pid);
    expect(replacement.identity).toBe(owner.identity);
  }, 60_000);

  it("binds owner identity and endpoint into lifecycle proofs", () => {
    const base = {
      pid: 123,
      root: "/project",
      startedAt: "2026-01-01",
      ownerIdentity: "a".repeat(64),
      ownerEndpoint: "http://127.0.0.1:1/mcp",
    };
    const proof = createMcpLifecycleHealthProof("token", "challenge", base);
    expect(matchesMcpLifecycleHealthProof(proof, "token", "challenge", base)).toBe(true);
    expect(
      matchesMcpLifecycleHealthProof(proof, "token", "challenge", { ...base, ownerIdentity: "b".repeat(64) }),
    ).toBe(false);
    expect(
      matchesMcpLifecycleHealthProof(proof, "token", "challenge", { ...base, ownerEndpoint: "http://127.0.0.1:2/mcp" }),
    ).toBe(false);
  });

  it("does not retire a long-running request and restarts its idle clock after completion", async () => {
    vi.useFakeTimers();
    const server = createServer();
    const retire = vi.fn(async (isIdle: () => boolean) => isIdle());
    const dispose = installSharedOwnerIdleTimeout(server, retire, 1_000);
    const request = new IncomingMessage(new Socket());
    request.method = "POST";
    request.url = "/mcp";
    const response = new ServerResponse(request);
    server.emit("request", request, response);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(retire).not.toHaveBeenCalled();
    response.emit("finish");
    await vi.advanceTimersByTimeAsync(999);
    expect(retire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(retire).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("rechecks activity after waiting for the lifecycle lease", async () => {
    vi.useFakeTimers();
    const server = createServer();
    const gate = Promise.withResolvers<void>();
    let gateResolved = false;
    const retire = vi.fn(async (isIdle: () => boolean) => {
      if (!gateResolved) await gate.promise;
      return isIdle();
    });
    const dispose = installSharedOwnerIdleTimeout(server, retire, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(retire).toHaveBeenCalledTimes(1);
    const request = new IncomingMessage(new Socket());
    request.method = "GET";
    request.url = "/health";
    server.emit("request", request, new ServerResponse(request));
    gateResolved = true;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(retire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(retire).toHaveBeenCalledTimes(2);
    dispose();
  });
});
