import fs from "node:fs";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  diffBuildOptions,
  loadManifest,
  sanitizeManifestEntriesForRoot,
  type ManifestFileEntry,
} from "./build-cache.js";
import type { BuildOptions, IncrementalBuildOptions } from "./types.js";
import { listChangedFiles, listUntrackedFiles, type GitDiscoveryCache } from "../util/git.js";
import { errorMessage } from "../util/errors.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { mapLimit } from "../util/concurrency.js";
import { DEFAULT_RESOLUTION_EXTENSIONS, stripKnownResolutionExtension } from "../util/resolution-candidates.js";
import {
  createDiscoveredFileMatcher,
  DEFAULT_PROJECT_PATTERNS,
  filterRealPathsWithinRoot,
  type ProjectFileDiscoveryOptions,
} from "../util/project-files.js";

export type IncrementalGitDiffOptions = {
  base?: string;
  head?: string;
  changedSince?: string;
};

export type TrackedManifestFilePlan = {
  trackedFileList: string[];
  trackedFiles: Set<string>;
  deletedTrackedFiles: Set<string>;
};

/** Bound concurrent existence probes so warm builds don't stall the event loop. */
export const PATH_EXISTS_PROBE_CONCURRENCY = 64;

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe unique paths once with bounded concurrency. Scaling: O(unique paths)
 * syscalls instead of O(call sites × paths).
 */
export async function probePathExistence(
  paths: readonly string[],
  concurrency: number = PATH_EXISTS_PROBE_CONCURRENCY,
): Promise<Map<string, boolean>> {
  const uniquePaths = Array.from(new Set(paths));
  const results = await mapLimit(uniquePaths, concurrency, async (filePath) => {
    return [filePath, await pathExists(filePath)] as const;
  });
  return new Map(results);
}

export function isMissingGitRevisionError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("Invalid revision range") ||
    message.includes("bad revision") ||
    // A single-revision diff against WORKTREE (git diff --end-of-options <base>) reports
    // a missing base commit as "bad object", not "bad revision" (that phrasing is
    // specific to two-dot/three-dot range syntax); both mean the same thing here.
    message.includes("bad object") ||
    message.includes("unknown revision") ||
    message.includes("ambiguous argument")
  );
}

export function buildIncrementalGitDiffOptions(opts: IncrementalBuildOptions | undefined): IncrementalGitDiffOptions {
  const gitOpts: IncrementalGitDiffOptions = {};
  if (opts?.gitBase) gitOpts.base = opts.gitBase;
  if (opts?.gitHead) gitOpts.head = opts.gitHead;
  if (!opts?.gitBase && opts?.changedSince) gitOpts.changedSince = opts.changedSince;
  return gitOpts;
}

export async function partitionTrackedManifestFiles(
  trackedEntries: Record<string, ManifestFileEntry>,
  concurrency: number = PATH_EXISTS_PROBE_CONCURRENCY,
): Promise<TrackedManifestFilePlan> {
  const trackedFileList = Object.keys(trackedEntries);
  const existence = await probePathExistence(trackedFileList, concurrency);
  const trackedFiles = new Set<string>();
  const deletedTrackedFiles = new Set<string>();
  for (const file of trackedFileList) {
    if (existence.get(file)) trackedFiles.add(file);
    else deletedTrackedFiles.add(file);
  }
  return {
    trackedFileList,
    trackedFiles,
    deletedTrackedFiles,
  };
}

export function collectDeletedTrackedFileDependents(
  trackedEntries: Record<string, ManifestFileEntry>,
  deletedTrackedFiles: ReadonlySet<string>,
): Set<string> {
  const dependents = new Set<string>();
  if (!deletedTrackedFiles.size) return dependents;
  const deletedFileKeys = new Set(Array.from(deletedTrackedFiles, fileIdentityKey));
  for (const [file, entry] of Object.entries(trackedEntries)) {
    if (deletedFileKeys.has(fileIdentityKey(file))) continue;
    if (entry.edges.some((edge) => edge.to.type === "file" && deletedFileKeys.has(fileIdentityKey(edge.to.path)))) {
      dependents.add(file);
    }
  }
  return dependents;
}

