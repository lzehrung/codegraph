import { watch as fsWatch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  type AgentFreshnessResult,
  type AgentProjectSnapshot,
  type AgentSession,
} from "../src/agent/session.js";
import {
  createWatchController,
  startProjectWatcher,
  type ProjectWatchFactory,
  type ProjectWatcherOptions,
  type WatchController,
  type WatchControllerOptions,
} from "../src/mcp/project-watcher.js";
import { isFileIdentityCaseInsensitive, resetFileIdentityCaseSensitivityForTests } from "../src/util/paths.js";
import { createTempRootRegistry, tryCreateDirectorySymlink } from "./helpers/filesystem.js";

// Nothing below touches this directory: the fake watch factory never reaches the file system.
const root = path.join(os.tmpdir(), "cg-project-watcher-fake-root");
const at = (...segments: string[]): string => path.join(root, ...segments);
const sorted = (directories: string[]): string[] => [...directories].sort();

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated watch failure`), { code });
}

type FakeHandle = {
  directory: string;
  recursive: boolean;
  open: boolean;
  /** The system stopped reporting this handle's directory without telling the process. */
  silent: boolean;
  unrefCalls: number;
  emit(filename: string | null, eventType?: string): void;
  fail(error: Error): void;
};

/** How a system loses the watch of a removed directory. Neither reports an `error` or a `close`. */
type DirectoryRemoval = "windows" | "inotify";

/** Most events that a removal sends to a handle that nobody closes, so that a watcher that never closes it ends the loop. */
const REMOVAL_EVENT_CAP = 5_000;

type FakeWatch = {
  watch: ProjectWatchFactory;
  /** Every handle ever opened, in order. */
  handles: FakeHandle[];
  /** Paths for which a second handle was opened while the first was still open. */
  duplicateOpens: string[];
  openHandles(): FakeHandle[];
  openDirectories(): string[];
  /** The most handles that were ever open at once. */
  maxOpen(): number;
  /** Delivers an event through every open handle of `directory` that still receives events; returns how many did. */
  deliver(directory: string, filename: string | null, eventType?: string): number;
  /**
   * Removes `directory` as the system does to its watch, and returns how many events the process received.
   * - `windows`: `rename` events that name the directory by its absolute path (`\\?\C:\...`), again and again for as
   *   long as the handle stays open.
   * - `inotify`: two `rename` events with the directory's own name, then nothing more from a handle that is still open.
   */
  removeDirectory(directory: string, removal: DirectoryRemoval): number;
  /** Makes `watch` throw for the directories that `failure` returns an error for. */
  failOpens(failure: ((directory: string) => Error | undefined) | undefined): void;
};

/** Stands in for `fs.watch`: counts open handles and records any second handle opened for one path. */
function createFakeWatch(): FakeWatch {
  const handles: FakeHandle[] = [];
  const duplicateOpens: string[] = [];
  let openFailure: ((directory: string) => Error | undefined) | undefined;
  let maxOpen = 0;
  const openHandles = (): FakeHandle[] => handles.filter((handle) => handle.open);
  const receiving = (directory: string): FakeHandle[] =>
    openHandles().filter((handle) => handle.directory === directory && !handle.silent);
  const watch: ProjectWatchFactory = (directory, watchOptions, listener) => {
    const failure = openFailure?.(directory);
    if (failure) throw failure;
    if (openHandles().some((handle) => handle.directory === directory)) duplicateOpens.push(directory);
    const errorListeners: Array<(error: Error) => void> = [];
    const handle: FakeHandle = {
      directory,
      recursive: watchOptions.recursive,
      open: true,
      silent: false,
      unrefCalls: 0,
      emit: (filename, eventType = "change") => {
        if (!handle.silent) listener(eventType, filename);
      },
      fail: (error) => {
        for (const errorListener of errorListeners) errorListener(error);
      },
    };
    handles.push(handle);
    maxOpen = Math.max(maxOpen, openHandles().length);
    return {
      close: () => {
        handle.open = false;
      },
      unref: () => {
        handle.unrefCalls += 1;
      },
      on: (_event, errorListener) => {
        errorListeners.push(errorListener);
      },
    };
  };
  return {
    watch,
    handles,
    duplicateOpens,
    openHandles,
    openDirectories: () => sorted(openHandles().map((handle) => handle.directory)),
    maxOpen: () => maxOpen,
    deliver: (directory, filename, eventType) => {
      const receivers = receiving(directory);
      for (const handle of receivers) handle.emit(filename, eventType);
      return receivers.length;
    },
    removeDirectory: (directory, removal) => {
      let received = 0;
      for (const handle of receiving(directory)) {
        if (removal === "windows") {
          while (handle.open && received < REMOVAL_EVENT_CAP) {
            handle.emit(`\\\\?\\${directory}`, "rename");
            received += 1;
          }
        } else {
          // IN_DELETE_SELF, then IN_IGNORED. A process that closed the handle at the first one never sees the second.
          for (let event = 0; event < 2 && handle.open; event += 1) {
            handle.emit(path.basename(directory), "rename");
            received += 1;
          }
          handle.silent = true;
        }
      }
      return received;
    },
    failOpens: (failure) => {
      openFailure = failure;
    },
  };
}

function startWatcher(overrides: Partial<ProjectWatcherOptions> & { fake?: FakeWatch } = {}) {
  const { fake = createFakeWatch(), ...watcherOverrides } = overrides;
  const onChange = vi.fn();
  const onSettled = vi.fn();
  const log = vi.fn();
  const watcher = startProjectWatcher({
    root,
    onChange,
    onSettled,
    listFiles: async () => [],
    platform: "win32",
    watch: fake.watch,
    log,
    ...watcherOverrides,
  });
  return { fake, watcher, onChange, onSettled, log };
}

// The controller never reads the snapshot that `loadProject` returns.
const snapshot = {} as AgentProjectSnapshot;

function createFakeSession(files: string[]) {
  const calls: string[] = [];
  const checkStarts: number[] = [];
  const checkEnds: number[] = [];
  const loadEnds: number[] = [];
  const state: {
    freshness: AgentFreshnessResult | Error;
    files: string[];
    hold: Promise<void> | undefined;
    /** Holds `loadProject`, the rebuild, until it is released. */
    loadHold: Promise<void> | undefined;
    /** Holds `listFiles`, the read of the file list, until it is released. */
    listHold: Promise<void> | undefined;
    /** How long a freshness check takes once `hold` is released. */
    checkMs: number;
  } = {
    freshness: { state: "fresh" },
    files,
    hold: undefined,
    loadHold: undefined,
    listHold: undefined,
    checkMs: 0,
  };
  const session: AgentSession = {
    root,
    listFiles: async () => {
      calls.push("listFiles");
      await state.listHold;
      return [...state.files];
    },
    checkFreshness: async () => {
      calls.push("checkFreshness");
      checkStarts.push(Date.now());
      await state.hold;
      if (state.checkMs) await new Promise<void>((resolve) => setTimeout(resolve, state.checkMs));
      checkEnds.push(Date.now());
      if (state.freshness instanceof Error) throw state.freshness;
      return state.freshness;
    },
    loadProject: async (loadOptions) => {
      calls.push(`loadProject:${loadOptions?.symbolGraph}`);
      await state.loadHold;
      loadEnds.push(Date.now());
      return snapshot;
    },
    markChanged: () => {
      calls.push("markChanged");
    },
    invalidate: () => {
      calls.push("invalidate");
    },
  };
  const count = (call: string): number => calls.filter((entry) => entry === call).length;
  return { session, calls, checkStarts, checkEnds, loadEnds, state, count };
}

function startController(
  overrides: Partial<WatchControllerOptions> & { fake?: FakeWatch; files?: string[]; listHold?: Promise<void> } = {},
) {
  const { fake = createFakeWatch(), files = [], listHold, ...controllerOverrides } = overrides;
  const fakeSession = createFakeSession(files);
  fakeSession.state.listHold = listHold;
  const log = vi.fn();
  const controller = createWatchController(fakeSession.session, {
    root,
    platform: "win32",
    watch: fake.watch,
    log,
    // Nothing else refreshes the session in these tests, so a turn comes at once.
    runExclusive: (operation) => operation(),
    ...controllerOverrides,
  });
  return { fake, controller, log, ...fakeSession };
}

/** Stands in for the lock that the MCP handlers pass as `runExclusive`: one operation at a time, in the order asked. */
function createExclusiveRunner(): (operation: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (operation) => {
    const turn = tail.then(operation);
    tail = turn.catch(() => undefined);
    return turn;
  };
}

describe("startProjectWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports events outside ignored directories and skips events inside them", async () => {
    const { fake, onChange, onSettled } = startWatcher();
    const [handle] = fake.openHandles();

    const ignored = [
      ".git/index",
      ".git\\objects\\ab",
      "node_modules/a/b.ts",
      "packages/x/node_modules/y.js",
      ".codegraph/cache/index-v1/search-v1.sqlite",
      ".codegraph/server.json",
      ".codegraph-cache/index-v1/manifest.json",
      // The other directories that default discovery ignores, so that a build writing into them wakes nothing.
      "dist",
      "dist/bundle.js",
      "dist\\chunks\\a.js",
      "packages/app/build/out.js",
      "target/debug/app",
      ".venv/lib/x.py",
      "venv/bin/python",
      "lib/python3/site-packages/y.py",
      "src/__pycache__/m.pyc",
      "vendor/bundle/ruby/gem.rb",
      ".build/debug/x",
      "Pods/Alamofire/a.swift",
      "infra/.terraform/providers/x",
    ];
    for (const filename of ignored) handle.emit(filename);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChange).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();

    // Neighbors whose names only contain an ignored name are real project files.
    const reported = [
      "src/a.ts",
      "src\\b.ts",
      ".gitignore",
      ".github/workflows/ci.yml",
      "node_modules_old/a.ts",
      "my.git/config",
      "codegraph/notes.md",
      "constructor/index.ts",
      "distro/a.ts",
      "src/build.ts",
      "build.gradle",
      "targets/a.ts",
      ".venv2/x.py",
      "vendor/lib/x.go",
      "vendor/bundle.rb",
      "Podfile",
      null,
    ];
    for (const filename of reported) handle.emit(filename);
    expect(onChange).toHaveBeenCalledTimes(reported.length);
  });

  it("ignores the subtree of a cache directory that was moved into the project, and nothing next to it", async () => {
    const { fake, onChange, onSettled } = startWatcher({ cacheDirectory: at(".moved-cache", "project-abc") });
    const [handle] = fake.openHandles();

    const ignored = [
      ".moved-cache/project-abc",
      ".moved-cache/project-abc/manifest.json",
      ".moved-cache\\project-abc\\cache\\index-v1\\search-v1.sqlite",
    ];
    for (const filename of ignored) handle.emit(filename);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChange).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();

    // Paths that only start like the cache directory's are project files.
    const reported = [
      ".moved-cache/notes.md",
      ".moved-cache/project-abcd/a.ts",
      ".moved-cache/other/project-abc/a.ts",
      ".moved-cache2/project-abc/a.ts",
      "src/.moved-cache/project-abc/a.ts",
      "project-abc/a.ts",
    ];
    for (const filename of reported) handle.emit(filename);
    expect(onChange).toHaveBeenCalledTimes(reported.length);
  });

  it.each([
    ["outside the project", path.join(os.tmpdir(), "cg-project-watcher-elsewhere", "project-abc")],
    ["at the project root", root],
  ] as const)("ignores nothing extra for a cache directory %s", (_label, cacheDirectory) => {
    const { fake, onChange } = startWatcher({ cacheDirectory });
    const [handle] = fake.openHandles();
    const reported = ["src/a.ts", "project-abc/a.ts", "elsewhere/project-abc/a.ts", "a.ts"];

    for (const filename of reported) handle.emit(filename);

    expect(onChange).toHaveBeenCalledTimes(reported.length);
  });

  it.each([
    ["a case-insensitive file system", true, 0],
    ["a case-sensitive file system", false, 1],
  ] as const)("compares the cache directory's path as %s does", (_label, caseInsensitive, expectedReports) => {
    const originalCaseInsensitive = isFileIdentityCaseInsensitive();
    resetFileIdentityCaseSensitivityForTests(caseInsensitive);
    try {
      const { fake, onChange } = startWatcher({ cacheDirectory: at(".moved-cache", "project-abc") });

      // The system names the directory as it is on disk, which can differ in case from the configured path.
      fake.openHandles()[0]?.emit(".Moved-Cache\\Project-ABC\\manifest.json");

      expect(onChange).toHaveBeenCalledTimes(expectedReports);
    } finally {
      resetFileIdentityCaseSensitivityForTests(originalCaseInsensitive);
    }
  });

  it("settles once, debounceMs after the last of several events", async () => {
    const { fake, onChange, onSettled } = startWatcher();
    const [handle] = fake.openHandles();

    handle.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(200);
    handle.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(200);
    handle.emit("src/c.ts");

    expect(onChange).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(499);
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("settles events that are further apart than the debounce separately", async () => {
    const { fake, onSettled } = startWatcher({ debounceMs: 100 });
    const [handle] = fake.openHandles();

    handle.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(101);
    handle.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(101);

    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("opens one recursive handle and never reads the file list on Windows and macOS", async () => {
    for (const platform of ["win32", "darwin"] as const) {
      const listFiles = vi.fn(async () => [at("src", "a.ts")]);
      const { fake, watcher } = startWatcher({ platform, listFiles });
      await watcher.refreshDirectories();

      expect(fake.handles.map((handle) => [handle.directory, handle.recursive])).toEqual([[root, true]]);
      expect(listFiles).not.toHaveBeenCalled();
      watcher.close();
    }
  });

  it("watches the root, directories that hold listed files, and their ancestors, and nothing in an ignored directory", async () => {
    const files = [
      at("src", "a", "b.ts"),
      at("src", "c.ts"),
      at("README.md"),
      at("node_modules", "pkg", "index.js"),
      at(".git", "hooks", "pre-commit"),
      at(".codegraph", "cache", "state.json"),
      at("docs", "node_modules", "y.md"),
      at("dist", "out.js"),
      at("src", "build", "gen.ts"),
      at("vendor", "bundle", "gems", "g.rb"),
      at("vendor", "lib", "v.go"),
      at("..hidden", "z.ts"),
      path.join(os.tmpdir(), "cg-project-watcher-elsewhere", "outside.ts"),
    ];
    const { fake, watcher } = startWatcher({ platform: "linux", listFiles: async () => files });
    await watcher.refreshDirectories();

    // `..hidden` is an ordinary directory name, not a way out of the root. Bare `vendor` is not ignored, only `vendor/bundle`.
    expect(fake.openDirectories()).toEqual(
      sorted([root, at("src"), at("src", "a"), at("vendor"), at("vendor", "lib"), at("..hidden")]),
    );
    expect(fake.handles.every((handle) => !handle.recursive)).toBe(true);
    expect(fake.handles.every((handle) => handle.unrefCalls === 1)).toBe(true);
    expect(fake.duplicateOpens).toEqual([]);
  });

  it("watches the root before the file list arrives", () => {
    const { fake } = startWatcher({ platform: "linux", listFiles: () => Promise.withResolvers<string[]>().promise });

    expect(fake.openDirectories()).toEqual([root]);
  });

  it("adds a watch for a directory that appears in the file list and closes the watch of one that disappears", async () => {
    let files = [at("src", "a.ts")];
    const { fake, watcher } = startWatcher({ platform: "linux", listFiles: async () => files });
    await watcher.refreshDirectories();
    const srcHandle = fake.handles.find((handle) => handle.directory === at("src"));
    expect(fake.openDirectories()).toEqual(sorted([root, at("src")]));

    files = [at("src", "a.ts"), at("src", "new", "d.ts")];
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([root, at("src"), at("src", "new")]));
    expect(fake.handles).toHaveLength(3);
    expect(srcHandle?.open).toBe(true);

    files = [at("lib", "e.ts")];
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([root, at("lib")]));
    expect(srcHandle?.open).toBe(false);
    expect(fake.duplicateOpens).toEqual([]);
  });

  it("shares one directory scan among overlapping refreshes and reads the file list once more", async () => {
    const lists: Array<PromiseWithResolvers<string[]>> = [];
    const listFiles = vi.fn(() => {
      const list = Promise.withResolvers<string[]>();
      lists.push(list);
      return list.promise;
    });
    const { fake, watcher } = startWatcher({ platform: "linux", listFiles });
    expect(listFiles).toHaveBeenCalledTimes(1);

    const overlapping = [watcher.refreshDirectories(), watcher.refreshDirectories(), watcher.refreshDirectories()];
    expect(listFiles).toHaveBeenCalledTimes(1);
    lists[0]?.resolve([at("src", "a.ts")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(listFiles).toHaveBeenCalledTimes(2);
    lists[1]?.resolve([at("src", "a.ts"), at("lib", "b.ts")]);
    await Promise.all(overlapping);

    expect(fake.openDirectories()).toEqual(sorted([root, at("src"), at("lib")]));
    expect(fake.duplicateOpens).toEqual([]);
  });

  it("treats a watch error as a change, closes only that handle, logs once, and reopens the directory at the next refresh", async () => {
    const files = [at("src", "a.ts"), at("lib", "b.ts")];
    const { fake, watcher, onChange, onSettled, log } = startWatcher({
      platform: "linux",
      listFiles: async () => files,
    });
    await watcher.refreshDirectories();
    const srcHandle = fake.handles.find((handle) => handle.directory === at("src"));
    const libHandle = fake.handles.find((handle) => handle.directory === at("lib"));

    expect(() => srcHandle?.fail(errnoError("EPERM"))).not.toThrow();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(srcHandle?.open).toBe(false);
    expect(libHandle?.open).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("file watch failed: EPERM"));
    await vi.advanceTimersByTimeAsync(500);
    expect(onSettled).toHaveBeenCalledTimes(1);

    libHandle?.fail(errnoError("EIO"));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);

    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([root, at("src"), at("lib")]));
    expect(fake.duplicateOpens).toEqual([]);
  });

  it.each(["ENOSPC", "EMFILE"])("closes every handle for good when a watch error reports %s", async (code) => {
    const listFiles = vi.fn(async () => [at("src", "a.ts")]);
    const { fake, watcher, onChange, log } = startWatcher({ platform: "linux", listFiles });
    await watcher.refreshDirectories();
    expect(fake.openHandles()).toHaveLength(2);
    listFiles.mockClear();

    fake.handles[0]?.fail(errnoError(code));

    expect(fake.openHandles()).toHaveLength(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(`[codegraph] file watching disabled: ${code}`);
    await watcher.refreshDirectories();
    expect(listFiles).not.toHaveBeenCalled();
    expect(fake.openHandles()).toHaveLength(0);
  });

  it("skips only a directory whose watch cannot open, and retries it at the next refresh", async () => {
    const files = [at("src", "a.ts"), at("lib", "b.ts"), at("docs", "c.md")];
    const fake = createFakeWatch();
    fake.failOpens((directory) => (directory === at("src") ? errnoError("ENOENT") : undefined));
    const { watcher, log } = startWatcher({ fake, platform: "linux", listFiles: async () => files });

    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([root, at("lib"), at("docs")]));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));

    fake.failOpens(undefined);
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([root, at("src"), at("lib"), at("docs")]));
  });

  it("stops watching altogether when opening a directory runs out of watches", async () => {
    const files = [at("src", "a.ts"), at("lib", "b.ts"), at("docs", "c.md")];
    const fake = createFakeWatch();
    fake.failOpens((directory) => (directory === at("lib") ? errnoError("ENOSPC") : undefined));
    const { watcher, log, onChange } = startWatcher({ fake, platform: "linux", listFiles: async () => files });

    await watcher.refreshDirectories();

    expect(fake.openHandles()).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[codegraph] file watching disabled: ENOSPC");
    // Losing the watches is not itself an event: the session keeps its pull check.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes every handle, cancels a pending settle, and ignores later events, refreshes, and closes", async () => {
    const lists: Array<PromiseWithResolvers<string[]>> = [];
    const listFiles = vi.fn(() => {
      const list = Promise.withResolvers<string[]>();
      lists.push(list);
      return list.promise;
    });
    const { fake, watcher, onChange, onSettled } = startWatcher({ platform: "linux", listFiles });
    lists[0]?.resolve([at("src", "a.ts")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.openDirectories()).toEqual(sorted([root, at("src")]));
    const [rootHandle] = fake.openHandles();
    rootHandle.emit("src/a.ts");
    expect(vi.getTimerCount()).toBe(1);

    const pendingScan = watcher.refreshDirectories();
    watcher.close();
    watcher.close();

    expect(fake.openHandles()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onSettled).not.toHaveBeenCalled();

    // A scan that was already reading the file list opens nothing once the watcher is closed.
    lists[1]?.resolve([at("src", "a.ts"), at("lib", "b.ts")]);
    await pendingScan;
    expect(fake.openHandles()).toHaveLength(0);
    const handlesAtClose = fake.handles.length;
    rootHandle.emit("src/late.ts");
    await watcher.refreshDirectories();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(fake.handles).toHaveLength(handlesAtClose);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no handle or timer open after many events, many directory refreshes, and close", async () => {
    const directories = Array.from({ length: 12 }, (_, index) => at(`dir${index}`));
    let files: string[] = [];
    const { fake, watcher, onChange, onSettled } = startWatcher({
      platform: "linux",
      debounceMs: 10,
      listFiles: async () => files,
    });
    let largestWanted = 1;

    for (let round = 0; round < 20; round += 1) {
      // A different subset of directories each round, so handles close and reopen repeatedly.
      files = directories
        .filter((_, index) => (index + round) % 3 !== 0)
        .map((directory) => path.join(directory, "f.ts"));
      await watcher.refreshDirectories();
      const wanted = files.length + 1;
      largestWanted = Math.max(largestWanted, wanted);
      expect(fake.openHandles()).toHaveLength(wanted);
      for (let event = 0; event < 50; event += 1) {
        fake.openHandles()[event % wanted]?.emit(`f${event}.ts`);
      }
      await vi.advanceTimersByTimeAsync(10);
    }

    expect(onChange).toHaveBeenCalledTimes(1_000);
    expect(onSettled).toHaveBeenCalledTimes(20);
    expect(fake.maxOpen()).toBeLessThanOrEqual(largestWanted);
    expect(fake.duplicateOpens).toEqual([]);
    expect(fake.handles.every((handle) => handle.unrefCalls === 1)).toBe(true);

    watcher.close();
    expect(fake.openHandles()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["Windows, recursive root", "windows", "win32", root],
    ["Windows, a root under an ignored directory name", "windows", "win32", path.join(os.tmpdir(), "build", "cg-app")],
    ["Windows, per-directory watches", "windows", "linux", root],
    ["Linux", "inotify", "linux", root],
  ] as const)(
    "closes a handle at the first event that names its removed directory, as %s sends it",
    async (_label, removal, platform, watchedRoot) => {
      const { fake, watcher, onChange, onSettled, log } = startWatcher({ root: watchedRoot, platform });

      // Windows repeats the event for as long as the handle stays open, and sends no error.
      expect(fake.removeDirectory(watchedRoot, removal)).toBe(1);

      expect(fake.openHandles()).toHaveLength(0);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(onSettled).toHaveBeenCalledTimes(1);
      watcher.close();
    },
  );

  it("keeps a recursive handle when an entry is named like the root", () => {
    const { fake, watcher, onChange } = startWatcher({ platform: "win32" });

    // `proj/proj` was created: a recursive handle reports it as a relative name, never as its own path.
    expect(fake.deliver(root, path.basename(root), "rename")).toBe(1);

    expect(fake.openHandles()).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it("watches a directory again at the next refresh after the system dropped its watch without a word", async () => {
    const files = [at("src", "a.ts")];
    const { fake, watcher, onChange } = startWatcher({ platform: "linux", listFiles: async () => files });
    await watcher.refreshDirectories();
    expect(fake.deliver(at("src"), "a.ts")).toBe(1);

    // `rm -rf src && mkdir src`: the old watch is gone, and all the process hears is a rename of the directory's name.
    fake.removeDirectory(at("src"), "inotify");
    expect(fake.deliver(at("src"), "a.ts")).toBe(0);
    await watcher.refreshDirectories();

    expect(fake.deliver(at("src"), "a.ts")).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(fake.duplicateOpens).toEqual([]);
    watcher.close();
  });
});

describe("createWatchController", () => {
  const freshnessByState: Record<"fresh" | "refreshed" | "stale" | "unchecked", AgentFreshnessResult> = {
    fresh: { state: "fresh" },
    refreshed: { state: "refreshed", changedFiles: ["src/a.ts"] },
    stale: {
      state: "stale",
      changedFiles: ["src/a.ts"],
      changedFileCount: 1,
      omittedChangedFileCount: 0,
      reason: "changed file count exceeds 50",
    },
    unchecked: { state: "unchecked", reason: "manual" },
  };

  // What a real auto session reports when it cannot read its configuration, so that the test below follows the
  // session's own wording. It runs before the fake timers start, because the session does real file work.
  let configurationUnchecked: AgentFreshnessResult;
  const setupRoots = createTempRootRegistry();

  beforeAll(async () => {
    const projectRoot = await setupRoots.create("cg-project-watcher-config-");
    await fs.writeFile(path.join(projectRoot, "main.ts"), "export const value = 1;\n");
    await fs.writeFile(path.join(projectRoot, "tsconfig.json"), "{}\n");
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (path.basename(String(args[0])) === "tsconfig.json") {
        throw Object.assign(new Error("config read denied"), { code: "EACCES" });
      }
      return await originalReadFile(...args);
    });
    const session = createAgentSession({
      root: projectRoot,
      buildOptions: { cache: "off" },
      freshness: { policy: "auto" },
    });
    try {
      await session.loadProject({ symbolGraph: "skip" });
      configurationUnchecked = await session.checkFreshness!();
    } finally {
      readSpy.mockRestore();
      session.invalidate();
    }
  });

  afterAll(async () => {
    await setupRoots.cleanup();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the session's freshness result at every event, before the burst settles", () => {
    const { fake, count } = startController();
    const [handle] = fake.openHandles();

    handle.emit("src/a.ts");
    handle.emit("src/b.ts");
    handle.emit(".git/index");

    expect(count("markChanged")).toBe(2);
  });

  it.each([
    ["fresh", ["markChanged", "checkFreshness"]],
    ["refreshed", ["markChanged", "checkFreshness", "loadProject:skip"]],
    ["stale", ["markChanged", "checkFreshness", "invalidate", "loadProject:skip"]],
    ["unchecked", ["markChanged", "checkFreshness"]],
  ] as const)("runs a background refresh for a settled burst that finds %s", async (outcome, expectedCalls) => {
    const { fake, calls, state } = startController();
    state.freshness = freshnessByState[outcome];

    fake.openHandles()[0]?.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toEqual(["markChanged"]);
    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toEqual(expectedCalls);
  });

  it("leaves a session that cannot verify its configuration alone, as the session retains its snapshot", async () => {
    const { fake, calls, state } = startController();
    expect(configurationUnchecked).toMatchObject({ state: "stale", changedFileCount: 0 });
    state.freshness = configurationUnchecked;

    fake.openHandles()[0]?.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);

    expect(calls).toEqual(["markChanged", "checkFreshness"]);
  });

  it("starts a refresh at most once per interval after the previous one ended while events keep coming for 20 seconds", async () => {
    const { fake, checkStarts, controller, state } = startController();
    const [handle] = fake.openHandles();
    state.checkMs = 700;

    for (let second = 0; second < 20; second += 1) {
      handle.emit("src/a.ts");
      await vi.advanceTimersByTimeAsync(1_000);
    }

    // The interval counts from the end of a refresh (1_200, 7_200, 13_200), so refreshes are due at 6_200, 12_200, and
    // 18_200. An event at 6_000, 12_000, and 18_000 keeps its burst open for 500 ms more, and a refresh starts only once
    // a burst has settled.
    expect(checkStarts).toEqual([500, 6_500, 12_500, 18_500]);
    const closing = controller.close();
    expect(vi.getTimerCount()).toBe(0);
    await closing;
  });

  it("never starts a refresh within the interval after the previous one ended, even when a refresh outlasts the interval", async () => {
    const { fake, checkStarts, checkEnds, controller, state } = startController({
      debounceMs: 50,
      minRefreshIntervalMs: 500,
    });
    state.checkMs = 800;
    const [handle] = fake.openHandles();

    // An event every 200 ms, so that a burst settles during every refresh.
    for (let tick = 0; tick < 30; tick += 1) {
      handle.emit("src/a.ts");
      await vi.advanceTimersByTimeAsync(200);
    }

    expect(checkStarts.length).toBeGreaterThanOrEqual(4);
    const gaps = checkStarts.slice(1).map((start, index) => start - (checkEnds[index] ?? Number.NaN));
    expect(gaps.every((gap) => gap >= 500)).toBe(true);
    // The refresh that is running at the end finishes within its 800 ms.
    const closing = controller.close();
    await vi.advanceTimersByTimeAsync(800);
    await closing;
  });

  it("waits for a burst to end before refreshing, however long it lasts", async () => {
    const { fake, checkStarts } = startController();
    const [handle] = fake.openHandles();

    for (let tick = 0; tick < 200; tick += 1) {
      handle.emit("src/out.js");
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(checkStarts).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    expect(checkStarts).toEqual([20_400]);
  });

  it("starts no refresh within the debounce time of an event, even when one is waiting out the minimum interval", async () => {
    const { fake, checkStarts } = startController();
    const [handle] = fake.openHandles();

    handle.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);
    expect(checkStarts).toEqual([500]);
    // This burst settles at 1_500, and its refresh waits for the 5 s floor, until 5_500.
    await vi.advanceTimersByTimeAsync(500);
    handle.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(4_200);

    // A new burst starts just before that refresh is due, and goes on past it.
    handle.emit("src/c.ts");
    await vi.advanceTimersByTimeAsync(100);
    handle.emit("src/d.ts");
    await vi.advanceTimersByTimeAsync(100);
    handle.emit("src/e.ts");
    await vi.advanceTimersByTimeAsync(100);
    expect(checkStarts).toEqual([500]);

    // The burst settles at 5_900, 500 ms after its last event, and the refresh starts then.
    await vi.advanceTimersByTimeAsync(399);
    expect(checkStarts).toEqual([500]);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkStarts).toEqual([500, 5_900]);
  });

  it("keeps the minimum interval after the previous refresh when an event restarts the wait", async () => {
    const { fake, checkStarts } = startController();
    const [handle] = fake.openHandles();

    handle.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);
    expect(checkStarts).toEqual([500]);
    // Settles at 1_000; the first refresh ended at 500, so this one is due at 5_500.
    handle.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(1_500);
    // Settles at 2_500, long before the floor.
    handle.emit("src/c.ts");
    await vi.advanceTimersByTimeAsync(3_499);
    expect(checkStarts).toEqual([500]);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkStarts).toEqual([500, 5_500]);
  });

  it("does not rerun in the middle of a burst that began while the refresh was running", async () => {
    const { fake, checkStarts, state } = startController({ minRefreshIntervalMs: 0 });
    const [handle] = fake.openHandles();
    const release = Promise.withResolvers<void>();
    state.hold = release.promise;

    handle.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);
    expect(checkStarts).toEqual([500]);
    // This burst settles at 1_000, while the refresh still runs, and sets the rerun flag.
    handle.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(500);

    // A new burst starts, and the refresh ends 100 ms into it. With no minimum interval, the old flag would start the
    // rerun at once.
    handle.emit("src/c.ts");
    await vi.advanceTimersByTimeAsync(100);
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(checkStarts).toEqual([500]);

    await vi.advanceTimersByTimeAsync(399);
    expect(checkStarts).toEqual([500]);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkStarts).toEqual([500, 1_500]);
  });

  it("runs one more refresh, an interval after the current one ended, when bursts settle during it", async () => {
    const { fake, checkStarts, state } = startController();
    const [handle] = fake.openHandles();
    const release = Promise.withResolvers<void>();
    state.hold = release.promise;

    handle.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);
    expect(checkStarts).toEqual([500]);

    // Two separate bursts settle while the first refresh is still running: one rerun flag.
    handle.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(500);
    handle.emit("src/c.ts");
    await vi.advanceTimersByTimeAsync(500);
    expect(checkStarts).toEqual([500]);

    // The first refresh ends at 1_500, when it is released.
    release.resolve();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(checkStarts).toEqual([500]);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkStarts).toEqual([500, 6_500]);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(checkStarts).toEqual([500, 6_500]);
  });

  it("does not rerun when nothing changed while the refresh ran", async () => {
    const { fake, checkStarts, state } = startController();
    const release = Promise.withResolvers<void>();
    state.hold = release.promise;

    fake.openHandles()[0]?.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(2_000);
    release.resolve();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(checkStarts).toEqual([500]);
  });

  it("logs a failed refresh once, never throws, and keeps refreshing later bursts", async () => {
    const { fake, log, state, checkStarts } = startController();
    const [handle] = fake.openHandles();
    state.freshness = new Error("scan exploded");

    handle.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[codegraph] watch refresh failed: scan exploded");

    state.freshness = { state: "fresh" };
    handle.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(checkStarts).toEqual([500, 5_500]);
    expect(log).toHaveBeenCalledTimes(1);

    state.freshness = new Error("scan exploded again");
    handle.emit("src/c.ts");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("reconciles the per-directory watches after every refresh, including one that finds nothing stale", async () => {
    const { fake, state, calls } = startController({ platform: "linux", files: [at("src", "a.ts")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.openDirectories()).toEqual(sorted([root, at("src")]));

    // Another query already rebuilt around the new directory, so the background check finds nothing stale.
    state.files = [at("src", "a.ts"), at("lib", "b.ts")];
    fake.openHandles()[0]?.emit("lib");
    await vi.advanceTimersByTimeAsync(500);

    expect(calls).not.toContain("loadProject:skip");
    expect(fake.openDirectories()).toEqual(sorted([root, at("src"), at("lib")]));
  });

  it("closes the watches and every timer after the idle time, and reopens them once for the next tool call", async () => {
    const { fake, controller, count } = startController({ idleMs: 1_000 });
    expect(fake.openHandles()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fake.openHandles()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.openHandles()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(count("markChanged")).toBe(0);

    controller.noteActivity();
    expect(fake.openHandles()).toHaveLength(1);
    expect(count("markChanged")).toBe(1);

    controller.noteActivity();
    controller.noteActivity();
    expect(fake.handles).toHaveLength(2);
    expect(count("markChanged")).toBe(1);

    // The resumed watcher is live: the next event reaches the session.
    fake.openHandles()[0]?.emit("src/a.ts");
    expect(count("markChanged")).toBe(2);
  });

  it("restarts the idle time at every tool call", async () => {
    const { fake, controller } = startController({ idleMs: 1_000 });

    await vi.advanceTimersByTimeAsync(900);
    controller.noteActivity();
    await vi.advanceTimersByTimeAsync(900);
    controller.noteActivity();
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.openHandles()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.openHandles()).toHaveLength(0);
  });

  it("cancels a refresh that waits for the minimum interval when it pauses", async () => {
    const { fake, checkStarts } = startController({ idleMs: 3_000 });
    const [handle] = fake.openHandles();

    handle.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(checkStarts).toEqual([500]);
    // This burst settles at 1_500 and then waits for the 5 s floor, until 5_500. The idle time runs out at 3_000.
    handle.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(1_800);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(200);

    expect(fake.openHandles()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkStarts).toEqual([500]);
  });

  it("cancels a pending debounce when it pauses", async () => {
    const { fake, checkStarts } = startController({ idleMs: 3_000 });
    const [handle] = fake.openHandles();

    // This burst is still debouncing at 2_800, when the idle time is about to run out at 3_000.
    await vi.advanceTimersByTimeAsync(2_800);
    handle.emit("src/a.ts");
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(200);

    expect(fake.openHandles()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkStarts).toEqual([]);
  });

  it("lets a refresh that is running at the pause finish without another one", async () => {
    const { fake, checkStarts, state, log } = startController({ idleMs: 3_000 });
    const release = Promise.withResolvers<void>();
    state.hold = release.promise;

    fake.openHandles()[0]?.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);
    fake.openHandles()[0]?.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fake.openHandles()).toHaveLength(0);

    release.resolve();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(checkStarts).toEqual([500]);
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never pauses when the idle time is 0", async () => {
    const { fake } = startController({ idleMs: 0 });
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);

    expect(fake.openHandles()).toHaveLength(1);
  });

  it("pauses after 30 minutes without a tool call by default", async () => {
    const { fake } = startController();

    await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 - 1);
    expect(fake.openHandles()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.openHandles()).toHaveLength(0);
  });

  it("opens no watch until the first tool call when it starts paused", () => {
    const { fake, controller, count } = startController({ startPaused: true });
    expect(fake.handles).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    controller.noteActivity();

    expect(fake.openHandles()).toHaveLength(1);
    expect(count("markChanged")).toBe(1);
  });

  it("rewatches every directory when it resumes", async () => {
    const { fake, controller } = startController({
      platform: "linux",
      idleMs: 1_000,
      files: [at("src", "a.ts"), at("lib", "b.ts")],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.openHandles()).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.openHandles()).toHaveLength(0);
    controller.noteActivity();
    expect(fake.openDirectories()).toEqual([root]);
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.openDirectories()).toEqual(sorted([root, at("src"), at("lib")]));
    expect(fake.duplicateOpens).toEqual([]);
  });

  it("leaves nothing open after close, and later close and tool calls do nothing", async () => {
    const { fake, controller, count } = startController();
    fake.openHandles()[0]?.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(1_000);
    fake.openHandles()[0]?.emit("src/b.ts");
    expect(vi.getTimerCount()).toBe(2);

    await controller.close();
    await controller.close();

    expect(fake.openHandles()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    controller.noteActivity();
    expect(fake.handles).toHaveLength(1);
    expect(count("markChanged")).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["refreshed", "stale"] as const)(
    "does not rebuild when the server closed while the freshness check ran and found the index %s",
    async (outcome) => {
      const { fake, controller, calls, state } = startController();
      const release = Promise.withResolvers<void>();
      state.hold = release.promise;
      state.freshness = freshnessByState[outcome];

      fake.openHandles()[0]?.emit("src/a.ts");
      await vi.advanceTimersByTimeAsync(500);
      expect(calls).toEqual(["markChanged", "checkFreshness"]);

      let closed = false;
      const closing = (async () => {
        await controller.close();
        closed = true;
      })();
      await vi.advanceTimersByTimeAsync(1_000);
      // The check is still running, and it may replace the session's snapshot before it ends.
      expect(closed).toBe(false);
      release.resolve();
      await closing;
      await vi.advanceTimersByTimeAsync(60_000);

      // A rebuild now would keep the project and its cache busy after the client has left.
      expect(calls).toEqual(["markChanged", "checkFreshness"]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("waits at close for the rebuild that is running, and starts no refresh after it", async () => {
    const { fake, controller, calls, checkStarts, loadEnds, state } = startController();
    const releaseRebuild = Promise.withResolvers<void>();
    state.freshness = freshnessByState.refreshed;
    state.loadHold = releaseRebuild.promise;
    const [handle] = fake.openHandles();

    handle.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual(["markChanged", "checkFreshness", "loadProject:skip"]);
    // A burst that settles during the rebuild would schedule one more refresh.
    handle.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(500);

    let settledCloses = 0;
    const close = async (): Promise<void> => {
      await controller.close();
      settledCloses += 1;
    };
    const closings = [close(), close()];
    await vi.advanceTimersByTimeAsync(60_000);
    // A caller that releases the session now does it under a rebuild that goes on writing to it.
    expect(settledCloses).toBe(0);
    expect(loadEnds).toEqual([]);

    releaseRebuild.resolve();
    await Promise.all(closings);
    expect(settledCloses).toBe(2);
    expect(loadEnds).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkStarts).toEqual([500]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes its turn from the exclusive runner before it checks the session, and keeps the turn until the rebuild ended", async () => {
    const turn = Promise.withResolvers<void>();
    const releaseRebuild = Promise.withResolvers<void>();
    let turnEnded = false;
    const { fake, calls, state } = startController({
      runExclusive: async (operation) => {
        await turn.promise;
        await operation();
        turnEnded = true;
      },
    });
    state.freshness = freshnessByState.stale;
    state.loadHold = releaseRebuild.promise;

    fake.openHandles()[0]?.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);
    // Another refresh or an artifact build holds the session: not even the check runs beside it.
    expect(calls).toEqual(["markChanged"]);

    turn.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["markChanged", "checkFreshness", "invalidate", "loadProject:skip"]);
    expect(turnEnded).toBe(false);

    releaseRebuild.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(turnEnded).toBe(true);
  });

  it("checks and rebuilds nothing when the server closed while the refresh waited for its turn", async () => {
    const turn = Promise.withResolvers<void>();
    const { fake, controller, calls, state } = startController({
      runExclusive: async (operation) => {
        await turn.promise;
        await operation();
      },
    });
    state.freshness = freshnessByState.stale;

    fake.openHandles()[0]?.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);
    let closed = false;
    const closing = controller.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    // The refresh still waits, so a caller that releases the session now would do it under a check that is yet to run.
    expect(closed).toBe(false);

    turn.resolve();
    await closing;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toEqual(["markChanged"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up a refresh that waited for its turn when a newer event restarted the burst, and refreshes when that burst settles", async () => {
    const turn = Promise.withResolvers<void>();
    const { fake, calls, checkStarts } = startController({
      runExclusive: async (operation) => {
        await turn.promise;
        await operation();
      },
    });
    const [handle] = fake.openHandles();

    handle.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);
    // This burst settled, and its refresh waits behind another refresh or an artifact build.
    expect(calls).toEqual(["markChanged"]);
    // A newer burst starts, and the session comes free in the middle of it.
    handle.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(300);
    turn.resolve();
    await vi.advanceTimersByTimeAsync(199);

    // The refresh that waited belongs to the old burst, so it starts nothing while the new one still gets events.
    expect(checkStarts).toEqual([]);
    // The new burst settles at 1_000. The refresh that gave up did no work, so no interval holds this one back.
    await vi.advanceTimersByTimeAsync(1);
    expect(checkStarts).toEqual([1_000]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkStarts).toEqual([1_000]);
  });

  it("gives up a refresh that waited for its turn when the watcher paused, and starts none after it", async () => {
    const turn = Promise.withResolvers<void>();
    const { fake, calls, state } = startController({
      idleMs: 2_000,
      runExclusive: async (operation) => {
        await turn.promise;
        await operation();
      },
    });
    state.freshness = freshnessByState.stale;

    fake.openHandles()[0]?.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual(["markChanged"]);
    // The idle time runs out at 2_000, long before the session comes free.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fake.openHandles()).toHaveLength(0);

    turn.resolve();
    await vi.advanceTimersByTimeAsync(60_000);

    // The watching ended, and a check or a rebuild now would keep the project busy while nobody uses it.
    expect(calls).toEqual(["markChanged"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds a refresh_index behind the first read of the file list, which would otherwise end after the rebuild and replace its file signatures", async () => {
    const read = Promise.withResolvers<void>();
    const runExclusive = createExclusiveRunner();
    const { fake, calls } = startController({
      platform: "linux",
      files: [at("src", "a.ts")],
      listHold: read.promise,
      runExclusive,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["listFiles"]);

    // What `refresh_index` does under the same lock: it drops the session's state and rebuilds it.
    const refreshIndex = runExclusive(async () => {
      calls.push("refresh_index");
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(["listFiles"]);

    read.resolve();
    await refreshIndex;
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["listFiles", "refresh_index"]);
    expect(fake.openDirectories()).toEqual(sorted([root, at("src")]));
  });

  it.each([
    ["the idle time ran out", (_controller: WatchController) => vi.advanceTimersByTimeAsync(1_000)],
    ["the server closed", (controller: WatchController) => controller.close()],
  ] as const)(
    "reads no file list for a watcher that ended while its read waited for the session, because %s",
    async (_label, end) => {
      const turn = Promise.withResolvers<void>();
      const { fake, controller, calls } = startController({
        platform: "linux",
        idleMs: 1_000,
        files: [at("src", "a.ts")],
        runExclusive: async (operation) => {
          await turn.promise;
          await operation();
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual([]);

      await end(controller);
      turn.resolve();
      await vi.advanceTimersByTimeAsync(60_000);

      // Nothing uses the list of a watcher that ended, and a session that its owner released must not load the project again.
      expect(calls).toEqual([]);
      expect(fake.openHandles()).toHaveLength(0);
    },
  );

  it("waits at close for the read of the file list that is running, and uses nothing that it read", async () => {
    const read = Promise.withResolvers<void>();
    const { fake, controller, calls } = startController({
      platform: "linux",
      files: [at("src", "a.ts")],
      listHold: read.promise,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["listFiles"]);

    let closed = false;
    const closing = controller.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    // The read cannot be cancelled, and the first read of a session that nothing has loaded records its file signatures
    // when it ends. A caller that releases the session now would get them back.
    expect(closed).toBe(false);

    read.resolve();
    await closing;
    await vi.advanceTimersByTimeAsync(60_000);

    // The list belongs to a watcher that ended, so no watch opens for it.
    expect(calls).toEqual(["listFiles"]);
    expect(fake.openHandles()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles at close, and does not reject, when the read of the file list that it waited for failed", async () => {
    const read = Promise.withResolvers<void>();
    const { controller } = startController({
      platform: "linux",
      files: [at("src", "a.ts")],
      listHold: read.promise,
    });
    await vi.advanceTimersByTimeAsync(0);

    const closing = controller.close();
    read.reject(new Error("discovery failed"));

    // A caller that releases the session after `close` would never get to it if this rejected.
    await expect(closing).resolves.toBeUndefined();
  });

  it("completes a background refresh, and the directory scan that follows it, behind a lock that serves one operation at a time", async () => {
    const { fake, calls, state } = startController({
      platform: "linux",
      files: [at("src", "a.ts")],
      runExclusive: createExclusiveRunner(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.openDirectories()).toEqual(sorted([root, at("src")]));

    state.files = [at("src", "a.ts"), at("lib", "b.ts")];
    fake.openHandles()[0]?.emit("lib");
    await vi.advanceTimersByTimeAsync(500);

    // The check takes one turn, and the read of the file list after it takes another.
    expect(calls).toEqual(["listFiles", "markChanged", "checkFreshness", "listFiles"]);
    expect(fake.openDirectories()).toEqual(sorted([root, at("src"), at("lib")]));
  });

  it("closes at once, and never starts the refresh, when one only waits for its minimum interval", async () => {
    const { fake, controller, checkStarts } = startController();
    const [handle] = fake.openHandles();
    handle.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(500);
    expect(checkStarts).toEqual([500]);
    // This burst settles at 1_000, and its refresh waits for the 5 s floor, until 5_500. No refresh is running.
    handle.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(2);

    await controller.close();

    expect(fake.openHandles()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkStarts).toEqual([500]);
  });
});

describe("startProjectWatcher with the real file system", () => {
  const tempRoots = createTempRootRegistry();
  afterEach(async () => {
    await tempRoots.cleanup();
  });

  // `linux` forces the per-directory strategy so that every lane exercises it; the default is the platform's own.
  it.each([
    ["the platform default", undefined],
    ["per-directory watches", "linux"],
  ] as const)(
    "reports a write to a listed file with %s and nothing from inside .codegraph",
    async (_label, platform) => {
      const projectRoot = await tempRoots.create("cg-project-watcher-real-");
      const listed = path.join(projectRoot, "src", "a.ts");
      await fs.mkdir(path.dirname(listed), { recursive: true });
      await fs.mkdir(path.join(projectRoot, ".codegraph"));
      await fs.writeFile(listed, "export const a = 1;\n");
      const recursiveWatch = !platform && (process.platform === "win32" || process.platform === "darwin");
      // What the operating system delivers, to compare with what the watcher reports.
      const delivered: Array<string | null> = [];
      const onChange = vi.fn();
      const watcher = startProjectWatcher({
        root: projectRoot,
        onChange,
        onSettled: vi.fn(),
        listFiles: async () => [listed],
        watch: (directory, watchOptions, listener) =>
          fsWatch(directory, watchOptions, (eventType, filename) => {
            delivered.push(filename);
            listener(eventType, filename);
          }),
        ...(platform ? { platform } : {}),
      });

      try {
        await watcher.refreshDirectories();
        await fs.writeFile(path.join(projectRoot, ".codegraph", "state.json"), "{}\n");
        await fs.writeFile(listed, "export const a = 22;\n");
        await vi.waitFor(() => expect(delivered.some((name) => name?.endsWith("a.ts"))).toBe(true), {
          timeout: 10_000,
          interval: 25,
        });
        if (recursiveWatch) {
          // A recursive handle sees the cache write too; the watcher must not report it.
          await vi.waitFor(() => expect(delivered.some((name) => name?.includes(".codegraph"))).toBe(true), {
            timeout: 10_000,
            interval: 25,
          });
        }

        const projectEvents = delivered.filter((name) => !name?.includes(".codegraph"));
        expect(projectEvents.length).toBeGreaterThan(0);
        expect(onChange).toHaveBeenCalledTimes(projectEvents.length);
      } finally {
        watcher.close();
      }
    },
  );

  // The self-removal events of macOS (FSEvents) are not characterized, so these two run where they were observed.
  it.runIf(process.platform === "win32" || process.platform === "linux")(
    "closes the handle of a removed root instead of spinning on its events",
    async () => {
      const projectRoot = await tempRoots.create("cg-project-watcher-removed-");
      const listed = path.join(projectRoot, "src", "a.ts");
      await fs.mkdir(path.dirname(listed), { recursive: true });
      await fs.writeFile(listed, "export const a = 1;\n");
      let delivered = 0;
      const closed = new Set<string>();
      const watcher = startProjectWatcher({
        root: projectRoot,
        onChange: vi.fn(),
        onSettled: vi.fn(),
        listFiles: async () => [listed],
        watch: (directory, watchOptions, listener) => {
          const handle = fsWatch(directory, watchOptions, (eventType, filename) => {
            delivered += 1;
            listener(eventType, filename);
          });
          const close = handle.close.bind(handle);
          handle.close = () => {
            closed.add(directory);
            close();
          };
          return handle;
        },
      });

      try {
        await watcher.refreshDirectories();
        await fs.rm(projectRoot, { recursive: true });

        await vi.waitFor(() => expect(closed.has(projectRoot)).toBe(true), { timeout: 10_000, interval: 25 });
        // Windows sends hundreds of thousands of events per second for a removed directory until its handle closes.
        expect(delivered).toBeLessThan(100);
      } finally {
        watcher.close();
      }
    },
  );

  it.runIf(process.platform === "win32" || process.platform === "linux")(
    "watches a directory that was removed and created again, with per-directory watches",
    async () => {
      const projectRoot = await tempRoots.create("cg-project-watcher-recreated-");
      const feature = path.join(projectRoot, "src", "feature");
      const listed = path.join(feature, "a.ts");
      await fs.mkdir(feature, { recursive: true });
      await fs.writeFile(listed, "export const a = 1;\n");
      const opened: Array<{ directory: string; closed: boolean }> = [];
      const reported: Array<{ directory: string; filename: string | null }> = [];
      const watcher = startProjectWatcher({
        root: projectRoot,
        onChange: vi.fn(),
        onSettled: vi.fn(),
        listFiles: async () => [listed],
        platform: "linux",
        watch: (directory, watchOptions, listener) => {
          const handle = fsWatch(directory, watchOptions, (eventType, filename) => {
            reported.push({ directory, filename });
            listener(eventType, filename);
          });
          const record = { directory, closed: false };
          opened.push(record);
          const close = handle.close.bind(handle);
          handle.close = () => {
            record.closed = true;
            close();
          };
          return handle;
        },
      });
      const featureWatches = (): Array<{ directory: string; closed: boolean }> =>
        opened.filter((record) => record.directory === feature);
      const timing = { timeout: 10_000, interval: 25 };

      try {
        await watcher.refreshDirectories();
        expect(featureWatches()).toHaveLength(1);

        await fs.rm(feature, { recursive: true });
        // The system sends no error for the lost watch, so the watcher has to close it from the events.
        await vi.waitFor(() => expect(featureWatches()[0]?.closed).toBe(true), timing);

        await fs.mkdir(feature);
        await vi.waitFor(() => expect(featureWatches()).toHaveLength(2), timing);
        await fs.writeFile(listed, "export const a = 2;\n");
        await vi.waitFor(
          () => expect(reported.some((event) => event.directory === feature && event.filename === "a.ts")).toBe(true),
          timing,
        );
      } finally {
        watcher.close();
      }
    },
  );

  it.runIf(process.platform === "win32" || process.platform === "linux")(
    "keeps hearing a new directory that holds only a placeholder, so that a source file and then a sibling file are reported, and the source file again after it was deleted, with per-directory watches",
    async () => {
      const projectRoot = await tempRoots.create("cg-project-watcher-placeholder-");
      const src = path.join(projectRoot, "src");
      const feature = path.join(src, "feature");
      const listed = path.join(src, "a.ts");
      const first = path.join(feature, "first.ts");
      await fs.mkdir(src);
      await fs.writeFile(listed, "export const a = 1;\n");
      const opened: string[] = [];
      const reported: Array<{ directory: string; filename: string | null }> = [];
      let files = [listed];
      const watcher = startProjectWatcher({
        root: projectRoot,
        onChange: vi.fn(),
        onSettled: vi.fn(),
        listFiles: async () => files,
        platform: "linux",
        watch: (directory, watchOptions, listener) => {
          opened.push(directory);
          return fsWatch(directory, watchOptions, (eventType, filename) => {
            reported.push({ directory, filename });
            listener(eventType, filename);
          });
        },
      });
      const heard = (filename: string): boolean =>
        reported.some((event) => event.directory === feature && event.filename === filename);
      const timing = { timeout: 10_000, interval: 25 };

      try {
        await watcher.refreshDirectories();
        await fs.mkdir(feature);
        await vi.waitFor(() => expect(opened).toContain(feature), timing);

        // No list names `feature`, because `.gitkeep` is no source file. The refresh that follows must not end its watch.
        await fs.writeFile(path.join(feature, ".gitkeep"), "");
        await vi.waitFor(() => expect(heard(".gitkeep")).toBe(true), timing);
        await watcher.refreshDirectories();

        await fs.writeFile(first, "export const first = 1;\n");
        await vi.waitFor(() => expect(heard("first.ts")).toBe(true), timing);

        // The next list names `first.ts`, and its sibling is heard as well.
        files = [listed, first];
        await watcher.refreshDirectories();
        await fs.writeFile(path.join(feature, "second.ts"), "export const second = 1;\n");
        await vi.waitFor(() => expect(heard("second.ts")).toBe(true), timing);

        // `first.ts` is deleted, so no list names `feature` any more, yet `.gitkeep` stays: so does the watch, and the
        // source file that comes back is heard.
        await fs.rm(first);
        files = [listed];
        await watcher.refreshDirectories();
        const heardBefore = reported.length;
        await fs.writeFile(first, "export const first = 2;\n");
        await vi.waitFor(
          () =>
            expect(
              reported.slice(heardBefore).some((event) => event.directory === feature && event.filename === "first.ts"),
            ).toBe(true),
          timing,
        );
      } finally {
        watcher.close();
      }
    },
  );

  it.runIf(process.platform === "win32" || process.platform === "linux")(
    "keeps hearing a directory that held the only listed source file at startup, so that a source file added after that file was deleted is reported, with per-directory watches",
    async () => {
      const projectRoot = await tempRoots.create("cg-project-watcher-startup-");
      const feature = path.join(projectRoot, "feature");
      const listed = path.join(feature, "first.ts");
      await fs.mkdir(feature);
      await fs.writeFile(listed, "export const first = 1;\n");
      await fs.writeFile(path.join(feature, ".gitkeep"), "");
      const reported: Array<{ directory: string; filename: string | null }> = [];
      let files = [listed];
      const watcher = startProjectWatcher({
        root: projectRoot,
        onChange: vi.fn(),
        onSettled: vi.fn(),
        listFiles: async () => files,
        platform: "linux",
        watch: (directory, watchOptions, listener) =>
          fsWatch(directory, watchOptions, (eventType, filename) => {
            reported.push({ directory, filename });
            listener(eventType, filename);
          }),
      });
      const heardSince = (count: number, filename: string): boolean =>
        reported.slice(count).some((event) => event.directory === feature && event.filename === filename);
      const timing = { timeout: 10_000, interval: 25 };

      try {
        await watcher.refreshDirectories();
        // The watch of `feature` was opened for the list at startup, not for an event.
        await fs.rm(listed);
        await vi.waitFor(() => expect(heardSince(0, "first.ts")).toBe(true), timing);

        // No list names `feature` any more, yet `.gitkeep` stays. The refresh must not end its watch.
        files = [];
        await watcher.refreshDirectories();
        const heardBefore = reported.length;
        await fs.writeFile(listed, "export const first = 2;\n");
        await vi.waitFor(() => expect(heardSince(heardBefore, "first.ts")).toBe(true), timing);
      } finally {
        watcher.close();
      }
    },
  );

  it("keeps the session's cached freshness result across writes to the output directories that discovery ignores", async () => {
    const projectRoot = await tempRoots.create("cg-project-watcher-ignored-");
    await fs.mkdir(path.join(projectRoot, "src"));
    await fs.writeFile(path.join(projectRoot, "src", "main.ts"), "export const value = 1;\n");
    const session = createAgentSession({
      root: projectRoot,
      buildOptions: { cache: "off" },
      freshness: { policy: "auto" },
    });
    // A recursive handle, as on Windows and macOS, reports every write under the root.
    const fake = createFakeWatch();
    const controller = createWatchController(session, {
      root: projectRoot,
      platform: "win32",
      watch: fake.watch,
      debounceMs: 60_000,
      log: vi.fn(),
      runExclusive: (operation) => operation(),
    });

    try {
      await session.loadProject({ symbolGraph: "skip" });
      const [handle] = fake.openHandles();
      // A scan builds a new result object; a cached answer returns the same one.
      const answers = new Set<AgentFreshnessResult>();

      for (const output of [
        "dist/bundle.js",
        "build\\out.js",
        "vendor/bundle/gem.rb",
        ".venv/lib/x.py",
        ".codegraph/cache/state.json",
      ]) {
        handle.emit(output);
        answers.add(await session.checkFreshness!());
      }
      expect(answers.size).toBe(1);

      handle.emit("distro/a.ts");
      answers.add(await session.checkFreshness!());
      expect(answers.size).toBe(2);
    } finally {
      await controller.close();
      session.invalidate();
    }
  });

  it("waits at close for the first read of the file list to record its file signatures, so that the release after it leaves the session empty", async () => {
    const projectRoot = await tempRoots.create("cg-project-watcher-first-read-");
    await fs.mkdir(path.join(projectRoot, "src"));
    await fs.writeFile(path.join(projectRoot, "src", "main.ts"), "export const value = 1;\n");
    const session = createAgentSession({
      root: projectRoot,
      buildOptions: { cache: "off" },
      freshness: { policy: "auto" },
    });
    const events: string[] = [];
    // The first read of the file list of a session that nothing has loaded ends by recording the size and modification
    // time of every listed file. Holding the first of those stats holds the read.
    const realStat = fs.stat.bind(fs);
    const recording = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      if (held || path.extname(String(args[0])) !== ".ts") return await realStat(...args);
      held = true;
      recording.resolve();
      await release.promise;
      const stats = await realStat(...args);
      events.push("recorded");
      return stats;
    });
    // Per-directory watches, as on Linux, are what read the file list. A server that started without warmup has loaded
    // nothing yet, so its watcher makes the first read.
    const controller = createWatchController(session, {
      root: projectRoot,
      platform: "linux",
      watch: createFakeWatch().watch,
      log: vi.fn(),
      runExclusive: (operation) => operation(),
    });

    try {
      await recording.promise;
      const closing = controller.close();
      // The read ends only after `close` was called, as when the server shuts down in the middle of it.
      release.resolve();
      await closing;
      // What the owner does after `close`.
      events.push("released");
      session.invalidate();

      // A read that ended after the release would record its file signatures into the session that was just released.
      expect(events).toEqual(["recorded", "released"]);
      // A session that holds a baseline checks the files against it. An empty one answers without a stat.
      statSpy.mockClear();
      expect(await session.checkFreshness!()).toEqual({ state: "fresh" });
      expect(statSpy).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await controller.close();
      session.invalidate();
      statSpy.mockRestore();
    }
  });
});

describe("startProjectWatcher with directories that appear", () => {
  const tempRoots = createTempRootRegistry();
  afterEach(async () => {
    await tempRoots.cleanup();
  });

  const timing = { timeout: 10_000, interval: 25 };

  // Per-directory watches over a real directory tree, with a fake `watch`, so that the test decides which events arrive.
  async function startInProject() {
    const projectRoot = await tempRoots.create("cg-project-watcher-appear-");
    const src = path.join(projectRoot, "src");
    await fs.mkdir(src);
    const listFiles = vi.fn(async () => [path.join(src, "a.ts")]);
    const started = startWatcher({ root: projectRoot, platform: "linux", listFiles });
    await started.watcher.refreshDirectories();
    return { projectRoot, src, listFiles, ...started };
  }

  it("watches a directory that a rename event reports and the directories inside it, and keeps them until they are removed", async () => {
    const { projectRoot, src, fake, watcher, onChange } = await startInProject();
    const feature = path.join(src, "feature");
    const inner = path.join(feature, "inner");
    const empty = path.join(inner, "empty");
    const reported = sorted([projectRoot, src, feature, inner, empty]);
    // A `mkdir -p` that finished before the watch on `feature` opened raised no event for `inner` or `empty`.
    await fs.mkdir(empty, { recursive: true });

    fake.deliver(src, "feature", "rename");

    await vi.waitFor(() => expect(fake.openDirectories()).toEqual(reported), timing);
    // No file list names them. `feature` and `inner` hold only a directory and `empty` holds nothing, yet a source
    // file can still arrive in any of them.
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(reported);
    expect(fake.deliver(empty, "first.ts")).toBe(1);
    expect(fake.deliver(feature, "next.ts")).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(3);

    // A removed directory loses its watch at the refresh even when the system sent no event for it.
    await fs.rm(inner, { recursive: true });
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([projectRoot, src, feature]));
    expect(fake.duplicateOpens).toEqual([]);
    watcher.close();
  });

  it("keeps the watch of a directory that holds only a placeholder, so that a source file added later is heard, and a sibling file after it, and the source file again after it was deleted", async () => {
    const { src, listFiles, fake, watcher, onChange } = await startInProject();
    const feature = path.join(src, "feature");
    const first = path.join(feature, "first.ts");
    await fs.mkdir(feature);
    fake.deliver(src, "feature", "rename");
    await vi.waitFor(() => expect(fake.openDirectories()).toContain(feature), timing);

    // `.gitkeep` is no source file, so no list names `feature`, and the directory is no longer empty.
    await fs.writeFile(path.join(feature, ".gitkeep"), "");
    expect(fake.deliver(feature, ".gitkeep", "rename")).toBe(1);
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toContain(feature);

    await fs.writeFile(first, "export const first = 1;\n");
    const changes = onChange.mock.calls.length;
    expect(fake.deliver(feature, "first.ts", "rename")).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(changes + 1);

    // The next list names `first.ts`, and a sibling file that arrives after that is heard as well.
    listFiles.mockImplementation(async () => [path.join(src, "a.ts"), first]);
    await watcher.refreshDirectories();
    expect(fake.deliver(feature, "second.ts", "rename")).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(changes + 2);

    // `first.ts` is deleted, so no list names `feature` any more, yet `.gitkeep` stays: so does the watch, and the
    // source file that comes back is heard.
    await fs.rm(first);
    listFiles.mockImplementation(async () => [path.join(src, "a.ts")]);
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toContain(feature);
    await fs.writeFile(first, "export const first = 2;\n");
    expect(fake.deliver(feature, "first.ts", "rename")).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(changes + 3);
    expect(fake.duplicateOpens).toEqual([]);
    watcher.close();
  });

  it("keeps the watches above a reported directory after the file list stops naming them, and closes the one that only it needed once it is removed", async () => {
    const projectRoot = await tempRoots.create("cg-project-watcher-above-");
    const src = path.join(projectRoot, "src");
    const old = path.join(src, "old");
    const added = path.join(old, "added");
    await fs.mkdir(old, { recursive: true });
    let files = [path.join(old, "x.ts")];
    const { fake, watcher } = startWatcher({ root: projectRoot, platform: "linux", listFiles: async () => files });
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([projectRoot, src, old]));

    await fs.mkdir(added);
    fake.deliver(old, "added", "rename");
    await vi.waitFor(() => expect(fake.openDirectories()).toContain(added), timing);

    // `x.ts` is gone, so no listed file is left. `added` keeps its watch, and so do the directories that lead to it:
    // a source file next to `added` must still be heard.
    files = [];
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([projectRoot, src, old, added]));
    expect(fake.deliver(old, "y.ts")).toBe(1);

    // A watch that failed opens again at the next refresh, because `added` still needs the directory above it.
    fake
      .openHandles()
      .find((handle) => handle.directory === old)
      ?.fail(errnoError("EIO"));
    expect(fake.openDirectories()).toEqual(sorted([projectRoot, src, added]));
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([projectRoot, src, old, added]));

    // `old` came back only because `added` needs the directory above it, so it goes with `added`. `src` is a directory
    // that a list named and that still exists, so it keeps its watch.
    await fs.rm(added, { recursive: true });
    fake.removeDirectory(added, "inotify");
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([projectRoot, src]));
    expect(fake.duplicateOpens).toEqual([]);
    watcher.close();
  });

  it("keeps the watch of a directory that the file list named at startup after its last source file was deleted, so that a source file added later is heard, and closes it once the directory is removed", async () => {
    const projectRoot = await tempRoots.create("cg-project-watcher-startup-");
    const src = path.join(projectRoot, "src");
    const lib = path.join(src, "lib");
    const other = path.join(projectRoot, "other");
    const first = path.join(lib, "first.ts");
    const remaining = path.join(other, "b.ts");
    await fs.mkdir(lib, { recursive: true });
    await fs.mkdir(other);
    await fs.writeFile(first, "export const first = 1;\n");
    await fs.writeFile(path.join(lib, ".gitkeep"), "");
    await fs.writeFile(remaining, "export const b = 1;\n");
    let files = [first, remaining];
    const { fake, watcher, onChange } = startWatcher({
      root: projectRoot,
      platform: "linux",
      listFiles: async () => files,
    });
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([projectRoot, src, lib, other]));

    // `first.ts` is deleted, so no list names `lib` or `src` any more, yet `.gitkeep` stays in `lib`. Both keep their
    // watch, and the source file that comes back is heard.
    await fs.rm(first);
    files = [remaining];
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([projectRoot, src, lib, other]));
    await fs.writeFile(first, "export const first = 2;\n");
    const changes = onChange.mock.calls.length;
    expect(fake.deliver(lib, "first.ts", "rename")).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(changes + 1);

    // Nothing keeps a directory that was removed. The one above it stays, and reports the directory when it is made again.
    await fs.rm(lib, { recursive: true });
    fake.removeDirectory(lib, "inotify");
    await watcher.refreshDirectories();
    expect(fake.openDirectories()).toEqual(sorted([projectRoot, src, other]));
    expect(fake.deliver(src, "lib", "rename")).toBe(1);
    expect(fake.duplicateOpens).toEqual([]);
    watcher.close();
  });

  it("keeps at most 128 directories that the file list stopped naming, so that a build that empties thousands of directories cannot hold thousands of watches", async () => {
    const projectRoot = await tempRoots.create("cg-project-watcher-emptied-");
    const names = Array.from({ length: 130 }, (_, index) => `emptied${index}`);
    await Promise.all(names.map((name) => fs.mkdir(path.join(projectRoot, name))));
    let files = names.map((name) => path.join(projectRoot, name, "a.ts"));
    const { fake, watcher } = startWatcher({ root: projectRoot, platform: "linux", listFiles: async () => files });
    await watcher.refreshDirectories();
    // A file list needs a watch for every directory that it names, however many there are.
    expect(fake.openHandles()).toHaveLength(1 + 130);

    // No source file is left, and every directory stays. Only 128 of them keep their watch.
    files = [];
    await watcher.refreshDirectories();
    expect(fake.openHandles()).toHaveLength(1 + 128);
    expect(fake.duplicateOpens).toEqual([]);
    watcher.close();
  });

  it("opens no watch for a file, an ignored directory, or an entry that is gone, however the events name them", async () => {
    const { projectRoot, src, fake, watcher } = await startInProject();
    const vendor = path.join(src, "vendor");
    const real = path.join(src, "real");
    await fs.writeFile(path.join(src, "file.ts"), "x\n");
    await fs.mkdir(path.join(src, "dist"));
    await fs.mkdir(path.join(vendor, "bundle"), { recursive: true });
    await fs.mkdir(real);

    for (const name of ["file.ts", "gone", "dist", "vendor"]) fake.deliver(src, name, "rename");
    await vi.waitFor(() => expect(fake.openDirectories()).toContain(vendor), timing);
    // The events are handled in order, so by the time `real` is open the ones before it were handled too.
    fake.deliver(src, "real", "rename");
    await vi.waitFor(() => expect(fake.openDirectories()).toContain(real), timing);

    // `vendor` is an ordinary directory, the `vendor/bundle` inside it is not.
    expect(fake.openDirectories()).toEqual(sorted([projectRoot, src, vendor, real]));
    watcher.close();
  });

  it("opens a recreated directory from the event that reports it, without waiting for a refresh", async () => {
    const { projectRoot, src, listFiles, fake } = await startInProject();
    const listed = listFiles.mock.calls.length;
    expect(fake.deliver(src, "a.ts")).toBe(1);

    // `rm -rf src && mkdir src`: the old watch is dropped without an error, and the process hears the rename.
    await fs.rm(src, { recursive: true });
    fake.removeDirectory(src, "inotify");
    expect(fake.openDirectories()).toEqual([projectRoot]);
    await fs.mkdir(src);
    fake.deliver(projectRoot, "src", "rename");

    await vi.waitFor(() => expect(fake.openDirectories()).toEqual(sorted([projectRoot, src])), timing);
    expect(fake.deliver(src, "a.ts")).toBe(1);
    expect(listFiles).toHaveBeenCalledTimes(listed);
    expect(fake.duplicateOpens).toEqual([]);
  });

  it("opens at most 128 watches from events, so that a build that creates thousands of directories cannot use up the inotify watches", async () => {
    const { src, fake, watcher } = await startInProject();
    const names = Array.from({ length: 140 }, (_, index) => `generated${index}`);
    await Promise.all(names.map((name) => fs.mkdir(path.join(src, name))));

    for (const name of names) fake.deliver(src, name, "rename");
    // A refresh waits for the events that are still being opened, and keeps the empty directories.
    await watcher.refreshDirectories();

    // The root, `src`, and the 128 directories that the limit let through.
    expect(fake.openHandles()).toHaveLength(2 + 128);
    watcher.close();
  });

  it("counts only the reported directories that no file list names toward the 128, so that a project that grew since then still hears new ones", async () => {
    const { src, listFiles, fake, watcher } = await startInProject();
    const names = Array.from({ length: 128 }, (_, index) => `generated${index}`);
    await Promise.all(names.map((name) => fs.mkdir(path.join(src, name))));
    for (const name of names) fake.deliver(src, name, "rename");
    await watcher.refreshDirectories();
    expect(fake.openHandles()).toHaveLength(2 + 128);

    // The next list names every one of them. It accounts for their watches now, so they no longer use up the limit.
    listFiles.mockImplementation(async () => [
      path.join(src, "a.ts"),
      ...names.map((name) => path.join(src, name, "x.ts")),
    ]);
    await watcher.refreshDirectories();
    const later = path.join(src, "later");
    await fs.mkdir(later);
    fake.deliver(src, "later", "rename");

    await vi.waitFor(() => expect(fake.openDirectories()).toContain(later), timing);
    watcher.close();
  });

  it("opens no watch inside a cache directory that was moved into the project, however the events name it", async () => {
    const projectRoot = await tempRoots.create("cg-project-watcher-cache-");
    const src = path.join(projectRoot, "src");
    const moved = path.join(projectRoot, ".moved-cache");
    const cache = path.join(moved, "project-abc");
    await fs.mkdir(src);
    const { fake, watcher } = startWatcher({
      root: projectRoot,
      platform: "linux",
      listFiles: async () => [path.join(src, "a.ts")],
      cacheDirectory: cache,
    });
    await watcher.refreshDirectories();

    // The first cache write creates the whole tree under the watch that is open, and the `mkdir -p` raises one event.
    await fs.mkdir(path.join(cache, "index-v1", "deeper"), { recursive: true });
    fake.deliver(projectRoot, ".moved-cache", "rename");
    await watcher.refreshDirectories();

    // The directory around the cache is an ordinary one that the event reported. Nothing inside the cache gets a watch.
    expect(fake.handles.map((handle) => handle.directory)).toContain(moved);
    expect(fake.handles.filter((handle) => handle.directory.startsWith(cache))).toEqual([]);
    watcher.close();
  });

  it("opens the recursive root handle again at the next refresh once the root exists, and stays quiet while it is gone", async () => {
    const projectRoot = await tempRoots.create("cg-project-watcher-root-");
    const { fake, watcher, log } = startWatcher({ root: projectRoot, platform: "win32" });

    expect(fake.removeDirectory(projectRoot, "windows")).toBe(1);
    expect(fake.openHandles()).toHaveLength(0);
    await fs.rm(projectRoot, { recursive: true });
    await watcher.refreshDirectories();
    expect(fake.handles).toHaveLength(1);

    await fs.mkdir(projectRoot);
    await watcher.refreshDirectories();

    expect(fake.openHandles().map((handle) => [handle.directory, handle.recursive])).toEqual([[projectRoot, true]]);
    expect(log).not.toHaveBeenCalled();
    watcher.close();
  });
});

describe("startProjectWatcher with a linked project root", () => {
  const tempRoots = createTempRootRegistry();
  afterEach(async () => {
    await tempRoots.cleanup();
  });

  // A project directory and a link to it: a symlink, or a junction on Windows. Nothing where the system forbids links.
  async function createLinkedProject(): Promise<{ real: string; linked: string } | undefined> {
    const real = await tempRoots.create("cg-project-watcher-link-real-");
    const parent = await tempRoots.create("cg-project-watcher-link-parent-");
    const linked = path.join(parent, "alias");
    return (await tryCreateDirectorySymlink(real, linked)) ? { real, linked } : undefined;
  }

  // One directory under two names. The events name entries relative to the root as it was given, whichever name the cache
  // directory carries.
  it.each([
    [
      "a root that is a link and a cache directory that names the project by its physical path",
      "linked",
      "real",
      false,
    ],
    ["a root that is a link and a physical cache directory that exists already", "linked", "real", true],
    ["a physical root and a cache directory that names the project through the link", "real", "linked", false],
  ] as const)(
    "ignores the subtree of a cache directory inside the project, with %s",
    async (_label, rootName, cacheName, exists) => {
      const project = await createLinkedProject();
      if (!project) return;
      const cacheDirectory = path.join(project[cacheName], ".moved-cache", "project-abc");
      if (exists) await fs.mkdir(cacheDirectory, { recursive: true });
      const { fake, watcher, onChange } = startWatcher({ root: project[rootName], cacheDirectory });
      const [handle] = fake.openHandles();

      for (const filename of [
        ".moved-cache/project-abc",
        ".moved-cache/project-abc/manifest.json",
        ".moved-cache\\project-abc\\cache\\index-v1\\search-v1.sqlite",
      ]) {
        handle.emit(filename);
      }
      expect(onChange).not.toHaveBeenCalled();

      // Paths that only start like the cache directory's are project files.
      const reported = [".moved-cache/notes.md", ".moved-cache/project-abcd/a.ts", "project-abc/a.ts"];
      for (const filename of reported) handle.emit(filename);
      expect(onChange).toHaveBeenCalledTimes(reported.length);
      watcher.close();
    },
  );

  it("opens no watch inside a cache directory that names the project by its physical path, under a root that is a link", async () => {
    const project = await createLinkedProject();
    if (!project) return;
    const moved = path.join(project.linked, ".moved-cache");
    const cache = path.join(project.real, ".moved-cache", "project-abc");
    await fs.mkdir(path.join(project.real, "src"));
    const { fake, watcher } = startWatcher({
      root: project.linked,
      platform: "linux",
      listFiles: async () => [path.join(project.linked, "src", "a.ts")],
      cacheDirectory: cache,
    });
    await watcher.refreshDirectories();

    // The first cache write creates the whole tree under the watch that is open, and the `mkdir -p` raises one event.
    await fs.mkdir(path.join(cache, "index-v1", "deeper"), { recursive: true });
    fake.deliver(project.linked, ".moved-cache", "rename");
    await watcher.refreshDirectories();

    // The directory around the cache is an ordinary one that the event reported. Nothing inside the cache gets a watch.
    expect(fake.handles.map((handle) => handle.directory)).toContain(moved);
    expect(fake.handles.filter((handle) => handle.directory.startsWith(path.join(moved, "project-abc")))).toEqual([]);
    watcher.close();
  });
});
