import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { AGENT_FRESHNESS_CHECK_INTERVAL_MS, type AgentFreshnessResult, type AgentSession } from "../agent/session.js";
import { PROJECT_CACHE_DIRECTORY } from "../indexer/build-cache/location.js";
import { isRelativePathInside } from "../util/discovery-path.js";
import { errorMessage, isFileSystemErrorCode, isMissingPathError } from "../util/errors.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { DEFAULT_PROJECT_FILE_IGNORES } from "../util/project-files.js";
import { DEFAULT_MCP_STDIO_IDLE_TIMEOUT_MS } from "./stdio-lifecycle.js";

/** Quiet time after the last file event before the burst counts as settled. */
export const DEFAULT_MCP_WATCH_DEBOUNCE_MS = 500;
/** Idle time without a tool call before the watcher pauses. */
export const DEFAULT_MCP_WATCH_IDLE_MS = DEFAULT_MCP_STDIO_IDLE_TIMEOUT_MS;
/**
 * Minimum time from the end of one background refresh to the start of the next. Defaults to the session's own
 * freshness-check interval.
 */
export const DEFAULT_MCP_WATCH_MIN_REFRESH_INTERVAL_MS = AGENT_FRESHNESS_CHECK_INTERVAL_MS;

const MAX_WATCH_TIMER_MS = 2_147_483_647;

// What `checkFreshness` reports when it cannot verify the configuration (src/agent/session.ts). The session
// retains its snapshot then, so the background refresh must not replace it.
const CONFIGURATION_UNCHECKED_REASON = "session configuration could not be checked";

// Directories whose contents never reach the index: what default discovery ignores (dependencies, build output,
// virtual environments, and Codegraph's own state). Discovery and the watcher share one list, so a write that no
// query can see never clears the session's freshness result. The cache directory is named on top of that list
// because the server itself writes there.
const isDiscoveryIgnored = picomatch([...DEFAULT_PROJECT_FILE_IGNORES, `**/${PROJECT_CACHE_DIRECTORY}/**`], {
  dot: true,
});

// Per-directory mode keeps a watch for as long as its directory exists, although no file list names the directory: for
// one that an event reported, and for one that a list named until its last source file was deleted. This many such
// watches at once, not counting the ones that a file list names as well, keep a build that creates or empties
// thousands of directories from using up the inotify watches that every process of the user shares. Past the limit an
// event opens no watch, and a directory that the list stopped naming loses its watch; the file list after the next
// refresh takes over for the rest.
const MAX_RETAINED_DIRECTORIES = 128;

/** The part of `fs.FSWatcher` the project watcher uses. */
export type ProjectWatchHandle = {
  close(): void;
  unref(): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

/** Seam for tests; the default is `fs.watch`. */
export type ProjectWatchFactory = (
  directory: string,
  options: { recursive: boolean },
  listener: (eventType: string, filename: string | null) => void,
) => ProjectWatchHandle;

export type ProjectWatcher = {
  /**
   * Per-directory mode: re-reads `listFiles` and adds or closes watches. Recursive mode: opens the root handle again
   * once the root directory exists, after the handle was lost with it.
   */
  refreshDirectories: () => Promise<void>;
  /** Closes every handle and cancels the pending settle timer. Safe to call twice. */
  close: () => void;
};

export type ProjectWatcherOptions = {
  root: string;
  /**
   * Called synchronously for every event outside an ignored directory, for every watch error, and when a watched
   * directory is removed.
   */
  onChange: () => void;
  /** Called once, `debounceMs` after the last event. */
  onSettled: () => void;
  /** Discovered project files. Read only in per-directory mode. */
  listFiles: () => Promise<readonly string[]>;
  /**
   * The directory that the session writes its disk cache to (`resolveCacheLocation`). One inside the project is ignored
   * as `.codegraph` is, so that the server's own cache writes wake nothing.
   */
  cacheDirectory?: string | undefined;
  /** Defaults to {@link DEFAULT_MCP_WATCH_DEBOUNCE_MS}. */
  debounceMs?: number | undefined;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /** Defaults to `fs.watch`. */
  watch?: ProjectWatchFactory | undefined;
  /** Defaults to `console.error`. */
  log?: ((message: string) => void) | undefined;
};

function startTimer(callback: () => void, ms: number): NodeJS.Timeout {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return timer;
}

/** True when a path relative to the project root is, or lies in, a directory that discovery ignores. */
function isIgnoredPath(relativePath: string): boolean {
  return isDiscoveryIgnored(normalizePath(relativePath));
}

type PathMatcher = (relativePath: string) => boolean;

/**
 * `target` with every link in it resolved. What does not exist yet, such as a cache directory before its first write,
 * keeps its spelling below the nearest ancestor that does. A path that cannot be resolved stays as it is.
 */
function resolvePhysicalPath(target: string): string {
  let existing = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), path.relative(existing, target));
    } catch (error) {
      const parent = path.dirname(existing);
      if (!isMissingPathError(error) || parent === existing) return target;
      existing = parent;
    }
  }
}

