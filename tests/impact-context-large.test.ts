import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ModuleIndex, ProjectIndex } from "../src/indexer.js";

type MockSymbolNode = {
  id: string;
  file: string;
  name: string;
  kind: string;
};

type MockSymbolEdge = {
  from: string;
  to: string;
  label?: string;
};

type MockSymbolGraph = {
  nodes: Map<string, MockSymbolNode>;
  edges: MockSymbolEdge[];
};

type NeighborInfo = {
  symbolId: string;
  relationship: "uses" | "usedBy";
  file: string;
  name: string;
  kind: string;
};

const buildMockGraph = (size = 500): MockSymbolGraph => {
  const nodes = new Map<string, MockSymbolNode>();
  for (let i = 0; i < size; i++) {
    nodes.set(`sym-${i}`, {
      id: `sym-${i}`,
      file: `/src/file-${i}.ts`,
      name: `symbol${i}`,
      kind: i % 2 === 0 ? "function" : "class",
    });
  }

  const edges: MockSymbolEdge[] = [];
  for (let i = 0; i < size - 1; i++) {
    edges.push({ from: `sym-${i}`, to: `sym-${i + 1}`, label: `chain-${i}` });
    edges.push({ from: `sym-${i + 1}`, to: `sym-${i}`, label: `chain-${i}` });
  }

  for (let i = 0; i < Math.floor(size / 3); i++) {
    const target = size - 1 - i;
    edges.push({ from: `sym-${i}`, to: `sym-${target}`, label: `jump-${i}` });
  }

  return { nodes, edges };
};

let cachedMockGraph: MockSymbolGraph | undefined;

vi.mock("../src/graphs.js", () => {
  const graph = buildMockGraph(600);
  cachedMockGraph = graph;
  return {
    buildSymbolGraphDetailed: vi.fn(async () => graph),
  };
});

let collectImpactContext: typeof import("../src/impact/index.js").collectImpactContext;

beforeAll(async () => {
  const module = await import("../src/impact/index.js");
  collectImpactContext = module.collectImpactContext;
});

const computeExpectedNeighbors = (graph: MockSymbolGraph, changedSymbolIds: string[], hops: number): NeighborInfo[] => {
  const adjacencyFrom = new Map<string, MockSymbolEdge[]>();
  const adjacencyTo = new Map<string, MockSymbolEdge[]>();
  for (const edge of graph.edges) {
    const fromList = adjacencyFrom.get(edge.from) || [];
    if (!adjacencyFrom.has(edge.from)) adjacencyFrom.set(edge.from, fromList);
    fromList.push(edge);

    const toList = adjacencyTo.get(edge.to) || [];
    if (!adjacencyTo.has(edge.to)) adjacencyTo.set(edge.to, toList);
    toList.push(edge);
  }

  const visited = new Set(changedSymbolIds);
  let currentLevel = changedSymbolIds.slice();
  const neighbors: NeighborInfo[] = [];

  for (let depth = 0; depth < hops && currentLevel.length > 0; depth++) {
    const nextLevel: string[] = [];

    for (const symbolId of currentLevel) {
      for (const edge of adjacencyFrom.get(symbolId) || []) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        nextLevel.push(edge.to);
        const node = graph.nodes.get(edge.to);
        if (node) {
          neighbors.push({
            symbolId: edge.to,
            relationship: "uses",
            file: node.file,
            name: node.name,
            kind: node.kind,
          });
        }
      }

      for (const edge of adjacencyTo.get(symbolId) || []) {
        if (visited.has(edge.from)) continue;
        visited.add(edge.from);
        nextLevel.push(edge.from);
        const node = graph.nodes.get(edge.from);
        if (node) {
          neighbors.push({
            symbolId: edge.from,
            relationship: "usedBy",
            file: node.file,
            name: node.name,
            kind: node.kind,
          });
        }
      }
    }

    currentLevel = nextLevel;
  }

  return neighbors;
};

describe("Impact context BFS adjacency optimization", () => {
  it("returns the same neighbors for a large mocked graph", async () => {
    if (!collectImpactContext) throw new Error("collectImpactContext is not initialized");
    if (!cachedMockGraph) throw new Error("Mock graph was not initialized");

    const changedSymbolIds = ["sym-0"];
    const hops = 3;
    const expected = computeExpectedNeighbors(cachedMockGraph, changedSymbolIds, hops);

    const index: ProjectIndex = {
      graph: { nodes: new Set<string>(), edges: [] },
      modules: new Map<string, ModuleIndex>(),
      byFile: new Map<string, ModuleIndex>(),
      exportCache: new Map(),
    };

    const context = await collectImpactContext(index, [], changedSymbolIds, hops);

    expect(context.symbolNeighbors.length).toBe(expected.length);

    const neighborKey = (neighbor: NeighborInfo) =>
      `${neighbor.symbolId}:${neighbor.relationship}:${neighbor.file}:${neighbor.name}:${neighbor.kind}`;

    const actualSet = new Set(context.symbolNeighbors.map(neighborKey));
    const expectedSet = new Set(expected.map(neighborKey));
    expect(actualSet).toEqual(expectedSet);

    const expectedFiles = new Set(expected.map((neighbor) => neighbor.file));
    expect(context.neighborFiles).toEqual(expectedFiles);
  });
});
