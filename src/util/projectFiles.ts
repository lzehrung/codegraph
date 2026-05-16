import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import picomatch from "picomatch";
import { logWithLevel, type LogLevel } from "../logging.js";
import { stringifyUnknown } from "./ast.js";
import { isFilePathWithinRoot, normalizePath } from "./paths.js";
import { mapLimitSemaphore } from "./semaphore.js";

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
  "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,php,vue,svelte,astro,hbs,handlebars,md,mdx,rst,adoc,asciidoc,go,java,cs,rb,rs,html,htm,css,scss,less,kt,kts,swift,zig,c,h,cc,cpp,cxx,c++,hpp,hh,hxx,ipp,tpp,inl,sql}",
  ...DEFAULT_PROJECT_MANIFESTS.map((name) => `**/${name}`),
];

const REALPATH_FILTER_CONCURRENCY = 64;

export type ProjectFileDiscoveryOptions = {
  includeGlobs?: string[];
  ignoreGlobs?: string[];
  globRoot?: string;
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

type FastGlobEntry = {
  path: string;
  dirent: {
    isSymbolicLink: () => boolean;
  };
};

type SafeSymlinkDirectoryCrawlOptions = {
  globRoot?: string;
  onlyFiles?: boolean;
  markDirectories?: boolean;
};

type RootSafePath = {
  path: string;
  realPath: string;
};

function normalizeGlobPattern(globPattern: string): string {
  return globPattern.trim().replace(/\\/g, "/");
}

function isLocationIndependentGlob(globPattern: string): boolean {
  return globPattern.startsWith("**/");
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
    followSymbolicLinks: false,
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

async function loadGitignoreRulesForRootAliases(projectRoot: string): Promise<GitignoreRule[]> {
  const roots = [projectRoot];
  const realRoot = await fsp.realpath(projectRoot);
  if (normalizePath(realRoot) !== normalizePath(projectRoot)) {
    roots.push(realRoot);
  }
  const rules: GitignoreRule[] = [];
  for (const root of roots) {
    rules.push(...(await loadGitignoreRules(root)));
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
  const globRoot = options?.globRoot ? await ensureDirectoryReadable(options.globRoot, "Glob root") : root;
  const includeMatchers = (options?.includeGlobs ?? [])
    .map(normalizeGlobPattern)
    .filter(Boolean)
    .map((globPattern) => picomatch(globPattern, { dot: true }));
  const userIgnoreGlobs = (options?.ignoreGlobs ?? []).map(normalizeGlobPattern).filter(Boolean);
  const userIgnoreMatchers = userIgnoreGlobs.map((globPattern) => picomatch(globPattern, { dot: true }));

  try {
    const useGitignore = options?.useGitignore ?? true;
    const realRoot = await fsp.realpath(root);
    const gitignoreRules = !useGitignore
      ? []
      : await loadGitignoreRulesForRootAliases(
          options?.gitignoreRoot ? await ensureDirectoryReadable(options.gitignoreRoot, "Gitignore root") : root,
        );
    const files = await fg(patterns, {
      cwd: root,
      absolute: true,
      dot: true,
      followSymbolicLinks: false,
      ignore: [...DEFAULT_PROJECT_FILE_IGNORES, ...userIgnoreGlobs],
    });
    const linkedFiles = await listEntriesFromSafeSymlinkDirectories(
      root,
      realRoot,
      patterns,
      [...DEFAULT_PROJECT_FILE_IGNORES, ...userIgnoreGlobs],
      { globRoot },
    );
    const rootSafeFiles = await filterRealPathsWithinRootEntries([...files, ...linkedFiles], realRoot);
    return rootSafeFiles
      .map(({ path: filePath, realPath }) => ({ filePath: normalizePath(filePath), realPath }))
      .filter(({ filePath, realPath }) => {
        if (
          includeMatchers.length > 0 &&
          !includeMatchers.some((matcher) => matchesDiscoveryGlob(filePath, globRoot, matcher))
        ) {
          return false;
        }
        if (userIgnoreMatchers.some((matcher) => matchesDiscoveryGlob(filePath, globRoot, matcher))) {
          return false;
        }
        return !isIgnoredByGitignore(filePath, gitignoreRules) && !isIgnoredByGitignore(realPath, gitignoreRules);
      })
      .map(({ filePath }) => filePath);
  } catch (error) {
    logWithLevel(options?.logLevel, "debug", `listProjectFiles failed for ${root}: ${stringifyUnknown(error)}`);
    throw new Error(`Failed to list files in ${root}: ${stringifyUnknown(error)}`);
  }
}

async function listEntriesFromSafeSymlinkDirectories(
  root: string,
  realRoot: string,
  patterns: string[],
  ignore: string[],
  options: SafeSymlinkDirectoryCrawlOptions = {},
): Promise<string[]> {
  const globRoot = options.globRoot ?? root;
  const rootRelativeIgnoreMatchers = ignore
    .map(normalizeGlobPattern)
    .filter(Boolean)
    .map((globPattern) => picomatch(globPattern, { dot: true }));
  const locationIndependentIgnores = ignore.map(normalizeGlobPattern).filter(isLocationIndependentGlob);
  const entries = (await fg(["**/*"], {
    cwd: root,
    absolute: true,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    objectMode: true,
    ignore,
  })) as FastGlobEntry[];
  const symlinkDirectories = await mapLimitSemaphore(
    entries.filter((entry) => entry.dirent.isSymbolicLink()).map((entry) => entry.path),
    REALPATH_FILTER_CONCURRENCY,
    async (linkPath) => {
      try {
        const [realPath, stats] = await Promise.all([fsp.realpath(linkPath), fsp.stat(linkPath)]);
        if (!stats.isDirectory()) return null;
        if (!isFilePathWithinRoot(realRoot, realPath)) return null;
        if (normalizePath(realPath) === normalizePath(realRoot)) return null;
        return linkPath;
      } catch {
        return null;
      }
    },
  );
  const safeSymlinkDirectories = symlinkDirectories.filter((entry): entry is string => entry !== null);
  const filesByPath = new Map<string, string>();
  const filesByDirectory = await mapLimitSemaphore(
    safeSymlinkDirectories,
    REALPATH_FILTER_CONCURRENCY,
    async (directory) =>
      (await fg(patterns, {
        cwd: directory,
        absolute: true,
        dot: true,
        followSymbolicLinks: false,
        ignore: locationIndependentIgnores,
        ...(options.onlyFiles !== undefined ? { onlyFiles: options.onlyFiles } : {}),
        ...(options.markDirectories !== undefined ? { markDirectories: options.markDirectories } : {}),
      })).filter((filePath) => {
        const cleanPath = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
        return !rootRelativeIgnoreMatchers.some((matcher) => matchesDiscoveryGlob(cleanPath, globRoot, matcher));
      }),
  );
  for (const files of filesByDirectory) {
    for (const file of files) {
      filesByPath.set(normalizePath(file), file);
    }
  }
  return [...filesByPath.values()];
}

async function filterRealPathsWithinRootEntries(paths: string[], realRoot: string): Promise<RootSafePath[]> {
  const filtered = await mapLimitSemaphore(paths, REALPATH_FILTER_CONCURRENCY, async (filePath) => {
    try {
      const realPath = await fsp.realpath(filePath);
      return isFilePathWithinRoot(realRoot, realPath) ? { path: filePath, realPath } : null;
    } catch {
      return null;
    }
  });
  return filtered.filter((entry): entry is RootSafePath => entry !== null);
}

async function filterRealPathsWithinRoot(paths: string[], realRoot: string): Promise<string[]> {
  const entries = await filterRealPathsWithinRootEntries(paths, realRoot);
  return entries.map((entry) => entry.path);
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

function stripInlineComment(line: string): string {
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
    if (ch === "#") return line.slice(0, i).trim();
  }
  return line.trim();
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
    const realRoot = await fsp.realpath(root);
    const allPatterns = PROJECT_FILE_DEFINITIONS.flatMap((def) => def.patterns.map(toProjectGlob));
    const matches = await fg(allPatterns, {
      cwd: root,
      absolute: true,
      dot: true,
      followSymbolicLinks: false,
      ignore: DEFAULT_PROJECT_FILE_IGNORES,
      markDirectories: true,
      onlyFiles: false,
    });
    const linkedMatches = await listEntriesFromSafeSymlinkDirectories(
      root,
      realRoot,
      allPatterns,
      DEFAULT_PROJECT_FILE_IGNORES,
      { markDirectories: true, onlyFiles: false },
    );
    const rootSafeMatches = await filterRealPathsWithinRoot(
      [...matches, ...linkedMatches].map((match) => (match.endsWith("/") ? match.slice(0, -1) : match)),
      realRoot,
    );

    const entries: ProjectFileInfo[] = [];
    const matchTasks = rootSafeMatches.map(async (cleanMatch) => {
      const stats = await fsp.stat(cleanMatch);
      const isDir = stats.isDirectory();
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
