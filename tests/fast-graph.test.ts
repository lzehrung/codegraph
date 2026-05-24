import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { collectGraph, type Edge } from "../src/index.js";
import * as nativeRuntime from "../src/native/treeSitterNative.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { graphEdgeKey } from "./helpers/graph.js";
import { getSamplePath } from "./test-utils.js";

describe("Fast graph specifier extraction (--fast-graph)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches regular graph edges for TypeScript samples", async () => {
    const root = getSamplePath("typescript");
    const files = [
      path.join(root, "main.ts").replace(/\\/g, "/"),
      path.join(root, "utils.ts").replace(/\\/g, "/"),
      path.join(root, "helpers.ts").replace(/\\/g, "/"),
    ];
    const g1 = await collectGraph(root, files);
    const g2 = await (await import("../src/graphs.js")).collectGraph(root, files, { fast: true });

    const aSet = new Set(g1.edges.map(graphEdgeKey));
    const bSet = new Set(g2.edges.map(graphEdgeKey));
    expect(bSet).toEqual(aSet);
  });

  it("matches regular graph edges for JavaScript samples", async () => {
    const root = getSamplePath("javascript");
    const files = [
      path.join(root, "main.js").replace(/\\/g, "/"),
      path.join(root, "utils.js").replace(/\\/g, "/"),
      path.join(root, "helpers.js").replace(/\\/g, "/"),
      path.join(root, "legacy.js").replace(/\\/g, "/"),
      path.join(root, "mixed.js").replace(/\\/g, "/"),
    ];
    const g1 = await collectGraph(root, files);
    const g2 = await (await import("../src/graphs.js")).collectGraph(root, files, { fast: true });

    const aSet = new Set(g1.edges.map(graphEdgeKey));
    const bSet = new Set(g2.edges.map(graphEdgeKey));
    expect(bSet).toEqual(aSet);
  });
  it("matches regular graph edges for Python samples", async () => {
    const root = getSamplePath("python");
    const files = [
      path.join(root, "main.py").replace(/\\/g, "/"),
      path.join(root, "utils.py").replace(/\\/g, "/"),
      path.join(root, "helpers.py").replace(/\\/g, "/"),
      path.join(root, "__init__.py").replace(/\\/g, "/"),
    ];
    const g1 = await collectGraph(root, files);
    const g2 = await (await import("../src/graphs.js")).collectGraph(root, files, { fast: true });

    const aSet = new Set(g1.edges.map(graphEdgeKey));
    const bSet = new Set(g2.edges.map(graphEdgeKey));
    expect(bSet).toEqual(aSet);
  });

  it("can miss multiline import edges that full parsing captures", async () => {
    const root = await mkTmpDir("dg-fast-graph-");
    const entryPath = path.join(root, "entry.ts").replace(/\\/g, "/");
    const depPath = path.join(root, "dep.ts").replace(/\\/g, "/");
    await fsp.writeFile(entryPath, `import {\n  value\n} from './dep';\n\nconsole.log(value);\n`, "utf8");
    await fsp.writeFile(depPath, `export const value = 42;\n`, "utf8");

    const files = [entryPath, depPath];
    const fullGraph = await collectGraph(root, files);
    const fastGraph = await collectGraph(root, files, { fast: true });

    const hasEdge = (edges: Edge[], from: string, to: string) =>
      edges.some((edge) => edge.from === from && edge.to.type === "file" && edge.to.path === to);

    expect(hasEdge(fullGraph.edges, entryPath, depPath)).toBe(true);
    expect(hasEdge(fastGraph.edges, entryPath, depPath)).toBe(false);
  });

  it("does not invoke native query execution for JS/TS fast-graph extraction", async () => {
    const root = getSamplePath("typescript");
    const files = [
      path.join(root, "main.ts").replace(/\\/g, "/"),
      path.join(root, "utils.ts").replace(/\\/g, "/"),
      path.join(root, "helpers.ts").replace(/\\/g, "/"),
    ];
    const nativeSpy = vi.spyOn(nativeRuntime, "getNativeQueryExecution");

    await collectGraph(root, files, { fast: true });

    expect(nativeSpy).not.toHaveBeenCalled();
  });
});