const PYTHON_SOURCE_PATTERN = /\.pyi?$/iu;

/**
 * `from pkg import name` binds the `name` attribute of `pkg/__init__.py` when that file defines
 * one; otherwise, once `pkg/name.py` (or a namespace directory `pkg/name/` holding Python code)
 * exists, it binds the submodule. That edge is already resolved to `__init__.py`, so no external
 * edge names the added module. Returns cached Python importers of every package on the added
 * file's directory chain; they are reparsed instead of reused. The walk is conservative:
 * importers whose binding does not change reparse to the same result.
 */
export function collectPythonPackageImporters(
  trackedEntries: Record<string, ManifestFileEntry>,
  addedFiles: readonly string[],
): Set<string> {
  return pythonImportersOfPackageInits(
    Object.entries(trackedEntries).map(([file, entry]) => [
      file,
      entry.edges.flatMap((edge) => (edge.to.type === "file" ? [edge.to.path] : [])),
    ]),
    addedFiles,
  );
}

/**
 * Same as `collectPythonPackageImporters`, for builds without a manifest.
 * Takes the resolved import targets of each importer.
 */
export function pythonImportersOfPackageInits(
  importerTargets: Iterable<readonly [file: string, targets: readonly string[]]>,
  addedFiles: readonly string[],
): Set<string> {
  const packageInits = new Set<string>();
  for (const file of addedFiles) {
    if (!PYTHON_SOURCE_PATTERN.test(file)) continue;
    let directory = path.posix.dirname(normalizePath(file));
    let previous: string;
    do {
      for (const init of ["__init__.py", "__init__.pyi"]) {
        packageInits.add(fileIdentityKey(path.posix.join(directory, init)));
      }
      previous = directory;
      directory = path.posix.dirname(directory);
    } while (directory !== previous);
  }
  const importers = new Set<string>();
  if (!packageInits.size) return importers;
  for (const [file, targets] of importerTargets) {
    if (!PYTHON_SOURCE_PATTERN.test(file)) continue;
    if (targets.some((target) => packageInits.has(fileIdentityKey(target)))) importers.add(file);
  }
  return importers;
}

const RESOLUTION_ENTRY_STEMS = new Set(["index", "__init__", "mod", "package"]);
/** `.d.ts` and similar: a resolver probes `foo` + `.d.ts`, so `foo.d.ts` satisfies stem `foo`. */
const MULTI_PART_RESOLUTION_EXTENSIONS = DEFAULT_RESOLUTION_EXTENSIONS.filter(
  (extension) => extension.lastIndexOf(".") > 0,
);

type ExternalSpecifierResolutionRule = {
  separator: RegExp;
  importNamesDirectory?: "parent" | "ancestors";
  // Declaration imports name packages, not files, so a filename stem cannot match.
  // Any added file of the language re-resolves its importers.
  reResolveAnyAddedExtensions?: readonly string[];
  matchesModuleSegments?: boolean;
};

const DEFAULT_EXTERNAL_SPECIFIER_RULE: ExternalSpecifierResolutionRule = { separator: /[/\\]/u };

