import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createMatchPath } from "tsconfig-paths";
import { logWithLevel, type LogLevel } from "../../logging.js";
import { parseJsonc } from "../comments.js";
import { fileIdentityKey, isFilePathWithinRoot } from "../paths.js";
import { fileExists } from "../workspace.js";

export type MatchPathFn = ReturnType<typeof createMatchPath>;

const tsconfigCache = new Map<string, { matchPath?: MatchPathFn }>();

async function findNearestTsconfig(startFromFile: string, projectRoot: string): Promise<string | null> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const projectRootKey = fileIdentityKey(resolvedProjectRoot);
  let dir = path.dirname(startFromFile);
  while (isFilePathWithinRoot(resolvedProjectRoot, dir)) {
    const candidate = path.join(dir, "tsconfig.json");
    try {
      await fsp.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      /* file not found: continue up */
    }
    if (fileIdentityKey(dir) === projectRootKey) break;
    const parent = path.dirname(dir);
    if (!isFilePathWithinRoot(resolvedProjectRoot, parent)) break;
    dir = parent;
  }
  return null;
}

interface TsconfigCompilerOptions {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

interface TsconfigJson {
  compilerOptions?: TsconfigCompilerOptions;
  extends?: string;
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

  const raw = await fsp.readFile(cfgPath, "utf8");
  const json = parseJsonc<TsconfigJson>(raw);
  const cfgDir = path.dirname(cfgPath);
  const co = json.compilerOptions;
  const baseUrlRaw = co?.baseUrl ?? ".";
  const baseUrl = path.isAbsolute(baseUrlRaw) ? baseUrlRaw : path.resolve(cfgDir, baseUrlRaw);
  const paths: Record<string, string[]> = co?.paths ?? {};

  if (json.extends) {
    const extendsPath = await resolveTsconfigExtendsPath(cfgDir, json.extends, projectRoot);
    if (extendsPath) {
      const parent = await loadTsconfigConfig(extendsPath, projectRoot, seen);
      const mergedPaths: Record<string, string[]> = { ...parent.paths };

      for (const [key, patterns] of Object.entries(parent.paths)) {
        mergedPaths[key] = patterns.map((p) => {
          const abs = path.resolve(parent.baseUrl, p);
          const rel = path.relative(baseUrl, abs).replace(/\\/g, "/");
          return rel;
        });
      }

      for (const [key, patterns] of Object.entries(paths)) {
        mergedPaths[key] = patterns.map((p) => p.replace(/\\/g, "/"));
      }
      return { baseUrl: baseUrl.replace(/\\/g, "/"), paths: mergedPaths };
    }
  }

  const normalizedPaths: Record<string, string[]> = {};
  for (const [key, patterns] of Object.entries(paths)) {
    normalizedPaths[key] = patterns.map((p) => p.replace(/\\/g, "/"));
  }

  return { baseUrl: baseUrl.replace(/\\/g, "/"), paths: normalizedPaths };
}

export async function loadNearestTsconfigFor(
  file: string,
  projectRoot: string,
  logLevel?: LogLevel,
): Promise<{ matchPath?: MatchPathFn }> {
  const dir = path.dirname(file);
  const cacheKey = `${fileIdentityKey(path.resolve(projectRoot))}::${fileIdentityKey(path.resolve(dir))}`;
  const cached = tsconfigCache.get(cacheKey);
  if (cached) return cached;

  const cfgPath = await findNearestTsconfig(file, projectRoot);
  if (!cfgPath) {
    const val = {};
    tsconfigCache.set(cacheKey, val);
    return val;
  }

  try {
    const { baseUrl, paths } = await loadTsconfigConfig(cfgPath, projectRoot);
    const matchPath = createMatchPath(baseUrl, paths);
    const val = { matchPath };
    tsconfigCache.set(cacheKey, val);
    return val;
  } catch (error) {
    logWithLevel(logLevel, "warn", `Warning: Failed to load tsconfig at ${cfgPath}:`, error);
    const val = {};
    tsconfigCache.set(cacheKey, val);
    return val;
  }
}

export function clearTsconfigCache(): void {
  tsconfigCache.clear();
}