/**
 * Matches the paths relative to `root` that never reach the index: what discovery ignores, and the subtree of a cache
 * directory that was moved into the project (`--cache-dir`, `CODEGRAPH_CACHE_DIR`), which the server writes to itself.
 * A cache directory outside the project, or inside a directory that discovery ignores anyway, adds nothing.
 * Whether the cache directory lies inside the project is decided on physical paths, because either one can be spelled
 * through a link: a root that is a symlink or junction, or a cache directory that names the project by its physical
 * path. The events name their paths relative to the root as it was given, and the match is made on those.
 */
function createIgnoredPathMatcher(root: string, cacheDirectory: string | undefined): PathMatcher {
  if (!cacheDirectory) return isIgnoredPath;
  const cacheRelative = path.relative(
    resolvePhysicalPath(root),
    resolvePhysicalPath(path.resolve(root, cacheDirectory)),
  );
  if (!isRelativePathInside(cacheRelative) || isIgnoredPath(cacheRelative)) return isIgnoredPath;
  // The identity key has the file system's case rules and `/` separators, as the events name paths in either form.
  const cacheKey = fileIdentityKey(cacheRelative);
  return (relativePath) => {
    if (isIgnoredPath(relativePath)) return true;
    const key = fileIdentityKey(relativePath);
    return key === cacheKey || key.startsWith(`${cacheKey}/`);
  };
}

function capacityErrorCode(error: unknown): "ENOSPC" | "EMFILE" | undefined {
  if (isFileSystemErrorCode(error, "ENOSPC")) return "ENOSPC";
  if (isFileSystemErrorCode(error, "EMFILE")) return "EMFILE";
  return undefined;
}

/**
 * True when a `rename` event names the watched directory itself: it was removed, moved, or replaced, and its watch
 * may be dead. Neither system reports an `error` or `close` for that.
 * - Windows names the directory by its absolute path (`\\?\C:\...`), over and over until the handle is closed.
 * - Linux (inotify) names it by its own name, once or twice, and then drops the watch without a word.
 * The entries of a watched directory arrive as relative names. The Linux form can also come from a change to the
 * directory's own attributes (`chmod`, `touch`) or from an entry with the same name (`pkg/pkg`). That closes a live
 * handle, which the next refresh opens again.
 */
