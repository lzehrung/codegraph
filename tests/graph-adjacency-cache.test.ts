import { describe, expect, it } from "vitest";
import { buildGraphAdjacency, graphAdjacencyFor } from "../src/graphs/adjacency.js";
import type { Graph } from "../src/types.js";

describe("graphAdjacencyFor memoization", () => {
  it("returns the same adjacency index for repeated lookups on one graph", () => {
    const graph: Graph = {
      nodes: new Set(["/a.ts", "/b.ts"]),
      edges: [{ from: "/a.ts", to: { type: "file", path: "/b.ts" }, raw: "./b" }],
    };

    const first = graphAdjacencyFor(graph);
    const second = graphAdjacencyFor(graph);
    expect(second).toBe(first);
    expect(first).not.toBe(buildGraphAdjacency(graph));
  });
});
