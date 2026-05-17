const fileExistsCache = new Map<string, boolean>();
const directoryExistsCache = new Map<string, boolean>();

import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { listResolutionCandidates } from "./resolutionCandidates.js";

export async function fileExists(p: string): Promise<boolean> {
  const cached = fileExistsCache.get(p);
  if (cached !== undefined) return cached;
  try {
    const stat = await fsp.stat(p);
    const exists = stat.isFile();
    fileExistsCache.set(p, exists);
    return exists;
  } catch {
    fileExistsCache.set(p, false);
    return false;
  }
}

export async function directoryExists(p: string): Promise<boolean> {
  const cached = directoryExistsCache.get(p);
  if (cached !== undefined) return cached;
  try {
    const stat = await fsp.stat(p);
    const exists = stat.isDirectory();
    directoryExistsCache.set(p, exists);
    return exists;
  } catch {
    directoryExistsCache.set(p, false);
    return false;
  }
}

async function findWorkspaceRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  while (true) {
    const pkgJson = path.join(dir, "package.json");
    const pnpmYaml = path.join(dir, "pnpm-workspace.yaml");
    const lernaJson = path.join(dir, "lerna.json");
    if (await fileExists(pkgJson)) {
      try {
        const raw = await fsp.readFile(pkgJson, "utf8");
        const json = JSON.parse(raw) as { workspaces?: unknown };
        if (json.workspaces) return dir;
      } catch {
        /* invalid JSON: ignore */
      }
    }
    if (await fileExists(pnpmYaml)) return dir;
    if (await fileExists(lernaJson)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function loadJSON<T = unknown>(p: string): Promise<T | null> {
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

type WorkspaceGlobSet = { include: string[]; ignore: string[] };

function addWorkspaceGlob(globs: WorkspaceGlobSet, raw: unknown) {
  if (typeof raw !== "string") return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  if (trimmed.startsWith("!")) {
    const neg = trimmed.slice(1).trim();
    if (neg) globs.ignore.push(neg);
    return;
  }
  globs.include.push(trimmed);
}

function toPackageJsonGlob(rawGlob: string): string {
  const normalized = rawGlob.replace(/\\/g, "/").trim();
  if (!normalized) return "";
  if (normalized.endsWith("package.json")) return normalized;
  return path.posix.join(normalized, "package.json");
}

function parsePnpmWorkspacePackages(rawYaml: string): string[] {
  const src = rawYaml.replace(/^\uFEFF/, "");
  const lines = src.split(/\r?\n/);
  const out: string[] = [];

  // Strip YAML-style inline comments, but keep `#` characters that appear inside quoted strings.
  const stripInlineComment = (line: string): string => {
    let quote: "'" | '"' | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === "#") return line.slice(0, i);
    }
    return line;
  };

  // Remove surrounding single or double quotes from a YAML string value,
  // preserving values that are not enclosed in matching quotes.
  const unquoteMaybe = (value: string): string => {
    const t = value.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      return t.slice(1, -1);
    }
    return t;
  };

  // Support flow style, including multi-line:
  // packages: ['a/*', '!b/*']
  // packages: [
  //   'a/*',
  //   '!b/*'
  // ]
  {
    const cleanedSrc = lines.map((line) => stripInlineComment(line)).join("\n");
    const m = cleanedSrc.match(/^packages\s*:\s*\[([\s\S]*?)\]\s*$/m);
    if (m) {
      const inner = m[1] ?? "";
      const parts = inner
        .split(",")
        .map((p) => unquoteMaybe(p))
        .map((p) => p.trim())
        .filter(Boolean);
      out.push(...parts);
      return out;
    }
  }

  // Block style:
  // packages:
  //   - 'a/*'
  //   - '!b/*'
  let inPackages = false;
  let packagesIndent: number | null = null;
  for (const rawLine of lines) {
    const commentStripped = stripInlineComment(rawLine);
    const line = commentStripped.replace(/\t/g, "  ");
    if (!inPackages) {
      const m = line.match(/^(\s*)packages\s*:\s*$/);
      if (m) {
        inPackages = true;
        packagesIndent = (m[1] ?? "").length;
      }
      continue;
    }

    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
    if (packagesIndent !== null && indent <= packagesIndent) break;
    const itemMatch = line.trim().match(/^[-]\s*(.+)\s*$/);
    if (!itemMatch) continue;
    const value = unquoteMaybe(itemMatch[1] ?? "").trim();
    if (value) out.push(value);
  }

  return out;
}

export type MinimalPackageJson = {
  name?: string;
  main?: string;
  exports?: unknown;
  workspaces?: string[] | { packages?: string[] };
};

type MinimalLernaJson = {
  packages?: string[];
};

