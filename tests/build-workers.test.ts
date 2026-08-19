import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";
import { supportForFile } from "../src/languages.js";
import { prepareFileContextsForBuildBatch, type WorkerPoolSetupResult } from "../src/indexer/build-workers.js";
import type { BuildReport } from "../src/indexer/types.js";
import type { NativeExtractTask } from "../src/worker/nativeExtractWorker.js";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("native build worker batches", () => {
  it("counts and records an omitted worker result before falling back", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-worker-short-batch-"));
    tempDirs.push(root);
    const file = path.join(root, "sample.ts");
    await fs.writeFile(file, "export const answer = 42;\n", "utf8");
    const support = supportForFile(file);
    expect(support).toBeDefined();
    if (!support) throw new Error("TypeScript support was not registered");

    const run = vi.fn(async () => ({ results: [] }));
    const workerSetup: WorkerPoolSetupResult = {
      pool: {
        run,
        destroy: async () => {},
      },
      report: {
        enabled: true,
        threads: 1,
        tasksSubmitted: 0,
        tasksFailed: 0,
      },
      startTime: 0,
      batchSize: 1,
    };
    const report: BuildReport = { timings: {} };

    const prepared = await prepareFileContextsForBuildBatch(
      [{ file, support }],
      { native: "off" },
      workerSetup,
      report,
    );

    expect(run).toHaveBeenCalledOnce();
    expect(prepared).toHaveLength(1);
    expect(workerSetup.report?.tasksSubmitted).toBe(1);
    expect(workerSetup.report?.tasksFailed).toBe(1);
    expect(workerSetup.report?.errors).toEqual([
      {
        file,
        message: "Native worker returned no result for batch task.",
      },
    ]);
    expect(report.backend?.native.filesFellBack).toBe(1);
  });

  it("falls back when a worker returns null", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-worker-null-result-"));
    tempDirs.push(root);
    const file = path.join(root, "sample.ts");
    await fs.writeFile(file, "export const answer = 42;\n", "utf8");
    const support = supportForFile(file);
    expect(support).toBeDefined();
    if (!support) throw new Error("TypeScript support was not registered");

    const run = vi.fn(async () => null);
    const workerSetup: WorkerPoolSetupResult = {
      pool: {
        run,
        destroy: async () => {},
      },
      report: {
        enabled: true,
        threads: 1,
        tasksSubmitted: 0,
        tasksFailed: 0,
      },
      startTime: 0,
      batchSize: 1,
    };
    const report: BuildReport = { timings: {} };

    const prepared = await prepareFileContextsForBuildBatch(
      [{ file, support }],
      { native: "off" },
      workerSetup,
      report,
    );

    expect(run).toHaveBeenCalledOnce();
    expect(prepared).toHaveLength(1);
    expect(workerSetup.report?.tasksFailed).toBe(1);
    expect(workerSetup.report?.errors).toEqual([
      {
        file,
        message: "Native worker returned no result for batch task.",
      },
    ]);
    expect(report.backend?.native.filesFellBack).toBe(1);
  });

  it("submits each bounded slice as one batch request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-worker-batch-"));
    tempDirs.push(root);
    const files = [path.join(root, "first.ts"), path.join(root, "second.ts")];
    await Promise.all(
      files.map((file, index) => fs.writeFile(file, `export const value${index} = ${index};\n`, "utf8")),
    );
    const support = supportForFile(files[0]);
    expect(support).toBeDefined();
    if (!support) throw new Error("TypeScript support was not registered");

    const run = vi.fn(async (task: NativeExtractTask | { tasks: NativeExtractTask[] }) => {
      if (!("tasks" in task)) throw new Error("Expected a batch task");
      return {
        results: task.tasks.map((item) => ({
          filePath: item.filePath,
          languageId: item.languageId,
          source: `export const ${path.basename(item.filePath, ".ts")} = 1;\n`,
          nativeResults: null,
          compactResults: null,
          syntaxTree: null,
        })),
      };
    });
    const workerSetup: WorkerPoolSetupResult = {
      pool: { run, destroy: async () => {} },
      report: { enabled: true, threads: 1, tasksSubmitted: 0, tasksFailed: 0 },
      startTime: 0,
      batchSize: 2,
    };

    const prepared = await prepareFileContextsForBuildBatch(
      files.map((file) => ({ file, support })),
      { native: "off" },
      workerSetup,
    );

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toEqual({
      tasks: expect.arrayContaining([
        expect.objectContaining({ filePath: files[0] }),
        expect.objectContaining({ filePath: files[1] }),
      ]),
    });
    expect(prepared.map((entry) => entry.file)).toEqual(files);
    expect(workerSetup.report?.tasksSubmitted).toBe(2);
    expect(workerSetup.report?.tasksFailed).toBe(0);
  });
});
