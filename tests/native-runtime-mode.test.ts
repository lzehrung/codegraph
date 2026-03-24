import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildProjectIndex, collectGraph, type BuildReport } from "../src/index.js";

describe("native runtime mode", () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");

  it("buildProjectIndex accepts native: off and reports native disabled", async () => {
    const report: BuildReport = { timings: {} };
    const index = await buildProjectIndex(samplePath, {
      native: "off",
      report,
    });

    expect(index.byFile.size).toBeGreaterThan(0);
    expect(report.backend?.native?.enabled).toBe(false);
    expect(report.backend?.native?.filesUsed).toBe(0);
    expect(report.backend?.native?.fallbackReasons.unavailable).toBeGreaterThan(0);
  });

  it("collectGraph accepts native: off and still builds the graph", async () => {
    const mainFile = path.resolve(samplePath, "main.ts").replace(/\\/g, "/");
    const utilsFile = path.resolve(samplePath, "utils.ts").replace(/\\/g, "/");
    const report: BuildReport = { timings: {} };
    const graph = await collectGraph(samplePath, [mainFile, utilsFile], {
      native: "off",
      report,
    });

    expect(graph.nodes.has(mainFile)).toBe(true);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(report.backend?.native?.enabled).toBe(false);
  });
});
