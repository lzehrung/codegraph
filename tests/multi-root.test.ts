import { describe, it, expect } from "vitest";
import path from "node:path";
import { listProjectFiles, buildProjectIndexFromFiles } from "../src/index.js";

describe("Multi-root scanning", () => {
  it("indexes files across multiple roots and merges into one graph", async () => {
    const tsRoot = path.resolve(process.cwd(), "tests", "samples", "typescript");
    const jsRoot = path.resolve(process.cwd(), "tests", "samples", "javascript");
    const commonRoot = path.resolve(process.cwd(), "tests", "samples");

    const tsFiles = await listProjectFiles(tsRoot);
    const jsFiles = await listProjectFiles(jsRoot);
    const files = Array.from(new Set([...tsFiles, ...jsFiles])).map((f) => f.replace(/\\/g, "/"));

    const index = await buildProjectIndexFromFiles(commonRoot, files);

    // Expect modules from both roots to be present
    const tsMain = path.join(tsRoot, "main.ts").replace(/\\/g, "/");
    const jsMain = path.join(jsRoot, "main.js").replace(/\\/g, "/");
    expect(index.byFile.has(tsMain)).toBe(true);
    expect(index.byFile.has(jsMain)).toBe(true);

    // Should build a combined graph
    expect(index.graph.nodes.size).toBeGreaterThan(0);
    expect(index.graph.edges.length).toBeGreaterThan(0);
  });
});
