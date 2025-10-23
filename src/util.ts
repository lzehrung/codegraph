import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { createMatchPath } from "tsconfig-paths";
import Parser from "tree-sitter";

export type Pos = { line: number; column: number; index: number };
export type Range = { start: Pos; end: Pos };

export function sliceText(node: any, src: string) {
  if (!node || !src) return "";
  return src.slice(node.startIndex, node.endIndex);
}
export function unquote(s: string) {
  if (!s || typeof s !== "string") return s as any;
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith("`") && t.endsWith("`"))
    ? (t.slice(1, -1) as any)
    : (t as any);
}
export function toRange(node: any): Range {
  if (!node) {
    return {
      start: { line: 0, column: 0, index: 0 },
      end: { line: 0, column: 0, index: 0 },
    };
  }
  return {
    start: {
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      index: node.startIndex,
    },
    end: {
      line: node.endPosition.row + 1,
      column: node.endPosition.column + 1,
      index: node.endIndex,
    },
  };
}

export async function listProjectFiles(
  projectRoot: string,
  patterns = ["**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py}"]
) {
  try {
    return await fg(patterns, {
      cwd: projectRoot,
      absolute: true,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/.venv/**",
        "**/__pycache__/**",
      ],
    });
  } catch (error) {
    console.warn(`Warning: Failed to list files in ${projectRoot}:`, error);
    return [] as string[];
  }
}

export function stripJsLikeComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
export function stripPythonCommentsAndStrings(src: string): string {
  let out = src;
  out = out.replace(/([rRuU]?[fF]?)("""|''')[\s\S]*?\2/g, "");
  out = out.replace(/([rRuU]?[fF]?)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, "");
  out = out.replace(/#.*$/gm, "");
  return out;
}

type MatchPathFn = ReturnType<typeof createMatchPath>;
const tsconfigCache = new Map<string, { matchPath?: MatchPathFn }>();

async function findNearestTsconfig(startFromFile: string): Promise<string | null> {
  let dir = path.dirname(startFromFile);
  while (true) {
    const cand = path.join(dir, "tsconfig.json");
    try {
      await fsp.access(cand, fs.constants.R_OK);
      return cand;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function loadNearestTsconfigFor(
  file: string
): Promise<{ matchPath?: MatchPathFn }> {
  const dir = path.dirname(file);
  if (tsconfigCache.has(dir)) return tsconfigCache.get(dir)!;

  const cfgPath = await findNearestTsconfig(file);
  if (!cfgPath) {
    tsconfigCache.set(dir, {});
    return {};
  }

  try {
    const raw = await fsp.readFile(cfgPath, "utf8");
    const json = JSON.parse(raw);
    const baseUrl = path.resolve(
      path.dirname(cfgPath),
      json.compilerOptions?.baseUrl ?? "."
    );
    const paths = json.compilerOptions?.paths as
      | Record<string, string[]>
      | undefined;
    const matchPath = createMatchPath(baseUrl, paths ?? {});
    const val = { matchPath };
    tsconfigCache.set(dir, val);
    return val;
  } catch {
    const val = {} as any;
    tsconfigCache.set(dir, val);
    return val;
  }
}

export async function fileExists(p: string): Promise<boolean> {
  // Simple in-memory cache to avoid repeated fs lookups
  const cached = fileExistsCache.get(p);
  if (cached !== undefined) return cached;
  try {
    await fsp.access(p, fs.constants.R_OK);
    fileExistsCache.set(p, true);
    return true;
  } catch {
    fileExistsCache.set(p, false);
    return false;
  }
}

async function findWorkspaceRoot(startDir: string): Promise<string | null> {
  let dir = startDir;
  while (true) {
    const pkgJson = path.join(dir, "package.json");
    const pnpmYaml = path.join(dir, "pnpm-workspace.yaml");
    const lernaJson = path.join(dir, "lerna.json");
    if (await fileExists(pkgJson)) {
      try {
        const raw = await fsp.readFile(pkgJson, "utf8");
        const json = JSON.parse(raw);
        if (json.workspaces) return dir;
      } catch {}
    }
    if (await fileExists(pnpmYaml)) return dir;
    if (await fileExists(lernaJson)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function loadJSON<T = any>(p: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export type WorkspacePackageInfo = {
  name: string;
  path: string;
  main?: string;
  exports?: unknown;
};
export type WorkspaceConfig = {
  packages: Map<string, WorkspacePackageInfo>;
  rootDir: string;
};
const workspaceCache = new Map<string, WorkspaceConfig>();

export async function loadWorkspaceConfig(
  projectRoot: string
): Promise<WorkspaceConfig | undefined> {
  const root = (await findWorkspaceRoot(projectRoot)) ?? projectRoot;
  if (workspaceCache.has(root)) return workspaceCache.get(root)!;

  const packages = new Map<string, WorkspacePackageInfo>();

  const rootPkgPath = path.join(root, "package.json");
  const rootPkg = await loadJSON<any>(rootPkgPath);
  let workspaceGlobs: string[] = [];
  if (rootPkg?.workspaces) {
    if (Array.isArray(rootPkg.workspaces)) workspaceGlobs = rootPkg.workspaces;
    else if (Array.isArray(rootPkg.workspaces?.packages))
      workspaceGlobs = rootPkg.workspaces.packages;
  }

  const pnpmYamlPath = path.join(root, "pnpm-workspace.yaml");
  if (await fileExists(pnpmYamlPath)) {
    try {
      const raw = await fsp.readFile(pnpmYamlPath, "utf8");
      const lines = raw.split(/\r?\n/);
      let inPackages = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("packages:")) {
          inPackages = true;
          continue;
        }
        if (!inPackages) continue;
        if (/^\w/.test(trimmed)) break;
        const m = trimmed.match(/^[-]\s*['"]?([^'"\s]+)['"]?/);
        if (m && m[1]) workspaceGlobs.push(m[1]);
      }
    } catch {}
  }

  const lernaPath = path.join(root, "lerna.json");
  const lerna = await loadJSON<any>(lernaPath);
  if (lerna?.packages && Array.isArray(lerna.packages)) {
    workspaceGlobs.push(...lerna.packages);
  }

  workspaceGlobs = Array.from(new Set(workspaceGlobs));

  if (workspaceGlobs.length > 0) {
    const patterns = workspaceGlobs.map((g) =>
      path.posix.join(g.replace(/\\/g, "/"), "package.json")
    );
    const found = await fg(patterns, {
      cwd: root,
      absolute: true,
      dot: true,
      ignore: ["**/node_modules/**"],
    });
    for (const pkgPath of found) {
      const info = await loadJSON<any>(pkgPath);
      const name: string | undefined = info?.name;
      if (!name) continue;
      const dir = path.dirname(pkgPath);
      packages.set(name, {
        name,
        path: dir,
        main: typeof info.main === "string" ? info.main : undefined,
        exports: info.exports,
      });
    }
  }

  const cfg: WorkspaceConfig = { packages, rootDir: root };
  workspaceCache.set(root, cfg);
  return cfg;
}

export function resolvePackageSubpath(spec: string): {
  name: string;
  subpath?: string | undefined;
} {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    const name = parts.slice(0, 2).join("/");
    const sub = parts.slice(2).join("/");
    return { name, subpath: sub || undefined };
  }
  const parts = spec.split("/");
  const name = parts[0]!;
  const sub = parts.slice(1).join("/");
  return { name, subpath: sub || undefined };
}

export async function resolveWorkspacePackage(
  spec: string,
  ws: WorkspaceConfig | undefined
): Promise<string | null> {
  if (!ws) return null;
  const { name, subpath } = resolvePackageSubpath(spec);
  const pkg = ws.packages.get(name);
  if (!pkg) return null;
  const baseDir = pkg.path;

  const exts = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
  const tryResolveRelative = async (rel: string): Promise<string | null> => {
    const raw = path.resolve(baseDir, rel);
    const candidates: string[] = [raw];
    for (const e of exts) candidates.push(raw + e);
    for (const e of exts) candidates.push(path.join(raw, "index" + e));
    for (const c of candidates) if (await fileExists(c)) return path.resolve(c);
    return null;
  };
  const pickExportTarget = (target: any): string | null => {
    if (!target) return null;
    if (typeof target === "string") return target as string;
    if (typeof target === "object") {
      const cand = (target as any).import ?? (target as any).default ?? (target as any).require ?? (target as any).module;
      if (typeof cand === "string") return cand;
    }
    return null;
  };
  if (pkg.exports) {
    const key = subpath ? `./${subpath}` : ".";
    if (typeof pkg.exports === "string" && key === ".") {
      const hit = await tryResolveRelative(pkg.exports as string);
      if (hit) return hit;
    } else if (typeof pkg.exports === "object") {
      const map = pkg.exports as any;
      const target = map[key] ?? (key === "." ? map["."] : undefined);
      const rel = pickExportTarget(target);
      if (rel) {
        const hit = await tryResolveRelative(rel);
        if (hit) return hit;
      }
    }
  }

  if (subpath) {
    const raw = path.join(baseDir, subpath);
    const candidates: string[] = [raw];
    for (const e of exts) candidates.push(raw + e);
    for (const e of exts) candidates.push(path.join(raw, "index" + e));
    for (const c of candidates) {
      if (await fileExists(c)) return path.resolve(c);
    }
    return null;
  }

  const mainField = pkg.main ? path.resolve(baseDir, pkg.main) : null;
  if (mainField && (await fileExists(mainField))) return mainField;

  const idxCandidates = exts.flatMap((e) => [path.join(baseDir, "index" + e)]);
  for (const c of idxCandidates) {
    if (await fileExists(c)) return path.resolve(c);
  }
  return baseDir;
}

export type FileId = string;

export async function resolveSpecifier(
  fromFile: string,
  spec: string,
  projectRoot: string,
  matchPath?: MatchPathFn,
  workspaceConfig?: WorkspaceConfig
): Promise<FileId | { external: string }> {
  const cacheKey = `${fromFile}::${spec}`;
  const cached = resolveSpecifierCache.get(cacheKey);
  if (cached) return cached;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = spec.startsWith("/")
      ? path.join(projectRoot, spec)
      : path.resolve(path.dirname(fromFile), spec);
    const candidates: string[] = [base];
    const exts = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
    // If spec already has .js/.mjs/.cjs, also try the corresponding .ts/.mts/.cts
    const baseExt = path.extname(base);
    if (baseExt === ".js" || baseExt === ".mjs" || baseExt === ".cjs") {
      const baseWithoutExt = base.slice(0, -baseExt.length);
      const tsExt = baseExt === ".mjs" ? ".mts" : baseExt === ".cjs" ? ".cts" : ".ts";
      candidates.unshift(baseWithoutExt + tsExt);
    }
    for (const e of exts) candidates.push(base + e);
    for (const e of exts) candidates.push(path.join(base, "index" + e));
    for (const c of candidates) {
      try {
        await fsp.access(c, fs.constants.R_OK);
        const res = path.resolve(c);
        resolveSpecifierCache.set(cacheKey, res);
        return res;
      } catch {}
    }
    const ext = { external: spec } as const;
    resolveSpecifierCache.set(cacheKey, ext as any);
    return ext;
  }
  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    const resolvedWs = await resolveWorkspacePackage(spec, workspaceConfig);
    if (resolvedWs) {
      resolveSpecifierCache.set(cacheKey, resolvedWs);
      return resolvedWs;
    }
  }
  if (matchPath) {
    const m = matchPath(
      spec,
      undefined,
      (candidate: string) => {
        try {
          fs.accessSync(candidate, fs.constants.R_OK);
          return true;
        } catch {
          return false;
        }
      },
      [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
    );
    if (m) {
      const cand = path.resolve(m);
      const hasExt = !!path.extname(cand);
      if (hasExt) { resolveSpecifierCache.set(cacheKey, cand); return cand; }
      const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
      for (const e of exts) {
        const pth = cand + e;
        try {
          fs.accessSync(pth, fs.constants.R_OK);
          resolveSpecifierCache.set(cacheKey, pth);
          return pth;
        } catch {}
      }
      for (const e of exts) {
        const pth = path.join(cand, "index" + e);
        try {
          fs.accessSync(pth, fs.constants.R_OK);
          resolveSpecifierCache.set(cacheKey, pth);
          return pth;
        } catch {}
      }
      resolveSpecifierCache.set(cacheKey, cand);
      return cand;
    }
  }
  const ext = { external: spec } as const;
  resolveSpecifierCache.set(cacheKey, ext as any);
  return ext;
}

async function findPythonPackageAnchor(startDir: string): Promise<string> {
  let dir = startDir;
  let topWithInit = startDir;
  while (true) {
    try {
      await fsp.access(path.join(dir, "__init__.py"), fs.constants.R_OK);
      topWithInit = dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return topWithInit;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function resolvePythonModule(
  projectRoot: string,
  fromFile: string,
  moduleName: string | null,
  relativeDots: number
): Promise<FileId | { external: string }> {
  const cacheKey = `${fromFile}::${".".repeat(relativeDots)}${moduleName ?? ""}`;
  const cached = resolvePythonModuleCache.get(cacheKey);
  if (cached) return cached;
  const fromDir = path.dirname(fromFile);
  const anchor = await findPythonPackageAnchor(fromDir);

  let baseDir = anchor;
  const climb = Math.max(0, relativeDots - 1);
  for (let i = 0; i < climb; i++) baseDir = path.dirname(baseDir);

  const parts = (moduleName ? moduleName.split(".") : []).filter(Boolean);
  const relPath = parts.length ? path.join(...parts) : "";
  const candidates: string[] = [];
  if (relPath) {
    candidates.push(path.join(baseDir, relPath + ".py"));
    candidates.push(path.join(baseDir, relPath, "__init__.py"));
    candidates.push(path.join(baseDir, relPath));
  } else {
    candidates.push(path.join(baseDir, "__init__.py"));
  }
  for (const c of candidates) {
    try {
      if (await isDirectory(c)) { const res = path.resolve(c); resolvePythonModuleCache.set(cacheKey, res); return res; }
      await fsp.access(c, fs.constants.R_OK);
      { const res = path.resolve(c); resolvePythonModuleCache.set(cacheKey, res); return res; }
    } catch {}
  }

  if (moduleName) {
    const abs = path.join(projectRoot, ...moduleName.split("."));
    for (const c of [abs + ".py", path.join(abs, "__init__.py"), abs]) {
      try {
        if (await isDirectory(c)) { const res = path.resolve(c); resolvePythonModuleCache.set(cacheKey, res); return res; }
        await fsp.access(c, fs.constants.R_OK);
        { const res = path.resolve(c); resolvePythonModuleCache.set(cacheKey, res); return res; }
      } catch {}
    }
  }
  const ext = { external: ".".repeat(relativeDots) + (moduleName ?? "") } as const;
  resolvePythonModuleCache.set(cacheKey, ext as any);
  return ext;
}

// ----------------- Caches -----------------
const fileExistsCache = new Map<string, boolean>();
const resolveSpecifierCache = new Map<string, FileId | { external: string }>();
const resolvePythonModuleCache = new Map<string, FileId | { external: string }>();

// ----------------- Parser pool (simple) -----------------
type LangKey = "ts" | "tsx" | "js" | "py";
const parserPools = new Map<LangKey, Parser[]>();

export function acquireParser(lang: Parser.Language, key: LangKey): Parser {
  const pool = parserPools.get(key) ?? [];
  const p = pool.pop();
  if (p) { parserPools.set(key, pool); return p; }
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

export function releaseParser(parser: Parser, key: LangKey) {
  const pool = parserPools.get(key) ?? [];
  pool.push(parser);
  parserPools.set(key, pool);
}


