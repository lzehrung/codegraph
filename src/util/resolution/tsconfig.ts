import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  createMatchPath,
  createMatchPathAsync,
  type FileExistsAsync,
  type MatchPathAsync,
  type ReadJsonAsync,
} from "tsconfig-paths";
import { logWithLevel, type LogLevel } from "../../logging.js";
import { parseJsonc } from "../comments.js";
import { currentProbeCache } from "../fs-probe-cache.js";
import { fileIdentityKey, isFilePathWithinRoot, stripBom } from "../paths.js";
import { fileExists } from "../workspace.js";

export type MatchPathFn = ReturnType<typeof createMatchPath>;

/**
 * Each matcher `loadNearestTsconfigFor` makes is paired with an asynchronous twin built from the same
 * `baseUrl` and `paths`, and with a key for those two inputs. The twin runs the same candidate search through
 * the build's probe cache. The key lets files whose configs resolve alike share one resolution.
 */
type MatchPathResolver = { scopeKey: string; matchAsync: MatchPathAsync };
const matchPathResolvers = new WeakMap<MatchPathFn, MatchPathResolver>();
const anonymousMatchPathKeys = new WeakMap<MatchPathFn, string>();
let anonymousMatchPathCount = 0;
const requireJson = createRequire(import.meta.url);

type TsconfigResolutionInputs = {
  configFile: string;
  baseUrl: string;
  paths: Record<string, string[]>;
};

type CachedTsconfig = {
  result: { matchPath?: MatchPathFn };
  inputs?: TsconfigResolutionInputs;
};

const tsconfigCache = new Map<string, CachedTsconfig>();
const resolvedTsconfigCache = new Map<string, Promise<CachedTsconfig>>();

async function findNearestTsconfig(startFromFile: string, projectRoot: string): Promise<string | null> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const projectRootKey = fileIdentityKey(resolvedProjectRoot);
  let dir = path.dirname(startFromFile);
  while (isFilePathWithinRoot(resolvedProjectRoot, dir)) {
    const candidate = path.join(dir, "tsconfig.json");
    if (await fileExists(candidate)) return candidate;
    if (fileIdentityKey(dir) === projectRootKey) break;
    const parent = path.dirname(dir);
    if (!isFilePathWithinRoot(resolvedProjectRoot, parent)) break;
    dir = parent;
  }
  return null;
}

interface TsconfigCompilerOptions {
  baseUrl?: unknown;
  paths?: unknown;
}

interface TsconfigJson {
  compilerOptions?: TsconfigCompilerOptions;
  extends?: unknown;
}

function sanitizeTsconfigPaths(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const paths: Record<string, string[]> = {};
  for (const [key, patterns] of Object.entries(value)) {
    if (!Array.isArray(patterns) || !patterns.every((pattern) => typeof pattern === "string")) continue;
    paths[key] = patterns;
  }
  return paths;
}

function isPathLikeExtendsSpecifier(spec: string): boolean {
  return (
    spec.startsWith(".") || path.posix.isAbsolute(spec) || path.win32.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)
  );
}

function localExtendsCandidates(cfgDir: string, spec: string): string[] {
  const basePath = path.resolve(cfgDir, spec);
  if (basePath.endsWith(".json")) {
    return [basePath];
  }
  return [basePath, `${basePath}.json`, path.join(basePath, "tsconfig.json")];
}

async function resolveTsconfigExtendsPath(cfgDir: string, spec: string, projectRoot: string): Promise<string | null> {
  if (isPathLikeExtendsSpecifier(spec)) {
    for (const candidate of localExtendsCandidates(cfgDir, spec)) {
      if (isFilePathWithinRoot(projectRoot, candidate) && (await fileExists(candidate))) {
        return candidate;
      }
    }
    return null;
  }

  try {
    const requireFromConfig = createRequire(path.join(cfgDir, "tsconfig.json"));
    const resolved = requireFromConfig.resolve(spec);
    return isFilePathWithinRoot(projectRoot, resolved) ? resolved : null;
  } catch {
    return null;
  }
}

