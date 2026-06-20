import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { buildProjectIndex, buildSymbolGraphDetailed, collectGraph, type BuildReport } from "../src/index.js";
import { isNonNativeParserAvailable } from "../src/parserBackend.js";
import * as nativeRuntime from "../src/native/treeSitterNative.js";

describe("native runtime mode", () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
  const nonNativeParserIt = isNonNativeParserAvailable() ? it : it.skip;

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  nonNativeParserIt("threads native: off through syntax-tree reconstruction paths", async () => {
    const spy = vi.spyOn(nativeRuntime, "getNativeSyntaxTreeExecution");

    const index = await buildProjectIndex(samplePath, {
      native: "off",
    });
    expect(index.byFile.size).toBeGreaterThan(0);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(spy.mock.calls.every((call) => call[2] === "off")).toBe(true);

    spy.mockClear();
    const detailed = await buildSymbolGraphDetailed(index);
    expect(detailed.nodes.size).toBeGreaterThan(0);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(spy.mock.calls.every((call) => call[2] === "off")).toBe(true);
  });
});
