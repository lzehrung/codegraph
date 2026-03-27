import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectIndexFromFiles,
  listProjectFiles,
  type ProjectIndex,
  type BuildReport,
} from "../src/index.js";
import * as nativeRuntime from "../src/native/treeSitterNative.js";

const nativeDescribe = nativeRuntime.isNativeTreeSitterAvailable()
  ? describe
  : describe.skip;

const sampleRoot = path.resolve(process.cwd(), "tests", "samples");

function serializableModules(index: ProjectIndex) {
  const entries: Array<{
    file: string;
    exports: unknown[];
    imports: unknown[];
    locals: unknown[];
  }> = [];
  for (const [file, mod] of index.byFile) {
    entries.push({
      file,
      exports: mod.exports.map((e) => ({ ...e })),
      imports: mod.imports.map((i) => ({ ...i })),
      locals: mod.locals.map((l) => ({ ...l })),
    });
  }
  return entries.sort((a, b) => a.file.localeCompare(b.file));
}

function serializableGraph(index: ProjectIndex) {
  return {
    nodes: Array.from(index.graph.nodes).sort(),
    edges: index.graph.edges
      .map((e) => ({
        from: e.from,
        to: e.to,
        ...(e.raw !== undefined ? { raw: e.raw } : {}),
        ...(e.typeOnly !== undefined ? { typeOnly: e.typeOnly } : {}),
        ...(e.resolved !== undefined ? { resolved: e.resolved } : {}),
        ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
      }))
      .sort((a, b) => {
        const key = (x: (typeof a)) => {
          const toStr = x.to.type === "file" ? x.to.path : x.to.name;
          const extras = JSON.stringify({
            raw: "raw" in x ? x.raw : undefined,
            typeOnly: "typeOnly" in x ? x.typeOnly : undefined,
          });
          return `${x.from}::${toStr}::${extras}`;
        };
        return key(a).localeCompare(key(b));
      }),
  };
}

nativeDescribe("native worker parity", () => {
  const fixtureRoots = [
    { name: "typescript", dir: path.join(sampleRoot, "typescript") },
    { name: "python", dir: path.join(sampleRoot, "python") },
    { name: "go", dir: path.join(sampleRoot, "go") },
    { name: "mixed", dir: sampleRoot },
  ];

  for (const { name, dir } of fixtureRoots) {
    it(`produces identical output for ${name} fixtures`, async () => {
      const files = await listProjectFiles(dir);
      expect(files.length).toBeGreaterThan(0);

      const reportBaseline: BuildReport = { timings: {} };
      const reportWorker: BuildReport = { timings: {} };

      const baseline = await buildProjectIndexFromFiles(dir, files, {
        native: "on",
        report: reportBaseline,
      });

      const withWorkers = await buildProjectIndexFromFiles(dir, files, {
        native: "on",
        useNativeWorkers: true,
        nativeThreads: 2,
        report: reportWorker,
      });

      // Module indexes must match
      const baselineModules = serializableModules(baseline);
      const workerModules = serializableModules(withWorkers);
      expect(workerModules).toEqual(baselineModules);

      // Graph structure must match
      const baselineGraph = serializableGraph(baseline);
      const workerGraph = serializableGraph(withWorkers);
      expect(workerGraph).toEqual(baselineGraph);

      // Worker pool report must be present
      expect(reportWorker.workerPool?.enabled).toBe(true);
      expect(reportWorker.workerPool?.threads).toBeGreaterThan(0);
    }, 30_000);
  }

  it("skips worker pool when native is disabled and still produces valid results", async () => {
    const files = await listProjectFiles(
      path.join(sampleRoot, "typescript"),
    );
    expect(files.length).toBeGreaterThan(0);

    const report: BuildReport = { timings: {} };
    // useNativeWorkers + native off: pool should not be created, results still valid
    const index = await buildProjectIndexFromFiles(
      path.join(sampleRoot, "typescript"),
      files,
      {
        native: "off",
        useNativeWorkers: true,
        report,
      },
    );
    expect(index.byFile.size).toBeGreaterThan(0);
    // Pool should not have been enabled since native is off
    expect(
      report.workerPool === undefined || report.workerPool.enabled === false,
    ).toBe(true);
  }, 15_000);
});
