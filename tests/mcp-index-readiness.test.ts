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
import { createAgentSession, type AgentLoadProjectOptions, type AgentSession } from "../src/agent/session.js";
import * as duplicatesModule from "../src/duplicates.js";
import * as indexerBuild from "../src/indexer/build-index.js";
import { createCodegraphMcpResources } from "../src/mcp/handlers.js";
import {
  createMcpBuildProgress,
  createMcpIndexReadiness,
  MCP_REFRESH_RETRY_WINDOW_MS,
  MCP_STAGES_BY_HANDLER,
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
import * as gitUtil from "../src/util/git.js";
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

/**
 * A session whose `loadProject` waits until `release()`, as a cold build does, then loads for real. `holds` chooses the
 * loads that wait; the others load at once.
 */
function holdSession(
  root: string,
  holds: (options: AgentLoadProjectOptions | undefined) => boolean = () => true,
): HeldSession {
  const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  const session: AgentSession = {
    ...inner,
    loadProject: async (options) => {
      if (!holds(options)) return await inner.loadProject(options);
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

type HeldDuplicates = {
  session: AgentSession;
  /** The real session behind the held one, for the loads that must not wait. */
  inner: AgentSession;
  /** How many times a caller asked the held session for its duplicate analysis. */
  requests: () => number;
  release: () => void;
};

/** A session whose duplicate analysis waits until `release()`, then comes from the real session. */
function holdDuplicates(root: string): HeldDuplicates {
  const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
  const loadDuplicates = inner.loadDuplicateAnalysis;
  if (!loadDuplicates) throw new Error("The session has no duplicate analysis.");
  const gate = Promise.withResolvers<void>();
  let requests = 0;
  const session: AgentSession = {
    ...inner,
    loadDuplicateAnalysis: async () => {
      requests += 1;
      await gate.promise;
      return await loadDuplicates();
    },
  };
  return { session, inner, requests: () => requests, release: gate.resolve };
}

/** The handle of the symbol `name`, which the handlers of `session` resolve. */
async function symbolHandle(root: string, session: AgentSession, name: string): Promise<string> {
  const found = await createCodegraphMcpHandlers({ root, session }).search({ query: name, mode: "symbol" });
  const handle = found.results.find((result) => result.label === name)?.handle;
  if (!handle) throw new Error(`No symbol ${name}.`);
  return handle;
}

/** What `call` answers, once it has answered: a call that must answer within its budget leaves it empty when it blocks. */
function recordOutcome(call: Promise<unknown>): { readonly value: unknown } {
  const outcome: { value: unknown } = { value: undefined };
  call.then(
    (value) => {
      outcome.value = value;
    },
    (error: unknown) => {
      outcome.value = error;
    },
  );
  return outcome;
}

/** Waits for the `index_building` answer of `tool`; a call that blocks fails here on the clock, not by hanging. */
async function expectIndexBuilding(outcome: { readonly value: unknown }, tool: string): Promise<void> {
  await vi.waitFor(() => expect(outcome.value).toMatchObject({ result: { status: "index_building", tool } }), {
    timeout: 2_000,
  });
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
      await resources.buildsSettled();
      const ready = await callTool(io.client, "search", { query: "alpha" });
      const body = parseBody(ready.text);

      expect(ready.isError).toBe(false);
      expect(body.status).toBeUndefined();
      expect(body.results).toEqual(expect.arrayContaining([expect.objectContaining({ label: "alpha" })]));
    } finally {
      held.release();
      await io.close();
      await resources.buildsSettled();
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
      await resources.buildsSettled();
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
      await resources.buildsSettled();
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
      await resources.buildsSettled();
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
      await resources.buildsSettled();
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
      await resources.buildsSettled();
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

  it("asks git for the diff once per review call, and builds the report from that answer", async () => {
    const root = await createProject("cg-mcp-ready-review-once-");
    runGit(root, ["init"]);
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-m", "one"]);
    await fs.appendFile(path.join(root, "alpha.ts"), "export const gamma = 3;\n", "utf8");
    runGit(root, ["commit", "-am", "two"]);
    const resources = createCodegraphMcpResources({
      root,
      watch: false,
      warmup: "base",
      mcpIndexWaitMs: 0,
      buildOptions: { cache: "off" },
    });
    const diffs = vi.spyOn(gitUtil, "getUnifiedDiff");
    try {
      resources.startWarmup();
      await resources.buildsSettled();

      const report = await resources.handlers.review({ base: "HEAD~1", head: "HEAD" });
      const empty = await resources.handlers.review({ base: "HEAD", head: "HEAD" });

      expect(report).toMatchObject({ status: "ok", changedFiles: [expect.objectContaining({ file: "alpha.ts" })] });
      expect(empty).toMatchObject({ status: "no_changes" });
      // One diff per call: the answer that the gate used to choose its builds is the one the report is built from.
      expect(diffs).toHaveBeenCalledTimes(2);
    } finally {
      await resources.buildsSettled();
      resources.session.invalidate();
    }
  });

  it("gives a review request that is used again the diff of its own call", async () => {
    const root = await createProject("cg-mcp-ready-review-reuse-");
    runGit(root, ["init"]);
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-m", "one"]);
    const gated = createCodegraphMcpResources({ root, watch: false, warmup: "off", buildOptions: { cache: "off" } });
    const plain = createCodegraphMcpHandlers({ root, buildOptions: { cache: "off" } });
    // A host may keep one request object and call again after the working tree changed.
    const request = { base: "HEAD", head: "WORKTREE" };
    try {
      await expect(gated.handlers.review(request)).resolves.toMatchObject({ status: "no_changes" });
      await expect(plain.review(request)).resolves.toMatchObject({ status: "no_changes" });

      await fs.appendFile(path.join(root, "alpha.ts"), "export const gamma = 3;\n", "utf8");

      for (const handlers of [gated.handlers, plain]) {
        await expect(handlers.review(request)).resolves.toMatchObject({
          status: "ok",
          changedFiles: [expect.objectContaining({ file: "alpha.ts" })],
        });
      }
    } finally {
      plain.dispose();
      gated.session.invalidate();
    }
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
      await resources.buildsSettled();
      await expect(resources.handlers.refresh_index({})).resolves.toEqual({ refreshed: true, warmup: "off" });
      expect(held.events.at(-1)).toBe("invalidate");
      // The first call stopped waiting for its turn, so it replaced nothing: only the retry did.
      expect(held.events.filter((event) => event === "invalidate")).toHaveLength(1);
    } finally {
      held.release();
      await resources.buildsSettled();
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
      await resources.buildsSettled();
      expect(queryIndexSpy).toHaveBeenCalledTimes(1);

      const search = await resources.handlers.search({ query: "alpha" });

      expect(search.results.length).toBeGreaterThan(0);
      expect(queryIndexSpy).toHaveBeenCalledTimes(1);
    } finally {
      await resources.buildsSettled();
      resources.session.invalidate();
    }
  });

  it("builds nothing up front with warmup off, and starts the build at the first call that needs the index", async () => {
    const root = await createProject("cg-mcp-ready-off-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    resources.startWarmup();
    try {
      await resources.buildsSettled();
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
    await expect(resources.buildsSettled()).resolves.toBeUndefined();

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

describe("MCP build registry", () => {
  it("consumes the failure of a build that a call cancelled before it waited", async () => {
    const root = await createProject("cg-mcp-registry-cancelled-");
    const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
    const failure = Promise.withResolvers<void>();
    const session: AgentSession = {
      ...inner,
      loadProject: async () => {
        await failure.promise;
        throw new Error("disk full");
      },
    };
    const resources = createCodegraphMcpResources({ root, session, warmup: "off", mcpIndexWaitMs: 600_000 });
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(resources.handlers.search({ query: "alpha" }, cancelled.signal)).rejects.toThrow(
        "MCP tool call was cancelled.",
      );

      failure.resolve();
      await resources.buildsSettled();
      // Node reports an unhandled rejection once the microtask queue drains, which this real delay outlasts.
      await letShutdownRun();

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("makes refresh_index wait for a build that a tool call started, with the warmup off", async () => {
    const root = await createProject("cg-mcp-registry-refresh-demand-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    try {
      const building = await resources.handlers.orient({}).catch((error: unknown) => error);
      const refreshing = await resources.handlers.refresh_index({}).catch((error: unknown) => error);

      expect(building).toMatchObject({ result: { status: "index_building", tool: "orient" } });
      expect(refreshing).toMatchObject({ result: { status: "index_building", tool: "refresh_index" } });
      expect(held.events).toEqual(["loadProject:start"]);

      held.release();
      await resources.buildsSettled();
      await expect(resources.handlers.refresh_index({})).resolves.toEqual({ refreshed: true, warmup: "off" });
      // The session is replaced after the build that was writing to it.
      expect(held.events).toEqual(["loadProject:start", "loadProject:end", "invalidate"]);
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it("makes refresh_index wait for a detailed symbol graph that a tool call started after the warmup", async () => {
    const root = await createProject("cg-mcp-registry-refresh-symbols-");
    // The warmup loads the project index and the basic symbol graph; only the detailed graph waits.
    const held = holdSession(root, (options) => !options?.symbolGraph || options.symbolGraph === "eager");
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "base", mcpIndexWaitMs: 25 });
    resources.startWarmup();
    try {
      await resources.buildsSettled();
      const building = await resources.handlers.get_symbol({ handle: "alpha" }).catch((error: unknown) => error);
      const refreshing = await resources.handlers.refresh_index({}).catch((error: unknown) => error);

      expect(building).toMatchObject({ result: { status: "index_building", tool: "get_symbol" } });
      expect(refreshing).toMatchObject({ result: { status: "index_building", tool: "refresh_index" } });
      expect(held.events).not.toContain("invalidate");

      held.release();
      await resources.buildsSettled();
      await resources.handlers.refresh_index({});
      expect(held.events.at(-1)).toBe("invalidate");
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it("answers index_building when the rebuild of refresh_index outlasts the budget, and a retry joins that refresh", async () => {
    const root = await createProject("cg-mcp-registry-refresh-budget-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    let drained = false;
    try {
      // The rebuild is held, so a refresh that waited for it past the budget would not answer.
      const first = recordOutcome(resources.handlers.refresh_index({ warmup: "base" }));
      await expectIndexBuilding(first, "refresh_index");

      const retry = recordOutcome(resources.handlers.refresh_index({ warmup: "base" }));
      await expectIndexBuilding(retry, "refresh_index");
      // One replacement and one rebuild served both calls.
      expect(held.events).toEqual(["invalidate", "loadProject:start"]);

      // Neither call waits for the rebuild any more, and a shutdown still does.
      void resources.buildsSettled().then(() => {
        drained = true;
      });
      await letShutdownRun();
      expect(drained).toBe(false);

      held.release();
      await resources.buildsSettled();
      expect(held.events).toEqual(["invalidate", "loadProject:start", "loadProject:end"]);
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it("answers the retry of a cancelled refresh_index with the refresh that still runs", async () => {
    const root = await createProject("cg-mcp-registry-refresh-retry-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({
      root,
      session: held.session,
      warmup: "off",
      mcpIndexWaitMs: 600_000,
    });
    try {
      const cancel = new AbortController();
      const cancelled = recordOutcome(resources.handlers.refresh_index({ warmup: "base" }, cancel.signal));
      await held.started;
      cancel.abort();
      await vi.waitFor(() => expect(cancelled.value).toMatchObject({ message: "MCP tool call was cancelled." }), {
        timeout: 2_000,
      });

      // The retry arrives while the rebuild of the cancelled call still runs.
      const retry = resources.handlers.refresh_index({ warmup: "base" });
      held.release();

      await expect(retry).resolves.toEqual({ refreshed: true, warmup: "base" });
      // The retry waited for that refresh instead of replacing the session and rebuilding it again.
      expect(held.events).toEqual(["invalidate", "loadProject:start", "loadProject:end"]);
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it("answers the retry that comes after the refresh ended with its outcome, and replaces the session once", async () => {
    const root = await createProject("cg-mcp-registry-refresh-ended-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    try {
      const first = recordOutcome(resources.handlers.refresh_index({ warmup: "base" }));
      await expectIndexBuilding(first, "refresh_index");

      // The refresh ends while no call waits for it. A retry that started another refresh would find the rebuild
      // unfinished at its own budget, and so would every retry after it.
      held.release();
      await resources.buildsSettled();
      await expect(resources.handlers.refresh_index({ warmup: "base" })).resolves.toEqual({
        refreshed: true,
        warmup: "base",
      });
      expect(held.events).toEqual(["invalidate", "loadProject:start", "loadProject:end"]);

      // The outcome goes to one retry. The next call is a refresh of its own.
      await expect(resources.handlers.refresh_index({})).resolves.toEqual({ refreshed: true, warmup: "off" });
      expect(held.events.filter((event) => event === "invalidate")).toHaveLength(2);
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it("keeps the outcome of a refresh that was handed off for one retry, within the window", async () => {
    const root = await createProject("cg-mcp-registry-refresh-window-");
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
    let clock = 0;
    const readiness = createMcpIndexReadiness(session, {
      waitMs: 0,
      warmup: "off",
      progress: createMcpBuildProgress(),
      now: () => clock,
    });
    // What `refresh_index` does: replaces the session, rebuilds it, and its call either waits for it or hands it off.
    const refresh = async (handOff: boolean): Promise<void> => {
      session.invalidate();
      const rebuilt = readiness.rebuild("base");
      if (handOff) readiness.handOffRefresh();
      await rebuilt;
    };
    try {
      // The call that waited for its refresh has its answer: nothing is left for a retry.
      await refresh(false);
      expect(readiness.joinRefresh("refresh_index", "base")).toBeUndefined();

      // A retry takes the outcome of a refresh that builds at least what it asks for, and one retry takes it.
      await refresh(true);
      expect(readiness.joinRefresh("refresh_index", "symbols")).toBeUndefined();
      clock = MCP_REFRESH_RETRY_WINDOW_MS;
      const retry = readiness.joinRefresh("refresh_index", "base");
      expect(retry).toBeDefined();
      await retry;
      expect(readiness.joinRefresh("refresh_index", "base")).toBeUndefined();

      // A call after the window is a refresh of its own.
      await refresh(true);
      clock += MCP_REFRESH_RETRY_WINDOW_MS + 1;
      expect(readiness.joinRefresh("refresh_index", "base")).toBeUndefined();
    } finally {
      await readiness.buildsSettled();
      session.invalidate();
    }
  });

  it("keeps no outcome of a refresh that failed, so that the retry runs it again", async () => {
    const root = await createProject("cg-mcp-registry-refresh-failure-");
    const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
    const session: AgentSession = {
      ...inner,
      loadProject: () => Promise.reject(new Error("disk full")),
    };
    const readiness = createMcpIndexReadiness(session, {
      waitMs: 0,
      warmup: "off",
      progress: createMcpBuildProgress(),
    });
    const rebuilt = readiness.rebuild("base");
    readiness.handOffRefresh();

    await expect(rebuilt).rejects.toThrow("disk full");
    expect(readiness.joinRefresh("refresh_index", "base")).toBeUndefined();
    await readiness.buildsSettled();
  });

  it("consumes the failure of a refresh whose call stopped waiting, and replaces the session again at the retry", async () => {
    const root = await createProject("cg-mcp-registry-refresh-failed-");
    const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
    const failure = Promise.withResolvers<void>();
    let failures = 1;
    const session: AgentSession = {
      ...inner,
      loadProject: async (options) => {
        if (failures-- > 0) {
          await failure.promise;
          throw new Error("disk full");
        }
        return await inner.loadProject(options);
      },
    };
    const resources = createCodegraphMcpResources({ root, session, warmup: "off", mcpIndexWaitMs: 25 });
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const first = recordOutcome(resources.handlers.refresh_index({ warmup: "base" }));
      await expectIndexBuilding(first, "refresh_index");

      failure.resolve();
      await resources.buildsSettled();
      // Node reports an unhandled rejection once the microtask queue drains, which this real delay outlasts.
      await letShutdownRun();
      expect(unhandled).toEqual([]);

      // The rebuild is real now and can outlast the budget; a client retries, and each retry joins the refresh that runs.
      const refreshed = await vi.waitFor(() => resources.handlers.refresh_index({ warmup: "base" }), {
        timeout: 10_000,
      });
      expect(refreshed).toEqual({ refreshed: true, warmup: "base" });
    } finally {
      process.off("unhandledRejection", record);
      failure.resolve();
      await resources.buildsSettled();
    }
  });

  it("runs a refresh that asks for more than the one that runs after it, and the call that gave up its turn runs none", async () => {
    const root = await createProject("cg-mcp-registry-refresh-more-");
    // Only the rebuild of the project index is held; the detailed symbol graph loads at once.
    const held = holdSession(root, (options) => options?.symbolGraph === "skip");
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    try {
      const base = recordOutcome(resources.handlers.refresh_index({ warmup: "base" }));
      await expectIndexBuilding(base, "refresh_index");
      // The refresh that runs does not build the detailed symbol graph, so this call waits for its turn behind it.
      const more = recordOutcome(resources.handlers.refresh_index({ warmup: "symbols" }));
      await expectIndexBuilding(more, "refresh_index");
      expect(held.events).toEqual(["invalidate", "loadProject:start"]);

      held.release();
      await resources.buildsSettled();
      // The refresh that ended built the project index only, so a call that asks for the detailed symbol graph as well
      // is a refresh of its own. It starts at its first attempt, and its retries take it over.
      const refreshed = await vi.waitFor(() => resources.handlers.refresh_index({ warmup: "symbols" }), {
        timeout: 10_000,
      });
      expect(refreshed).toEqual({ refreshed: true, warmup: "symbols" });
      // The first call replaced the session once, and the call after it once. The call that gave up its turn replaced
      // it never.
      expect(held.events.filter((event) => event === "invalidate")).toHaveLength(2);
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it("makes a tool call that arrives while a refresh rebuilds wait for it, inside its budget", async () => {
    const root = await createProject("cg-mcp-registry-refresh-queries-");
    // The refresh rebuilds the project index at once and holds on the detailed symbol graph, which `orient` does not read.
    const held = holdSession(root, (options) => !options?.symbolGraph || options.symbolGraph === "eager");
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    try {
      const refreshing = recordOutcome(resources.handlers.refresh_index({ warmup: "symbols" }));
      await expectIndexBuilding(refreshing, "refresh_index");

      // The index is rebuilt, but the session is still being replaced, and the handler of a call that read it now would
      // wait for the rest of the refresh without the budget.
      const orient = recordOutcome(resources.handlers.orient({}));
      await expectIndexBuilding(orient, "orient");

      held.release();
      await resources.buildsSettled();
      const ready = await vi.waitFor(() => resources.handlers.orient({}), { timeout: 10_000 });
      expect(ready.freshness.state).toBe("fresh");
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it("makes explore with source packets wait for the detailed symbol graph and the duplicate analysis, inside the budget", async () => {
    const root = await createProject("cg-mcp-registry-explore-");
    const held = holdDuplicates(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "base", mcpIndexWaitMs: 25 });
    resources.startWarmup();
    try {
      await resources.buildsSettled();
      // The first freshness check scans the project and can outlast the budget; the calls below reuse its answer.
      await held.inner.checkFreshness?.();

      // Source packets are off by default, and `maxPackets: 0` turns them off: the held analysis delays neither.
      const plain = await resources.handlers.explore({ query: "alpha" });
      const none = await resources.handlers.explore({ query: "alpha", includeSource: true, maxPackets: 0 });
      expect(plain.packets).toEqual([]);
      expect(none.packets).toEqual([]);
      expect(held.requests()).toBe(0);

      // Every packet explains its anchor, which reads the duplicate analysis, so a call that built them would block.
      const withSource = recordOutcome(resources.handlers.explore({ query: "alpha", includeSource: true }));
      await expectIndexBuilding(withSource, "explore");

      held.release();
      await resources.buildsSettled();
      const ready = await vi.waitFor(() => resources.handlers.explore({ query: "alpha", includeSource: true }), {
        timeout: 10_000,
      });
      expect(ready.packets.length).toBeGreaterThan(0);
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it("makes artifact_build take its turn of the lock only when no build runs", async () => {
    const root = await createProject("cg-mcp-registry-artifact-");
    const held = holdDuplicates(root);
    await held.inner.loadProject();
    // The first freshness check scans the project and can outlast the budget; the calls below reuse its answer.
    await held.inner.checkFreshness?.();
    const resources = createCodegraphMcpResources({
      root,
      session: held.session,
      readOnly: false,
      warmup: "off",
      mcpIndexWaitMs: 25,
    });
    const outDir = path.join(root, "out");
    try {
      // A packet call starts the duplicate analysis, which stays held, and stops waiting for it.
      await resources.handlers.packet_get({ target: "alpha.ts" }).catch(() => undefined);
      const writing = await resources.handlers
        .artifact_build({ outDir, sqlite: true })
        .catch((error: unknown) => error);

      expect(writing).toMatchObject({ result: { status: "index_building", tool: "artifact_build" } });
      await expect(fs.access(path.join(outDir, "codegraph.sqlite"))).rejects.toThrow();

      held.release();
      await resources.buildsSettled();
      await expect(resources.handlers.artifact_build({ outDir, sqlite: true })).resolves.toMatchObject({
        artifacts: { sqlite: "codegraph.sqlite" },
      });
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it("starts an operation that replaces the session only once the builds that start while it waits have ended", async () => {
    const root = await createProject("cg-mcp-registry-idle-");
    const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
    const loads: Array<PromiseWithResolvers<void>> = [];
    const session: AgentSession = {
      ...inner,
      loadProject: async (options) => {
        const gate = Promise.withResolvers<void>();
        loads.push(gate);
        await gate.promise;
        return await inner.loadProject(options);
      },
    };
    const readiness = createMcpIndexReadiness(session, {
      waitMs: 0,
      warmup: "off",
      progress: createMcpBuildProgress(),
    });
    const replace = vi.fn(async () => "replaced");
    try {
      void readiness.waitFor("orient", ["index"]).catch(() => undefined);
      await vi.waitFor(() => expect(loads).toHaveLength(1));
      const replacing = readiness.whenIdle(replace);
      // A call that arrives while the operation waits starts a build of its own: the detailed graph, after the index.
      void readiness.waitFor("get_symbol", ["symbols"]).catch(() => undefined);

      loads[0]?.resolve();
      await vi.waitFor(() => expect(loads).toHaveLength(2));
      await letShutdownRun();
      expect(replace).not.toHaveBeenCalled();

      loads[1]?.resolve();
      await expect(replacing).resolves.toBe("replaced");
    } finally {
      for (const gate of loads) gate.resolve();
      await readiness.buildsSettled();
    }
  });

  it("keeps a build whose call stopped waiting until it ends", async () => {
    const root = await createProject("cg-mcp-registry-tracked-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    let drained = false;
    try {
      const building = await resources.handlers.orient({}).catch((error: unknown) => error);
      expect(building).toMatchObject({ result: { status: "index_building", tool: "orient" } });

      const settled = resources.buildsSettled().then(() => {
        drained = true;
      });
      await letShutdownRun();
      expect(drained).toBe(false);

      held.release();
      await settled;
      expect(held.events).toEqual(["loadProject:start", "loadProject:end"]);
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it("releases the session after a build whose call stopped waiting, when the HTTP server closes", async () => {
    const root = await createProject("cg-mcp-registry-http-");
    const held = holdSession(root);
    const server = await startCodegraphMcpHttpServer({
      root,
      port: 0,
      session: held.session,
      warmup: "off",
      mcpIndexWaitMs: 25,
    });
    const client = new Client({ name: "mcp-build-registry-http", version: "1.0.0" });
    let closing: Promise<void> | undefined;
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      const building = await callTool(client, "orient", {});
      expect(parseBody(building.text)).toMatchObject({ status: "index_building", tool: "orient" });
      await client.close();

      closing = server.close();
      await letShutdownRun();
      // The call has its answer, and its build still writes to the session.
      expect(held.events).not.toContain("invalidate");

      held.release();
      await closing;
      expect(held.events).toEqual(["loadProject:start", "loadProject:end", "invalidate"]);
    } finally {
      held.release();
      await client.close();
      await (closing ?? server.close());
    }
  });

  it("releases the session after a build whose call stopped waiting, when the stdio server stops", async () => {
    const root = await createProject("cg-mcp-registry-stdio-");
    const held = holdSession(root);
    await withStandInStdio(async ({ stdin, stdout }) => {
      const lines: string[] = [];
      createInterface({ input: stdout }).on("line", (line) => lines.push(line));
      let served = false;
      const serving = serveCodegraphMcp({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 }).then(() => {
        served = true;
      });
      try {
        const frames = [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "stdio-test", version: "1" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "orient", arguments: {} } },
        ];
        stdin.write(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
        await vi.waitFor(
          () => expect(lines.some((line) => line.includes('"id":2') && line.includes("index_building"))).toBe(true),
          { timeout: 20_000 },
        );

        stdin.end();
        await letShutdownRun();
        // Nothing else holds the server open, so only the build can.
        expect(served).toBe(false);
        expect(held.events).not.toContain("invalidate");

        held.release();
        await serving;
        expect(held.events).toEqual(["loadProject:start", "loadProject:end", "invalidate"]);
      } finally {
        held.release();
        stdin.end();
        await serving;
      }
    });
  });

  it("builds a review packet from the session's index and duplicate analysis, inside the budget", async () => {
    const root = await createProject("cg-mcp-registry-packet-review-");
    runGit(root, ["init"]);
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-m", "one"]);
    await fs.appendFile(path.join(root, "alpha.ts"), "export const gamma = 3;\n", "utf8");
    runGit(root, ["commit", "-am", "two"]);
    const held = holdDuplicates(root);
    const indexBuilds = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
    const preparations = vi.spyOn(duplicatesModule, "prepareDuplicateAnalysis");
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    const target = "review:base=HEAD~1;head=HEAD";
    try {
      const waiting = await resources.handlers.packet_get({ target }).catch((error: unknown) => error);

      expect(waiting).toMatchObject({ result: { status: "index_building", tool: "packet_get" } });

      held.release();
      await resources.buildsSettled();
      const packet = await resources.handlers.packet_get({ target });

      expect(packet).toMatchObject({ kind: "review", packet: { status: "ok" } });
      // One index and one duplicate analysis served the wait and the report.
      expect(indexBuilds).toHaveBeenCalledTimes(1);
      expect(preparations).toHaveBeenCalledTimes(1);
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it("reads no duplicate context for refs by handle", async () => {
    const root = await createProject("cg-mcp-registry-refs-");
    const held = holdDuplicates(root);
    const handle = await symbolHandle(root, held.inner, "beta");
    await held.inner.loadProject();
    // The first freshness check scans the project and can outlast the budget; the call below reuses its answer.
    await held.inner.checkFreshness?.();
    const scans = vi.spyOn(duplicatesModule, "findDuplicateContext");
    const preparations = vi.spyOn(duplicatesModule, "prepareDuplicateAnalysis");
    const resources = createCodegraphMcpResources({
      root,
      session: held.session,
      warmup: "off",
      mcpIndexWaitMs: 2_000,
    });
    try {
      // The duplicate analysis is held, so a refs that read it would not answer.
      const references = await resources.handlers.refs({ handle });

      expect(references.references.map((reference) => reference.file)).toContain("alpha.ts");
      expect(held.requests()).toBe(0);
      expect(scans).not.toHaveBeenCalled();
      expect(preparations).not.toHaveBeenCalled();
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it("prepares the duplicate context of a file packet through the session, inside the budget", async () => {
    const root = await createProject("cg-mcp-registry-packet-duplicates-");
    const held = holdDuplicates(root);
    await held.inner.loadProject();
    // The first freshness check scans the project and can outlast the budget; the calls below reuse its answer.
    await held.inner.checkFreshness?.();
    const scans = vi.spyOn(duplicatesModule, "findDuplicateContext");
    const preparations = vi.spyOn(duplicatesModule, "prepareDuplicateAnalysis");
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    try {
      const waiting = await resources.handlers.packet_get({ target: "alpha.ts" }).catch((error: unknown) => error);

      expect(waiting).toMatchObject({ result: { status: "index_building", tool: "packet_get" } });

      held.release();
      await resources.buildsSettled();
      const packet = await resources.handlers.packet_get({ target: "alpha.ts" });

      expect(packet).toMatchObject({ kind: "file" });
      expect(preparations).toHaveBeenCalledTimes(1);
      expect(scans).not.toHaveBeenCalled();
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });

  it.each([true, false])(
    "answers a fresh SQLite artifact at once and budgets the session wait of a stale one (readOnly %s)",
    async (readOnly) => {
      const root = await createProject("cg-mcp-registry-sqlite-");
      const outDir = path.join(root, "artifacts");
      const builder = createCodegraphMcpHandlers({ root, readOnly: false, buildOptions: { cache: "off" } });
      try {
        await builder.artifact_build({ outDir, sqlite: true });
      } finally {
        builder.dispose();
      }
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const build = indexerBuild.buildProjectIndexIncremental;
      vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
        started.resolve();
        await release.promise;
        return await build(...args);
      });
      const resources = createCodegraphMcpResources({
        root,
        watch: false,
        readOnly,
        artifactPath: outDir,
        warmup: "base",
        mcpIndexWaitMs: 25,
        buildOptions: { cache: "off" },
      });
      try {
        resources.startWarmup();
        await started.promise;

        // The artifact's own file signatures decide, so the session that is still building is not asked.
        await expect(resources.handlers.query_sqlite({ query: "SELECT path FROM files;" })).resolves.toMatchObject({
          freshness: { state: "fresh" },
        });

        await fs.appendFile(path.join(root, "alpha.ts"), "export const gamma = 3;\n", "utf8");
        let outcome: unknown;
        void resources.handlers.query_sqlite({ query: "SELECT path FROM files;" }).then(
          (value) => {
            outcome = value;
          },
          (error: unknown) => {
            outcome = error;
          },
        );
        await vi.waitFor(
          () => expect(outcome).toMatchObject({ result: { status: "index_building", tool: "query_sqlite" } }),
          { timeout: 2_000 },
        );

        release.resolve();
        await resources.buildsSettled();
        await resources.session.loadProject();
        if (readOnly) {
          await expect(resources.handlers.query_sqlite({ query: "SELECT path FROM files;" })).rejects.toThrow(
            /SQLite artifact is stale/,
          );
        } else {
          await expect(resources.handlers.query_sqlite({ query: "SELECT path FROM files;" })).resolves.toMatchObject({
            freshness: { state: "refreshed" },
          });
        }
      } finally {
        release.resolve();
        await resources.buildsSettled();
      }
    },
  );

  it("checks freshness and rebuilds inside the budget after a file changed", async () => {
    const root = await createProject("cg-mcp-registry-changed-");
    const hold = Promise.withResolvers<void>();
    let held = false;
    const build = indexerBuild.buildProjectIndexIncremental;
    vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      if (held) await hold.promise;
      return await build(...args);
    });
    const resources = createCodegraphMcpResources({
      root,
      watch: false,
      warmup: "base",
      mcpIndexWaitMs: 25,
      buildOptions: { cache: "off" },
    });
    try {
      resources.startWarmup();
      await resources.buildsSettled();
      held = true;
      await fs.appendFile(path.join(root, "alpha.ts"), "export const gamma = 3;\n", "utf8");

      let outcome: unknown;
      void resources.handlers.search({ query: "gamma" }).then(
        (value) => {
          outcome = value;
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      // The call finds the change and starts the rebuild inside its budget, then answers that the build is running.
      await vi.waitFor(() => expect(outcome).toMatchObject({ result: { status: "index_building", tool: "search" } }), {
        timeout: 2_000,
      });

      hold.resolve();
      await resources.buildsSettled();
      const ready = await resources.handlers.search({ query: "gamma" });

      expect(ready.results.map((result) => result.label)).toContain("gamma");
    } finally {
      hold.resolve();
      await resources.buildsSettled();
    }
  });

  it("runs its builds again when the session was replaced while it waited", async () => {
    const root = await createProject("cg-mcp-registry-replaced-");
    const gates: Array<PromiseWithResolvers<void>> = [];
    const build = indexerBuild.buildProjectIndexIncremental;
    vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      await gate.promise;
      return await build(...args);
    });
    const resources = createCodegraphMcpResources({
      root,
      watch: false,
      warmup: "off",
      mcpIndexWaitMs: 300,
      buildOptions: { cache: "off" },
    });
    try {
      let outcome: unknown;
      void resources.handlers.orient({}).then(
        (value) => {
          outcome = value;
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      // Another call's freshness check, or a refresh, replaced the session while the first build ran.
      resources.session.invalidate();
      gates[0]?.resolve();

      // The build of the replaced session does not serve the call: it builds again inside its budget.
      await vi.waitFor(() => expect(outcome).toMatchObject({ result: { status: "index_building", tool: "orient" } }), {
        timeout: 3_000,
      });
      await vi.waitFor(() => expect(gates).toHaveLength(2));
    } finally {
      for (const gate of gates) gate.resolve();
      await resources.buildsSettled();
    }
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
  it("gates exactly the handlers that exist", async () => {
    const root = await createProject("cg-mcp-stages-names-");
    const handlers = createCodegraphMcpHandlers({ root });
    try {
      const handlerNames = Object.keys(handlers).filter((name) => name !== "dispose");

      expect(Object.keys(MCP_STAGES_BY_HANDLER).sort()).toEqual(handlerNames.sort());
    } finally {
      handlers.dispose();
    }
  });

  it("declares for every handler what it loads from the session", async () => {
    const root = await createProject("cg-mcp-stages-");
    await fs.writeFile(path.join(root, "schema.sql"), "create table users (id int);\n", "utf8");
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
      buildsSettled: async () => undefined,
      whenIdle: async (operation) => await operation(),
      waitFor: async (_tool, stages) => {
        declared.push(...stages);
      },
      waitUntil: async () => undefined,
      rebuild: async () => undefined,
      handOffRefresh: () => undefined,
      joinRefresh: () => undefined,
    };
    const plain = createCodegraphMcpHandlers({ root, session: inner });
    const context: McpStageContext = {
      reviewRangeHasChanges: async (request) =>
        (await collectReviewChanges(root, { gitBase: request.base, gitHead: request.head })).changedFiles.size > 0,
    };
    const handlers = withIndexReadiness(
      createCodegraphMcpHandlers({ root, session, readOnly: false }),
      MCP_STAGES_BY_HANDLER,
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
    const users = (await plain.search({ query: "users", mode: "sql" })).results.find(
      (result) => result.kind === "sql_object",
    )?.handle;
    if (!users) throw new Error("No SQL object users.");
    const chunk = (await plain.search({ query: "beta", mode: "text" })).results.find(
      (result) => result.kind === "chunk",
    )?.handle;
    if (!chunk) throw new Error("No text chunk for beta.");
    // `refresh_index` is no scenario: it declares no stage, because it takes its own turn and waits for its rebuild
    // itself. Its tests are in "MCP build registry".
    const scenarios: Array<[string, () => Promise<unknown>]> = [
      ["search hybrid", () => handlers.search({ query: "alpha beta" })],
      ["search text", () => handlers.search({ query: "beta", mode: "text" })],
      ["search symbol", () => handlers.search({ query: "gamma", mode: "symbol" })],
      ["search graph", () => handlers.search({ query: "alpha", mode: "graph" })],
      ["search path", () => handlers.search({ query: "alpha", mode: "path" })],
      ["explore", () => handlers.explore({ query: "alpha" })],
      ["explore with source packets", () => handlers.explore({ query: "alpha", includeSource: true })],
      // Another query than the scenario before: a repeated search is answered from the session's cache, which would
      // hide its query index from this scenario.
      [
        "explore with source packets turned off by maxPackets",
        () => handlers.explore({ query: "beta", includeSource: true, maxPackets: 0 }),
      ],
      ["orient", () => handlers.orient({})],
      ["workspace_symbols", () => handlers.workspace_symbols({ query: "alpha" })],
      ["goto", () => handlers.goto({ file: "alpha.ts", line: 2, column: 16 })],
      ["file_deps", () => handlers.file_deps({ direction: "deps", file: "alpha.ts" })],
      ["path", () => handlers.path({ from: "alpha.ts", to: "beta.ts" })],
      ["get_file", () => handlers.get_file({ file: "alpha.ts" })],
      ["get_file with graph context", () => handlers.get_file({ file: "alpha.ts", includeGraphContext: true })],
      ["get_symbol", () => handlers.get_symbol({ handle: alpha })],
      ["packet_get", () => handlers.packet_get({ target: "alpha.ts" })],
      ["packet_get of a symbol handle", () => handlers.packet_get({ target: alpha })],
      ["packet_get of a SQL handle", () => handlers.packet_get({ target: users })],
      ["packet_get of a chunk handle", () => handlers.packet_get({ target: chunk })],
      [
        "packet_get of a review range with changes",
        () => handlers.packet_get({ target: "review:base=HEAD~1;head=HEAD" }),
      ],
      [
        "packet_get of a review range without changes",
        () => handlers.packet_get({ target: "review:base=HEAD;head=HEAD" }),
      ],
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
