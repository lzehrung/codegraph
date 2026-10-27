import fs from "node:fs";
import path from "node:path";
import { AGENT_FRESHNESS_CHECK_INTERVAL_MS, type AgentFreshnessResult, type AgentSession } from "../agent/session.js";
import { isRelativePathInside } from "../util/discovery-path.js";
import { errorMessage, isFileSystemErrorCode } from "../util/errors.js";
import { DEFAULT_MCP_STDIO_IDLE_TIMEOUT_MS } from "./stdio-lifecycle.js";

/** Quiet time after the last file event before the burst counts as settled. */
export const DEFAULT_MCP_WATCH_DEBOUNCE_MS = 500;
/** Idle time without a tool call before the watcher pauses. */
export const DEFAULT_MCP_WATCH_IDLE_MS = DEFAULT_MCP_STDIO_IDLE_TIMEOUT_MS;
/** Minimum time between background refresh starts; the session's own freshness-check interval. */
export const DEFAULT_MCP_WATCH_MIN_REFRESH_INTERVAL_MS = AGENT_FRESHNESS_CHECK_INTERVAL_MS;

const MAX_WATCH_TIMER_MS = 2_147_483_647;

// What `checkFreshness` reports when it cannot verify the configuration (src/agent/session.ts). The session
// retains its snapshot then, so the background refresh must not replace it.
const CONFIGURATION_UNCHECKED_REASON = "session configuration could not be checked";

// Directory names whose contents never reach the index. `.codegraph` holds the disk cache and server.json,
// so without it the server's own cache writes would wake the watcher; `.codegraph-cache` is the legacy cache.
const IGNORED_SEGMENTS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".codegraph": true,
  ".codegraph-cache": true,
};

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
  /** Re-reads `listFiles` and adds or closes per-directory watches. Does nothing in recursive mode. */
  refreshDirectories: () => Promise<void>;
  /** Closes every handle and cancels the pending settle timer. Safe to call twice. */
  close: () => void;
};

export type ProjectWatcherOptions = {
  root: string;
  /** Called synchronously for every event outside an ignored directory, and for every watch error. */
  onChange: () => void;
  /** Called once, `debounceMs` after the last event. */
  onSettled: () => void;
  /** Discovered project files. Read only in per-directory mode. */
  listFiles: () => Promise<readonly string[]>;
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

/** True when any segment of a path relative to the watched directory names an ignored directory. */
function isIgnoredPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => Object.hasOwn(IGNORED_SEGMENTS, segment));
}

function capacityErrorCode(error: unknown): "ENOSPC" | "EMFILE" | undefined {
  if (isFileSystemErrorCode(error, "ENOSPC")) return "ENOSPC";
  if (isFileSystemErrorCode(error, "EMFILE")) return "EMFILE";
  return undefined;
}

/** The root, every directory that holds a listed file, and their ancestors up to the root. */
function collectWatchDirectories(root: string, files: readonly string[]): Set<string> {
  const directories = new Set<string>([root]);
  for (const file of files) {
    let directory = path.dirname(path.resolve(root, file));
    // A directory already in the set brought all its ancestors with it.
    while (!directories.has(directory)) {
      const relative = path.relative(root, directory);
      if (!isRelativePathInside(relative) || isIgnoredPath(relative)) break;
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
 * The watcher is a hint: a missed event costs speed, never correctness, because the session's pull check stays
 * the authority.
 */
export function startProjectWatcher(options: ProjectWatcherOptions): ProjectWatcher {
  const root = path.resolve(options.root);
  const debounceMs = options.debounceMs ?? DEFAULT_MCP_WATCH_DEBOUNCE_MS;
  const platform = options.platform ?? process.platform;
  const recursive = platform === "win32" || platform === "darwin";
  const watch: ProjectWatchFactory = options.watch ?? fs.watch;
  const log = options.log ?? ((message: string): void => console.error(message));
  const handles = new Map<string, ProjectWatchHandle>();
  let debounceTimer: NodeJS.Timeout | undefined;
  let directoryRefresh: Promise<void> | undefined;
  let directoryRefreshAgain = false;
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
    if (handles.get(directory) === handle) handles.delete(directory);
    handle.close();
  };

  const closeAll = (): void => {
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
    let handle: ProjectWatchHandle;
    try {
      handle = watch(directory, { recursive: recursiveWatch }, (_eventType, filename) => {
        if (closed || (filename && isIgnoredPath(filename))) return;
        noteChange();
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

  const applyDirectories = (files: readonly string[]): void => {
    const wanted = collectWatchDirectories(root, files);
    for (const [directory, handle] of [...handles]) {
      if (!wanted.has(directory)) closeHandle(directory, handle);
    }
    for (const directory of wanted) {
      if (closed || disabled) return;
      if (!handles.has(directory)) openDirectory(directory, false);
    }
  };

  const refreshDirectories = (): Promise<void> => {
    if (recursive || closed || disabled) return Promise.resolve();
    // One scan at a time. A call that arrives meanwhile shares it and makes it read the files once more.
    if (directoryRefresh) {
      directoryRefreshAgain = true;
      return directoryRefresh;
    }
    directoryRefresh = (async (): Promise<void> => {
      try {
        do {
          directoryRefreshAgain = false;
          const files = await options.listFiles();
          if (closed || disabled) return;
          applyDirectories(files);
        } while (directoryRefreshAgain);
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
 * - Every event clears the session's cached freshness result at once (`markChanged`).
 * - A settled burst starts a refresh, no sooner than `minRefreshIntervalMs` after the previous one started.
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
  let lastRefreshStartedAt: number | undefined;
  let refreshing = false;
  let rerun = false;
  let closed = false;

  const scheduleRefresh = (): void => {
    if (refreshTimer) return;
    const waitMs =
      lastRefreshStartedAt === undefined ? 0 : Math.max(0, lastRefreshStartedAt + minRefreshIntervalMs - Date.now());
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
    lastRefreshStartedAt = Date.now();
    const current = watcher;
    try {
      const freshness: AgentFreshnessResult = session.checkFreshness
        ? await session.checkFreshness()
        : { state: "fresh" };
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
      onChange: () => session.markChanged?.(),
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
