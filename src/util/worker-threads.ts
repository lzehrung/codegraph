import os from "node:os";

export type WorkerThreadCountOptions = {
  /** Explicit request (e.g. a --threads flag). Values <= 0 or non-finite are treated as unset. */
  requested?: number | undefined;
  /** Fixed default when no request is given; omit to size from availableParallelism() - 1. */
  defaultCount?: number | undefined;
  /** Positive integer upper bound. Defaults to 64; invalid values throw. */
  max?: number | undefined;
};

/** Single worker-pool sizing policy: explicit request wins, else the configured default,
 * else availableParallelism() - 1; always clamped to [1, max]. */
export function resolveWorkerThreadCount(options?: WorkerThreadCountOptions): number {
  const max = options?.max ?? 64;
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError("Worker thread maximum must be a positive integer.");
  }
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

const NO_REQUIRE_ESM_FLAG = "--no-experimental-require-module";

/**
 * `execArgv` for the worker threads of a Piscina pool. Piscina's worker calls `require()` on its task module before
 * it falls back to `import()`, and this package's workers are ES modules, so on Node 22 that first load runs through
 * `require(esm)`. Terminating a worker thread while it is in that load aborts the whole process on Node 22.16
 * (`FATAL ERROR: v8::Module::IsGraphAsync must be used on an instantiated module`), and `pool.destroy()` terminates
 * every worker that has not finished starting. With `require(esm)` off, the `require()` fails at once and the
 * `import()` after it can be interrupted safely. An explicit `execArgv` replaces the options that a worker inherits.
 */
export function piscinaWorkerExecArgv(): string[] {
  return process.allowedNodeEnvironmentFlags.has(NO_REQUIRE_ESM_FLAG) ? [NO_REQUIRE_ESM_FLAG] : [...process.execArgv];
}
