import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";

export type CompileCacheEnableResult = {
  status: number;
  message?: string;
  directory?: string;
};

type EnableCompileCacheFn = {
  (directory?: string): CompileCacheEnableResult;
  (options: { directory?: string; portable?: boolean }): CompileCacheEnableResult;
};

/**
 * Per-user codegraph cache root (not project-local `.codegraph/` /
 * `.codegraph-cache/`), so V8 compile cache never enters discovery.
 */
export function resolveCodegraphUserCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return path.join(localAppData, "codegraph");
    }
    return path.join(homedir, "AppData", "Local", "codegraph");
  }

  const xdgCacheHome = env.XDG_CACHE_HOME?.trim();
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, "codegraph");
  }
  return path.join(homedir, ".cache", "codegraph");
}

/**
 * Per-user Codegraph state root. Long-lived server lifecycle records live here,
 * separate from replaceable package files and disposable compiler cache data.
 */
export function resolveCodegraphUserStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return path.join(localAppData, "codegraph");
    }
    return path.join(homedir, "AppData", "Local", "codegraph");
  }

  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) {
    return path.join(xdgStateHome, "codegraph");
  }
  return path.join(homedir, ".local", "state", "codegraph");
}

export function resolveCliCompileCacheDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.NODE_COMPILE_CACHE?.trim();
  if (override) {
    return override;
  }
  return path.join(resolveCodegraphUserCacheRoot(env, homedir, platform), "compile-cache");
}

/**
 * Enable Node's module compile cache as early as possible. Failures are
 * non-fatal: the CLI must still run when the cache directory is unusable.
 */
export function enableCliCompileCache(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): CompileCacheEnableResult | null {
  try {
    const enableCompileCache = module.enableCompileCache as EnableCompileCacheFn | undefined;
    if (typeof enableCompileCache !== "function") {
      return null;
    }

    // Explicit opt-out: do not call enableCompileCache() at all. Passing no
    // directory can still arm Node's default temp cache.
    if (env.NODE_DISABLE_COMPILE_CACHE === "1") {
      return null;
    }

    const directory = resolveCliCompileCacheDirectory(env, homedir, platform);
    if (!env.NODE_COMPILE_CACHE?.trim()) {
      fs.mkdirSync(directory, { recursive: true });
    }

    // Node 24+ accepts `{ directory, portable }` (path-independent cache keys).
    // Node 22 (engines minimum) only accepts a string cacheDir and throws
    // "cacheDir should be a string" for the options object — fall back.
    try {
      return enableCompileCache({ directory, portable: true });
    } catch {
      return enableCompileCache(directory);
    }
  } catch {
    return null;
  }
}
