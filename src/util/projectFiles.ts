import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import picomatch from "picomatch";
import { performance } from "node:perf_hooks";
import { logWithLevel, type LogLevel } from "../logging.js";
import { stringifyUnknown } from "./ast.js";
import { fileIdentityKey, isFilePathWithinRoot, normalizePath } from "./paths.js";
import { isRelativePathInside, matchesDiscoveryGlob } from "./discoveryPath.js";

export { isRelativePathInside, matchesDiscoveryGlob } from "./discoveryPath.js";
import {
  PROJECT_FILE_DEFINITIONS,
  type ProjectFileDefinition,
  type ProjectFileInfo,
} from "./projectFiles/definitions.js";
import { trimToNull } from "./projectFiles/parsers.js";
import { mapLimitSemaphore } from "./concurrency.js";
import {
  getGitRepositoryRoot,
  isGitProjectRootIgnored,
  isGitRepo,
  isGitTimeoutError,
  listGitExcludeFiles,
  listGitStageSpecialPaths,
  listTrackedFiles,
  listUntrackedFiles,
} from "./git.js";

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
  // Never treat Codegraph's own on-disk state as project input. `.codegraph/` contains
  // lifecycle metadata and the indexer disk cache. Keep the legacy cache ignore so
  // pre-migration checkouts stay excluded from discovery.
  "**/.codegraph/**",
  "**/.codegraph-cache/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/.venv/**",
  "**/venv/**",
  "**/site-packages/**",
  "**/__pycache__/**",
  "**/vendor/bundle/**",
  "**/.build/**",
  "**/Pods/**",
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
  "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,pyi,php,vue,svelte,astro,hbs,handlebars,md,mdx,rst,adoc,asciidoc,go,java,cs,rb,rs,html,htm,css,scss,less,kt,kts,swift,zig,c,h,cc,cpp,cxx,c++,hpp,hh,hxx,ipp,tpp,inl,sql}",
  ...DEFAULT_PROJECT_MANIFESTS.map((name) => `**/${name}`),
];

const REALPATH_FILTER_CONCURRENCY = 64;

export type SymlinkProbeMode = "known" | "git-candidates" | "filesystem";

/**
 * Working-tree candidate listing shared by `listProjectFiles` and `discoverProjectFiles`.
 *
 * `files` are tracked plus untracked-but-not-ignored paths (including initialized submodule
 * contents). `symlinkCandidatePaths` are the subset worth `lstat`-screening as directory
 * links: Git mode 120000 plus extensionless or bundle-directory names. `gitignoreFiles` are
 * the ignore sources that still apply to those paths, so a caller can reuse the set without
 * re-probing Git.
 */
export type GitCandidateSet = {
  files: string[];
  symlinkCandidatePaths: string[];
  gitignoreFiles: GitignoreSource[];
  gitignoreRoots: string[];
  gitignoreAliases: GitIgnoreSourceRoot[];
};

export type ProjectFileDiscoveryOptions = {
  includeGlobs?: string[];
  ignoreGlobs?: string[];
  globRoot?: string;
  useGitignore?: boolean;
  gitignoreRoot?: string;
  logLevel?: LogLevel;
  /**
   * Previously discovered symlinked directories under the project root. When provided
   * (including an empty array), discovery re-verifies each entry directly and skips the
   * probe on warm runs. Omit it to probe once and report the result through
   * `onSymlinkDirectoriesDiscovered`. The callback mode distinguishes persisted hints,
   * Git candidate screening, and the non-Git filesystem fallback.
   */
  knownSymlinkDirectories?: readonly string[];
  onSymlinkDirectoriesDiscovered?: (directories: readonly string[], mode: SymlinkProbeMode) => void;
};

type DiscoveryWorkProgress = {
  activity: string;
  current: number;
  total: number;
};

type DiscoveryTimingStep = {
  name: string;
  ms: number;
};

type DiscoveryWorkCallbacks = {
  onDiscoveryProgress?: (progress: DiscoveryWorkProgress) => void;
  onDiscoveryTiming?: (step: DiscoveryTimingStep) => void;
};

function emitDiscoveryActivity(
  report: ((progress: DiscoveryWorkProgress) => void) | undefined,
  activity: string,
  current = 0,
  total = 0,
): void {
  report?.({ activity, current, total });
}

function emitDiscoveryTiming(
  record: ((step: DiscoveryTimingStep) => void) | undefined,
  name: string,
  startedAt: number,
): void {
  record?.({ name, ms: Math.round(performance.now() - startedAt) });
}

type InternalProjectFileDiscoveryOptions = ProjectFileDiscoveryOptions &
  DiscoveryWorkCallbacks & {
    onGitCandidatesDiscovered?: (candidates: GitCandidateSet | null) => void;
  };

type ProjectMetadataPublicOptions = Pick<
  ProjectFileDiscoveryOptions,
  "logLevel" | "knownSymlinkDirectories" | "onSymlinkDirectoriesDiscovered"
>;

type ProjectMetadataDiscoveryOptions = ProjectMetadataPublicOptions &
  DiscoveryWorkCallbacks & {
    knownGitCandidates?: GitCandidateSet | null;
    onGitCandidatesDiscovered?: (candidates: GitCandidateSet | null) => void;
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
  candidatePaths?: readonly string[];
  resolvedSafeSymlinkDirectories?: readonly string[];
  onSymlinkDirectoriesDiscovered?: (directories: readonly string[], mode: SymlinkProbeMode) => void;
  onPathCheckProgress?: (current: number, total: number) => void;
};

type RootSafePath = {
  path: string;
  realPath: string;
};

function createPathCheckProgressReporter(
  total: number,
  onProgress: ((current: number, total: number) => void) | undefined,
): () => void {
  onProgress?.(0, total);
  let completed = 0;
  return () => {
    completed += 1;
    if (completed === total || completed % 100 === 0) onProgress?.(completed, total);
  };
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined;
}

function normalizeGlobPattern(globPattern: string): string {
  return globPattern.trim().replace(/\\/g, "/");
}

const DIRECTORY_METADATA_EXTENSIONS = new Set<string>();
const DIRECTORY_METADATA_BASENAMES = new Set<string>();
for (const definition of PROJECT_FILE_DEFINITIONS) {
  if (definition.kind !== "dir") continue;
  for (const pattern of definition.patterns) {
    if (!pattern.includes("*") && !pattern.includes("?")) {
      DIRECTORY_METADATA_BASENAMES.add(pattern.toLowerCase());
      continue;
    }
    const trimmed = pattern.replaceAll("*", "").replaceAll("?", "");
    const lastDot = trimmed.lastIndexOf(".");
    if (lastDot < 0) continue;
    DIRECTORY_METADATA_EXTENSIONS.add(trimmed.slice(lastDot).toLowerCase());
  }
}

