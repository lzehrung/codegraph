import os from "node:os";

export type WorkerThreadCountOptions = {
  /** Explicit request (e.g. a --threads flag). Values <= 0 or non-finite are treated as unset. */
  requested?: number | undefined;
  /** Fixed default when no request is given; omit to size from availableParallelism() - 1. */
  defaultCount?: number | undefined;
  /** Upper bound. Defaults to 64. */
  max?: number | undefined;
};

/** Single worker-pool sizing policy: explicit request wins, else the configured default,
 * else availableParallelism() - 1; always clamped to [1, max]. */
export function resolveWorkerThreadCount(options?: WorkerThreadCountOptions): number {
  const max = options?.max ?? 64;
  const requested = options?.requested;
  if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.max(Math.floor(requested), 1), max);
  }
  const defaultCount = options?.defaultCount;
  if (typeof defaultCount === "number" && Number.isFinite(defaultCount) && defaultCount > 0) {
    return Math.min(Math.max(Math.floor(defaultCount), 1), max);
  }
  return Math.min(Math.max(os.availableParallelism() - 1, 1), max);
}