const EXTERNAL_SPECIFIER_RESOLUTION_RULES: Readonly<Record<string, ExternalSpecifierResolutionRule>> = {
  csharp: { separator: /[/\\]/u, reResolveAnyAddedExtensions: [".cs", ".csx"] },
  go: { separator: /\//u, importNamesDirectory: "parent" },
  java: { separator: /\./u, reResolveAnyAddedExtensions: [".java"] },
  kotlin: { separator: /\./u, reResolveAnyAddedExtensions: [".kt", ".kts", ".ktm"] },
  php: { separator: /[/\\]/u, reResolveAnyAddedExtensions: [".php", ".phtml", ".php4", ".php8"] },
  python: { separator: /[./\\]/u, importNamesDirectory: "ancestors" },
  rust: { separator: /::/u, matchesModuleSegments: true },
};

function externalSpecifierResolutionRule(languageId: string): ExternalSpecifierResolutionRule {
  return EXTERNAL_SPECIFIER_RESOLUTION_RULES[languageId] ?? DEFAULT_EXTERNAL_SPECIFIER_RULE;
}

/** Stems an added file can satisfy, plus directories used by language-specific module imports. */
export function addedResolutionStems(addedFiles: readonly string[], languageId = "default"): Set<string> {
  const rule = externalSpecifierResolutionRule(languageId);
  const stems = new Set<string>();
  for (const file of addedFiles) {
    const base = path.basename(file);
    const extension = path.extname(base);
    const fileStems = [extension ? base.slice(0, -extension.length) : base];
    const lowerBase = base.toLowerCase();
    for (const multiPart of MULTI_PART_RESOLUTION_EXTENSIONS) {
      if (lowerBase.endsWith(multiPart)) fileStems.push(base.slice(0, -multiPart.length));
    }
    for (const stem of fileStems) {
      if (stem) stems.add(stem);
    }
    if (!rule.importNamesDirectory && !fileStems.some((stem) => RESOLUTION_ENTRY_STEMS.has(stem))) continue;
    let directory = path.dirname(file);
    while (directory !== path.dirname(directory)) {
      stems.add(path.basename(directory));
      if (rule.importNamesDirectory !== "ancestors") break;
      directory = path.dirname(directory);
    }
  }
  return stems;
}

function externalSpecifierSegments(value: string, rule: ExternalSpecifierResolutionRule): string[] {
  return value.split(rule.separator).filter((segment) => segment && segment !== "." && segment !== "..");
}

/**
 * True when an added file can satisfy a declaration import.
 * The file has a built-in suffix, or its configured language is the importer's language
 * (for example, a `.jvm` file mapped to Kotlin).
 */
function hasAddedFileMatchingRule(
  rule: ExternalSpecifierResolutionRule,
  languageId: string,
  addedFiles: readonly string[],
  addedFileLanguageId?: (file: string) => string | undefined,
): boolean {
  const extensions = rule.reResolveAnyAddedExtensions;
  if (!extensions || !extensions.length) return false;
  return addedFiles.some(
    (file) => extensions.includes(path.extname(file).toLowerCase()) || addedFileLanguageId?.(file) === languageId,
  );
}

function specifierMatchesAddedStem(
  specifier: string,
  rule: ExternalSpecifierResolutionRule,
  addedStems: ReadonlySet<string>,
): boolean {
  const segments = externalSpecifierSegments(specifier, rule);
  const lastSegment = segments.at(-1) ?? specifier;
  if (addedStems.has(stripKnownResolutionExtension(lastSegment))) return true;
  if (!rule.matchesModuleSegments) return false;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (addedStems.has(stripKnownResolutionExtension(segments[index]!))) return true;
  }
  return false;
}

/**
 * tsconfig `paths` substitutions for a specifier, ignoring whether each target exists. The
 * longest matching prefix selects the pattern, matching tsconfig-paths; every fallback target
 * of that pattern is returned in order, because an added file can satisfy any of them.
 */
export function tsconfigAliasMappedTails(
  specifier: string,
  paths: Readonly<Record<string, readonly string[]>>,
): string[] {
  let best: { rank: number; tails: string[] } | null = null;
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf("*");
    let captured = "";
    let rank = 0;
    if (star === -1) {
      if (specifier !== pattern) continue;
      rank = pattern.length + 1000;
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      if (specifier.length < prefix.length + suffix.length) continue;
      captured = specifier.slice(prefix.length, specifier.length - suffix.length);
      rank = prefix.length;
    }
    const tails = targets
      .filter(Boolean)
      .map((target) => (target.includes("*") ? target.replace("*", captured) : target));
    if (!tails.length) continue;
    if (!best || rank > best.rank) best = { rank, tails };
  }
  return best?.tails ?? [];
}

export function externalSpecifierMatchesAddedStem(
  specifier: string,
  languageId: string,
  addedStems: ReadonlySet<string>,
  mappedTails: readonly string[] = [],
  addedFiles: readonly string[] = [],
  addedFileLanguageId?: (file: string) => string | undefined,
): boolean {
  if (!specifier) return false;
  const rule = externalSpecifierResolutionRule(languageId);
  if (hasAddedFileMatchingRule(rule, languageId, addedFiles, addedFileLanguageId)) return true;
  if (!addedStems.size) return false;
  if (specifierMatchesAddedStem(specifier, rule, addedStems)) return true;
  return mappedTails.some((tail) => specifierMatchesAddedStem(tail, rule, addedStems));
}