function namesWatchedDirectory(
  directory: string,
  eventType: string,
  filename: string | null,
  reportsOwnName: boolean,
): boolean {
  if (eventType !== "rename" || !filename) return false;
  // Windows path rules on every host, so that a test on any system can send the Windows form. A relative entry name
  // is never absolute in either flavor.
  if (path.win32.isAbsolute(filename)) return true;
  return reportsOwnName && filename === path.basename(directory);
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fsp.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/** Adds `directory` and its ancestors up to the root to `directories`, stopping at the first one that is ignored. */
function addDirectoryWithAncestors(
  root: string,
  directories: Set<string>,
  directory: string,
  isIgnored: PathMatcher,
): void {
  let current = directory;
  // A directory already in the set brought all its ancestors with it.
  while (!directories.has(current)) {
    const relative = path.relative(root, current);
    if (!isRelativePathInside(relative) || isIgnored(relative)) break;
    directories.add(current);
    current = path.dirname(current);
  }
}

/** The root, every directory that holds a listed file, and their ancestors up to the root. */
function collectWatchDirectories(root: string, files: readonly string[], isIgnored: PathMatcher): Set<string> {
  const directories = new Set<string>([root]);
  for (const file of files) {
    addDirectoryWithAncestors(root, directories, path.dirname(path.resolve(root, file)), isIgnored);
  }
  return directories;
}

/**
 * Watches the project for file changes. Windows and macOS use one recursive handle on the root. Other platforms
 * use one non-recursive handle per directory that holds a listed file, because Node walks the whole tree for
 * `recursive: true` there, `node_modules` included, and can exhaust inotify watches.
 * A directory that appears later gets its handle from the event that reports it, not from the next file list, and
 * keeps it, with the handles of the directories above it, until the directory is removed. No list names a directory
 * that holds only a placeholder such as `.gitkeep`, yet its first source file must raise an event. The same goes for
 * a directory that a list named for a while: once its last source file is deleted, a placeholder may remain, and a
 * source file added again must raise an event. At most `MAX_RETAINED_DIRECTORIES` handles that no list names stay at
 * once. A handle that was lost with its directory is closed (see `namesWatchedDirectory`), and `refreshDirectories`
 * opens it again once the directory exists.
 * The watcher is a hint: a missed event costs speed, never correctness, because the session's pull check stays
 * the authority.
 */
export function startProjectWatcher(options: ProjectWatcherOptions): ProjectWatcher {
  const root = path.resolve(options.root);
  const isIgnored = createIgnoredPathMatcher(root, options.cacheDirectory);
  const debounceMs = options.debounceMs ?? DEFAULT_MCP_WATCH_DEBOUNCE_MS;
  const platform = options.platform ?? process.platform;
  const recursive = platform === "win32" || platform === "darwin";
  const watch: ProjectWatchFactory = options.watch ?? fs.watch;
  const log = options.log ?? ((message: string): void => console.error(message));
  const handles = new Map<string, ProjectWatchHandle>();
  // Per-directory mode: directories whose watch outlives the file list. An event reported them, or a list named them
  // until it stopped. The watch stays until the directory is removed, whether or not a file list names it.
  const retainedDirectories = new Set<string>();
  // What the latest file list needs a watch for. A retained directory among them does not count toward the limit.
  let listedDirectories: ReadonlySet<string> = new Set();
  // Reported directories whose watch is still to open, in the order the events arrived.
  const pendingDirectories = new Set<string>();
  let debounceTimer: NodeJS.Timeout | undefined;
  let directoryRefresh: Promise<void> | undefined;
  let directoryRefreshAgain = false;
  let walkingPending = false;
  // The latest walk through `pendingDirectories`. A reconcile waits for it, to see every watch that events opened.
  let pendingWalk: Promise<void> = Promise.resolve();
  let closed = false;
  let disabled = false;
  let failureLogged = false;

  const settle = (): void => {
    debounceTimer = undefined;
    if (!closed) options.onSettled();
  };

  const noteChange = (): void => {
    options.onChange();
    clearTimeout(debounceTimer);
    debounceTimer = startTimer(settle, debounceMs);
  };

  const closeHandle = (directory: string, handle: ProjectWatchHandle): void => {
    if (handles.get(directory) === handle) {
      handles.delete(directory);
      retainedDirectories.delete(directory);
    }
    handle.close();
  };

  const closeAll = (): void => {
    pendingDirectories.clear();
    for (const [directory, handle] of [...handles]) closeHandle(directory, handle);
  };

  // Out of watches or descriptors: stop watching and leave the session on its pull check.
  const disable = (code: string): void => {
    if (disabled) return;
    disabled = true;
    closeAll();
    log(`[codegraph] file watching disabled: ${code}`);
  };

  const logFailureOnce = (error: unknown): void => {
    if (failureLogged) return;
    failureLogged = true;
    log(`[codegraph] file watch failed: ${errorMessage(error)}`);
  };

  const openDirectory = (directory: string, recursiveWatch: boolean): void => {
    // Event names are relative to the watched directory; the ignore patterns are relative to the root.
    const prefix = directory === root ? "" : `${path.relative(root, directory)}/`;
    let handle: ProjectWatchHandle;
    try {
      handle = watch(directory, { recursive: recursiveWatch }, (eventType, filename) => {
        if (closed) return;
        // Before the ignore check: this name is the directory's own path, which may pass through an ignored name.
        if (namesWatchedDirectory(directory, eventType, filename, !recursiveWatch)) {
          closeHandle(directory, handle);
          noteChange();
          return;
        }
        if (filename && isIgnored(prefix + filename)) return;
        noteChange();
        if (!recursive && eventType === "rename" && filename) queueDirectory(path.join(directory, filename));
      });
    } catch (error) {
      // A directory that vanished before its watch opened is seen again, or gone, at the next refresh.
      const code = capacityErrorCode(error);
      if (code) disable(code);
      else logFailureOnce(error);
      return;
    }
    handle.unref();
    handle.on("error", (error) => {
      if (closed) return;
      const code = capacityErrorCode(error);
      if (code) {
        disable(code);
      } else {
        closeHandle(directory, handle);
        logFailureOnce(error);
      }
      // The lost handle may have hidden events, so the error counts as a change.
      noteChange();
    });
    handles.set(directory, handle);
  };

  // True once this many retained directories hold a watch that no file list accounts for.
  const retainedLimitReached = (): boolean => {
    if (retainedDirectories.size < MAX_RETAINED_DIRECTORIES) return false;
    let unlisted = 0;
    for (const directory of retainedDirectories) {
      if (!listedDirectories.has(directory)) unlisted += 1;
    }
    return unlisted >= MAX_RETAINED_DIRECTORIES;
  };

  // Watches a directory that an event reported, if it still is one. A `mkdir -p` or a copy may have filled it before
  // this watch opened, which raised no event, so the directories inside it are queued too.
  const watchReportedDirectory = async (directory: string): Promise<void> => {
    const relative = path.relative(root, directory);
    if (!isRelativePathInside(relative) || isIgnored(relative) || handles.has(directory)) return;
    if (retainedLimitReached()) return;
    let stats: fs.Stats;
    try {
      stats = await fsp.lstat(directory);
    } catch {
      // Gone again: the next refresh sees the final state.
      return;
    }
    // A link is not followed, as in discovery.
    if (!stats.isDirectory() || closed || disabled || handles.has(directory)) return;
    openDirectory(directory, false);
    if (!handles.has(directory)) return;
    retainedDirectories.add(directory);
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queueDirectory(path.join(directory, entry.name));
    }
  };

  const watchPendingDirectories = async (): Promise<void> => {
    try {
      // The set grows while it is walked: a directory's subdirectories join the queue behind the ones already in it.
      for (const directory of pendingDirectories) {
        pendingDirectories.delete(directory);
        if (closed || disabled) return;
        await watchReportedDirectory(directory);
      }
    } finally {
      walkingPending = false;
    }
  };

  const queueDirectory = (directory: string): void => {
    if (closed || disabled || handles.has(directory)) return;
    pendingDirectories.add(directory);
    if (walkingPending) return;
    walkingPending = true;
    pendingWalk = watchPendingDirectories().catch((error: unknown) => {
      logFailureOnce(error);
    });
  };

  const applyDirectories = async (files: readonly string[]): Promise<void> => {
    const wanted = collectWatchDirectories(root, files, isIgnored);
    const previouslyListed = listedDirectories;
    listedDirectories = wanted;
    // Watched even while no handle is open: what the list needs, and the directories above a retained one that stays.
    const required = new Set(wanted);
    const kept = new Set<string>();
    const open = [...handles];
    for (const [directory, handle] of open) {
      // A directory that the list names is required, and stays retained if it was.
      if (wanted.has(directory)) continue;
      const retained = retainedDirectories.has(directory);
      // Neither retained nor named by the list that this one replaces: only a retained directory below it can need it.
      if (!retained && !previouslyListed.has(directory)) continue;
      // No list names a directory that holds only a placeholder, or only more directories, and none names one whose
      // last source file was deleted while a placeholder remains. Its first source file must still raise an event, so
      // the watch stays until the directory is removed, and so do the ones above it. An ignored directory never got
      // a watch.
      const exists = await isDirectory(directory);
      if (closed || disabled) return;
      if (!exists || handles.get(directory) !== handle) continue;
      // A directory that the previous list named joins the retained ones only while the limit has room, so that a
      // build that empties thousands of directories cannot keep thousands of watches.
      if (!retained) {
        if (retainedLimitReached()) continue;
        retainedDirectories.add(directory);
      }
      kept.add(directory);
      addDirectoryWithAncestors(root, required, path.dirname(directory), isIgnored);
    }
    for (const [directory, handle] of open) {
      if (!required.has(directory) && !kept.has(directory)) closeHandle(directory, handle);
    }
    for (const directory of required) {
      if (closed || disabled) return;
      if (!handles.has(directory)) openDirectory(directory, false);
    }
  };

  const reconcileDirectories = async (): Promise<void> => {
    if (recursive) {
      // The root handle is lost only with its own directory. Watch it again once that exists.
      if (handles.has(root) || !(await isDirectory(root)) || closed || disabled) return;
      openDirectory(root, true);
      return;
    }
    const files = await options.listFiles();
    await pendingWalk;
    if (closed || disabled) return;
    await applyDirectories(files);
  };

  const refreshDirectories = (): Promise<void> => {
    if (closed || disabled) return Promise.resolve();
    // One scan at a time. A call that arrives meanwhile shares it and makes it read the files once more.
    if (directoryRefresh) {
      directoryRefreshAgain = true;
      return directoryRefresh;
    }
    directoryRefresh = (async (): Promise<void> => {
      try {
        do {
          directoryRefreshAgain = false;
          await reconcileDirectories();
        } while (directoryRefreshAgain && !closed && !disabled);
      } finally {
        directoryRefresh = undefined;
      }
    })();
    return directoryRefresh;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
    closeAll();
  };

  if (recursive) {
    openDirectory(root, true);
  } else {
    openDirectory(root, false);
    refreshDirectories().catch((error: unknown) => {
      logFailureOnce(error);
    });
  }
  return { refreshDirectories, close };
}

