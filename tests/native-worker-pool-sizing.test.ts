import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildProjectIndexFromFiles, buildProjectIndexIncremental } from "../src/index.js";
import { NATIVE_WORKER_AUTO_FILE_THRESHOLD, shouldEnableNativeWorkers } from "../src/indexer/build-workers.js";
import { isNativeTreeSitterAvailable } from "../src/native/treeSitterNative.js";
import {
  createNativeWorkerPool,
  defaultNativeWorkerThreadCount,
  resolveNativeWorkerThreadCount,
} from "../src/worker/nativeWorkerPool.js";
import type { BuildReport } from "../src/indexer/types.js";

async function makeProject(fileCount: number, extension = ".ts"): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-pool-sizing-"));
  for (let index = 0; index < fileCount; index += 1) {
    const source =
      extension === ".vue"
        ? `<script lang="ts">export const value${index} = ${index};</script>\n`
        : `export const value${index} = ${index};\n`;
    await fsp.writeFile(path.join(root, `file-${index}${extension}`), source, "utf8");
  }
  return root;
}

function filesIn(root: string, fileCount: number, extension = ".ts"): string[] {
  return Array.from({ length: fileCount }, (_, index) => path.join(root, `file-${index}${extension}`));
}

describe("native worker pool enablement", () => {
  it("declines when there is nothing to parse, even under an explicit request", () => {
    // Piscina starts minThreads eagerly, so an explicit request with no work spawns a pool that
    // is torn down without ever receiving a task.
    expect(shouldEnableNativeWorkers({ useNativeWorkers: true }, 0)).toBe(false);
    expect(shouldEnableNativeWorkers({}, 0)).toBe(false);
  });

  it("auto-enables from the measured threshold, not from an arbitrary project size", () => {
    if (!isNativeTreeSitterAvailable()) return;
    expect(shouldEnableNativeWorkers({}, NATIVE_WORKER_AUTO_FILE_THRESHOLD - 1)).toBe(false);
    expect(shouldEnableNativeWorkers({}, NATIVE_WORKER_AUTO_FILE_THRESHOLD)).toBe(true);
  });

  it("honors an explicit request below the threshold", () => {
    if (!isNativeTreeSitterAvailable()) return;
    expect(shouldEnableNativeWorkers({ useNativeWorkers: true }, 1)).toBe(true);
    expect(shouldEnableNativeWorkers({ useNativeWorkers: false }, 10_000)).toBe(false);
  });

  it("clamps a positive fractional thread bound to one worker", async () => {
    const pool = createNativeWorkerPool({ maxThreads: 0.5 });
    try {
      expect(pool).toBeDefined();
    } finally {
      await pool.destroy();
    }
  });

  it("reserves capacity for automatic native worker sizing", () => {
    expect(defaultNativeWorkerThreadCount(1)).toBe(1);
    expect(defaultNativeWorkerThreadCount(2)).toBe(1);
    expect(defaultNativeWorkerThreadCount(4)).toBe(3);
    expect(defaultNativeWorkerThreadCount(8)).toBe(6);
    expect(defaultNativeWorkerThreadCount(32)).toBe(8);
  });

  it("keeps explicit native thread overrides available", () => {
    expect(resolveNativeWorkerThreadCount(24, 32)).toBe(24);
    expect(resolveNativeWorkerThreadCount(0, 32)).toBe(8);
  });
});

describe.runIf(isNativeTreeSitterAvailable())("native worker pool sizing", () => {
  it("creates no worker threads for a warm run with nothing changed", async () => {
    const root = await makeProject(NATIVE_WORKER_AUTO_FILE_THRESHOLD + 8);
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-pool-sizing-cache-"));
    try {
      const cold: BuildReport = { timings: {} };
      await buildProjectIndexIncremental(root, { cache: "disk", cacheDir, report: cold });
      expect(cold.workerPool?.threads ?? 0).toBeGreaterThan(0);

      const warm: BuildReport = { timings: {} };
      await buildProjectIndexIncremental(root, { cache: "disk", cacheDir, report: warm });
      // Nothing changed, so nothing should have been spawned to parse it.
      expect(warm.workerPool?.threads ?? 0).toBe(0);
      expect(warm.workerPool?.tasksSubmitted ?? 0).toBe(0);
    } finally {
      await Promise.all([
        fsp.rm(root, { recursive: true, force: true }),
        fsp.rm(cacheDir, { recursive: true, force: true }),
      ]);
    }
  }, 60_000);

  it("skips workers for fully cached full builds", async () => {
    const fileCount = NATIVE_WORKER_AUTO_FILE_THRESHOLD + 8;
    const root = await makeProject(fileCount);
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-pool-sizing-full-cache-"));
    try {
      const files = filesIn(root, fileCount);
      await buildProjectIndexFromFiles(root, files, { cache: "disk", cacheDir });

      const warm: BuildReport = { timings: {} };
      await buildProjectIndexFromFiles(root, files, { cache: "disk", cacheDir, report: warm });

      expect(warm.workerPool?.threads ?? 0).toBe(0);
      expect(warm.workerPool?.tasksSubmitted ?? 0).toBe(0);
    } finally {
      await Promise.all([
        fsp.rm(root, { recursive: true, force: true }),
        fsp.rm(cacheDir, { recursive: true, force: true }),
      ]);
    }
  }, 60_000);

  it("bounds an explicitly enabled full build pool to cache misses", async () => {
    const fileCount = NATIVE_WORKER_AUTO_FILE_THRESHOLD + 8;
    const root = await makeProject(fileCount);
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-pool-sizing-full-partial-"));
    try {
      const files = filesIn(root, fileCount);
      await buildProjectIndexFromFiles(root, files, { cache: "disk", cacheDir });
      await fsp.writeFile(path.join(root, "file-0.ts"), "export const value0 = 1000;\n", "utf8");

      const partial: BuildReport = { timings: {} };
      await buildProjectIndexFromFiles(root, files, {
        cache: "disk",
        cacheDir,
        useNativeWorkers: true,
        report: partial,
      });

      expect(partial.workerPool?.enabled).toBe(true);
      expect(partial.workerPool?.threads).toBe(1);
    } finally {
      await Promise.all([
        fsp.rm(root, { recursive: true, force: true }),
        fsp.rm(cacheDir, { recursive: true, force: true }),
      ]);
    }
  }, 60_000);

  it("never creates more threads than there are files to parse", async () => {
    const root = await makeProject(3);
    try {
      const report: BuildReport = { timings: {} };
      // Explicitly requested, so the pool is created despite being under the threshold; the
      // point here is that it is sized by the work rather than by the machine.
      await buildProjectIndexFromFiles(root, filesIn(root, 3), {
        cache: "off",
        useNativeWorkers: true,
        report,
      });
      expect(report.workerPool?.enabled).toBe(true);
      expect(report.workerPool?.threads).toBeGreaterThan(0);
      expect(report.workerPool?.threads).toBeLessThanOrEqual(3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("skips the pool when every changed file stays on the main thread", async () => {
    const fileCount = NATIVE_WORKER_AUTO_FILE_THRESHOLD + 8;
    const root = await makeProject(fileCount, ".vue");
    try {
      const report: BuildReport = { timings: {} };
      await buildProjectIndexFromFiles(root, filesIn(root, fileCount, ".vue"), {
        cache: "off",
        report,
      });
      expect(report.workerPool?.threads ?? 0).toBe(0);
      expect(report.workerPool?.tasksSubmitted ?? 0).toBe(0);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
