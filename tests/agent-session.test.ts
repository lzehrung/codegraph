import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_FRESHNESS_CHECK_INTERVAL_MS, createAgentSession, listAgentSessionFiles } from "../src/agent/session.js";
import * as symbolGraphBuild from "../src/graphs/symbol-graph-detailed.js";
import * as indexerBuild from "../src/indexer/build-index.js";
import { createProjectSnapshotIdentity } from "../src/indexer/build-cache.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import * as projectFilesModule from "../src/util/projectFiles.js";
import * as gitModule from "../src/util/git.js";
import { runGit as git } from "./helpers/git.js";

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-session-"));
  await fs.writeFile(path.join(root, "util.ts"), "export function add(a: number, b: number) { return a + b; }\n");
  await fs.writeFile(path.join(root, "main.ts"), "import { add } from './util';\nexport const total = add(1, 2);\n");
  await fs.writeFile(path.join(root, "schema.sql"), "CREATE TABLE public.users (id int primary key);\n");
  return root;
}

async function mkGitRepo(): Promise<string> {
  const root = await mkRepo();
  git(root, ["init"]);
  git(root, ["config", "user.email", "tests@example.com"]);
  git(root, ["config", "user.name", "Tests"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  return root;
}
function detailedSymbolGraphSnapshotPath(root: string): string {
  return path.join(root, ".codegraph-cache", "index-v1", "detailed-symbol-graph.json");
}
type MutableDetailedSymbolGraphSidecar = {
  version: number;
  projectSnapshotIdentity: string;
  graphHash: string;
  graph: {
    nodes: Array<{
      id: string;
      file: string;
      name: string;
      complexity?: number;
    }>;
    edges: Array<{
      from: string;
      to: string;
      site?: {
        file: string;
        range: {
          start: { line: number; column: number; index?: number };
          end: { line: number; column: number; index?: number };
        };
      };
    }>;
  };
};
function refreshDetailedSidecarHash(sidecar: MutableDetailedSymbolGraphSidecar): void {
  const hash = createHash("sha256");
  hash.update(sidecar.projectSnapshotIdentity);
  hash.update("\0");
  hash.update(JSON.stringify(sidecar.graph));
  sidecar.graphHash = hash.digest("hex");
}

describe("agent session", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads index, graph, symbol graph, and SQL files once for repeated agent operations", async () => {
    const root = await mkRepo();
    const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");
    const session = createAgentSession({ root });

    const first = await session.loadProject();
    const second = await session.loadProject();

    expect(second).toBe(first);
    expect(first.files.some((file) => file.endsWith("schema.sql"))).toBeTruthy();
    expect(first.symbolGraph.nodes.size).toBeGreaterThan(0);
    expect(first.fileGraph.nodes.size).toBeGreaterThan(0);
    expect(first.fileGraph).toBe(first.index.graph);
    expect(symbolGraphSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses current build signatures and stats only files missing from the manifest", async () => {
    const root = await mkGitRepo();
    const missingFile = path.resolve(root, "util.ts");
    const coveredFiles = [path.resolve(root, "main.ts"), path.resolve(root, "schema.sql")];
    const originalBuild = indexerBuild.buildProjectIndexIncremental;
    let buildFinished = false;
    vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      const index = await originalBuild(...args);
      index.manifestEntries?.delete(missingFile.replace(/\\/g, "/"));
      buildFinished = true;
      return index;
    });
    const originalStat = fs.stat.bind(fs);
    const baselineStats: string[] = [];
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const file = path.resolve(String(args[0]));
      if (buildFinished) baselineStats.push(file);
      return await originalStat(...args);
    });

    const session = createAgentSession({ root });
    await session.loadProject({ symbolGraph: "skip" });

    expect(baselineStats.filter((file) => file === missingFile)).toHaveLength(1);
    expect(baselineStats.filter((file) => coveredFiles.includes(file))).toHaveLength(0);
    expect(await session.checkFreshness()).toEqual({ state: "fresh" });
  });

  it("starts fresh after a tracked file metadata-only change on the snapshot fast path", async () => {
    const root = await mkGitRepo();
    await createAgentSession({ root }).loadProject({ symbolGraph: "skip" });
    const mainPath = path.join(root, "main.ts");
    const stat = await fs.stat(mainPath);
    await fs.utimes(mainPath, stat.atime, new Date(stat.mtimeMs + 10_000));
    const session = createAgentSession({ root });

    await session.loadProject({ symbolGraph: "skip" });

    expect(await session.checkFreshness()).toEqual({ state: "fresh" });
  });

  it("skips detailed symbol graph construction until requested", async () => {
    const root = await mkRepo();
    const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");
    const session = createAgentSession({ root });

    const pathOnlySnapshot = await session.loadProject({ symbolGraph: "skip" });

    expect(pathOnlySnapshot.symbolGraph.nodes.size).toBe(0);
    expect(symbolGraphSpy).not.toHaveBeenCalled();

    const symbolSnapshot = await session.loadProject();

    expect(symbolSnapshot.symbolGraph.nodes.size).toBeGreaterThan(0);
    expect(symbolGraphSpy).toHaveBeenCalledTimes(1);
  });

  it("loads a basic in-memory symbol graph without detailed sidecar work", async () => {
    const root = await mkRepo();
    const detailedSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");
    const session = createAgentSession({ root });

    const basic = await session.loadProject({ symbolGraph: "basic" });
    const basicAgain = await session.loadProject({ symbolGraph: "basic" });

    expect(basicAgain).toBe(basic);
    expect(basic.symbolGraph.nodes.size).toBeGreaterThan(0);
    expect(detailedSpy).not.toHaveBeenCalled();

    const eager = await session.loadProject();
    expect(eager.symbolGraph.nodes.size).toBeGreaterThan(0);
    expect(detailedSpy).toHaveBeenCalledTimes(1);
  });

  it("persists detailed symbols and lazily reuses them in a new session without source parsing", async () => {
    const root = await mkGitRepo();
    await fs.writeFile(
      path.join(root, "hierarchy.ts"),
      [
        "export class BaseService {",
        "  run() { return 1; }",
        "}",
        "export class DerivedService extends BaseService {",
        "  run() { return super.run(); }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");
    const cold = await createAgentSession({ root }).loadProject();
    const sidecarPath = detailedSymbolGraphSnapshotPath(root);
    const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as {
      version: number;
      projectSnapshotIdentity: string;
      graph: { nodes: unknown[]; edges: unknown[] };
    };

    expect(symbolGraphSpy).toHaveBeenCalledTimes(1);
    expect(sidecar.version).toBe(1);
    expect(sidecar.projectSnapshotIdentity).toBe(cold.index.projectSnapshotIdentity);
    expect(Object.keys(sidecar).sort()).toEqual(["graph", "graphHash", "projectSnapshotIdentity", "version"]);
    expect(Object.keys(sidecar.graph).sort()).toEqual(["edges", "nodes"]);

    symbolGraphSpy.mockClear();
    const warmSession = createAgentSession({ root });
    const skipped = await warmSession.loadProject({ symbolGraph: "skip" });
    expect(skipped.symbolGraph.nodes.size).toBe(0);
    expect(symbolGraphSpy).not.toHaveBeenCalled();

    const warm = await warmSession.loadProject();
    expect(symbolGraphSpy).not.toHaveBeenCalled();
    expect([...warm.symbolGraph.nodes]).toEqual([...cold.symbolGraph.nodes]);
    expect(warm.symbolGraph.edges).toEqual(cold.symbolGraph.edges);
    expect(cold.symbolGraph.edges.some((edge) => edge.label === "extends")).toBe(true);
    expect(cold.symbolGraph.edges.some((edge) => edge.label === "member_of")).toBe(true);
  });

  it("memoizes a validated detailed sidecar until its file identity changes", async () => {
    const root = await mkGitRepo();
    await createAgentSession({ root }).loadProject();
    const sidecarPath = detailedSymbolGraphSnapshotPath(root);
    const sidecarText = await fs.readFile(sidecarPath, "utf8");
    await fs.writeFile(sidecarPath, `${sidecarText}\n`, "utf8");
    const originalReadFile = fs.readFile.bind(fs);
    let sidecarReads = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(sidecarPath)) sidecarReads++;
      return await originalReadFile(...args);
    });

    const first = await createAgentSession({ root }).loadProject();
    const retainedNode = first.symbolGraph.nodes.keys().next().value as string;
    first.symbolGraph.nodes.delete(retainedNode);
    const second = await createAgentSession({ root }).loadProject();

    expect(second.symbolGraph).not.toBe(first.symbolGraph);
    expect(second.symbolGraph.nodes.has(retainedNode)).toBe(true);
    expect(sidecarReads).toBe(1);
    const beforeRewrite = await fs.stat(sidecarPath);
    const unchangedText = await originalReadFile(sidecarPath, "utf8");
    await fs.writeFile(sidecarPath, unchangedText, "utf8");
    await fs.utimes(sidecarPath, beforeRewrite.atime, beforeRewrite.mtime);
    await createAgentSession({ root }).loadProject();

    expect(sidecarReads).toBe(2);
  });

  it("does not cache a detailed graph across an atomic sidecar replacement", async () => {
    const root = await mkGitRepo();
    await createAgentSession({ root }).loadProject();
    const sidecarPath = detailedSymbolGraphSnapshotPath(root);
    const sidecarText = await fs.readFile(sidecarPath, "utf8");
    await fs.writeFile(sidecarPath, `${sidecarText}\n`, "utf8");
    const originalStat = fs.stat.bind(fs);
    let sidecarStats = 0;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(sidecarPath)) {
        sidecarStats++;
        if (sidecarStats === 4) await fs.writeFile(sidecarPath, "{replacement", "utf8");
      }
      return await originalStat(...args);
    });
    const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");

    const rebuilt = await createAgentSession({ root }).loadProject();

    expect(symbolGraphSpy).toHaveBeenCalledTimes(1);
    expect(rebuilt.symbolGraph.nodes.size).toBeGreaterThan(0);
  });

  it("rebuilds and refreshes malformed detailed symbol graph sidecars", async () => {
    const root = await mkGitRepo();
    await createAgentSession({ root }).loadProject();
    await fs.writeFile(detailedSymbolGraphSnapshotPath(root), "{not-json", "utf8");
    const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");

    const rebuilt = await createAgentSession({ root }).loadProject();
    const refreshed = JSON.parse(await fs.readFile(detailedSymbolGraphSnapshotPath(root), "utf8")) as {
      version: number;
    };

    expect(symbolGraphSpy).toHaveBeenCalledTimes(1);
    expect(rebuilt.symbolGraph.nodes.size).toBeGreaterThan(0);
    expect(refreshed.version).toBe(1);
  });
  it("rejects well-typed sidecar tampering against the current project index", async () => {
    const root = await mkGitRepo();
    await createAgentSession({ root }).loadProject();
    const sidecarPath = detailedSymbolGraphSnapshotPath(root);
    const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");
    const tamperers: Array<(sidecar: MutableDetailedSymbolGraphSidecar) => void> = [
      (sidecar) => {
        sidecar.graph.edges[0]!.to = "missing-node";
      },
      (sidecar) => {
        const node = sidecar.graph.nodes[0]!;
        node.file = path.resolve(root, "..", "escaped.ts").replace(/\\/g, "/");
        node.id = `${node.file}::escaped::0`;
      },
      (sidecar) => {
        sidecar.graph.nodes[0]!.complexity = -1;
      },
      (sidecar) => {
        const baseNode = sidecar.graph.nodes.find((node) => node.name === "add");
        if (!baseNode) throw new Error("expected persisted add node");
        baseNode.name = "tampered";
      },
      (sidecar) => {
        const node = sidecar.graph.nodes[0]!;
        sidecar.graph.nodes.push({
          ...node,
          id: `${node.file}::bogus-extra-node::0`,
          name: "bogus-extra-node",
        });
      },
      (sidecar) => {
        sidecar.graph.edges[0]!.site = {
          file: sidecar.graph.nodes[0]!.file,
          range: {
            start: { line: -1, column: 0, index: 0 },
            end: { line: 0, column: 1, index: 1 },
          },
        };
      },
    ];

    for (const tamper of tamperers) {
      const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as MutableDetailedSymbolGraphSidecar;
      tamper(sidecar);
      refreshDetailedSidecarHash(sidecar);
      await fs.writeFile(sidecarPath, JSON.stringify(sidecar), "utf8");
      symbolGraphSpy.mockClear();

      const rebuilt = await createAgentSession({ root }).loadProject();

      expect(symbolGraphSpy).toHaveBeenCalledTimes(1);
      expect(rebuilt.symbolGraph.nodes.size).toBeGreaterThan(0);
    }
  });

  it("loads a valid sidecar from disk without re-verifying its self-reported graphHash", async () => {
    const root = await mkGitRepo();
    const cold = await createAgentSession({ root }).loadProject();
    const sidecarPath = detailedSymbolGraphSnapshotPath(root);

    // Corrupt only `graphHash`, leaving `graph` untouched: recomputing and comparing this
    // field required re-stringifying and re-hashing the whole graph on every load (~36ms
    // measured on an 11MB sidecar) purely to prove this file's own bytes are
    // self-consistent, a guarantee the atomic write already provides. A stale or wrong hash
    // must therefore no longer force a rebuild; correctness against the current project is
    // proven by the structural and semantic checks in
    // `isDetailedSymbolGraphCompatibleWithProject` instead, exercised separately by "rejects
    // well-typed sidecar tampering against the current project index" above.
    const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as MutableDetailedSymbolGraphSidecar;
    sidecar.graphHash = "f".repeat(64);
    await fs.writeFile(sidecarPath, JSON.stringify(sidecar), "utf8");

    const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");
    const warm = await createAgentSession({ root }).loadProject();

    expect(symbolGraphSpy).not.toHaveBeenCalled();
    expect([...warm.symbolGraph.nodes]).toEqual([...cold.symbolGraph.nodes]);
    expect(warm.symbolGraph.edges).toEqual(cold.symbolGraph.edges);
  });

  it("rebuilds and upgrades older detailed symbol graph sidecars", async () => {
    const root = await mkGitRepo();
    await createAgentSession({ root }).loadProject();
    const sidecarPath = detailedSymbolGraphSnapshotPath(root);
    const legacy = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as {
      version: number;
      projectSnapshotIdentity: string;
      graph: unknown;
    };
    legacy.version = 0;
    await fs.writeFile(sidecarPath, JSON.stringify(legacy), "utf8");
    const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");

    await createAgentSession({ root }).loadProject();
    const refreshed = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as { version: number };

    expect(symbolGraphSpy).toHaveBeenCalledTimes(1);
    expect(refreshed.version).toBe(1);
  });

  it("invalidates the detailed sidecar after a tracked edit", async () => {
    const root = await mkGitRepo();
    const initial = await createAgentSession({ root }).loadProject();
    await fs.appendFile(path.join(root, "util.ts"), "export class AddedAfterSnapshot {}\n", "utf8");
    const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");

    const rebuilt = await createAgentSession({ root }).loadProject();

    expect(symbolGraphSpy).toHaveBeenCalledTimes(1);
    expect(rebuilt.index.projectSnapshotIdentity).not.toBe(initial.index.projectSnapshotIdentity);
    expect([...rebuilt.symbolGraph.nodes.values()].some((node) => node.name === "AddedAfterSnapshot")).toBe(true);
  });

  it("invalidates detailed sidecar compatibility when semantic graph or native options change", async () => {
    const root = await mkGitRepo();
    const initial = await createAgentSession({ root }).loadProject();
    const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");

    const rebuilt = await createAgentSession({
      root,
      buildOptions: { graph: { dynamicImportHeuristics: true } },
    }).loadProject();

    expect(symbolGraphSpy).toHaveBeenCalledTimes(1);
    expect(rebuilt.index.projectSnapshotIdentity).not.toBe(initial.index.projectSnapshotIdentity);
    expect(createProjectSnapshotIdentity("same-files", { graph: { dynamicImportHeuristics: true } })).not.toBe(
      createProjectSnapshotIdentity("same-files", { graph: { dynamicImportHeuristics: false } }),
    );
    expect(createProjectSnapshotIdentity("same-files", { native: "on" })).not.toBe(
      createProjectSnapshotIdentity("same-files", { native: "off" }),
    );
    const previousDisableNative = process.env.CODEGRAPH_DISABLE_NATIVE;
    let enabledRuntimeIdentity = "";
    let disabledRuntimeIdentity = "";
    try {
      delete process.env.CODEGRAPH_DISABLE_NATIVE;
      enabledRuntimeIdentity = createProjectSnapshotIdentity("same-files", { native: "auto" });
      process.env.CODEGRAPH_DISABLE_NATIVE = "1";
      disabledRuntimeIdentity = createProjectSnapshotIdentity("same-files", { native: "auto" });
    } finally {
      if (previousDisableNative === undefined) {
        delete process.env.CODEGRAPH_DISABLE_NATIVE;
      } else {
        process.env.CODEGRAPH_DISABLE_NATIVE = previousDisableNative;
      }
    }
    expect(disabledRuntimeIdentity).not.toBe(enabledRuntimeIdentity);
  });

  it("rebuilds the detailed sidecar when the effective native runtime changes", async () => {
    const root = await mkGitRepo();
    const previousDisableNative = process.env.CODEGRAPH_DISABLE_NATIVE;
    let initialIdentity = "";
    let transitionedIdentity = "";
    let detailedBuildCount = 0;
    try {
      delete process.env.CODEGRAPH_DISABLE_NATIVE;
      const initial = await createAgentSession({ root }).loadProject();
      initialIdentity = initial.index.projectSnapshotIdentity ?? "";
      const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");

      process.env.CODEGRAPH_DISABLE_NATIVE = "1";
      const transitioned = await createAgentSession({ root }).loadProject();
      transitionedIdentity = transitioned.index.projectSnapshotIdentity ?? "";
      detailedBuildCount = symbolGraphSpy.mock.calls.length;
    } finally {
      if (previousDisableNative === undefined) {
        delete process.env.CODEGRAPH_DISABLE_NATIVE;
      } else {
        process.env.CODEGRAPH_DISABLE_NATIVE = previousDisableNative;
      }
    }

    expect(transitionedIdentity).not.toBe(initialIdentity);
    expect(detailedBuildCount).toBe(1);
  });

  it("builds agent snapshots through incremental disk cache by default", async () => {
    const root = await mkRepo();
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");

    const session = createAgentSession({ root });
    await session.loadProject();

    expect(buildSpy).toHaveBeenCalledTimes(1);
    const buildOptions = buildSpy.mock.calls[0]?.[1];
    expect(buildOptions?.cache).toBe("disk");
    expect(buildOptions?.keepParsed).toBe(true);
    expect(buildOptions?.files?.map((file) => path.basename(file)).sort()).toEqual([
      "main.ts",
      "schema.sql",
      "util.ts",
    ]);
  });

  it("threads explicit build options into incremental agent indexing", async () => {
    const root = await mkRepo();
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");

    const session = createAgentSession({
      root,
      buildOptions: {
        cache: "memory",
        threads: 2,
        keepParsed: false,
        useBloomFilters: false,
      },
    });
    await session.loadProject();

    const buildOptions = buildSpy.mock.calls[0]?.[1];
    expect(buildOptions?.cache).toBe("memory");
    expect(buildOptions?.threads).toBe(2);
    expect(buildOptions?.keepParsed).toBe(false);
    expect(buildOptions?.useBloomFilters).toBe(false);
  });

  it("discovers built-in and configured custom files and forwards the normalized mapping", async () => {
    const root = await mkRepo();
    const customPath = path.join(root, "feature.custom");
    await fs.writeFile(customPath, "export const customFeature = 1;\n");
    await fs.writeFile(
      path.join(root, "codegraph.config.json"),
      JSON.stringify({ languages: { extensions: { ".CUSTOM": " ts " } } }),
    );
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");

    const snapshot = await createAgentSession({ root }).loadProject({ symbolGraph: "skip" });

    expect(snapshot.files.map((file) => path.basename(file)).sort()).toEqual([
      "feature.custom",
      "main.ts",
      "schema.sql",
      "util.ts",
    ]);
    expect(snapshot.index.byFile.get(customPath.replace(/\\/g, "/"))?.locals.map((local) => local.localName)).toContain(
      "customFeature",
    );
    expect(buildSpy.mock.calls[0]?.[1]?.languageExtensions).toEqual({ ".custom": "ts" });
  });

  it("uses programmatic language extensions when listing agent session files", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "feature.custom"), "export const customFeature = 1;\n");

    const files = await createAgentSession({
      root,
      useConfig: false,
      buildOptions: { languageExtensions: { ".CUSTOM": " ts " } },
    }).listFiles?.();

    expect(files?.map((file) => path.basename(file)).sort()).toEqual([
      "feature.custom",
      "main.ts",
      "schema.sql",
      "util.ts",
    ]);
  });

  it("auto-enables native workers for large agent builds unless explicitly disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-session-large-"));
    for (let index = 0; index < 260; index += 1) {
      await fs.writeFile(path.join(root, `file-${index}.ts`), `export const value${index} = ${index};\n`);
    }
    const emptyGraph = { nodes: new Set<string>(), edges: [] };
    const emptyIndex: ProjectIndex = {
      graph: emptyGraph,
      modules: new Map(),
      byFile: new Map(),
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockResolvedValue(emptyIndex);

    await createAgentSession({ root }).loadProject({ symbolGraph: "skip" });
    await createAgentSession({ root, buildOptions: { useNativeWorkers: false } }).loadProject({ symbolGraph: "skip" });

    expect(buildSpy.mock.calls[0]?.[1]?.useNativeWorkers).toBe(true);
    expect(buildSpy.mock.calls[1]?.[1]?.useNativeWorkers).toBe(false);
  });

  it("does not cache failed project loads", async () => {
    const root = path.join(os.tmpdir(), `cg-agent-session-retry-${Date.now()}`);
    const session = createAgentSession({ root });

    await expect(session.loadProject()).rejects.toThrow(/Project root does not exist or is not readable:/);

    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "index.ts"), "export const value = 1;\n");

    const snapshot = await session.loadProject();

    expect(snapshot.files.some((file) => file.endsWith("index.ts"))).toBe(true);
  });

  it("preserves explicit discovery globRoot when loading a child root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-session-child-root-"));
    const testsRoot = path.join(root, "tests");
    const keptFile = path.join(testsRoot, "unit", "app.test.ts");
    const ignoredFile = path.join(testsRoot, "samples", "fixture.ts");

    await fs.mkdir(path.dirname(keptFile), { recursive: true });
    await fs.mkdir(path.dirname(ignoredFile), { recursive: true });
    await fs.writeFile(keptFile, "export const kept = 1;\n", "utf8");
    await fs.writeFile(ignoredFile, "export const ignored = 1;\n", "utf8");

    const session = createAgentSession({
      root: testsRoot,
      useConfig: false,
      discovery: {
        globRoot: root,
        includeGlobs: ["tests/**/*.ts"],
        ignoreGlobs: ["tests/samples/**"],
        useGitignore: false,
      },
    });

    const snapshot = await session.loadProject();
    const files = snapshot.files.map((file) => file.replace(/\\/g, "/"));

    expect(files).toContain(keptFile.replace(/\\/g, "/"));
    expect(files).not.toContain(ignoredFile.replace(/\\/g, "/"));
  });

  it("reports stale file edits as normalized project display paths without invalidating cached project state", async () => {
    const absoluteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-session-check-fresh-"));
    const relativeRoot = path.relative(process.cwd(), absoluteRoot);
    const filePath = path.join(absoluteRoot, "src", "auth.ts");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "export function oldSymbol() { return 1; }\n", "utf8");
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
    const session = createAgentSession({ root: relativeRoot, useConfig: false, freshness: { policy: "check" } });
    const cached = await session.loadProject({ symbolGraph: "skip" });
    if (!session.checkFreshness) {
      throw new Error("agent session should expose freshness checks");
    }

    await fs.writeFile(filePath, "export function editedSymbol() { return 22; }\n", "utf8");
    const freshness = await session.checkFreshness();
    const afterCheck = await session.loadProject({ symbolGraph: "skip" });

    expect(freshness).toEqual({
      state: "stale",
      changedFiles: ["src/auth.ts"],
      changedFileCount: 1,
      omittedChangedFileCount: 0,
      reason: "session snapshot is older than files on disk",
    });
    expect(afterCheck).toBe(cached);
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it("counts deleted file bytes against auto-refresh limits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-session-delete-bytes-"));
    const removedFile = path.join(root, "large.ts");
    await fs.writeFile(removedFile, `export const payload = "${"x".repeat(64)}";\n`, "utf8");
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
    const session = createAgentSession({ root, freshness: { policy: "auto", maxAutoRefreshBytes: 16 } });
    const cached = await session.loadProject({ symbolGraph: "skip" });
    if (!session.checkFreshness) {
      throw new Error("agent session should expose freshness checks");
    }

    await fs.unlink(removedFile);
    const freshness = await session.checkFreshness();
    const afterCheck = await session.loadProject({ symbolGraph: "skip" });

    expect(freshness).toEqual({
      state: "stale",
      changedFiles: ["large.ts"],
      changedFileCount: 1,
      omittedChangedFileCount: 0,
      reason: "changed byte count exceeds 16",
    });
    expect(afterCheck).toBe(cached);
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it("discovers files in a Git-backed project without a full recursive scan once a manifest exists", async () => {
    const root = await mkGitRepo();
    // Prime the manifest via a real build, matching how loadProject() itself would.
    await createAgentSession({ root }).loadProject({ symbolGraph: "skip" });

    const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
    const files = (await listAgentSessionFiles({ root })).map((file) => file.replace(/\\/g, "/"));

    expect(files.some((file) => file.endsWith("/main.ts"))).toBe(true);
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it("finds a newly created untracked file in a Git-backed project without a full recursive scan", async () => {
    const root = await mkGitRepo();
    await createAgentSession({ root }).loadProject({ symbolGraph: "skip" });

    await fs.writeFile(path.join(root, "fresh.ts"), "export const fresh = 1;\n", "utf8");
    const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
    const files = (await listAgentSessionFiles({ root })).map((file) => file.replace(/\\/g, "/"));

    expect(files.some((file) => file.endsWith("/fresh.ts"))).toBe(true);
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it("falls back to a full scan for non-Git projects", async () => {
    const root = await mkRepo();
    await createAgentSession({ root }).loadProject({ symbolGraph: "skip" });

    const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
    const files = await listAgentSessionFiles({ root });

    expect(files.some((file) => file.endsWith("main.ts"))).toBe(true);
    expect(scanSpy).toHaveBeenCalled();
  });

  it("falls back to a full scan when --cache-strict is requested", async () => {
    const root = await mkGitRepo();
    await createAgentSession({ root }).loadProject({ symbolGraph: "skip" });

    const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
    const files = await listAgentSessionFiles({ root, buildOptions: { cacheStrict: true } });

    expect(files.some((file) => file.endsWith("main.ts"))).toBe(true);
    expect(scanSpy).toHaveBeenCalled();
  });

  it("falls back to a full scan when discovery options changed since the manifest was written", async () => {
    const root = await mkGitRepo();
    await createAgentSession({ root }).loadProject({ symbolGraph: "skip" });

    const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
    const files = await listAgentSessionFiles({
      root,
      useConfig: false,
      discovery: { ignoreGlobs: ["**/*.spec.ts"] },
    });

    expect(files.some((file) => file.endsWith("main.ts"))).toBe(true);
    expect(scanSpy).toHaveBeenCalled();
  });

  it("reuses one Git reconciliation for warm AgentSession indexing", async () => {
    const root = await mkGitRepo();
    await createAgentSession({ root, freshness: { policy: "manual" } }).loadProject({ symbolGraph: "skip" });

    const diffSpy = vi.spyOn(gitModule, "listChangedFiles");
    const untrackedSpy = vi.spyOn(gitModule, "listUntrackedFiles");
    const session = createAgentSession({ root, freshness: { policy: "manual" } });
    await session.loadProject({ symbolGraph: "skip" });

    expect(diffSpy).toHaveBeenCalledTimes(1);
    expect(untrackedSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses the fast discovery path for checkFreshness on an unchanged Git-backed project", async () => {
    const root = await mkGitRepo();
    const session = createAgentSession({ root, freshness: { policy: "check" } });
    await session.loadProject({ symbolGraph: "skip" });
    if (!session.checkFreshness) {
      throw new Error("agent session should expose freshness checks");
    }

    const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
    const freshness = await session.checkFreshness();

    expect(freshness).toEqual({ state: "fresh" });
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it("throttles repeated freshness checks within the stale-check interval", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-session-fresh-throttle-"));
    const filePath = path.join(root, "main.ts");
    await fs.writeFile(filePath, "export const value = 1;\n", "utf8");
    const session = createAgentSession({ root, freshness: { policy: "check" } });
    await session.loadProject({ symbolGraph: "skip" });
    if (!session.checkFreshness) {
      throw new Error("agent session should expose freshness checks");
    }

    let nowMs = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const originalStat = fs.stat.bind(fs);
    let statCalls = 0;
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      statCalls += 1;
      return await originalStat(...args);
    });

    try {
      const first = await session.checkFreshness();
      const afterFirst = statCalls;
      const second = await session.checkFreshness();
      expect(first).toEqual({ state: "fresh" });
      expect(second).toEqual({ state: "fresh" });
      expect(statCalls).toBe(afterFirst);

      await fs.writeFile(filePath, "export const value = 2;\n", "utf8");
      const throttled = await session.checkFreshness();
      expect(throttled).toEqual({ state: "fresh" });
      expect(statCalls).toBe(afterFirst);

      nowMs += AGENT_FRESHNESS_CHECK_INTERVAL_MS + 1;
      const afterWindow = await session.checkFreshness();
      expect(afterWindow).toEqual({
        state: "stale",
        changedFiles: ["main.ts"],
        changedFileCount: 1,
        omittedChangedFileCount: 0,
        reason: "session snapshot is older than files on disk",
      });
      expect(statCalls).toBeGreaterThan(afterFirst);
    } finally {
      statSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });
});