export type WatchControllerOptions = {
  root: string;
  /**
   * Runs `operation` once every operation that rebuilds the session's index or writes its artifacts has ended, and
   * keeps the next one waiting until it ends. The MCP handlers pass the lock that `refresh_index`, `artifact_build`,
   * and the SQLite rebuild take. A background refresh that overlapped one of them would leave the file signatures of
   * whichever build ended last, whatever snapshot the session serves. The same goes for a read of the file list for
   * the per-directory watches, because the first read of a session that nothing has loaded records file signatures.
   */
  runExclusive: (operation: () => Promise<void>) => Promise<void>;
  /** The directory that the session writes its disk cache to; see {@link ProjectWatcherOptions.cacheDirectory}. */
  cacheDirectory?: string | undefined;
  /** Defaults to {@link DEFAULT_MCP_WATCH_DEBOUNCE_MS}. */
  debounceMs?: number | undefined;
  /** Defaults to {@link DEFAULT_MCP_WATCH_MIN_REFRESH_INTERVAL_MS}. */
  minRefreshIntervalMs?: number | undefined;
  /** Pauses the watcher after this long without `noteActivity`. Defaults to 30 minutes; 0 never pauses. */
  idleMs?: number | undefined;
  /** Starts without watching; the first `noteActivity` opens the watches, as after an idle pause. */
  startPaused?: boolean | undefined;
  platform?: NodeJS.Platform | undefined;
  watch?: ProjectWatchFactory | undefined;
  log?: ((message: string) => void) | undefined;
};

