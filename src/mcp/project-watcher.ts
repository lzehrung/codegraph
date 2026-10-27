import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { AGENT_FRESHNESS_CHECK_INTERVAL_MS, type AgentFreshnessResult, type AgentSession } from "../agent/session.js";
import { PROJECT_CACHE_DIRECTORY } from "../indexer/build-cache/location.js";
import { isRelativePathInside } from "../util/discovery-path.js";
import { errorMessage, isFileSystemErrorCode } from "../util/errors.js";
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

// Per-directory mode opens a watch for a directory as soon as an event reports it. This many such watches at once
// keep a build that creates thousands of directories from using up the inotify watches that every process of the
// user shares; the file list after the next refresh takes over for the rest.
const MAX_REPORTED_DIRECTORIES = 128;

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
 * Matches the paths relative to `root` that never reach the index: what discovery ignores, and the subtree of a cache
 * directory that was moved into the project (`--cache-dir`, `CODEGRAPH_CACHE_DIR`), which the server writes to itself.
 * A cache directory outside the project, or inside a directory that discovery ignores anyway, adds nothing.
 */
function createIgnoredPathMatcher(root: string, cacheDirectory: string | undefined): PathMatcher {
  if (!cacheDirectory) return isIgnoredPath;
  const cacheRelative = path.relative(root, path.resolve(root, cacheDirectory));
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

async function isEmptyDirectory(directory: string): Promise<boolean> {
  try {
    return !(await fsp.readdir(directory)).length;
  } catch {
    return false;
  }
}

/** The root, every directory that holds a listed file, and their ancestors up to the root. */
function collectWatchDirectories(root: string, files: readonly string[], isIgnored: PathMatcher): Set<string> {
  const directories = new Set<string>([root]);
  for (const file of files) {
    let directory = path.dirname(path.resolve(root, file));
    // A directory already in the set brought all its ancestors with it.
    while (!directories.has(directory)) {
      const relative = path.relative(root, directory);
      if (!isRelativePathInside(relative) || isIgnored(relative)) break;
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  return directories;
}

/**
 * Watches the project for file changes. Windows and macOS use one recursive handle on the root. Other platforms
 * use one non-recursive handle per directory that holds a listed file, because Node walks the whole tree for
 * `recursive: true` there, `node_modules` included, and can exhaust inotify watches.
 * A directory that appears later gets its handle from the event that reports it, not from the next file list. A
 * handle that was lost with its directory is closed (see `namesWatchedDirectory`), and `refreshDirectories`
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
  // Per-directory mode: directories that hold a watch because an event reported them, before a file list named them.
  const reportedDirectories = new Set<string>();
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
      reportedDirectories.delete(directory);
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

  // Watches a directory that an event reported, if it still is one. A `mkdir -p` or a copy may have filled it before
  // this watch opened, which raised no event, so the directories inside it are queued too.
  const watchReportedDirectory = async (directory: string): Promise<void> => {
    const relative = path.relative(root, directory);
    if (!isRelativePathInside(relative) || isIgnored(relative) || handles.has(directory)) return;
    if (reportedDirectories.size >= MAX_REPORTED_DIRECTORIES) return;
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
    reportedDirectories.add(directory);
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
    for (const [directory, handle] of [...handles]) {
      if (wanted.has(directory)) {
        reportedDirectories.delete(directory);
        continue;
      }
      // A reported directory keeps its watch while it is empty, so that its first file raises an event. Once it holds
      // anything that the file list does not name, discovery ignores it, and so does the watcher.
      if (reportedDirectories.has(directory) && (await isEmptyDirectory(directory))) continue;
      if (closed || disabled) return;
      closeHandle(directory, handle);
    }
    for (const directory of wanted) {
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
  /** Closes every handle and cancels every timer. Safe to call twice. */
  close: () => void;
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
 *   and the rerun that an earlier burst scheduled, so that none starts while events still arrive.
 * - A settled burst starts a refresh, no sooner than `minRefreshIntervalMs` after the previous one ended.
 * - One refresh runs at a time. A settled burst during it sets one rerun flag.
 * - After `idleMs` without `noteActivity` the watches close. The next `noteActivity` reopens them and calls
 *   `markChanged`, so the pull check sees every edit made during the pause.
 */
export function createWatchController(session: AgentSession, options: WatchControllerOptions): WatchController {
  const minRefreshIntervalMs = options.minRefreshIntervalMs ?? DEFAULT_MCP_WATCH_MIN_REFRESH_INTERVAL_MS;
  const idleMs = options.idleMs ?? DEFAULT_MCP_WATCH_IDLE_MS;
  const log = options.log ?? ((message: string): void => console.error(message));
  let watcher: ProjectWatcher | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let lastRefreshEndedAt: number | undefined;
  let refreshing = false;
  let rerun = false;
  let closed = false;

  const scheduleRefresh = (): void => {
    if (refreshTimer) return;
    // From the end, not the start: a refresh that outlasts the interval must not be followed by another at once.
    const waitMs =
      lastRefreshEndedAt === undefined ? 0 : Math.max(0, lastRefreshEndedAt + minRefreshIntervalMs - Date.now());
    if (!waitMs) {
      void runRefresh();
      return;
    }
    refreshTimer = startTimer(() => {
      refreshTimer = undefined;
      void runRefresh();
    }, waitMs);
  };

  const runRefresh = async (): Promise<void> => {
    refreshing = true;
    rerun = false;
    const current = watcher;
    try {
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
      // After every refresh, so a directory that a query already rebuilt around still gets its watch.
      await current?.refreshDirectories();
    } catch (error) {
      log(`[codegraph] watch refresh failed: ${errorMessage(error)}`);
    } finally {
      lastRefreshEndedAt = Date.now();
      refreshing = false;
      if (rerun && watcher) scheduleRefresh();
    }
  };

  const onSettled = (): void => {
    if (!watcher) return;
    if (refreshing) {
      rerun = true;
      return;
    }
    scheduleRefresh();
  };

  // The burst that this event belongs to schedules its own refresh when it settles. One that an earlier burst armed
  // would start in the middle of this one, so it goes now.
  const onChange = (): void => {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    rerun = false;
    session.markChanged?.();
  };

  const pause = (): void => {
    clearTimeout(idleTimer);
    clearTimeout(refreshTimer);
    idleTimer = undefined;
    refreshTimer = undefined;
    rerun = false;
    watcher?.close();
    watcher = undefined;
  };

  const armIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (idleMs) idleTimer = startTimer(pause, idleMs);
  };

  const open = (): void => {
    watcher = startProjectWatcher({
      root: options.root,
      cacheDirectory: options.cacheDirectory,
      onChange,
      onSettled,
      listFiles: async () => (await session.listFiles?.()) ?? [],
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

  const close = (): void => {
    if (closed) return;
    closed = true;
    pause();
  };

  if (!options.startPaused) open();
  return { noteActivity, close };
}
