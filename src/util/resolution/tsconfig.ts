import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createMatchPath } from "tsconfig-paths";
import { logWithLevel, type LogLevel } from "../../logging.js";
import { parseJsonc } from "../comments.js";
import { fileExists } from "../workspace.js";

export type MatchPathFn = ReturnType<typeof createMatchPath>;

const tsconfigCache = new Map<string, { matchPath?: MatchPathFn }>();

async function findNearestTsconfig(startFromFile: string): Promise<string | null> {
  let dir = path.dirname(startFromFile);
  while (true) {
    const cand = path.join(dir, "tsconfig.json");
    try {
      await fsp.access(cand, fs.constants.R_OK);
      return cand;
    } catch {
      /* file not found: continue up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
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
    spec.startsWith(".") ||
    path.posix.isAbsolute(spec) ||
    path.win32.isAbsolute(spec) ||
    /^[A-Za-z]:[\\/]/.test(spec)
  );
}

function localExtendsCandidates(cfgDir: string, spec: string): string[] {
  const basePath = path.resolve(cfgDir, spec);
  if (basePath.endsWith(".json")) {
    return [basePath];
  }
  return [basePath, `${basePath}.json`, path.join(basePath, "tsconfig.json")];
}

async function resolveTsconfigExtendsPath(cfgDir: string, spec: string): Promise<string | null> {
  if (isPathLikeExtendsSpecifier(spec)) {
    for (const candidate of localExtendsCandidates(cfgDir, spec)) {
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  try {
    const requireFromConfig = createRequire(path.join(cfgDir, "tsconfig.json"));
    return requireFromConfig.resolve(spec);
  } catch {
    return null;
  }
}

async function loadTsconfigConfig(
  cfgPath: string,
  seen: Set<string> = new Set(),
): Promise<{ baseUrl: string; paths: Record<string, string[]> }> {
  const normalizedCfgPath = path.resolve(cfgPath);
  if (seen.has(normalizedCfgPath)) {
    return { baseUrl: path.dirname(normalizedCfgPath).replace(/\\/g, "/"), paths: {} };
  }
  seen.add(normalizedCfgPath);

  const raw = await fsp.readFile(cfgPath, "utf8");
  const json = parseJsonc<TsconfigJson>(raw);
  const cfgDir = path.dirname(cfgPath);
  const co = json.compilerOptions;
  const baseUrlRaw = co?.baseUrl ?? ".";
  const baseUrl = path.isAbsolute(baseUrlRaw) ? baseUrlRaw : path.resolve(cfgDir, baseUrlRaw);
  const paths: Record<string, string[]> = co?.paths ?? {};

  if (json.extends) {
    const extendsPath = await resolveTsconfigExtendsPath(cfgDir, json.extends);
    if (extendsPath) {
      const parent = await loadTsconfigConfig(extendsPath, seen);
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

export async function loadNearestTsconfigFor(file: string, logLevel?: LogLevel): Promise<{ matchPath?: MatchPathFn }> {
  const dir = path.dirname(file);
  if (tsconfigCache.has(dir)) return tsconfigCache.get(dir)!;

  const cfgPath = await findNearestTsconfig(file);
  if (!cfgPath) {
    tsconfigCache.set(dir, {});
    return {};
  }

  try {
    const { baseUrl, paths } = await loadTsconfigConfig(cfgPath);
    const matchPath = createMatchPath(baseUrl, paths);
    const val = { matchPath };
    tsconfigCache.set(dir, val);
    return val;
  } catch (error) {
    logWithLevel(logLevel, "warn", `Warning: Failed to load tsconfig at ${cfgPath}:`, error);
    const val = {};
    tsconfigCache.set(dir, val);
    return val;
  }
}

export function clearTsconfigCache(): void {
  tsconfigCache.clear();
}