export type WatchController = {
  /** Records a tool call: resets the idle timer, and after an idle pause reopens the watches. */
  noteActivity: () => void;
  /**
   * Closes every handle and cancels every timer. Safe to call twice. The promise settles once the background refresh
   * that was running and every read of the file list that had started have ended, and never rejects. A refresh that
   * still waits for its turn then checks and rebuilds nothing, and a read that still waits reads nothing. Neither can
   * be cancelled once it runs, so a caller that releases the session waits for them first: one that outlives the
   * release keeps writing the cache and restores the file signatures that the release dropped.
   */
  close: () => Promise<void>;
};

/** Throws unless `value` is a whole number of milliseconds that a timer accepts. */
export function assertMcpWatchMs(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_WATCH_TIMER_MS) {
    throw new RangeError(`${name} must be a whole number of milliseconds from 0 through ${MAX_WATCH_TIMER_MS}.`);
  }
}

/**
 * Turns file events into background refreshes of an MCP-owned session.
 * - Every event clears the session's cached freshness result at once (`markChanged`). It also cancels the refresh
 *   and the rerun that an earlier burst scheduled, so that none starts while events still arrive. A refresh that
 *   already waits for its turn of `runExclusive` gives the turn up when it comes: the burst that the event belongs to
 *   starts its own refresh when it settles.
 * - A settled burst starts a refresh, no sooner than `minRefreshIntervalMs` after the previous one ended.
 * - One refresh runs at a time. A settled burst during it sets one rerun flag. Its freshness check, invalidation, and
 *   rebuild run in one turn of `runExclusive`, so they never overlap an explicit refresh or an artifact build. Every
 *   read of the file list for the per-directory watches takes a turn as well.
 * - After `idleMs` without `noteActivity` the watches close, and a refresh that waits for its turn gives it up. The
 *   next `noteActivity` reopens them and calls `markChanged`, so the pull check sees every edit made during the pause.
 * - `close` ends the watching for good. The refresh that is running finishes, and so does every read of the file list
 *   that has started. `close` returns a promise for them, so that the owner of the session can release the session
 *   after them. A read that still waits for its turn gives it up.
 */
