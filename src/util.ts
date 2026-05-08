import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import picomatch from "picomatch";
import { createMatchPath } from "tsconfig-paths";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Range } from "./types.js";
import { logWithLevel, type LogLevel } from "./logging.js";

const execFileAsync = promisify(execFile);

export function isGitWorktreeSentinel(value: string): boolean {
  return value.toUpperCase() === "WORKTREE";
}

export function isGitIndexSentinel(value: string): boolean {
  const normalized = value.toUpperCase();
  return normalized === "INDEX" || normalized === "STAGED";
}

export function gitDiffArgs(base: string, head: string, extraArgs: string[] = []): string[] {
  if (isGitWorktreeSentinel(head)) {
    return ["diff", ...extraArgs, base];
  }
  if (isGitIndexSentinel(head)) {
    return ["diff", "--cached", ...extraArgs, base];
  }
  return ["diff", ...extraArgs, `${base}..${head}`];
}

/** Node-like interface for AST nodes with position info */
interface NodeLike {
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
}

export function sliceText(node: NodeLike | null | undefined, src: string): string {
  if (!node || !src) return "";
  return src.slice(node.startIndex, node.endIndex);
}
export function unquote(s: string): string {
  if (!s || typeof s !== "string") return s;
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith("`") && t.endsWith("`"))
    ? t.slice(1, -1)
    : t;
}
export function toRange(node: NodeLike | null | undefined): Range {
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

export function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[Object]";
    }
  }
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") {
    return `[Function: ${value.name || "anonymous"}]`;
  }
  return "unknown";
}

export const DEFAULT_PROJECT_FILE_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/.venv/**",
  "**/__pycache__/**",
];

export const DEFAULT_PROJECT_MANIFESTS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "turbo.json",
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
  "rust-toolchain",
  "rust-toolchain.toml",
  "go.mod",
  "go.sum",
  "go.work",
  "Gemfile",
  "Gemfile.lock",
  "*.gemspec",
  "pom.xml",
  "mvnw",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "gradlew",
  "*.csproj",
  "*.fsproj",
  "*.vbproj",
  "*.sln",
  "Directory.Build.props",
  "Directory.Build.targets",
  "global.json",
  "composer.json",
  "composer.lock",
  "Package.swift",
  "Package.resolved",
  "CMakeLists.txt",
  "CMakePresets.json",
  "CMakeUserPresets.json",
  "Makefile",
  "makefile",
  "GNUmakefile",
  "configure.ac",
  "configure.in",
  "meson.build",
  "meson_options.txt",
  "conanfile.txt",
  "conanfile.py",
  "vcpkg.json",
];

export const DEFAULT_PROJECT_PATTERNS = [
  "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,php,vue,svelte,astro,hbs,handlebars,md,mdx,rst,adoc,asciidoc,go,java,cs,rb,rs,html,htm,css,scss,less,kt,kts,swift,zig,c,h,cc,cpp,cxx,c++,hpp,hh,hxx,ipp,tpp,inl}",
  ...DEFAULT_PROJECT_MANIFESTS.map((name) => `**/${name}`),
];

export type ProjectFileDiscoveryOptions = {
  includeGlobs?: string[];
  ignoreGlobs?: string[];
  useGitignore?: boolean;
  gitignoreRoot?: string;
  logLevel?: LogLevel;
};

type GitignoreRule = {
  baseDir: string;
  negated: boolean;
  dirOnly: boolean;
  matches: (relativePath: string) => boolean;
};

function normalizeGlobPattern(globPattern: string): string {
  return globPattern.trim().replace(/\\/g, "/");
}

function stripGitignoreTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let slashCount = 0;
    for (let i = end - 2; i >= 0 && line[i] === "\\"; i -= 1) {
      slashCount += 1;
    }
    if (slashCount % 2 === 1) {
      break;
    }
    end -= 1;
  }
  return line.slice(0, end);
}

function parseGitignoreRule(baseDir: string, rawLine: string): GitignoreRule | null {
  const trimmedLine = stripGitignoreTrailingSpaces(rawLine);
  if (!trimmedLine) return null;
  if (trimmedLine.startsWith("#")) return null;

  const negated = trimmedLine.startsWith("!");
  let pattern = negated ? trimmedLine.slice(1) : trimmedLine;
  if (!pattern || pattern === "/") return null;

  const dirOnly = pattern.endsWith("/");
  if (dirOnly) {
    pattern = pattern.slice(0, -1);
  }
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }
  pattern = pattern.replace(/^\\([#!])/, "$1").replace(/\\/g, "/");
  if (!pattern) return null;

  const anchored = trimmedLine.startsWith("/") || (negated && trimmedLine.startsWith("!/"));
  const baseMatcherPattern = anchored || pattern.includes("/") ? pattern : `**/${pattern}`;
  const matcherPattern = dirOnly ? `${baseMatcherPattern}/**` : [baseMatcherPattern, `${baseMatcherPattern}/**`];
  const matches = picomatch(matcherPattern, { dot: true });
  return {
    baseDir: normalizePath(baseDir),
    negated,
    dirOnly,
    matches,
  };
}

async function loadGitignoreRules(projectRoot: string): Promise<GitignoreRule[]> {
  const gitignoreFiles = await fg(["**/.gitignore"], {
    cwd: projectRoot,
    absolute: true,
    dot: true,
    ignore: DEFAULT_PROJECT_FILE_IGNORES,
  });
  gitignoreFiles.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
  const rules: GitignoreRule[] = [];
  for (const gitignoreFile of gitignoreFiles) {
    if (isIgnoredByGitignore(gitignoreFile, rules)) {
      continue;
    }
    try {
      const baseDir = path.dirname(gitignoreFile);
      const raw = await fsp.readFile(gitignoreFile, "utf8");
      rules.push(
        ...raw
          .split(/\r?\n/)
          .map((line) => parseGitignoreRule(baseDir, line))
          .filter((rule): rule is GitignoreRule => !!rule),
      );
    } catch {
      continue;
    }
  }
  return rules;
}

function matchesDiscoveryGlob(
  absolutePath: string,
  projectRoot: string,
  matcher: (relativePath: string) => boolean,
): boolean {
  const relativePath = normalizePath(path.relative(projectRoot, absolutePath));
  if (!relativePath || relativePath.startsWith("..")) {
    return false;
  }
  return matcher(relativePath);
}

