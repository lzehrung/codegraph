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
    locals: Array<{ localName: string; kind: string }>;
  }> = [];
  for (const [file, mod] of index.byFile) {
    entries.push({
      file,
      exports: mod.exports.map((e) => ({ ...e })),
      imports: mod.imports.map((i) => ({ ...i })),
      locals: mod.locals.map((l) => ({
        localName: l.localName,
        kind: l.kind,
      })),
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
        ...(e.raw ? { raw: e.raw } : {}),
      }))
      .sort((a, b) => {
        const key = (x: (typeof a)) => {
          const toStr = x.to.type === "file" ? x.to.path : x.to.name;
          return `${x.from}::${toStr}`;
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
      if (files.length === 0) return;

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

  it("gracefully falls back when workers encounter errors", async () => {
    const files = await listProjectFiles(
      path.join(sampleRoot, "typescript"),
    );
    if (files.length === 0) return;

    const report: BuildReport = { timings: {} };
    // Even with workers enabled but native off, should produce valid results
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
  }, 15_000);
});