export function createWatchController(session: AgentSession, options: WatchControllerOptions): WatchController {
  const minRefreshIntervalMs = options.minRefreshIntervalMs ?? DEFAULT_MCP_WATCH_MIN_REFRESH_INTERVAL_MS;
  const idleMs = options.idleMs ?? DEFAULT_MCP_WATCH_IDLE_MS;
  const log = options.log ?? ((message: string): void => console.error(message));
  let watcher: ProjectWatcher | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let lastRefreshEndedAt: number | undefined;
  // The refresh that is running, if any. Only one runs at a time, and `close` waits for it.
  let activeRefresh: Promise<void> | undefined;
  // The reads of the file list that took their turn of `runExclusive` and have not ended. `close` waits for them too.
  const activeReads = new Set<Promise<unknown>>();
  let rerun = false;
  let closed = false;
  // Bumped by every event and by `pause`. A refresh keeps the value it started under, and gives up its turn of
  // `runExclusive` when the value has moved by the time the turn comes: an event reopened the burst, so the refresh
  // that its settling starts is the one that counts, or the watching ended.
  let turnToken = 0;
  // Bumped when a watcher opens and when it pauses, so that a read of the file list that waited for its turn can tell
  // whether the watcher that asked for it is still the open one.
  let watcherToken = 0;

  const scheduleRefresh = (): void => {
    if (refreshTimer) return;
    // From the end, not the start: a refresh that outlasts the interval must not be followed by another at once.
    const waitMs =
      lastRefreshEndedAt === undefined ? 0 : Math.max(0, lastRefreshEndedAt + minRefreshIntervalMs - Date.now());
    if (!waitMs) {
      startRefresh();
      return;
    }
    refreshTimer = startTimer(() => {
      refreshTimer = undefined;
      startRefresh();
    }, waitMs);
  };

  // Runs in one turn of `runExclusive`, so that no other refresh replaces the session between the check and the rebuild.
  const checkAndRebuild = async (): Promise<void> => {
    const freshness: AgentFreshnessResult = session.checkFreshness
      ? await session.checkFreshness()
      : { state: "fresh" };
    // The server closed while the check ran: a rebuild now would keep the project busy after its client left.
    if (closed) return;
    // Nobody waits in the background, so the auto-refresh limits do not apply to a stale result. A session that
    // cannot verify its configuration keeps its snapshot instead, as it does without a watcher.
    const rebuildStale = freshness.state === "stale" && freshness.reason !== CONFIGURATION_UNCHECKED_REASON;
    if (rebuildStale) session.invalidate();
    if (rebuildStale || freshness.state === "refreshed") {
      await session.loadProject({ symbolGraph: "skip" });
    }
  };

  // Never rejects: a failure is logged. Resolves to whether the refresh took its turn.
  const refreshSession = async (current: ProjectWatcher | undefined, token: number): Promise<boolean> => {
    let tookTurn = false;
    try {
      await options.runExclusive(async () => {
        // The turn comes after every refresh and build that held the session, however long those take. Events since
        // this refresh started reopened its burst, and a pause or a close ended the watching, so it is not due now.
        if (token !== turnToken) return;
        tookTurn = true;
        await checkAndRebuild();
      });
      // After every refresh, so a directory that a query already rebuilt around still gets its watch.
      if (tookTurn) await current?.refreshDirectories();
    } catch (error) {
      log(`[codegraph] watch refresh failed: ${errorMessage(error)}`);
    }
    return tookTurn;
  };

  const startRefresh = (): void => {
    rerun = false;
    const refresh: Promise<void> = refreshSession(watcher, turnToken).then((tookTurn) => {
      // A refresh that gave up its turn did nothing, so it does not push the next one back.
      if (tookTurn) lastRefreshEndedAt = Date.now();
      if (activeRefresh === refresh) activeRefresh = undefined;
      if (rerun && watcher) scheduleRefresh();
    });
    activeRefresh = refresh;
  };

  const onSettled = (): void => {
    if (!watcher) return;
    if (activeRefresh) {
      rerun = true;
      return;
    }
    scheduleRefresh();
  };

  // The burst that this event belongs to schedules its own refresh when it settles. One that an earlier burst armed
  // would start in the middle of this one, so it goes now: its timer is cancelled, and a refresh that already waits
  // for its turn gives the turn up.
  const onChange = (): void => {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    rerun = false;
    turnToken += 1;
    session.markChanged?.();
  };

  const pause = (): void => {
    clearTimeout(idleTimer);
    clearTimeout(refreshTimer);
    idleTimer = undefined;
    refreshTimer = undefined;
    rerun = false;
    turnToken += 1;
    watcherToken += 1;
    watcher?.close();
    watcher = undefined;
  };

  const armIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (idleMs) idleTimer = startTimer(pause, idleMs);
  };

  // Reads the file list for the directory scans of one watcher, in a turn of `runExclusive`. The first read of a session
  // that nothing has loaded discovers the project and records the file signatures that the freshness check compares
  // with. A read that ran beside `refresh_index` and ended last would replace the signatures of the snapshot that the
  // rebuild produced. One that ended after the owner released the session would record them into the released session,
  // so a read that runs stays in `activeReads` until it ends.
  const readFiles = async (token: number): Promise<readonly string[]> => {
    let files: readonly string[] = [];
    await options.runExclusive(async () => {
      // The watcher paused or closed while the read waited. Nothing uses the list, and a session that its owner
      // released must not load the project again.
      if (token !== watcherToken) return;
      // Tracked in the tick of the check, so that a `close` right after it finds every read that was not skipped.
      const read = (async (): Promise<readonly string[]> => (await session.listFiles?.()) ?? [])();
      activeReads.add(read);
      try {
        files = await read;
      } finally {
        activeReads.delete(read);
      }
    });
    return files;
  };

  const open = (): void => {
    watcherToken += 1;
    const token = watcherToken;
    watcher = startProjectWatcher({
      root: options.root,
      cacheDirectory: options.cacheDirectory,
      onChange,
      onSettled,
      listFiles: () => readFiles(token),
      debounceMs: options.debounceMs,
      platform: options.platform,
      watch: options.watch,
      log,
    });
    armIdleTimer();
  };

  const noteActivity = (): void => {
    if (closed) return;
    if (watcher) {
      armIdleTimer();
      return;
    }
    // First call after an idle pause or a lazy start: edits made while no watch was open left no event.
    open();
    session.markChanged?.();
  };

  const close = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      pause();
    }
    // Neither the refresh nor a read can be cancelled, and either writes to the session until it ends. Their failures
    // are logged where they happened, so none rejects here.
    await Promise.allSettled([activeRefresh, ...activeReads]);
  };

  if (!options.startPaused) open();
  return { noteActivity, close };
}