function isIgnoredByGitignore(absolutePath: string, rules: GitignoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const relativePath = normalizePath(path.relative(rule.baseDir, absolutePath));
    if (!relativePath || relativePath.startsWith("..")) {
      continue;
    }
    if (rule.dirOnly && !relativePath.includes("/")) {
      continue;
    }
    if (rule.matches(relativePath)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

async function ensureDirectoryReadable(directoryPath: string, label: string): Promise<string> {
  const resolvedPath = path.resolve(directoryPath);
  let stats: fs.Stats;
  try {
    stats = await fsp.stat(resolvedPath);
  } catch (error) {
    throw new Error(`${label} does not exist or is not readable: ${resolvedPath} (${stringifyUnknown(error)})`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${resolvedPath}`);
  }
  return resolvedPath;
}

export async function listProjectFiles(
  projectRoot: string,
  patterns = DEFAULT_PROJECT_PATTERNS,
  options?: ProjectFileDiscoveryOptions,
): Promise<string[]> {
  const root = await ensureDirectoryReadable(projectRoot, "Project root");
  const includeMatchers = (options?.includeGlobs ?? [])
    .map(normalizeGlobPattern)
    .filter(Boolean)
    .map((globPattern) => picomatch(globPattern, { dot: true }));
  const userIgnoreGlobs = (options?.ignoreGlobs ?? []).map(normalizeGlobPattern).filter(Boolean);

  try {
    const gitignoreRules =
      options?.useGitignore === false
        ? []
        : await loadGitignoreRules(
            options?.gitignoreRoot ? await ensureDirectoryReadable(options.gitignoreRoot, "Gitignore root") : root,
          );
    const files = await fg(patterns, {
      cwd: root,
      absolute: true,
      dot: true,
      ignore: [...DEFAULT_PROJECT_FILE_IGNORES, ...userIgnoreGlobs],
    });
    return files.map(normalizePath).filter((filePath) => {
      if (
        includeMatchers.length > 0 &&
        !includeMatchers.some((matcher) => matchesDiscoveryGlob(filePath, root, matcher))
      ) {
        return false;
      }
      return !isIgnoredByGitignore(filePath, gitignoreRules);
    });
  } catch (error) {
    logWithLevel(options?.logLevel, "debug", `listProjectFiles failed for ${root}: ${stringifyUnknown(error)}`);
    throw new Error(`Failed to list files in ${root}: ${stringifyUnknown(error)}`);
  }
}

export type ProjectFileKind = "file" | "dir";
export type ProjectFileRole = "manifest" | "lockfile" | "config" | "solution" | "ide";
export type ProjectFileType =
  | "node"
  | "typescript"
  | "python"
  | "rust"
  | "go"
  | "maven"
  | "gradle"
  | "dotnet"
  | "ruby"
  | "php"
  | "swift"
  | "native"
  | "ide";

export type ProjectFileInfo = {
  path: string;
  kind: ProjectFileKind;
  type: ProjectFileType;
  role: ProjectFileRole;
  projectRoot: string;
  name?: string;
};

type ProjectFileDefinition = {
  type: ProjectFileType;
  role: ProjectFileRole;
  kind: ProjectFileKind;
  patterns: string[];
  parseName?: (contents: string, filePath: string) => string | null;
  nameFromPath?: "file" | "dir";
};

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonName(raw: string): string | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (!isPlainRecord(data)) return null;
    const name = data.name;
    if (typeof name !== "string") return null;
    return trimToNull(name);
  } catch {
    return null;
  }
}

function stripTomlInlineComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i += 1) {
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
}

function parseTomlName(raw: string, sections: string[]): string | null {
  const lines = raw.split(/\r?\n/);
  let currentSection = "";
  for (const rawLine of lines) {
    const line = stripTomlInlineComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      currentSection = (sectionMatch[1] ?? "").trim();
      continue;
    }
    if (!sections.includes(currentSection)) continue;
    const nameMatch = line.match(/^name\s*=\s*("([^"]*)"|'([^']*)')/);
    if (!nameMatch) continue;
    return trimToNull(nameMatch[2] ?? nameMatch[3] ?? "");
  }
  return null;
}

function parseIniName(raw: string, section: string, key: string): string | null {
  const lines = raw.split(/\r?\n/);
  let currentSection = "";
  const targetSection = section.toLowerCase();
  const targetKey = key.toLowerCase();
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      currentSection = (sectionMatch[1] ?? "").trim().toLowerCase();
      continue;
    }
    if (currentSection !== targetSection) continue;
    const keyMatch = trimmed.match(/^([^=]+)=(.+)$/);
    if (!keyMatch) continue;
    const foundKey = (keyMatch[1] ?? "").trim().toLowerCase();
    if (foundKey !== targetKey) continue;
    const value = (keyMatch[2] ?? "").trim();
    return trimToNull(value.replace(/^['"]|['"]$/g, ""));
  }
  return null;
}

function parseSetupPyName(raw: string): string | null {
  const match = raw.match(/\bname\s*=\s*["']([^"']+)["']/);
  return trimToNull(match?.[1]);
}

function parsePomName(raw: string): string | null {
  const withoutParent = raw.replace(/<parent>[\s\S]*?<\/parent>/gi, "");
  const nameMatch = withoutParent.match(/<name>\s*([^<]+)\s*<\/name>/i);
  if (nameMatch) return trimToNull(nameMatch[1]);
  const artifactMatch = withoutParent.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/i);
  if (artifactMatch) return trimToNull(artifactMatch[1]);
  return null;
}

function parseGradleName(raw: string): string | null {
  const match = raw.match(/\brootProject\.name\s*=\s*["']([^"']+)["']/);
  return trimToNull(match?.[1]);
}

function parseGradlePropertiesName(raw: string): string | null {
  const match = raw.match(/^\s*rootProject\.name\s*=\s*["']([^"']+)["']/m);
  return trimToNull(match?.[1]);
}

function parseDotnetName(raw: string): string | null {
  const tags = ["AssemblyName", "PackageId", "RootNamespace"];
  for (const tag of tags) {
    const match = raw.match(new RegExp(`<${tag}>\\s*([^<]+)\\s*</${tag}>`, "i"));
    if (match) return trimToNull(match[1]);
  }
  return null;
}

function parseGoModuleName(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine);
    if (!line) continue;
    const match = line.match(/^module\s+(.+)$/);
    if (match) return trimToNull(match[1]);
  }
  return null;
}

function parseGemspecName(raw: string): string | null {
  const match = raw.match(/\bname\s*=\s*["']([^"']+)["']/);
  return trimToNull(match?.[1]);
}

function parseSwiftPackageName(raw: string): string | null {
  const match = raw.match(/\bname\s*:\s*["']([^"']+)["']/);
  return trimToNull(match?.[1]);
}

const PROJECT_FILE_DEFINITIONS: ProjectFileDefinition[] = [
  {
    type: "node",
    role: "manifest",
    kind: "file",
    patterns: ["package.json"],
    parseName: parseJsonName,
    nameFromPath: "dir",
  },
  {
    type: "node",
    role: "lockfile",
    kind: "file",
    patterns: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"],
  },
  {
    type: "node",
    role: "config",
    kind: "file",
    patterns: ["pnpm-workspace.yaml"],
    nameFromPath: "dir",
  },
  {
    type: "node",
    role: "config",
    kind: "file",
    patterns: ["lerna.json", "nx.json", "turbo.json"],
    parseName: parseJsonName,
    nameFromPath: "dir",
  },
  {
    type: "typescript",
    role: "config",
    kind: "file",
    patterns: ["tsconfig.json", "jsconfig.json"],
  },
  {
    type: "python",
    role: "manifest",
    kind: "file",
    patterns: ["pyproject.toml"],
    parseName: (raw) => parseTomlName(raw, ["project", "tool.poetry"]),
    nameFromPath: "dir",
  },
  {
    type: "python",
    role: "manifest",
    kind: "file",
    patterns: ["setup.cfg"],
    parseName: (raw) => parseIniName(raw, "metadata", "name"),
    nameFromPath: "dir",
  },
  {
    type: "python",
    role: "manifest",
    kind: "file",
    patterns: ["setup.py"],
    parseName: parseSetupPyName,
    nameFromPath: "dir",
  },
  {
    type: "python",
    role: "manifest",
    kind: "file",
    patterns: ["requirements.txt", "requirements.in", "Pipfile"],
    nameFromPath: "dir",
  },
  {
    type: "python",
    role: "lockfile",
    kind: "file",
    patterns: ["Pipfile.lock", "poetry.lock"],
  },
  {
    type: "rust",
    role: "manifest",
    kind: "file",
    patterns: ["Cargo.toml"],
    parseName: (raw) => parseTomlName(raw, ["package"]),
    nameFromPath: "dir",
  },
  {
    type: "rust",
    role: "lockfile",
    kind: "file",
    patterns: ["Cargo.lock"],
  },
  {
    type: "rust",
    role: "config",
    kind: "file",
    patterns: ["rust-toolchain", "rust-toolchain.toml"],
    nameFromPath: "dir",
  },
  {
    type: "go",
    role: "manifest",
    kind: "file",
    patterns: ["go.mod"],
    parseName: parseGoModuleName,
    nameFromPath: "dir",
  },
  {
    type: "go",
    role: "lockfile",
    kind: "file",
    patterns: ["go.sum"],
  },
  {
    type: "go",
    role: "config",
    kind: "file",
    patterns: ["go.work"],
    nameFromPath: "dir",
  },
  {
    type: "ruby",
    role: "manifest",
    kind: "file",
    patterns: ["Gemfile"],
    nameFromPath: "dir",
  },
  {
    type: "ruby",
    role: "lockfile",
    kind: "file",
    patterns: ["Gemfile.lock"],
  },
  {
    type: "ruby",
    role: "manifest",
    kind: "file",
    patterns: ["*.gemspec"],
    parseName: parseGemspecName,
    nameFromPath: "file",
  },
  {
    type: "maven",
    role: "manifest",
    kind: "file",
    patterns: ["pom.xml"],
    parseName: parsePomName,
    nameFromPath: "dir",
  },
  {
    type: "maven",
    role: "config",
    kind: "file",
    patterns: ["mvnw"],
    nameFromPath: "dir",
  },
  {
    type: "gradle",
    role: "manifest",
    kind: "file",
    patterns: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    parseName: parseGradleName,
    nameFromPath: "dir",
  },
  {
    type: "gradle",
    role: "config",
    kind: "file",
    patterns: ["gradle.properties"],
    parseName: parseGradlePropertiesName,
    nameFromPath: "dir",
  },
  {
    type: "gradle",
    role: "config",
    kind: "file",
    patterns: ["gradlew"],
    nameFromPath: "dir",
  },
  {
    type: "dotnet",
    role: "manifest",
    kind: "file",
    patterns: ["*.csproj", "*.fsproj", "*.vbproj"],
    parseName: parseDotnetName,
    nameFromPath: "file",
  },
  {
    type: "dotnet",
    role: "solution",
    kind: "file",
    patterns: ["*.sln"],
    nameFromPath: "file",
  },
  {
    type: "dotnet",
    role: "config",
    kind: "file",
    patterns: ["Directory.Build.props", "Directory.Build.targets", "global.json"],
    nameFromPath: "dir",
  },
  {
    type: "php",
    role: "manifest",
    kind: "file",
    patterns: ["composer.json"],
    parseName: parseJsonName,
    nameFromPath: "dir",
  },
  {
    type: "php",
    role: "lockfile",
    kind: "file",
    patterns: ["composer.lock"],
  },
  {
    type: "native",
    role: "manifest",
    kind: "file",
    patterns: [
      "CMakeLists.txt",
      "Makefile",
      "makefile",
      "GNUmakefile",
      "configure.ac",
      "configure.in",
      "meson.build",
      "conanfile.txt",
      "conanfile.py",
    ],
    nameFromPath: "dir",
  },
  {
    type: "native",
    role: "config",
    kind: "file",
    patterns: ["CMakePresets.json", "CMakeUserPresets.json", "meson_options.txt"],
    nameFromPath: "dir",
  },
  {
    type: "native",
    role: "manifest",
    kind: "file",
    patterns: ["vcpkg.json"],
    parseName: parseJsonName,
    nameFromPath: "dir",
  },
  {
    type: "swift",
    role: "manifest",
    kind: "file",
    patterns: ["Package.swift"],
    parseName: parseSwiftPackageName,
    nameFromPath: "dir",
  },
  {
    type: "swift",
    role: "lockfile",
    kind: "file",
    patterns: ["Package.resolved"],
  },
  {
    type: "swift",
    role: "config",
    kind: "dir",
    patterns: ["*.xcodeproj", "*.xcworkspace"],
    nameFromPath: "file",
  },
  {
    type: "ide",
    role: "ide",
    kind: "dir",
    patterns: [".idea"],
    nameFromPath: "dir",
  },
];

function toProjectGlob(pattern: string): string {
  return pattern.startsWith("**/") ? pattern : `**/${pattern}`;
}

async function buildProjectFileInfo(def: ProjectFileDefinition, filePath: string): Promise<ProjectFileInfo> {
  const normalizedPath = normalizePath(filePath);
  const projectRoot = normalizePath(path.dirname(filePath));
  let name: string | null = null;
  if (def.parseName && def.kind === "file") {
    try {
      const raw = await fsp.readFile(filePath, "utf8");
      name = def.parseName(raw, filePath);
    } catch {
      name = null;
    }
  }
  if (!name && def.nameFromPath) {
    if (def.nameFromPath === "file") {
      name = trimToNull(path.basename(filePath, path.extname(filePath)));
    } else {
      name = trimToNull(path.basename(projectRoot));
    }
  }
  return {
    path: normalizedPath,
    kind: def.kind,
    type: def.type,
    role: def.role,
    projectRoot,
    ...(name ? { name } : {}),
  };
}

export async function discoverProjectFiles(
  projectRoot: string,
  options?: { logLevel?: LogLevel },
): Promise<ProjectFileInfo[]> {
  const root = await ensureDirectoryReadable(projectRoot, "Project root");
  try {
    const allPatterns = PROJECT_FILE_DEFINITIONS.flatMap((def) => def.patterns.map(toProjectGlob));
    const matches = await fg(allPatterns, {
      cwd: root,
      absolute: true,
      dot: true,
      ignore: DEFAULT_PROJECT_FILE_IGNORES,
      markDirectories: true,
      onlyFiles: false,
    });

    const entries: ProjectFileInfo[] = [];
    const matchTasks = matches.map(async (match) => {
      const isDir = match.endsWith("/");
      const cleanMatch = isDir ? match.slice(0, -1) : match;
      const fileName = path.basename(cleanMatch);

      for (const def of PROJECT_FILE_DEFINITIONS) {
        if (isDir && def.kind !== "dir") continue;
        if (!isDir && def.kind !== "file") continue;

        const matchesPattern = def.patterns.some((p) => {
          if (p.includes("*") || p.includes("?")) {
            const re = new RegExp("^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
            return re.test(fileName);
          }
          return p === fileName;
        });

        if (matchesPattern) {
          entries.push(await buildProjectFileInfo(def, cleanMatch));
        }
      }
    });

    await Promise.all(matchTasks);

    const byKey = new Map<string, ProjectFileInfo>();
    for (const entry of entries) {
      const key = `${entry.path}::${entry.type}::${entry.role}`;
      const existing = byKey.get(key);
      if (!existing || (!existing.name && entry.name)) {
        byKey.set(key, entry);
      }
    }
    return Array.from(byKey.values()).sort((a, b) => {
      if (a.path === b.path) return a.type.localeCompare(b.type);
      return a.path.localeCompare(b.path);
    });
  } catch (error) {
    logWithLevel(options?.logLevel, "debug", `discoverProjectFiles failed for ${root}: ${stringifyUnknown(error)}`);
    throw new Error(`Failed to discover project files in ${root}: ${stringifyUnknown(error)}`);
  }
}

function transformJsLikeTrivia(src: string, options?: { maskStrings?: boolean; preserveLength?: boolean }): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escapeNext = false;
  const maskStrings = options?.maskStrings ?? false;
  const preserveLength = options?.preserveLength ?? false;
  const maskedChar = (ch: string) => (ch === "\n" || ch === "\r" ? ch : " ");

  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1] ?? "";

    if (inSingle || inDouble || inTemplate) {
      const isClosingQuote =
        !escapeNext && ((inSingle && ch === "'") || (inDouble && ch === '"') || (inTemplate && ch === "`"));
      if (maskStrings) {
        out += isClosingQuote ? ch : maskedChar(ch);
      } else {
        out += ch;
      }
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (inSingle && ch === "'") {
        inSingle = false;
      } else if (inDouble && ch === '"') {
        inDouble = false;
      } else if (inTemplate && ch === "`") {
        inTemplate = false;
      }
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      if (preserveLength) out += "  ";
      i += 2;
      while (i < src.length) {
        if (src[i] === "*" && src[i + 1] === "/") {
          if (preserveLength) out += "  ";
          i += 2;
          break;
        }
        if (preserveLength) out += maskedChar(src[i]!);
        else if (src[i] === "\n") out += "\n";
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      if (preserveLength) out += "  ";
      i += 2;
      while (i < src.length && src[i] !== "\n") {
        if (preserveLength) out += " ";
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

export function stripJsLikeComments(src: string): string {
  return transformJsLikeTrivia(src);
}

export function maskJsLikeCommentsAndStrings(src: string): string {
  return transformJsLikeTrivia(src, {
    maskStrings: true,
    preserveLength: true,
  });
}

function stripJsonTrailingCommas(src: string): string {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;

    if (inSingle || inDouble) {
      out += ch;
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (inSingle && ch === "'") {
        inSingle = false;
      } else if (inDouble && ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j]!)) j += 1;
      const next = src[j];
      if (next === "}" || next === "]") {
        continue;
      }
    }

    out += ch;
  }

  return out;
}

function parseJsonc<T>(raw: string): T {
  return JSON.parse(stripJsonTrailingCommas(stripJsLikeComments(raw))) as T;
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

function normalizeWindowsComparablePath(filePath: string): string {
  return normalizePath(filePath).replace(/^([A-Za-z]):/, (_, driveLetter: string) => `${driveLetter.toUpperCase()}:`);
}

export function isAbsoluteFilePath(filePath: string): boolean {
  return path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath);
}

export function resolveFilePathFromRoot(projectRoot: string, filePath: string): string {
  if (isAbsoluteFilePath(filePath)) {
    return filePath;
  }
  if (path.win32.isAbsolute(projectRoot)) {
    return path.win32.resolve(projectRoot, filePath);
  }
  return path.resolve(projectRoot, filePath);
}

function resolveComparableProjectRoot(projectRoot: string): string {
  if (isAbsoluteFilePath(projectRoot)) {
    return projectRoot;
  }
  return path.resolve(projectRoot);
}

function isRelativeToRoot(normalizedRoot: string, normalizedFile: string): boolean {
  const comparableRoot = path.win32.isAbsolute(normalizedRoot)
    ? normalizeWindowsComparablePath(normalizedRoot)
    : normalizedRoot;
  const comparableFile = path.win32.isAbsolute(normalizedFile)
    ? normalizeWindowsComparablePath(normalizedFile)
    : normalizedFile;

  if (path.win32.isAbsolute(comparableRoot) && path.win32.isAbsolute(comparableFile)) {
    if (comparableFile === comparableRoot) {
      return true;
    }
    const relativePath = normalizePath(path.win32.relative(comparableRoot, comparableFile));
    return relativePath.length > 0 && !relativePath.startsWith("..") && !path.win32.isAbsolute(relativePath);
  }

  if (comparableFile === comparableRoot) {
    return true;
  }
  const relativePath = path.relative(comparableRoot, comparableFile);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

export function isFilePathWithinRoot(projectRoot: string, filePath: string): boolean {
  const normalizedRoot = normalizePath(resolveComparableProjectRoot(projectRoot));
  const normalizedFile = normalizePath(resolveFilePathFromRoot(normalizedRoot, filePath));
  return isRelativeToRoot(normalizedRoot, normalizedFile);
}

export function assertFilePathWithinRoot(projectRoot: string, filePath: string, label: string = "File"): string {
  const normalizedRoot = normalizePath(resolveComparableProjectRoot(projectRoot));
  const normalizedFile = normalizePath(resolveFilePathFromRoot(normalizedRoot, filePath));
  if (!isFilePathWithinRoot(normalizedRoot, normalizedFile)) {
    throw new Error(`${label} is outside project root: ${normalizedFile} (root: ${normalizedRoot})`);
  }
  return normalizedFile;
}

export function toProjectRelativePath(projectRoot: string, filePath: string): string | null {
  const normalizedRoot = normalizePath(resolveComparableProjectRoot(projectRoot));
  const normalizedFile = normalizePath(resolveFilePathFromRoot(normalizedRoot, filePath));
  if (!isFilePathWithinRoot(normalizedRoot, normalizedFile)) {
    return null;
  }
  if (path.win32.isAbsolute(normalizedRoot) && path.win32.isAbsolute(normalizedFile)) {
    const comparableRoot = normalizeWindowsComparablePath(normalizedRoot);
    const comparableFile = normalizeWindowsComparablePath(normalizedFile);
    return normalizePath(path.win32.relative(comparableRoot, comparableFile));
  }
  return normalizePath(path.relative(normalizedRoot, normalizedFile));
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

export type ModuleSpecifier = {
  spec: string;
  raw?: string;
  typeOnly?: boolean;
  phpImportType?: "class" | "function" | "const";
  resolutionKind?: "document" | "source";
  dropIfUnresolved?: boolean;
  resolved?: "heuristic" | "precise";
  confidence?: number;
};

export function extractJsTsSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  try {
    const src = stripJsLikeComments(source);
    const push = (spec: string, typeOnly?: boolean) => {
      if (spec) out.push({ spec, ...(typeOnly ? { typeOnly: true } : {}) });
    };

    const combined =
      /^\s*import\s+[^\n;]*?\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\bexport\s+[^\n;]*?\s+from\s+["']([^"']+)["']|\b(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)|(?<!["'`])\brequire\(\s*["']([^"']+)["']\s*\)|(?<!["'`])\bimport\(\s*["']([^"']+)["']\s*\)/gm;

    for (const m of src.matchAll(combined)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
      if (!spec) continue;
      const text = m[0] ?? "";
      let typeOnly = false;
      if (m[1] !== undefined || m[2] !== undefined) {
        typeOnly = /\bimport\s+type\b/.test(text);
      } else if (m[3] !== undefined) {
        typeOnly = /\bexport\s+type\b/.test(text);
      }
      push(spec, typeOnly);
    }
  } catch {
    /* regex/parse fallback: ignore */
  }
  return out;
}

type DynamicBase = "file" | "project";
type ParsedDynamicToken = { kind: "base"; base: DynamicBase } | { kind: "literal"; value: string };

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
  if (compact === "__dirname" || compact === "__filename" || compact === "import.meta.url") {
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

function buildRelativeSpecifier(fromFile: string, targetPath: string): string | null {
  const fromDir = path.dirname(fromFile);
  const rel = normalizePath(path.relative(fromDir, targetPath));
  if (!rel) return null;
  return rel.startsWith(".") ? rel : `./${rel}`;
}

export function extractJsTsDynamicSpecifiers(source: string, fromFile: string, projectRoot: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  try {
    const src = stripJsLikeComments(source);
    const seen = new Set<string>();
    const addSpec = (spec: string | null) => {
      if (!spec || seen.has(spec)) return;
      seen.add(spec);
      out.push({ spec, resolved: "heuristic", confidence: 0.7 });
    };
    const pathCallRe = /(?<!["'`])\b(?:require|import)\s*\(\s*(path\.(?:join|resolve)\s*\([^)]*\))\s*\)/g;
    for (const match of src.matchAll(pathCallRe)) {
      const argText = match[1] ?? "";
      const parsed = parsePathCallArg(argText);
      if (!parsed) continue;
      const baseDir = parsed.base === "file" ? path.dirname(fromFile) : projectRoot;
      const targetPath = path.resolve(baseDir, ...parsed.segments);
      addSpec(buildRelativeSpecifier(fromFile, targetPath));
    }
    const urlCallRe = /(?<!["'`])\b(?:require|import)\s*\(\s*(new\s+URL\s*\([^)]*\))\s*\)/g;
    for (const match of src.matchAll(urlCallRe)) {
      const argText = match[1] ?? "";
      const parsed = parseNewUrlArg(argText);
      if (!parsed) continue;
      const baseDir = path.dirname(fromFile);
      const targetPath = path.resolve(baseDir, ...parsed.segments);
      addSpec(buildRelativeSpecifier(fromFile, targetPath));
    }
  } catch {
    /* parse fallback: ignore */
  }
  return out;
}

export function extractPythonSpecifiers(source: string): string[] {
  const out: string[] = [];
  try {
    const cleaned = stripPythonCommentsAndStrings(source);
    const reImport = /^\s*import\s+([A-Za-z_][\w.]*)/gm;
    for (const m of cleaned.matchAll(reImport)) out.push(m[1]!);
    const reFrom = /^\s*from\s+(\.+(?:[A-Za-z_][\w.]*)?|[A-Za-z_][\w.]*)\s+import/gm;
    for (const m of cleaned.matchAll(reFrom)) out.push(m[1]!);
  } catch {
    /* parse fallback: ignore */
  }
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

async function loadTsconfigConfig(cfgPath: string): Promise<{ baseUrl: string; paths: Record<string, string[]> }> {
  const raw = await fsp.readFile(cfgPath, "utf8");
  const json = parseJsonc<TsconfigJson>(raw);
  const cfgDir = path.dirname(cfgPath);
  const co = json.compilerOptions;
  const baseUrlRaw = co?.baseUrl ?? ".";
  const baseUrl = path.isAbsolute(baseUrlRaw) ? baseUrlRaw : path.resolve(cfgDir, baseUrlRaw);
  const paths: Record<string, string[]> = co?.paths ?? {};

  if (json.extends) {
    const extendsPath = path.resolve(cfgDir, json.extends);
    if (await fileExists(extendsPath)) {
      const parent = await loadTsconfigConfig(extendsPath);
      const mergedPaths: Record<string, string[]> = { ...parent.paths };

      // Adjust parent paths to be relative to child baseUrl
      for (const [key, patterns] of Object.entries(parent.paths)) {
        mergedPaths[key] = patterns.map((p) => {
          const abs = path.resolve(parent.baseUrl, p);
          const rel = path.relative(baseUrl, abs).replace(/\\/g, "/");
          return rel;
        });
      }

      // Child paths overwrite parent paths for the same key
      // and ensure they are also normalized
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

type MinimalPackageJson = {
  name?: string;
  main?: string;
  exports?: unknown;
  workspaces?: string[] | { packages?: string[] };
};

type MinimalLernaJson = {
  packages?: string[];
};

export async function loadWorkspaceConfig(projectRoot: string): Promise<WorkspaceConfig | undefined> {
  const root = (await findWorkspaceRoot(projectRoot)) ?? projectRoot;
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
      const packages = (rootPkg.workspaces as { packages?: unknown }).packages;
      if (Array.isArray(packages)) {
        for (const g of packages) addWorkspaceGlob(workspaceGlobs, g);
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

export async function resolveWorkspacePackage(
  spec: string,
  ws: WorkspaceConfig | undefined,
  resolutionExtensions?: readonly string[],
): Promise<string | null> {
  if (!ws) return null;
  const { name, subpath } = resolvePackageSubpath(spec);
  const pkg = ws.packages.get(name);
  if (!pkg) return null;
  const baseDir = pkg.path;
  for (const candidate of listWorkspacePackageResolutionCandidates(spec, ws, resolutionExtensions)) {
    if (await fileExists(candidate)) {
      return path.resolve(candidate);
    }
  }
  return baseDir;
}

export type FileId = string;

const DEFAULT_RESOLUTION_EXTENSIONS = [
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
  ".php",
  ".html",
  ".vue",
  ".svelte",
  ".go",
  ".java",
  ".cs",
  ".rb",
  ".rs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".c++",
  ".hpp",
  ".hh",
  ".hxx",
  ".ipp",
  ".tpp",
  ".inl",
  ".kt",
  ".kts",
  ".swift",
] as const;

export const GRAPH_ONLY_RESOLUTION_EXTENSIONS = [
  ".md",
  ".mdx",
  ".astro",
  ".hbs",
  ".handlebars",
  ".rst",
  ".adoc",
  ".asciidoc",
] as const;

const GRAPH_ONLY_LANGUAGE_DOCUMENT_RESOLUTION_EXTENSIONS: Record<string, readonly string[]> = {
  markdown: [".md", ".mdx"],
  mdx: [".mdx", ".md"],
  astro: [".astro"],
  hbs: [".hbs", ".handlebars"],
  rst: [".rst"],
  adoc: [".adoc", ".asciidoc"],
};

const GRAPH_ONLY_LANGUAGE_SOURCE_RESOLUTION_EXTENSIONS: Record<string, readonly string[]> = {
  mdx: DEFAULT_RESOLUTION_EXTENSIONS,
  astro: [".astro", ...DEFAULT_RESOLUTION_EXTENSIONS],
};

const EXPLICIT_SPECIFIER_EXTENSION_FAMILIES: Record<string, readonly string[]> = {
  ".ts": [".ts", ".tsx", ".js", ".jsx"],
  ".tsx": [".tsx", ".jsx", ".ts", ".js"],
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".jsx": [".tsx", ".jsx", ".ts", ".js"],
  ".mts": [".mts", ".mjs"],
  ".mjs": [".mts", ".mjs"],
  ".cts": [".cts", ".cjs"],
  ".cjs": [".cts", ".cjs"],
};

export function getGraphOnlyResolutionExtensions(
  languageId: string,
  resolutionKind: "document" | "source" = "document",
): string[] {
  const normalizedLanguageId = languageId.toLowerCase();
  const preferredExtensions =
    resolutionKind === "source"
      ? (GRAPH_ONLY_LANGUAGE_SOURCE_RESOLUTION_EXTENSIONS[normalizedLanguageId] ?? DEFAULT_RESOLUTION_EXTENSIONS)
      : (GRAPH_ONLY_LANGUAGE_DOCUMENT_RESOLUTION_EXTENSIONS[normalizedLanguageId] ?? GRAPH_ONLY_RESOLUTION_EXTENSIONS);
  const includeGraphOnlyFallbacks = resolutionKind === "document";
  return Array.from(
    new Set([
      ...preferredExtensions,
      ...(includeGraphOnlyFallbacks ? GRAPH_ONLY_RESOLUTION_EXTENSIONS : []),
      ...DEFAULT_RESOLUTION_EXTENSIONS,
    ]),
  );
}

function getResolutionExtensions(resolutionExtensions?: readonly string[]): string[] {
  const extensions = resolutionExtensions === undefined ? DEFAULT_RESOLUTION_EXTENSIONS : resolutionExtensions;
  return Array.from(new Set(extensions));
}

export function listResolutionCandidates(base: string, resolutionExtensions?: readonly string[]): string[] {
  const extensions = getResolutionExtensions(resolutionExtensions);
  const baseExt = path.extname(base).toLowerCase();
  if (!baseExt) {
    return Array.from(
      new Set([
        base,
        ...extensions.map((extension) => `${base}${extension}`),
        ...extensions.map((extension) => path.join(base, `index${extension}`)),
      ]),
    );
  }

  const compatibleExtensions = EXPLICIT_SPECIFIER_EXTENSION_FAMILIES[baseExt] ?? [baseExt];
  const baseWithoutExt = base.slice(0, -baseExt.length);
  const candidates = compatibleExtensions
    .filter((extension) => extension === baseExt || extensions.includes(extension))
    .map((extension) => `${baseWithoutExt}${extension}`);
  return candidates.length > 0 ? Array.from(new Set(candidates)) : [base];
}

async function findFirstExistingResolutionCandidate(
  base: string,
  resolutionExtensions?: readonly string[],
): Promise<string | null> {
  for (const candidate of listResolutionCandidates(base, resolutionExtensions)) {
    if (await fileExists(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

async function findFirstExistingScssPartialCandidate(base: string): Promise<string | null> {
  const basename = path.basename(base);
  if (!basename || basename.startsWith("_")) return null;
  const baseExt = path.extname(base).toLowerCase();
  if (baseExt && baseExt !== ".scss") return null;
  const partialBasename = baseExt ? `_${basename}` : `_${basename}.scss`;
  const partialPath = path.join(path.dirname(base), partialBasename);
  return (await fileExists(partialPath)) ? path.resolve(partialPath) : null;
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

export async function resolvePathLikeModule(
  projectRoot: string,
  spec: string,
  resolutionExtensions?: readonly string[],
): Promise<string | null> {
  const parts = spec.split(/[/.:]+/).filter(Boolean);
  const exts = getResolutionExtensions(resolutionExtensions);

  // Try matching progressively shorter prefixes (e.g. a.b.c -> a/b/c, a/b, a)
  for (let i = parts.length; i > 0; i--) {
    const sub = parts.slice(0, i);
    const p = path.join(projectRoot, ...sub);

    for (const e of exts) {
      if (await fileExists(p + e)) return path.resolve(p + e);
    }
    for (const e of exts) {
      if (await fileExists(path.join(p, "index" + e))) return path.resolve(path.join(p, "index" + e));
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

type KotlinSymbolIndexEntry = {
  packageName: string | null;
  symbols: Set<string>;
};

type JavaSymbolIndexEntry = {
  packageName: string | null;
  symbols: Set<string>;
};

type PhpSymbolKind = "class" | "function" | "const";

type PhpPackageSymbolIndexEntry = {
  packageName: string;
  symbols: Set<string>;
  kindsBySymbol: Map<string, Set<PhpSymbolKind>>;
};

type PhpSymbolIndexEntry = {
  packageName: string | null;
  symbols: Set<string>;
  kindsBySymbol: Map<string, Set<PhpSymbolKind>>;
  packageEntries: PhpPackageSymbolIndexEntry[];
};

type PhpComposerConfig = {
  psr4: Map<string, string[]>;
  psr0: Map<string, string[]>;
  classmap: string[];
  excludeFromClassmap: string[];
  files: string[];
};

type LanguageProjectSymbolIndex = {
  files: string[];
  filesByPackage: Map<string, string[]>;
  filesByPackageSymbol: Map<string, Map<string, string[]>>;
};

const kotlinImportResolutionCache = new Map<string, string | null>();
const kotlinSymbolIndexCache = new Map<string, KotlinSymbolIndexEntry>();
const kotlinProjectSymbolIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();
const javaImportResolutionCache = new Map<string, string | null>();
const javaSymbolIndexCache = new Map<string, JavaSymbolIndexEntry>();
const javaProjectSymbolIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();
const phpImportResolutionCache = new Map<string, string | null>();
const phpSymbolIndexCache = new Map<string, PhpSymbolIndexEntry>();
const phpProjectSymbolIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();
const phpComposerConfigCache = new Map<string, Promise<PhpComposerConfig | null>>();
const phpComposerAutoloadFileCache = new Map<string, Promise<Set<string>>>();

async function listProjectLanguageFiles(projectRoot: string, patterns: string[]): Promise<string[]> {
  return await listProjectFiles(projectRoot, patterns);
}

function addProjectSymbolFile(
  index: LanguageProjectSymbolIndex,
  packageName: string,
  filePath: string,
  symbols: Set<string>,
): void {
  const packageFiles = index.filesByPackage.get(packageName) ?? [];
  packageFiles.push(filePath);
  index.filesByPackage.set(packageName, packageFiles);

  let symbolFiles = index.filesByPackageSymbol.get(packageName);
  if (!symbolFiles) {
    symbolFiles = new Map<string, string[]>();
    index.filesByPackageSymbol.set(packageName, symbolFiles);
  }
  for (const symbolName of symbols) {
    const files = symbolFiles.get(symbolName) ?? [];
    files.push(filePath);
    symbolFiles.set(symbolName, files);
  }
}

function sortProjectSymbolIndex(index: LanguageProjectSymbolIndex): void {
  for (const [packageName, files] of index.filesByPackage) {
    files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
    index.filesByPackage.set(packageName, files);
  }
  for (const symbolFiles of index.filesByPackageSymbol.values()) {
    for (const [symbolName, files] of symbolFiles) {
      files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
      symbolFiles.set(symbolName, files);
    }
  }
}

async function buildProjectSymbolIndex<TEntry extends { packageName: string | null; symbols: Set<string> }>(
  projectRoot: string,
  patterns: string[],
  readIndexEntry: (filePath: string) => Promise<TEntry>,
): Promise<LanguageProjectSymbolIndex> {
  const files = await listProjectLanguageFiles(projectRoot, patterns);
  const index: LanguageProjectSymbolIndex = {
    files,
    filesByPackage: new Map<string, string[]>(),
    filesByPackageSymbol: new Map<string, Map<string, string[]>>(),
  };

  const indexEntries = await mapLimit(files, 8, async (filePath) => {
    try {
      const entry = await readIndexEntry(filePath);
      return { filePath, entry };
    } catch {
      // Ignore unreadable files and keep indexing the project.
      return null;
    }
  });

  for (const indexEntry of indexEntries) {
    if (!indexEntry || indexEntry.entry.packageName === null) continue;
    addProjectSymbolFile(index, indexEntry.entry.packageName, indexEntry.filePath, indexEntry.entry.symbols);
  }

  sortProjectSymbolIndex(index);
  return index;
}

function getOrCreateProjectSymbolIndex(
  cache: Map<string, Promise<LanguageProjectSymbolIndex>>,
  projectRoot: string,
  buildIndex: () => Promise<LanguageProjectSymbolIndex>,
): Promise<LanguageProjectSymbolIndex> {
  const cached = cache.get(projectRoot);
  if (cached) return cached;
  const pending = buildIndex().catch((error) => {
    cache.delete(projectRoot);
    throw error;
  });
  cache.set(projectRoot, pending);
  return pending;
}

async function getKotlinProjectSymbolIndex(projectRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(
    kotlinProjectSymbolIndexCache,
    projectRoot,
    async () => await buildProjectSymbolIndex(projectRoot, ["**/*.kt", "**/*.kts"], readKotlinSymbolIndex),
  );
}

async function getJavaProjectSymbolIndex(projectRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(
    javaProjectSymbolIndexCache,
    projectRoot,
    async () => await buildProjectSymbolIndex(projectRoot, ["**/*.java"], readJavaSymbolIndex),
  );
}

async function getJvmProjectSymbolIndex(
  projectRoot: string,
  languageId: "java" | "kotlin",
): Promise<LanguageProjectSymbolIndex> {
  return languageId === "kotlin"
    ? await getKotlinProjectSymbolIndex(projectRoot)
    : await getJavaProjectSymbolIndex(projectRoot);
}

export async function resolveJvmPackageImportPaths(
  projectRoot: string,
  spec: string,
  languageId: "java" | "kotlin",
): Promise<string[]> {
  const projectIndex = await getJvmProjectSymbolIndex(projectRoot, languageId);
  const packageCandidates = projectIndex.filesByPackage.get(spec) ?? [];
  return packageCandidates.map((candidate) => path.resolve(candidate));
}

async function getPhpProjectSymbolIndex(projectRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(phpProjectSymbolIndexCache, projectRoot, async () => {
    const files = await listProjectLanguageFiles(projectRoot, ["**/*.php"]);
    const index: LanguageProjectSymbolIndex = {
      files,
      filesByPackage: new Map<string, string[]>(),
      filesByPackageSymbol: new Map<string, Map<string, string[]>>(),
    };

    const indexEntries = await mapLimit(files, 8, async (filePath) => {
      try {
        const entry = await readPhpSymbolIndex(filePath);
        return { filePath, entry };
      } catch {
        return null;
      }
    });

    for (const indexEntry of indexEntries) {
      if (!indexEntry) continue;
      for (const packageEntry of indexEntry.entry.packageEntries) {
        addProjectSymbolFile(index, packageEntry.packageName, indexEntry.filePath, packageEntry.symbols);
      }
    }

    sortProjectSymbolIndex(index);
    return index;
  });
}

function stripInlineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line.trim() : line.slice(0, idx).trim();
}

async function findNearestFile(startDir: string, stopDir: string, fileName: string): Promise<string | null> {
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
    const replaceMatch = line.match(/^replace\s+(\S+)(?:\s+v[^\s]+)?\s+=>\s+(\S+)/);
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
    .filter((entry) => entry.isFile() && entry.name.endsWith(".go") && !entry.name.endsWith("_test.go"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (goFiles.length === 0) return null;
  return path.join(dirPath, goFiles[0] ?? "");
}

function isGoStdLib(spec: string): boolean {
  const base = spec.split("/")[0] ?? "";
  return base.length > 0 && !base.includes(".");
}

async function resolveGoModuleImport(moduleInfo: GoModuleInfo, spec: string): Promise<string | null> {
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

export async function resolveGoImportPath(projectRoot: string, fromFile: string, spec: string): Promise<string | null> {
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

async function readKotlinSymbolIndex(filePath: string): Promise<KotlinSymbolIndexEntry> {
  const cached = kotlinSymbolIndexCache.get(filePath);
  if (cached) return cached;

  const source = await fsp.readFile(filePath, "utf8");
  const packageName = source.match(/^\s*package\s+([A-Za-z_][\w.]*)/m)?.[1] ?? null;
  const symbols = new Set<string>();
  const declarationPattern = /\b(?:class|object|fun|typealias|interface)\s+([A-Za-z_][\w]*)\b/g;
  for (const match of source.matchAll(declarationPattern)) {
    const symbolName = match[1];
    if (symbolName) symbols.add(symbolName);
  }

  const entry = { packageName, symbols };
  kotlinSymbolIndexCache.set(filePath, entry);
  return entry;
}

async function resolveKotlinImportPath(projectRoot: string, spec: string): Promise<string | null> {
  const cacheKey = `${projectRoot}::${spec}`;
  const cached = kotlinImportResolutionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const parts = spec.split(".").filter(Boolean);
  const projectIndex = await getKotlinProjectSymbolIndex(projectRoot);
  if (parts.length < 2) {
    const packageCandidates = projectIndex.filesByPackage.get(spec) ?? [];
    const resolved = packageCandidates[0] ? path.resolve(packageCandidates[0]) : null;
    kotlinImportResolutionCache.set(cacheKey, resolved);
    return resolved;
  }

  const importedName = parts[parts.length - 1]!;
  const packageName = importedName === "*" ? parts.slice(0, -1).join(".") : parts.slice(0, -1).join(".");
  const packageCandidates = projectIndex.filesByPackage.get(packageName) ?? [];

  if (importedName === "*") {
    const resolved = packageCandidates[0] ? path.resolve(packageCandidates[0]) : null;
    kotlinImportResolutionCache.set(cacheKey, resolved);
    return resolved;
  }

  const symbolFiles = projectIndex.filesByPackageSymbol.get(packageName)?.get(importedName) ?? [];
  const resolvedCandidate = symbolFiles[0] ?? packageCandidates[0] ?? null;
  const resolved = resolvedCandidate ? path.resolve(resolvedCandidate) : null;
  kotlinImportResolutionCache.set(cacheKey, resolved);
  return resolved;
}

async function readJavaSymbolIndex(filePath: string): Promise<JavaSymbolIndexEntry> {
  const cached = javaSymbolIndexCache.get(filePath);
  if (cached) return cached;

  const source = await fsp.readFile(filePath, "utf8");
  const packageName = source.match(/^\s*package\s+([A-Za-z_][\w.]*)\s*;/m)?.[1] ?? null;
  const symbols = new Set<string>();
  const declarationPattern = /\b(?:class|interface|enum)\s+([A-Za-z_][\w]*)\b/g;
  for (const match of source.matchAll(declarationPattern)) {
    const symbolName = match[1];
    if (symbolName) symbols.add(symbolName);
  }

  const entry = { packageName, symbols };
  javaSymbolIndexCache.set(filePath, entry);
  return entry;
}

async function readPhpSymbolIndex(filePath: string): Promise<PhpSymbolIndexEntry> {
  const cached = phpSymbolIndexCache.get(filePath);
  if (cached) return cached;

  const source = await fsp.readFile(filePath, "utf8");
  const packageEntries = extractPhpTopLevelPackageEntries(source);
  const primaryEntry = packageEntries[0] ?? {
    packageName: "",
    symbols: new Set<string>(),
    kindsBySymbol: new Map<string, Set<PhpSymbolKind>>(),
  };
  const symbols = new Set<string>();
  const kindsBySymbol = new Map<string, Set<PhpSymbolKind>>();
  const addSymbol = (symbolName: string, symbolKind: PhpSymbolKind): void => {
    symbols.add(symbolName);
    const currentKinds = kindsBySymbol.get(symbolName) ?? new Set();
    currentKinds.add(symbolKind);
    kindsBySymbol.set(symbolName, currentKinds);
  };
  for (const packageEntry of packageEntries) {
    for (const symbolName of packageEntry.symbols) {
      const symbolKinds = packageEntry.kindsBySymbol.get(symbolName);
      if (!symbolKinds) continue;
      for (const symbolKind of symbolKinds) {
        addSymbol(symbolName, symbolKind);
      }
    }
  }

  const entry = {
    packageName: primaryEntry.packageName,
    symbols,
    kindsBySymbol,
    packageEntries,
  };
  phpSymbolIndexCache.set(filePath, entry);
  return entry;
}

type PhpScannerToken =
  | { type: "word"; value: string }
  | { type: "brace_open" | "brace_close" | "paren_open" | "paren_close" }
  | { type: "semicolon" | "comma" | "backslash" | "ampersand" | "equals" };

function extractPhpTopLevelPackageEntries(source: string): PhpPackageSymbolIndexEntry[] {
  const packageEntries = new Map<string, PhpPackageSymbolIndexEntry>();
  const getPackageEntry = (packageName: string): PhpPackageSymbolIndexEntry => {
    const existing = packageEntries.get(packageName);
    if (existing) return existing;
    const entry: PhpPackageSymbolIndexEntry = {
      packageName,
      symbols: new Set<string>(),
      kindsBySymbol: new Map<string, Set<PhpSymbolKind>>(),
    };
    packageEntries.set(packageName, entry);
    return entry;
  };
  const addSymbol = (packageName: string, symbolName: string, symbolKind: PhpSymbolKind): void => {
    const entry = getPackageEntry(packageName);
    entry.symbols.add(symbolName);
    const symbolKinds = entry.kindsBySymbol.get(symbolName) ?? new Set();
    symbolKinds.add(symbolKind);
    entry.kindsBySymbol.set(symbolName, symbolKinds);
  };
  const tokens = tokenizePhpSource(source);
  let braceDepth = 0;
  const namespaceBlockDepths: Array<{ packageName: string; depth: number }> = [];
  const classLikeDepths: number[] = [];
  const functionLikeDepths: number[] = [];
  let activeNamespace = "";
  let pendingBlock: { type: "class" | "function" } | null = null;

  const inDeclarationBody = (): boolean => classLikeDepths.length > 0 || functionLikeDepths.length > 0;
  const currentNamespace = (): string =>
    namespaceBlockDepths[namespaceBlockDepths.length - 1]?.packageName ?? activeNamespace;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (token.type === "brace_open") {
      braceDepth += 1;
      if (pendingBlock?.type === "class") {
        classLikeDepths.push(braceDepth);
      } else if (pendingBlock?.type === "function") {
        functionLikeDepths.push(braceDepth);
      }
      pendingBlock = null;
      continue;
    }

    if (token.type === "brace_close") {
      if (classLikeDepths[classLikeDepths.length - 1] === braceDepth) {
        classLikeDepths.pop();
      }
      if (functionLikeDepths[functionLikeDepths.length - 1] === braceDepth) {
        functionLikeDepths.pop();
      }
      if (namespaceBlockDepths[namespaceBlockDepths.length - 1]?.depth === braceDepth) {
        namespaceBlockDepths.pop();
      }
      braceDepth = Math.max(0, braceDepth - 1);
      pendingBlock = null;
      continue;
    }

    if (token.type === "semicolon") {
      pendingBlock = null;
      continue;
    }

    if (token.type !== "word") {
      continue;
    }

    if (token.value === "namespace" && !inDeclarationBody()) {
      let packageName = "";
      let lookahead = index + 1;
      while (lookahead < tokens.length) {
        const nextToken = tokens[lookahead];
        if (!nextToken) break;
        if (nextToken.type === "word") {
          packageName += nextToken.value;
          lookahead += 1;
          continue;
        }
        if (nextToken.type === "backslash") {
          packageName += "\\";
          lookahead += 1;
          continue;
        }
        if (nextToken.type === "brace_open") {
          braceDepth += 1;
          namespaceBlockDepths.push({ packageName, depth: braceDepth });
          index = lookahead;
          break;
        }
        if (nextToken.type === "semicolon") {
          activeNamespace = packageName;
          index = lookahead;
          break;
        }
        lookahead += 1;
      }
      continue;
    }

    if (
      (token.value === "class" || token.value === "interface" || token.value === "trait" || token.value === "enum") &&
      !inDeclarationBody()
    ) {
      let lookahead = index + 1;
      let symbolName: string | null = null;
      while (lookahead < tokens.length) {
        const nextToken = tokens[lookahead];
        if (!nextToken) break;
        if (nextToken.type === "word") {
          symbolName = nextToken.value;
          break;
        }
        if (nextToken.type === "brace_open" || nextToken.type === "semicolon") {
          break;
        }
        lookahead += 1;
      }
      if (symbolName) {
        addSymbol(currentNamespace(), symbolName, "class");
      }
      pendingBlock = { type: "class" };
      continue;
    }

    if (token.value === "function" && !inDeclarationBody()) {
      let lookahead = index + 1;
      if (tokens[lookahead]?.type === "ampersand") {
        lookahead += 1;
      }
      const nextToken = tokens[lookahead];
      if (nextToken?.type === "word") {
        addSymbol(currentNamespace(), nextToken.value, "function");
      }
      pendingBlock = { type: "function" };
      continue;
    }

    if (token.value === "const" && !inDeclarationBody()) {
      let lookahead = index + 1;
      let expectingName = true;
      while (lookahead < tokens.length) {
        const nextToken = tokens[lookahead];
        if (!nextToken || nextToken.type === "semicolon") {
          index = lookahead;
          break;
        }
        if (nextToken.type === "comma") {
          expectingName = true;
          lookahead += 1;
          continue;
        }
        if (nextToken.type === "equals") {
          expectingName = false;
          lookahead += 1;
          continue;
        }
        if (nextToken.type === "word" && expectingName) {
          addSymbol(currentNamespace(), nextToken.value, "const");
          expectingName = false;
          lookahead += 1;
          continue;
        }
        lookahead += 1;
      }
    }
  }

  if (packageEntries.size === 0) {
    packageEntries.set("", {
      packageName: "",
      symbols: new Set<string>(),
      kindsBySymbol: new Map<string, Set<PhpSymbolKind>>(),
    });
  }

  return Array.from(packageEntries.values()).sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function tokenizePhpSource(source: string): PhpScannerToken[] {
  const tokens: PhpScannerToken[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (/\s/.test(ch)) continue;

    if (ch === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      index += 2;
      while (index < source.length - 1 && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    if (ch === "#" && next === "[") {
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        const current = source[index] ?? "";
        const afterCurrent = source[index + 1] ?? "";
        if (current === "'" || current === '"') {
          const quote = current;
          index += 1;
          while (index < source.length) {
            if (source[index] === "\\") {
              index += 2;
              continue;
            }
            if (source[index] === quote) break;
            index += 1;
          }
          index += 1;
          continue;
        }
        if (current === "/" && afterCurrent === "*") {
          index += 2;
          while (index < source.length - 1 && !(source[index] === "*" && source[index + 1] === "/")) {
            index += 1;
          }
          index += 2;
          continue;
        }
        if (current === "[" || current === "(" || current === "{") {
          depth += 1;
          index += 1;
          continue;
        }
        if (current === "]" || current === ")" || current === "}") {
          depth -= 1;
          index += 1;
          continue;
        }
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (ch === "#") {
      index += 1;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        index += 1;
      }
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end] ?? "")) {
        end += 1;
      }
      tokens.push({ type: "word", value: source.slice(index, end) });
      index = end - 1;
      continue;
    }

    if (ch === "{") {
      tokens.push({ type: "brace_open" });
      continue;
    }
    if (ch === "}") {
      tokens.push({ type: "brace_close" });
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "paren_open" });
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "paren_close" });
      continue;
    }
    if (ch === ";") {
      tokens.push({ type: "semicolon" });
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma" });
      continue;
    }
    if (ch === "\\") {
      tokens.push({ type: "backslash" });
      continue;
    }
    if (ch === "&") {
      tokens.push({ type: "ampersand" });
      continue;
    }
    if (ch === "=") {
      tokens.push({ type: "equals" });
    }
  }

  return tokens;
}

function readComposerNamespaceDirs(value: unknown, composerDir: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!value || typeof value !== "object") {
    return result;
  }
  for (const [prefix, rawTarget] of Object.entries(value as Record<string, unknown>)) {
    const targets = Array.isArray(rawTarget) ? rawTarget : [rawTarget];
    const dirs = targets
      .filter((target): target is string => typeof target === "string")
      .map((target) => resolveComposerPath(target, composerDir));
    if (dirs.length > 0) {
      result.set(prefix, dirs);
    }
  }
  return result;
}

function mergeComposerNamespaceDirMaps(...maps: Map<string, string[]>[]): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const map of maps) {
    for (const [prefix, dirs] of map) {
      const currentDirs = merged.get(prefix) ?? [];
      const dedupedDirs = Array.from(new Set([...currentDirs, ...dirs]));
      merged.set(prefix, dedupedDirs);
    }
  }
  return merged;
}

function resolveComposerPath(entry: string, composerDir: string): string {
  if (entry.startsWith("/") || entry.startsWith("\\")) {
    return path.resolve(composerDir, `.${entry}`);
  }
  if (/^[A-Za-z]:[\\/]/.test(entry) || path.isAbsolute(entry)) {
    return path.resolve(entry);
  }
  return path.resolve(composerDir, entry);
}

function readComposerStringList(value: unknown, composerDir: string): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => resolveComposerPath(entry, composerDir));
}

async function loadPhpComposerConfig(composerPath: string): Promise<PhpComposerConfig | null> {
  const cached = phpComposerConfigCache.get(composerPath);
  if (cached) return await cached;

  const pending = (async () => {
    try {
      const raw = await fsp.readFile(composerPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const composerDir = path.dirname(composerPath);
      const autoload =
        parsed.autoload && typeof parsed.autoload === "object" ? (parsed.autoload as Record<string, unknown>) : {};
      const autoloadDev =
        parsed["autoload-dev"] && typeof parsed["autoload-dev"] === "object"
          ? (parsed["autoload-dev"] as Record<string, unknown>)
          : {};

      const psr4 = mergeComposerNamespaceDirMaps(
        readComposerNamespaceDirs(autoload["psr-4"], composerDir),
        readComposerNamespaceDirs(autoloadDev["psr-4"], composerDir),
      );
      const psr0 = mergeComposerNamespaceDirMaps(
        readComposerNamespaceDirs(autoload["psr-0"], composerDir),
        readComposerNamespaceDirs(autoloadDev["psr-0"], composerDir),
      );
      const classmap = [
        ...readComposerStringList(autoload["classmap"], composerDir),
        ...readComposerStringList(autoloadDev["classmap"], composerDir),
      ];
      const excludeFromClassmap = [
        ...readComposerStringList(autoload["exclude-from-classmap"], composerDir),
        ...readComposerStringList(autoloadDev["exclude-from-classmap"], composerDir),
      ];
      const files = [
        ...readComposerStringList(autoload["files"], composerDir),
        ...readComposerStringList(autoloadDev["files"], composerDir),
      ];

      return { psr4, psr0, classmap, excludeFromClassmap, files };
    } catch {
      return null;
    }
  })();

  phpComposerConfigCache.set(composerPath, pending);
  return await pending;
}

function sortPhpComposerMappings(mappings: Map<string, string[]>): Array<[string, string[]]> {
  return Array.from(mappings.entries()).sort((left, right) => right[0].length - left[0].length);
}

async function resolvePhpPsr4MappedPath(spec: string, mappings: Map<string, string[]>): Promise<string | null> {
  const normalizedSpec = spec.replace(/^\\+/, "");
  const mappingEntries = sortPhpComposerMappings(mappings);

  for (const [prefix, dirs] of mappingEntries) {
    if (!normalizedSpec.startsWith(prefix)) continue;
    const suffix = normalizedSpec.slice(prefix.length).replace(/\\/g, "/");
    for (const dir of dirs) {
      const basePath = suffix ? path.join(dir, suffix) : dir;
      const resolved = await findFirstExistingResolutionCandidate(basePath, [".php"]);
      if (resolved) return resolved;
    }
  }

  return null;
}

function buildPhpPsr0RelativePath(spec: string, prefix: string): string | null {
  if (!spec.startsWith(prefix)) return null;
  const suffix = spec.slice(prefix.length);
  const namespaceParts = suffix.split("\\");
  const classPart = namespaceParts.pop() ?? "";
  const namespacePath = namespaceParts.filter(Boolean).join("/");
  const classPath = classPart.replace(/_/g, "/");
  return [namespacePath, classPath].filter(Boolean).join("/");
}

async function resolvePhpPsr0MappedPath(spec: string, mappings: Map<string, string[]>): Promise<string | null> {
  const normalizedSpec = spec.replace(/^\\+/, "");
  const mappingEntries = sortPhpComposerMappings(mappings);

  for (const [prefix, dirs] of mappingEntries) {
    const relativePath = buildPhpPsr0RelativePath(normalizedSpec, prefix);
    if (relativePath === null) continue;
    for (const dir of dirs) {
      const basePath = relativePath ? path.join(dir, relativePath) : dir;
      const resolved = await findFirstExistingResolutionCandidate(basePath, [".php"]);
      if (resolved) return resolved;
    }
  }

  return null;
}

async function resolvePhpSymbolImportPath(
  projectRoot: string,
  spec: string,
  preferredKind?: "class" | "function" | "const",
  allowedFiles?: Set<string>,
): Promise<string | null> {
  const normalizedSpec = spec.replace(/^\\+/, "");
  const projectIndex = await getPhpProjectSymbolIndex(projectRoot);
  const pickCandidate = async (candidates: string[], symbolName?: string): Promise<string | null> => {
    for (const candidate of candidates) {
      const resolvedCandidate = path.resolve(candidate);
      if (allowedFiles && !allowedFiles.has(resolvedCandidate)) {
        continue;
      }
      if (!symbolName || !preferredKind) {
        return resolvedCandidate;
      }
      const entry = await readPhpSymbolIndex(resolvedCandidate);
      const symbolKinds = entry.kindsBySymbol.get(symbolName);
      if (symbolKinds?.has(preferredKind)) {
        return resolvedCandidate;
      }
    }
    return null;
  };

  const exactNamespaceFiles = projectIndex.filesByPackage.get(normalizedSpec) ?? [];
  const exactNamespaceHit = await pickCandidate(exactNamespaceFiles);
  if (exactNamespaceHit) {
    return exactNamespaceHit;
  }

  const parts = normalizedSpec.split("\\").filter(Boolean);
  if (parts.length === 1) {
    const globalFiles = projectIndex.filesByPackageSymbol.get("")?.get(parts[0]!) ?? [];
    return await pickCandidate(globalFiles, parts[0]);
  }

  if (parts.length < 2) {
    return null;
  }

  const importedName = parts[parts.length - 1]!;
  const packageName = parts.slice(0, -1).join("\\");
  const symbolFiles = projectIndex.filesByPackageSymbol.get(packageName)?.get(importedName) ?? [];
  const symbolHit = await pickCandidate(symbolFiles, importedName);
  if (symbolHit) {
    return symbolHit;
  }

  const packageFiles = projectIndex.filesByPackage.get(packageName) ?? [];
  return await pickCandidate(packageFiles, importedName);
}

async function findPhpComposerPath(projectRoot: string, fromFile: string): Promise<string | null> {
  return (
    (await findNearestFile(path.dirname(fromFile), projectRoot, "composer.json")) ??
    ((await fileExists(path.join(projectRoot, "composer.json"))) ? path.join(projectRoot, "composer.json") : null)
  );
}

export async function getPhpComposerImplicitFiles(projectRoot: string, fromFile: string): Promise<string[]> {
  const composerPath = await findPhpComposerPath(projectRoot, fromFile);
  if (!composerPath) {
    return [];
  }

  const composerConfig = await loadPhpComposerConfig(composerPath);
  if (!composerConfig) {
    return [];
  }

  const deduped = new Set<string>();
  for (const filePath of composerConfig.files) {
    if (!(await fileExists(filePath))) continue;
    deduped.add(path.resolve(filePath));
  }
  return Array.from(deduped);
}

async function getPhpComposerAutoloadFiles(
  composerPath: string,
  composerConfig: PhpComposerConfig,
): Promise<Set<string>> {
  const cached = phpComposerAutoloadFileCache.get(composerPath);
  if (cached) {
    return await cached;
  }

  const pending = (async () => {
    const candidates = new Set<string>();
    const roots = new Set<string>([
      ...composerConfig.classmap,
      ...composerConfig.files,
      ...Array.from(composerConfig.psr4.values()).flat(),
      ...Array.from(composerConfig.psr0.values()).flat(),
    ]);

    for (const root of roots) {
      try {
        const stat = await fsp.stat(root);
        if (stat.isDirectory()) {
          const files = await listProjectFiles(root, ["**/*.php"]);
          for (const filePath of files) {
            if (isPhpComposerClassmapExcluded(filePath, composerConfig)) {
              continue;
            }
            candidates.add(path.resolve(filePath));
          }
          continue;
        }
        if (stat.isFile() && root.toLowerCase().endsWith(".php")) {
          if (isPhpComposerClassmapExcluded(root, composerConfig)) continue;
          candidates.add(path.resolve(root));
        }
      } catch {
        // Ignore missing Composer autoload roots.
      }
    }

    return candidates;
  })();

  phpComposerAutoloadFileCache.set(composerPath, pending);
  return await pending;
}

function isPhpComposerClassmapExcluded(filePath: string, composerConfig: PhpComposerConfig): boolean {
  const normalizedFile = normalizePath(path.resolve(filePath));
  return composerConfig.excludeFromClassmap.some((entry) => {
    const normalizedEntry = normalizePath(path.resolve(entry)).replace(/\/+$/, "");
    return normalizedFile === normalizedEntry || normalizedFile.startsWith(`${normalizedEntry}/`);
  });
}

async function resolvePhpImportPath(
  projectRoot: string,
  fromFile: string,
  spec: string,
  preferredKind?: "class" | "function" | "const",
): Promise<string | null> {
  const cacheKey = `${projectRoot}::${fromFile}::${spec}::${preferredKind ?? "any"}`;
  const cached = phpImportResolutionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const normalizedSpec = spec.trim();
  const isPathLike =
    normalizedSpec.startsWith(".") || normalizedSpec.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalizedSpec);
  if (isPathLike) {
    const resolved = await resolveSpecifier(fromFile, normalizedSpec, projectRoot, undefined, undefined, {
      resolutionExtensions: [".php"],
    });
    const fileResolved = typeof resolved === "string" ? resolved : null;
    phpImportResolutionCache.set(cacheKey, fileResolved);
    return fileResolved;
  }

  const composerPath = await findPhpComposerPath(projectRoot, fromFile);
  if (composerPath) {
    const composerConfig = await loadPhpComposerConfig(composerPath);
    if (composerConfig) {
      if (!preferredKind || preferredKind === "class") {
        const psr4Resolved = await resolvePhpPsr4MappedPath(normalizedSpec, composerConfig.psr4);
        if (psr4Resolved) {
          phpImportResolutionCache.set(cacheKey, psr4Resolved);
          return psr4Resolved;
        }
        const psr0Resolved = await resolvePhpPsr0MappedPath(normalizedSpec, composerConfig.psr0);
        if (psr0Resolved) {
          phpImportResolutionCache.set(cacheKey, psr0Resolved);
          return psr0Resolved;
        }
      }

      const autoloadFiles = await getPhpComposerAutoloadFiles(composerPath, composerConfig);
      const symbolResolved = await resolvePhpSymbolImportPath(
        projectRoot,
        normalizedSpec,
        preferredKind,
        autoloadFiles,
      );
      if (symbolResolved && !isPhpComposerClassmapExcluded(symbolResolved, composerConfig)) {
        phpImportResolutionCache.set(cacheKey, symbolResolved);
        return symbolResolved;
      }

      phpImportResolutionCache.set(cacheKey, null);
      return null;
    }
  }

  const symbolResolved = await resolvePhpSymbolImportPath(projectRoot, normalizedSpec, preferredKind);
  if (symbolResolved) {
    phpImportResolutionCache.set(cacheKey, symbolResolved);
    return symbolResolved;
  }

  const pathLikeResolved = await resolvePathLikeModule(projectRoot, normalizedSpec.replace(/\\/g, "/"), [".php"]);
  phpImportResolutionCache.set(cacheKey, pathLikeResolved);
  return pathLikeResolved;
}

async function resolveJavaImportPath(projectRoot: string, spec: string): Promise<string | null> {
  const cacheKey = `${projectRoot}::${spec}`;
  const cached = javaImportResolutionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const parts = spec.split(".").filter(Boolean);
  if (parts.length < 2) {
    javaImportResolutionCache.set(cacheKey, null);
    return null;
  }

  const projectIndex = await getJavaProjectSymbolIndex(projectRoot);
  const exactPackageFiles = projectIndex.filesByPackage.get(spec) ?? [];
  if (exactPackageFiles[0]) {
    const resolved = path.resolve(exactPackageFiles[0]);
    javaImportResolutionCache.set(cacheKey, resolved);
    return resolved;
  }

  const importedName = parts[parts.length - 1]!;
  const packageName = importedName === "*" ? parts.slice(0, -1).join(".") : parts.slice(0, -1).join(".");

  const packageCandidates = projectIndex.filesByPackage.get(packageName) ?? [];
  if (importedName === "*") {
    const resolved = packageCandidates[0] ? path.resolve(packageCandidates[0]) : null;
    javaImportResolutionCache.set(cacheKey, resolved);
    return resolved;
  }

  const symbolFiles = projectIndex.filesByPackageSymbol.get(packageName)?.get(importedName) ?? [];
  const resolvedCandidate = symbolFiles[0] ?? packageCandidates[0] ?? null;
  const resolved = resolvedCandidate ? path.resolve(resolvedCandidate) : null;
  javaImportResolutionCache.set(cacheKey, resolved);
  return resolved;
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
    phpImportType?: "class" | "function" | "const";
  },
): Promise<FileId | { external: string }> {
  if (languageId === "go") {
    const goResolved = await resolveGoImportPath(projectRoot, fromFile, spec);
    if (goResolved) return goResolved;
  }
  if (languageId === "kotlin") {
    const kotlinResolved = await resolveKotlinImportPath(projectRoot, spec);
    if (kotlinResolved) return kotlinResolved;
  }
  if (languageId === "java") {
    const javaResolved = await resolveJavaImportPath(projectRoot, spec);
    if (javaResolved) return javaResolved;
  }
  if (languageId === "php") {
    const phpResolved = await resolvePhpImportPath(projectRoot, fromFile, spec, opts?.phpImportType);
    if (phpResolved) return phpResolved;
  }

  return resolveSpecifier(fromFile, spec, projectRoot, opts?.matchPath, opts?.workspaceConfig, {
    resolveNodeModules: !!opts?.resolveNodeModules,
    ...(opts?.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
  });
}

export async function resolveSpecifier(
  fromFile: string,
  spec: string,
  projectRoot: string,
  matchPath?: MatchPathFn,
  workspaceConfig?: WorkspaceConfig,
  opts?: {
    resolveNodeModules?: boolean;
    resolutionHints?: string[];
    resolutionExtensions?: readonly string[];
    allowScssPartialResolution?: boolean;
  },
): Promise<FileId | { external: string }> {
  const resolutionHints = normalizeResolutionHints(opts?.resolutionHints);
  const hintKey = resolutionHints.join("|");
  const resolutionExtensions = getResolutionExtensions(opts?.resolutionExtensions);
  const extensionKey = resolutionExtensions.join("|");
  const cacheKey = `${fromFile}::${spec}::nm=${opts?.resolveNodeModules ? 1 : 0}::scssPartial=${opts?.allowScssPartialResolution ? 1 : 0}::hints=${hintKey}::exts=${extensionKey}`;
  const cached = resolveSpecifierCache.get(cacheKey);
  if (cached) return cached;
  const hasSchemePrefix = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec);
  const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(spec);
  if (!isWindowsAbsolutePath && (hasSchemePrefix || spec.startsWith("//"))) {
    const ext = { external: spec } as const;
    resolveSpecifierCache.set(cacheKey, ext);
    return ext;
  }

  const isRelativeOrAbsolute = spec.startsWith(".") || spec.startsWith("/") || isWindowsAbsolutePath;
  if (isRelativeOrAbsolute) {
    let base = path.resolve(path.dirname(fromFile), spec);
    if (isWindowsAbsolutePath) {
      base = spec;
    } else if (spec.startsWith("/")) {
      base = path.join(projectRoot, spec);
    }
    const hit = await findFirstExistingResolutionCandidate(base, resolutionExtensions);
    if (hit) {
      resolveSpecifierCache.set(cacheKey, hit);
      return hit;
    }
    if (opts?.allowScssPartialResolution && path.extname(fromFile).toLowerCase() === ".scss") {
      const partialHit = await findFirstExistingScssPartialCandidate(base);
      if (partialHit) {
        resolveSpecifierCache.set(cacheKey, partialHit);
        return partialHit;
      }
    }
    const ext = { external: spec } as const;
    resolveSpecifierCache.set(cacheKey, ext);
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
      resolutionExtensions,
    );
    if (m) {
      const cand = path.resolve(m);
      const hasExt = !!path.extname(cand);
      if (hasExt) {
        resolveSpecifierCache.set(cacheKey, cand);
        return cand;
      }
      for (const e of resolutionExtensions) {
        const pth = cand + e;
        try {
          fs.accessSync(pth, fs.constants.R_OK);
          resolveSpecifierCache.set(cacheKey, pth);
          return pth;
        } catch {
          /* file not found: try next */
        }
      }
      for (const e of resolutionExtensions) {
        const pth = path.join(cand, "index" + e);
        try {
          fs.accessSync(pth, fs.constants.R_OK);
          resolveSpecifierCache.set(cacheKey, pth);
          return pth;
        } catch {
          /* file not found: try next */
        }
      }
      resolveSpecifierCache.set(cacheKey, cand);
      return cand;
    }
  }

  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    const resolvedWs = await resolveWorkspacePackage(spec, workspaceConfig, opts?.resolutionExtensions);
    if (resolvedWs) {
      resolveSpecifierCache.set(cacheKey, resolvedWs);
      return resolvedWs;
    }
    const fromExt = path.extname(fromFile).toLowerCase();
    const prefersPathLikeFallback = [".go", ".java", ".cs", ".rb", ".rs", ".swift"].includes(fromExt);
    const shouldTryPathLikeFallback = prefersPathLikeFallback || spec.includes("/") || spec.includes(".");
    if (shouldTryPathLikeFallback) {
      // Try path-like fallback for languages that often map package-like names to source paths.
      const pathLike = await resolvePathLikeModule(projectRoot, spec, opts?.resolutionExtensions);
      if (pathLike) {
        resolveSpecifierCache.set(cacheKey, pathLike);
        return pathLike;
      }
    }
    if (opts?.resolveNodeModules) {
      const nm = await resolveFromNodeModules(spec, fromFile, projectRoot, opts?.resolutionExtensions);
      if (nm) {
        resolveSpecifierCache.set(cacheKey, nm);
        return nm;
      }
    }
  }
  if (resolutionHints.length > 0) {
    for (const hint of resolutionHints) {
      const baseDir = path.isAbsolute(hint) ? hint : path.resolve(projectRoot, hint);
      const base = path.resolve(baseDir, spec);
      const hit = await findFirstExistingResolutionCandidate(base, resolutionExtensions);
      if (hit) {
        resolveSpecifierCache.set(cacheKey, hit);
        return hit;
      }
    }
  }
  const ext = { external: spec } as const;
  resolveSpecifierCache.set(cacheKey, ext);
  return ext;
}

async function resolveFromNodeModules(
  spec: string,
  fromFile: string,
  _projectRoot: string,
  resolutionExtensions?: readonly string[],
): Promise<string | null> {
  try {
    // Walk up from the file directory to project root looking for node_modules
    let dir = path.dirname(fromFile);
    const parts = spec.split("/");
    const packageName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    const subpath = spec.startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/");
    while (true) {
      const nmDir = path.join(dir, "node_modules", packageName);
      if (await fileExists(nmDir)) {
        const pkgPath = path.join(nmDir, "package.json");
        const pkg = await loadJSON<MinimalPackageJson>(pkgPath);
        const baseDir = nmDir;
        const tryResolveRelative = async (rel: string): Promise<string | null> => {
          return await findFirstExistingResolutionCandidate(path.resolve(baseDir, rel), resolutionExtensions);
        };
        // Exports map handling (simplified)
        const pickExportTarget = (target: unknown): string | null => {
          if (!target) return null;
          if (typeof target === "string") return target;
          if (typeof target === "object" && target !== null) {
            const t = target as Record<string, unknown>;
            const cand = t.import ?? t.default ?? t.require ?? t.module;
            if (typeof cand === "string") return cand;
          }
          return null;
        };
        if (pkg?.exports) {
          const key = subpath ? `./${subpath}` : ".";
          if (typeof pkg.exports === "string" && key === ".") {
            const hit = await tryResolveRelative(pkg.exports);
            if (hit) return hit;
          } else if (typeof pkg.exports === "object" && pkg.exports !== null) {
            const map = pkg.exports as Record<string, unknown>;
            const target = map[key] ?? (key === "." ? map["."] : undefined);
            const rel = pickExportTarget(target);
            if (rel) {
              const hit = await tryResolveRelative(rel);
              if (hit) return hit;
            }
          }
        }
        if (subpath) {
          const hit = await findFirstExistingResolutionCandidate(path.join(baseDir, subpath), resolutionExtensions);
          if (hit) return hit;
        }
        const mainField = typeof pkg?.main === "string" ? path.resolve(baseDir, pkg.main) : null;
        if (mainField) {
          const mainHit = await findFirstExistingResolutionCandidate(mainField, resolutionExtensions);
          if (mainHit) return mainHit;
        }
        const indexHit = await findFirstExistingResolutionCandidate(path.join(baseDir, "index"), resolutionExtensions);
        if (indexHit) return indexHit;
        return baseDir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fs/access: ignore */
  }
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
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: projectRoot,
      env: process.env,
    });
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
        .filter((rel) => rel && !rel.startsWith("..") && !path.isAbsolute(rel) && rel !== "."),
    ),
  );
  if (relFiles.length === 0) return new Map();
  try {
    const { stdout: trackedStdout } = await execFileAsync("git", ["ls-files", "-z", "--", ...relFiles], {
      cwd: projectRoot,
      env: process.env,
    });
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
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += typeof chunk === "string" ? chunk : chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += typeof chunk === "string" ? chunk : chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`git hash-object failed (${code}): ${stderr || "unknown error"}`));
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

/**
 * List files changed in Git.
 * - base/head: compares commits in the explicit range `${base}..${head ?? "HEAD"}`.
 *   WORKTREE compares base to the working tree, and STAGED/INDEX compares base to the index.
 * - changedSince: runs `git diff <rev>` (that revision vs current working tree/index).
 */
export async function listChangedFiles(
  projectRoot: string,
  opts: {
    changedSince?: string | undefined;
    base?: string | undefined;
    head?: string | undefined;
  },
): Promise<string[]> {
  let args = ["diff", "--name-only", "--diff-filter=ACDMRTUXB"];
  if (opts.base) {
    const head = opts.head ?? "HEAD";
    args = gitDiffArgs(opts.base, head, ["--name-only", "--diff-filter=ACDMRTUXB"]);
  } else if (opts.changedSince) {
    args.push(opts.changedSince);
  } else {
    return [];
  }
  args.push("--");
  try {
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
  } catch (error) {
    throw createGitDiffError(projectRoot, args, error);
  }
}

/**
 * Get unified diff text from Git.
 * - base/head: compares commits in the explicit range `${base}..${head ?? "HEAD"}`.
 *   WORKTREE compares base to the working tree, and STAGED/INDEX compares base to the index.
 * - changedSince: runs `git diff <rev>` (that revision vs current working tree/index).
 */
export async function getUnifiedDiff(
  projectRoot: string,
  opts: {
    changedSince?: string | undefined;
    base?: string | undefined;
    head?: string | undefined;
  },
): Promise<string> {
  let args = ["diff", "--unified=0", "--no-color", "--diff-filter=ACDMRTUXB"];
  if (opts.base) {
    const head = opts.head ?? "HEAD";
    args = gitDiffArgs(opts.base, head, ["--unified=0", "--no-color", "--diff-filter=ACDMRTUXB"]);
  } else if (opts.changedSince) {
    args.push(opts.changedSince);
  } else {
    return "";
  }
  args.push("--");
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: projectRoot,
      env: process.env,
    });
    return stdout;
  } catch (error) {
    throw createGitDiffError(projectRoot, args, error);
  }
}

function createGitDiffError(projectRoot: string, args: string[], error: unknown): Error {
  let detail = stringifyUnknown(error);
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.trim()
  ) {
    detail = error.stderr.trim();
  }
  return new Error(`git ${args.join(" ")} failed in ${projectRoot}: ${detail}`);
}

async function findPythonPackageAnchor(startDir: string): Promise<string> {
  let dir = startDir;
  let topWithInit = startDir;
  while (true) {
    try {
      await fsp.access(path.join(dir, "__init__.py"), fs.constants.R_OK);
      topWithInit = dir;
    } catch {
      /* no __init__.py: continue */
    }
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
  importDotCount: number,
): Promise<FileId | { external: string }> {
  const cacheKey = `${fromFile}::${".".repeat(importDotCount)}${moduleName ?? ""}`;
  const cached = resolvePythonModuleCache.get(cacheKey);
  if (cached) return cached;
  const fromDir = path.dirname(fromFile);

  // If it's a relative import (dots > 0), start from current file's dir and walk up.
  // importDotCount = 1 means same dir (.), 2 means parent (..), etc.
  let startDir = fromDir;
  if (importDotCount > 0) {
    // 1 dot = current dir (0 steps up)
    // 2 dots = parent dir (1 step up)
    const stepsUp = Math.max(0, importDotCount - 1);
    for (let i = 0; i < stepsUp; i++) {
      startDir = path.dirname(startDir);
    }
  } else {
    // Absolute import: start from project root or find anchor?
    // Python sys.path usually includes current script dir, but for "absolute" imports
    // in a project structure, we usually mean relative to project root or nearest site-packages.
    // Here we try relative to project root first.
    startDir = projectRoot;
  }

  const parts = (moduleName ? moduleName.split(".") : []).filter(Boolean);
  const relPath = parts.length ? path.join(...parts) : "";

  // Candidates relative to the resolved start directory
  const candidates: string[] = [];
  if (relPath) {
    candidates.push(path.join(startDir, relPath + ".py"));
    candidates.push(path.join(startDir, relPath, "__init__.py"));
    candidates.push(path.join(startDir, relPath));
  } else if (importDotCount > 0) {
    // "from . import x" or "from .. import x" where moduleName is null
    // This resolves to the package defined by __init__.py in startDir
    candidates.push(path.join(startDir, "__init__.py"));
  }

  for (const c of candidates) {
    try {
      if (await isDirectory(c)) {
        const res = normalizePath(path.resolve(c));
        resolvePythonModuleCache.set(cacheKey, res);
        return res;
      }
      await fsp.access(c, fs.constants.R_OK);
      {
        const res = normalizePath(path.resolve(c));
        resolvePythonModuleCache.set(cacheKey, res);
        return res;
      }
    } catch {
      /* access failed: try next */
    }
  }

  // If absolute import, also try finding anchor in case project root isn't the package root
  if (importDotCount === 0 && moduleName) {
    let anchor: string;
    try {
      anchor = await findPythonPackageAnchor(fromDir);
    } catch {
      anchor = projectRoot;
    }

    const parts = moduleName.split(".");
    // Try relative to anchor parent (package structure)
    const parentPath = path.join(path.dirname(anchor), ...parts);
    // Try relative to anchor itself (script/root structure)
    const anchorPath = path.join(anchor, ...parts);

    const anchorCandidates = [
      parentPath + ".py",
      path.join(parentPath, "__init__.py"),
      parentPath,
      anchorPath + ".py",
      path.join(anchorPath, "__init__.py"),
      anchorPath,
    ];
    for (const c of anchorCandidates) {
      try {
        if (await isDirectory(c)) {
          const res = normalizePath(path.resolve(c));
          resolvePythonModuleCache.set(cacheKey, res);
          return res;
        }
        await fsp.access(c, fs.constants.R_OK);
        {
          const res = normalizePath(path.resolve(c));
          resolvePythonModuleCache.set(cacheKey, res);
          return res;
        }
      } catch {
        /* access failed: try next */
      }
    }
  }

  const ext = {
    external: ".".repeat(importDotCount) + (moduleName ?? ""),
  } as const;
  resolvePythonModuleCache.set(cacheKey, ext);
  return ext;
}

export function clearImportResolutionCaches(): void {
  kotlinImportResolutionCache.clear();
  kotlinSymbolIndexCache.clear();
  kotlinProjectSymbolIndexCache.clear();
  javaImportResolutionCache.clear();
  javaSymbolIndexCache.clear();
  javaProjectSymbolIndexCache.clear();
  phpImportResolutionCache.clear();
  phpSymbolIndexCache.clear();
  phpProjectSymbolIndexCache.clear();
  phpComposerConfigCache.clear();
  phpComposerAutoloadFileCache.clear();
  fileExistsCache.clear();
  resolveSpecifierCache.clear();
  resolvePythonModuleCache.clear();
}

export function clearResolutionCaches(): void {
  clearImportResolutionCaches();
  tsconfigCache.clear();
  workspaceCache.clear();
}

// ----------------- Caches -----------------
const fileExistsCache = new Map<string, boolean>();
const resolveSpecifierCache = new Map<string, FileId | { external: string }>();
const resolvePythonModuleCache = new Map<string, FileId | { external: string }>();

/**
 * Map over items with bounded concurrency.
 * Uses a streaming approach to avoid creating all promises upfront,
 * preventing memory issues with large arrays and EMFILE errors.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let activeCount = 0;
  let resolveAll: (() => void) | null = null;
  let rejectAll: ((err: unknown) => void) | null = null;
  let aborted = false;

  const startNext = (): void => {
    if (aborted) return;
    while (activeCount < safeLimit && nextIndex < items.length) {
      if (aborted) return;
      const index = nextIndex++;
      const item = items[index]!;
      activeCount++;

      fn(item)
        .then((result) => {
          if (aborted) return;
          results[index] = result;
          activeCount--;
          if (nextIndex < items.length) {
            startNext();
          } else if (activeCount === 0 && resolveAll) {
            resolveAll();
          }
        })
        .catch((err) => {
          if (aborted) return;
          aborted = true;
          activeCount--;
          if (rejectAll) rejectAll(err);
        });
    }
  };

  return new Promise<R[]>((resolve, reject) => {
    resolveAll = () => resolve(results);
    rejectAll = reject;
    startNext();
    // Handle empty case or immediate completion
    if (!aborted && (items.length === 0 || (nextIndex >= items.length && activeCount === 0))) {
      resolve(results);
    }
  });
}
