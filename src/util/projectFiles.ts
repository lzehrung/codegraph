import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import picomatch from "picomatch";
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
  isGitProjectRootIgnored,
  isGitRepo,
  listGitExcludeFiles,
  listGitSubmoduleDirectories,
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

/**
 * Whether an include glob explicitly re-opens a default-ignored root, so a default ignore
 * should stay active for every OTHER root the includes never mention. Compares literal
 * (non-wildcard) path segments rather than attempting general glob-vs-glob intersection.
 */
function isIgnoreGlobReopenedByIncludes(ignoreGlob: string, includeGlobs: readonly string[]): boolean {
  const literalSegments = ignoreGlob.split("/").filter((segment) => segment && !segment.includes("*"));
  if (!literalSegments.length) return false;
  return includeGlobs.some((includeGlob) => {
    const includeSegments = includeGlob.split("/");
    return literalSegments.every((segment) => includeSegments.includes(segment));
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
type GitignoreRuleGroup = { baseDir: string; rules: GitignoreRule[] };

type GitignoreIndex = {
  hasRules: boolean;
  /**
   * Rule groups keyed by {@link fileIdentityKey} of the declaring directory, so one base
   * directory can never be keyed two ways.
   */
  byBaseDir: Map<string, GitignoreRuleGroup>;
};

const EMPTY_GITIGNORE_INDEX: GitignoreIndex = { hasRules: false, byBaseDir: new Map() };

/**
 * A file of ignore patterns plus the directory its patterns resolve against.
 *
 * For `.gitignore` the base is its own directory; for Git's exclude files the base is
 * the repository root, which is how Git matches them.
 */
type GitignoreSource = { file: string; baseDir: string };

/**
 * Parse `.gitignore` rules from an already-discovered set of `.gitignore` files.
 *
 * Ordered by path depth, not lexically: a directory segment collating before `.` (for
 * example `-vendor` or `!keep`) would otherwise place a child's rule file ahead of its
 * parent's, so a parent could no longer suppress a child whose rules it ignores, and a
 * child negation could re-include files. Depth-first ordering also keeps the "last match
 * wins" order deeper files depend on, and drops the locale sensitivity of `localeCompare`.
 */
async function buildGitignoreIndex(sources: readonly GitignoreSource[]): Promise<GitignoreIndex> {
  const sorted = [...sources]
    .map(({ file, baseDir }) => ({ file: normalizePath(file), baseDir: normalizePath(baseDir) }))
    .sort((left, right) => {
      const leftFile = left.file;
      const rightFile = right.file;
      const depthDelta = leftFile.split("/").length - rightFile.split("/").length;
      if (depthDelta !== 0) return depthDelta;
      if (leftFile < rightFile) return -1;
      return leftFile > rightFile ? 1 : 0;
    });
  const gitignoreIndex: GitignoreIndex = { hasRules: false, byBaseDir: new Map() };
  for (const { file, baseDir } of sorted) {
    if (isIgnoredByGitignore(file, gitignoreIndex)) {
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
      else gitignoreIndex.byBaseDir.set(baseKey, { baseDir, rules: [rule] });
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
function isIgnoredByGitignore(absolutePath: string, gitignoreIndex: GitignoreIndex): boolean {
  if (!gitignoreIndex.hasRules) return false;
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
    const relativePath = path.relative(group.baseDir, absolutePath);
    if (!isRelativePathInside(relativePath)) {
      continue;
    }
    const normalizedRelativePath = normalizePath(relativePath);
    const hasSeparator = normalizedRelativePath.includes("/");
    for (const rule of group.rules) {
      if (rule.dirOnly && !hasSeparator) {
        continue;
      }
      if (rule.matches(normalizedRelativePath)) {
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

type GitCandidateSet = {
  files: string[];
  gitignoreFiles: GitignoreSource[];
};

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

/**
 * Locate the `.gitignore` files that can affect `files`, plus Git's other ignore sources.
 *
 * Filtering the candidate listing for `.gitignore` would miss a `.gitignore` that is
 * itself ignored; Git still reads those, and tracked files matching their rules must
 * still be excluded. Probing the candidates' ancestor directories finds them without
 * reintroducing a full-tree walk. `.git/info/exclude` and `core.excludesFile` are
 * included so the index is authoritative for every source Git consults: paths that do
 * not come from Git, such as entries behind a directory symlink, are then filtered by
 * the same rules Git applied to the candidate listing.
 */
async function findGitIgnoreSources(root: string, files: readonly string[]): Promise<GitignoreSource[]> {
  const directories = collectCandidateAncestorDirectories(root, files);
  const present = await mapLimitSemaphore(directories, REALPATH_FILTER_CONCURRENCY, async (directory) => {
    const candidate = normalizePath(path.join(directory, ".gitignore"));
    try {
      return (await fsp.stat(candidate)).isFile() ? { file: candidate, baseDir: directory } : null;
    } catch {
      return null;
    }
  });
  const sources = present.filter((entry): entry is GitignoreSource => entry !== null);
  sources.push(...(await listGitExcludeFiles(root)));
  return sources;
}

/**
 * Enumerate candidate project files through Git, or `null` when Git cannot answer.
 *
 * Tracked plus untracked-but-not-ignored files are exactly the working-tree files Git
 * treats as part of the project. Any Git failure returns `null` and discovery falls back
 * to scanning the filesystem.
 *
 * Submodules need explicit handling or their contents vanish from the index: the
 * superproject records only a gitlink. Tracked files come from `--recurse-submodules`,
 * which cannot combine with `--others`, so untracked files are listed per submodule
 * directory, including submodules nested inside submodules.
 *
 * A root that Git itself ignores falls back to scanning. Enumerating it through Git
 * would return only tracked files and silently drop the rest, which would make a
 * directory the caller named explicitly look nearly empty.
 */
async function listGitCandidateFiles(root: string, logLevel: LogLevel | undefined): Promise<GitCandidateSet | null> {
  try {
    if (!(await isGitRepo(root))) return null;
    if (await isGitProjectRootIgnored(root)) return null;
    const [tracked, untracked, submoduleDirectories] = await Promise.all([
      listTrackedFiles(root, { recurseSubmodules: true, ...(logLevel === undefined ? {} : { logLevel }) }),
      listUntrackedFiles(root, { respectGitignore: true }),
      listGitSubmoduleDirectories(root, { recurse: true }),
    ]);
    const submoduleUntracked = await Promise.all(
      submoduleDirectories.map(async (directory) => await listUntrackedFiles(directory, { respectGitignore: true })),
    );
    // Sorted so discovery order is reproducible rather than an artifact of how three
    // separate Git listings happened to be concatenated. Callers that surface results
    // in discovery order then behave the same way on every machine.
    const files = Array.from(new Set([...tracked, ...untracked, ...submoduleUntracked.flat()])).sort();
    return { files, gitignoreFiles: await findGitIgnoreSources(root, files) };
  } catch (error) {
    logWithLevel(logLevel, "debug", `Git discovery unavailable for ${root}: ${stringifyUnknown(error)}`);
    return null;
  }
}

export async function listProjectFiles(
  projectRoot: string,
  patterns = DEFAULT_PROJECT_PATTERNS,
  options?: ProjectFileDiscoveryOptions,
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
    // An aliased root or a gitignore-root override means Git's notion of the project is
    // not this call's, so those fall back to the scan.
    const gitCandidates =
      useGitignore && options?.gitignoreRoot === undefined && normalizePath(realRoot) === normalizePath(root)
        ? await listGitCandidateFiles(root, options?.logLevel)
        : null;
    let gitignoreIndex = EMPTY_GITIGNORE_INDEX;
    if (useGitignore && gitCandidates) {
      gitignoreIndex = await buildGitignoreIndex(gitCandidates.gitignoreFiles);
    } else if (useGitignore) {
      const gitignoreRoot = options?.gitignoreRoot
        ? await ensureDirectoryReadable(options.gitignoreRoot, "Gitignore root")
        : root;
      gitignoreIndex = await loadGitignoreIndexForRootAliases(gitignoreRoot);
    }
    // Git returns a candidate set, not a filtered result: the pattern, include,
    // default-ignore, and gitignore checks below still decide what is indexable.
    const files = gitCandidates
      ? gitCandidates.files
      : await fg(patterns, {
          cwd: root,
          absolute: true,
          dot: true,
          followSymbolicLinks: false,
          ignore: fastGlobIgnoreGlobs,
        });
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
    const symlinkOptions = {
      globRoot,
      ...(gitCandidates ? { candidatePaths: gitCandidates.files } : {}),
      ...(options?.knownSymlinkDirectories !== undefined
        ? { knownSymlinkDirectories: options.knownSymlinkDirectories }
        : {}),
      ...(options?.onSymlinkDirectoriesDiscovered
        ? { onSymlinkDirectoriesDiscovered: options.onSymlinkDirectoriesDiscovered }
        : {}),
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
    const rootSafeFiles = await filterRealPathsWithinRootEntries(
      [...files, ...includedOverrideFiles, ...linkedFiles, ...linkedOverrideFiles],
      realRoot,
    );
    const seen = new Set<string>();
    return rootSafeFiles
      .map(({ path: filePath, realPath }) => ({ filePath: normalizePath(filePath), realPath }))
      .filter(({ filePath, realPath }) => {
        if (seen.has(filePath)) return false;
        seen.add(filePath);
        const rootRelative = normalizePath(path.relative(root, filePath));
        if (!isRelativePathInside(rootRelative)) return false;
        if (!patternMatchers.some((matcher) => matcher(rootRelative))) return false;
        const matchesInclude =
          !includeMatchers.length ||
          includeMatchers.some((matcher) => matchesDiscoveryGlob(filePath, globRoot, matcher));
        if (!matchesInclude) return false;
        if (userIgnoreMatchers.some((matcher) => matchesDiscoveryGlob(filePath, globRoot, matcher))) {
          return false;
        }
        const ignoredByDefault = defaultIgnoreMatchers.some((matcher) => matcher(rootRelative));
        if (ignoredByDefault && !(includeMatchers.length > 0 && matchesInclude)) {
          return false;
        }
        if (isIgnoredByGitignore(filePath, gitignoreIndex)) return false;
        // The real path only differs when the entry was reached through a symlink, so
        // testing it again for every ordinary file doubled the matcher work for nothing.
        return normalizePath(realPath) === filePath || !isIgnoredByGitignore(realPath, gitignoreIndex);
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

/**
 * Resolve the symlinked directories under `root` that are safe to crawl.
 *
 * When `knownSymlinkDirectories` is provided, this re-verifies each previously
 * discovered path directly. Otherwise a Git-derived `candidatePaths` list avoids a
 * separate full-tree scan: Git already enumerated every tracked and non-ignored
 * untracked entry, including symlinks. Non-Git discovery retains the existing
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
    const verified = await mapLimitSemaphore(
      Array.from(new Set(options.knownSymlinkDirectories)),
      REALPATH_FILTER_CONCURRENCY,
      async (linkPath) => ((await isSafeSymlinkDirectory(root, linkPath, realRoot)) ? linkPath : null),
    );
    const resolved = verified.filter((entry): entry is string => entry !== null);
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
      return !ignoreMatchers.some((matcher) => matcher(relativePath));
    });
    const verified = await mapLimitSemaphore(candidatePaths, REALPATH_FILTER_CONCURRENCY, async (linkPath) =>
      (await isSafeSymlinkDirectory(root, linkPath, realRoot)) ? linkPath : null,
    );
    const discovered = verified.filter((entry): entry is string => entry !== null);
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
  const candidates = await mapLimitSemaphore(
    entries.filter((entry) => entry.dirent.isSymbolicLink()).map((entry) => entry.path),
    REALPATH_FILTER_CONCURRENCY,
    async (linkPath) => ((await isSafeSymlinkDirectory(root, linkPath, realRoot)) ? linkPath : null),
  );
  const discovered = candidates.filter((entry): entry is string => entry !== null);
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
    onSymlinkDirectoriesDiscovered?: (directories: readonly string[], mode: SymlinkProbeMode) => void;
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

    const projectFileDefinitionMatchers = PROJECT_FILE_DEFINITIONS.map((definition) =>
      definition.patterns.map((pattern) =>
        pattern.includes("*") || pattern.includes("?")
          ? new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$")
          : undefined,
      ),
    );
    const entries: ProjectFileInfo[] = [];
    const matchTasks = rootSafeMatches.map(async (cleanMatch) => {
      const stats = await fsp.stat(cleanMatch);
      const isDir = stats.isDirectory();
      const fileName = path.basename(cleanMatch);

      for (let definitionIndex = 0; definitionIndex < PROJECT_FILE_DEFINITIONS.length; definitionIndex++) {
        const def = PROJECT_FILE_DEFINITIONS[definitionIndex]!;
        if (isDir && def.kind !== "dir") continue;
        if (!isDir && def.kind !== "file") continue;

        const matchesPattern = def.patterns.some((pattern, patternIndex) => {
          const matcher = projectFileDefinitionMatchers[definitionIndex]![patternIndex];
          return matcher ? matcher.test(fileName) : pattern === fileName;
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
