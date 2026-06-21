import { describe, expect, it } from "vitest";
import { findDetailedCycles } from "../src/graphs/cycles.js";
import type { Graph } from "../src/types.js";

describe("findDetailedCycles iterative Tarjan", () => {
  it("finds a cycle in a long chain graph without recursive stack overflow", () => {
    const nodes = new Set<string>();
    const edges: Graph["edges"] = [];
    const count = 2500;
    for (let i = 0; i < count; i += 1) {
      const current = `/chain/${i}.ts`;
      nodes.add(current);
      const next = `/chain/${(i + 1) % count}.ts`;
      edges.push({ from: current, to: { type: "file", path: next }, raw: "./next" });
    }
    const graph: Graph = { nodes, edges };

    const cycles = findDetailedCycles(graph);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]?.fileCount).toBe(count);
  });
});