/**
 * Git lists files, not directories. A directory symlink still appears as one path.
 * Ordinary data files (`row.json`) are not directory links, so probing every Git
 * candidate spent one lstat per JSON/CSV. Tracked symlinks are identified by Git
 * mode 120000 regardless of extension. Untracked paths and Windows checkouts that
 * do not record 120000 still need this name heuristic: no extension, a bundle
 * directory marker such as `App.xcodeproj`, or a literal directory name such as `.idea`.
 */
function couldBeDirectorySymlink(filePath: string): boolean {
  const basename = path.posix.basename(normalizePath(filePath));
  if (DIRECTORY_METADATA_BASENAMES.has(basename.toLowerCase())) return true;
  const extension = path.posix.extname(basename);
  if (!extension) return true;
  return DIRECTORY_METADATA_EXTENSIONS.has(extension.toLowerCase());
}

function isProjectMetadataDirectoryName(dirPath: string): boolean {
  const basename = path.posix.basename(normalizePath(dirPath));
  if (DIRECTORY_METADATA_BASENAMES.has(basename.toLowerCase())) return true;
  const extension = path.posix.extname(basename);
  return Boolean(extension) && DIRECTORY_METADATA_EXTENSIONS.has(extension.toLowerCase());
}

function globLiteralPrefix(globPattern: string): string[] {
  const prefix: string[] = [];
  let seenLiteral = false;
  for (const segment of globPattern.split("/")) {
    if (!segment) continue;
    if (!seenLiteral && segment === "**") continue;
    if (segment.includes("*") || segment.includes("?")) break;
    seenLiteral = true;
    prefix.push(segment);
  }
  return prefix;
}

function isSegmentPrefix(prefix: readonly string[], pathSegments: readonly string[]): boolean {
  if (!prefix.length || prefix.length > pathSegments.length) return false;
  return prefix.every((segment, index) => pathSegments[index] === segment);
}

/**
 * Whether an include glob explicitly re-opens a default-ignored root, so a default ignore
 * should stay active for every OTHER root the includes never mention. A parent include
 * such as vendor/ re-opens a nested ignore such as vendor/bundle. Compares
 * literal path segments rather than attempting general glob-vs-glob intersection.
 */
function isIgnoreGlobReopenedByIncludes(ignoreGlob: string, includeGlobs: readonly string[]): boolean {
  const ignoreLiterals = ignoreGlob.split("/").filter((segment) => segment && !segment.includes("*"));
  if (!ignoreLiterals.length) return false;
  return includeGlobs.some((includeGlob) => {
    const includeSegments = includeGlob.split("/");
    if (ignoreLiterals.every((segment) => includeSegments.includes(segment))) return true;
    const includePrefix = globLiteralPrefix(includeGlob);
    return isSegmentPrefix(includePrefix, ignoreLiterals) || isSegmentPrefix(ignoreLiterals, includePrefix);
  });
}

