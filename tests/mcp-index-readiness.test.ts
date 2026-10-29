import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as queryIndexStore from "../src/agent/query-index/session-store.js";
import * as queryIndexUpdate from "../src/agent/query-index/update.js";
import { createAgentSession, type AgentSession } from "../src/agent/session.js";
import * as indexerBuild from "../src/indexer/build-index.js";
import { createCodegraphMcpResources } from "../src/mcp/handlers.js";
import {
  withIndexReadiness,
  type McpIndexReadiness,
  type McpIndexStage,
  type McpStageContext,
} from "../src/mcp/index-readiness.js";
import { collectReviewChanges } from "../src/review/changes.js";
import {
  createCodegraphMcpHandlers,
  createCodegraphMcpProtocolServer,
  serveCodegraphMcp,
  startCodegraphMcpHttpServer,
  type CodegraphMcpHandlers,
} from "../src/mcp/server.js";
import { describeMcpRuntimeError, isStaleInstallError, STALE_INSTALL_MESSAGE } from "../src/mcp/stale-install.js";
import { isPlainRecord } from "../src/util/guards.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

const tempRoots = createTempRootRegistry();

afterEach(async () => {
  vi.restoreAllMocks();
  await tempRoots.cleanup();
});

async function createProject(prefix: string): Promise<string> {
  const root = await tempRoots.create(prefix);
  await fs.writeFile(
    path.join(root, "alpha.ts"),
    'import { beta } from "./beta";\nexport function alpha() { return beta(); }\n',
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "beta.ts"),
    "export function beta() { return 1; }\nexport interface Shape { area(): number }\n" +
      "export class Square implements Shape { area() { return 4; } }\n",
    "utf8",
  );
  return root;
}

type HeldSession = {
  session: AgentSession;
  /** Settles when the first build asks the session to load the project. */
  started: Promise<void>;
  release: () => void;
  events: string[];
};

/** A session whose `loadProject` waits until `release()`, as a cold build does, then loads for real. */
function holdSession(root: string): HeldSession {
  const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  const session: AgentSession = {
    ...inner,
    loadProject: async (options) => {
      events.push("loadProject:start");
      started.resolve();
      await gate.promise;
      const snapshot = await inner.loadProject(options);
      events.push("loadProject:end");
      return snapshot;
    },
    invalidate: () => {
      events.push("invalidate");
      inner.invalidate();
    },
  };
  return { session, started: started.promise, release: gate.resolve, events };
}

async function connect(handlers: CodegraphMcpHandlers, maxConcurrentToolCalls?: number) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCodegraphMcpProtocolServer(handlers, undefined, undefined, undefined, maxConcurrentToolCalls);
  const client = new Client({ name: "mcp-index-readiness-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async (): Promise<void> => {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const result = await client.callTool({ name, arguments: args }, signal ? { signal } : undefined);
  const [first] = result.content;
  if (first?.type !== "text") throw new Error("MCP tool result did not contain text content.");
  return { isError: Boolean(result.isError), text: first.text };
}

function parseBody(text: string): Record<string, unknown> {
  const body: unknown = JSON.parse(text);
  if (!isPlainRecord(body)) throw new Error("Expected a JSON object.");
  return body;
}

// serveCodegraphMcp reads the process streams, so stand in for them while `run` serves.
async function withStandInStdio<T>(run: (io: { stdin: PassThrough; stdout: PassThrough }) => Promise<T>): Promise<T> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalStdout = Object.getOwnPropertyDescriptor(process, "stdout");
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  Object.defineProperty(process, "stdout", { value: stdout, configurable: true });
  try {
    return await run({ stdin, stdout });
  } finally {
    if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
    if (originalStdout) Object.defineProperty(process, "stdout", originalStdout);
  }
}

// A real delay: the sockets and streams are real, so no fake clock reaches them. A shutdown that does not wait for the
// build is done long before this ends, and one that does wait is not shortened by it.
async function letShutdownRun(): Promise<void> {
  const elapsed = Promise.withResolvers<void>();
  setTimeout(elapsed.resolve, 150);
  await elapsed.promise;
}

