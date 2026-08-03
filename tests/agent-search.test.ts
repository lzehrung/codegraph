import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "../src/agent/session.js";
import { searchCodegraph, searchCodegraphWithSession } from "../src/agent/search.js";
import { formatAgentSymbolHandle } from "../src/agent/handles.js";
import type { SymbolEdge, SymbolGraph, SymbolNode } from "../src/graphs.js";
import * as symbolGraphBuild from "../src/graphs/symbol-graph-detailed.js";
import * as indexerBuild from "../src/indexer/build-index.js";
import { SymbolKind, type ModuleIndex, type ProjectIndex, type SymbolDef } from "../src/indexer/types.js";
import type { Edge, Graph, Range } from "../src/types.js";
import { countingSession } from "./helpers/agent.js";
import { isSymlinkUnavailable } from "./helpers/filesystem.js";

const DEFAULT_ANALYSIS = {
  mode: "semantic" as const,
  backend: "unknown" as const,
  parserDegradedFiles: 0,
  fallbackImportExtractionFiles: 0,
  nativeFilesUsed: 0,
  nativeFilesFellBack: 0,
  label: "semantic",
};

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-search-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(
    path.join(root, "src", "auth.ts"),
    [
      "export function validateUser(token: string) {",
      "  return !!token.length;",
      "}",
      "",
      "export function revokeSession(sessionId: string) {",
      "  return !!sessionId.length;",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "src", "api.ts"),
    "import { validateUser } from './auth';\nexport function handleLogin(token: string) { return validateUser(token); }\n",
  );
  await fs.writeFile(
    path.join(root, "src", "compatibility.ts"),
    "export function callCompatibility() { return 'call compatibility symbol'; }\n",
  );
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(
    path.join(root, "docs", "agent-search.md"),
    [
      "# Agent Search",
      "",
      "Use call compatibility when reviewing changed TypeScript signatures.",
      "The docs phrase should be easy to find from natural-language search.",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "schema.sql"),
    "CREATE TABLE public.users (id int primary key, email text);\nCREATE VIEW active_users AS SELECT id FROM public.users;\n",
  );
  return root;
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
  const file = def.file.replace(/\\/g, "/");
  return {
    id: `${file}::${def.localName}::${def.range.start.index ?? 0}`,
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

function snapshotSession(
  snapshot: Omit<AgentProjectSnapshot, "analysis"> & { analysis?: AgentProjectSnapshot["analysis"] },
): AgentSession {
  const fullSnapshot: AgentProjectSnapshot = {
    ...snapshot,
    analysis: snapshot.analysis ?? DEFAULT_ANALYSIS,
  };
  return {
    root: fullSnapshot.root,
    loadProject: async () => fullSnapshot,
    invalidate: () => undefined,
  };
}

describe("agent search", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    expect(response.results[0]?.provenance.surface).toBe("code");
    expect(response.results[0]?.provenance.capability).toBe("semantic");
    expect(response.results.some((result) => result.file.endsWith("src/auth.ts"))).toBeTruthy();
  });

  it("shell-quotes generated follow-up commands for path metacharacters", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "src", "cost$center.ts"), "export const costCenter = 1;\n");

    const response = await searchCodegraph({ root, query: "cost center", mode: "path", limit: 5 });
    const result = response.results.find((entry) => entry.file === "src/cost$center.ts");

    expect(result?.followUps).toContain("codegraph chunk 'src/cost$center.ts'");
    expect(result?.followUps).not.toContain('codegraph chunk "src/cost$center.ts"');
  });

  it("uses a file-list fast path for pure path searches", async () => {
    const root = await mkRepo();
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");

    const response = await searchCodegraph({ root, query: "agent search", mode: "path", limit: 5 });

    expect(response.results.some((result) => result.file === "docs/agent-search.md")).toBe(true);
    expect(response.analysis).toMatchObject({
      mode: "reduced",
      backend: "unknown",
      label: "path-only",
    });
    expect(response.results[0]?.provenance).toMatchObject({
      capability: "text",
      analysisMode: "reduced",
      backend: "unknown",
    });
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it("normalizes path fast-path results against the session root", async () => {
    const root = await mkRepo();
    const session = createAgentSession({ root });
    const response = await searchCodegraphWithSession(session, {
      root: path.dirname(root),
      query: "agent search",
      mode: "path",
      limit: 5,
    });

    const result = response.results.find((entry) => entry.file === "docs/agent-search.md");
    expect(response.root).toBe(root);
    expect(result?.handle).toBe("file:docs%2Fagent-search.md");
    expect(result?.file).toBe("docs/agent-search.md");
  });

  it("keeps legacy custom sessions without root on the snapshot-backed path", async () => {
    const root = await mkRepo();
    const docsFile = path.join(root, "docs", "agent-search.md");
    const fileGraph: Graph = { nodes: new Set([docsFile]), edges: [] };
    const index: ProjectIndex = {
      graph: fileGraph,
      modules: new Map(),
      byFile: new Map(),
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    let loadCount = 0;
    const session: AgentSession = {
      listFiles: async () => [docsFile],
      loadProject: async () => {
        loadCount += 1;
        return {
          root,
          files: [docsFile],
          index,
          fileGraph,
          symbolGraph: { nodes: new Map(), edges: [] },
          analysis: DEFAULT_ANALYSIS,
        };
      },
      invalidate: () => undefined,
    };

    const response = await searchCodegraphWithSession(session, {
      root: path.dirname(root),
      query: "agent search",
      mode: "path",
      limit: 5,
    });

    expect(loadCount).toBe(1);
    expect(response.root).toBe(root);
    expect(response.results[0]?.file).toBe("docs/agent-search.md");
  });

  it("includes SQL object results from .sql language support", async () => {
    const root = await mkRepo();
    const response = await searchCodegraph({ root, query: "public users", mode: "sql", limit: 5 });

    expect(
      response.results.some((result) => result.kind === "sql_object" && result.label.includes("public.users")),
    ).toBeTruthy();
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

  it("uses ASCII lexical ordering after equal ranking signals", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "src", "ascii.ts"),
      "function alpha() { return 1; }\nfunction Alpha() { return 2; }\n",
    );

    const response = await searchCodegraph({ root, query: "alpha", mode: "symbol", limit: 20 });
    const tiedLabels = response.results
      .filter((result) => result.label === "Alpha" || result.label === "alpha")
      .map((result) => result.label);

    expect(tiedLabels).toEqual(["Alpha", "alpha"]);
  });

  it("uses stable handles after all visible ranking keys tie", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-search-handle-tie-"));
    const file = path.join(root, "handles.ts");
    const first = symbolDef(file, "same", 0);
    const second: SymbolDef = {
      ...symbolDef(file, "same", 100),
      range: {
        start: { line: 2, column: 1, index: 100 },
        end: { line: 2, column: 10, index: 109 },
      },
    };
    const module = moduleIndex(file, [first, second]);
    const fileGraph: Graph = { nodes: new Set([file]), edges: [] };
    const byFile = new Map([[file, module]]);
    const index: ProjectIndex = {
      graph: fileGraph,
      modules: byFile,
      byFile,
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    const firstNode = symbolNode(first);
    const secondNode = symbolNode(second);
    const symbolGraph: SymbolGraph = {
      nodes: new Map([
        [secondNode.id, secondNode],
        [firstNode.id, firstNode],
      ]),
      edges: [],
    };

    const response = await searchCodegraphWithSession(
      snapshotSession({ root, files: [file], index, fileGraph, symbolGraph }),
      { root, query: "same", mode: "symbol", limit: 20 },
    );
    const handles = response.results.filter((result) => result.label === "same").map((result) => result.handle);

    expect(handles).toEqual([
      formatAgentSymbolHandle({ file: "handles.ts", name: "same", line: 1, column: 1 }),
      formatAgentSymbolHandle({ file: "handles.ts", name: "same", line: 2, column: 1 }),
    ]);
  });

  it("skips detailed symbol graph work for path, text, sql, hybrid, symbol, and graph searches", async () => {
    const root = await mkRepo();
    const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");

    await searchCodegraph({ root, query: "auth", mode: "path", limit: 5 });
    await searchCodegraph({ root, query: "active users", mode: "text", limit: 5 });
    await searchCodegraph({ root, query: "public users", mode: "sql", limit: 5 });
    const hybrid = await searchCodegraph({ root, query: "callCompatibility", mode: "hybrid", limit: 5 });
    await searchCodegraph({ root, query: "callCompatibility", mode: "symbol", limit: 5 });
    await searchCodegraph({ root, query: "auth", mode: "graph", limit: 5 });

    expect(symbolGraphSpy).not.toHaveBeenCalled();
    expect(
      hybrid.results.some((result) => result.kind === "symbol" && result.label === "callCompatibility"),
    ).toBeTruthy();
  });

  it("keeps implementation results ahead of documentation phrases in hybrid mode", async () => {
    const root = await mkRepo();

    const response = await searchCodegraph({ root, query: "call compatibility", mode: "hybrid", limit: 5 });

    expect(response.results[0]?.kind).toBe("symbol");
    expect(response.results[0]?.label).toBe("callCompatibility");
    expect(response.results.some((result) => result.label === "callCompatibility")).toBeTruthy();
    expect(response.results.some((result) => result.file === "docs/agent-search.md")).toBeTruthy();
  });

  it("keeps symbol-first ranking for identifier-like queries", async () => {
    const root = await mkRepo();

    const response = await searchCodegraph({ root, query: "callCompatibility", mode: "hybrid", limit: 5 });

    expect(response.results[0]?.kind).toBe("symbol");
    expect(response.results[0]?.label).toBe("callCompatibility");
  });

  it("ignores only natural-language syntax terms while preserving fallback queries", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "src", "installer.ts"),
      "export function preserveExistingMcpConfig() { return true; }\n",
    );
    await fs.writeFile(
      path.join(root, "src", "generic.ts"),
      ["export function howDoesThe() { return false; }", "export function theUserService() { return true; }", ""].join(
        "\n",
      ),
    );
    await fs.mkdir(path.join(root, "src", "how"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "how", "config.ts"), "export const configured = true;\n");
    await fs.mkdir(path.join(root, "src", "agent"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "agent", "agent.ts"), "export const agentMarker = true;\n");

    const response = await searchCodegraph({
      root,
      query: "how does the installer preserve existing mcp config",
      mode: "hybrid",
      limit: 20,
    });

    expect(response.results[0]?.label).toBe("preserveExistingMcpConfig");
    expect(response.results.some((result) => result.label === "howDoesThe")).toBe(false);
    expect(response.results.flatMap((result) => result.rankReasons).join(" ")).not.toMatch(/\b(?:how|does|the)\b/);

    const allSyntax = await searchCodegraph({ root, query: "how does the", mode: "symbol", limit: 20 });
    expect(allSyntax.results.some((result) => result.label === "howDoesThe")).toBe(true);

    const identifier = await searchCodegraph({ root, query: "theUserService", mode: "symbol", limit: 20 });
    const identifierResult = identifier.results.find((result) => result.label === "theUserService");
    expect(identifierResult?.rankReasons).toContain("symbol token match: the, user, service");

    const exactPath = await searchCodegraph({ root, query: "src/how/config.ts", mode: "path", limit: 20 });
    expect(exactPath.results[0]?.file).toBe("src/how/config.ts");
    expect(exactPath.results[0]?.rankReasons).toContain("path token match: src, how, config, ts");

    const repeatedPath = await searchCodegraph({ root, query: "src/agent/agent.ts", mode: "path", limit: 20 });
    expect(repeatedPath.results[0]?.file).toBe("src/agent/agent.ts");
    expect(repeatedPath.results[0]?.score).toBe(144);

    const mixedProsePath = await searchCodegraph({
      root,
      query: "how does src/how/config.ts preserve config",
      mode: "path",
      limit: 20,
    });
    expect(mixedProsePath.results.some((result) => result.file === "src/how/config.ts")).toBe(true);
    expect(mixedProsePath.results.flatMap((result) => result.rankReasons).join(" ")).not.toMatch(/\b(?:how|does)\b/);

    const leadingProsePath = await searchCodegraph({
      root,
      query: "src/how/config.ts is what does src/agent/agent.ts",
      mode: "path",
      limit: 20,
    });
    expect(leadingProsePath.results.some((result) => result.file === "src/how/config.ts")).toBe(true);
    expect(leadingProsePath.results.flatMap((result) => result.rankReasons).join(" ")).not.toMatch(
      /\b(?:how|is|what|does)\b/,
    );

    const directoryPathProse = await searchCodegraph({
      root,
      query: "src/agent what is agent.ts",
      mode: "path",
      limit: 20,
    });
    expect(directoryPathProse.results[0]?.file).toBe("src/agent/agent.ts");
    expect(directoryPathProse.results[0]?.score).toBe(144);
    expect(directoryPathProse.results[0]?.rankReasons).toContain("path token match: src, agent, ts");
  });

  it("preserves every term in an existing spaced path", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "src", "how config.ts"), "export const spacedPath = true;\n");
    await fs.mkdir(path.join(root, "the app"), { recursive: true });
    await fs.writeFile(path.join(root, "the app", "config.ts"), "export const firstSegmentSpace = true;\n");

    const response = await searchCodegraph({ root, query: "src/how config.ts", mode: "path", limit: 20 });

    expect(response.results[0]?.file).toBe("src/how config.ts");
    expect(response.results[0]?.rankReasons).toContain("path token match: src, how, config, ts");

    const firstSegmentResponse = await searchCodegraph({
      root,
      query: "the app/config.ts",
      mode: "path",
      limit: 20,
    });
    const firstSegmentPath = firstSegmentResponse.results.find((result) => result.file === "the app/config.ts");
    expect(firstSegmentPath?.rankReasons).toContain("path token match: the, app, config, ts");

    const hybridResponse = await searchCodegraph({ root, query: "src/how config.ts", mode: "hybrid", limit: 20 });
    const hybridPath = hybridResponse.results.find((result) => result.file === "src/how config.ts");
    expect(hybridPath?.rankReasons).toContain("path token match: src, how, config, ts");

    const prefixedResponse = await searchCodegraph({ root, query: "./src/how config.ts", mode: "path", limit: 20 });
    const prefixedPath = prefixedResponse.results.find((result) => result.file === "src/how config.ts");
    expect(prefixedPath?.rankReasons).toContain("path token match: src, how, config, ts");

    const absoluteQuery = path.join(root, "src", "how config.ts");
    const absoluteResponse = await searchCodegraph({ root, query: absoluteQuery, mode: "path", limit: 20 });
    const absolutePath = absoluteResponse.results.find((result) => result.file === "src/how config.ts");
    expect(absolutePath?.rankReasons.join(" ")).toMatch(/\bhow\b/);
  });
  it("keys the session result cache by rank-bearing query terms", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "src", "generic.ts"), "export function theUserService() { return true; }\n");
    await fs.mkdir(path.join(root, "src", "how"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "how", "config.ts"), "export const configured = true;\n");
    const session = createAgentSession({ root });

    try {
      await searchCodegraphWithSession(session, {
        root,
        query: "the user service",
        mode: "symbol",
        limit: 20,
      });
      const identifier = await searchCodegraphWithSession(session, {
        root,
        query: "theUserService",
        mode: "symbol",
        limit: 20,
      });
      const identifierResult = identifier.results.find((result) => result.label === "theUserService");
      expect(identifierResult?.rankReasons).toContain("symbol token match: the, user, service");
      const cachedIdentifier = await searchCodegraphWithSession(session, {
        root,
        query: "theUserService",
        mode: "symbol",
        limit: 20,
      });
      expect(cachedIdentifier).toBe(identifier);

      await searchCodegraphWithSession(session, {
        root,
        query: "src how config ts",
        mode: "hybrid",
        limit: 20,
      });
      const pathQuery = await searchCodegraphWithSession(session, {
        root,
        query: "src/how/config.ts",
        mode: "hybrid",
        limit: 20,
      });
      const pathResult = pathQuery.results.find(
        (result) => result.kind === "file" && result.file === "src/how/config.ts",
      );
      expect(pathResult?.rankReasons).toContain("path token match: src, how, config, ts");
      expect(pathResult?.score).toBe(164);
    } finally {
      session.invalidate();
    }
  });

  it("breaks equal scores by capability before discriminative-term coverage", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "src", "tie.ts"), "function ab() { return true; }\n");
    await fs.writeFile(path.join(root, "docs", "tie.md"), "# Tie\n\ngh ef cd ab\n");

    const response = await searchCodegraph({
      root,
      query: "ab cd ef gh ij",
      mode: "hybrid",
      limit: 20,
    });
    const semanticIndex = response.results.findIndex((result) => result.label === "ab");
    const textIndex = response.results.findIndex((result) => result.file === "docs/tie.md");

    expect(semanticIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(response.results[semanticIndex]?.score).toBe(response.results[textIndex]?.score);
    expect(semanticIndex).toBeLessThan(textIndex);
  });

  it("breaks equal semantic scores by discriminative-term coverage", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "src", "coverage.ts"),
      ["/** gh ef cd ab */", "function zzzCandidate() { return true; }", "function ab() { return true; }", ""].join(
        "\n",
      ),
    );

    const response = await searchCodegraph({
      root,
      query: "ab cd ef gh ij",
      mode: "symbol",
      limit: 20,
    });
    const coveredIndex = response.results.findIndex((result) => result.label === "zzzCandidate");
    const partialIndex = response.results.findIndex((result) => result.label === "ab");

    expect(coveredIndex).toBeGreaterThanOrEqual(0);
    expect(partialIndex).toBeGreaterThanOrEqual(0);
    expect(response.results[coveredIndex]?.score).toBe(response.results[partialIndex]?.score);
    expect(coveredIndex).toBeLessThan(partialIndex);
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
    expect(
      loginResult?.evidence.some((entry) => entry.source === "graph" && entry.label === "imported_by"),
    ).toBeTruthy();
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

  it("reuses searchable file text and chunks across repeated session searches", async () => {
    const root = await mkRepo();
    const docsFile = path.join(root, "docs", "agent-search.md");
    const fileGraph: Graph = { nodes: new Set([docsFile]), edges: [] };
    const index: ProjectIndex = {
      graph: fileGraph,
      modules: new Map(),
      byFile: new Map(),
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    const session = snapshotSession({
      root,
      files: [docsFile],
      index,
      fileGraph,
      symbolGraph: { nodes: new Map(), edges: [] },
    });
    const readSpy = vi.spyOn(fs, "readFile");

    await searchCodegraphWithSession(session, { root, query: "natural language search", mode: "text", limit: 5 });
    await searchCodegraphWithSession(session, { root, query: "call compatibility", mode: "text", limit: 5 });

    const docsReads = readSpy.mock.calls.filter((call) => call[0] === docsFile);
    expect(docsReads).toHaveLength(1);
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
    const firstResult = response.results.find((result) => result.label === "fooFirst");
    const secondResult = response.results.find((result) => result.label === "fooSecond");
    expect(firstResult?.neighbors).toContainEqual({
      relation: "calls",
      target: "fooSecond",
      file: "second.ts",
    });
    expect(secondResult?.neighbors).toContainEqual({
      relation: "incoming:calls",
      target: "fooFirst",
      file: "first.ts",
    });
    expect(secondResult?.neighbors.some((neighbor) => neighbor.relation === "calls")).toBe(false);
    expect(edgeIterations).toBe(1);
  });

  it("does not return symbol handles for graph-only import alias nodes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-search-import-node-"));
    const sourceFile = path.join(root, "source.ts");
    const consumerFile = path.join(root, "consumer.ts");
    const sourceDef = symbolDef(sourceFile, "sharedValue", 0);
    const sourceModule = moduleIndex(sourceFile, [sourceDef]);
    const consumerModule: ModuleIndex = {
      file: consumerFile,
      locals: [],
      imports: [],
      exports: [],
    };
    const fileGraph: Graph = {
      nodes: new Set([sourceFile, consumerFile]),
      edges: [],
    };
    const byFile = new Map([
      [sourceFile, sourceModule],
      [consumerFile, consumerModule],
    ]);
    const index: ProjectIndex = {
      graph: fileGraph,
      modules: byFile,
      byFile,
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    const sourceNode = symbolNode(sourceDef);
    const importNode: SymbolNode = {
      id: `${consumerFile}::sharedValue::import`,
      file: consumerFile,
      name: "sharedValue",
      kind: "import",
    };

    const response = await searchCodegraphWithSession(
      snapshotSession({
        root,
        files: [sourceFile, consumerFile],
        index,
        fileGraph,
        symbolGraph: {
          nodes: new Map([
            [sourceNode.id, sourceNode],
            [importNode.id, importNode],
          ]),
          edges: [{ from: importNode.id, to: sourceNode.id, label: "sharedValue" }],
        },
      }),
      { root, query: "shared value", mode: "symbol", limit: 10 },
    );

    expect(response.results.map((result) => result.handle)).toContain("symbol:source.ts:sharedValue:1:1");
    expect(response.results.some((result) => result.file === "consumer.ts" && result.handle.endsWith(":0:0"))).toBe(
      false,
    );
  });

  it("indexes file neighbors once per graph search instead of scanning edges per match", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-search-file-neighbors-"));
    const firstFile = path.join(root, "foo-a.ts");
    const secondFile = path.join(root, "foo-b.ts");
    const thirdFile = path.join(root, "foo-c.ts");
    const fileEdges: Edge[] = [
      { from: firstFile, to: { type: "file", path: secondFile }, raw: "./foo-b" },
      { from: secondFile, to: { type: "file", path: thirdFile }, raw: "./foo-c" },
    ];
    const edgeStorage = [...fileEdges];
    let edgeIterations = 0;
    Object.defineProperty(fileEdges, Symbol.iterator, {
      value: function* iterateEdges(): IterableIterator<Edge> {
        edgeIterations += 1;
        yield* edgeStorage;
      },
    });
    const fileGraph: Graph = {
      nodes: new Set([firstFile, secondFile, thirdFile]),
      edges: fileEdges,
    };
    const index: ProjectIndex = {
      graph: fileGraph,
      modules: new Map(),
      byFile: new Map(),
      exportCache: new Map(),
      scopeCache: new Map(),
    };

    const response = await searchCodegraphWithSession(
      snapshotSession({
        root,
        files: [firstFile, secondFile, thirdFile],
        index,
        fileGraph,
        symbolGraph: { nodes: new Map(), edges: [] },
      }),
      { root, query: "foo", mode: "graph", from: "foo-a.ts", depth: 2, limit: 10 },
    );

    expect(response.results.map((result) => result.file)).toContain("foo-c.ts");
    expect(response.results.find((result) => result.file === "foo-a.ts")?.neighbors).toContainEqual({
      relation: "imports",
      target: "foo-b.ts",
      file: "foo-b.ts",
    });
    expect(response.results.find((result) => result.file === "foo-c.ts")?.evidence).toContainEqual(
      expect.objectContaining({
        source: "graph",
        label: "imports",
        file: "foo-c.ts",
      }),
    );
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
