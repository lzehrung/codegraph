import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../src/agent/session.js";
import { CODEGRAPH_CONFIG_FILE } from "../src/config.js";
import { projectCacheNamespace, resolveCacheLocation } from "../src/indexer/build-cache/location.js";
import type { BuildOptions, BuildReport } from "../src/indexer/types.js";
import {
  getCodegraphLifecycleStatus,
  initCodegraphLifecycle,
  syncCodegraphLifecycle,
  type CodegraphLifecycleSyncResult,
} from "../src/lifecycle/manifest.js";
import { resolveNativeWorkerPath } from "../src/worker/native-worker-pool.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tempRoots = createTempRootRegistry();

async function createGitProject(atGitRoot = false): Promise<{ repository: string; root: string }> {
  const repository = await tempRoots.create("cg-life-cache-anchor-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository, windowsHide: true });
  const root = atGitRoot ? repository : path.join(repository, "sub");
  await fsp.mkdir(path.join(root, "src"), { recursive: true });
  await fsp.writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
  if (!atGitRoot) {
    await fsp.writeFile(path.join(repository, "outside.ts"), "export const outside = 2;\n", "utf8");
  }
  return { repository, root };
}

async function loadProject(root: string, buildOptions: BuildOptions = {}) {
  const session = createAgentSession({ root, buildOptions: { ...buildOptions, cache: "disk" } });
  try {
    return await session.loadProject({ symbolGraph: "skip" });
  } finally {
    session.invalidate();
  }
}

function expectWarmBuild(report: BuildReport): void {
  expect(report.files?.cached).toBeGreaterThanOrEqual(1);
  expect(report.files?.parsed).toBe(0);
}

async function expectCurrentStatus(root: string, buildOptions: BuildOptions = {}): Promise<void> {
  expect(await getCodegraphLifecycleStatus(root, { buildOptions })).toMatchObject({
    initialized: true,
    configChanged: false,
    buildOptionsChanged: false,
    filesChanged: false,
    suggestedNextCommand: "codegraph status",
  });
}

async function expectNoParentCache(repository: string): Promise<void> {
  await expect(fsp.stat(path.join(repository, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
}

async function runCli(repository: string, args: string[]): Promise<string> {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repository,
    windowsHide: true,
  });
  expect(result.stderr).not.toContain("[Progress]");
  return result.stdout;
}

describe("lifecycle cache anchoring", () => {
  beforeEach(async () => {
    const environment = await tempRoots.create("cg-life-cache-environment-");
    vi.stubEnv("CODEGRAPH_CACHE_DIR", "");
    vi.stubEnv("APPDATA", path.join(environment, "config"));
    vi.stubEnv("XDG_CONFIG_HOME", path.join(environment, "config"));
    vi.stubEnv("LOCALAPPDATA", path.join(environment, "cache"));
    vi.stubEnv("XDG_CACHE_HOME", path.join(environment, "cache"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await tempRoots.cleanup();
  });

  it.each(["init", "sync --init"] as const)(
    "%s warms the subproject cache reused by status, sync, and a new library session",
    async (command) => {
      const { repository, root } = await createGitProject();
      const initialReport: BuildReport = { timings: {} };
      const options = { buildOptions: { report: initialReport } };
      const initialized =
        command === "init"
          ? await initCodegraphLifecycle(root, options)
          : await syncCodegraphLifecycle(root, { ...options, init: true });
      const cachePath = path.join(root, ".codegraph", "cache", "index-v1");

      expect(initialReport.files).toMatchObject({ total: 1, parsed: 1, cached: 0 });
      expect(initialized.manifest.files).toEqual(["src/a.ts"]);
      expect((await fsp.readdir(cachePath)).length).toBeGreaterThan(0);
      expect(resolveCacheLocation(root).path).toBe(cachePath);
      await expectNoParentCache(repository);
      await expectCurrentStatus(root);

      const syncReport: BuildReport = { timings: {} };
      const synced = await syncCodegraphLifecycle(root, { buildOptions: { report: syncReport } });
      expectWarmBuild(syncReport);
      expect(synced.manifest.buildOptionsHash).toBe(initialized.manifest.buildOptionsHash);
      expect(synced.changedFiles).toEqual({ added: 0, removed: 0, totalDelta: 0 });

      const queryReport: BuildReport = { timings: {} };
      const snapshot = await loadProject(root, { report: queryReport });
      expectWarmBuild(queryReport);
      const files = snapshot.files.map((file) => path.resolve(file));
      expect(files).toEqual([path.join(root, "src/a.ts")]);
      expect(files).not.toContain(path.join(repository, "outside.ts"));
      expect(path.resolve(snapshot.index.cacheRootDir ?? "")).toBe(cachePath);
      await expectCurrentStatus(root);
      await expectNoParentCache(repository);
    },
  );

  it.each([undefined, "repo"])("keeps the Git-root cache path with cacheLocation %s", async (cacheLocation) => {
    const { root } = await createGitProject(true);
    const buildOptions: BuildOptions = cacheLocation ? { cacheLocation } : {};
    const before = resolveCacheLocation(root, buildOptions).path;
    await initCodegraphLifecycle(root, { buildOptions });

    expect(resolveCacheLocation(root, buildOptions).path).toBe(before);
    expect((await fsp.readdir(before)).length).toBeGreaterThan(0);
    const report: BuildReport = { timings: {} };
    await syncCodegraphLifecycle(root, { buildOptions: { ...buildOptions, report } });
    expectWarmBuild(report);
    await expectCurrentStatus(root, buildOptions);
  });

  it.each([
    "cache-dir",
    "environment",
    "project",
    "user",
    "absolute",
    "config-project",
    "config-user",
    "config-absolute",
  ] as const)("preserves the configured %s cache path and option identity", async (setting) => {
    const { repository, root } = await createGitProject();
    const target = path.join(repository, "cache-target");
    const buildOptions: BuildOptions = {};
    let effectiveOptions = buildOptions;
    if (setting === "cache-dir") {
      buildOptions.cacheDir = target;
    } else if (setting === "environment") {
      vi.stubEnv("CODEGRAPH_CACHE_DIR", target);
    } else if (setting.startsWith("config-")) {
      const configured = setting.slice("config-".length);
      const cacheLocation = configured === "absolute" ? target : configured;
      await fsp.writeFile(
        path.join(root, CODEGRAPH_CONFIG_FILE),
        JSON.stringify({ cache: { location: cacheLocation } }),
      );
      effectiveOptions = { cacheLocation };
    } else {
      buildOptions.cacheLocation = setting === "absolute" ? target : setting;
    }
    const before = resolveCacheLocation(root, effectiveOptions).path;
    const initialized = await initCodegraphLifecycle(root, { buildOptions });

    expect(resolveCacheLocation(root, effectiveOptions).path).toBe(before);
    expect((await fsp.readdir(before)).length).toBeGreaterThan(0);
    await expectNoParentCache(repository);
    await expectCurrentStatus(root, buildOptions);
    const report: BuildReport = { timings: {} };
    const synced = await syncCodegraphLifecycle(root, { buildOptions: { ...buildOptions, report } });
    expectWarmBuild(report);
    expect(synced.manifest.buildOptionsHash).toBe(initialized.manifest.buildOptionsHash);
  });

  it.each(["option", "config"] as const)(
    "keeps the repo setting's manifest-relative namespace when selected by %s",
    async (setting) => {
      const { repository, root } = await createGitProject();
      const buildOptions: BuildOptions = {};
      if (setting === "option") {
        buildOptions.cacheLocation = "repo";
      } else {
        await fsp.writeFile(path.join(root, CODEGRAPH_CONFIG_FILE), JSON.stringify({ cache: { location: "repo" } }));
      }
      const expected = path.join(root, ".codegraph", "cache", "index-v1", projectCacheNamespace(root, root));
      await initCodegraphLifecycle(root, { buildOptions });

      expect(resolveCacheLocation(root, { cacheLocation: "repo" }).path).toBe(expected);
      expect((await fsp.readdir(expected)).length).toBeGreaterThan(0);
      await expectNoParentCache(repository);
      const report: BuildReport = { timings: {} };
      await syncCodegraphLifecycle(root, { buildOptions: { ...buildOptions, report } });
      expectWarmBuild(report);
      await expectCurrentStatus(root, buildOptions);
    },
  );

  it("keeps an initialized subproject's path and idempotent manifest", async () => {
    const { repository, root } = await createGitProject();
    const first = await initCodegraphLifecycle(root);
    const before = resolveCacheLocation(root).path;
    const second = await initCodegraphLifecycle(root);
    expect(second.manifest).toEqual(first.manifest);
    expect(resolveCacheLocation(root).path).toBe(before);

    const report: BuildReport = { timings: {} };
    const forced = await initCodegraphLifecycle(root, { force: true, buildOptions: { report } });
    expectWarmBuild(report);
    expect(forced.manifest.buildOptionsHash).toBe(first.manifest.buildOptionsHash);
    expect(resolveCacheLocation(root).path).toBe(before);
    await expectCurrentStatus(root);
    await expectNoParentCache(repository);
  });

  it("warms a subproject independently of its initialized parent's cache", async () => {
    const { repository, root } = await createGitProject();
    await initCodegraphLifecycle(repository);
    const parentCache = resolveCacheLocation(repository).path;
    const parentManifestPath = path.join(repository, ".codegraph", "manifest.json");
    const parentManifest = await fsp.readFile(parentManifestPath);
    const parentEntries = (await fsp.readdir(parentCache, { recursive: true })).sort();
    const parentArtifacts = new Map<string, Buffer>();
    for (const entry of await fsp.readdir(parentCache, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      parentArtifacts.set(file, await fsp.readFile(file));
    }
    expect(parentArtifacts.size).toBeGreaterThan(0);

    const initialized = await initCodegraphLifecycle(root);

    expect(initialized.manifest.files).toEqual(["src/a.ts"]);
    expect(resolveCacheLocation(root).path).toBe(path.join(root, ".codegraph", "cache", "index-v1"));
    expect(await fsp.readFile(parentManifestPath)).toEqual(parentManifest);
    expect((await fsp.readdir(parentCache, { recursive: true })).sort()).toEqual(parentEntries);
    for (const [file, contents] of parentArtifacts) {
      expect(await fsp.readFile(file)).toEqual(contents);
    }
    const report: BuildReport = { timings: {} };
    const snapshot = await loadProject(root, { report });
    expectWarmBuild(report);
    expect(snapshot.files.map((file) => path.resolve(file))).toEqual([path.join(root, "src/a.ts")]);
    expect(snapshot.files.map((file) => path.resolve(file))).not.toContain(path.join(repository, "outside.ts"));
    await expectCurrentStatus(root);
  });

  it("CLI init --force replaces a corrupt manifest without changing the warmed subproject anchor", async () => {
    const { repository, root } = await createGitProject();
    await fsp.mkdir(path.join(root, ".codegraph"), { recursive: true });
    await fsp.writeFile(path.join(root, ".codegraph", "manifest.json"), "{invalid JSON\n", "utf8");

    const initialized = JSON.parse(
      await runCli(repository, ["init", "sub", "--force", "--json", "--no-progress"]),
    ) as CodegraphLifecycleSyncResult;

    expect(initialized.manifest.files).toEqual(["src/a.ts"]);
    const cachePath = path.join(root, ".codegraph", "cache", "index-v1");
    expect(resolveCacheLocation(root).path).toBe(cachePath);
    expect((await fsp.readdir(cachePath)).length).toBeGreaterThan(0);
    const report: BuildReport = { timings: {} };
    await loadProject(root, { report });
    expectWarmBuild(report);
    await expectCurrentStatus(root);
    await expectNoParentCache(repository);
  });

  it("a native-worker initialization warms the same subproject anchor for the next session", async () => {
    expect(resolveNativeWorkerPath()).toBe(
      fileURLToPath(new URL("../dist/worker/native-extract-worker.js", import.meta.url)),
    );
    const { repository, root } = await createGitProject();
    const initialReport: BuildReport = { timings: {} };
    const buildOptions: BuildOptions = { useNativeWorkers: true, nativeThreads: 1 };
    await initCodegraphLifecycle(root, { buildOptions: { ...buildOptions, report: initialReport } });

    expect(initialReport.workerPool).toMatchObject({
      enabled: true,
      threads: 1,
      tasksSubmitted: 1,
      tasksFailed: 0,
    });
    expect(initialReport.files).toMatchObject({ total: 1, parsed: 1, cached: 0 });
    const cachePath = path.join(root, ".codegraph", "cache", "index-v1");
    expect(resolveCacheLocation(root).path).toBe(cachePath);
    expect((await fsp.readdir(cachePath)).length).toBeGreaterThan(0);
    const report: BuildReport = { timings: {} };
    const snapshot = await loadProject(root, { ...buildOptions, report });
    expectWarmBuild(report);
    expect(report.workerPool?.tasksSubmitted ?? 0).toBe(0);
    expect(snapshot.files.map((file) => path.resolve(file))).toEqual([path.join(root, "src/a.ts")]);
    expect(path.resolve(snapshot.index.cacheRootDir ?? "")).toBe(cachePath);
    await expectCurrentStatus(root, buildOptions);
    await expectNoParentCache(repository);
  });

  it("leaves existing repository caches in place and keeps non-lifecycle anchor selection", async () => {
    const { repository, root } = await createGitProject();
    const previous = resolveCacheLocation(root).path;
    expect(previous).toBe(
      path.join(repository, ".codegraph", "cache", "index-v1", projectCacheNamespace(root, repository)),
    );
    const snapshot = await loadProject(root);
    expect(path.resolve(snapshot.index.cacheRootDir ?? "")).toBe(previous);
    const sentinel = path.join(previous, "keep.txt");
    await fsp.writeFile(sentinel, "existing cache\n", "utf8");
    const entries = await fsp.readdir(previous);

    await initCodegraphLifecycle(root);

    expect(await fsp.readdir(previous)).toEqual(entries);
    expect(await fsp.readFile(sentinel, "utf8")).toBe("existing cache\n");
    expect(resolveCacheLocation(root).path).toBe(path.join(root, ".codegraph", "cache", "index-v1"));
    const report: BuildReport = { timings: {} };
    await loadProject(root, { report });
    expectWarmBuild(report);
    await expectCurrentStatus(root);
  });

  it.each(["init", "sync --init"] as const)(
    "the built CLI %s warms the next query without a parent cache or status drift",
    async (command) => {
      const { repository, root } = await createGitProject();
      const initializeArgs = command === "init" ? ["init", "sub"] : ["sync", "sub", "--init"];
      const initialized = JSON.parse(
        await runCli(repository, [...initializeArgs, "--json", "--no-progress"]),
      ) as CodegraphLifecycleSyncResult;
      expect(initialized.manifest.files).toEqual(["src/a.ts"]);
      expect((await fsp.readdir(path.join(root, ".codegraph", "cache", "index-v1"))).length).toBeGreaterThan(0);
      await expectNoParentCache(repository);

      const reportPath = path.join(repository, "query-report.json");
      const query = JSON.parse(
        await runCli(repository, [
          "orient",
          "--root",
          "sub",
          "--budget",
          "small",
          "--json",
          "--no-progress",
          "--report-file",
          reportPath,
        ]),
      ) as { root: string };
      expect(query.root).toBe(root);
      const report = JSON.parse(await fsp.readFile(reportPath, "utf8")) as { index: BuildReport };
      expectWarmBuild(report.index);
      const synced = JSON.parse(
        await runCli(repository, ["sync", "sub", "--json", "--no-progress"]),
      ) as CodegraphLifecycleSyncResult;
      expect(synced.manifest.buildOptionsHash).toBe(initialized.manifest.buildOptionsHash);
      expect(JSON.parse(await runCli(repository, ["status", "sub", "--json"]))).toMatchObject({
        root,
        initialized: true,
        configChanged: false,
        buildOptionsChanged: false,
        filesChanged: false,
      });
      await expectNoParentCache(repository);
    },
    30_000,
  );
});
