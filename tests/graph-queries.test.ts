import { describe, it, expect } from "vitest";
import {
  getDependencies,
  getReverseDependencies,
  getShortestPath,
  findCycles,
  findDetailedCycles,
  sortDetailedCycles,
} from "../src/index.js";
import type { Edge, Graph } from "../src/types.js";

describe("graph queries", () => {
  const root = "/root";
  const nodes = new Set([`${root}/a.ts`, `${root}/b.ts`, `${root}/c.ts`, `${root}/d.ts`]);
  const edges = [
    { from: `${root}/a.ts`, to: { type: "file" as const, path: `${root}/b.ts` }, raw: "./b" },
    { from: `${root}/b.ts`, to: { type: "file" as const, path: `${root}/c.ts` }, raw: "./c" },
    { from: `${root}/c.ts`, to: { type: "file" as const, path: `${root}/a.ts` }, raw: "./a" }, // Cycle!
    { from: `${root}/d.ts`, to: { type: "file" as const, path: `${root}/b.ts` }, raw: "./b" },
  ];
  const graph = { nodes, edges };

  it("should get dependencies", () => {
    const deps = getDependencies(graph, `${root}/a.ts`);
    expect(deps.length).toBe(2);
    expect(deps.some((d) => d.file === `${root}/b.ts` && d.depth === 1)).toBe(true);
    expect(deps.some((d) => d.file === `${root}/c.ts` && d.depth === 2)).toBe(true);
  });

  it("should get reverse dependencies", () => {
    const rdeps = getReverseDependencies(graph, `${root}/b.ts`);
    expect(rdeps.length).toBe(3);
    expect(rdeps.some((d) => d.file === `${root}/a.ts` && d.depth === 1)).toBe(true);
    expect(rdeps.some((d) => d.file === `${root}/d.ts` && d.depth === 1)).toBe(true);
    expect(rdeps.some((d) => d.file === `${root}/c.ts` && d.depth === 2)).toBe(true);
  });

  it("should bound dependency traversal results when a limit is provided", () => {
    const deps = getDependencies(graph, `${root}/a.ts`, { limit: 1 });
    expect(deps).toEqual([{ file: `${root}/b.ts`, depth: 1 }]);
  });

  it("should return no dependency results when the limit is zero", () => {
    const deps = getDependencies(graph, `${root}/a.ts`, { limit: 0 });
    expect(deps).toEqual([]);
  });

  it("should bound reverse dependency traversal results when a limit is provided", () => {
    const rdeps = getReverseDependencies(graph, `${root}/b.ts`, { limit: 2 });
    expect(rdeps.length).toBe(2);
    expect(rdeps.some((d) => d.file === `${root}/a.ts` && d.depth === 1)).toBe(true);
    expect(rdeps.some((d) => d.file === `${root}/d.ts` && d.depth === 1)).toBe(true);
  });

  it("should return no reverse dependency results when the limit is zero", () => {
    const rdeps = getReverseDependencies(graph, `${root}/b.ts`, { limit: 0 });
    expect(rdeps).toEqual([]);
  });

  it("should ignore non-finite dependency limits", () => {
    const depsWithNaN = getDependencies(graph, `${root}/a.ts`, { limit: Number.NaN });
    const depsWithInfinity = getDependencies(graph, `${root}/a.ts`, { limit: Number.POSITIVE_INFINITY });
    expect(depsWithNaN).toEqual(getDependencies(graph, `${root}/a.ts`));
    expect(depsWithInfinity).toEqual(getDependencies(graph, `${root}/a.ts`));
  });

  it("should ignore non-finite reverse dependency limits", () => {
    const rdepsWithNaN = getReverseDependencies(graph, `${root}/b.ts`, { limit: Number.NaN });
    const rdepsWithInfinity = getReverseDependencies(graph, `${root}/b.ts`, { limit: Number.POSITIVE_INFINITY });
    expect(rdepsWithNaN).toEqual(getReverseDependencies(graph, `${root}/b.ts`));
    expect(rdepsWithInfinity).toEqual(getReverseDependencies(graph, `${root}/b.ts`));
  });

  it("should find shortest path", () => {
    const p = getShortestPath(graph, `${root}/d.ts`, `${root}/c.ts`);
    expect(p).toEqual([`${root}/d.ts`, `${root}/b.ts`, `${root}/c.ts`]);
  });

  it("builds traversal adjacency once per direct graph query", () => {
    const perfRoot = `${root}/perf`;
    const perfNodes = new Set<string>();
    const perfEdges: Edge[] = [];
    for (let i = 0; i <= 20; i++) {
      perfNodes.add(`${perfRoot}/${i}.ts`);
      if (i > 0) {
        perfEdges.push({
          from: `${perfRoot}/${i - 1}.ts`,
          to: { type: "file", path: `${perfRoot}/${i}.ts` },
          raw: `./${i}`,
        });
      }
    }

    let edgeIterations = 0;
    const trackedEdges: Edge[] = [...perfEdges];
    const originalIterator = trackedEdges[Symbol.iterator].bind(trackedEdges);
    trackedEdges[Symbol.iterator] = function (): ArrayIterator<Edge> {
      edgeIterations += 1;
      return originalIterator();
    };
    const trackedGraph: Graph = { nodes: perfNodes, edges: trackedEdges };

    expect(getDependencies(trackedGraph, `${perfRoot}/0.ts`, { limit: 5 })).toHaveLength(5);
    expect(getReverseDependencies(trackedGraph, `${perfRoot}/5.ts`, { limit: 5 })).toHaveLength(5);
    expect(getShortestPath(trackedGraph, `${perfRoot}/0.ts`, `${perfRoot}/5.ts`)).toEqual([
      `${perfRoot}/0.ts`,
      `${perfRoot}/1.ts`,
      `${perfRoot}/2.ts`,
      `${perfRoot}/3.ts`,
      `${perfRoot}/4.ts`,
      `${perfRoot}/5.ts`,
    ]);
    expect(edgeIterations).toBe(1);
  });

  it("should find cycles", () => {
    const cycles = findCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toContain(`${root}/a.ts`);
    expect(cycles[0]).toContain(`${root}/b.ts`);
    expect(cycles[0]).toContain(`${root}/c.ts`);
  });

  it("should return null for disconnected nodes in shortest path", () => {
    const eFile = `${root}/e.ts`;
    nodes.add(eFile);
    const p = getShortestPath(graph, `${root}/a.ts`, eFile);
    expect(p).toBeNull();
  });

  it("should detect self-loop cycles", () => {
    const selfLoopFile = `${root}/self.ts`;
    const selfLoopNodes = new Set([selfLoopFile]);
    const selfLoopEdges = [{ from: selfLoopFile, to: { type: "file" as const, path: selfLoopFile }, raw: "./self" }];
    const selfLoopGraph = { nodes: selfLoopNodes, edges: selfLoopEdges };

    const cycles = findCycles(selfLoopGraph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual([selfLoopFile]);
  });

  it("does not report document-only link cycles as dependency cycles", () => {
    const docGraph = {
      nodes: new Set([`${root}/docs/a.md`, `${root}/docs/b.md`]),
      edges: [
        { from: `${root}/docs/a.md`, to: { type: "file" as const, path: `${root}/docs/b.md` }, raw: "./b.md" },
        { from: `${root}/docs/b.md`, to: { type: "file" as const, path: `${root}/docs/a.md` }, raw: "./a.md" },
      ],
    };

    expect(findCycles(docGraph)).toEqual([]);
    expect(findDetailedCycles(docGraph)).toEqual([]);
  });

  it("still reports cycles that cross from documents into source files", () => {
    const mixedGraph = {
      nodes: new Set([`${root}/docs/a.md`, `${root}/src/a.ts`]),
      edges: [
        { from: `${root}/docs/a.md`, to: { type: "file" as const, path: `${root}/src/a.ts` }, raw: "../src/a.ts" },
        { from: `${root}/src/a.ts`, to: { type: "file" as const, path: `${root}/docs/a.md` }, raw: "../docs/a.md" },
      ],
    };

    expect(findCycles(mixedGraph)).toHaveLength(1);
  });

  it("should provide detailed cycle metadata with entry edges and priority", () => {
    const details = findDetailedCycles(graph);
    expect(details.length).toBe(1);
    const cycle = details[0]!;
    expect(cycle.fileCount).toBe(3);
    expect(cycle.internalEdgeCount).toBe(3);
    expect(cycle.internalEdges.length).toBe(3);
    expect(cycle.entryEdges.length).toBe(1);
    expect(cycle.priorityScore).toBeGreaterThan(0);
    expect(cycle.remediationHint.length).toBeGreaterThan(0);
  });

  it("should sort detailed cycles by size and fanin", () => {
    const g = {
      nodes: new Set([`${root}/a.ts`, `${root}/b.ts`, `${root}/c.ts`, `${root}/d.ts`, `${root}/e.ts`, `${root}/f.ts`]),
      edges: [
        { from: `${root}/a.ts`, to: { type: "file" as const, path: `${root}/b.ts` }, raw: "./b" },
        { from: `${root}/b.ts`, to: { type: "file" as const, path: `${root}/a.ts` }, raw: "./a" },
        { from: `${root}/c.ts`, to: { type: "file" as const, path: `${root}/d.ts` }, raw: "./d" },
        { from: `${root}/d.ts`, to: { type: "file" as const, path: `${root}/e.ts` }, raw: "./e" },
        { from: `${root}/e.ts`, to: { type: "file" as const, path: `${root}/c.ts` }, raw: "./c" },
        { from: `${root}/f.ts`, to: { type: "file" as const, path: `${root}/c.ts` }, raw: "./c" },
      ],
    };
    const detailed = findDetailedCycles(g);
    const bySize = sortDetailedCycles(detailed, "size");
    const byFanin = sortDetailedCycles(detailed, "fanin");

    expect(bySize[0]?.fileCount).toBeGreaterThanOrEqual(bySize[1]?.fileCount ?? 0);
    expect(byFanin[0]?.fanInFromOutside).toBeGreaterThanOrEqual(byFanin[1]?.fanInFromOutside ?? 0);
  });

  it("should use symbol coupling to choose remediation edge", () => {
    const coupling = new Map<string, number>([
      [`${root}/a.ts -> ${root}/b.ts`, 4],
      [`${root}/b.ts -> ${root}/c.ts`, 1],
      [`${root}/c.ts -> ${root}/a.ts`, 5],
    ]);
    const details = findDetailedCycles(graph, { symbolCoupling: coupling });
    expect(details[0]?.remediationHint.includes(`${root}/b.ts -> ${root}/c.ts`)).toBe(true);
  });
});