async function loadTsconfigConfig(
  cfgPath: string,
  projectRoot: string,
  seen: Set<string> = new Set(),
): Promise<{ baseUrl: string; paths: Record<string, string[]> }> {
  const normalizedCfgPath = path.resolve(cfgPath);
  if (!isFilePathWithinRoot(projectRoot, normalizedCfgPath)) {
    return { baseUrl: path.resolve(projectRoot).replace(/\\/g, "/"), paths: {} };
  }
  const cfgKey = fileIdentityKey(normalizedCfgPath);
  if (seen.has(cfgKey)) {
    return { baseUrl: path.dirname(normalizedCfgPath).replace(/\\/g, "/"), paths: {} };
  }
  seen.add(cfgKey);

  const raw = stripBom(await fsp.readFile(cfgPath, "utf8"));
  const json = parseJsonc<TsconfigJson>(raw);
  const cfgDir = path.dirname(cfgPath);
  const compilerOptions = json.compilerOptions;
  const baseUrlRaw = compilerOptions?.baseUrl;
  let ownBaseUrl: string | null = null;
  if (typeof baseUrlRaw === "string") {
    ownBaseUrl = path.isAbsolute(baseUrlRaw) ? baseUrlRaw : path.resolve(cfgDir, baseUrlRaw);
  }
  const paths = sanitizeTsconfigPaths(compilerOptions?.paths);

  if (typeof json.extends === "string") {
    const extendsPath = await resolveTsconfigExtendsPath(cfgDir, json.extends, projectRoot);
    if (extendsPath) {
      const parent = await loadTsconfigConfig(extendsPath, projectRoot, seen);
      const baseUrl = ownBaseUrl ?? parent.baseUrl;
      const mergedPaths: Record<string, string[]> = { ...parent.paths };

      if (ownBaseUrl) {
        for (const [key, patterns] of Object.entries(parent.paths)) {
          mergedPaths[key] = patterns.map((pattern) =>
            path.relative(baseUrl, path.resolve(parent.baseUrl, pattern)).replace(/\\/g, "/"),
          );
        }
      }
      for (const [key, patterns] of Object.entries(paths)) {
        mergedPaths[key] = patterns.map((pattern) => pattern.replace(/\\/g, "/"));
      }
      return { baseUrl: baseUrl.replace(/\\/g, "/"), paths: mergedPaths };
    }
  }

  const baseUrl = ownBaseUrl ?? cfgDir;

  const normalizedPaths: Record<string, string[]> = {};
  for (const [key, patterns] of Object.entries(paths)) {
    normalizedPaths[key] = patterns.map((p) => p.replace(/\\/g, "/"));
  }

  return { baseUrl: baseUrl.replace(/\\/g, "/"), paths: normalizedPaths };
}

async function loadTsconfigFor(file: string, projectRoot: string, logLevel?: LogLevel): Promise<CachedTsconfig> {
  const dir = path.dirname(file);
  const cacheKey = `${fileIdentityKey(path.resolve(projectRoot))}::${fileIdentityKey(path.resolve(dir))}`;
  const cached = tsconfigCache.get(cacheKey);
  if (cached) return cached;

  const cfgPath = await findNearestTsconfig(file, projectRoot);
  if (!cfgPath) {
    const val = { result: {} };
    tsconfigCache.set(cacheKey, val);
    return val;
  }

  const configKey = `${fileIdentityKey(path.resolve(projectRoot))}::${fileIdentityKey(cfgPath)}`;
  let pending = resolvedTsconfigCache.get(configKey);
  if (!pending) {
    pending = createTsconfigResolution(cfgPath, projectRoot, logLevel);
    resolvedTsconfigCache.set(configKey, pending);
  }
  const val = await pending;
  tsconfigCache.set(cacheKey, val);
  return val;
}

/**
 * The key of a matcher's inputs: a digest of its `baseUrl` and `paths`. Matchers with equal inputs share a key and
 * different inputs never do, whichever configs were read before, so no table of keys grows in a long-lived process.
 */
function matchPathInputsKey(baseUrl: string, paths: Record<string, string[]>): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([baseUrl, Object.entries(paths)]))
    .digest("hex");
  return `config${digest.slice(0, 32)}`;
}