export async function loadWorkspaceConfig(projectRoot: string): Promise<WorkspaceConfig | undefined> {
  const root = (await findWorkspaceRoot(projectRoot)) ?? path.resolve(projectRoot);
  if (workspaceCache.has(root)) return workspaceCache.get(root)!;

  const packages = new Map<string, WorkspacePackageInfo>();

  const rootPkgPath = path.join(root, "package.json");
  const rootPkg = await loadJSON<MinimalPackageJson>(rootPkgPath);
  const workspaceGlobs: WorkspaceGlobSet = { include: [], ignore: [] };
  if (rootPkg?.workspaces) {
    if (Array.isArray(rootPkg.workspaces)) {
      for (const g of rootPkg.workspaces) addWorkspaceGlob(workspaceGlobs, g);
    } else if (
      typeof rootPkg.workspaces === "object" &&
      rootPkg.workspaces !== null &&
      "packages" in rootPkg.workspaces
    ) {
      const workspacePackagePatterns = (rootPkg.workspaces as { packages?: unknown }).packages;
      if (Array.isArray(workspacePackagePatterns)) {
        for (const g of workspacePackagePatterns) addWorkspaceGlob(workspaceGlobs, g);
      }
    }
  }

  const pnpmYamlPath = path.join(root, "pnpm-workspace.yaml");
  if (await fileExists(pnpmYamlPath)) {
    try {
      const raw = await fsp.readFile(pnpmYamlPath, "utf8");
      const parsedGlobs = parsePnpmWorkspacePackages(raw);
      for (const g of parsedGlobs) addWorkspaceGlob(workspaceGlobs, g);
    } catch {
      /* parse error: ignore */
    }
  }

  const lernaPath = path.join(root, "lerna.json");
  const lerna = await loadJSON<MinimalLernaJson>(lernaPath);
  if (lerna?.packages && Array.isArray(lerna.packages)) {
    for (const g of lerna.packages) addWorkspaceGlob(workspaceGlobs, g);
  }

  const include = Array.from(new Set(workspaceGlobs.include));
  const ignore = Array.from(new Set(workspaceGlobs.ignore));

  if (include.length) {
    const patterns = include.map(toPackageJsonGlob).filter(Boolean);
    const ignorePatterns = ignore.map(toPackageJsonGlob).filter(Boolean);
    const found = await fg(patterns, {
      cwd: root,
      absolute: true,
      dot: true,
      ignore: ["**/node_modules/**", ...ignorePatterns],
    });
    for (const pkgPath of found) {
      const info = await loadJSON<MinimalPackageJson>(pkgPath);
      if (!info || !info.name) continue;
      const name = info.name;
      const dir = path.dirname(pkgPath);
      packages.set(name, {
        name,
        path: dir,
        ...(typeof info.main === "string" ? { main: info.main } : {}),
        ...(info.exports ? { exports: info.exports } : {}),
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

export function listWorkspacePackageResolutionCandidates(
  spec: string,
  ws: WorkspaceConfig | undefined,
  resolutionExtensions?: readonly string[],
): string[] {
  if (!ws) return [];
  const { name, subpath } = resolvePackageSubpath(spec);
  const pkg = ws.packages.get(name);
  if (!pkg) return [];
  const baseDir = pkg.path;
  const candidates: string[] = [];
  const pushRelativeCandidates = (rel: string): void => {
    candidates.push(...listResolutionCandidates(path.resolve(baseDir, rel), resolutionExtensions));
  };
  const pickExportTarget = (target: unknown): string | null => {
    if (!target) return null;
    if (typeof target === "string") return target;
    if (typeof target === "object" && target !== null) {
      const typedTarget = target as Record<string, unknown>;
      const candidate = typedTarget.import ?? typedTarget.default ?? typedTarget.require ?? typedTarget.module;
      if (typeof candidate === "string") return candidate;
    }
    return null;
  };

  if (pkg.exports) {
    const key = subpath ? `./${subpath}` : ".";
    if (typeof pkg.exports === "string" && key === ".") {
      pushRelativeCandidates(pkg.exports);
    } else if (typeof pkg.exports === "object") {
      const exportMap = pkg.exports as Record<string, unknown>;
      const target = exportMap[key] ?? (key === "." ? exportMap["."] : undefined);
      const rel = pickExportTarget(target);
      if (rel) {
        pushRelativeCandidates(rel);
      }
    }
  }

  if (subpath) {
    pushRelativeCandidates(subpath);
    return Array.from(new Set(candidates));
  }

  if (pkg.main) {
    pushRelativeCandidates(pkg.main);
  }
  candidates.push(...listResolutionCandidates(path.join(baseDir, "index"), resolutionExtensions));
  return Array.from(new Set(candidates));
}

export async function resolveWorkspacePackage(
  spec: string,
  ws: WorkspaceConfig | undefined,
  resolutionExtensions?: readonly string[],
): Promise<string | null> {
  if (!ws) return null;
  const { name } = resolvePackageSubpath(spec);
  const pkg = ws.packages.get(name);
  if (!pkg) return null;
  for (const candidate of listWorkspacePackageResolutionCandidates(spec, ws, resolutionExtensions)) {
    if (await fileExists(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

export function clearWorkspaceCaches(): void {
  fileExistsCache.clear();
  directoryExistsCache.clear();
  workspaceCache.clear();
}

export function clearFileExistsCache(): void {
  fileExistsCache.clear();
  directoryExistsCache.clear();
}
