import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import picomatch from "picomatch";
import { logWithLevel, type LogLevel } from "../logging.js";
import { stringifyUnknown } from "./ast.js";
import { isFilePathWithinRoot, normalizePath } from "./paths.js";
import {
  PROJECT_FILE_DEFINITIONS,
  type ProjectFileDefinition,
  type ProjectFileInfo,
} from "./projectFiles/definitions.js";
import { trimToNull } from "./projectFiles/parsers.js";
import { mapLimitSemaphore } from "./concurrency.js";

export type {
  ProjectFileDefinition,
  ProjectFileInfo,
  ProjectFileKind,
  ProjectFileRole,
  ProjectFileType,
} from "./projectFiles/definitions.js";

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
  /**
   * Previously discovered symlinked directories under the project root. When provided
   * (including an empty array), discovery skips the full-tree symlink-directory probe
   * and instead re-verifies each entry directly, avoiding a second full recursive walk
   * on warm runs. Omit when the symlink-directory set is not yet known; discovery then
   * probes once and reports what it found via `onSymlinkDirectoriesDiscovered`.
   */
  knownSymlinkDirectories?: readonly string[];
  onSymlinkDirectoriesDiscovered?: (directories: readonly string[]) => void;
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
  filterIgnoreGlobs?: string[];
  onlyFiles?: boolean;
  markDirectories?: boolean;
  knownSymlinkDirectories?: readonly string[];
  onSymlinkDirectoriesDiscovered?: (directories: readonly string[]) => void;
};

type RootSafePath = {
  path: string;
  realPath: string;
};

function isPresent(value: string | undefined): value is string {
  return value !== undefined;
}

function normalizeGlobPattern(globPattern: string): string {
  return globPattern.trim().replace(/\\/g, "/");
}

function isLocationIndependentGlob(globPattern: string): boolean {
  return globPattern.startsWith("**/");
}

export function isRelativePathInside(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  return (
    !!normalized &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !path.isAbsolute(relativePath) &&
    !path.win32.isAbsolute(relativePath) &&
    !path.posix.isAbsolute(relativePath)
  );
}

