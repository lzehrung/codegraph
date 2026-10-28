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
const REQUIRE_ESM_FLAGS = ["--experimental-require-module", NO_REQUIRE_ESM_FLAG];

/**
 * Host options that a worker thread must keep, so that it loads code the way its host does: preloads, resolution
 * conditions, loaders, source maps, warning policy, and the module-loading feature switches. Node accepts only some
 * options in a worker's `execArgv` and throws `ERR_WORKER_INVALID_EXEC_ARGV` for the rest. Node 22.16 and 24.15 both
 * reject every V8 option (`--max-old-space-size`, `--stack-trace-limit`, `--expose-gc`, `--jitless`, ...) and every
 * process-wide option (`--title`, `--openssl-config`, `--icu-data-dir`, `--report-on-fatalerror`, ...), and they
 * reject `--cpu-prof-dir` and `--experimental-default-type`. A worker that is started with `--inspect-brk` or
 * `--inspect-wait` stops until a debugger attaches, and `--cpu-prof` writes a profile per worker. Which options Node
 * accepts changes between versions and `process.allowedNodeEnvironmentFlags` does not tell (it lists the rejected
 * V8 and process-wide options too), so an option that is not listed here is not passed on, and an unknown future
 * option can never make pool creation throw. Every listed option was started in a worker on Node 22.16 and 24.15.
 */
const WORKER_INHERITED_FLAGS: Record<string, true> = {
  "--require": true,
  "-r": true,
  "--import": true,
  "--conditions": true,
  "-C": true,
  "--loader": true,
  "--experimental-loader": true,
  "--enable-source-maps": true,
  "--warnings": true,
  "--no-warnings": true,
  "--deprecation": true,
  "--no-deprecation": true,
  "--trace-deprecation": true,
  "--throw-deprecation": true,
  "--pending-deprecation": true,
  "--trace-warnings": true,
  "--disable-warning": true,
  "--preserve-symlinks": true,
  "--preserve-symlinks-main": true,
  "--experimental-vm-modules": true,
  "--experimental-strip-types": true,
  "--experimental-transform-types": true,
  "--experimental-detect-module": true,
  "--no-experimental-detect-module": true,
  "--experimental-import-meta-resolve": true,
  "--experimental-require-module": true,
  "--no-experimental-require-module": true,
};

/** The option name of an `execArgv` or `NODE_OPTIONS` token as Node reads it: without an `=value` part, and with `_`
 * in a long option name read as `-` (`--experimental_require_module=true` is `--experimental-require-module`). */
function optionName(token: string): string {
  const name = token.split("=", 1)[0] ?? token;
  return name.startsWith("--") ? `--${name.slice(2).replaceAll("_", "-")}` : name;
}

/** Keeps the options of `execArgv` that a worker thread accepts and needs. An option owns the value tokens (those
 * that do not start with `-`) that follow it, as in `--require ./preload.cjs`. */
function inheritableExecArgv(execArgv: readonly string[]): string[] {
  const kept: string[] = [];
  let keeping = false;
  for (const token of execArgv) {
    if (token.startsWith("-")) {
      const name = optionName(token);
      keeping = Object.hasOwn(WORKER_INHERITED_FLAGS, name) && process.allowedNodeEnvironmentFlags.has(name);
    }
    if (keeping) kept.push(token);
  }
  return kept;
}

/** Splits `NODE_OPTIONS` the way Node does: tokens are separated by spaces, and a double-quoted part may hold spaces
 * and escape a character with a backslash. */
function nodeOptionsTokens(nodeOptions: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let pending = false;
  for (let i = 0; i < nodeOptions.length; i += 1) {
    const char = nodeOptions[i] as string;
    if (inQuotes && char === "\\" && i + 1 < nodeOptions.length) {
      i += 1;
      current += nodeOptions[i];
    } else if (char === '"') {
      inQuotes = !inQuotes;
      pending = true;
    } else if (char === " " && !inQuotes) {
      if (pending || current) tokens.push(current);
      current = "";
      pending = false;
    } else {
      current += char;
    }
  }
  if (pending || current) tokens.push(current);
  return tokens;
}

/**
 * `execArgv` for the worker threads of a Piscina pool. Piscina's worker calls `require()` on its task module before
 * it falls back to `import()`, and this package's workers are ES modules, so on Node 22 that first load runs through
 * `require(esm)`. Terminating a worker thread while it is in that load aborts the whole process on Node 22.16
 * (`FATAL ERROR: v8::Module::IsGraphAsync must be used on an instantiated module`), and `pool.destroy()` terminates
 * every worker that has not finished starting. With `require(esm)` off, the `require()` fails at once and the
 * `import()` after it can be interrupted safely.
 *
 * An explicit `execArgv` replaces the command-line options that a worker inherits, so this returns the host's options
 * that {@link WORKER_INHERITED_FLAGS} lists (a host started with `node --require ./preload.cjs` still runs that preload
 * in its workers), followed by `--no-experimental-require-module` when this Node knows it and the host has not chosen
 * a require-module option itself. A worker re-reads `NODE_OPTIONS` from the environment, and its `execArgv` wins over
 * it, so a require-module option in `NODE_OPTIONS` (for a preload that requires an ES module) counts as the host's
 * choice too, and appending the flag then would override it.
 */
export function piscinaWorkerExecArgv(): string[] {
  const execArgv = inheritableExecArgv(process.execArgv);
  const hostChoseRequireEsm = [...execArgv, ...nodeOptionsTokens(process.env.NODE_OPTIONS ?? "")].some((token) =>
    REQUIRE_ESM_FLAGS.includes(optionName(token)),
  );
  if (!hostChoseRequireEsm && process.allowedNodeEnvironmentFlags.has(NO_REQUIRE_ESM_FLAG)) {
    execArgv.push(NO_REQUIRE_ESM_FLAG);
  }
  return execArgv;
}
