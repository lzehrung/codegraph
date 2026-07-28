import { describe, it, expect } from "vitest";
import path from "node:path";
import { collectGraph } from "../src/index.js";
import { graphEdgeKey } from "./helpers/graph.js";
import { readOnlySamplePath } from "./helpers/filesystem.js";

describe("Monorepo fast graph parity", () => {
  it("fast mode matches normal mode in monorepo sample", async () => {
    const root = readOnlySamplePath("monorepo");
    const files = [
      path.join(root, "packages", "pkg-a", "src", "index.ts").replace(/\\/g, "/"),
      path.join(root, "packages", "pkg-b", "src", "index.js").replace(/\\/g, "/"),
    ];
    const g1 = await collectGraph(root, files);
    const g2 = await (await import("../src/graphs.js")).collectGraph(root, files, { fast: true });

    const aSet = new Set(g1.edges.map(graphEdgeKey));
    const bSet = new Set(g2.edges.map(graphEdgeKey));
    expect(bSet).toEqual(aSet);

    // Ensure workspace package edge is resolved to a file
    const hasPkgA = g2.edges.some((e) => e.raw === "@acme/pkg-a" && e.to.type === "file");
    expect(hasPkgA).toBe(true);
  });
});
