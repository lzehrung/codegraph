import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Piscina } from "piscina";
import { resolveWorkerThreadCount } from "../util/workerThreads.js";

import type { NativeExtractTask, NativeExtractResult } from "./nativeExtractWorker.js";

export type { NativeExtractTask, NativeExtractResult };

export type NativeWorkerPoolOptions = {
  threads?: number | undefined;
  maxQueue?: number | undefined;
  /** Upper bound applied after the usual sizing policy, e.g. the number of files to parse. */
  maxThreads?: number | undefined;
  /** Passed through to each worker as node's `workerData`. */
  workerData?: unknown;
};

const HARD_MAX_THREADS = 64;

function resolveThreadCount(requested?: number): number {
  return resolveWorkerThreadCount({ requested, max: HARD_MAX_THREADS });
}

export function resolveNativeWorkerPath(): string {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  // When running from dist/, the sibling .js file exists directly
  const sibling = path.resolve(selfDir, "nativeExtractWorker.js");
  if (fs.existsSync(sibling)) return sibling;
  // When running from src/ (e.g. vitest), resolve to the compiled dist/ worker
  const projectRoot = path.resolve(selfDir, "../..");
  const distWorker = path.resolve(projectRoot, "dist", "worker", "nativeExtractWorker.js");
  if (fs.existsSync(distWorker)) return distWorker;
  throw new Error(
    `Native worker file not found. Expected at "${sibling}" or "${distWorker}". ` +
      `Ensure the project has been built (dist/worker/nativeExtractWorker.js).`,
  );
}

export function createNativeWorkerPool(opts?: NativeWorkerPoolOptions): Piscina {
  const requestedMax = opts?.maxThreads;
  const bounded =
    typeof requestedMax === "number" && Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.floor(requestedMax)
      : HARD_MAX_THREADS;
  const threads = Math.min(resolveThreadCount(opts?.threads), bounded);
  const workerPath = resolveNativeWorkerPath();
  return new Piscina({
    filename: workerPath,
    minThreads: threads,
    maxThreads: threads,
    maxQueue: opts?.maxQueue ?? threads * 4,
    idleTimeout: 30_000,
    ...(opts?.workerData === undefined ? {} : { workerData: opts.workerData }),
  });
}
