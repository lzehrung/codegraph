import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "../src/agent/session.js";
import { searchCodegraph, searchCodegraphWithSession } from "../src/agent/search.js";
import type { SymbolEdge, SymbolGraph, SymbolNode } from "../src/graphs.js";
import { SymbolKind, type ModuleIndex, type ProjectIndex, type SymbolDef } from "../src/indexer/types.js";
import type { Graph, Range } from "../src/types.js";

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-search-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(
    path.join(root, "src", "auth.ts"),
    [
      "export function validateUser(token: string) {",
      "  return token.length > 0;",
      "}",
      "",
      "export function revokeSession(sessionId: string) {",
      "  return sessionId.length > 0;",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "src", "api.ts"),
    "import { validateUser } from './auth';\nexport function handleLogin(token: string) { return validateUser(token); }\n",
  );
  await fs.writeFile(
    path.join(root, "schema.sql"),
    "CREATE TABLE public.users (id int primary key, email text);\nCREATE VIEW active_users AS SELECT id FROM public.users;\n",
  );
  return root;
}

function countingSession(session: AgentSession): { session: AgentSession; loads: () => number } {
  let cached: Promise<AgentProjectSnapshot> | undefined;
  let loadCount = 0;
  return {
    session: {
      loadProject: async () => {
        if (!cached) {
          loadCount += 1;
          cached = session.loadProject();
        }
        return await cached;
      },
      invalidate: () => {
        cached = undefined;
        session.invalidate();
      },
    },
    loads: () => loadCount,
  };
}

function oneLineRange(index: number): Range {
  return {
    start: { line: 1, column: 1, index },
    end: { line: 1, column: 10, index: index + 9 },
  };
}

function symbolDef(file: string, name: string, index: number): SymbolDef {
  return {
    file,
    localName: name,
    kind: SymbolKind.Function,
    range: oneLineRange(index),
  };
}

function symbolNode(def: SymbolDef): SymbolNode {
  return {
    id: `${def.file}::${def.localName}::${def.range.start.index ?? 0}`,
    file: def.file,
    name: def.localName,
    kind: "function",
  };
}

function moduleIndex(file: string, locals: SymbolDef[]): ModuleIndex {
  return {
    file,
    locals,
    imports: [],
    exports: locals.map((local) => ({ type: "local", exportedAs: local.localName, target: local })),
  };
}

function snapshotSession(snapshot: AgentProjectSnapshot): AgentSession {
  return {
    loadProject: async () => snapshot,
    invalidate: () => undefined,
  };
}

