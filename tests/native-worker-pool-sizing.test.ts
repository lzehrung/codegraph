import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildProjectIndexFromFiles, buildProjectIndexIncremental } from "../src/index.js";
import { NATIVE_WORKER_AUTO_FILE_THRESHOLD, shouldEnableNativeWorkers } from "../src/indexer/build-workers.js";
import { isNativeTreeSitterAvailable } from "../src/native/tree-sitter-native.js";
import {
  createNativeWorkerPool,
  defaultNativeWorkerThreadCount,
  resolveNativeWorkerPath,
  resolveNativeWorkerThreadCount,
} from "../src/worker/native-worker-pool.js";
import type { BuildReport } from "../src/indexer/types.js";

async function makeProject(fileCount: number, extension = ".ts", paddingBytes = 0): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-pool-sizing-"));
  const padding = paddingBytes ? `\n/*${"x".repeat(paddingBytes)}*/\n` : "";
  for (let index = 0; index < fileCount; index += 1) {
    const source =
      extension === ".vue"
        ? `<script lang="ts">export const value${index} = ${index};</script>\n`
        : `export const value${index} = ${index};\n`;
    await fsp.writeFile(path.join(root, `file-${index}${extension}`), source + padding, "utf8");
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

  it("uses the compiled worker from this checkout", () => {
    const worker = resolveNativeWorkerPath();
    expect(worker).toBe(path.resolve("dist", "worker", "native-extract-worker.js"));
    expect(existsSync(worker)).toBe(true);
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
  it.each([
    [50, 2],
    [150, 2],
    [500, 2],
  ])("sizes an automatic pool for %i parse misses", async (fileCount, workLimit) => {
    const root = await makeProject(fileCount);
    try {
      const report: BuildReport = { timings: {} };
      await buildProjectIndexFromFiles(root, filesIn(root, fileCount), { cache: "off", report });
      expect(report.workerPool?.threads).toBe(Math.min(defaultNativeWorkerThreadCount(), workLimit));
      expect(report.workerPool?.tasksSubmitted).toBe(fileCount);
      expect(report.workerPool?.tasksFailed).toBe(0);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["full", "incremental"] as const)("sizes the %s pool from parse-miss bytes", async (mode) => {
    const parallelism = vi.spyOn(os, "availableParallelism").mockReturnValue(8);
    const root = await makeProject(100, ".ts", 16 * 1024);
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-pool-sizing-heavy-cache-"));
    try {
      const report: BuildReport = { timings: {} };
      if (mode === "full") {
        await buildProjectIndexFromFiles(root, filesIn(root, 100), { cache: "off", report });
      } else {
        await buildProjectIndexIncremental(root, { cache: "disk", cacheDir, report });
      }
      expect(report.workerPool?.threads).toBe(4);
      expect(report.workerPool?.tasksSubmitted).toBe(100);
      expect(report.workerPool?.tasksFailed).toBe(0);
    } finally {
      parallelism.mockRestore();
      await Promise.all([
        fsp.rm(root, { recursive: true, force: true }),
        fsp.rm(cacheDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("sizes a warm incremental update from the bytes of changed files", async () => {
    const parallelism = vi.spyOn(os, "availableParallelism").mockReturnValue(8);
    const root = await makeProject(100);
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-pool-sizing-incremental-cache-"));
    try {
      await buildProjectIndexIncremental(root, { cache: "disk", cacheDir });
      const padding = `\n/*${"x".repeat(16 * 1024)}*/\n`;
      await Promise.all(
        filesIn(root, 100).map((file, index) =>
          fsp.writeFile(file, `export const value${index} = ${index + 1000};\n${padding}`, "utf8"),
        ),
      );
      const report: BuildReport = { timings: {} };
      await buildProjectIndexIncremental(root, { cache: "disk", cacheDir, report });
      expect(report.manifest?.reused).toBe(true);
      expect(report.files?.changed).toBe(100);
      expect(report.workerPool?.threads).toBe(4);
      expect(report.workerPool?.tasksSubmitted).toBe(100);
      expect(report.workerPool?.tasksFailed).toBe(0);
    } finally {
      parallelism.mockRestore();
      await Promise.all([
        fsp.rm(root, { recursive: true, force: true }),
        fsp.rm(cacheDir, { recursive: true, force: true }),
      ]);
    }
  });

  it.each([
    { name: "automatic", useNativeWorkers: undefined, nativeThreads: undefined },
    { name: "forced", useNativeWorkers: true, nativeThreads: undefined },
    { name: "two explicit workers", useNativeWorkers: true, nativeThreads: 2 },
  ])("keeps the $name queue large enough for 16 build tasks", async ({ useNativeWorkers, nativeThreads }) => {
    const root = await makeProject(150);
    try {
      const report: BuildReport = { timings: {} };
      await buildProjectIndexFromFiles(root, filesIn(root, 150), {
        cache: "off",
        threads: 16,
        ...(useNativeWorkers === undefined ? {} : { useNativeWorkers }),
        ...(nativeThreads === undefined ? {} : { nativeThreads }),
        report,
      });
      const expectedThreads = nativeThreads ?? Math.min(defaultNativeWorkerThreadCount(), 2);
      expect(report.workerPool?.threads).toBe(expectedThreads);
      expect(report.workerPool?.tasksSubmitted).toBe(150);
      expect(report.workerPool?.tasksFailed).toBe(0);
      expect(report.workerPool?.errors ?? []).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["full", "incremental"] as const)("excludes cached source bytes when sizing a %s pool", async (mode) => {
    const parallelism = vi.spyOn(os, "availableParallelism").mockReturnValue(8);
    const root = await makeProject(100, ".ts", 16 * 1024);
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-pool-sizing-partial-cache-"));
    const files = filesIn(root, 100);
    try {
      if (mode === "full") {
        await buildProjectIndexFromFiles(root, files, { cache: "disk", cacheDir });
      } else {
        await buildProjectIndexIncremental(root, { cache: "disk", cacheDir });
      }
      await Promise.all(
        files.slice(0, 32).map((file, index) => fsp.writeFile(file, `export const value${index} = ${index};\n`)),
      );
      const report: BuildReport = { timings: {} };
      if (mode === "full") {
        await buildProjectIndexFromFiles(root, files, { cache: "disk", cacheDir, report });
      } else {
        await buildProjectIndexIncremental(root, { cache: "disk", cacheDir, report });
      }
      expect(report.workerPool?.threads).toBe(2);
      expect(report.workerPool?.tasksSubmitted).toBe(32);
      expect(report.workerPool?.tasksFailed).toBe(0);
    } finally {
      parallelism.mockRestore();
      await Promise.all([
        fsp.rm(root, { recursive: true, force: true }),
        fsp.rm(cacheDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("honors an explicit native thread count above the automatic work limit", async () => {
    const root = await makeProject(3);
    try {
      const report: BuildReport = { timings: {} };
      await buildProjectIndexFromFiles(root, filesIn(root, 3), {
        cache: "off",
        useNativeWorkers: true,
        nativeThreads: 3,
        report,
      });
      expect(report.workerPool?.threads).toBe(3);
      expect(report.workerPool?.tasksSubmitted).toBe(3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

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
