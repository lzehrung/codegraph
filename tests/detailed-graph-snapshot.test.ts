import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SymbolEdge, SymbolGraph, SymbolNode } from "../src/graphs/symbol-graph.js";
import { buildProjectIndex, buildSymbolGraphDetailed } from "../src/index.js";
import * as buildCache from "../src/indexer/build-cache.js";
import { encodeDetailedSymbolGraphSnapshot } from "../src/indexer/build-cache/detailed-graph-snapshot.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import { assertFilePathWithinRoot, normalizePath } from "../src/util/paths.js";
import { detailedSidecarPath, patchDetailedSidecarHeader } from "./helpers/detailed-sidecar.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const cacheOptions = { cache: "disk", threads: 1 } as const;
const roots = createTempRootRegistry();
const cachedRoots: string[] = [];

afterEach(async () => {
  // The disk cache keeps its SQLite file open, which would keep Windows from removing the project directory.
  for (const root of cachedRoots.splice(0)) buildCache.closeDiskCacheDatabase(root, cacheOptions);
  await roots.cleanup();
});

type Project = {
  root: string;
  index: ProjectIndex;
  /** The absolute, normalized path of a project file, as a graph names it. */
  file: (relative: string) => string;
};

async function indexedProject(sources: Record<string, string>): Promise<Project> {
  const root = await roots.create("dg-detailed-snapshot-");
  cachedRoots.push(root);
  for (const [relative, source] of Object.entries(sources)) {
    await fsp.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fsp.writeFile(path.join(root, relative), source, "utf8");
  }
  const index = await buildProjectIndex(root, cacheOptions);
  return { root, index, file: (relative) => normalizePath(path.resolve(root, relative)) };
}

function graphOf(nodes: SymbolNode[], edges: SymbolEdge[], aliases?: Array<[string, string]>): SymbolGraph {
  const graph: SymbolGraph = { nodes: new Map(nodes.map((node) => [node.id, node])), edges };
  if (aliases?.length) Object.defineProperty(graph, "nodeAliases", { value: new Map(aliases) });
  return graph;
}

async function persist(project: Project, graph: SymbolGraph): Promise<SymbolGraph | null> {
  await buildCache.writeDetailedSymbolGraphSnapshot(project.root, { cache: "disk" }, project.index, graph);
  return await buildCache.tryLoadDetailedSymbolGraphSnapshot(project.root, { cache: "disk" }, project.index);
}

/** JSON text lists properties in order, so equal text is equal values in equal property order. */
function describeGraph(graph: SymbolGraph): { nodes: string; edges: string; aliases: string } {
  const aliases: unknown = Object.getOwnPropertyDescriptor(graph, "nodeAliases")?.value;
  return {
    nodes: JSON.stringify([...graph.nodes]),
    edges: JSON.stringify(graph.edges),
    aliases: JSON.stringify(aliases instanceof Map ? [...aliases] : []),
  };
}

function range(startLine: number, startColumn: number, endLine: number, endColumn: number, indexes?: [number, number]) {
  return {
    start: { line: startLine, column: startColumn, ...(indexes ? { index: indexes[0] } : {}) },
    end: { line: endLine, column: endColumn, ...(indexes ? { index: indexes[1] } : {}) },
  };
}

