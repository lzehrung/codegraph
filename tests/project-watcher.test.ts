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
  type WatchControllerOptions,
} from "../src/mcp/project-watcher.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

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
  unrefCalls: number;
  emit(filename: string | null): void;
  fail(error: Error): void;
};

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
  const watch: ProjectWatchFactory = (directory, watchOptions, listener) => {
    const failure = openFailure?.(directory);
    if (failure) throw failure;
    if (openHandles().some((handle) => handle.directory === directory)) duplicateOpens.push(directory);
    const errorListeners: Array<(error: Error) => void> = [];
    const handle: FakeHandle = {
      directory,
      recursive: watchOptions.recursive,
      open: true,
      unrefCalls: 0,
      emit: (filename) => listener("change", filename),
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
  const state: { freshness: AgentFreshnessResult | Error; files: string[]; hold: Promise<void> | undefined } = {
    freshness: { state: "fresh" },
    files,
    hold: undefined,
  };
  const session: AgentSession = {
    root,
    listFiles: async () => [...state.files],
    checkFreshness: async () => {
      calls.push("checkFreshness");
      checkStarts.push(Date.now());
      await state.hold;
      if (state.freshness instanceof Error) throw state.freshness;
      return state.freshness;
    },
    loadProject: async (loadOptions) => {
      calls.push(`loadProject:${loadOptions?.symbolGraph}`);
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
  return { session, calls, checkStarts, state, count };
}

function startController(overrides: Partial<WatchControllerOptions> & { fake?: FakeWatch; files?: string[] } = {}) {
  const { fake = createFakeWatch(), files = [], ...controllerOverrides } = overrides;
  const fakeSession = createFakeSession(files);
  const log = vi.fn();
  const controller = createWatchController(fakeSession.session, {
    root,
    platform: "win32",
    watch: fake.watch,
    log,
    ...controllerOverrides,
  });
  return { fake, controller, log, ...fakeSession };
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
      null,
    ];
    for (const filename of reported) handle.emit(filename);
    expect(onChange).toHaveBeenCalledTimes(reported.length);
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
      at("..hidden", "z.ts"),
      path.join(os.tmpdir(), "cg-project-watcher-elsewhere", "outside.ts"),
    ];
    const { fake, watcher } = startWatcher({ platform: "linux", listFiles: async () => files });
    await watcher.refreshDirectories();

    // `..hidden` is an ordinary directory name, not a way out of the root.
    expect(fake.openDirectories()).toEqual(sorted([root, at("src"), at("src", "a"), at("..hidden")]));
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

  it("starts at most one refresh per interval while events keep coming for 20 seconds", async () => {
    const { fake, checkStarts, controller } = startController();
    const [handle] = fake.openHandles();

    for (let second = 0; second < 20; second += 1) {
      handle.emit("src/a.ts");
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(checkStarts).toEqual([500, 5_500, 10_500, 15_500]);
    controller.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for a burst to end before refreshing, however long it lasts", async () => {
    const { fake, checkStarts } = startController();
    const [handle] = fake.openHandles();

    for (let tick = 0; tick < 200; tick += 1) {
      handle.emit("build/out.js");
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(checkStarts).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    expect(checkStarts).toEqual([20_400]);
  });

  it("runs one more refresh after the current one when bursts settle during it", async () => {
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

    release.resolve();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(checkStarts).toEqual([500]);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkStarts).toEqual([500, 5_500]);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(checkStarts).toEqual([500, 5_500]);
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

  it("cancels a pending debounce and a rate-limited refresh when it pauses", async () => {
    const { fake, checkStarts } = startController({ idleMs: 3_000 });
    const [handle] = fake.openHandles();

    handle.emit("src/a.ts");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(checkStarts).toEqual([500]);
    // This burst settles at 1_500 and then waits for the 5 s floor, until 5_500.
    handle.emit("src/b.ts");
    await vi.advanceTimersByTimeAsync(1_800);
    // This one is still debouncing at 2_800, when the idle time is about to run out at 3_000.
    handle.emit("src/c.ts");
    expect(vi.getTimerCount()).toBe(3);
    await vi.advanceTimersByTimeAsync(200);

    expect(fake.openHandles()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkStarts).toEqual([500]);
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

    controller.close();
    controller.close();

    expect(fake.openHandles()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    controller.noteActivity();
    expect(fake.handles).toHaveLength(1);
    expect(count("markChanged")).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
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
});