describe("agent search", () => {
  it("ranks exact symbol, path, chunk, and graph evidence with follow-up commands", async () => {
    const root = await mkRepo();
    const response = await searchCodegraph({ root, query: "validate user auth", mode: "hybrid", limit: 5 });

    expect(response.schemaVersion).toBe(1);
    expect(response.results[0]?.label).toContain("validateUser");
    expect(response.results[0]?.rankReasons.length).toBeGreaterThan(0);
    expect(response.results[0]?.handle).not.toContain(root.replace(/\\/g, "/"));
    expect(response.results[0]?.evidence.some((entry) => entry.source === "symbol")).toBeTruthy();
    expect(response.results[0]?.neighbors.some((entry) => entry.file?.endsWith("src/api.ts"))).toBeTruthy();
    expect(response.results[0]?.followUps.some((cmd) => cmd.includes("codegraph refs"))).toBeTruthy();
    expect(response.results.some((result) => result.file.endsWith("src/auth.ts"))).toBeTruthy();
  });

  it("includes SQL object results from .sql language support", async () => {
    const root = await mkRepo();
    const response = await searchCodegraph({ root, query: "public users", mode: "sql", limit: 5 });

    expect(response.results.some((result) => result.kind === "sql_object" && result.label.includes("public.users"))).toBeTruthy();
    expect(response.results.every((result) => result.score > 0)).toBeTruthy();
    expect(response.results.every((result) => !result.handle.includes(root.replace(/\\/g, "/")))).toBeTruthy();
  });

  it("returns deterministic ordering for equal path matches", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "src", "account-alpha.ts"), "export const accountAlpha = 1;\n");
    await fs.writeFile(path.join(root, "src", "account-beta.ts"), "export const accountBeta = 1;\n");

    const first = await searchCodegraph({ root, query: "account", mode: "path", limit: 10 });
    const second = await searchCodegraph({ root, query: "account", mode: "path", limit: 10 });

    expect(second.results.map((result) => result.handle)).toEqual(first.results.map((result) => result.handle));
  });

  it("boosts matches reachable from a graph anchor", async () => {
    const root = await mkRepo();
    const anchorSearch = await searchCodegraph({ root, query: "auth", mode: "path", limit: 5 });
    const authHandle = anchorSearch.results.find((result) => result.file === "src/auth.ts")?.handle;
    expect(authHandle).toBeDefined();

    const response = await searchCodegraph({
      root,
      query: "handle login",
      mode: "graph",
      from: authHandle ?? "",
      depth: 1,
      limit: 5,
    });

    const loginResult = response.results.find((result) => result.label.includes("handleLogin"));
    expect(loginResult?.file).toBe("src/api.ts");
    expect(loginResult?.evidence.some((entry) => entry.source === "graph" && entry.label === "imported_by")).toBeTruthy();
    expect(loginResult?.rankReasons).toContain("graph neighborhood match at depth 1");
  });

  it("returns an empty result set for unmatched queries", async () => {
    const root = await mkRepo();
    const response = await searchCodegraph({ root, query: "zzzz-unmatched-domain", limit: 5 });

    expect(response.results).toEqual([]);
  });

  it("loads one project snapshot for a search call", async () => {
    const root = await mkRepo();
    const counted = countingSession(createAgentSession({ root }));

    await searchCodegraphWithSession(counted.session, { root, query: "validate user", mode: "hybrid", limit: 5 });

    expect(counted.loads()).toBe(1);
  });

  it("indexes symbol neighbors once per search instead of scanning edges per match", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-search-neighbors-"));
    const firstFile = path.join(root, "first.ts");
    const secondFile = path.join(root, "second.ts");
    const first = symbolDef(firstFile, "fooFirst", 0);
    const second = symbolDef(secondFile, "fooSecond", 0);
    const firstModule = moduleIndex(firstFile, [first]);
    const secondModule = moduleIndex(secondFile, [second]);
    const fileGraph: Graph = { nodes: new Set([firstFile, secondFile]), edges: [] };
    const byFile = new Map([
      [firstFile, firstModule],
      [secondFile, secondModule],
    ]);
    const index: ProjectIndex = {
      graph: fileGraph,
      modules: byFile,
      byFile,
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    const firstNode = symbolNode(first);
    const secondNode = symbolNode(second);
    const edges: SymbolEdge[] = [{ from: firstNode.id, to: secondNode.id, label: "calls" }];
    const edgeStorage = [...edges];
    let edgeIterations = 0;
    Object.defineProperty(edges, Symbol.iterator, {
      value: function* iterateEdges(): IterableIterator<SymbolEdge> {
        edgeIterations += 1;
        yield* edgeStorage;
      },
    });
    const symbolGraph: SymbolGraph = {
      nodes: new Map([
        [firstNode.id, firstNode],
        [secondNode.id, secondNode],
      ]),
      edges,
    };

    const response = await searchCodegraphWithSession(
      snapshotSession({
        root,
        files: [firstFile, secondFile],
        index,
        fileGraph,
        symbolGraph,
      }),
      { root, query: "foo", mode: "symbol", limit: 10 },
    );

    expect(response.results).toHaveLength(2);
    const everyResultHasCallNeighbor = response.results.every((result) =>
      result.neighbors.some((neighbor) => neighbor.relation === "calls"),
    );
    expect(everyResultHasCallNeighbor).toBe(true);
    expect(edgeIterations).toBe(1);
  });

  it("caps result count and per-result packet arrays with omission counts", async () => {
    const root = await mkRepo();
    for (let i = 0; i < 30; i += 1) {
      await fs.writeFile(
        path.join(root, "src", `consumer-${i}.ts`),
        `import { validateUser } from './auth';\nexport const consumer${i} = validateUser(${i});\n`,
      );
    }
    for (let i = 0; i < 120; i += 1) {
      await fs.writeFile(path.join(root, "src", `account-${i}.ts`), `export const account${i} = ${i};\n`);
    }

    const response = await searchCodegraph({ root, query: "account validate user", mode: "hybrid", limit: 500 });
    const validateResult = response.results.find((result) => result.label === "validateUser");

    expect(response.results.length).toBeLessThanOrEqual(100);
    expect(response.resultCount).toBe(response.results.length);
    expect(response.totalCandidates).toBeGreaterThan(response.resultCount);
    expect(response.omittedCounts.results).toBeGreaterThan(0);
    expect(response.limits.results).toBe(100);
    expect(validateResult?.neighbors.length).toBeLessThanOrEqual(response.limits.neighborsPerResult);
    expect(validateResult?.omittedCounts.neighbors).toBeGreaterThan(0);
    expect(validateResult?.evidence.length).toBeLessThanOrEqual(response.limits.evidencePerResult);
    expect(validateResult?.followUps.length).toBeLessThanOrEqual(response.limits.followUpsPerResult);
  });

  it("does not discover files that escape the root through a directory link", async () => {
    const root = await mkRepo();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-search-outside-"));
    await fs.writeFile(path.join(outside, "secret.ts"), "export const outsideSecretNeedle = true;\n");
    try {
      await fs.symlink(outside, path.join(root, "linked"), "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const response = await searchCodegraph({ root, query: "outside secret needle", mode: "text", limit: 10 });

    expect(response.results).toEqual([]);
  });
});

function isSymlinkUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP")
  );
}