export function translateGlobRootIgnoreGlobsForScanRoot(
  scanRoot: string,
  globRoot: string,
  ignoreGlobs: readonly string[],
): string[] {
  const relativeScanRoot = normalizePath(path.relative(globRoot, scanRoot));
  if (!relativeScanRoot || !isRelativePathInside(relativeScanRoot)) {
    return ignoreGlobs.map(normalizeGlobPattern).filter(Boolean);
  }

  const rootPrefix = `${relativeScanRoot}/`;
  return ignoreGlobs
    .map(normalizeGlobPattern)
    .filter(Boolean)
    .map((globPattern): string | undefined => {
      const rootRelativePattern = globPattern.startsWith("/") ? globPattern.slice(1) : globPattern;
      if (isLocationIndependentGlob(rootRelativePattern)) return rootRelativePattern;
      if (rootRelativePattern === relativeScanRoot || rootRelativePattern === `${relativeScanRoot}/**`) return "**";
      if (rootRelativePattern.startsWith(rootPrefix)) return rootRelativePattern.slice(rootPrefix.length) || "**";
      return undefined;
    })
    .filter(isPresent);
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

export function matchesDiscoveryGlob(
  absolutePath: string,
  projectRoot: string,
  matcher: (relativePath: string) => boolean,
): boolean {
  const relativePath = path.relative(projectRoot, absolutePath);
  if (!isRelativePathInside(relativePath)) {
    return false;
  }
  return matcher(normalizePath(relativePath));
}

function isIgnoredByGitignore(absolutePath: string, rules: GitignoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const relativePath = path.relative(rule.baseDir, absolutePath);
    if (!isRelativePathInside(relativePath)) {
      continue;
    }
    const normalizedRelativePath = normalizePath(relativePath);
    if (rule.dirOnly && !normalizedRelativePath.includes("/")) {
      continue;
    }
    if (rule.matches(normalizedRelativePath)) {
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
  const fastGlobIgnoreGlobs = [
    ...DEFAULT_PROJECT_FILE_IGNORES,
    ...translateGlobRootIgnoreGlobsForScanRoot(root, globRoot, userIgnoreGlobs),
  ];

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
      ignore: fastGlobIgnoreGlobs,
    });
    const linkedFiles = await listEntriesFromSafeSymlinkDirectories(root, realRoot, patterns, fastGlobIgnoreGlobs, {
      globRoot,
      filterIgnoreGlobs: [...DEFAULT_PROJECT_FILE_IGNORES, ...userIgnoreGlobs],
      ...(options?.knownSymlinkDirectories !== undefined
        ? { knownSymlinkDirectories: options.knownSymlinkDirectories }
        : {}),
      ...(options?.onSymlinkDirectoriesDiscovered
        ? { onSymlinkDirectoriesDiscovered: options.onSymlinkDirectoriesDiscovered }
        : {}),
    });
    const rootSafeFiles = await filterRealPathsWithinRootEntries([...files, ...linkedFiles], realRoot);
    return rootSafeFiles
      .map(({ path: filePath, realPath }) => ({ filePath: normalizePath(filePath), realPath }))
      .filter(({ filePath, realPath }) => {
        if (
          includeMatchers.length &&
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

/**
 * Build a predicate that answers "does this absolute path belong in the project file
 * set" without walking the filesystem. Mirrors the pattern/ignore-glob filtering that
 * `listProjectFiles()` applies during its scan, so it can be reused to test candidate
 * paths sourced elsewhere (e.g. `git ls-files --others`) against the same discovery
 * rules. Does not evaluate `.gitignore`; callers sourcing candidates from Git already
 * get gitignore-aware filtering for free and should not reuse this for arbitrary,
 * non-Git-sourced candidate paths without also checking gitignore separately.
 */
export function createDiscoveredFileMatcher(
  root: string,
  globRoot: string,
  patterns: readonly string[],
  options?: ProjectFileDiscoveryOptions,
): (absolutePath: string) => boolean {
  const patternMatchers = patterns.map((pattern) => picomatch(normalizeGlobPattern(pattern), { dot: true }));
  const defaultIgnoreMatchers = DEFAULT_PROJECT_FILE_IGNORES.map((pattern) =>
    picomatch(normalizeGlobPattern(pattern), { dot: true }),
  );
  const includeMatchers = (options?.includeGlobs ?? [])
    .map(normalizeGlobPattern)
    .filter(Boolean)
    .map((pattern) => picomatch(pattern, { dot: true }));
  const userIgnoreMatchers = (options?.ignoreGlobs ?? [])
    .map(normalizeGlobPattern)
    .filter(Boolean)
    .map((pattern) => picomatch(pattern, { dot: true }));

  return (absolutePath: string): boolean => {
    const rootRelative = path.relative(root, absolutePath);
    if (!isRelativePathInside(rootRelative)) return false;
    const normalizedRootRelative = normalizePath(rootRelative);
    if (!patternMatchers.some((matcher) => matcher(normalizedRootRelative))) return false;
    if (defaultIgnoreMatchers.some((matcher) => matcher(normalizedRootRelative))) return false;
    if (
      includeMatchers.length &&
      !includeMatchers.some((matcher) => matchesDiscoveryGlob(absolutePath, globRoot, matcher))
    ) {
      return false;
    }
    return !userIgnoreMatchers.some((matcher) => matchesDiscoveryGlob(absolutePath, globRoot, matcher));
  };
}

async function isSafeSymlinkDirectory(linkPath: string, realRoot: string): Promise<boolean> {
  try {
    const [realPath, stats] = await Promise.all([fsp.realpath(linkPath), fsp.stat(linkPath)]);
    if (!stats.isDirectory()) return false;
    if (!isFilePathWithinRoot(realRoot, realPath)) return false;
    return normalizePath(realPath) !== normalizePath(realRoot);
  } catch {
    return false;
  }
}

/**
 * Resolve the symlinked directories under `root` that are safe to crawl.
 *
 * When `knownSymlinkDirectories` is provided, this re-verifies each previously
 * discovered path directly (stat + realpath per entry) instead of walking the
 * whole tree again. Otherwise it probes once via a full `fg(["**\/*"])` walk
 * and, if `onSymlinkDirectoriesDiscovered` is set, reports what it found so a
 * caller can persist the result for future warm runs.
 */
async function resolveSafeSymlinkDirectories(
  root: string,
  realRoot: string,
  ignore: string[],
  options: SafeSymlinkDirectoryCrawlOptions,
): Promise<string[]> {
  if (options.knownSymlinkDirectories !== undefined) {
    const verified = await mapLimitSemaphore(
      Array.from(options.knownSymlinkDirectories),
      REALPATH_FILTER_CONCURRENCY,
      async (linkPath) => ((await isSafeSymlinkDirectory(linkPath, realRoot)) ? linkPath : null),
    );
    return verified.filter((entry): entry is string => entry !== null);
  }
  const entries = (await fg(["**/*"], {
    cwd: root,
    absolute: true,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    objectMode: true,
    ignore,
  })) as FastGlobEntry[];
  const candidates = await mapLimitSemaphore(
    entries.filter((entry) => entry.dirent.isSymbolicLink()).map((entry) => entry.path),
    REALPATH_FILTER_CONCURRENCY,
    async (linkPath) => ((await isSafeSymlinkDirectory(linkPath, realRoot)) ? linkPath : null),
  );
  const discovered = candidates.filter((entry): entry is string => entry !== null);
  options.onSymlinkDirectoriesDiscovered?.(discovered);
  return discovered;
}

async function listEntriesFromSafeSymlinkDirectories(
  root: string,
  realRoot: string,
  patterns: string[],
  ignore: string[],
  options: SafeSymlinkDirectoryCrawlOptions = {},
): Promise<string[]> {
  const globRoot = options.globRoot ?? root;
  const filterIgnoreGlobs = options.filterIgnoreGlobs ?? ignore;
  const rootRelativeIgnoreMatchers = filterIgnoreGlobs
    .map(normalizeGlobPattern)
    .filter(Boolean)
    .map((globPattern) => picomatch(globPattern, { dot: true }));
  const locationIndependentIgnores = ignore.map(normalizeGlobPattern).filter(isLocationIndependentGlob);
  const safeSymlinkDirectories = await resolveSafeSymlinkDirectories(root, realRoot, ignore, options);
  if (!safeSymlinkDirectories.length) return [];
  const filesByPath = new Map<string, string>();
  const filesByDirectory = await mapLimitSemaphore(
    safeSymlinkDirectories,
    REALPATH_FILTER_CONCURRENCY,
    async (directory) =>
      (
        await fg(patterns, {
          cwd: directory,
          absolute: true,
          dot: true,
          followSymbolicLinks: false,
          ignore: locationIndependentIgnores,
          ...(options.onlyFiles !== undefined ? { onlyFiles: options.onlyFiles } : {}),
          ...(options.markDirectories !== undefined ? { markDirectories: options.markDirectories } : {}),
        })
      ).filter((filePath) => {
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

export async function filterRealPathsWithinRoot(paths: string[], realRoot: string): Promise<string[]> {
  const entries = await filterRealPathsWithinRootEntries(paths, realRoot);
  return entries.map((entry) => entry.path);
}

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
  options?: {
    logLevel?: LogLevel;
    knownSymlinkDirectories?: readonly string[];
    onSymlinkDirectoriesDiscovered?: (directories: readonly string[]) => void;
  },
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
      {
        markDirectories: true,
        onlyFiles: false,
        ...(options?.knownSymlinkDirectories !== undefined
          ? { knownSymlinkDirectories: options.knownSymlinkDirectories }
          : {}),
        ...(options?.onSymlinkDirectoriesDiscovered
          ? { onSymlinkDirectoriesDiscovered: options.onSymlinkDirectoriesDiscovered }
          : {}),
      },
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