describe("detailed symbol graph sidecar", () => {
  it("round-trips ids, optional properties, property orders, labels, sites, and aliases exactly", async () => {
    const project = await indexedProject({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" });
    const a = project.file("a.ts");
    const b = project.file("b.ts");
    const nodes: SymbolNode[] = [
      {
        id: `${a}::alpha::0`,
        file: a,
        name: "alpha",
        kind: "function",
        docstring: "Adds numbers.\nSecond line \u00e9 \ud83d\ude00 \u65e5\u672c\u8a9e",
        lineSpan: 12,
        complexity: 3,
      },
      { id: `${a}::beta::4294967294`, file: a, name: "beta", kind: "class", lineSpan: 0, complexity: 0 },
      {
        id: `${a}::gamma::4294967295`,
        file: a,
        name: "gamma",
        kind: "interface",
        complexity: 1.5,
        visibility: "protected",
        implementationTarget: true,
      },
      { id: `${a}::delta::007`, file: a, name: "delta", kind: "type", implementationTarget: false, memberArity: 2 },
      { id: `${a}::epsilon::`, file: a, name: "epsilon", kind: "variable", callable: true },
      { id: `${b}::zeta::import`, file: b, name: "zeta", kind: "import" },
      { id: `${b}::eta::import:type`, file: b, name: "eta", kind: "namespaceImport" },
      // An id whose name part is not the node's name keeps its rest as text.
      { id: `${b}::renamed::-1`, file: b, name: "theta", kind: "default" },
      // `callable` before `memberArity`, and a node that lists its required properties in another order.
      Object.assign(
        { id: `${b}::iota::9`, file: b, name: "iota", kind: "function" as const },
        { callable: true as const },
        { memberArity: 1 },
      ),
      { name: "kappa", id: `${b}::kappa::3`, file: b, kind: "table" },
      // Text that UTF-8 cannot hold: a lone surrogate.
      { id: `${b}::lone\ud800::5`, file: b, name: "lone\ud800", kind: "module", docstring: "lone \udc00 surrogate" },
    ];
    const id = (name: string): string => nodes.find((node) => node.name === name)!.id;
    const edges: SymbolEdge[] = [
      { from: id("alpha"), to: id("beta") },
      { from: id("alpha"), to: id("beta"), label: "calls", site: { file: a, range: range(1, 2, 1, 8, [3, 9]) } },
      { from: id("alpha"), to: id("beta"), label: "calls", site: { file: a, range: range(1, 2, 1, 8, [3, 9]) } },
      { from: id("gamma"), to: id("delta"), label: "" },
      { from: id("zeta"), to: id("alpha"), label: "default", site: { file: b, range: range(4, 0, 4, 5) } },
      { from: id("kappa"), to: id("iota"), label: "unicode \u00fc \ud83d\ude00" },
    ];
    const graph = graphOf(nodes, edges, [
      [`${a}::alphaOverload::20`, id("alpha")],
      [`${b}::thetaOverload::21`, id("theta")],
    ]);

    const loaded = await persist(project, graph);

    if (!loaded) throw new Error("the graph was not persisted");
    expect(describeGraph(loaded)).toEqual(describeGraph(graph));
  });

  it("rebases a sidecar onto the root that loads it", async () => {
    const source = await indexedProject({ "dir/a.ts": "export const a = 1;\n" });
    const target = await indexedProject({ "dir/a.ts": "export const a = 1;\n" });
    const sourceFile = source.file("dir/a.ts");
    const targetFile = target.file("dir/a.ts");
    const node: SymbolNode = { id: `${sourceFile}::a::0`, file: sourceFile, name: "a", kind: "variable" };
    await buildCache.writeDetailedSymbolGraphSnapshot(
      source.root,
      { cache: "disk" },
      source.index,
      graphOf([node], []),
    );
    // The same project content and cache identity under another root: the sidecar moves with the project.
    await patchDetailedSidecarHeader(detailedSidecarPath(source.root), {
      projectSnapshotIdentity: target.index.projectSnapshotIdentity,
    });
    await fsp.mkdir(path.dirname(detailedSidecarPath(target.root)), { recursive: true });
    await fsp.copyFile(detailedSidecarPath(source.root), detailedSidecarPath(target.root));

    const loaded = await buildCache.tryLoadDetailedSymbolGraphSnapshot(target.root, { cache: "disk" }, target.index);

    expect([...(loaded?.nodes ?? [])]).toEqual([
      [`${targetFile}::a::0`, { id: `${targetFile}::a::0`, file: targetFile, name: "a", kind: "variable" }],
    ]);
  });

  it("round-trips text larger than one buffer chunk", async () => {
    const project = await indexedProject({ "a.ts": "export const a = 1;\n" });
    const a = project.file("a.ts");
    // Each docstring is about 300,000 characters of one to three UTF-8 bytes each, so the strings span several chunks.
    const docstrings = ["x", "\u00e9", "\u65e5", "\ud83d\ude00", "mixed \u00e9\u65e5\ud83d\ude00 "].map((unit) =>
      unit.repeat(Math.ceil(300_000 / unit.length)),
    );
    const nodes: SymbolNode[] = docstrings.map((docstring, index) => ({
      id: `${a}::big${index}::${index}`,
      file: a,
      name: `big${index}`,
      kind: "function",
      docstring,
    }));

    const loaded = await persist(project, graphOf(nodes, []));

    expect(nodes.map((node) => loaded?.nodes.get(node.id)?.docstring === node.docstring)).toEqual(
      nodes.map(() => true),
    );
  });

  it("rebases every file name exactly as the shared path functions do", async () => {
    const names = [
      "plain.ts",
      "dir/nested.ts",
      "with space/a b.ts",
      "unicode/\u00f1and\u00fa-\u65e5\u672c\u8a9e.ts",
      "emoji/\ud83d\ude00.ts",
      "dots/a..b.ts",
      "hash#name.ts",
      "brackets/[id].ts",
      "percent%20name.ts",
      "deep/er/still/er/file.ts",
    ];
    const project = await indexedProject(Object.fromEntries(names.map((name) => [name, "export const x = 1;\n"])));
    const nodes: SymbolNode[] = names.map((name) => {
      const file = project.file(name);
      return { id: `${file}::x::0`, file, name: "x", kind: "variable" };
    });

    const loaded = await persist(project, graphOf(nodes, []));

    const expected = names.map((name) =>
      assertFilePathWithinRoot(project.root, path.join(project.root, name), "oracle"),
    );
    expect([...(loaded?.nodes.values() ?? [])].map((node) => node.file)).toEqual(expected);
    expect([...(loaded?.nodes.keys() ?? [])]).toEqual(expected.map((file) => `${file}::x::0`));
  });

  it("writes the same bytes for the same graph", async () => {
    const project = await indexedProject({ "a.ts": "export const a = 1;\n" });
    const a = project.file("a.ts");
    const graph = graphOf(
      [
        { id: `${a}::one::0`, file: a, name: "one", kind: "function", lineSpan: 2 },
        { id: `${a}::two::5`, file: a, name: "two", kind: "function", complexity: 2 },
      ],
      [
        {
          from: `${a}::one::0`,
          to: `${a}::two::5`,
          label: "calls",
          site: { file: a, range: range(1, 1, 1, 4, [0, 3]) },
        },
      ],
    );
    const input = { projectRoot: project.root, projectSnapshotIdentity: "a".repeat(64), graph };

    const first = await encodeDetailedSymbolGraphSnapshot(input);
    const second = await encodeDetailedSymbolGraphSnapshot(input);

    expect(second.equals(first)).toBe(true);
  });

  describe("a graph the format cannot hold exactly", () => {
    const base = (file: string): SymbolNode => ({ id: `${file}::one::0`, file, name: "one", kind: "function" });

    it.each<[string, (project: Project) => SymbolGraph]>([
      [
        "a callable marker that is not true",
        ({ file }) => graphOf([Object.assign(base(file("a.ts")), { callable: false })], []),
      ],
      [
        "a property the format has no column for",
        ({ file }) => graphOf([Object.assign(base(file("a.ts")), { extra: 1 })], []),
      ],
      ["a negative line span", ({ file }) => graphOf([{ ...base(file("a.ts")), lineSpan: -1 }], [])],
      ["a fractional member arity", ({ file }) => graphOf([{ ...base(file("a.ts")), memberArity: 1.5 }], [])],
      [
        "a node id that does not start with its file",
        ({ file }) => graphOf([{ ...base(file("a.ts")), id: "elsewhere::one::0" }], []),
      ],
      [
        "an edge to a node the graph does not hold",
        ({ file }) => graphOf([base(file("a.ts"))], [{ from: `${file("a.ts")}::one::0`, to: "missing" }]),
      ],
      [
        "a call site with a fractional line",
        ({ file }) =>
          graphOf(
            [base(file("a.ts"))],
            [
              {
                from: `${file("a.ts")}::one::0`,
                to: `${file("a.ts")}::one::0`,
                label: "calls",
                site: { file: file("a.ts"), range: range(1.5, 0, 2, 0) },
              },
            ],
          ),
      ],
      [
        "a node file outside the project root",
        ({ root }) => {
          const outside = normalizePath(path.resolve(root, "..", "outside.ts"));
          return graphOf([base(outside)], []);
        },
      ],
      ["a node file the project does not index", ({ file }) => graphOf([base(file("ghost.ts"))], [])],
    ])("is not persisted for %s, and a load finds no sidecar", async (_description, makeGraph) => {
      const project = await indexedProject({ "a.ts": "export const a = 1;\n" });

      await expect(
        buildCache.writeDetailedSymbolGraphSnapshot(project.root, { cache: "disk" }, project.index, makeGraph(project)),
      ).resolves.toBeUndefined();

      await expect(fsp.stat(detailedSidecarPath(project.root))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        buildCache.tryLoadDetailedSymbolGraphSnapshot(project.root, { cache: "disk" }, project.index),
      ).resolves.toBeNull();
    });
  });

  // The graphs of real sources carry every node and edge shape the detailed passes produce. A shape the format has no
  // column for would leave a repository without a persisted graph and rebuild it in every process.
  describe("a graph built from real sources", () => {
    const samples = [
      "c",
      "cpp",
      "csharp",
      "go",
      "java",
      "kotlin",
      "php",
      "python",
      "ruby",
      "rust",
      "swift",
      "typescript",
      "tsx",
      "zig",
      "sql",
      "terraform",
      "vue",
      "svelte",
      "scss",
      "complex-monorepo",
    ];

    it.each(samples)("persists and reloads the %s sample unchanged", async (name) => {
      const root = await roots.create("dg-detailed-sample-");
      cachedRoots.push(root);
      await fsp.cp(path.resolve(process.cwd(), "tests", "samples", name), root, { recursive: true });
      const index = await buildProjectIndex(root, cacheOptions);
      const graph = await buildSymbolGraphDetailed(index);

      await buildCache.writeDetailedSymbolGraphSnapshot(root, { cache: "disk" }, index, graph);
      const loaded = await buildCache.tryLoadDetailedSymbolGraphSnapshot(root, { cache: "disk" }, index);

      if (!loaded) throw new Error(`the ${name} sample graph was not persisted`);
      expect(graph.nodes.size).toBeGreaterThan(0);
      expect(describeGraph(loaded)).toEqual(describeGraph(graph));
    });
  });
});