describe("MCP cold start", () => {
  it("answers initialize and tools/list over HTTP while the index build is still running", async () => {
    const root = await createProject("cg-mcp-ready-http-");
    const held = holdSession(root);
    const server = await startCodegraphMcpHttpServer({ root, port: 0, session: held.session, warmup: "base" });
    const client = new Client({ name: "mcp-index-readiness-http", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      const tools = await client.listTools();

      expect(tools.tools.map((tool) => tool.name)).toContain("search");
      // The warmup began, and nothing released it: the server answered without waiting for the build.
      await held.started;
      expect(held.events).not.toContain("loadProject:end");
    } finally {
      held.release();
      await client.close();
      await server.close();
    }
  });

  it("answers initialize over stdio while the index build is still running, and shuts down after the build", async () => {
    const root = await createProject("cg-mcp-ready-stdio-");
    const held = holdSession(root);
    await withStandInStdio(async ({ stdin, stdout }) => {
      const lines: string[] = [];
      createInterface({ input: stdout }).on("line", (line) => lines.push(line));
      let served = false;
      const serving = serveCodegraphMcp({ root, session: held.session, warmup: "base" }).then(() => {
        served = true;
      });
      try {
        const initialize = {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } },
        };
        stdin.write(`${JSON.stringify(initialize)}\n`);
        await vi.waitFor(() => expect(lines.some((line) => line.includes('"id":1'))).toBe(true), { timeout: 20_000 });
        await held.started;
        expect(held.events).not.toContain("loadProject:end");

        stdin.end();
        await letShutdownRun();
        // Nothing else holds the server open, so only the build can.
        expect(served).toBe(false);

        held.release();
        await serving;
        // The warmup writes to the session until it ends, so the session is released after it.
        expect(held.events.at(-1)).toBe("invalidate");
      } finally {
        held.release();
        stdin.end();
        await serving;
      }
    });
  });

  it("answers index_building past the budget, then the normal result once the build ends", async () => {
    const root = await createProject("cg-mcp-ready-budget-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "base", mcpIndexWaitMs: 25 });
    resources.startWarmup();
    const io = await connect(resources.handlers);
    try {
      await held.started;
      const waiting = await callTool(io.client, "search", { query: "alpha" });

      expect(waiting.isError).toBe(false);
      expect(parseBody(waiting.text)).toMatchObject({
        status: "index_building",
        tool: "search",
        retryAfterMs: expect.any(Number),
        waitedMs: expect.any(Number),
        progress: { activity: expect.any(String), elapsedMs: expect.any(Number) },
      });
      expect(parseBody(waiting.text).message).toContain("call 'search' again");

      held.release();
      await resources.warmupSettled();
      const ready = await callTool(io.client, "search", { query: "alpha" });
      const body = parseBody(ready.text);

      expect(ready.isError).toBe(false);
      expect(body.status).toBeUndefined();
      expect(body.results).toEqual(expect.arrayContaining([expect.objectContaining({ label: "alpha" })]));
    } finally {
      held.release();
      await io.close();
      await resources.warmupSettled();
    }
  });

  it("reports counts only for work with a measurable total, and keeps the caller's own progress callback", async () => {
    const root = await createProject("cg-mcp-ready-progress-");
    const userProgress = vi.fn();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const build = indexerBuild.buildProjectIndexIncremental;
    vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (projectRoot, options) => {
      options?.onProgress?.({
        type: "progress",
        phase: "update",
        mode: "check",
        message: "Discovering",
        activity: "Discovering source files",
        current: 0,
        total: 0,
      });
      started.resolve();
      await release.promise;
      return await build(projectRoot, options);
    });
    const resources = createCodegraphMcpResources({
      root,
      watch: false,
      warmup: "base",
      mcpIndexWaitMs: 25,
      buildOptions: { cache: "off", onProgress: userProgress },
    });
    resources.startWarmup();
    try {
      await started.promise;
      const discovering = await resources.handlers.orient({}).catch((error: unknown) => error);

      expect(discovering).toMatchObject({ result: { progress: { activity: "Discovering source files" } } });
      expect(
        isPlainRecord(discovering) && isPlainRecord(discovering.result) ? discovering.result.progress : {},
      ).not.toHaveProperty("total");
      expect(userProgress).toHaveBeenCalledWith(expect.objectContaining({ activity: "Discovering source files" }));
    } finally {
      release.resolve();
      await resources.warmupSettled();
      resources.session.invalidate();
    }
  });

  it("shares one build between the warmup and concurrent calls", async () => {
    const root = await createProject("cg-mcp-ready-shared-");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const build = indexerBuild.buildProjectIndexIncremental;
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      started.resolve();
      await release.promise;
      return await build(...args);
    });
    const resources = createCodegraphMcpResources({
      root,
      watch: false,
      warmup: "base",
      mcpIndexWaitMs: 0,
      buildOptions: { cache: "off" },
    });
    resources.startWarmup();
    try {
      await started.promise;
      const calls = Promise.all([
        resources.handlers.search({ query: "alpha" }),
        resources.handlers.orient({}),
        resources.handlers.workspace_symbols({ query: "alpha" }),
        resources.handlers.file_deps({ direction: "deps", file: "alpha.ts" }),
      ]);
      release.resolve();
      const [search, orient, symbols, deps] = await calls;

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(search.results.length).toBeGreaterThan(0);
      expect(orient.freshness.state).toBe("fresh");
      expect(symbols.symbols.length).toBeGreaterThan(0);
      expect(deps.dependencies?.map((entry) => entry.file)).toContain("beta.ts");
    } finally {
      release.resolve();
      await resources.warmupSettled();
      resources.session.invalidate();
    }
  });

  it("stops waiting at once when the call is cancelled, and releases its concurrency slot", async () => {
    const root = await createProject("cg-mcp-ready-cancel-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({
      root,
      session: held.session,
      warmup: "base",
      mcpIndexWaitMs: 600_000,
    });
    resources.startWarmup();
    const io = await connect(resources.handlers, 1);
    try {
      await held.started;
      const direct = new AbortController();
      const cancelledDirect = resources.handlers.search({ query: "alpha" }, direct.signal);
      direct.abort();
      await expect(cancelledDirect).rejects.toThrow("MCP tool call was cancelled.");

      const controller = new AbortController();
      const cancelled = callTool(io.client, "search", { query: "alpha" }, controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toThrow();
      // The build is untouched, so a slot that stayed taken would refuse this call as busy until the build ends.
      await vi.waitFor(async () => {
        const read = await callTool(io.client, "get_file", { file: "alpha.ts" });
        expect(read.isError).toBe(false);
      });
      expect(held.events).not.toContain("loadProject:end");
    } finally {
      held.release();
      await io.close();
      await resources.warmupSettled();
    }
  });

  it("reads a file without graph context at once, and waits for the index only when the context is asked for", async () => {
    const root = await createProject("cg-mcp-ready-get-file-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "base", mcpIndexWaitMs: 25 });
    resources.startWarmup();
    try {
      await held.started;
      const plain = await resources.handlers.get_file({ file: "alpha.ts" });
      const withContext = await resources.handlers
        .get_file({ file: "alpha.ts", includeGraphContext: true })
        .catch((error: unknown) => error);

      expect(plain.text).toContain("export function alpha");
      expect(withContext).toMatchObject({ result: { status: "index_building", tool: "get_file" } });
      expect(held.events).not.toContain("loadProject:end");
    } finally {
      held.release();
      await resources.warmupSettled();
    }
  });

  it("answers a review of a range without changes from git alone, while a range with changes waits for the index", async () => {
    const root = await createProject("cg-mcp-ready-review-");
    runGit(root, ["init"]);
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-m", "one"]);
    await fs.appendFile(path.join(root, "alpha.ts"), "export const gamma = 3;\n", "utf8");
    runGit(root, ["commit", "-am", "two"]);
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "base", mcpIndexWaitMs: 25 });
    resources.startWarmup();
    try {
      await held.started;
      const empty = await resources.handlers.review({ base: "HEAD", head: "HEAD" });
      const changed = await resources.handlers
        .review({ base: "HEAD~1", head: "HEAD" })
        .catch((error: unknown) => error);

      expect(empty).toMatchObject({ status: "no_changes", freshness: { state: "fresh" } });
      expect(changed).toMatchObject({ result: { status: "index_building", tool: "review" } });
      // The build is still held, so neither answer came from an index.
      expect(held.events).not.toContain("loadProject:end");
    } finally {
      held.release();
      await resources.warmupSettled();
    }
  });

  it("builds no index for a review of a range without changes when warmup is off", async () => {
    const root = await createProject("cg-mcp-ready-review-off-");
    runGit(root, ["init"]);
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-m", "one"]);
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    resources.startWarmup();

    await expect(resources.handlers.review({ base: "HEAD", head: "HEAD" })).resolves.toMatchObject({
      status: "no_changes",
    });
    expect(held.events).toEqual([]);
  });

  it("makes refresh_index wait for the startup warmup instead of replacing the session under it", async () => {
    const root = await createProject("cg-mcp-ready-refresh-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "base", mcpIndexWaitMs: 25 });
    resources.startWarmup();
    try {
      await held.started;
      const waiting = await resources.handlers.refresh_index({}).catch((error: unknown) => error);

      expect(waiting).toMatchObject({ result: { status: "index_building", tool: "refresh_index" } });
      expect(held.events).not.toContain("invalidate");

      held.release();
      await resources.warmupSettled();
      await expect(resources.handlers.refresh_index({})).resolves.toEqual({ refreshed: true, warmup: "off" });
      expect(held.events.at(-1)).toBe("invalidate");
    } finally {
      held.release();
      await resources.warmupSettled();
    }
  });

  it("builds the search index in the warmup, so that the first search does not", async () => {
    const root = await createProject("cg-mcp-ready-query-");
    const cacheDir = path.join(await tempRoots.create("cg-mcp-ready-cache-"), "cache");
    const queryIndexSpy = vi.spyOn(queryIndexUpdate, "ensureQueryIndex");
    const resources = createCodegraphMcpResources({
      root,
      watch: false,
      warmup: "base",
      buildOptions: { cache: "disk", cacheDir },
    });
    try {
      resources.startWarmup();
      await resources.warmupSettled();
      expect(queryIndexSpy).toHaveBeenCalledTimes(1);

      const search = await resources.handlers.search({ query: "alpha" });

      expect(search.results.length).toBeGreaterThan(0);
      expect(queryIndexSpy).toHaveBeenCalledTimes(1);
    } finally {
      await resources.warmupSettled();
      resources.session.invalidate();
    }
  });

  it("builds nothing up front with warmup off, and starts the build at the first call that needs the index", async () => {
    const root = await createProject("cg-mcp-ready-off-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    resources.startWarmup();
    try {
      await resources.warmupSettled();
      expect(held.events).toEqual([]);

      const waiting = await resources.handlers.orient({}).catch((error: unknown) => error);

      expect(waiting).toMatchObject({ result: { status: "index_building", tool: "orient" } });
      expect(held.events).toEqual(["loadProject:start"]);
    } finally {
      held.release();
    }
  });

  it("waits without a limit when the budget is 0", async () => {
    const root = await createProject("cg-mcp-ready-unlimited-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 0 });
    let settled = false;
    const pending = resources.handlers.orient({}).finally(() => {
      settled = true;
    });
    await held.started;
    await letShutdownRun();

    expect(settled).toBe(false);

    held.release();
    await expect(pending).resolves.toMatchObject({ freshness: { state: "fresh" } });
  });

  it("logs a failed warmup and builds again at the next call that needs the index", async () => {
    const root = await createProject("cg-mcp-ready-failed-");
    const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
    let failures = 1;
    const session: AgentSession = {
      ...inner,
      loadProject: async (options) => {
        if (failures-- > 0) throw new Error("disk full");
        return await inner.loadProject(options);
      },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const resources = createCodegraphMcpResources({ root, session, warmup: "base" });

    resources.startWarmup();
    await expect(resources.warmupSettled()).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("MCP startup warmup failed: disk full"));
    await expect(resources.handlers.orient({})).resolves.toMatchObject({ freshness: { state: "fresh" } });
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 31])("rejects the invalid index wait %s at startup", async (mcpIndexWaitMs) => {
    const root = await createProject("cg-mcp-ready-invalid-");

    expect(() => createCodegraphMcpResources({ root, mcpIndexWaitMs })).toThrow(
      "mcpIndexWaitMs must be a whole number from 0 through 2147483647; 0 disables the budget.",
    );
  });
});

describe("MCP tool arguments and package upgrades", () => {
  it.each([
    [{ file: null }, "received null"],
    [{}, "received nothing (the field is missing)"],
    [{ file: 5 }, "received number"],
  ])("rejects get_file arguments %j with a message that names the field", async (args, received) => {
    const root = await createProject("cg-mcp-get-file-null-");
    const io = await connect(createCodegraphMcpHandlers({ root }));
    try {
      await expect(callTool(io.client, "get_file", args)).rejects.toThrow(
        `Invalid parameters for get_file: file: expected a project-relative file path string, ${received}`,
      );
    } finally {
      await io.close();
    }
  });

  it("tells the client to restart the server when a module of the package is gone", async () => {
    const root = await createProject("cg-mcp-missing-chunk-");
    const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
    const session: AgentSession = {
      ...inner,
      // A chunk that an upgrade removed: Node's own error for a module that is not on disk.
      loadProject: () => {
        createRequire(import.meta.url)(path.join(root, "chunk-REMOVED.js"));
        return inner.loadProject();
      },
    };
    const resources = createCodegraphMcpResources({ root, session, warmup: "off" });
    const io = await connect(resources.handlers);
    try {
      const failed = await callTool(io.client, "orient", {});

      expect(failed.isError).toBe(true);
      expect(failed.text).toBe(STALE_INSTALL_MESSAGE);
      expect(failed.text).toContain("Restart the MCP server");
      expect(failed.text).not.toContain("Cannot find module");
    } finally {
      await io.close();
    }
  });

  it("recognizes the error that Node raises for a module that is not on disk, and nothing else", () => {
    const missing = pathToFileURL(path.join(process.cwd(), "chunk-REMOVED.js")).href;
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(missing)}).catch((error) => process.stdout.write(JSON.stringify({ code: error.code, message: error.message })));`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const real = parseBody(probe.stdout) as { code: string; message: string };

    expect(real.code).toBe("ERR_MODULE_NOT_FOUND");
    expect(isStaleInstallError(Object.assign(new Error(real.message), { code: real.code }))).toBe(true);
    // A worker thread or a re-thrown error can lose the code and keep the wording.
    expect(isStaleInstallError(new Error(real.message))).toBe(true);
    expect(isStaleInstallError(new Error("failed to load", { cause: new Error(real.message) }))).toBe(true);
    expect(isStaleInstallError(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))).toBe(false);
    expect(isStaleInstallError(new Error("disk full"))).toBe(false);
    expect(isStaleInstallError("Cannot find module 'x'")).toBe(false);
    expect(describeMcpRuntimeError(new Error("disk full"))).toBe("disk full");
    expect(describeMcpRuntimeError(new Error(real.message))).toBe(STALE_INSTALL_MESSAGE);
  });
});

describe("MCP index readiness stages", () => {
  it("declares for every handler what it loads from the session", async () => {
    const root = await createProject("cg-mcp-stages-");
    runGit(root, ["init"]);
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-m", "one"]);
    await fs.appendFile(path.join(root, "alpha.ts"), "export const gamma = 3;\n", "utf8");
    runGit(root, ["commit", "-am", "two"]);

    const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
    const loadDuplicates = inner.loadDuplicateAnalysis;
    if (!loadDuplicates) throw new Error("The session has no duplicate analysis.");
    const observed = { level: 0, query: false, duplicates: false };
    const levels: Record<string, number> = { skip: 1, basic: 2, eager: 3 };
    const session: AgentSession = {
      ...inner,
      loadProject: async (options) => {
        observed.level = Math.max(observed.level, levels[options?.symbolGraph ?? "eager"] ?? 0);
        return await inner.loadProject(options);
      },
      loadDuplicateAnalysis: async () => {
        observed.duplicates = true;
        return await loadDuplicates();
      },
    };
    const ensureQueryIndex = queryIndexStore.ensureSessionQueryIndex;
    vi.spyOn(queryIndexStore, "ensureSessionQueryIndex").mockImplementation(async (...args) => {
      observed.query = true;
      return await ensureQueryIndex(...args);
    });
    const declared: McpIndexStage[] = [];
    const readiness: McpIndexReadiness = {
      startWarmup: () => undefined,
      warmupSettled: async () => undefined,
      waitFor: async (_tool, stages) => {
        declared.push(...stages);
      },
    };
    const plain = createCodegraphMcpHandlers({ root, session: inner });
    const context: McpStageContext = {
      reviewRangeHasChanges: async (request) =>
        (await collectReviewChanges(root, { gitBase: request.base, gitHead: request.head })).changedFiles.size > 0,
    };
    const handlers = withIndexReadiness(
      createCodegraphMcpHandlers({ root, session, readOnly: false }),
      readiness,
      context,
    );
    const handleOf = async (query: string): Promise<string> => {
      const found = await plain.search({ query, mode: "symbol" });
      const handle = found.results.find((result) => result.label === query)?.handle;
      if (!handle) throw new Error(`No symbol ${query}.`);
      return handle;
    };
    const [alpha, beta, shape, square] = [
      await handleOf("alpha"),
      await handleOf("beta"),
      await handleOf("Shape"),
      await handleOf("Square"),
    ];
    const scenarios: Array<[string, () => Promise<unknown>]> = [
      ["search hybrid", () => handlers.search({ query: "alpha beta" })],
      ["search text", () => handlers.search({ query: "beta", mode: "text" })],
      ["search symbol", () => handlers.search({ query: "gamma", mode: "symbol" })],
      ["search graph", () => handlers.search({ query: "alpha", mode: "graph" })],
      ["search path", () => handlers.search({ query: "alpha", mode: "path" })],
      ["explore", () => handlers.explore({ query: "alpha" })],
      ["orient", () => handlers.orient({})],
      ["workspace_symbols", () => handlers.workspace_symbols({ query: "alpha" })],
      ["goto", () => handlers.goto({ file: "alpha.ts", line: 2, column: 16 })],
      ["file_deps", () => handlers.file_deps({ direction: "deps", file: "alpha.ts" })],
      ["path", () => handlers.path({ from: "alpha.ts", to: "beta.ts" })],
      ["get_file", () => handlers.get_file({ file: "alpha.ts" })],
      ["get_file with graph context", () => handlers.get_file({ file: "alpha.ts", includeGraphContext: true })],
      ["get_symbol", () => handlers.get_symbol({ handle: alpha })],
      ["packet_get", () => handlers.packet_get({ target: "alpha.ts" })],
      ["refs by handle", () => handlers.refs({ handle: alpha })],
      ["refs by qualified path", () => handlers.refs({ handle: "alpha.ts::alpha" })],
      ["refs by position", () => handlers.refs({ file: "alpha.ts", line: 2, column: 16 })],
      ["calls", () => handlers.calls({ direction: "callers", handle: beta })],
      ["type_hierarchy", () => handlers.type_hierarchy({ direction: "supertypes", handle: square })],
      ["implementations", () => handlers.implementations({ handle: shape })],
      ["rename_preview", () => handlers.rename_preview({ handle: alpha, newName: "alpha2" })],
      ["refactor_plan", () => handlers.refactor_plan({ handle: alpha })],
      ["impact", () => handlers.impact({ base: "HEAD~1", head: "HEAD" })],
      ["review of a range with changes", () => handlers.review({ base: "HEAD~1", head: "HEAD" })],
      ["review of a ref to itself", () => handlers.review({ base: "HEAD", head: "HEAD" })],
      ["query_sqlite", () => handlers.query_sqlite({ query: "select 1" })],
    ];
    const level = (stages: readonly McpIndexStage[]): number => {
      if (stages.includes("symbols")) return 3;
      if (stages.includes("graph")) return 2;
      return stages.some((stage) => stage === "index" || stage === "query" || stage === "duplicates") ? 1 : 0;
    };

    // A path search lists files and loads no snapshot, but its freshness check waits for a build that is running, so it
    // still has to wait for the project index inside the budget.
    const waitsOnFreshnessCheck: Record<string, true> = { "search path": true };

    for (const [name, run] of scenarios) {
      declared.length = 0;
      observed.level = 0;
      observed.query = false;
      observed.duplicates = false;
      await run().catch(() => undefined);

      const expected = waitsOnFreshnessCheck[name] ? { ...observed, level: 1 } : observed;
      expect(
        { level: level(declared), query: declared.includes("query"), duplicates: declared.includes("duplicates") },
        name,
      ).toEqual(expected);
    }
  });
});