/**
 * Tracked files with a module-specifier edge. Used only when the tracked set gained a file;
 * the caller keeps only specifiers whose stem matches an added file. A deletion does not call
 * this: collectDeletedTrackedFileDependents already rebuilds importers of the deleted file,
 * and a lost file cannot make an unresolved specifier start resolving.
 *
 * Resolved edges stay candidates too: a newly added higher-priority file can supersede their
 * current target just as it can resolve an external edge.
 */
export function collectSpecifierEdgeCandidates(
  trackedEntries: Record<string, ManifestFileEntry>,
  trackedFileSetChanged: boolean,
): Set<string> {
  const candidates = new Set<string>();
  if (!trackedFileSetChanged) return candidates;
  for (const [file, entry] of Object.entries(trackedEntries)) {
    if (entry.edges.length) candidates.add(file);
  }
  return candidates;
}

export function buildTrackedFileReverseDependencies(
  trackedEntries: Record<string, ManifestFileEntry>,
): Map<string, Set<string>> {
  const reverseDeps = new Map<string, Set<string>>();
  for (const [file, entry] of Object.entries(trackedEntries)) {
    for (const edge of entry.edges) {
      if (edge.to.type !== "file") continue;
      const importedFileKey = fileIdentityKey(edge.to.path);
      let bucket = reverseDeps.get(importedFileKey);
      if (!bucket) {
        bucket = new Set<string>();
        reverseDeps.set(importedFileKey, bucket);
      }
      bucket.add(file);
    }
  }
  return reverseDeps;
}

export function collectTrackedFileDependents(
  trackedEntries: Record<string, ManifestFileEntry>,
  changedFiles: ReadonlySet<string>,
  reverseDeps = buildTrackedFileReverseDependencies(trackedEntries),
): Set<string> {
  const dependents = new Set<string>();
  if (!changedFiles.size) return dependents;

  const enqueued = new Set(Array.from(changedFiles, fileIdentityKey));
  const queue = [...enqueued];
  let head = 0;
  while (head < queue.length) {
    const targetKey = queue[head]!;
    head += 1;
    for (const dependent of reverseDeps.get(targetKey) ?? []) {
      const dependentKey = fileIdentityKey(dependent);
      if (enqueued.has(dependentKey)) continue;
      enqueued.add(dependentKey);
      dependents.add(dependent);
      queue.push(dependentKey);
    }
  }

  return dependents;
}

/**
 * List new, untracked files that Git sees but the manifest does not yet know about,
 * filtered to the same discovery patterns/ignores a full scan would apply.
 *
 * This is the one piece a manifest-plus-git-diff reconciliation cannot otherwise cover:
 * modified and deleted tracked files are already detected cheaply via git diff and
 * per-file signature checks, but a file that was just created and never committed or
 * staged has no tracked entry and no diff record. Errors are not swallowed here;
 * callers decide whether a failure should fall back to a full scan or be treated as a
 * best-effort miss.
 *
 * When `discovery.useGitignore` is `false`, Git's `--exclude-standard` is dropped too:
 * that mode explicitly wants gitignored files included, so filtering untracked
 * candidates through `.gitignore` here would be exactly backwards. The default
 * project-file ignores (`node_modules`, `.git`, build output, ...) still apply via
 * `createDiscoveredFileMatcher()` below regardless of this setting.
 */
export async function listUntrackedProjectFiles(
  projectRoot: string,
  discovery: ProjectFileDiscoveryOptions | undefined,
  gitAvailable: boolean,
  discoveryCache?: GitDiscoveryCache,
): Promise<string[]> {
  if (!gitAvailable) return [];
  const respectGitignore = discovery?.useGitignore !== false;
  const candidates = await listUntrackedFiles(projectRoot, {
    gitAvailable,
    respectGitignore,
    ...(discoveryCache ? { discoveryCache } : {}),
  });
  if (!candidates.length) return [];
  const globRoot = discovery?.globRoot ?? projectRoot;
  const isDiscoveredFile = createDiscoveredFileMatcher(projectRoot, globRoot, DEFAULT_PROJECT_PATTERNS, discovery);
  const matchingCandidates = candidates.filter(isDiscoveredFile);
  if (!matchingCandidates.length) return [];
  const realRoot = await fs.promises.realpath(projectRoot);
  return filterRealPathsWithinRoot(matchingCandidates, realRoot);
}

