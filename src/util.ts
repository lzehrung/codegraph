import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { createMatchPath } from "tsconfig-paths";
import Parser from "tree-sitter";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Range } from "./types.js";

const execFileAsync = promisify(execFile);

export function sliceText(node: any, src: string) {
  if (!node || !src) return "";
  return src.slice(node.startIndex, node.endIndex);
}
export function unquote(s: string): string {
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

export const DEFAULT_PROJECT_MANIFESTS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "tsconfig.json",
  "jsconfig.json",
  "requirements.txt",
  "requirements.in",
  "pyproject.toml",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "setup.py",
  "setup.cfg",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "*.csproj",
  "*.sln",
  "composer.json",
  "composer.lock",
];

export const DEFAULT_PROJECT_PATTERNS = [
  "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,vue,svelte,go,java,cs,rb,rs,html,htm,css,scss,less}",
  ...DEFAULT_PROJECT_MANIFESTS.map((name) => `**/${name}`),
];

export async function listProjectFiles(
  projectRoot: string,
  patterns = DEFAULT_PROJECT_PATTERNS,
): Promise<string[]> {
  try {
    const files = await fg(patterns, {
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
    return files.map(normalizePath);
  } catch (error) {
    console.warn(`Warning: Failed to list files in ${projectRoot}:`, error);
    return [];
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

export function normalizePath(p: string): string {
  return typeof p === "string" ? p.replace(/\\/g, "/") : "";
}

export function normalizeResolutionHints(hints?: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const hint of hints ?? []) {
    const normalized = hint.replace(/\\/g, "/").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export type ModuleSpecifier = { spec: string; typeOnly?: boolean };

export function extractJsTsSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  try {
    const src = stripJsLikeComments(source);
    const push = (spec: string, typeOnly?: boolean) => {
      if (spec) out.push({ spec, ...(typeOnly ? { typeOnly: true } : {}) });
    };
    const reImportFrom = /^\s*import\s+[^\n;]*?\s+from\s+(["'])([^"']+)\1/gm;
    for (const m of src.matchAll(reImportFrom))
      push(m[2]!, /\bimport\s+type\b/.test(m[0]!));
    const reImportSide = /^\s*import\s+(["'])([^"']+)\1/gm;
    for (const m of src.matchAll(reImportSide))
      push(m[2]!, /\bimport\s+type\b/.test(m[0]!));
    const reExportFrom = /\bexport\s+[^\n;]*?\s+from\s+(["'])([^"']+)\1/gm;
    for (const m of src.matchAll(reExportFrom))
      push(m[2]!, /\bexport\s+type\b/.test(m[0]!));
    const reRequire = /(?<!["'`])\brequire\(\s*(["'])([^"']+)\1\s*\)/g;
    for (const m of src.matchAll(reRequire)) push(m[2]!);
    const reReqDestr =
      /\b(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\(\s*(["'])([^"']+)\1\s*\)/g;
    for (const m of src.matchAll(reReqDestr)) push(m[2]!);
    const reDynImport = /(?<!["'`])\bimport\(\s*(["'])([^"']+)\1\s*\)/g;
    for (const m of src.matchAll(reDynImport)) push(m[2]!);
  } catch {}
  return out;
}

type DynamicBase = "file" | "project";
type ParsedDynamicToken =
  | { kind: "base"; base: DynamicBase }
  | { kind: "literal"; value: string };

function parseStringLiteralToken(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if (quote !== "'" && quote !== `"` && quote !== "`") return null;
  if (!trimmed.endsWith(quote)) return null;
  if (quote === "`" && trimmed.includes("${")) return null;
  return trimmed.slice(1, -1);
}

function splitTopLevelArgs(text: string): string[] | null {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next) {
          current += next;
          i += 1;
        }
        continue;
      }
      if (quote === "`" && ch === "$" && text[i + 1] === "{") return null;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === `"` || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return null;
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) args.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote || depth !== 0) return null;
  const tail = current.trim();
  if (tail) args.push(tail);
  return args;
}

function parseDynamicToken(token: string): ParsedDynamicToken | null {
  const compact = token.replace(/\s+/g, "");
  if (
    compact === "__dirname" ||
    compact === "__filename" ||
    compact === "import.meta.url"
  ) {
    return { kind: "base", base: "file" };
  }
  if (compact === "process.cwd()") {
    return { kind: "base", base: "project" };
  }
  const literal = parseStringLiteralToken(token);
  if (literal !== null) {
    return { kind: "literal", value: literal };
  }
  return null;
}

function parsePathCallArg(argText: string): {
  base: DynamicBase;
  segments: string[];
} | null {
  const match = argText.match(/^\s*path\.(?:join|resolve)\s*\(([\s\S]*)\)\s*$/);
  if (!match) return null;
  const args = splitTopLevelArgs(match[1] ?? "");
  if (!args || args.length === 0) return null;
  let base: DynamicBase | null = null;
  const segments: string[] = [];
  for (const arg of args) {
    const token = parseDynamicToken(arg);
    if (!token) return null;
    if (token.kind === "base") {
      if (base && base !== token.base) return null;
      base = token.base;
    } else {
      segments.push(token.value);
    }
  }
  if (!base || segments.length === 0) return null;
  return { base, segments };
}

function parseNewUrlArg(argText: string): {
  base: DynamicBase;
  segments: string[];
} | null {
  const match = argText.match(/^\s*new\s+URL\s*\(([\s\S]*)\)\s*$/);
  if (!match) return null;
  const args = splitTopLevelArgs(match[1] ?? "");
  if (!args || args.length < 2) return null;
  const firstLiteral = parseStringLiteralToken(args[0] ?? "");
  if (!firstLiteral) return null;
  const baseToken = parseDynamicToken(args[1] ?? "");
  if (!baseToken || baseToken.kind !== "base") return null;
  if (baseToken.base !== "file") return null;
  return { base: baseToken.base, segments: [firstLiteral] };
}

function buildRelativeSpecifier(
  fromFile: string,
  targetPath: string,
): string | null {
  const fromDir = path.dirname(fromFile);
  const rel = normalizePath(path.relative(fromDir, targetPath));
  if (!rel) return null;
  return rel.startsWith(".") ? rel : `./${rel}`;
}

export function extractJsTsDynamicSpecifiers(
  source: string,
  fromFile: string,
  projectRoot: string,
): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  try {
    const src = stripJsLikeComments(source);
    const seen = new Set<string>();
    const addSpec = (spec: string | null) => {
      if (!spec || seen.has(spec)) return;
      seen.add(spec);
      out.push({ spec });
    };
    const pathCallRe =
      /(?<!["'`])\b(?:require|import)\s*\(\s*(path\.(?:join|resolve)\s*\([^)]*\))\s*\)/g;
    for (const match of src.matchAll(pathCallRe)) {
      const argText = match[1] ?? "";
      const parsed = parsePathCallArg(argText);
      if (!parsed) continue;
      const baseDir =
        parsed.base === "file" ? path.dirname(fromFile) : projectRoot;
      const targetPath = path.resolve(baseDir, ...parsed.segments);
      addSpec(buildRelativeSpecifier(fromFile, targetPath));
    }
    const urlCallRe =
      /(?<!["'`])\b(?:require|import)\s*\(\s*(new\s+URL\s*\([^)]*\))\s*\)/g;
    for (const match of src.matchAll(urlCallRe)) {
      const argText = match[1] ?? "";
      const parsed = parseNewUrlArg(argText);
      if (!parsed) continue;
      const baseDir = path.dirname(fromFile);
      const targetPath = path.resolve(baseDir, ...parsed.segments);
      addSpec(buildRelativeSpecifier(fromFile, targetPath));
    }
  } catch {}
  return out;
}

export function extractPythonSpecifiers(source: string): string[] {
  const out: string[] = [];
  try {
    const cleaned = stripPythonCommentsAndStrings(source);
    const reImport = /^\s*import\s+([A-Za-z_][\w\.]*)/gm;
    for (const m of cleaned.matchAll(reImport)) out.push(m[1]!);
    const reFrom =
      /^\s*from\s+([A-Za-z_][\w\.]|\.+[A-Za-z_][\w\.]*)\s+import/gm;
    for (const m of cleaned.matchAll(reFrom)) out.push(m[1]!);
  } catch {}
  return out;
}

type MatchPathFn = ReturnType<typeof createMatchPath>;
const tsconfigCache = new Map<string, { matchPath?: MatchPathFn }>();

async function findNearestTsconfig(
  startFromFile: string,
): Promise<string | null> {
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
  file: string,
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
      json.compilerOptions?.baseUrl ?? ".",
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
    if (
      (t.startsWith("'") && t.endsWith("'")) ||
      (t.startsWith('"') && t.endsWith('"'))
    ) {
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
    const cleanedSrc = lines
      .map((line) => stripInlineComment(line))
      .join("\n");
    const m = cleanedSrc.match(
      /^packages\s*:\s*\[([\s\S]*?)\]\s*$/m,
    );
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
    if (packagesIndent !== null && indent < packagesIndent) break;
    const itemMatch = line.trim().match(/^[-]\s*(.+)\s*$/);
    if (!itemMatch) continue;
    const value = unquoteMaybe(itemMatch[1] ?? "").trim();
    if (value) out.push(value);
  }

  return out;
}

export async function loadWorkspaceConfig(
  projectRoot: string,
): Promise<WorkspaceConfig | undefined> {
  const root = (await findWorkspaceRoot(projectRoot)) ?? projectRoot;
  if (workspaceCache.has(root)) return workspaceCache.get(root)!;

  const packages = new Map<string, WorkspacePackageInfo>();

  const rootPkgPath = path.join(root, "package.json");
  const rootPkg = await loadJSON<any>(rootPkgPath);
  const workspaceGlobs: WorkspaceGlobSet = { include: [], ignore: [] };
  if (rootPkg?.workspaces) {
    if (Array.isArray(rootPkg.workspaces)) {
      for (const g of rootPkg.workspaces) addWorkspaceGlob(workspaceGlobs, g);
    } else if (Array.isArray(rootPkg.workspaces?.packages)) {
      for (const g of rootPkg.workspaces.packages)
        addWorkspaceGlob(workspaceGlobs, g);
    }
  }

  const pnpmYamlPath = path.join(root, "pnpm-workspace.yaml");
  if (await fileExists(pnpmYamlPath)) {
    try {
      const raw = await fsp.readFile(pnpmYamlPath, "utf8");
      const parsedGlobs = parsePnpmWorkspacePackages(raw);
      for (const g of parsedGlobs) addWorkspaceGlob(workspaceGlobs, g);
    } catch {}
  }

  const lernaPath = path.join(root, "lerna.json");
  const lerna = await loadJSON<any>(lernaPath);
  if (lerna?.packages && Array.isArray(lerna.packages)) {
    for (const g of lerna.packages) addWorkspaceGlob(workspaceGlobs, g);
  }

  const include = Array.from(new Set(workspaceGlobs.include));
  const ignore = Array.from(new Set(workspaceGlobs.ignore));

  if (include.length > 0) {
    const patterns = include.map(toPackageJsonGlob).filter(Boolean);
    const ignorePatterns = ignore.map(toPackageJsonGlob).filter(Boolean);
    const found = await fg(patterns, {
      cwd: root,
      absolute: true,
      dot: true,
      ignore: ["**/node_modules/**", ...ignorePatterns],
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
  ws: WorkspaceConfig | undefined,
): Promise<string | null> {
  if (!ws) return null;
  const { name, subpath } = resolvePackageSubpath(spec);
  const pkg = ws.packages.get(name);
  if (!pkg) return null;
  const baseDir = pkg.path;

  const exts = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
    ".json",
    ".css",
    ".scss",
    ".less",
    ".html",
    ".vue",
    ".svelte",
    ".go",
    ".java",
    ".cs",
    ".rb",
    ".rs",
  ];
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
      const cand =
        (target as any).import ??
        (target as any).default ??
        (target as any).require ??
        (target as any).module;
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

export async function resolvePathLikeModule(
  projectRoot: string,
  spec: string,
): Promise<string | null> {
  const parts = spec.split(/[\/\\.:]+/).filter(Boolean);
  // Try extensions from the file
  const exts = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
    ".json",
    ".css",
    ".scss",
    ".less",
    ".html",
    ".vue",
    ".svelte",
    ".go",
    ".java",
    ".cs",
    ".rb",
    ".rs",
  ];

  // Try matching progressively shorter prefixes (e.g. a.b.c -> a/b/c, a/b, a)
  for (let i = parts.length; i > 0; i--) {
    const sub = parts.slice(0, i);
    const p = path.join(projectRoot, ...sub);

    for (const e of exts) {
      if (await fileExists(p + e)) return path.resolve(p + e);
    }
    for (const e of exts) {
      if (await fileExists(path.join(p, "index" + e)))
        return path.resolve(path.join(p, "index" + e));
    }
    if (await fileExists(p)) {
      const st = await fsp.stat(p);
      if (!st.isDirectory()) return path.resolve(p);
    }
  }
  return null;
}

type GoModuleInfo = {
  modulePath: string;
  moduleRoot: string;
  replacements: Map<string, string>;
};

function stripInlineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line.trim() : line.slice(0, idx).trim();
}

async function findNearestFile(
  startDir: string,
  stopDir: string,
  fileName: string,
): Promise<string | null> {
  let dir = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (true) {
    const candidate = path.join(dir, fileName);
    if (await fileExists(candidate)) return candidate;
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function parseGoMod(moduleRoot: string): Promise<GoModuleInfo | null> {
  const modPath = path.join(moduleRoot, "go.mod");
  if (!(await fileExists(modPath))) return null;
  const raw = await fsp.readFile(modPath, "utf8");
  const lines = raw.split(/\r?\n/);
  let modulePath: string | null = null;
  const replacements = new Map<string, string>();
  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine);
    if (!line) continue;
    if (!modulePath) {
      const moduleMatch = line.match(/^module\s+(.+)$/);
      if (moduleMatch) {
        modulePath = unquote(moduleMatch[1]?.trim() ?? "");
        continue;
      }
    }
    const replaceMatch = line.match(
      /^replace\s+(\S+)(?:\s+v[^\s]+)?\s+=>\s+(\S+)/,
    );
    if (replaceMatch) {
      const from = unquote(replaceMatch[1] ?? "");
      const toRaw = unquote(replaceMatch[2] ?? "");
      if (!from || !toRaw) continue;
      if (path.isAbsolute(toRaw) || toRaw.startsWith(".")) {
        const toPath = path.resolve(moduleRoot, toRaw);
        replacements.set(from, toPath);
      }
    }
  }
  if (!modulePath) return null;
  return {
    modulePath,
    moduleRoot,
    replacements,
  };
}

async function parseGoWork(goWorkPath: string): Promise<string[]> {
  const content = await fsp.readFile(goWorkPath, "utf8");
  const lines = content.split(/\r?\n/);
  const modules: string[] = [];
  let inUseBlock = false;
  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine);
    if (!line) continue;
    if (line.startsWith("use (")) {
      inUseBlock = true;
      continue;
    }
    if (inUseBlock) {
      if (line.startsWith(")")) {
        inUseBlock = false;
        continue;
      }
      modules.push(unquote(line));
      continue;
    }
    const match = line.match(/^use\s+(.+)$/);
    if (match) {
      modules.push(unquote(match[1] ?? ""));
    }
  }
  return modules.filter(Boolean);
}

async function findGoPackageEntry(dirPath: string): Promise<string | null> {
  try {
    const stat = await fsp.stat(dirPath);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const goFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".go") &&
        !entry.name.endsWith("_test.go"),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (goFiles.length === 0) return null;
  return path.join(dirPath, goFiles[0] ?? "");
}

function isGoStdLib(spec: string): boolean {
  const base = spec.split("/")[0] ?? "";
  return base.length > 0 && !base.includes(".");
}

async function resolveGoModuleImport(
  moduleInfo: GoModuleInfo,
  spec: string,
): Promise<string | null> {
  const { modulePath, moduleRoot, replacements } = moduleInfo;
  if (spec === modulePath || spec.startsWith(`${modulePath}/`)) {
    const subPath = spec === modulePath ? "" : spec.slice(modulePath.length + 1);
    const targetDir = path.join(moduleRoot, subPath);
    const entry = await findGoPackageEntry(targetDir);
    if (entry) return entry;
  }
  for (const [from, toPath] of replacements.entries()) {
    if (spec === from || spec.startsWith(`${from}/`)) {
      const subPath = spec === from ? "" : spec.slice(from.length + 1);
      const targetDir = path.join(toPath, subPath);
      const entry = await findGoPackageEntry(targetDir);
      if (entry) return entry;
    }
  }
  const vendorDir = path.join(moduleRoot, "vendor", spec);
  const vendored = await findGoPackageEntry(vendorDir);
  if (vendored) return vendored;
  return null;
}

export async function resolveGoImportPath(
  projectRoot: string,
  fromFile: string,
  spec: string,
): Promise<string | null> {
  const startDir = path.dirname(fromFile);
  const goWorkPath = await findNearestFile(startDir, projectRoot, "go.work");
  const moduleInfos: GoModuleInfo[] = [];

  if (goWorkPath) {
    const workDir = path.dirname(goWorkPath);
    const useDirs = await parseGoWork(goWorkPath);
    for (const useDir of useDirs) {
      if (!useDir) continue;
      const moduleRoot = path.resolve(workDir, useDir);
      const modInfo = await parseGoMod(moduleRoot);
      if (modInfo) moduleInfos.push(modInfo);
    }
  }

  if (moduleInfos.length === 0) {
    const goModPath = await findNearestFile(startDir, projectRoot, "go.mod");
    if (goModPath) {
      const moduleRoot = path.dirname(goModPath);
      const modInfo = await parseGoMod(moduleRoot);
      if (modInfo) moduleInfos.push(modInfo);
    }
  }

  for (const moduleInfo of moduleInfos) {
    const resolved = await resolveGoModuleImport(moduleInfo, spec);
    if (resolved) return resolved;
  }

  if (isGoStdLib(spec)) {
    const goRoot = process.env.GOROOT;
    if (goRoot) {
      const stdlibDir = path.join(goRoot, "src", spec);
      const entry = await findGoPackageEntry(stdlibDir);
      if (entry) return entry;
    }
  }

  return null;
}

export async function resolveImportSpecifier(
  projectRoot: string,
  fromFile: string,
  spec: string,
  languageId: string,
  opts?: {
    matchPath?: MatchPathFn;
    workspaceConfig?: WorkspaceConfig;
    resolveNodeModules?: boolean;
    resolutionHints?: string[];
  },
): Promise<FileId | { external: string }> {
  if (languageId === "go") {
    const goResolved = await resolveGoImportPath(projectRoot, fromFile, spec);
    if (goResolved) return goResolved;
  }

  return resolveSpecifier(
    fromFile,
    spec,
    projectRoot,
    opts?.matchPath,
    opts?.workspaceConfig,
    {
      resolveNodeModules: !!opts?.resolveNodeModules,
      ...(opts?.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
    },
  );
}

export async function resolveSpecifier(
  fromFile: string,
  spec: string,
  projectRoot: string,
  matchPath?: MatchPathFn,
  workspaceConfig?: WorkspaceConfig,
  opts?: { resolveNodeModules?: boolean; resolutionHints?: string[] },
): Promise<FileId | { external: string }> {
  const resolutionHints = normalizeResolutionHints(opts?.resolutionHints);
  const hintKey = resolutionHints.join("|");
  const cacheKey = `${fromFile}::${spec}::nm=${
    opts?.resolveNodeModules ? 1 : 0
  }::hints=${hintKey}`;
  const cached = resolveSpecifierCache.get(cacheKey);
  if (cached) return cached;
  const exts = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
    ".json",
    ".css",
    ".scss",
    ".less",
    ".html",
    ".vue",
    ".svelte",
    ".go",
    ".java",
    ".cs",
    ".rb",
    ".rs",
  ];
  const buildCandidates = (base: string): string[] => {
    const candidates: string[] = [base];
    const baseExt = path.extname(base);
    if (baseExt === ".js" || baseExt === ".mjs" || baseExt === ".cjs") {
      const baseWithoutExt = base.slice(0, -baseExt.length);
      const tsExt =
        baseExt === ".mjs" ? ".mts" : baseExt === ".cjs" ? ".cts" : ".ts";
      candidates.unshift(baseWithoutExt + tsExt);
    }
    for (const e of exts) candidates.push(base + e);
    for (const e of exts) candidates.push(path.join(base, "index" + e));
    return candidates;
  };
  const tryResolveCandidates = async (
    candidates: string[],
  ): Promise<string | null> => {
    for (const c of candidates) {
      if (await fileExists(c)) return path.resolve(c);
    }
    return null;
  };
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = spec.startsWith("/")
      ? path.join(projectRoot, spec)
      : path.resolve(path.dirname(fromFile), spec);
    const candidates = buildCandidates(base);
    const hit = await tryResolveCandidates(candidates);
    if (hit) {
      resolveSpecifierCache.set(cacheKey, hit);
      return hit;
    }
    const ext = { external: spec } as const;
    resolveSpecifierCache.set(cacheKey, ext as any);
    return ext;
  }
  // Bare specifier: prefer TS path mappings (tsconfig `paths`) before workspace/node_modules.
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
      [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    );
    if (m) {
      const cand = path.resolve(m);
      const hasExt = !!path.extname(cand);
      if (hasExt) {
        resolveSpecifierCache.set(cacheKey, cand);
        return cand;
      }
      const tsExts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
      for (const e of tsExts) {
        const pth = cand + e;
        try {
          fs.accessSync(pth, fs.constants.R_OK);
          resolveSpecifierCache.set(cacheKey, pth);
          return pth;
        } catch {}
      }
      for (const e of tsExts) {
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

  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    const resolvedWs = await resolveWorkspacePackage(spec, workspaceConfig);
    if (resolvedWs) {
      resolveSpecifierCache.set(cacheKey, resolvedWs);
      return resolvedWs;
    }
    // Try path-like fallback for Java/Go/C#/Rust which often look like packages but map to source
    const pathLike = await resolvePathLikeModule(projectRoot, spec);
    if (pathLike) {
      resolveSpecifierCache.set(cacheKey, pathLike);
      return pathLike;
    }
    if (opts?.resolveNodeModules) {
      const nm = await resolveFromNodeModules(spec, fromFile, projectRoot);
      if (nm) {
        resolveSpecifierCache.set(cacheKey, nm);
        return nm;
      }
    }
  }
  if (resolutionHints.length > 0) {
    for (const hint of resolutionHints) {
      const baseDir = path.isAbsolute(hint)
        ? hint
        : path.resolve(projectRoot, hint);
      const base = path.resolve(baseDir, spec);
      const candidates = buildCandidates(base);
      const hit = await tryResolveCandidates(candidates);
      if (hit) {
        resolveSpecifierCache.set(cacheKey, hit);
        return hit;
      }
    }
  }
  const ext = { external: spec } as const;
  resolveSpecifierCache.set(cacheKey, ext as any);
  return ext;
}

async function resolveFromNodeModules(
  spec: string,
  fromFile: string,
  projectRoot: string,
): Promise<string | null> {
  try {
    // Walk up from the file directory to project root looking for node_modules
    let dir = path.dirname(fromFile);
    const parts = spec.split("/");
    const packageName = spec.startsWith("@")
      ? parts.slice(0, 2).join("/")
      : parts[0]!;
    const subpath = spec.startsWith("@")
      ? parts.slice(2).join("/")
      : parts.slice(1).join("/");
    while (true) {
      const nmDir = path.join(dir, "node_modules", packageName);
      if (await fileExists(nmDir)) {
        const pkgPath = path.join(nmDir, "package.json");
        const pkg = await loadJSON<any>(pkgPath);
        const baseDir = nmDir;
        const exts = [
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".mts",
          ".cts",
          ".mjs",
          ".cjs",
          ".json",
          ".vue",
          ".svelte",
          ".go",
          ".java",
          ".cs",
          ".rb",
          ".rs",
        ];
        const tryResolveRelative = async (
          rel: string,
        ): Promise<string | null> => {
          const raw = path.resolve(baseDir, rel);
          const candidates: string[] = [raw];
          for (const e of exts) candidates.push(raw + e);
          for (const e of exts) candidates.push(path.join(raw, "index" + e));
          for (const c of candidates)
            if (await fileExists(c)) return path.resolve(c);
          return null;
        };
        // Exports map handling (simplified)
        const pickExportTarget = (target: any): string | null => {
          if (!target) return null;
          if (typeof target === "string") return target as string;
          if (typeof target === "object") {
            const cand =
              (target as any).import ??
              (target as any).default ??
              (target as any).require ??
              (target as any).module;
            if (typeof cand === "string") return cand;
          }
          return null;
        };
        if (pkg?.exports) {
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
          for (const c of candidates)
            if (await fileExists(c)) return path.resolve(c);
        }
        const mainField =
          typeof pkg?.main === "string"
            ? path.resolve(baseDir, pkg.main)
            : null;
        if (mainField && (await fileExists(mainField))) return mainField;
        const idxCandidates = exts.map((e) => path.join(baseDir, "index" + e));
        for (const c of idxCandidates)
          if (await fileExists(c)) return path.resolve(c);
        return baseDir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return null;
}

export async function getGitHead(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      env: process.env,
    });
    const hash = stdout?.toString().trim();
    return hash || null;
  } catch {
    return null;
  }
}

export async function isGitRepo(projectRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd: projectRoot,
        env: process.env,
      },
    );
    return stdout?.toString().trim() === "true";
  } catch {
    return false;
  }
}

export async function getGitBlobHash(
  projectRoot: string,
  file: string,
  opts?: { gitAvailable?: boolean },
): Promise<string | null> {
  try {
    if (opts?.gitAvailable === false) return null;
    const relPath = normalizePath(path.relative(projectRoot, file));
    if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
      return null;
    }
    await execFileAsync("git", ["ls-files", "--error-unmatch", relPath], {
      cwd: projectRoot,
      env: process.env,
    });
    const { stdout } = await execFileAsync("git", ["hash-object", relPath], {
      cwd: projectRoot,
      env: process.env,
    });
    const hash = stdout?.toString().trim();
    return hash || null;
  } catch {
    return null;
  }
}

export async function getGitBlobHashes(
  projectRoot: string,
  files: string[],
  opts?: { gitAvailable?: boolean },
): Promise<Map<string, string>> {
  if (opts?.gitAvailable === false) return new Map();
  const relFiles = Array.from(
    new Set(
      files
        .map((file) => normalizePath(path.relative(projectRoot, file)))
        .filter(
          (rel) =>
            rel &&
            !rel.startsWith("..") &&
            !path.isAbsolute(rel) &&
            rel !== ".",
        ),
    ),
  );
  if (relFiles.length === 0) return new Map();
  try {
    const { stdout: trackedStdout } = await execFileAsync(
      "git",
      ["ls-files", "-z", "--", ...relFiles],
      {
        cwd: projectRoot,
        env: process.env,
      },
    );
    const trackedRel = trackedStdout
      .toString()
      .split("\0")
      .map((line) => line.trim())
      .filter(Boolean);
    if (trackedRel.length === 0) return new Map();
    const hashes = await new Promise<string[]>((resolve, reject) => {
      const child = spawn("git", ["hash-object", "--stdin-paths"], {
        cwd: projectRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `git hash-object failed (${code}): ${stderr || "unknown error"}`,
            ),
          );
          return;
        }
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        );
      });
      child.stdin.write(trackedRel.join("\n"));
      child.stdin.end();
    });
    if (hashes.length !== trackedRel.length) return new Map();
    const out = new Map<string, string>();
    for (let i = 0; i < trackedRel.length; i += 1) {
      const rel = trackedRel[i]!;
      const hash = hashes[i];
      if (!hash) continue;
      const abs = normalizePath(path.resolve(projectRoot, rel));
      out.set(abs, hash);
    }
    return out;
  } catch {
    return new Map();
  }
}

export async function listChangedFiles(
  projectRoot: string,
  opts: {
    changedSince?: string | undefined;
    base?: string | undefined;
    head?: string | undefined;
  },
): Promise<string[]> {
  try {
    const args = ["diff", "--name-only", "--diff-filter=ACDMRTUXB"];
    if (opts.base) {
      const head = opts.head ?? "HEAD";
      args.push(`${opts.base}..${head}`);
    } else if (opts.changedSince) {
      args.push(opts.changedSince);
    } else {
      return [];
    }
    args.push("--");
    const { stdout } = await execFileAsync("git", args, {
      cwd: projectRoot,
      env: process.env,
    });
    const relFiles = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const out: string[] = [];
    for (const rel of relFiles) {
      const abs = normalizePath(path.resolve(projectRoot, rel));
      if (abs) out.push(abs);
    }
    return Array.from(new Set(out));
  } catch {
    return [];
  }
}

export async function getUnifiedDiff(
  projectRoot: string,
  opts: {
    changedSince?: string | undefined;
    base?: string | undefined;
    head?: string | undefined;
  },
): Promise<string> {
  try {
    const args = [
      "diff",
      "--unified=0",
      "--no-color",
      "--diff-filter=ACDMRTUXB",
    ];
    if (opts.base) {
      const head = opts.head ?? "HEAD";
      args.push(`${opts.base}..${head}`);
    } else if (opts.changedSince) {
      args.push(opts.changedSince);
    } else {
      return "";
    }
    args.push("--");
    const { stdout } = await execFileAsync("git", args, {
      cwd: projectRoot,
      env: process.env,
    });
    return stdout;
  } catch {
    return "";
  }
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
  relativeDots: number,
): Promise<FileId | { external: string }> {
  const cacheKey = `${fromFile}::${".".repeat(relativeDots)}${
    moduleName ?? ""
  }`;
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
      if (await isDirectory(c)) {
        const res = path.resolve(c);
        resolvePythonModuleCache.set(cacheKey, res);
        return res;
      }
      await fsp.access(c, fs.constants.R_OK);
      {
        const res = path.resolve(c);
        resolvePythonModuleCache.set(cacheKey, res);
        return res;
      }
    } catch {}
  }

  if (moduleName) {
    const abs = path.join(projectRoot, ...moduleName.split("."));
    for (const c of [abs + ".py", path.join(abs, "__init__.py"), abs]) {
      try {
        if (await isDirectory(c)) {
          const res = path.resolve(c);
          resolvePythonModuleCache.set(cacheKey, res);
          return res;
        }
        await fsp.access(c, fs.constants.R_OK);
        {
          const res = path.resolve(c);
          resolvePythonModuleCache.set(cacheKey, res);
          return res;
        }
      } catch {}
    }
  }
  const ext = {
    external: ".".repeat(relativeDots) + (moduleName ?? ""),
  } as const;
  resolvePythonModuleCache.set(cacheKey, ext as any);
  return ext;
}

// ----------------- Caches -----------------
const fileExistsCache = new Map<string, boolean>();
const resolveSpecifierCache = new Map<string, FileId | { external: string }>();
const resolvePythonModuleCache = new Map<
  string,
  FileId | { external: string }
>();

// ----------------- Parser pool (simple) -----------------
type LangKey = "ts" | "tsx" | "js" | "py";
const parserPools = new Map<LangKey, Parser[]>();

export function acquireParser(lang: Parser.Language, key: LangKey): Parser {
  const pool = parserPools.get(key) ?? [];
  const p = pool.pop();
  if (p) {
    parserPools.set(key, pool);
    return p;
  }
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

export function releaseParser(parser: Parser, key: LangKey) {
  const pool = parserPools.get(key) ?? [];
  pool.push(parser);
  parserPools.set(key, pool);
}
