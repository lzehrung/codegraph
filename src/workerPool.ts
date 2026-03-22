import fs from "node:fs";
import { fileURLToPath } from "node:url";

import type { ProcessFileResult, ProcessFileTask } from "./workerTypes.js";

type WorkerPool = {
  run(task: ProcessFileTask): Promise<ProcessFileResult>;
};

type WorkerPoolConstructor = new (options: {
  filename: string;
  maxThreads: number;
}) => WorkerPool;

const workerPools = new Map<number, WorkerPool>();

function resolveWorkerEntrypoint(): { filename: string } | null {
  const jsPath = fileURLToPath(new URL("./worker.js", import.meta.url));
  if (fs.existsSync(jsPath)) {
    return { filename: jsPath };
  }
  return null;
}

function isWorkerPoolModule(
  value: unknown,
): value is { default: WorkerPoolConstructor } {
  if (!value || typeof value !== "object") return false;
  const maybeDefault = (value as { default?: unknown }).default;
  return typeof maybeDefault === "function";
}

export function workerPoolAvailable(): boolean {
  return resolveWorkerEntrypoint() !== null;
}

async function getWorkerPool(maxThreads: number): Promise<WorkerPool> {
  const existing = workerPools.get(maxThreads);
  if (existing) return existing;
  const entrypoint = resolveWorkerEntrypoint();
  if (!entrypoint) {
    throw new Error("Worker pool is only available from built JavaScript output");
  }
  const piscinaModule = await import("piscina");
  if (!isWorkerPoolModule(piscinaModule)) {
    throw new Error("Failed to load Piscina worker pool");
  }
  const PiscinaCtor = piscinaModule.default;
  const pool = new PiscinaCtor({
    filename: entrypoint.filename,
    maxThreads,
  });
  workerPools.set(maxThreads, pool);
  return pool;
}

export async function processFileInWorker(
  task: ProcessFileTask,
  maxThreads: number,
): Promise<ProcessFileResult> {
  const pool = await getWorkerPool(maxThreads);
  return pool.run(task);
}