/**
 * Whether the cheap manifest-plus-git discovery path can stand in for a full recursive
 * scan. Requires a Git repository (the only source of untracked-file detection this
 * fast path has) and no `--cache-strict` request (an explicit ask for maximum
 * certainty over speed). `useGitignore: false` no longer disqualifies the fast path:
 * `listUntrackedProjectFiles()` drops `--exclude-standard` in that mode instead of
 * giving up, so it stays correct either way.
 */
export function canUseIncrementalDiscoveryFastPath(gitAvailable: boolean, cacheStrict: boolean | undefined): boolean {
  return gitAvailable && !cacheStrict;
}

/**
 * Resolve the current project file list from the on-disk manifest plus a cheap Git
 * reconciliation, without building or parsing anything. Returns `null` whenever the
 * fast path cannot be trusted to be complete: no manifest yet, a discovery-option
 * change since the manifest was written, no Git repository, `--cache-strict`, or a
 * Git command failure (most commonly a manifest commit that no longer exists, e.g.
 * after a rebase or shallow-clone gc). Callers must fall back to a full
 * `listProjectFiles()` scan when this returns `null`.
 */
export type IncrementalFilePlan = {
  files: string[];
  manifestUpdatedAt: number;
  workingTreeDiffFiles: string[];
  untrackedFiles: string[];
};

export async function resolveIncrementalFilePlan(
  projectRoot: string,
  opts: BuildOptions | undefined,
  discoveryCache?: GitDiscoveryCache,
): Promise<IncrementalFilePlan | null> {
  const manifest = await loadManifest(projectRoot, opts);
  if (!manifest) return null;
  if (!manifest.buildOptions) return null;
  if (diffBuildOptions(manifest.buildOptions, opts).includes("discovery")) return null;

  if (opts?.cacheStrict) return null;

  try {
    const trackedEntries = sanitizeManifestEntriesForRoot(projectRoot, manifest.files);
    const { trackedFiles } = await partitionTrackedManifestFiles(trackedEntries);

    // Diff against the working tree, not just the current commit: a file that was
    // `git add`ed but never committed is neither in the manifest (not yet indexed) nor
    // reported by `git ls-files --others` (it is no longer "untracked" once staged), so
    // a commit-only diff would miss it entirely whenever HEAD hasn't moved. Diffing the
    // last-indexed commit against WORKTREE catches staged and unstaged tracked-file
    // changes together, including new commits made since (working tree reflects those
    // too when clean), so this replaces the narrower commit-to-commit comparison.
    const [workingTreeDiffFiles, untrackedFiles] = await Promise.all([
      manifest.lastCommit ? listChangedFiles(projectRoot, { base: manifest.lastCommit, head: "WORKTREE" }) : [],
      listUntrackedProjectFiles(projectRoot, opts?.discovery, true, discoveryCache),
    ]);

    const candidatePaths = [...workingTreeDiffFiles, ...untrackedFiles];
    const existence = candidatePaths.length ? await probePathExistence(candidatePaths) : new Map<string, boolean>();
    const files = new Set<string>(trackedFiles);
    for (const file of workingTreeDiffFiles) if (existence.get(file)) files.add(file);
    for (const file of untrackedFiles) if (existence.get(file)) files.add(file);
    return {
      files: Array.from(files).sort(),
      manifestUpdatedAt: manifest.updatedAt,
      workingTreeDiffFiles,
      untrackedFiles,
    };
  } catch {
    // Any failure here (stale/missing manifest commit, transient Git error, ...) means
    // the fast path cannot be trusted. Fall back to a full scan rather than risk an
    // incomplete or stale file list.
    return null;
  }
}
export async function resolveIncrementalFileList(
  projectRoot: string,
  opts: BuildOptions | undefined,
): Promise<string[] | null> {
  const plan = await resolveIncrementalFilePlan(projectRoot, opts);
  return plan?.files ?? null;
}