function isLocationIndependentGlob(globPattern: string): boolean {
  return globPattern.startsWith("**/");
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

/**
 * The rules one `.gitignore` directory declares, kept with that directory.
 *
 * Storing the base alongside the rules lets the matcher resolve one relative path per
 * group instead of one per rule.
 */
type GitignoreRuleGroup = {
  baseDir: string;
  repositoryRoot: string | undefined;
  rules: GitignoreRule[];
};

type GitignoreIndex = {
  hasRules: boolean;
  repositoryRoots: string[];
  repositoryAliases: GitIgnoreSourceRoot[];
  /**
   * Rule groups keyed by {@link fileIdentityKey} of the declaring directory, so one base
   * directory can never be keyed two ways.
   */
  byBaseDir: Map<string, GitignoreRuleGroup>;
};

const EMPTY_GITIGNORE_INDEX: GitignoreIndex = {
  hasRules: false,
  repositoryRoots: [],
  repositoryAliases: [],
  byBaseDir: new Map(),
};

/**
 * A file of ignore patterns plus the directory its patterns resolve against.
 *
 * For `.gitignore` the base is its own directory; for Git's exclude files the base is
 * the repository root, which is how Git matches them.
 */
export type GitignoreSource = { file: string; baseDir: string; repositoryRoot?: string; priority?: number };

/**
 * Parse `.gitignore` rules from an already-discovered set of `.gitignore` files.
 *
 * Ordered by path depth, not lexically: a directory segment collating before `.` (for
 * example `-vendor` or `!keep`) would otherwise place a child's rule file ahead of its
 * parent's, so a parent could no longer suppress a child whose rules it ignores, and a
 * child negation could re-include files. Depth-first ordering also keeps the "last match
 * wins" order deeper files depend on, and drops the locale sensitivity of `localeCompare`.
 */
async function buildGitignoreIndex(
  sources: readonly GitignoreSource[],
  repositoryRoots: readonly string[] = [],
  repositoryAliases: readonly GitIgnoreSourceRoot[] = [],
): Promise<GitignoreIndex> {
  const sorted = [...sources]
    .map(({ file, baseDir, repositoryRoot, priority }) => ({
      file: normalizePath(file),
      baseDir: normalizePath(baseDir),
      priority: priority ?? 2,
      ...(repositoryRoot === undefined ? {} : { repositoryRoot: normalizePath(repositoryRoot) }),
    }))
    .sort((left, right) => {
      const baseDepthDelta = left.baseDir.split("/").length - right.baseDir.split("/").length;
      if (baseDepthDelta !== 0) return baseDepthDelta;
      const priorityDelta = left.priority - right.priority;
      if (priorityDelta !== 0) return priorityDelta;
      if (left.file < right.file) return -1;
      return left.file > right.file ? 1 : 0;
    });
  const gitignoreIndex: GitignoreIndex = {
    hasRules: false,
    repositoryRoots: Array.from(new Set(repositoryRoots.map(normalizePath))).sort(
      (left, right) => right.length - left.length,
    ),
    repositoryAliases: Array.from(
      new Map(
        repositoryAliases.map(({ path: aliasPath, repositoryRoot }) => [
          fileIdentityKey(aliasPath),
          { path: normalizePath(aliasPath), repositoryRoot: normalizePath(repositoryRoot) },
        ]),
      ).values(),
    ).sort((left, right) => right.path.length - left.path.length),
    byBaseDir: new Map(),
  };
  for (const { file, baseDir, repositoryRoot } of sorted) {
    if (isIgnoredByGitignore(path.dirname(file), gitignoreIndex, true)) {
      continue;
    }
    let raw: string;
    try {
      raw = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    const baseKey = fileIdentityKey(baseDir);
    for (const line of raw.split(/\r?\n/)) {
      const rule = parseGitignoreRule(baseDir, line);
      if (!rule) continue;
      const existing = gitignoreIndex.byBaseDir.get(baseKey);
      if (existing) existing.rules.push(rule);
      else gitignoreIndex.byBaseDir.set(baseKey, { baseDir, repositoryRoot, rules: [rule] });
      gitignoreIndex.hasRules = true;
    }
  }
  return gitignoreIndex;
}

async function findGitignoreFiles(projectRoot: string): Promise<string[]> {
  return await fg(["**/.gitignore"], {
    cwd: projectRoot,
    absolute: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: DEFAULT_PROJECT_FILE_IGNORES,
  });
}

async function loadGitignoreIndexForRootAliases(projectRoot: string): Promise<GitignoreIndex> {
  const roots = [projectRoot];
  const realRoot = await fsp.realpath(projectRoot);
  if (normalizePath(realRoot) !== normalizePath(projectRoot)) {
    roots.push(realRoot);
  }
  const sources: GitignoreSource[] = [];
  for (const root of roots) {
    for (const file of await findGitignoreFiles(root)) {
      sources.push({ file, baseDir: path.dirname(file) });
    }
  }
  return await buildGitignoreIndex(sources);
}

/**
 * Whether `.gitignore` rules ignore `absolutePath`.
 *
 * Only a `.gitignore` on the path's own ancestor chain can match it, so this walks that
 * chain rather than testing every rule in the project. The skipped rules are exactly the
 * ones whose relative-path check would have rejected them, and applying the chain
 * shallowest-first reproduces the flat list's ordering, so the answer is unchanged.
 * Testing every rule cost O(files x rules): on an Unreal project that meant 55,983
 * candidates against 2,266 rules from 173 `.gitignore` files, or 253.7M evaluations and
 * roughly 21.7s of a 26.1s discovery.
 *
 * The relative path is computed once per declaring directory rather than once per rule.
 * Every rule in a group shares that directory, so the per-rule form repeated identical
 * `path.relative` and normalization work; on the same project that repetition was the
 * dominant remaining cost, at 2.6s of a 3.8s discovery.
 */
function isIgnoredByGitignore(absolutePath: string, gitignoreIndex: GitignoreIndex, isDirectory = false): boolean {
  if (!gitignoreIndex.hasRules) return false;
  const owningRepositoryRoot =
    gitignoreIndex.repositoryRoots.find((root) => isFilePathWithinRoot(root, absolutePath)) ??
    gitignoreIndex.repositoryAliases.find(({ path: aliasPath }) => isFilePathWithinRoot(aliasPath, absolutePath))
      ?.repositoryRoot;
  const chain: GitignoreRuleGroup[] = [];
  let current = normalizePath(path.dirname(absolutePath));
  for (;;) {
    const group = gitignoreIndex.byBaseDir.get(fileIdentityKey(current));
    if (group) chain.push(group);
    const parent = normalizePath(path.dirname(current));
    if (parent === current) break;
    current = parent;
  }
  let ignored = false;
  for (let depth = chain.length - 1; depth >= 0; depth -= 1) {
    const group = chain[depth]!;
    if (
      group.repositoryRoot !== undefined &&
      owningRepositoryRoot !== undefined &&
      fileIdentityKey(group.repositoryRoot) !== fileIdentityKey(owningRepositoryRoot)
    ) {
      continue;
    }
    const relativePath = path.relative(group.baseDir, absolutePath);
    if (!isRelativePathInside(relativePath)) {
      continue;
    }
    const normalizedRelativePath = normalizePath(relativePath);
    const hasSeparator = normalizedRelativePath.includes("/");
    for (const rule of group.rules) {
      if (rule.dirOnly && !hasSeparator && !isDirectory) {
        continue;
      }
      const matchesDirectory = isDirectory && rule.dirOnly && rule.matches(`${normalizedRelativePath}/.directory`);
      if (rule.matches(normalizedRelativePath) || matchesDirectory) {
        ignored = !rule.negated;
      }
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

/**
 * Every directory on the ancestor chain of `files`, up to and including `root`.
 *
 * The ignore matcher only consults rules declared at a path's own ancestors, so this is
 * exactly the set of directories whose `.gitignore` can affect a candidate.
 */
function collectCandidateAncestorDirectories(root: string, files: readonly string[]): string[] {
  const rootKey = fileIdentityKey(root);
  const seen = new Set<string>([rootKey]);
  const directories = [normalizePath(root)];
  for (const file of files) {
    let current = normalizePath(path.dirname(file));
    while (fileIdentityKey(current) !== rootKey) {
      if (seen.has(fileIdentityKey(current))) break;
      seen.add(fileIdentityKey(current));
      directories.push(current);
      const parent = normalizePath(path.dirname(current));
      if (parent === current) break;
      current = parent;
    }
  }
  return directories;
}

type GitIgnoreSourceRoot = { path: string; repositoryRoot: string };

function owningGitIgnoreSourceRoot(
  file: string,
  roots: readonly GitIgnoreSourceRoot[],
): GitIgnoreSourceRoot | undefined {
  const normalized = normalizePath(file);
  let owning: GitIgnoreSourceRoot | undefined;
  for (const root of roots) {
    if (!isFilePathWithinRoot(root.path, normalized) && !isFilePathWithinRoot(root.repositoryRoot, normalized)) {
      continue;
    }
    if (!owning || root.repositoryRoot.length > owning.repositoryRoot.length) {
      owning = root;
    }
  }
  return owning;
}

async function gitignoreFileIfPresent(directory: string): Promise<string | undefined> {
  const file = normalizePath(path.join(directory, ".gitignore"));
  try {
    const stat = await fsp.stat(file);
    return stat.isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locate the `.gitignore` files that can affect the Git candidates, plus Git's
 * other ignore sources.
 *
 * A `.gitignore` only applies beneath its directory. After Git has listed tracked
 * and untracked candidates, the ignore files that can affect those paths live on
 * their ancestor chains up to the owning repository root, including parents of a
 * nested scan root, and at each source root. Stopping at the scan root would miss
 * `packages/.gitignore` when listing `packages/app`. Asking Git for ignored
 * `.gitignore` files walks every gitignored tree looking for them, which times
 * out on a large ignored data directory even after file listing already finished.
 */
async function findGitIgnoreSources(
  sourceRoots: readonly GitIgnoreSourceRoot[],
  candidateFiles: readonly string[],
): Promise<GitignoreSource[]> {
  const roots = Array.from(
    new Map(
      sourceRoots.map(({ path: sourceRoot, repositoryRoot }) => [
        fileIdentityKey(sourceRoot),
        { path: normalizePath(sourceRoot), repositoryRoot: normalizePath(repositoryRoot) },
      ]),
    ).values(),
  );
  const directories = new Map<string, { dir: string; repositoryRoot: string }>();
  const walkedDirectoryKeys = new Set<string>();
  const addDirectory = (directory: string, repositoryRoot: string): void => {
    const dir = normalizePath(directory);
    const key = fileIdentityKey(dir);
    if (!directories.has(key)) directories.set(key, { dir, repositoryRoot: normalizePath(repositoryRoot) });
  };
  for (const { path: sourceRoot, repositoryRoot } of roots) {
    addDirectory(sourceRoot, repositoryRoot);
  }
  for (const file of candidateFiles) {
    const owning = owningGitIgnoreSourceRoot(file, roots);
    if (!owning) continue;
    let dir = normalizePath(path.dirname(file));
    const stopKey = fileIdentityKey(owning.repositoryRoot);
    for (;;) {
      const dirKey = fileIdentityKey(dir);
      const walkKey = `${dirKey}\0${stopKey}`;
      if (walkedDirectoryKeys.has(walkKey)) break;
      addDirectory(dir, owning.repositoryRoot);
      walkedDirectoryKeys.add(walkKey);
      if (dirKey === stopKey) break;
      const parent = normalizePath(path.dirname(dir));
      if (
        parent === dir ||
        (!isFilePathWithinRoot(owning.path, parent) && !isFilePathWithinRoot(owning.repositoryRoot, parent))
      ) {
        break;
      }
      dir = parent;
    }
  }
  const uniqueRepositoryRoots = Array.from(new Set(roots.map((root) => root.repositoryRoot)));
  const [gitignoreHits, excludeLists] = await Promise.all([
    mapLimitSemaphore(
      Array.from(directories.values()),
      REALPATH_FILTER_CONCURRENCY,
      async ({ dir, repositoryRoot }) => {
        const file = await gitignoreFileIfPresent(dir);
        return file ? [{ file, baseDir: dir, repositoryRoot, priority: 2 }] : [];
      },
    ),
    Promise.all(uniqueRepositoryRoots.map((repositoryRoot) => listGitExcludeFiles(repositoryRoot))),
  ]);
  return [
    ...gitignoreHits.flat(),
    ...excludeLists.flat().map((source) => ({
      ...source,
      repositoryRoot: source.baseDir,
    })),
  ];
}

/**
 * Enumerate candidate project files through Git, or `null` when Git cannot answer.
 *
 * Tracked plus untracked-but-not-ignored files are Git candidates. Submodule files retain
 * their own repository boundary, and source roots cover logical and physical aliases.
 */
async function listGitCandidateFiles(
  root: string,
  logLevel: LogLevel | undefined,
  opts?: DiscoveryWorkCallbacks,
): Promise<GitCandidateSet | null> {
  let gitListStart: number | undefined;
  let gitIgnoreStart: number | undefined;
  try {
    const realRoot = normalizePath(await fsp.realpath(root));
    const gitRoot = (await isGitRepo(root)) ? root : realRoot;
    if (!(await isGitRepo(gitRoot))) return null;
    if (await isGitProjectRootIgnored(realRoot)) return null;
    const gitRepositoryRoot = await getGitRepositoryRoot(gitRoot);
    if (!gitRepositoryRoot) return null;
    emitDiscoveryActivity(opts?.onDiscoveryProgress, "Listing Git files");
    const listStartedAt = performance.now();
    gitListStart = listStartedAt;
    const [tracked, untracked, stageSpecial] = await Promise.all([
      listTrackedFiles(gitRoot, { recurseSubmodules: true, ...(logLevel === undefined ? {} : { logLevel }) }),
      listUntrackedFiles(gitRoot, { respectGitignore: true }),
      listGitStageSpecialPaths(gitRoot, { recurse: true }),
    ]);
    const submoduleDirectories = stageSpecial.gitlinks;
    const submoduleRoots = await Promise.all(
      submoduleDirectories.map(async (logicalPath) => ({
        logicalPath: normalizePath(logicalPath),
        physicalPath: normalizePath(await fsp.realpath(logicalPath).catch(() => logicalPath)),
      })),
    );
    const submoduleUntracked = await Promise.all(
      submoduleRoots.map(
        async ({ physicalPath }) => await listUntrackedFiles(physicalPath, { respectGitignore: true }),
      ),
    );
    const rawFiles = Array.from(new Set([...tracked, ...untracked, ...submoduleUntracked.flat()])).sort();
    const needsLogicalRemap = normalizePath(gitRoot) !== normalizePath(root);
    const files = Array.from(
      new Set(
        rawFiles.map((file) =>
          needsLogicalRemap && isFilePathWithinRoot(realRoot, file)
            ? normalizePath(path.resolve(root, path.relative(realRoot, file)))
            : normalizePath(file),
        ),
      ),
    ).sort();
    const remapGitPath = (file: string): string =>
      needsLogicalRemap && isFilePathWithinRoot(realRoot, file)
        ? normalizePath(path.resolve(root, path.relative(realRoot, file)))
        : normalizePath(file);
    const symlinkCandidatePaths = Array.from(
      new Set([...stageSpecial.symlinks.map(remapGitPath), ...files.filter((file) => couldBeDirectorySymlink(file))]),
    ).sort();
    const gitignoreRoots = [gitRepositoryRoot, ...submoduleRoots.map(({ physicalPath }) => physicalPath)].map(
      normalizePath,
    );
    const sourceRoots = [
      { path: root, repositoryRoot: gitRepositoryRoot },
      { path: realRoot, repositoryRoot: gitRepositoryRoot },
      { path: gitRepositoryRoot, repositoryRoot: gitRepositoryRoot },
      ...submoduleRoots.flatMap(({ logicalPath, physicalPath }) => [
        { path: logicalPath, repositoryRoot: physicalPath },
        { path: physicalPath, repositoryRoot: physicalPath },
      ]),
    ];
    emitDiscoveryTiming(opts?.onDiscoveryTiming, "git-list", listStartedAt);
    gitListStart = undefined;
    emitDiscoveryActivity(opts?.onDiscoveryProgress, "Listing Git files", files.length, files.length);
    emitDiscoveryActivity(opts?.onDiscoveryProgress, "Listing Git ignore files");
    const ignoreStartedAt = performance.now();
    gitIgnoreStart = ignoreStartedAt;
    const gitignoreFiles = await findGitIgnoreSources(sourceRoots, files);
    emitDiscoveryTiming(opts?.onDiscoveryTiming, "git-ignore", ignoreStartedAt);
    gitIgnoreStart = undefined;
    emitDiscoveryActivity(
      opts?.onDiscoveryProgress,
      "Listing Git ignore files",
      gitignoreFiles.length,
      gitignoreFiles.length,
    );
    return {
      files,
      symlinkCandidatePaths,
      gitignoreFiles,
      gitignoreRoots,
      gitignoreAliases: sourceRoots,
    };
  } catch (error) {
    const listingTimedOut = isGitTimeoutError(error) && (gitIgnoreStart !== undefined || gitListStart !== undefined);
    if (gitIgnoreStart !== undefined) {
      emitDiscoveryTiming(opts?.onDiscoveryTiming, "git-ignore", gitIgnoreStart);
    } else if (gitListStart !== undefined) {
      emitDiscoveryTiming(opts?.onDiscoveryTiming, "git-list", gitListStart);
    }
    if (listingTimedOut) {
      logWithLevel(
        logLevel,
        "warn",
        "Warning: Git listing timed out; scanning the filesystem instead. Ignore large untracked trees in .gitignore to keep discovery fast.",
      );
    } else {
      logWithLevel(logLevel, "debug", `Git discovery unavailable for ${root}: ${stringifyUnknown(error)}`);
    }
    return null;
  }
}

export async function listProjectFiles(
  projectRoot: string,
  patterns = DEFAULT_PROJECT_PATTERNS,
  options?: ProjectFileDiscoveryOptions,
): Promise<string[]> {
  return await listProjectFilesInternal(projectRoot, patterns, options);
}

export async function listProjectFilesWithGitCandidates(
  projectRoot: string,
  patterns = DEFAULT_PROJECT_PATTERNS,
  options?: InternalProjectFileDiscoveryOptions,
): Promise<string[]> {
  return await listProjectFilesInternal(projectRoot, patterns, options);
}

async function listProjectFilesInternal(
  projectRoot: string,
  patterns = DEFAULT_PROJECT_PATTERNS,
  options?: InternalProjectFileDiscoveryOptions,
): Promise<string[]> {
  const root = await ensureDirectoryReadable(projectRoot, "Project root");
  const globRoot = options?.globRoot ? await ensureDirectoryReadable(options.globRoot, "Glob root") : root;
  const includeGlobs = (options?.includeGlobs ?? []).map(normalizeGlobPattern).filter(Boolean);
  const includeMatchers = includeGlobs.map((globPattern) => picomatch(globPattern, { dot: true }));
  const userIgnoreGlobs = (options?.ignoreGlobs ?? []).map(normalizeGlobPattern).filter(Boolean);
  const userIgnoreMatchers = userIgnoreGlobs.map((globPattern) => picomatch(globPattern, { dot: true }));
  const defaultIgnoreMatchers = DEFAULT_PROJECT_FILE_IGNORES.map((globPattern) =>
    picomatch(globPattern, { dot: true }),
  );
  const patternMatchers = patterns.map((pattern) => picomatch(normalizeGlobPattern(pattern), { dot: true }));
  const translatedUserIgnoreGlobs = translateGlobRootIgnoreGlobsForScanRoot(root, globRoot, userIgnoreGlobs);
  const fastGlobIgnoreGlobs = [...DEFAULT_PROJECT_FILE_IGNORES, ...translatedUserIgnoreGlobs];
  // Include globs are an explicit request to re-open otherwise ignored roots. Probe
  // those roots for safe directory links before the later filter reapplies the default
  // ignores, so an included link is not lost before it can be traversed. Default ignores
  // an include never mentions (e.g. node_modules when only src/** is included) stay
  // active, so the probe does not walk unrelated large ignored trees.
  const symlinkProbeIgnoreGlobs = includeGlobs.length
    ? [
        ...translatedUserIgnoreGlobs,
        ...DEFAULT_PROJECT_FILE_IGNORES.filter(
          (ignoreGlob) => !isIgnoreGlobReopenedByIncludes(ignoreGlob, includeGlobs),
        ),
      ]
    : fastGlobIgnoreGlobs;

  try {
    const useGitignore = options?.useGitignore ?? true;
    const realRoot = await fsp.realpath(root);
    // Enumerate through Git when Git's ignore rules are the ones this call wants anyway.
    // Git applies them while walking, so ignored trees are never descended into and never
    // reach the realpath and gitignore checks below. Scanning instead costs O(files on
    // disk): on an Unreal project holding 100,168 files (818 tracked) the scan produced
    // 55,983 pattern-matching candidates, nearly all generated sources under a gitignored
    // `Intermediate/` tree, and discovery took 26.1s. Git lists 4,010 in about 111ms.
    // An aliased root or a gitignore-root override that points elsewhere means Git's notion
    // of the project is not this call's, so those fall back to the scan. Passing
    // `gitignoreRoot` equal to the scan root (the CLI's historical whole-project form) still
    // wants this repository's ignore rules, so keep the Git candidate path. On a 501-file
    // Git repo with a 20,000-file gitignored tree, `gitignoreRoot: scanRoot` otherwise
    // forced a filesystem scan plus a full-tree symlink probe (~403ms) instead of Git
    // listing (~66ms) of the 502 tracked paths.
    const gitignoreRootMatchesScanRoot =
      options?.gitignoreRoot === undefined || normalizePath(options.gitignoreRoot) === normalizePath(root);
    const attemptedGitCandidates =
      useGitignore && gitignoreRootMatchesScanRoot && normalizePath(realRoot) === normalizePath(root);
    const gitDiscoveryCallbacks: DiscoveryWorkCallbacks = {
      ...(options?.onDiscoveryProgress ? { onDiscoveryProgress: options.onDiscoveryProgress } : {}),
      ...(options?.onDiscoveryTiming ? { onDiscoveryTiming: options.onDiscoveryTiming } : {}),
    };
    const gitCandidates = attemptedGitCandidates
      ? await listGitCandidateFiles(root, options?.logLevel, gitDiscoveryCallbacks)
      : null;
    // Report only when this call actually asked Git, including a null result. Callers that
    // already enumerated candidates (build-index) can hand the same set to metadata discovery
    // and skip a second Git spawn; omitting the callback keeps prior caller behavior.
    if (attemptedGitCandidates) {
      options?.onGitCandidatesDiscovered?.(gitCandidates);
    }
    let gitignoreIndex = EMPTY_GITIGNORE_INDEX;
    if (useGitignore && gitCandidates) {
      gitignoreIndex = await buildGitignoreIndex(
        gitCandidates.gitignoreFiles,
        gitCandidates.gitignoreRoots,
        gitCandidates.gitignoreAliases,
      );
    } else if (useGitignore) {
      const gitignoreRoot = options?.gitignoreRoot
        ? await ensureDirectoryReadable(options.gitignoreRoot, "Gitignore root")
        : root;
      gitignoreIndex = await loadGitignoreIndexForRootAliases(gitignoreRoot);
    }
    // Git returns a candidate set, not a filtered result: the pattern, include,
    // default-ignore, and gitignore checks below still decide what is indexable.
    let files: string[];
    if (gitCandidates) {
      files = gitCandidates.files;
    } else {
      emitDiscoveryActivity(options?.onDiscoveryProgress, "Scanning project files");
      const scanStart = performance.now();
      files = await fg(patterns, {
        cwd: root,
        absolute: true,
        dot: true,
        followSymbolicLinks: false,
        ignore: fastGlobIgnoreGlobs,
      });
      emitDiscoveryTiming(options?.onDiscoveryTiming, "filesystem-scan", scanStart);
      emitDiscoveryActivity(options?.onDiscoveryProgress, "Scanning project files", files.length, files.length);
    }
    // Explicit includeGlobs may re-open default-ignored trees (for example vendored
    // dependency dirs). Scan those include patterns without default ignores, then keep
    // only paths that still match the project patterns and include globs below.
    //
    // Only needed on the scan path. Git never applied this project's default ignores, so
    // its listing already contains those files and the include globs below re-open them.
    // Running the scan anyway would also re-add paths Git excluded through its own
    // exclude files, contradicting the rule that Git's ignores still win here.
    const includedOverrideFiles =
      includeGlobs.length && !gitCandidates
        ? await fg(translateGlobRootIgnoreGlobsForScanRoot(root, globRoot, includeGlobs), {
            cwd: root,
            absolute: true,
            dot: true,
            followSymbolicLinks: false,
            ignore: translatedUserIgnoreGlobs,
          })
        : [];
    const reportSourceSymlinkChecks = options?.onDiscoveryProgress
      ? (current: number, total: number) =>
          options.onDiscoveryProgress?.({ activity: "Checking source symlinks", current, total })
      : undefined;
    const reportSourcePathChecks = options?.onDiscoveryProgress
      ? (current: number, total: number) =>
          options.onDiscoveryProgress?.({ activity: "Checking source file paths", current, total })
      : undefined;
    const symlinkOptions = {
      globRoot,
      ...(gitCandidates ? { candidatePaths: gitCandidates.symlinkCandidatePaths } : {}),
      ...(options?.knownSymlinkDirectories !== undefined
        ? { knownSymlinkDirectories: options.knownSymlinkDirectories }
        : {}),
      ...(options?.onSymlinkDirectoriesDiscovered
        ? { onSymlinkDirectoriesDiscovered: options.onSymlinkDirectoriesDiscovered }
        : {}),
      ...(reportSourceSymlinkChecks ? { onPathCheckProgress: reportSourceSymlinkChecks } : {}),
    };
    const safeSymlinkDirectories = await resolveSafeSymlinkDirectories(
      root,
      realRoot,
      symlinkProbeIgnoreGlobs,
      symlinkOptions,
    );
    const linkedFiles = await listEntriesFromSafeSymlinkDirectories(root, realRoot, patterns, fastGlobIgnoreGlobs, {
      ...symlinkOptions,
      filterIgnoreGlobs: [...DEFAULT_PROJECT_FILE_IGNORES, ...userIgnoreGlobs],
      resolvedSafeSymlinkDirectories: safeSymlinkDirectories,
    });
    const linkedOverrideFiles =
      includeGlobs.length === 0
        ? []
        : await listEntriesFromSafeSymlinkDirectories(root, realRoot, patterns, translatedUserIgnoreGlobs, {
            globRoot,
            filterIgnoreGlobs: userIgnoreGlobs,
            resolvedSafeSymlinkDirectories: safeSymlinkDirectories,
          });
    // Cheap path predicates run before the realpath confinement probe. Git enumerates
    // every tracked and untracked file it knows about, including trees this project
    // always ignores (virtualenvs, build output, caches), so probing first spent one
    // realpath syscall per ignored candidate: a Python project with a 20k-file untracked
    // virtualenv took 1.0s of syscalls to return 7 files. Only candidates that can still
    // become project files need their physical path resolved.
    const candidatePaths = [...files, ...includedOverrideFiles, ...linkedFiles, ...linkedOverrideFiles];
    const seen = new Set<string>();
    const indexableCandidates: string[] = [];
    for (const candidatePath of candidatePaths) {
      const filePath = normalizePath(candidatePath);
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      const rootRelative = normalizePath(path.relative(root, filePath));
      if (!isRelativePathInside(rootRelative)) continue;
      if (!patternMatchers.some((matcher) => matcher(rootRelative))) continue;
      if (
        includeMatchers.length &&
        !includeMatchers.some((matcher) => matchesDiscoveryGlob(filePath, globRoot, matcher))
      ) {
        continue;
      }
      if (userIgnoreMatchers.some((matcher) => matchesDiscoveryGlob(filePath, globRoot, matcher))) continue;
      // Explicit include globs are a deliberate request to re-open default-ignored trees.
      if (!includeMatchers.length && defaultIgnoreMatchers.some((matcher) => matcher(rootRelative))) continue;
      if (isIgnoredByGitignore(filePath, gitignoreIndex)) continue;
      indexableCandidates.push(filePath);
    }
    const rootSafeFiles = await filterRealPathsWithinRootEntries(indexableCandidates, realRoot, reportSourcePathChecks);
    return rootSafeFiles
      .filter(
        ({ path: filePath, realPath }) =>
          // The real path only differs when the entry was reached through a symlink, so
          // testing it again for every ordinary file doubled the matcher work for nothing.
          normalizePath(realPath) === filePath || !isIgnoredByGitignore(realPath, gitignoreIndex),
      )
      .map(({ path: filePath }) => filePath);
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
    const matchesInclude =
      !includeMatchers.length ||
      includeMatchers.some((matcher) => matchesDiscoveryGlob(absolutePath, globRoot, matcher));
    if (!matchesInclude) return false;
    if (defaultIgnoreMatchers.some((matcher) => matcher(normalizedRootRelative))) {
      if (!(includeMatchers.length > 0 && matchesInclude)) return false;
    }
    return !userIgnoreMatchers.some((matcher) => matchesDiscoveryGlob(absolutePath, globRoot, matcher));
  };
}

/**
 * Whether `linkPath` is a directory symlink that is safe to crawl for project files.
 *
 * `lstat` runs before `realpath` and `stat` so a candidate that is not a symlink costs
 * one syscall rather than three. That matters for callers screening a broad candidate
 * list, where nearly every entry is an ordinary file, and costs nothing for callers
 * passing entries a walk already identified as links.
 */
async function isSafeSymlinkDirectory(root: string, linkPath: string, realRoot: string): Promise<boolean> {
  try {
    if (!isRelativePathInside(path.relative(root, linkPath))) return false;
    if (!(await fsp.lstat(linkPath)).isSymbolicLink()) return false;
    const [realPath, targetStats] = await Promise.all([fsp.realpath(linkPath), fsp.stat(linkPath)]);
    if (!targetStats.isDirectory()) return false;
    if (!isFilePathWithinRoot(realRoot, realPath)) return false;
    return normalizePath(realPath) !== normalizePath(realRoot);
  } catch {
    return false;
  }
}

async function verifySafeSymlinkDirectories(
  root: string,
  realRoot: string,
  paths: readonly string[],
  onPathCheckProgress: ((current: number, total: number) => void) | undefined,
): Promise<string[]> {
  const reportPathCheck = createPathCheckProgressReporter(paths.length, onPathCheckProgress);
  const verified = await mapLimitSemaphore(Array.from(paths), REALPATH_FILTER_CONCURRENCY, async (linkPath) => {
    try {
      return (await isSafeSymlinkDirectory(root, linkPath, realRoot)) ? linkPath : null;
    } finally {
      reportPathCheck();
    }
  });
  return verified.filter((entry): entry is string => entry !== null);
}

/**
 * Resolve the symlinked directories under `root` that are safe to crawl.
 *
 * When `knownSymlinkDirectories` is provided, this re-verifies each previously
 * discovered path directly. Otherwise a Git-derived `candidatePaths` list avoids a
 * separate full-tree scan: Git already enumerated every tracked and non-ignored
 * untracked entry, including symlinks. Callers pass `symlinkCandidatePaths` so ordinary
 * data files are not lstat'd, while Git mode 120000 still screens extension-bearing
 * directory links. Non-Git discovery retains the existing
 * `fg(["**\/*"])` fallback. Every path still passes the same lstat, target-directory,
 * and realpath-confinement checks before it can be crawled.
 */
async function resolveSafeSymlinkDirectories(
  root: string,
  realRoot: string,
  ignore: string[],
  options: SafeSymlinkDirectoryCrawlOptions,
): Promise<string[]> {
  if (options.knownSymlinkDirectories !== undefined) {
    const resolved = await verifySafeSymlinkDirectories(
      root,
      realRoot,
      Array.from(new Set(options.knownSymlinkDirectories)),
      options.onPathCheckProgress,
    );
    options.onSymlinkDirectoriesDiscovered?.(resolved, "known");
    return resolved;
  }
  if (options.candidatePaths !== undefined) {
    const ignoreMatchers = ignore
      .map(normalizeGlobPattern)
      .filter(Boolean)
      .map((pattern) => picomatch(pattern, { dot: true }));
    const candidatePaths = Array.from(new Set(options.candidatePaths)).filter((candidatePath) => {
      const relativePath = normalizePath(path.relative(root, candidatePath));
      if (!isRelativePathInside(relativePath)) return false;
      if (ignoreMatchers.some((matcher) => matcher(relativePath))) return false;
      return true;
    });
    const discovered = await verifySafeSymlinkDirectories(root, realRoot, candidatePaths, options.onPathCheckProgress);
    options.onSymlinkDirectoriesDiscovered?.(discovered, "git-candidates");
    return discovered;
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
  const discovered = await verifySafeSymlinkDirectories(
    root,
    realRoot,
    entries.filter((entry) => entry.dirent.isSymbolicLink()).map((entry) => entry.path),
    options.onPathCheckProgress,
  );
  options.onSymlinkDirectoriesDiscovered?.(discovered, "filesystem");
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
  const safeSymlinkDirectories =
    options.resolvedSafeSymlinkDirectories ?? (await resolveSafeSymlinkDirectories(root, realRoot, ignore, options));
  if (!safeSymlinkDirectories.length) return [];
  const filesByPath = new Map<string, string>();
  const filesByDirectory = await mapLimitSemaphore<string, string[]>(
    Array.from(safeSymlinkDirectories),
    REALPATH_FILTER_CONCURRENCY,
    async (directory) =>
      (
        (await fg(patterns, {
          cwd: directory,
          absolute: true,
          dot: true,
          followSymbolicLinks: false,
          ignore: locationIndependentIgnores,
          ...(options.onlyFiles !== undefined ? { onlyFiles: options.onlyFiles } : {}),
          ...(options.markDirectories !== undefined ? { markDirectories: options.markDirectories } : {}),
        })) as string[]
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

async function filterRealPathsWithinRootEntries(
  paths: string[],
  realRoot: string,
  onPathCheckProgress?: (current: number, total: number) => void,
): Promise<RootSafePath[]> {
  const reportPathCheck = createPathCheckProgressReporter(paths.length, onPathCheckProgress);
  const filtered = await mapLimitSemaphore(paths, REALPATH_FILTER_CONCURRENCY, async (filePath) => {
    try {
      const realPath = await fsp.realpath(filePath);
      return isFilePathWithinRoot(realRoot, realPath) ? { path: filePath, realPath } : null;
    } catch {
      return null;
    } finally {
      reportPathCheck();
    }
  });
  return filtered.filter((entry): entry is RootSafePath => entry !== null);
}

export async function filterRealPathsWithinRoot(
  paths: string[],
  realRoot: string,
  onPathCheckProgress?: (current: number, total: number) => void,
): Promise<string[]> {
  const entries = await filterRealPathsWithinRootEntries(paths, realRoot, onPathCheckProgress);
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
  options?: ProjectMetadataPublicOptions,
): Promise<ProjectFileInfo[]> {
  return await discoverProjectFilesInternal(projectRoot, options);
}

export async function discoverProjectFilesWithGitCandidates(
  projectRoot: string,
  options?: ProjectMetadataDiscoveryOptions,
): Promise<ProjectFileInfo[]> {
  return await discoverProjectFilesInternal(projectRoot, options);
}

async function discoverProjectFilesInternal(
  projectRoot: string,
  options?: ProjectMetadataDiscoveryOptions,
): Promise<ProjectFileInfo[]> {
  const root = await ensureDirectoryReadable(projectRoot, "Project root");
  try {
    const realRoot = await fsp.realpath(root);
    const projectFileDefinitionMatchers = PROJECT_FILE_DEFINITIONS.map((definition) =>
      definition.patterns.map((pattern) =>
        pattern.includes("*") || pattern.includes("?")
          ? new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$")
          : undefined,
      ),
    );
    const matchesDefinition = (fileName: string, definitionIndex: number): boolean => {
      const definition = PROJECT_FILE_DEFINITIONS[definitionIndex]!;
      return definition.patterns.some((pattern, patternIndex) => {
        const matcher = projectFileDefinitionMatchers[definitionIndex]![patternIndex];
        return matcher ? matcher.test(fileName) : pattern === fileName;
      });
    };
    let gitCandidates: GitCandidateSet | null;
    if (options?.knownGitCandidates !== undefined) {
      gitCandidates = options.knownGitCandidates;
    } else {
      gitCandidates = await listGitCandidateFiles(root, options?.logLevel, {
        ...(options?.onDiscoveryProgress ? { onDiscoveryProgress: options.onDiscoveryProgress } : {}),
        ...(options?.onDiscoveryTiming ? { onDiscoveryTiming: options.onDiscoveryTiming } : {}),
      });
    }
    options?.onGitCandidatesDiscovered?.(gitCandidates);
    const reportMetadataSymlinkChecks = options?.onDiscoveryProgress
      ? (current: number, total: number) =>
          options.onDiscoveryProgress?.({ activity: "Checking project metadata symlinks", current, total })
      : undefined;
    const reportMetadataFileChecks = options?.onDiscoveryProgress
      ? (current: number, total: number) =>
          options.onDiscoveryProgress?.({ activity: "Checking project metadata files", current, total })
      : undefined;
    const reportMetadataDirectoryChecks = options?.onDiscoveryProgress
      ? (current: number, total: number) =>
          options.onDiscoveryProgress?.({ activity: "Checking project metadata directories", current, total })
      : undefined;
    let rootSafeMatches: string[];
    if (gitCandidates) {
      const gitignoreIndex = await buildGitignoreIndex(
        gitCandidates.gitignoreFiles,
        gitCandidates.gitignoreRoots,
        gitCandidates.gitignoreAliases,
      );
      const defaultIgnoreMatchers = DEFAULT_PROJECT_FILE_IGNORES.map((globPattern) =>
        picomatch(globPattern, { dot: true }),
      );
      const filterGitIgnoredEntries = (
        entries: RootSafePath[],
        directoryKeys: ReadonlySet<string> = new Set(),
      ): string[] =>
        entries
          .map(({ path: filePath, realPath }) => ({ filePath: normalizePath(filePath), realPath }))
          .filter(({ filePath, realPath }) => {
            const isDirectory = directoryKeys.has(fileIdentityKey(filePath));
            const rootRelative = normalizePath(path.relative(root, filePath));
            if (!isRelativePathInside(rootRelative)) return false;
            if (defaultIgnoreMatchers.some((matcher) => matcher(rootRelative))) return false;
            if (isIgnoredByGitignore(filePath, gitignoreIndex, isDirectory)) return false;
            return normalizePath(realPath) === filePath || !isIgnoredByGitignore(realPath, gitignoreIndex, isDirectory);
          })
          .map(({ filePath }) => filePath);
      const symlinkOptions = {
        candidatePaths: gitCandidates.symlinkCandidatePaths,
        ...(options?.knownSymlinkDirectories !== undefined
          ? { knownSymlinkDirectories: options.knownSymlinkDirectories }
          : {}),
        ...(options?.onSymlinkDirectoriesDiscovered
          ? { onSymlinkDirectoriesDiscovered: options.onSymlinkDirectoriesDiscovered }
          : {}),
        ...(reportMetadataSymlinkChecks ? { onPathCheckProgress: reportMetadataSymlinkChecks } : {}),
      };
      const safeSymlinkDirectories = await resolveSafeSymlinkDirectories(
        root,
        realRoot,
        DEFAULT_PROJECT_FILE_IGNORES,
        symlinkOptions,
      );
      const allPatterns = PROJECT_FILE_DEFINITIONS.flatMap((definition) => definition.patterns.map(toProjectGlob));
      const linkedMatches = await listEntriesFromSafeSymlinkDirectories(
        root,
        realRoot,
        allPatterns,
        DEFAULT_PROJECT_FILE_IGNORES,
        {
          markDirectories: true,
          onlyFiles: false,
          resolvedSafeSymlinkDirectories: safeSymlinkDirectories,
        },
      );
      const candidateFiles = Array.from(new Set(gitCandidates.files.map(normalizePath)));
      // Only a candidate whose basename can name a manifest becomes a metadata entry, so
      // resolve physical paths for those alone. Probing every Git candidate first cost a
      // realpath syscall per ignored file: the same 20k-file untracked virtualenv spent
      // 0.6s here. Ancestor directories come from the candidate paths themselves and are
      // confined by their own realpath check below.
      const metadataCandidates = candidateFiles.filter((file) =>
        PROJECT_FILE_DEFINITIONS.some(
          (definition, definitionIndex) =>
            definition.kind === "file" && matchesDefinition(path.basename(file), definitionIndex),
        ),
      );
      const fileMatches = filterGitIgnoredEntries(
        await filterRealPathsWithinRootEntries(metadataCandidates, realRoot, reportMetadataFileChecks),
      );
      // Directory metadata is identified by the directory name (.idea, App.xcodeproj).
      // Walking every Git-listed JSON or CSV still produced one realpath per data folder.
      const rawCandidateDirectories = collectCandidateAncestorDirectories(root, candidateFiles).filter(
        isProjectMetadataDirectoryName,
      );
      const candidateDirectoryKeys = new Set(rawCandidateDirectories.map(fileIdentityKey));
      const safeSymlinkDirectoryKeys = new Set(safeSymlinkDirectories.map(fileIdentityKey));
      const directoryMatches = [
        ...filterGitIgnoredEntries(
          await filterRealPathsWithinRootEntries(rawCandidateDirectories, realRoot, reportMetadataDirectoryChecks),
          candidateDirectoryKeys,
        ),
        ...filterGitIgnoredEntries(
          await filterRealPathsWithinRootEntries(safeSymlinkDirectories, realRoot, reportMetadataDirectoryChecks),
          safeSymlinkDirectoryKeys,
        ),
      ].filter((directory) =>
        PROJECT_FILE_DEFINITIONS.some(
          (definition, definitionIndex) =>
            definition.kind === "dir" && matchesDefinition(path.basename(directory), definitionIndex),
        ),
      );
      const linkedDirectoryKeys = new Set(
        linkedMatches.filter((match) => match.endsWith("/")).map((match) => fileIdentityKey(match.slice(0, -1))),
      );
      const rootSafeLinked = filterGitIgnoredEntries(
        await filterRealPathsWithinRootEntries(
          linkedMatches.map((match) => (match.endsWith("/") ? match.slice(0, -1) : match)),
          realRoot,
          reportMetadataFileChecks,
        ),
        linkedDirectoryKeys,
      );
      rootSafeMatches = [...fileMatches, ...directoryMatches, ...rootSafeLinked];
    } else {
      const allPatterns = PROJECT_FILE_DEFINITIONS.flatMap((definition) => definition.patterns.map(toProjectGlob));
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
          ...(reportMetadataSymlinkChecks ? { onPathCheckProgress: reportMetadataSymlinkChecks } : {}),
        },
      );
      rootSafeMatches = await filterRealPathsWithinRoot(
        [...matches, ...linkedMatches].map((match) => (match.endsWith("/") ? match.slice(0, -1) : match)),
        realRoot,
        reportMetadataFileChecks,
      );
    }
    const entries: ProjectFileInfo[] = [];
    const matchTasks = rootSafeMatches.map(async (cleanMatch) => {
      const stats = await fsp.stat(cleanMatch);
      const isDir = stats.isDirectory();
      const fileName = path.basename(cleanMatch);

      for (let definitionIndex = 0; definitionIndex < PROJECT_FILE_DEFINITIONS.length; definitionIndex++) {
        const def = PROJECT_FILE_DEFINITIONS[definitionIndex]!;
        if (isDir && def.kind !== "dir") continue;
        if (!isDir && def.kind !== "file") continue;

        const matchesPattern = matchesDefinition(fileName, definitionIndex);

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