async function createTsconfigResolution(
  cfgPath: string,
  projectRoot: string,
  logLevel?: LogLevel,
): Promise<CachedTsconfig> {
  try {
    const { baseUrl, paths } = await loadTsconfigConfig(cfgPath, projectRoot);
    const matchPath = createMatchPath(baseUrl, paths);
    matchPathResolvers.set(matchPath, {
      scopeKey: matchPathInputsKey(baseUrl, paths),
      matchAsync: createMatchPathAsync(baseUrl, paths),
    });
    return { result: { matchPath }, inputs: { configFile: cfgPath, baseUrl, paths } };
  } catch (error) {
    logWithLevel(logLevel, "warn", `Warning: Failed to load tsconfig at ${cfgPath}:`, error);
    return { result: {} };
  }
}

export async function loadNearestTsconfigFor(
  file: string,
  projectRoot: string,
  logLevel?: LogLevel,
): Promise<{ matchPath?: MatchPathFn }> {
  return (await loadTsconfigFor(file, projectRoot, logLevel)).result;
}

export async function loadTsconfigResolutionInputsFor(
  file: string,
  projectRoot: string,
  logLevel?: LogLevel,
): Promise<TsconfigResolutionInputs | undefined> {
  return (await loadTsconfigFor(file, projectRoot, logLevel)).inputs;
}

/**
 * The inputs that decide what `matchPath` resolves: the `baseUrl` and `paths` it was made from. Matchers made
 * from equal inputs share a key. A matcher made elsewhere has a key of its own, so it never shares a result
 * with one made from a config.
 */
export function matchPathScopeKey(matchPath: MatchPathFn | undefined): string {
  if (!matchPath) return "none";
  const registered = matchPathResolvers.get(matchPath);
  if (registered) return registered.scopeKey;
  let key = anonymousMatchPathKeys.get(matchPath);
  if (key === undefined) {
    anonymousMatchPathCount += 1;
    key = `custom${anonymousMatchPathCount}`;
    anonymousMatchPathKeys.set(matchPath, key);
  }
  return key;
}

function statIsFileSync(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The path `matchPath` returns for `spec`: the first candidate under the config's `baseUrl` and `paths` that
 * is a file inside the project root.
 *
 * Inside a build the candidates are answered by the build's probe cache. Outside a build, for a matcher not
 * made by `loadNearestTsconfigFor`, and for an empty extension list (the library's asynchronous search then
 * ends on a `package.json` probe and reads past its candidate list), `matchPath` runs as it is.
 */
export async function matchMappedSpecifier(
  matchPath: MatchPathFn,
  spec: string,
  projectRoot: string,
  resolutionExtensions: readonly string[],
): Promise<string | undefined> {
  const probes = currentProbeCache();
  const resolver = matchPathResolvers.get(matchPath);
  if (!probes || !resolver || !resolutionExtensions.length) {
    return matchPath(
      spec,
      undefined,
      (candidate: string) => isFilePathWithinRoot(projectRoot, candidate) && statIsFileSync(candidate),
      resolutionExtensions,
    );
  }
  const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
  // A throw inside the library's continuation would otherwise escape as an unhandled rejection.
  const guard = (continuation: () => void): void => {
    try {
      continuation();
    } catch (error) {
      reject(toError(error));
    }
  };
  // A candidate outside the project root is rejected without a probe, as the standalone search does.
  const fileExistsAsync: FileExistsAsync = (candidate, callback) => {
    const kind = isFilePathWithinRoot(projectRoot, candidate) ? probes.kind(candidate) : Promise.resolve(null);
    void kind.then((found) => {
      guard(() => callback(undefined, found === "file"));
    }, reject);
  };
  // `matchPath` reads a package.json with `require` when it exists, and so does this.
  const readJsonAsync: ReadJsonAsync = (jsonPath, callback) => {
    void probes.kind(jsonPath).then((kind) => {
      guard(() => {
        if (kind === null) {
          callback();
          return;
        }
        let content: unknown;
        try {
          content = requireJson(jsonPath);
        } catch (error) {
          callback(toError(error));
          return;
        }
        callback(undefined, content);
      });
    }, reject);
  };
  guard(() => {
    resolver.matchAsync(spec, readJsonAsync, fileExistsAsync, resolutionExtensions, (error, found) => {
      if (error) reject(error);
      else resolve(found);
    });
  });
  return await promise;
}

export function clearTsconfigCache(): void {
  tsconfigCache.clear();
  resolvedTsconfigCache.clear();
}
