import { AsyncLocalStorage } from "node:async_hooks";
import fs, { type Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "./errors.js";

/**
 * Answers the existence, type, and real-path questions of module resolution from one `readdir` per
 * directory instead of one `stat` and two `realpath` calls per candidate.
 *
 * - One cache lives for one index build ({@link runWithProbeCache}). A file created between two builds
 *   is seen by the second, and a path probed outside a build is never answered from a build's snapshot.
 * - Every answer equals what `fs.stat` and `fs.realpath` give for the same spelling. The cache lists a
 *   directory only when it can say so for sure. It asks the file system instead for a symbolic link, an
 *   entry of unknown type, a directory it cannot list or search, a name that only matches under a case
 *   or normalization rule it cannot prove (non-ASCII text in a case-insensitive directory, macOS
 *   normalization), and the Windows names that Win32 rewrites (trailing dot or space, `~`, `:`, devices).
 * - Case sensitivity is read from each directory (one `lstat` of a case-flipped entry name), not from the
 *   platform, so a case-sensitive directory on Windows and a case-insensitive mount on Linux both answer
 *   as `fs.stat` does.
 * - A directory is listed once more than {@link DIRECT_PROBE_BUDGET} different names were asked of it.
 *   Fewer probes use `stat`, so a walk up through large ancestors (a temp or home directory) never lists them.
 */

/** What `fs.stat` reports for a path. A path that `fs.stat` rejects for has no kind (`null`). */
export type ProbeKind = "file" | "directory" | "other";

export type ProbeDirent = Pick<
  Dirent,
  "name" | "isFile" | "isDirectory" | "isSymbolicLink" | "isFIFO" | "isSocket" | "isCharacterDevice" | "isBlockDevice"
>;

/** File system operations behind the cache. Tests pass a fake to model case modes and errors. */
export type FsProbeOps = {
  readdir(directory: string): Promise<readonly ProbeDirent[]>;
  stat(target: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  lstat(target: string): Promise<unknown>;
  realpath(target: string): Promise<string>;
  /** Rejects when the directory cannot be searched, so its entries cannot be `stat`ed. */
  access(directory: string): Promise<void>;
  /** Whether names match up to Unicode normalization (macOS), so a non-ASCII entry can answer for another spelling. */
  readonly normalizationInsensitive: boolean;
  /** Whether `realpath` returns an entry's stored name when the path spells it in another case (Windows). */
  readonly realpathStoresCase: boolean;
};

/** Looks each function up at call time, so a spy installed on `fs/promises` still sees every call. */
const nodeOps: FsProbeOps = {
  readdir: (directory) => fsp.readdir(directory, { withFileTypes: true }),
  stat: (target) => fsp.stat(target),
  lstat: (target) => fsp.lstat(target),
  realpath: (target) => fsp.realpath(target),
  access: (directory) => fsp.access(directory, fs.constants.X_OK),
  normalizationInsensitive: process.platform === "darwin",
  realpathStoresCase: process.platform === "win32",
};

/** Different names asked of one directory before its listing is read. */
const DIRECT_PROBE_BUDGET = 3;

const IS_WINDOWS = process.platform === "win32";
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

const MISSING = "missing" as const;
const UNKNOWN = "unknown" as const;
const PENDING = "pending" as const;
const MISSING_DIRECTORY = "missing-directory" as const;
const UNLISTABLE_DIRECTORY = "unlistable-directory" as const;

/** `unresolved` entries (links, entries of unknown type) need the file system to follow them. */
type EntryKind = ProbeKind | "unresolved";
type ListingEntry = { readonly name: string; readonly kind: EntryKind };
type CaseMode = "sensitive" | "insensitive" | "unknown";
type LookupResult = ListingEntry | typeof MISSING | typeof UNKNOWN | typeof PENDING;

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

/** Win32 rewrites these names before they reach the file system, so a listing cannot answer for them. */
function isWindowsHazardousName(name: string): boolean {
  if (!IS_WINDOWS) return false;
  const last = name.charCodeAt(name.length - 1);
  if (last === 0x2e || last === 0x20) return true;
  if (name.includes(":") || name.includes("~")) return true;
  // Device names start with one of c, p, a, n, l.
  const first = name.charCodeAt(0) | 0x20;
  if (first !== 0x63 && first !== 0x70 && first !== 0x61 && first !== 0x6e && first !== 0x6c) return false;
  return WINDOWS_DEVICE_NAME.test(name);
}

/** `C:\dir\name`: single backslashes and no `.` or `..` segment, so `path.win32.normalize` returns it unchanged. */
function isCanonicalDrivePath(target: string): boolean {
  const drive = target.charCodeAt(0) | 0x20;
  if (drive < 0x61 || drive > 0x7a || target.charCodeAt(1) !== 0x3a || target.charCodeAt(2) !== 0x5c) return false;
  return !target.includes("/") && !target.includes("\\\\") && !target.includes("\\.");
}

/** The path as the cache keys it, or `undefined` when the file system must answer for the exact spelling. */
function cacheablePath(target: string): string | undefined {
  if (IS_WINDOWS && isCanonicalDrivePath(target)) return target.endsWith("\\") ? undefined : target;
  if (!path.isAbsolute(target)) return undefined;
  const last = target.charCodeAt(target.length - 1);
  if (last === 0x2f || (IS_WINDOWS && last === 0x5c)) return undefined;
  if (!IS_WINDOWS) return target;
  if (/^(?:\\\\|\/\/)[?.][\\/]/.test(target)) return undefined;
  const normalized = path.win32.normalize(target);
  // A root has no entry name in any spelling. `normalize` turns the share root `\\server\share` into `\\server\share\`,
  // and the name of that path would be the share, looked up in its own listing. The parsed root decides, not the spelling.
  const { root, base } = path.win32.parse(normalized);
  return base && root !== normalized ? normalized : undefined;
}

const SEPARATOR = IS_WINDOWS ? "\\" : "/";

/** Splits at the last separator for POSIX and drive paths, which have no root longer than their first separator. */
function hasSimpleRoot(file: string): boolean {
  return !IS_WINDOWS || file.charCodeAt(1) === 0x3a;
}

function directoryOf(file: string): string {
  if (!hasSimpleRoot(file)) return path.dirname(file);
  const separator = file.lastIndexOf(SEPARATOR);
  return separator > (IS_WINDOWS ? 2 : 0) ? file.slice(0, separator) : file.slice(0, separator + 1);
}

function nameOf(file: string): string {
  if (!hasSimpleRoot(file)) return path.basename(file);
  return file.slice(file.lastIndexOf(SEPARATOR) + 1);
}

function entryKind(entry: ProbeDirent): EntryKind {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "unresolved";
  if (entry.isFIFO() || entry.isSocket() || entry.isCharacterDevice() || entry.isBlockDevice()) return "other";
  return "unresolved";
}

function classifyStat(stat: { isFile(): boolean; isDirectory(): boolean }): ProbeKind {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "other";
}

function flipFirstLetterCase(name: string): string | undefined {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    const isUpper = code >= 0x41 && code <= 0x5a;
    const isLower = code >= 0x61 && code <= 0x7a;
    if (!isUpper && !isLower) continue;
    const flipped = String.fromCharCode(code ^ 0x20);
    return name.slice(0, index) + flipped + name.slice(index + 1);
  }
  return undefined;
}

/**
 * `readdir` decodes the bytes of a name that is not valid text as U+FFFD (on Windows, an unpaired surrogate too), so the
 * listed name is a spelling no path reaches, and two such names can read alike. Only the file system can answer for it.
 */
function isLossyName(name: string): boolean {
  return name.includes("\uFFFD");
}

/** One directory's entries, with the rules that decide which probed names they can answer for. */
class DirListing {
  private readonly entries = new Map<string, ListingEntry>();
  private readonly hasNonAscii: boolean;
  private foldedEntries: Map<string, ListingEntry | null> | undefined;
  private mode: CaseMode | undefined;
  private modeDetection: Promise<CaseMode> | undefined;

  constructor(
    private readonly directory: string,
    dirents: readonly ProbeDirent[],
    private readonly ops: FsProbeOps,
  ) {
    let nonAscii = false;
    for (const dirent of dirents) {
      this.entries.set(dirent.name, {
        name: dirent.name,
        kind: isLossyName(dirent.name) ? "unresolved" : entryKind(dirent),
      });
      if (!nonAscii && !isAscii(dirent.name)) nonAscii = true;
    }
    this.hasNonAscii = nonAscii;
  }

  /**
   * The entry `fs.stat` would reach for `name`, `missing` when it would fail, `unknown` when only the file
   * system can say, or `pending` while the directory's case mode is unread (call {@link settleCaseMode}).
   */
  lookup(name: string): LookupResult {
    const exact = this.entries.get(name);
    if (exact !== undefined) return exact;
    const mode = this.mode;
    if (mode === undefined) return PENDING;
    if (mode === "sensitive") {
      // A few non-ASCII names normalize to ASCII (the Kelvin sign), so a directory that holds one cannot say "missing".
      return this.ops.normalizationInsensitive && (this.hasNonAscii || !isAscii(name)) ? UNKNOWN : MISSING;
    }
    if (mode === "insensitive" && isAscii(name)) {
      const folded = this.foldedIndex().get(name.toLowerCase());
      if (folded) return folded;
      if (folded === null) return UNKNOWN;
      return this.hasNonAscii ? UNKNOWN : MISSING;
    }
    return UNKNOWN;
  }

  settleCaseMode(): Promise<CaseMode> {
    this.modeDetection ??= this.detectCaseMode().then((mode) => {
      this.mode = mode;
      return mode;
    });
    return this.modeDetection;
  }

  private foldedIndex(): Map<string, ListingEntry | null> {
    if (this.foldedEntries) return this.foldedEntries;
    const folded = new Map<string, ListingEntry | null>();
    for (const entry of this.entries.values()) {
      if (!isAscii(entry.name)) continue;
      const key = entry.name.toLowerCase();
      folded.set(key, folded.has(key) ? null : entry);
    }
    this.foldedEntries = folded;
    return folded;
  }

  /** Reads whether this directory matches names case-insensitively, as the file system does. */
  private async detectCaseMode(): Promise<CaseMode> {
    let flippedName: string | undefined;
    for (const name of this.entries.keys()) {
      const flipped = isWindowsHazardousName(name) || isLossyName(name) ? undefined : flipFirstLetterCase(name);
      if (flipped === undefined) continue;
      // Two entries that differ only by case can exist only where names are case-sensitive.
      if (this.entries.has(flipped)) return "sensitive";
      flippedName = flipped;
      break;
    }
    if (flippedName === undefined) return this.hasNonAscii ? "unknown" : "sensitive";
    try {
      await this.ops.lstat(path.join(this.directory, flippedName));
      return "insensitive";
    } catch (error) {
      return isMissingPathError(error) ? "sensitive" : "unknown";
    }
  }
}

type DirListingResult = DirListing | typeof MISSING_DIRECTORY | typeof UNLISTABLE_DIRECTORY;

type DirState = {
  /** Names answered by a per-path `stat` while the directory was not listed (at most the budget). */
  direct: string[];
  listing?: Promise<DirListingResult>;
  loaded?: DirListingResult;
  /** Set once the parent's listing was asked whether this directory can exist at all. */
  parentChecked?: boolean;
};

let nextProbeCacheId = 1;

export class FsProbeCache {
  /** Changes on every {@link reset}, so a result remembered elsewhere can tell it came from a retired snapshot. */
  id: number = nextProbeCacheId++;
  private readonly directories = new Map<string, DirState>();
  private readonly statKinds = new Map<string, Promise<ProbeKind | null>>();
  private readonly statRealpaths = new Map<string, Promise<string | null>>();
  private readonly directoryRealpaths = new Map<string, Promise<string | null>>();
  private readonly ops: FsProbeOps;

  constructor(ops: FsProbeOps = nodeOps) {
    this.ops = ops;
  }

  reset(): void {
    this.directories.clear();
    this.statKinds.clear();
    this.statRealpaths.clear();
    this.directoryRealpaths.clear();
    this.id = nextProbeCacheId++;
  }

  /** What `fs.stat(target)` reports: the kind of the path after following links, or `null` when it throws. */
  async kind(target: string): Promise<ProbeKind | null> {
    const file = cacheablePath(target);
    if (file === undefined) return this.statKindOf(target, false);
    const remembered = this.statKinds.get(file);
    if (remembered !== undefined) return remembered;
    const name = nameOf(file);
    const directory = directoryOf(file);
    if (!name || name === "." || name === ".." || isWindowsHazardousName(name)) {
      return this.statKindOf(file, true);
    }
    const state = this.directoryState(directory);
    if (state.loaded === undefined && state.listing === undefined && !state.parentChecked) {
      state.parentChecked = true;
      if (await this.isBelowAbsentEntry(directory)) state.loaded = MISSING_DIRECTORY;
    }
    let listing = state.loaded;
    if (listing === undefined) {
      if (state.listing !== undefined) {
        listing = await state.listing;
      } else if (state.direct.length < DIRECT_PROBE_BUDGET) {
        state.direct.push(name);
        return this.statKindOf(file, true);
      } else {
        listing = await this.listDirectory(directory, state);
      }
    }
    if (listing === MISSING_DIRECTORY) return null;
    if (listing === UNLISTABLE_DIRECTORY) return this.statKindOf(file, true);
    let found = listing.lookup(name);
    if (found === PENDING) {
      await listing.settleCaseMode();
      found = listing.lookup(name);
    }
    if (found === MISSING) return null;
    if (found === UNKNOWN || found === PENDING || found.kind === "unresolved") return this.statKindOf(file, true);
    return found.kind;
  }

  /** What `fs.realpath(target)` returns, or `null` when it throws. */
  async realpath(target: string): Promise<string | null> {
    const file = cacheablePath(target);
    if (file === undefined) return this.statRealpathOf(target, false);
    const name = nameOf(file);
    const directory = directoryOf(file);
    const listing = this.directories.get(directory)?.loaded;
    if (listing === undefined || !name || name === "." || name === ".." || isWindowsHazardousName(name)) {
      return this.statRealpathOf(file, true);
    }
    if (listing === MISSING_DIRECTORY) return null;
    if (listing === UNLISTABLE_DIRECTORY) return this.statRealpathOf(file, true);
    let found = listing.lookup(name);
    if (found === PENDING) {
      await listing.settleCaseMode();
      found = listing.lookup(name);
    }
    if (found === MISSING) return null;
    if (found === UNKNOWN || found === PENDING || found.kind === "unresolved") return this.statRealpathOf(file, true);
    // Where `realpath` keeps the spelling of a name, only an exact match composes to what it would return.
    if (found.name !== name && !this.ops.realpathStoresCase) return this.statRealpathOf(file, true);
    const physicalDirectory = await this.realpathOfDirectory(directory);
    if (physicalDirectory === null) return this.statRealpathOf(file, true);
    return path.join(physicalDirectory, found.name);
  }

  private directoryState(directory: string): DirState {
    let state = this.directories.get(directory);
    if (state === undefined) {
      state = { direct: [] };
      this.directories.set(directory, state);
    }
    return state;
  }

  /** Whether the parent's listing shows that `directory` is no directory, so nothing below it exists. */
  private async isBelowAbsentEntry(directory: string): Promise<boolean> {
    const parent = directoryOf(directory);
    const name = nameOf(directory);
    if (parent === directory || !name || name === "." || name === ".." || isWindowsHazardousName(name)) return false;
    const parentListing = this.directories.get(parent)?.loaded;
    if (parentListing === MISSING_DIRECTORY) return true;
    if (!(parentListing instanceof DirListing)) return false;
    let found = parentListing.lookup(name);
    if (found === PENDING) {
      await parentListing.settleCaseMode();
      found = parentListing.lookup(name);
    }
    if (found === MISSING) return true;
    if (found === UNKNOWN || found === PENDING) return false;
    return found.kind === "file" || found.kind === "other";
  }

  private listDirectory(directory: string, state: DirState): Promise<DirListingResult> {
    state.listing ??= this.readDirectory(directory).then((result) => {
      state.loaded = result;
      return result;
    });
    return state.listing;
  }

  private async readDirectory(directory: string): Promise<DirListingResult> {
    try {
      if (!IS_WINDOWS) await this.ops.access(directory);
      return new DirListing(directory, await this.ops.readdir(directory), this.ops);
    } catch (error) {
      return isMissingPathError(error) ? MISSING_DIRECTORY : UNLISTABLE_DIRECTORY;
    }
  }

  private statKindOf(target: string, remember: boolean): Promise<ProbeKind | null> {
    if (!remember) return this.readStatKind(target);
    let result = this.statKinds.get(target);
    if (result === undefined) {
      result = this.readStatKind(target);
      this.statKinds.set(target, result);
    }
    return result;
  }

  private async readStatKind(target: string): Promise<ProbeKind | null> {
    try {
      return classifyStat(await this.ops.stat(target));
    } catch {
      return null;
    }
  }

  private statRealpathOf(target: string, remember: boolean): Promise<string | null> {
    if (!remember) return this.readRealpath(target);
    let result = this.statRealpaths.get(target);
    if (result === undefined) {
      result = this.readRealpath(target);
      this.statRealpaths.set(target, result);
    }
    return result;
  }

  private async readRealpath(target: string): Promise<string | null> {
    try {
      return await this.ops.realpath(target);
    } catch {
      return null;
    }
  }

  /** A directory's real path, composed from its parent's when that is listed, so one call serves its subtree. */
  private realpathOfDirectory(directory: string): Promise<string | null> {
    let result = this.directoryRealpaths.get(directory);
    if (result === undefined) {
      result = this.realpath(directory);
      this.directoryRealpaths.set(directory, result);
    }
    return result;
  }
}

const probeCacheStorage = new AsyncLocalStorage<FsProbeCache>();

/** The cache of the build the caller runs in, or `undefined` outside any build. */
export function currentProbeCache(): FsProbeCache | undefined {
  return probeCacheStorage.getStore();
}

/** Runs one index build with its own probe cache. A build started inside another build shares its cache. */
export async function runWithProbeCache<T>(operation: () => Promise<T>): Promise<T> {
  if (probeCacheStorage.getStore() !== undefined) return await operation();
  const cache = new FsProbeCache();
  try {
    return await probeCacheStorage.run(cache, operation);
  } finally {
    // Work that outlives the build can still hold this cache, so it must not keep the build's listings.
    cache.reset();
  }
}

/** Drops what the current build's cache learned, so the next probe reads the file system again. */
export function resetCurrentProbeCache(): void {
  probeCacheStorage.getStore()?.reset();
}

/** `fs.stat` classification of a path through the current build's cache, or directly outside a build. */
export async function probeKind(target: string): Promise<ProbeKind | null> {
  const cache = probeCacheStorage.getStore();
  if (cache) return await cache.kind(target);
  try {
    return classifyStat(await nodeOps.stat(target));
  } catch {
    return null;
  }
}

/** `fs.realpath` of a path through the current build's cache, or directly outside a build. */
export async function probeRealpath(target: string): Promise<string | null> {
  const cache = probeCacheStorage.getStore();
  if (cache) return await cache.realpath(target);
  try {
    return await nodeOps.realpath(target);
  } catch {
    return null;
  }
}
