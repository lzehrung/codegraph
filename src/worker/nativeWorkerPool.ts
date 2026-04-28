import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { Piscina } from "piscina";

import type {
  NativeExtractTask,
  NativeExtractResult,
} from "./nativeExtractWorker.js";

export type { NativeExtractTask, NativeExtractResult };

export type NativeWorkerPoolOptions = {
  threads?: number | undefined;
  maxQueue?: number | undefined;
};

const DEFAULT_MAX_THREADS = 8;

function resolveThreadCount(requested?: number): number {
  const cpus = os.cpus().length;
  if (requested && requested > 0) {
    return Math.min(requested, 64);
  }
  return Math.min(Math.max(cpus - 1, 1), DEFAULT_MAX_THREADS);
}

function resolveWorkerPath(): string {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  // When running from dist/, the sibling .js file exists directly
  const sibling = path.resolve(selfDir, "nativeExtractWorker.js");
  if (fs.existsSync(sibling)) return sibling;
  // When running from src/ under Vitest or other transformed loaders,
  // the real project cwd is a more stable anchor than import.meta.url.
  const cwdDistWorker = path.resolve(
    process.cwd(),
    "dist",
    "worker",
    "nativeExtractWorker.js",
  );
  if (fs.existsSync(cwdDistWorker)) return cwdDistWorker;
  // When running from src/ (e.g. vitest), resolve to the compiled dist/ worker
  const projectRoot = path.resolve(selfDir, "../..");
  const distWorker = path.resolve(
    projectRoot,
    "dist",
    "worker",
    "nativeExtractWorker.js",
  );
  if (fs.existsSync(distWorker)) return distWorker;
  throw new Error(
    `Native worker file not found. Expected at "${sibling}", "${cwdDistWorker}", or "${distWorker}". ` +
      `Ensure the project has been built (dist/worker/nativeExtractWorker.js).`,
  );
}

export function createNativeWorkerPool(
  opts?: NativeWorkerPoolOptions,
): Piscina {
  const threads = resolveThreadCount(opts?.threads);
  const workerPath = resolveWorkerPath();
  return new Piscina({
    filename: workerPath,
    minThreads: threads,
    maxThreads: threads,
    maxQueue: opts?.maxQueue ?? threads * 4,
    idleTimeout: 30_000,
  });
}
