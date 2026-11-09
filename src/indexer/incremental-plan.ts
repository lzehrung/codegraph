import fsp from "node:fs/promises";
import path from "node:path";
import { languageExtensionPatterns } from "../languages.js";
import {
  diffBuildOptions,
  gitSignatureBlobId,
  loadManifest,
  sanitizeManifestEntriesForRoot,
  type FileSignature,
  type IndexManifest,
  type ManifestFileEntry,
} from "./build-cache.js";
import type { BuildOptions, IncrementalBuildOptions } from "./types.js";
import {
  listChangedFileEntries,
  listGitIndexedBlobs,
  listGitSubmoduleDirectories,
  listSubmoduleFiles,
  listUntrackedAndFlaggedFiles,
} from "../util/git.js";
import { errorMessage } from "../util/errors.js";
import { IMPORT_RESOLUTION_ROWS, type ExternalSpecifierSeparator } from "./import-resolution-tables.js";
import { fileIdentityKey, isFileIdentityCaseInsensitive, normalizePath, pathExists } from "../util/paths.js";
import { mapLimit } from "../util/concurrency.js";
import { DEFAULT_RESOLUTION_EXTENSIONS, stripKnownResolutionExtension } from "../util/resolution-candidates.js";
import {
  createProjectDiscoveryContext,
  filterDiscoveredProjectFileCandidates,
  DEFAULT_PROJECT_PATTERNS,
  type ProjectFileDiscoveryOptions,
  type ProjectDiscoveryContext,
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
/** Sass loads `dir/_index.scss` for `@use "dir"`, the same directory role as `dir/index.scss`. */
const SCSS_PARTIAL_INDEX_STEM = "_index";
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

const PATH_SEPARATOR = /[/\\]/u;
const SLASH_SEPARATOR = /\//u;
const DOT_SEPARATOR = /\./u;
const PYTHON_SEPARATOR = /[./\\]/u;
const RUST_SEPARATOR = /::/u;

const DEFAULT_EXTERNAL_SPECIFIER_RULE: ExternalSpecifierResolutionRule = { separator: PATH_SEPARATOR };

function separatorPattern(separator: ExternalSpecifierSeparator): RegExp {
  if (separator === "slash") return SLASH_SEPARATOR;
  if (separator === "dot") return DOT_SEPARATOR;
  if (separator === "python") return PYTHON_SEPARATOR;
  if (separator === "rust") return RUST_SEPARATOR;
  return PATH_SEPARATOR;
}

function externalSpecifierResolutionRule(languageId: string): ExternalSpecifierResolutionRule {
  const data = IMPORT_RESOLUTION_ROWS[languageId]?.externalSpecifierResolution;
  if (!data) return DEFAULT_EXTERNAL_SPECIFIER_RULE;
  return {
    separator: separatorPattern(data.separator),
    ...(data.importNamesDirectory ? { importNamesDirectory: data.importNamesDirectory } : {}),
    ...(data.reResolveAnyAddedExtensions ? { reResolveAnyAddedExtensions: data.reResolveAnyAddedExtensions } : {}),
    ...(data.matchesModuleSegments ? { matchesModuleSegments: true } : {}),
  };
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
    const directoryEntry = fileStems.some(
      (stem) =>
        RESOLUTION_ENTRY_STEMS.has(stem) ||
        (languageId === "scss" && stem === SCSS_PARTIAL_INDEX_STEM && path.extname(file).toLowerCase() === ".scss"),
    );
    if (!rule.importNamesDirectory && !directoryEntry) continue;
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
 * Files that import one of the files named by `fileKeys` (`fileIdentityKey` values), by the previous
 * build's manifest edges and without following their own importers. An importer caches only what a
 * target's public surface covers, so a file whose surface changed invalidates exactly these.
 */
export function collectDirectDependents(
  reverseDeps: ReadonlyMap<string, ReadonlySet<string>>,
  fileKeys: Iterable<string>,
): Set<string> {
  const dependents = new Set<string>();
  for (const fileKey of fileKeys) {
    for (const dependent of reverseDeps.get(fileKey) ?? []) dependents.add(dependent);
  }
  return dependents;
}

/** Apply full-build discovery rules to new Git candidates while preserving manifest and explicit-file membership. */
export async function filterIncrementalDiscoveryCandidates(
  projectRoot: string,
  files: readonly string[],
  trackedEntries: Record<string, ManifestFileEntry>,
  opts: BuildOptions | undefined,
  discoveryContext?: ProjectDiscoveryContext,
): Promise<string[]> {
  const newCandidates = Array.from(new Set(files.filter((file) => !Object.hasOwn(trackedEntries, file))));
  const discoveredFiles = new Set(
    await filterDiscoveredProjectFileCandidates(
      projectRoot,
      newCandidates,
      [...DEFAULT_PROJECT_PATTERNS, ...languageExtensionPatterns(opts?.languageExtensions)],
      {
        ...opts?.discovery,
        ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
        ...(discoveryContext ? { discoveryContext } : {}),
      },
    ),
  );
  return files.filter((file) => Object.hasOwn(trackedEntries, file) || discoveredFiles.has(file));
}

/** Prefer Git content identity; an unchanged untracked file can gain its first Git signature after staging. */
export function manifestFileSignatureMatches(
  entry: ManifestFileEntry | undefined,
  signature: FileSignature,
  strict?: boolean,
): boolean {
  if (!entry) return false;
  const hasGitIdentities = !!entry.gitSig && !!signature.gitSig;
  if (hasGitIdentities) return entry.gitSig === signature.gitSig;
  if (entry.sig === signature.sig) return true;
  const gainedGitIdentity = !entry.gitSig && !!signature.gitSig;
  if (!gainedGitIdentity || strict) return false;
  return entry.sig.startsWith(`${signature.sig}:`);
}

/**
 * Previously dirty tracked paths stay candidates after restoration or reversion makes Git's diff empty.
 * New manifests record those paths, so a clean indexed state needs no blob listing. Older or invalid metadata
 * falls back to comparing reusable index blob ids; entries without one still need signature validation.
 *
 * The dirty record is trusted only beside the flagged record written with it. A manifest without that one predates
 * the record of the files a flag hid, so its dirty record says nothing about them: only the blob ids do.
 */
export async function collectGitManifestChangeCandidates(
  projectRoot: string,
  trackedEntries: Record<string, ManifestFileEntry>,
  discoveryContext: ProjectDiscoveryContext,
  recorded?: Pick<IndexManifest, "gitDirtyFiles" | "gitFlaggedFiles">,
): Promise<string[]> {
  const { gitDirtyFiles, gitFlaggedFiles } = recorded ?? {};
  if (gitDirtyFiles && gitFlaggedFiles) return gitDirtyFiles;
  const indexed = await listGitIndexedBlobs(projectRoot, discoveryContext.git);
  const candidates: string[] = [];
  for (const { rel, blob } of indexed) {
    const file = normalizePath(path.isAbsolute(rel) ? rel : path.resolve(projectRoot, rel));
    const entry = trackedEntries[file];
    if (!entry?.gitSig || !blob || gitSignatureBlobId(entry.gitSig) !== blob) candidates.push(file);
  }
  return candidates;
}

/**
 * List new, untracked files that Git sees but the manifest does not yet know about,
 * filtered to the same discovery patterns/ignores a full scan would apply.
 *
 * Modified and deleted tracked files are detected via Git diffs, manifest/blob reconciliation and per-file
 * signature checks. A file that was just created and never committed or staged has none of those signals.
 * Errors are not swallowed here; callers decide whether a failure should fall back to a full scan.
 *
 * When `discovery.useGitignore` is `false`, Git's `--exclude-standard` is dropped too:
 * that mode explicitly wants gitignored files included, so filtering untracked
 * candidates through `.gitignore` here would be exactly backwards. The default
 * project-file ignores (`node_modules`, `.git`, build output, ...) and the full
 * scan's symlink policy still apply regardless of this setting.
 */
export async function listUntrackedProjectFiles(
  projectRoot: string,
  discovery: ProjectFileDiscoveryOptions | undefined,
  gitAvailable: boolean,
  discoveryContext?: ProjectDiscoveryContext,
): Promise<string[]> {
  if (!gitAvailable) return [];
  const context = discoveryContext ?? createProjectDiscoveryContext(projectRoot);
  // The same Git child also names the tracked files Git cannot compare; see `listGitWorktreeSignals`.
  const { untracked } = await listUntrackedAndFlaggedFiles(projectRoot, {
    respectGitignore: discovery?.useGitignore !== false,
    discoveryCache: context.git,
  });
  return filterDiscoveredProjectFileCandidates(projectRoot, untracked, DEFAULT_PROJECT_PATTERNS, {
    ...discovery,
    discoveryContext: context,
  });
}

/**
 * What the untracked listing's Git child reports about tracked files: those Git cannot compare, and each path's
 * spelling. Each is read on first use.
 */
export type GitWorktreeSignals = {
  flaggedFiles: () => readonly string[];
  isCurrentSpelling: (file: string) => boolean;
  /** Every tracked and untracked path as the listing spells it. */
  listedFiles: () => Iterable<string>;
};

function* listedPaths(tracked: ReadonlySet<string> | undefined, untracked: ReadonlySet<string>): Generator<string> {
  if (tracked) yield* tracked;
  yield* untracked;
}

/**
 * Tracked files whose worktree Git cannot compare with the index, and the spelling Git records for each tracked or
 * untracked path. Both come from the listing `listUntrackedProjectFiles` reads, so a caller that lists untracked files
 * first (or at the same time) spawns no further Git child.
 */
export async function listGitWorktreeSignals(
  projectRoot: string,
  discovery: ProjectFileDiscoveryOptions | undefined,
  discoveryContext: ProjectDiscoveryContext,
): Promise<GitWorktreeSignals> {
  const listing = await listUntrackedAndFlaggedFiles(projectRoot, {
    respectGitignore: discovery?.useGitignore !== false,
    discoveryCache: discoveryContext.git,
  });
  const untracked = new Set(listing.untracked);
  return {
    flaggedFiles: () => listing.flaggedFiles?.() ?? [],
    isCurrentSpelling: (file) => !!listing.trackedPaths?.().has(file) || untracked.has(file),
    listedFiles: () => listedPaths(listing.trackedPaths?.(), untracked),
  };
}

/**
 * Files the manifest has not seen, or whose current stat differs from the manifest's `mtime:size` signature. A file
 * that cannot be read counts as stale. Non-strict signatures are `${mtimeMs}:${size}`; strict ones append the content
 * hash, so either form matches when the stat prefix does.
 */
export async function findStaleOrUnseenManifestFiles(
  files: readonly string[],
  trackedEntries: Record<string, ManifestFileEntry>,
  concurrency: number = PATH_EXISTS_PROBE_CONCURRENCY,
): Promise<string[]> {
  const stale = await mapLimit([...files], concurrency, async (file) => {
    const entry = trackedEntries[file];
    if (!entry?.sig) return true;
    try {
      const stat = await fsp.stat(file);
      const prefix = `${stat.mtimeMs}:${stat.size}`;
      return entry.sig !== prefix && !entry.sig.startsWith(`${prefix}:`);
    } catch {
      return true;
    }
  });
  return files.filter((_, index) => stale[index]);
}

/**
 * The submodules an update lists, and their files as Git spells them. A changed submodule is one path (its gitlink) in
 * the superproject's diff, so its own tracked and untracked files are listed as cold discovery lists them. The
 * submodules are the diff's changed gitlinks plus the ones the manifest recorded as dirty, so a submodule restored
 * since is reconciled once. A manifest that recorded none (absent or invalid) reconciles every submodule.
 */
async function listReconciledSubmoduleFiles(args: {
  projectRoot: string;
  changedSubmodules: readonly string[];
  /** Submodules the manifest recorded as dirty, or undefined when it recorded none. */
  recordedSubmodules: readonly string[] | undefined;
  opts: BuildOptions | undefined;
  context: ProjectDiscoveryContext;
  concurrency: number;
}): Promise<string[]> {
  const directories = new Set([...args.changedSubmodules, ...(args.recordedSubmodules ?? [])]);
  if (args.recordedSubmodules === undefined) {
    for (const directory of await listGitSubmoduleDirectories(args.projectRoot)) directories.add(directory);
  }
  const initialized = await mapLimit([...directories], args.concurrency, async (directory) =>
    (await pathExists(path.join(directory, ".git"))) ? directory : null,
  );
  const respectGitignore = args.opts?.discovery?.useGitignore !== false;
  const listings = await mapLimit(
    initialized.filter((directory): directory is string => directory !== null),
    args.concurrency,
    (directory) => listSubmoduleFiles(directory, { respectGitignore, discoveryCache: args.context.git }),
  );
  return listings.flat();
}

function parentDirectory(file: string): string {
  const separator = file.lastIndexOf("/");
  if (separator < 0) return ".";
  return file.slice(0, separator);
}

/**
 * The files among `files` that exist. A directory is probed only once its parent is known to exist, so the files of an
 * absent directory tree cost one probe at its top: a sparse checkout flags every file it leaves out, and most of those
 * directories are absent. A file is probed only when its directory exists.
 */
async function findExistingFiles(
  projectRoot: string,
  files: readonly string[],
  concurrency: number,
): Promise<string[]> {
  if (!files.length) return [];
  const root = normalizePath(path.resolve(projectRoot));
  const rootPrefix = root.endsWith("/") ? root : `${root}/`;
  const directoryProbes = new Map<string, Promise<boolean>>();
  const directoryExists = (directory: string): Promise<boolean> => {
    let probe = directoryProbes.get(directory);
    if (!probe) {
      probe = probeDirectory(directory);
      directoryProbes.set(directory, probe);
    }
    return probe;
  };
  const probeDirectory = async (directory: string): Promise<boolean> => {
    // The root, and anything outside it, is not probed: callers pass files inside the root.
    if (!directory.startsWith(rootPrefix)) return true;
    return (await directoryExists(parentDirectory(directory))) && (await pathExists(directory));
  };
  const directories = new Set(files.map(parentDirectory));
  const existingDirectories = new Set<string>();
  await mapLimit([...directories], concurrency, async (directory) => {
    if (await directoryExists(directory)) existingDirectories.add(directory);
  });
  const inExistingDirectory = files.filter((file) => existingDirectories.has(parentDirectory(file)));
  const existence = await probePathExistence(inExistingDirectory, concurrency);
  return inExistingDirectory.filter((file) => existence.get(file));
}

/** Changes Git's diff and index listings cannot show, found by comparing files with the manifest. */
export type GitHiddenChanges = {
  /**
   * Files for a signature check: the submodule, flagged and respelled files whose stat differs from the manifest, or
   * that it has not seen.
   */
  files: string[];
  /** Manifest paths retired because Git now spells their file differently (a case-only rename). */
  retiredTrackedFiles: string[];
  /** Paths a caller removes from its own candidates: the retired keys, and candidates Git does not spell that way. */
  droppedSpellings: Set<string>;
};

/**
 * Reconciles the changes Git's diff and index listings cannot show. Each file it names is one an update verifies
 * against the manifest by stat, because Git has nothing to say about it.
 *
 * - A changed submodule is one path (its gitlink) in the superproject's diff, so its own files are listed
 *   (`listReconciledSubmoduleFiles`). Inside a submodule only that listing says how Git spells a file, so it also
 *   settles a case-only rename there.
 * - A tracked file flagged assume-unchanged or skip-worktree is omitted from every Git diff. The files flagged now and
 *   those the manifest recorded as flagged are both verified: clearing a flag (`git sparse-checkout add` does) shows
 *   a file that differs from `lastCommit` in the diff, but one that matches it nowhere. A flagged file the manifest
 *   has is compared by stat. One it lacks is a file that was absent, or is not discovered; it is indexed when it now
 *   exists and discovery accepts it.
 * - Git's diff names no file when a case-only rename arrives through the index's spelling alone (a branch switch,
 *   `git reset --hard`, `git checkout -f`), so every manifest key is compared with the spelling of the listing the update
 *   already read (`findRespelledTrackedFiles`).
 *
 * `args.trackedEntries` loses the manifest keys retired for a case-only rename, so the candidates that follow see the
 * file's new spelling as unseen.
 */
export async function reconcileGitHiddenChanges(args: {
  projectRoot: string;
  trackedEntries: Record<string, ManifestFileEntry>;
  /** Files Git's diff, the manifest's dirty record or the untracked listing already named. */
  gitCandidates: readonly string[];
  /** The gitlinks Git's diff reports as changed. */
  changedSubmodules: readonly string[];
  /** What the manifest recorded about submodules and flags; undefined when there is no manifest. */
  manifest: Pick<IndexManifest, "gitDirtySubmodules" | "gitFlaggedFiles"> | undefined;
  signals: GitWorktreeSignals;
  opts: BuildOptions | undefined;
  context: ProjectDiscoveryContext;
  concurrency?: number;
}): Promise<GitHiddenChanges> {
  const concurrency = args.concurrency ?? PATH_EXISTS_PROBE_CONCURRENCY;
  const submoduleFiles = await listReconciledSubmoduleFiles({
    projectRoot: args.projectRoot,
    changedSubmodules: args.changedSubmodules,
    recordedSubmodules: args.manifest?.gitDirtySubmodules,
    opts: args.opts,
    context: args.context,
    concurrency,
  });
  let submoduleSpellings: Set<string> | undefined;
  const isCurrentSpelling = (file: string): boolean => {
    if (args.signals.isCurrentSpelling(file)) return true;
    submoduleSpellings ??= new Set(submoduleFiles);
    return submoduleSpellings.has(file);
  };
  // Iterated more than once: the exact-spelling check reads it, and so does the folding pass.
  const listedFiles: Iterable<string> = {
    *[Symbol.iterator]() {
      yield* args.signals.listedFiles();
      yield* submoduleFiles;
    },
  };
  const respelled = findRespelledTrackedFiles(args.trackedEntries, listedFiles, isCurrentSpelling, args.gitCandidates);
  for (const key of respelled.retiredTrackedFiles) delete args.trackedEntries[key];

  const verified = new Set(
    await filterIncrementalDiscoveryCandidates(
      args.projectRoot,
      [...submoduleFiles, ...respelled.respelledFiles],
      args.trackedEntries,
      args.opts,
      args.context,
    ),
  );
  const flagged = new Set([...args.signals.flaggedFiles(), ...(args.manifest?.gitFlaggedFiles ?? [])]);
  const unindexedFlagged: string[] = [];
  for (const file of flagged) {
    if (respelled.droppedSpellings.has(file)) continue;
    if (Object.hasOwn(args.trackedEntries, file)) verified.add(file);
    else unindexedFlagged.push(file);
  }
  const reappeared = await filterIncrementalDiscoveryCandidates(
    args.projectRoot,
    await findExistingFiles(args.projectRoot, unindexedFlagged, concurrency),
    args.trackedEntries,
    args.opts,
    args.context,
  );
  for (const file of reappeared) verified.add(file);
  return {
    files: await findStaleOrUnseenManifestFiles([...verified], args.trackedEntries, concurrency),
    retiredTrackedFiles: respelled.retiredTrackedFiles,
    droppedSpellings: respelled.droppedSpellings,
  };
}

/**
 * Whether the listing settles every spelling by exact lookups, so no path needs case folding: each manifest key and each
 * candidate is listed verbatim, and no two listed paths differ only in case. Then no key is retired and no candidate
 * dropped. Listed paths are `/`-separated, so lowercasing one is its `fileIdentityKey` on a case-insensitive file
 * system. A path without an uppercase letter can collide only with one that has, which finds it by lookup; a listing
 * without uppercase letters is checked by one lowercase pass and no allocation.
 */
function isSpellingSettled(
  trackedEntries: Record<string, ManifestFileEntry>,
  listedFiles: Iterable<string>,
  isListed: (file: string) => boolean,
  candidates: readonly string[],
): boolean {
  if (!candidates.every((candidate) => isListed(candidate))) return false;
  if (!Object.keys(trackedEntries).every((key) => isListed(key))) return false;
  const lowercased = new Set<string>();
  for (const file of listedFiles) {
    const lowercase = file.toLowerCase();
    if (lowercase === file) continue;
    if (isListed(lowercase) || lowercased.has(lowercase)) return false;
    lowercased.add(lowercase);
  }
  return true;
}

/**
 * On a case-insensitive file system a rename that only changes case leaves the manifest key spelled the old way, and an
 * existence probe still finds the file. Both spellings then index one file: the stale key's edges outlive the rename and
 * which spelling a module carries depends on processing order. Git's listing spells each file one way, and a cold build
 * keeps that spelling, so the update does too:
 *
 * - A manifest key that the listing does not spell, or that a later listed spelling of the same file replaces, is retired
 *   when the listing spells that file another way. A listed spelling the manifest does not hold is `respelledFiles`, which
 *   an update indexes as new.
 * - A candidate the manifest does not hold, which names a spelling the listing does not use for that file (a diff names
 *   both spellings of a renamed file), is dropped. `droppedSpellings` holds those and the retired keys, which a diff still
 *   names as deleted.
 *
 * An index can hold one path in two spellings at once (after a conflicted stash pop, or `git checkout HEAD -- <old
 * spelling>` following a staged case rename). A cold build then keeps the last spelling it lists
 * (`normalizeIndexedFileInputs`), and so does this.
 *
 * The comparison is in memory, with no Git child and no stat. An exact-spelling check (`isSpellingSettled`) settles the
 * common update without case folding. Otherwise every listed path is case-folded once, and keys and candidates the
 * listing spells itself are settled by an exact lookup. `listedFiles` is read twice then, so it must be re-iterable (a
 * generator is not).
 */
export function findRespelledTrackedFiles(
  trackedEntries: Record<string, ManifestFileEntry>,
  listedFiles: Iterable<string>,
  isListed: (file: string) => boolean,
  candidates: readonly string[] = [],
): { retiredTrackedFiles: string[]; respelledFiles: string[]; droppedSpellings: Set<string> } {
  const unrespelled = { retiredTrackedFiles: [], respelledFiles: [], droppedSpellings: new Set<string>() };
  if (!isFileIdentityCaseInsensitive()) return unrespelled;
  if (isSpellingSettled(trackedEntries, listedFiles, isListed, candidates)) return unrespelled;
  const spellingByIdentity = new Map<string, string>();
  // Listed spellings that a later listed spelling of the same file replaces.
  const outranked = new Set<string>();
  for (const file of listedFiles) {
    const identity = fileIdentityKey(file);
    const earlier = spellingByIdentity.get(identity);
    if (earlier !== undefined && earlier !== file) outranked.add(earlier);
    spellingByIdentity.set(identity, file);
  }
  const isListedSpelling = (file: string): boolean => isListed(file) && !outranked.has(file);
  const retired = new Set<string>();
  const respelledFiles = new Set<string>();
  const replacedBy = (file: string): string | undefined => {
    const spelling = spellingByIdentity.get(fileIdentityKey(file));
    return spelling === file ? undefined : spelling;
  };
  for (const key of Object.keys(trackedEntries)) {
    if (isListedSpelling(key)) continue;
    const spelling = replacedBy(key);
    if (spelling === undefined) continue;
    retired.add(key);
    if (!Object.hasOwn(trackedEntries, spelling)) respelledFiles.add(spelling);
  }
  const droppedSpellings = new Set(retired);
  for (const candidate of new Set(candidates)) {
    if (Object.hasOwn(trackedEntries, candidate) || isListedSpelling(candidate)) continue;
    const spelling = replacedBy(candidate);
    if (spelling === undefined) continue;
    droppedSpellings.add(candidate);
    if (!Object.hasOwn(trackedEntries, spelling)) respelledFiles.add(spelling);
  }
  return {
    retiredTrackedFiles: Array.from(retired),
    respelledFiles: Array.from(respelledFiles),
    droppedSpellings,
  };
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
  /** Manifest paths retired because Git now spells their file differently (a case-only rename). */
  retiredTrackedFiles: string[];
  /** The part of `workingTreeDiffFiles` Git cannot report on: submodule and flagged files, verified by stat. */
  hiddenChangeFiles: string[];
};

export async function resolveIncrementalFilePlan(
  projectRoot: string,
  opts: BuildOptions | undefined,
  discoveryContext?: ProjectDiscoveryContext,
): Promise<IncrementalFilePlan | null> {
  const manifest = await loadManifest(projectRoot, opts);
  if (!manifest) return null;
  if (!manifest.buildOptions) return null;
  const changedOptions = diffBuildOptions(manifest.buildOptions, opts);
  if (changedOptions.some((option) => ["discovery", "languageExtensions", "coreAlgorithm"].includes(option)))
    return null;

  if (opts?.cacheStrict) return null;
  if (!manifest.lastCommit) return null;

  try {
    const trackedEntries = sanitizeManifestEntriesForRoot(projectRoot, manifest.files);
    const context = discoveryContext ?? createProjectDiscoveryContext(projectRoot);
    const { trackedFiles } = await partitionTrackedManifestFiles(trackedEntries);

    // Diff against the working tree, not just the current commit: a file that was
    // `git add`ed but never committed is neither in the manifest (not yet indexed) nor
    // reported by `git ls-files --others` (it is no longer "untracked" once staged), so
    // a commit-only diff would miss it entirely whenever HEAD hasn't moved. Diffing the
    // last-indexed commit against WORKTREE catches staged and unstaged tracked-file
    // changes together, including new commits made since (working tree reflects those
    // too when clean), so this replaces the narrower commit-to-commit comparison.
    const [diffResult, untrackedResult, candidatesResult, signalsResult] = await Promise.allSettled([
      listChangedFileEntries(projectRoot, {
        base: manifest.lastCommit,
        head: "WORKTREE",
        includeRenameSources: true,
        includeHiddenSubmoduleChanges: true,
        discoveryCache: context.git,
      }),
      listUntrackedProjectFiles(projectRoot, opts?.discovery, true, context),
      collectGitManifestChangeCandidates(projectRoot, trackedEntries, context, manifest),
      listGitWorktreeSignals(projectRoot, opts?.discovery, context),
    ]);
    // A failed Git probe must not leave another child holding the project directory open.
    if (diffResult.status === "rejected") throw diffResult.reason;
    if (untrackedResult.status === "rejected") throw untrackedResult.reason;
    if (candidatesResult.status === "rejected") throw candidatesResult.reason;
    if (signalsResult.status === "rejected") throw signalsResult.reason;
    const diff = diffResult.value;
    const untrackedFiles = untrackedResult.value;
    const manifestCandidates = candidatesResult.value;
    const signals = signalsResult.value;
    const hidden = await reconcileGitHiddenChanges({
      projectRoot,
      trackedEntries,
      gitCandidates: [...diff.files, ...manifestCandidates, ...untrackedFiles],
      changedSubmodules: diff.gitlinks,
      manifest,
      signals,
      opts,
      context,
    });
    for (const file of hidden.retiredTrackedFiles) trackedFiles.delete(file);
    const gitDiffFiles = await filterIncrementalDiscoveryCandidates(
      projectRoot,
      [...new Set([...diff.files, ...manifestCandidates])].filter((file) => !hidden.droppedSpellings.has(file)),
      trackedEntries,
      opts,
      context,
    );
    const workingTreeDiffFiles = [...new Set([...gitDiffFiles, ...hidden.files])];

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
      retiredTrackedFiles: hidden.retiredTrackedFiles,
      hiddenChangeFiles: hidden.files,
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
