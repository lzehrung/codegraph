import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../src/agent/session.js";
import * as symbolGraphBuild from "../src/graphs/symbol-graph-detailed.js";
import * as indexerBuild from "../src/indexer/build-index.js";
import type { ProjectIndex } from "../src/indexer/types.js";

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-session-"));
  await fs.writeFile(path.join(root, "util.ts"), "export function add(a: number, b: number) { return a + b; }\n");
  await fs.writeFile(path.join(root, "main.ts"), "import { add } from './util';\nexport const total = add(1, 2);\n");
  await fs.writeFile(path.join(root, "schema.sql"), "CREATE TABLE public.users (id int primary key);\n");
  return root;
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

  it("reports stale file edits in check policy without invalidating cached project state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-session-check-fresh-"));
    const filePath = path.join(root, "auth.ts");
    await fs.writeFile(filePath, "export function oldSymbol() { return 1; }\n", "utf8");
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
    const session = createAgentSession({ root, freshness: { policy: "check" } });
    const cached = await session.loadProject({ symbolGraph: "skip" });
    if (!session.checkFreshness) {
      throw new Error("agent session should expose freshness checks");
    }

    await fs.writeFile(filePath, "export function editedSymbol() { return 22; }\n", "utf8");
    const freshness = await session.checkFreshness();
    const afterCheck = await session.loadProject({ symbolGraph: "skip" });

    expect(freshness).toEqual({
      state: "stale",
      changedFiles: ["auth.ts"],
      changedFileCount: 1,
      omittedChangedFileCount: 0,
      reason: "session snapshot is older than files on disk",
    });
    expect(afterCheck).toBe(cached);
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });
});
