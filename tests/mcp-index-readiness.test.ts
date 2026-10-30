import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { formatAgentSqlHandle } from "../src/agent/handles.js";
import * as queryIndexStore from "../src/agent/query-index/session-store.js";
import * as queryIndexUpdate from "../src/agent/query-index/update.js";
import { createAgentSession, type AgentLoadProjectOptions, type AgentSession } from "../src/agent/session.js";
import * as indexerBuild from "../src/indexer/build-index.js";
import { createCodegraphMcpResources } from "../src/mcp/handlers.js";
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

async function createProject(prefix: string, roots = tempRoots): Promise<string> {
  const root = await roots.create(prefix);
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

/** A project with two commits, the second of which changes `alpha.ts`: `HEAD~1..HEAD` has a changed file. */
async function createReviewProject(prefix: string, roots = tempRoots): Promise<string> {
  const root = await createProject(prefix, roots);
  runGit(root, ["init"]);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-m", "one"]);
  await fs.appendFile(path.join(root, "alpha.ts"), "export const gamma = 3;\n", "utf8");
  runGit(root, ["commit", "-am", "two"]);
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

/** What a tool reads from the session that `holdLoad` can hold back. */
type HeldLoad = "index" | "graph" | "detailed" | "query" | "duplicates";

/**
 * A session in which only the load `kind` waits until `release()`; every other load runs for real. `requested` counts
 * how often a caller asked for the held load.
 */
function holdLoad(
  root: string,
  kind: HeldLoad,
): { session: AgentSession; release: () => void; requested: () => number } {
  const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
  const loadDuplicates = inner.loadDuplicateAnalysis;
  if (!loadDuplicates) throw new Error("The session has no duplicate analysis.");
  const gate = Promise.withResolvers<void>();
  let requests = 0;
  const hold = async (): Promise<void> => {
    requests += 1;
    await gate.promise;
  };
  // `loadProject` serves three loads: the project index, the symbol graph, and the detailed symbol graph.
  const holdsProject = (options: AgentLoadProjectOptions | undefined): boolean => {
    const symbolGraph = options?.symbolGraph ?? "eager";
    if (kind === "index") return symbolGraph === "skip";
    if (kind === "graph") return symbolGraph === "basic";
    return kind === "detailed" && symbolGraph === "eager";
  };
  const session: AgentSession = {
    ...inner,
    loadProject: async (options) => {
      if (holdsProject(options)) await hold();
      return await inner.loadProject(options);
    },
    loadDuplicateAnalysis: async () => {
      if (kind === "duplicates") await hold();
      return await loadDuplicates();
    },
  };
  if (kind === "query") {
    const ensureQueryIndex = queryIndexStore.ensureSessionQueryIndex;
    vi.spyOn(queryIndexStore, "ensureSessionQueryIndex").mockImplementation(async (...args) => {
      await hold();
      return await ensureQueryIndex(...args);
    });
  }
  return { session, release: gate.resolve, requested: () => requests };
}

/**
 * A session for the two loads that a hybrid search and the default warmup start side by side: the basic symbol graph
 * fails at once, and the project index load that the search index starts with waits until `release()`. `events` records
 * that load and the invalidation of the session.
 */
function failOneLoadHoldAnother(root: string): { session: AgentSession; release: () => void; events: string[] } {
  const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  const session: AgentSession = {
    ...inner,
    loadProject: async (options) => {
      if (options?.symbolGraph === "basic") throw new Error("disk full");
      events.push("loadProject:start");
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
  return { session, release: gate.resolve, events };
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
    timeout: 10_000,
  });
}

/** Waits for a normal answer, which a call that waited for a build it does not read would never give. */
async function expectAnswered(outcome: { readonly value: unknown }): Promise<void> {
  await vi.waitFor(() => expect(outcome.value).toBeDefined(), { timeout: 15_000 });
  expect(outcome.value).not.toBeInstanceOf(Error);
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

  it("joins the build that is running, so that a retry waits for what is left of it", async () => {
    const root = await createProject("cg-mcp-ready-retry-");
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
      warmup: "off",
      mcpIndexWaitMs: 25,
      buildOptions: { cache: "off" },
    });
    try {
      const first = await resources.handlers.orient({}).catch((error: unknown) => error);
      await started.promise;
      const second = await resources.handlers.orient({}).catch((error: unknown) => error);

      expect(first).toMatchObject({ result: { status: "index_building", tool: "orient" } });
      expect(second).toMatchObject({ result: { status: "index_building", tool: "orient" } });

      release.resolve();
      await resources.buildsSettled();
      await expect(resources.handlers.orient({})).resolves.toMatchObject({ freshness: { state: "fresh" } });
      expect(buildSpy).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await resources.buildsSettled();
      resources.session.invalidate();
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

  it("shares one build between the warmup and concurrent calls, whichever tool they are", async () => {
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
    const root = await createReviewProject("cg-mcp-ready-review-");
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
    const root = await createReviewProject("cg-mcp-ready-review-off-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    resources.startWarmup();

    await expect(resources.handlers.review({ base: "HEAD", head: "HEAD" })).resolves.toMatchObject({
      status: "no_changes",
    });
    expect(held.events).toEqual([]);
  });

  it("asks git for the diff once per review call, and builds the report from that answer", async () => {
    const root = await createReviewProject("cg-mcp-ready-review-once-");
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
      expect(diffs).toHaveBeenCalledTimes(1);
      const empty = await resources.handlers.review({ base: "HEAD", head: "HEAD" });

      expect(report).toMatchObject({ status: "ok", changedFiles: [expect.objectContaining({ file: "alpha.ts" })] });
      expect(empty).toMatchObject({ status: "no_changes" });
      expect(diffs).toHaveBeenCalledTimes(2);
    } finally {
      await resources.buildsSettled();
      resources.session.invalidate();
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
      await resources.buildsSettled();
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

describe("MCP tools that wait for the index without a budget", () => {
  it.each([
    ["refresh_index", (handlers: CodegraphMcpHandlers) => handlers.refresh_index({ warmup: "base" })],
    ["goto", (handlers: CodegraphMcpHandlers) => handlers.goto({ file: "alpha.ts", line: 2, column: 16 })],
    ["file_deps", (handlers: CodegraphMcpHandlers) => handlers.file_deps({ direction: "deps", file: "alpha.ts" })],
  ])("%s waits for a build past the budget, as it always did", async (_tool, call) => {
    const root = await createProject("cg-mcp-ready-unbudgeted-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "off", mcpIndexWaitMs: 25 });
    let settled = false;
    const pending = call(resources.handlers).finally(() => {
      settled = true;
    });
    try {
      await held.started;
      await letShutdownRun();

      expect(settled).toBe(false);

      held.release();
      await expect(pending).resolves.toBeDefined();
    } finally {
      held.release();
      await pending.catch(() => undefined);
    }
  });

  it("replaces the session at once for refresh_index, even while a build runs, and answers the refresh without a status", async () => {
    const root = await createProject("cg-mcp-ready-refresh-");
    const held = holdSession(root);
    const resources = createCodegraphMcpResources({ root, session: held.session, warmup: "base", mcpIndexWaitMs: 25 });
    resources.startWarmup();
    try {
      await held.started;
      const refreshing = resources.handlers.refresh_index({});

      await expect(refreshing).resolves.toEqual({ refreshed: true, warmup: "off" });
      expect(held.events).toContain("invalidate");
      expect(held.events).not.toContain("loadProject:end");
    } finally {
      held.release();
      await resources.buildsSettled();
    }
  });
});

describe("MCP tools that wait within the budget", () => {
  let reviewRoot = "";
  const suiteRoots = createTempRootRegistry();
  beforeAll(async () => {
    reviewRoot = await createReviewProject("cg-mcp-ready-reads-", suiteRoots);
    await fs.writeFile(path.join(reviewRoot, "schema.sql"), "create table users (id int);\n", "utf8");
  });
  afterAll(async () => {
    await suiteRoots.cleanup();
  });
  // The table `users` that `beforeAll` writes into `schema.sql`.
  const sqlHandle = formatAgentSqlHandle({ name: "users", file: "schema.sql", line: 1 });

  type Scenario = {
    name: string;
    tool: string;
    call: (handlers: CodegraphMcpHandlers) => Promise<unknown>;
    /** The loads that the call waits for: with one held, it answers `index_building`. */
    waitsFor: HeldLoad[];
    /** The loads that the call never asks for: with one held, it answers normally. */
    ignores: HeldLoad[];
  };
  const everyLoad: HeldLoad[] = ["index", "graph", "detailed", "query", "duplicates"];
  const scenarios: Scenario[] = [
    {
      name: "search, hybrid",
      tool: "search",
      call: (handlers) => handlers.search({ query: "alpha" }),
      waitsFor: ["index", "graph", "query"],
      ignores: ["detailed", "duplicates"],
    },
    {
      name: "search, text",
      tool: "search",
      call: (handlers) => handlers.search({ query: "beta", mode: "text" }),
      waitsFor: ["index", "query"],
      ignores: ["graph", "detailed", "duplicates"],
    },
    {
      name: "search, symbol",
      tool: "search",
      call: (handlers) => handlers.search({ query: "gamma", mode: "symbol" }),
      waitsFor: ["graph"],
      ignores: ["query", "detailed", "duplicates"],
    },
    {
      name: "search, sql",
      tool: "search",
      call: (handlers) => handlers.search({ query: "users", mode: "sql" }),
      waitsFor: ["index"],
      ignores: ["graph", "query", "detailed", "duplicates"],
    },
    {
      name: "search, path",
      tool: "search",
      call: (handlers) => handlers.search({ query: "alpha", mode: "path" }),
      waitsFor: [],
      ignores: everyLoad,
    },
    {
      name: "search, path from a file",
      tool: "search",
      call: (handlers) => handlers.search({ query: "beta", mode: "path", from: "alpha.ts" }),
      waitsFor: ["index"],
      ignores: ["graph", "query", "detailed", "duplicates"],
    },
    {
      name: "explore",
      tool: "explore",
      call: (handlers) => handlers.explore({ query: "alpha" }),
      waitsFor: ["index", "graph", "query"],
      ignores: ["detailed", "duplicates"],
    },
    {
      name: "explore with source packets",
      tool: "explore",
      call: (handlers) => handlers.explore({ query: "alpha", includeSource: true }),
      waitsFor: ["index", "graph", "query", "detailed", "duplicates"],
      ignores: [],
    },
    {
      name: "explore with source packets turned off by maxPackets",
      tool: "explore",
      call: (handlers) => handlers.explore({ query: "beta", includeSource: true, maxPackets: 0 }),
      waitsFor: ["index", "graph", "query"],
      ignores: ["detailed", "duplicates"],
    },
    {
      name: "orient",
      tool: "orient",
      call: (handlers) => handlers.orient({}),
      waitsFor: ["index"],
      ignores: ["graph", "query", "detailed", "duplicates"],
    },
    {
      name: "workspace_symbols",
      tool: "workspace_symbols",
      call: (handlers) => handlers.workspace_symbols({ query: "alpha" }),
      waitsFor: ["index"],
      ignores: ["graph", "query", "detailed", "duplicates"],
    },
    {
      name: "impact",
      tool: "impact",
      call: (handlers) => handlers.impact({ base: "HEAD~1", head: "HEAD" }),
      waitsFor: ["index"],
      ignores: ["graph", "query", "detailed", "duplicates"],
    },
    {
      name: "get_file with graph context",
      tool: "get_file",
      call: (handlers) => handlers.get_file({ file: "alpha.ts", includeGraphContext: true }),
      waitsFor: ["index"],
      ignores: ["graph", "query", "detailed", "duplicates"],
    },
    {
      name: "get_file without graph context",
      tool: "get_file",
      call: (handlers) => handlers.get_file({ file: "alpha.ts" }),
      waitsFor: [],
      ignores: everyLoad,
    },
    {
      name: "review of a range with changes",
      tool: "review",
      call: (handlers) => handlers.review({ base: "HEAD~1", head: "HEAD" }),
      waitsFor: ["index", "duplicates"],
      ignores: ["graph", "query", "detailed"],
    },
    {
      name: "review of a range without changes",
      tool: "review",
      call: (handlers) => handlers.review({ base: "HEAD", head: "HEAD" }),
      waitsFor: [],
      ignores: everyLoad,
    },
    {
      name: "packet_get of a file",
      tool: "packet_get",
      call: (handlers) => handlers.packet_get({ target: "alpha.ts" }),
      waitsFor: ["detailed", "duplicates"],
      ignores: ["graph", "query"],
    },
    {
      name: "packet_get of a SQL handle",
      tool: "packet_get",
      call: (handlers) => handlers.packet_get({ target: sqlHandle }),
      waitsFor: ["detailed"],
      ignores: ["graph", "query", "duplicates"],
    },
    {
      name: "packet_get of a SQL object name",
      tool: "packet_get",
      call: (handlers) => handlers.packet_get({ target: "users" }),
      waitsFor: ["detailed"],
      ignores: ["graph", "query", "duplicates"],
    },
    {
      name: "packet_get of a review range",
      tool: "packet_get",
      call: (handlers) => handlers.packet_get({ target: "review:base=HEAD~1;head=HEAD" }),
      waitsFor: [],
      ignores: everyLoad,
    },
  ];
  const rows = scenarios.flatMap((scenario) => [
    ...scenario.waitsFor.map((held) => ({ scenario, held, waits: true })),
    ...scenario.ignores.map((held) => ({ scenario, held, waits: false })),
  ]);

  it.each(rows)("$scenario.name, with the $held load held, answers index_building: $waits", async (row) => {
    const { scenario, held, waits } = row;
    const gate = holdLoad(reviewRoot, held);
    const resources = createCodegraphMcpResources({
      root: reviewRoot,
      session: gate.session,
      warmup: "off",
      // A call that must answer gets a budget that no real build on this project outlasts, so that only a wait for the
      // held load can keep it from answering.
      mcpIndexWaitMs: waits ? 25 : 60_000,
    });
    try {
      const outcome = recordOutcome(scenario.call(resources.handlers));

      if (waits) {
        await expectIndexBuilding(outcome, scenario.tool);
        // The call gave up while it still built the other loads; the one it asked for next is the held one.
        await vi.waitFor(() => expect(gate.requested()).toBeGreaterThan(0), { timeout: 10_000 });
      } else {
        await expectAnswered(outcome);
        expect(gate.requested()).toBe(0);
      }
    } finally {
      gate.release();
      await resources.buildsSettled();
      resources.session.invalidate();
    }
  });

  it("fails a packet_get whose target does not resolve at once, without waiting for the duplicate analysis", async () => {
    const gate = holdLoad(reviewRoot, "duplicates");
    const resources = createCodegraphMcpResources({
      root: reviewRoot,
      session: gate.session,
      warmup: "off",
      mcpIndexWaitMs: 2_000,
    });
    try {
      await resources.session.loadProject();

      await expect(resources.handlers.packet_get({ target: "noSuchSymbol" })).rejects.toThrow(
        "Packet target did not resolve: noSuchSymbol",
      );
      expect(gate.requested()).toBe(0);
    } finally {
      gate.release();
      await resources.buildsSettled();
      resources.session.invalidate();
    }
  });
});

describe("MCP shutdown and the loads that a call stopped waiting for", () => {
  it("keeps a build whose call stopped waiting until it ends", async () => {
    const root = await createProject("cg-mcp-drain-tracked-");
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
    const root = await createProject("cg-mcp-drain-http-");
    const held = holdSession(root);
    const server = await startCodegraphMcpHttpServer({
      root,
      port: 0,
      session: held.session,
      warmup: "off",
      mcpIndexWaitMs: 25,
    });
    const client = new Client({ name: "mcp-drain-http", version: "1.0.0" });
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
    const root = await createProject("cg-mcp-drain-stdio-");
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

  it("keeps the load that ran beside a failed one in the drain, for a call", async () => {
    const root = await createProject("cg-mcp-drain-sibling-call-");
    const sibling = failOneLoadHoldAnother(root);
    const resources = createCodegraphMcpResources({
      root,
      session: sibling.session,
      warmup: "off",
      mcpIndexWaitMs: 600_000,
    });
    let drained = false;
    try {
      // The call reports the failure at once, while the load that ran beside it still waits.
      await expect(resources.handlers.search({ query: "alpha" })).rejects.toThrow("disk full");

      const settled = resources.buildsSettled().then(() => {
        drained = true;
      });
      await letShutdownRun();
      expect(drained).toBe(false);

      sibling.release();
      await settled;
      expect(sibling.events).toEqual(["loadProject:start", "loadProject:end"]);
    } finally {
      sibling.release();
      await resources.buildsSettled();
      resources.session.invalidate();
    }
  });

  it("releases the session after the load that ran beside a failed one of the warmup, when the HTTP server closes", async () => {
    const root = await createProject("cg-mcp-drain-sibling-http-");
    const sibling = failOneLoadHoldAnother(root);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await startCodegraphMcpHttpServer({ root, port: 0, session: sibling.session, warmup: "base" });
    let closing: Promise<void> | undefined;
    try {
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(expect.stringContaining("MCP startup warmup failed: disk full")),
      );

      closing = server.close();
      await letShutdownRun();
      // The warmup as a whole has failed, and the load that ran beside the failure still writes to the session.
      expect(sibling.events).not.toContain("invalidate");

      sibling.release();
      await closing;
      expect(sibling.events).toEqual(["loadProject:start", "loadProject:end", "invalidate"]);
    } finally {
      sibling.release();
      await (closing ?? server.close());
    }
  });

  describe("unhandled rejections", () => {
    async function failingLoad(prefix: string, mcpIndexWaitMs: number) {
      const root = await createProject(prefix);
      const inner = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "auto" } });
      const failure = Promise.withResolvers<void>();
      let loads = 0;
      const session: AgentSession = {
        ...inner,
        loadProject: async () => {
          loads += 1;
          await failure.promise;
          throw new Error("disk full");
        },
      };
      const resources = createCodegraphMcpResources({ root, session, warmup: "off", mcpIndexWaitMs });
      return { resources, failure, loads: () => loads };
    }

    // Node reports an unhandled rejection once the microtask queue drains, which the real delay of `letShutdownRun`
    // outlasts.
    async function recordingUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
      const unhandled: unknown[] = [];
      const record = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", record);
      try {
        await run();
        await letShutdownRun();
      } finally {
        process.off("unhandledRejection", record);
      }
      return unhandled;
    }

    it("consumes the failure of a build whose call was cancelled while it waited", async () => {
      const { resources, failure } = await failingLoad("cg-mcp-drain-cancelled-", 600_000);

      const unhandled = await recordingUnhandledRejections(async () => {
        const controller = new AbortController();
        const cancelled = resources.handlers.search({ query: "alpha" }, controller.signal);
        controller.abort();
        await expect(cancelled).rejects.toThrow("MCP tool call was cancelled.");

        failure.resolve();
        await resources.buildsSettled();
      });

      expect(unhandled).toEqual([]);
    });

    it("starts no build for a call that was cancelled before it began", async () => {
      const { resources, failure, loads } = await failingLoad("cg-mcp-drain-precancelled-", 600_000);
      const cancelled = new AbortController();
      cancelled.abort();

      const unhandled = await recordingUnhandledRejections(async () => {
        await expect(resources.handlers.orient({}, cancelled.signal)).rejects.toThrow("MCP tool call was cancelled.");
        failure.resolve();
        await resources.buildsSettled();
      });

      expect(loads()).toBe(0);
      expect(unhandled).toEqual([]);
    });

    it("consumes the failure of a build whose call answered index_building, and reports it at the next call", async () => {
      const { resources, failure } = await failingLoad("cg-mcp-drain-failed-", 25);

      const unhandled = await recordingUnhandledRejections(async () => {
        const waiting = await resources.handlers.orient({}).catch((error: unknown) => error);
        expect(waiting).toMatchObject({ result: { status: "index_building", tool: "orient" } });

        failure.resolve();
        await resources.buildsSettled();
      });

      expect(unhandled).toEqual([]);
      await expect(resources.handlers.orient({})).rejects.toThrow("disk full");
    });
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
