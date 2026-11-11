import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codegraphLifecycleManifestPath,
  CodegraphLifecycleUserError,
  getCodegraphLifecycleStatus,
  initCodegraphLifecycle,
  stableStringify,
  syncCodegraphLifecycle,
  uninitCodegraphLifecycle,
  type CodegraphLifecycleManifest,
  type CodegraphLifecycleStatus,
  type CodegraphLifecycleSyncResult,
  type CodegraphLifecycleUninitResult,
} from "../src/lifecycle/manifest.js";
import { discoverCodegraphLifecycleRoot, resolveCliRootPolicy } from "../src/cli/root-policy.js";
import * as indexerManifest from "../src/indexer/build-cache/manifest.js";
import { resolveCacheLocation } from "../src/indexer/build-cache/location.js";
import * as agentSession from "../src/agent/session.js";
import type { AgentProjectSnapshot, AgentSession } from "../src/agent/session.js";
import type { BuildOptions } from "../src/indexer/types.js";
import { captureCli } from "./helpers/cli.js";
import { mkTmpDir, tryCreateFileSymlink } from "./helpers/filesystem.js";
import { CODEGRAPH_CONFIG_FILE } from "../src/config.js";
import fs, { type PathLike } from "node:fs";
import {
  isFileIdentityCaseInsensitive,
  resetFileIdentityCaseSensitivityForTests,
  setFileIdentityCaseInsensitive,
} from "../src/util/paths.js";

const execFileAsync = promisify(execFile);

async function initializeGitRepository(root: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet"], { windowsHide: true, cwd: root });
  await execFileAsync("git", ["config", "user.email", "codegraph-tests@example.com"], { windowsHide: true, cwd: root });
  await execFileAsync("git", ["config", "user.name", "Codegraph Tests"], { windowsHide: true, cwd: root });
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, "utf8");
}

async function readManifest(root: string): Promise<CodegraphLifecycleManifest> {
  const raw = await fsp.readFile(codegraphLifecycleManifestPath(root), "utf8");
  return JSON.parse(raw) as CodegraphLifecycleManifest;
}

async function readCodegraphEntries(root: string): Promise<string[]> {
  return (await fsp.readdir(path.join(root, ".codegraph"))).filter((entry) => entry !== "cache").sort();
}

async function expectDiskIndexCacheHasArtifacts(root: string): Promise<void> {
  const cacheRoot = path.join(root, ".codegraph", "cache", "index-v1");
  const stats = await fsp.stat(cacheRoot);
  expect(stats.isDirectory()).toBeTruthy();
  const entries = await fsp.readdir(cacheRoot);
  expect(entries.length).toBeGreaterThan(0);
}

function lifecycleSnapshot(
  root: string,
  files: string[],
  manifestEntries: Map<string, { sig: string }>,
  manifestSignaturesFresh?: boolean,
): AgentProjectSnapshot {
  const index = {
    graph: { nodes: new Set(files), edges: [] },
    modules: new Map(),
    byFile: new Map(),
    exportCache: new Map(),
    scopeCache: new Map(),
    manifestEntries,
  } as AgentProjectSnapshot["index"];
  if (manifestSignaturesFresh !== undefined) index.manifestSignaturesFresh = manifestSignaturesFresh;
  return {
    root,
    files,
    index,
    fileGraph: index.graph,
    symbolGraph: { nodes: new Map(), edges: [] },
    analysis: {
      mode: "semantic",
      backend: "native",
      parserDegradedFiles: 0,
      nativeFilesUsed: 0,
      nativeFilesFellBack: 0,
      label: "native semantic",
    },
  };
}

function lifecycleSession(snapshot: AgentProjectSnapshot): AgentSession {
  return {
    root: snapshot.root,
    loadProject: async () => snapshot,
    invalidate: () => undefined,
  };
}

describe("project lifecycle commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("init creates a manifest and is idempotent when current", async () => {
    const root = await mkTmpDir("cg-life-init-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");

    const first = await initCodegraphLifecycle(root);
    const second = await initCodegraphLifecycle(root);

    expect(first.manifest.fileCount).toBe(1);
    expect(second.changedFiles.totalDelta).toBe(0);
    expect(await readManifest(root)).toEqual(first.manifest);
    expect(await readCodegraphEntries(root)).toEqual(["manifest.json"]);
  });
  it("init reuses fresh index mtime and size signatures without statting each file", async () => {
    const root = await mkTmpDir("cg-life-index-signatures-");
    const file = path.join(root, "src/main.ts");
    await writeFile(root, "src/main.ts", "ignored\n");
    const snapshot = lifecycleSnapshot(root, [file], new Map([[file, { sig: "123.5:7" }]]), true);
    const sessionSpy = vi.spyOn(agentSession, "createAgentSession").mockReturnValue(lifecycleSession(snapshot));
    const statSpy = vi.spyOn(fsp, "stat");

    const result = await initCodegraphLifecycle(root, { updateGitignore: false });

    const expectedHash = createHash("sha256")
      .update("src/main.ts\0".concat("7", "\0", "123.5", "\0"))
      .digest("hex");
    expect(result.manifest.fileSignatureHash).toBe(expectedHash);
    expect(sessionSpy).toHaveBeenCalledOnce();
    expect(
      statSpy.mock.calls.some(([candidate]) => path.resolve(String(candidate)) === path.resolve(file)),
    ).toBeFalsy();
  });

  it("init falls back to file stats for the index signature failure sentinel", async () => {
    const root = await mkTmpDir("cg-life-index-signature-sentinel-");
    const file = path.join(root, "src/main.ts");
    await writeFile(root, "src/main.ts", "ignored\n");
    const snapshot = lifecycleSnapshot(root, [file], new Map([[file, { sig: "0:0" }]]), true);
    vi.spyOn(agentSession, "createAgentSession").mockReturnValue(lifecycleSession(snapshot));
    const statSpy = vi.spyOn(fsp, "stat");

    await initCodegraphLifecycle(root, { updateGitignore: false });

    expect(
      statSpy.mock.calls.some(([candidate]) => path.resolve(String(candidate)) === path.resolve(file)),
    ).toBeTruthy();
  });

  it("init falls back to file stats when an index signature is incomplete and status detects edits", async () => {
    const root = await mkTmpDir("cg-life-index-signature-fallback-");
    const file = path.join(root, "src/main.ts");
    await writeFile(root, "src/main.ts", "export const value = 1;\n");
    const snapshot = lifecycleSnapshot(root, [file], new Map(), true);
    vi.spyOn(agentSession, "createAgentSession").mockReturnValue(lifecycleSession(snapshot));

    await initCodegraphLifecycle(root, { updateGitignore: false });
    await writeFile(root, "src/main.ts", "export const value = 2;\n");

    const status = await getCodegraphLifecycleStatus(root);

    expect(status.filesChanged).toBeTruthy();
  });

  it("init uses file stats for an old index without fresh manifest signatures", async () => {
    const root = await mkTmpDir("cg-life-old-index-signatures-");
    const file = path.join(root, "src/main.ts");
    await writeFile(root, "src/main.ts", "ignored\n");
    const snapshot = lifecycleSnapshot(root, [file], new Map([[file, { sig: "123.5:7" }]]));
    vi.spyOn(agentSession, "createAgentSession").mockReturnValue(lifecycleSession(snapshot));
    const statSpy = vi.spyOn(fsp, "stat");

    await initCodegraphLifecycle(root, { updateGitignore: false });

    expect(
      statSpy.mock.calls.some(([candidate]) => path.resolve(String(candidate)) === path.resolve(file)),
    ).toBeTruthy();
  });

  it("init appends only the consolidated Codegraph ignore rule while preserving file bytes, newline style, and permissions", async () => {
    const cases = [
      { name: "missing", initial: null, expected: ".codegraph/\n" },
      { name: "LF", initial: "node_modules/\n", expected: "node_modules/\n.codegraph/\n" },
      { name: "no-final-newline", initial: "node_modules/", expected: "node_modules/\n.codegraph/\n" },
      { name: "CRLF", initial: "node_modules/\r\n", expected: "node_modules/\r\n.codegraph/\r\n" },
    ] as const;

    for (const testCase of cases) {
      const root = await mkTmpDir(`cg-life-gitignore-${testCase.name}-`);
      await initializeGitRepository(root);
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      if (testCase.initial !== null) {
        await writeFile(root, ".gitignore", testCase.initial);
        await fsp.chmod(path.join(root, ".gitignore"), 0o640);
      }

      const first = await initCodegraphLifecycle(root);
      const second = await initCodegraphLifecycle(root);

      expect(first.gitignore).toEqual({ status: "added", path: ".gitignore", rules: [".codegraph/"] });
      expect(second.gitignore).toEqual({ status: "already-ignored", path: ".gitignore", rules: [".codegraph/"] });
      expect(await fsp.readFile(path.join(root, ".gitignore"), "utf8")).toBe(testCase.expected);
      if (testCase.initial !== null && process.platform !== "win32") {
        expect((await fsp.stat(path.join(root, ".gitignore"))).mode & 0o777).toBe(0o640);
      }
      expect(await readCodegraphEntries(root)).toEqual(["manifest.json"]);
    }
  });

  it("adds the consolidated rule unless both lifecycle manifest and cache are effectively ignored", async () => {
    const cases = [
      {
        name: "manifest-and-cache",
        policyPath: ".git/info/exclude",
        policy: ".codegraph/\n",
        expectedGitignore: null,
        status: "already-ignored",
      },
      {
        name: "manifest-only",
        policyPath: ".gitignore",
        policy: ".codegraph/manifest.json\n",
        expectedGitignore: ".codegraph/manifest.json\n.codegraph/\n",
        status: "added",
      },
      {
        name: "cache-only",
        policyPath: ".git/info/exclude",
        policy: ".codegraph/cache/\n",
        expectedGitignore: ".codegraph/\n",
        status: "added",
      },
      {
        name: "neither",
        policyPath: ".gitignore",
        policy: "",
        expectedGitignore: ".codegraph/\n",
        status: "added",
      },
    ] as const;

    for (const testCase of cases) {
      const root = await mkTmpDir(`cg-life-effective-ignore-${testCase.name}-`);
      await initializeGitRepository(root);
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      await writeFile(root, testCase.policyPath, testCase.policy);

      const result = await initCodegraphLifecycle(root);

      expect(result.gitignore).toEqual({
        status: testCase.status,
        path: ".gitignore",
        rules: [".codegraph/"],
      });
      if (testCase.expectedGitignore === null) {
        await expect(fsp.stat(path.join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await fsp.readFile(path.join(root, ".gitignore"), "utf8")).toBe(testCase.expectedGitignore);
      }
    }
  });

  it("adds the consolidated rule when only a legacy cache rule exists", async () => {
    for (const legacyRule of [".codegraph-cache/\n", "/.codegraph-cache/\n"]) {
      const root = await mkTmpDir("cg-life-legacy-ignore-");
      await initializeGitRepository(root);
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      await writeFile(root, ".gitignore", legacyRule);

      const result = await initCodegraphLifecycle(root);

      expect(result.gitignore).toEqual({ status: "added", path: ".gitignore", rules: [".codegraph/"] });
      expect(await fsp.readFile(path.join(root, ".gitignore"), "utf8")).toBe(`${legacyRule}.codegraph/\n`);
    }
  });

  it("init appends after an effective negation and refreshes a previously current unignored manifest", async () => {
    const root = await mkTmpDir("cg-life-gitignore-negation-");
    await initializeGitRepository(root);
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    const negatedPolicy = ".codegraph/\n!.codegraph/\n!.codegraph/manifest.json\n";
    await writeFile(root, ".gitignore", negatedPolicy);
    const before = await initCodegraphLifecycle(root, { updateGitignore: false });
    expect((await getCodegraphLifecycleStatus(root)).configChanged).toBeFalsy();

    const refreshed = await initCodegraphLifecycle(root);
    const status = await getCodegraphLifecycleStatus(root);

    expect(refreshed.gitignore).toEqual({
      status: "added",
      path: ".gitignore",
      rules: [".codegraph/"],
    });
    expect(refreshed.manifest.configHash).not.toBe(before.manifest.configHash);
    expect(await fsp.readFile(path.join(root, ".gitignore"), "utf8")).toBe(`${negatedPolicy}.codegraph/\n`);
    expect(status.configChanged).toBeFalsy();
    expect(status.suggestedNextCommand).toBe("codegraph status");
  });

  it("init is non-fatal outside Git and supports an explicit ignore-policy opt-out", async () => {
    const nonGitRoot = await mkTmpDir("cg-life-gitignore-non-git-");
    await writeFile(nonGitRoot, "src/main.ts", "export const main = 1;\n");
    const nonGit = await initCodegraphLifecycle(nonGitRoot);
    expect(nonGit.gitignore).toEqual({ status: "not-git", path: ".gitignore" });
    await expect(fsp.stat(path.join(nonGitRoot, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });

    const disabledRoot = await mkTmpDir("cg-life-gitignore-disabled-");
    await initializeGitRepository(disabledRoot);
    await writeFile(disabledRoot, "src/main.ts", "export const main = 1;\n");
    const disabled = await initCodegraphLifecycle(disabledRoot, { updateGitignore: false });
    expect(disabled.gitignore).toEqual({ status: "disabled", path: ".gitignore" });
    await expect(fsp.stat(path.join(disabledRoot, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sync --init prepares ignore policy once, while ordinary sync never changes it", async () => {
    const initializedRoot = await mkTmpDir("cg-life-sync-init-gitignore-");
    await initializeGitRepository(initializedRoot);
    await writeFile(initializedRoot, "src/main.ts", "export const main = 1;\n");
    const initialized = await syncCodegraphLifecycle(initializedRoot, { init: true });
    expect(initialized.gitignore).toEqual({
      status: "added",
      path: ".gitignore",
      rules: [".codegraph/"],
    });
    expect(await fsp.readFile(path.join(initializedRoot, ".gitignore"), "utf8")).toBe(".codegraph/\n");

    const disabledRoot = await mkTmpDir("cg-life-sync-init-gitignore-disabled-");
    await initializeGitRepository(disabledRoot);
    await writeFile(disabledRoot, "src/main.ts", "export const main = 1;\n");
    const disabled = await syncCodegraphLifecycle(disabledRoot, { init: true, updateGitignore: false });
    expect(disabled.gitignore).toEqual({ status: "disabled", path: ".gitignore" });
    await writeFile(disabledRoot, ".gitignore", "operator-policy\n");

    const ordinary = await syncCodegraphLifecycle(disabledRoot, { updateGitignore: true });
    expect(ordinary.gitignore).toBeUndefined();
    expect(await fsp.readFile(path.join(disabledRoot, ".gitignore"), "utf8")).toBe("operator-policy\n");
  });

  it("leaves a tracked lifecycle manifest and Git policy unchanged", async () => {
    const root = await mkTmpDir("cg-life-gitignore-tracked-");
    await initializeGitRepository(root);
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root, { updateGitignore: false });
    await execFileAsync("git", ["add", "--", ".codegraph/manifest.json"], { windowsHide: true, cwd: root });
    const result = await initCodegraphLifecycle(root);

    expect(result.gitignore).toEqual({ status: "tracked", path: ".gitignore" });
    await expect(fsp.stat(path.join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
    const { stdout } = await execFileAsync("git", ["ls-files", "--", ".codegraph/manifest.json"], {
      windowsHide: true,
      cwd: root,
    });
    expect(stdout.trim()).toBe(".codegraph/manifest.json");
  });

  it("rejects directory and symlink .gitignore paths before creating a manifest", async () => {
    for (const kind of ["directory", "symbolic link"] as const) {
      const root = await mkTmpDir(`cg-life-gitignore-${kind.replace(" ", "-")}-`);
      await initializeGitRepository(root);
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      const gitignorePath = path.join(root, ".gitignore");
      if (kind === "directory") {
        await fsp.mkdir(gitignorePath);
      } else {
        await writeFile(root, "ignore-target", "operator policy\n");
        try {
          await fsp.symlink("ignore-target", gitignorePath);
        } catch (error) {
          if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
            continue;
          }
          throw error;
        }
      }

      await expect(initCodegraphLifecycle(root)).rejects.toThrow(CodegraphLifecycleUserError);
      await expect(initCodegraphLifecycle(root)).rejects.toThrow(kind);
      await expect(fsp.stat(codegraphLifecycleManifestPath(root))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("wraps .gitignore read failures as actionable lifecycle errors before manifest creation", async () => {
    const root = await mkTmpDir("cg-life-gitignore-read-error-");
    await initializeGitRepository(root);
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await writeFile(root, ".gitignore", "operator-policy\n");
    const gitignorePath = path.join(root, ".gitignore");
    const originalReadFile = fsp.readFile.bind(fsp);
    vi.spyOn(fsp, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath === gitignorePath) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return await originalReadFile(filePath, options as never);
    });

    await expect(initCodegraphLifecycle(root)).rejects.toThrow(CodegraphLifecycleUserError);
    await expect(initCodegraphLifecycle(root)).rejects.toThrow(
      `Unable to read ${gitignorePath}: permission denied. Check file permissions or rerun with --no-update-gitignore.`,
    );
    await expect(fsp.stat(codegraphLifecycleManifestPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wraps .gitignore write failures as actionable lifecycle errors before manifest creation", async () => {
    const root = await mkTmpDir("cg-life-gitignore-write-error-");
    await initializeGitRepository(root);
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    const gitignorePath = path.join(root, ".gitignore");
    vi.spyOn(fsp, "appendFile").mockImplementation(async (filePath) => {
      if (filePath === gitignorePath) {
        throw Object.assign(new Error("read-only filesystem"), { code: "EROFS" });
      }
    });

    await expect(initCodegraphLifecycle(root)).rejects.toThrow(CodegraphLifecycleUserError);
    await expect(initCodegraphLifecycle(root)).rejects.toThrow(
      `Unable to update ${gitignorePath}: read-only filesystem. Check file permissions or rerun with --no-update-gitignore.`,
    );
    await expect(fsp.stat(codegraphLifecycleManifestPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uninit removes lifecycle state but leaves the appended root ignore rule", async () => {
    const root = await mkTmpDir("cg-life-uninit-gitignore-");
    await initializeGitRepository(root);
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    const first = await initCodegraphLifecycle(root);
    const status = await getCodegraphLifecycleStatus(root);
    const repeated = await initCodegraphLifecycle(root);
    const { stdout: gitStatus } = await execFileAsync("git", ["status", "--short", "--untracked-files=all"], {
      windowsHide: true,
      cwd: root,
    });
    const rules = (await fsp.readFile(path.join(root, ".gitignore"), "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line === ".codegraph/");

    expect(first.gitignore?.status).toBe("added");
    expect(repeated.gitignore?.status).toBe("already-ignored");
    expect(rules).toHaveLength(1);
    expect(gitStatus).not.toContain(".codegraph/");
    expect(status.configChanged).toBeFalsy();
    expect(status.buildOptionsChanged).toBeFalsy();
    expect(status.filesChanged).toBeFalsy();
    expect(status.suggestedNextCommand).toBe("codegraph status");

    await uninitCodegraphLifecycle(root);

    expect(await fsp.readFile(path.join(root, ".gitignore"), "utf8")).toBe(".codegraph/\n");
    await expect(fsp.stat(codegraphLifecycleManifestPath(root))).rejects.toMatchObject({ code: "ENOENT" });
    await expectDiskIndexCacheHasArtifacts(root);
  });

  it("init --force refreshes lastSyncAt when project files and options are current", async () => {
    const root = await mkTmpDir("cg-life-force-current-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    const first = await initCodegraphLifecycle(root);
    const manifestPath = codegraphLifecycleManifestPath(root);
    const staleManifest: CodegraphLifecycleManifest = {
      ...first.manifest,
      lastSyncAt: "2000-01-01T00:00:00.000Z",
    };
    await fsp.writeFile(manifestPath, `${JSON.stringify(staleManifest, null, 2)}\n`, "utf8");

    const currentStatus = await getCodegraphLifecycleStatus(root);
    const withoutForce = await initCodegraphLifecycle(root);

    expect(currentStatus.suggestedNextCommand).toBe("codegraph status");
    expect(currentStatus.lastSyncAt).toBe(staleManifest.lastSyncAt);
    expect(withoutForce.manifest).toEqual(staleManifest);
    expect(await readManifest(root)).toEqual(staleManifest);

    const forced = await initCodegraphLifecycle(root, { force: true });

    expect(forced.manifest.createdAt).toBe(first.manifest.createdAt);
    expect(forced.manifest.lastSyncAt).not.toBe(staleManifest.lastSyncAt);
    expect(forced.changedFiles.totalDelta).toBe(0);
    expect(await readManifest(root)).toEqual(forced.manifest);
  });

  it("init --force recomputes stale manifest metadata for current project files", async () => {
    const root = await mkTmpDir("cg-life-force-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    const first = await initCodegraphLifecycle(root);
    await writeFile(root, "src/extra.ts", "export const extra = 2;\n");
    const manifestPath = codegraphLifecycleManifestPath(root);
    const staleManifest = {
      ...first.manifest,
      fileCount: 99,
      fileSignatureHash: "stale-file-signature-hash",
    };
    await fsp.writeFile(manifestPath, `${JSON.stringify(staleManifest, null, 2)}\n`, "utf8");

    const result = await initCodegraphLifecycle(root, { force: true });
    const status = await getCodegraphLifecycleStatus(root);

    expect(result.manifest.createdAt).toBe(first.manifest.createdAt);
    expect(result.manifest.fileCount).toBe(2);
    expect(result.manifest.fileSignatureHash).not.toBe(staleManifest.fileSignatureHash);
    expect(status.fileCount).toEqual({ then: 2, current: 2 });
    expect(status.filesChanged).toBeFalsy();
    expect(await readManifest(root)).toEqual(result.manifest);
  });

  it("init --force recovers from a corrupt manifest", async () => {
    const root = await mkTmpDir("cg-life-force-corrupt-manifest-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    const manifestPath = codegraphLifecycleManifestPath(root);
    await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
    await fsp.writeFile(manifestPath, "{not valid json\n", "utf8");

    await expect(initCodegraphLifecycle(root)).rejects.toThrow(
      `Unable to read Codegraph lifecycle manifest at ${manifestPath}`,
    );

    const result = await initCodegraphLifecycle(root, { force: true });

    expect(result.manifest.fileCount).toBe(1);
    expect(await readManifest(root)).toEqual(result.manifest);
    expect(await readCodegraphEntries(root)).toEqual(["manifest.json"]);
  });

  it("status reports initialized and not initialized projects", async () => {
    const root = await mkTmpDir("cg-life-status-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");

    const before = await getCodegraphLifecycleStatus(root);
    await initCodegraphLifecycle(root);
    const after = await getCodegraphLifecycleStatus(root);

    expect(before.initialized).toBeFalsy();
    expect(before.suggestedNextCommand).toBe("codegraph init");
    expect(after.initialized).toBeTruthy();
    expect(after.fileCount).toEqual({ then: 1, current: 1 });
  });

  it("status detects same-file content edits without a file-count change", async () => {
    const root = await mkTmpDir("cg-life-status-edit-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);

    await writeFile(root, "src/main.ts", "export const main = 2;\n");
    const status = await getCodegraphLifecycleStatus(root);

    expect(status.fileCount).toEqual({ then: 1, current: 1 });
    expect(status.filesChanged).toBeTruthy();
    expect(status.suggestedNextCommand).toBe("codegraph sync");
  });

  it("status detects config hash changes", async () => {
    const root = await mkTmpDir("cg-life-config-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await writeFile(root, "package.json", `${JSON.stringify({ name: "fixture", dependencies: { left: "1.0.0" } })}\n`);
    await initCodegraphLifecycle(root);
    await writeFile(root, "package.json", `${JSON.stringify({ name: "fixture", dependencies: { right: "1.0.0" } })}\n`);

    const status = await getCodegraphLifecycleStatus(root);

    expect(status.configChanged).toBeTruthy();
    expect(status.suggestedNextCommand).toBe("codegraph sync");
  });

  it("status detects codegraph.config.json content changes", async () => {
    const root = await mkTmpDir("cg-life-config-json-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);

    const before = await getCodegraphLifecycleStatus(root);
    expect(before.configChanged).toBeFalsy();

    await writeFile(root, CODEGRAPH_CONFIG_FILE, `${JSON.stringify({ discovery: { ignoreGlobs: ["dist/**"] } })}\n`);

    const after = await getCodegraphLifecycleStatus(root);

    expect(after.configChanged).toBeTruthy();
    expect(after.suggestedNextCommand).toBe("codegraph sync");

    // Sync so the manifest baselines against the file's current ("dist/**") content.
    await initCodegraphLifecycle(root, { force: true });

    const baselined = await getCodegraphLifecycleStatus(root);
    expect(baselined.configChanged).toBeFalsy();

    // Rewrite with different valid content (not a mere appearance) and confirm drift is detected again.
    // An implementation that only checks the file's presence/path (and ignores content) would still see
    // this as "unchanged since sync" and wrongly report configChanged: false here.
    await writeFile(root, CODEGRAPH_CONFIG_FILE, `${JSON.stringify({ discovery: { ignoreGlobs: ["build/**"] } })}\n`);

    const driftedAgain = await getCodegraphLifecycleStatus(root);

    expect(driftedAgain.configChanged).toBeTruthy();
    expect(driftedAgain.suggestedNextCommand).toBe("codegraph sync");
  });

  it("init tolerates an unreadable config file: warns via hashConfig but still returns a hash-backed manifest", async () => {
    const root = await mkTmpDir("cg-life-config-unreadable-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await writeFile(root, "package.json", `${JSON.stringify({ name: "fixture" })}\n`);
    await writeFile(root, ".gitignore", "node_modules/\n");
    const gitignorePath = path.join(root, ".gitignore");
    // Mock fsp.readFile to fail (EACCES) only for .gitignore, so computeConfigHash's per-file read
    // throws for this one config-hash input while package.json still hashes successfully. .gitignore
    // is deliberately chosen: it's one of computeConfigHash's matched config files (`**/.gitignore`),
    // but unlike package.json/package-lock.json/codegraph.config.json it is never part of the
    // discovered project file set (DEFAULT_PROJECT_PATTERNS) or read unconditionally elsewhere
    // (loadGitignoreRules already swallows its own read failures) - so this isolates hashConfig's
    // `if (result.error) logWithLevel(logLevel, "warn", ...)` branch without tripping an unrelated
    // unguarded read. A readFile mock (rather than chmod) keeps this deterministic across platforms
    // where chmod may not reliably block reads (e.g. Windows, or CI running as root).
    const originalReadFile = fsp.readFile.bind(fsp);
    const eaccesError = Object.assign(new Error(`EACCES: permission denied, open '${gitignorePath}'`), {
      code: "EACCES",
    });
    const readFileSpy = vi.spyOn(fsp, "readFile").mockImplementation(async (filePath, options) => {
      if (path.resolve(String(filePath)) === path.resolve(gitignorePath)) {
        throw eaccesError;
      }
      return await originalReadFile(filePath, options as never);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await initCodegraphLifecycle(root);

      // Init reuses the index manifest hash, so hashConfig (and this lifecycle-specific warning)
      // runs on status, which must still recompute to detect drift.
      await getCodegraphLifecycleStatus(root);

      expect(warnSpy).toHaveBeenCalled();
      const lifecycleWarnCall = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("Codegraph lifecycle config drift check"),
      );
      expect(lifecycleWarnCall).toBeDefined();
      expect(lifecycleWarnCall?.[0]).toEqual(expect.stringContaining(".gitignore"));

      // The command completes successfully (no throw) and still produces a hash-backed manifest,
      // computed from whichever config files it *could* read (here, package.json).
      expect(result.manifest.configHash).toMatch(/^[0-9a-f]{40}$/);
      expect(await readManifest(root)).toEqual(result.manifest);
    } finally {
      warnSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });

  it("status detects lifecycle-relevant build option drift", async () => {
    const cases: { name: string; initial: BuildOptions; current: BuildOptions }[] = [
      {
        name: "graph options",
        initial: { graph: { resolveNodeModules: true } },
        current: { graph: { resolveNodeModules: false } },
      },
    ];

    for (const testCase of cases) {
      const root = await mkTmpDir(`cg-life-build-options-${testCase.name.replaceAll(" ", "-")}-`);
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      await initCodegraphLifecycle(root, { buildOptions: testCase.initial });

      const status = await getCodegraphLifecycleStatus(root, { buildOptions: testCase.current });

      expect(status.fileCount, testCase.name).toEqual({ then: 1, current: 1 });
      expect(status.filesChanged, testCase.name).toBeFalsy();
      expect(status.buildOptionsChanged, testCase.name).toBeTruthy();
      expect(status.suggestedNextCommand, testCase.name).toBe("codegraph sync");
    }
  });

  it("status treats omitted cache and explicit cache off as the same build options", async () => {
    const root = await mkTmpDir("cg-life-cache-equivalent-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root, { buildOptions: { cache: "off" } });

    const status = await getCodegraphLifecycleStatus(root);

    expect(status.fileCount).toEqual({ then: 1, current: 1 });
    expect(status.filesChanged).toBeFalsy();
    expect(status.buildOptionsChanged).toBeFalsy();
    expect(status.suggestedNextCommand).toBe("codegraph status");
  });

  it("status treats omitted and explicit default-equivalent graph options as current", async () => {
    const explicitDefaultGraphOptions: BuildOptions = {
      graph: { resolveNodeModules: false, dynamicImportHeuristics: false },
    };
    const cases: { name: string; initial?: BuildOptions; current?: BuildOptions }[] = [
      {
        name: "omitted at init and explicit graph defaults at status",
        current: explicitDefaultGraphOptions,
      },
      {
        name: "explicit graph defaults at init and omitted at status",
        initial: explicitDefaultGraphOptions,
      },
    ];

    for (const testCase of cases) {
      const root = await mkTmpDir(`cg-life-build-options-defaults-${testCase.name.replaceAll(" ", "-")}-`);
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      if (testCase.initial) {
        await initCodegraphLifecycle(root, { buildOptions: testCase.initial });
      } else {
        await initCodegraphLifecycle(root);
      }

      let status: CodegraphLifecycleStatus;
      if (testCase.current) {
        status = await getCodegraphLifecycleStatus(root, { buildOptions: testCase.current });
      } else {
        status = await getCodegraphLifecycleStatus(root);
      }

      expect(status.fileCount, testCase.name).toEqual({ then: 1, current: 1 });
      expect(status.filesChanged, testCase.name).toBeFalsy();
      expect(status.buildOptionsChanged, testCase.name).toBeFalsy();
      expect(status.suggestedNextCommand, testCase.name).toBe("codegraph status");
    }
  });

  it("sync updates manifest after a file edit", async () => {
    const root = await mkTmpDir("cg-life-sync-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);
    await writeFile(root, "src/extra.ts", "export const extra = 2;\n");

    const result = await syncCodegraphLifecycle(root);

    expect(result.manifest.fileCount).toBe(2);
    expect(result.changedFiles.added).toBe(1);
    expect(await readCodegraphEntries(root)).toEqual(["manifest.json"]);
  });

  it("sync refreshes lifecycle state after a Git-ignored mtime-only rewrite", async () => {
    const root = await mkTmpDir("cg-life-sync-mtime-");
    const relativePath = "src/main.ts";
    const file = path.join(root, relativePath);
    await initializeGitRepository(root);
    await writeFile(root, ".gitignore", ".codegraph/\n");
    await writeFile(root, relativePath, "export const main = 1;\n");
    await execFileAsync("git", ["add", ".gitignore", relativePath], { windowsHide: true, cwd: root });
    await execFileAsync("git", ["commit", "--quiet", "-m", "initial source"], { windowsHide: true, cwd: root });
    await initCodegraphLifecycle(root);

    const before = await fsp.stat(file);
    const rewrittenAt = new Date(before.mtimeMs + 5_000);
    await fsp.utimes(file, rewrittenAt, rewrittenAt);
    await syncCodegraphLifecycle(root);

    expect((await getCodegraphLifecycleStatus(root)).filesChanged).toBeFalsy();
  });

  it("sync refreshes retained lifecycle signatures after a mixed Git update", async () => {
    const root = await mkTmpDir("cg-life-sync-mixed-signatures-");
    const retainedPath = "src/retained.ts";
    const updatedPath = "src/updated.ts";
    const retainedFile = path.join(root, retainedPath);
    await initializeGitRepository(root);
    await writeFile(root, ".gitignore", ".codegraph/\n");
    await writeFile(root, retainedPath, "export const retained = 1;\n");
    await writeFile(root, updatedPath, "export const updated = 1;\n");
    await execFileAsync("git", ["add", ".gitignore", retainedPath, updatedPath], { windowsHide: true, cwd: root });
    await execFileAsync("git", ["commit", "--quiet", "-m", "initial source"], { windowsHide: true, cwd: root });
    await initCodegraphLifecycle(root);

    const before = await fsp.stat(retainedFile);
    const rewrittenAt = new Date(before.mtimeMs + 5_000);
    await fsp.utimes(retainedFile, rewrittenAt, rewrittenAt);
    await writeFile(root, updatedPath, "export const updated = 2;\n");
    await syncCodegraphLifecycle(root);

    expect((await getCodegraphLifecycleStatus(root)).filesChanged).toBeFalsy();
  });

  it("sync independently tracks added and removed files when one is added and a different one is removed", async () => {
    const root = await mkTmpDir("cg-life-sync-add-remove-");
    await writeFile(root, "src/a.ts", "export const a = 1;\n");
    await writeFile(root, "src/b.ts", "export const b = 2;\n");
    await initCodegraphLifecycle(root);

    await fsp.rm(path.join(root, "src/a.ts"));
    await writeFile(root, "src/c.ts", "export const c = 3;\n");

    const result = await syncCodegraphLifecycle(root);

    expect(result.manifest.fileCount).toBe(2);
    expect(result.manifest.files).toEqual(["src/b.ts", "src/c.ts"]);
    expect(result.changedFiles.totalDelta).toBe(0);
    expect(result.changedFiles.added).toBe(1);
    expect(result.changedFiles.removed).toBe(1);
  });

  it("sync derives totalDelta from the actual file lists even when a manifest's fileCount has drifted from files.length", async () => {
    const root = await mkTmpDir("cg-life-sync-desynced-manifest-");
    await writeFile(root, "src/a.ts", "export const a = 1;\n");
    await writeFile(root, "src/b.ts", "export const b = 2;\n");
    await initCodegraphLifecycle(root);

    const manifestPath = codegraphLifecycleManifestPath(root);
    const priorManifest = await readManifest(root);
    const previousFiles = priorManifest.files ?? [];
    expect(previousFiles).toEqual(["src/a.ts", "src/b.ts"]);

    // Hand-desync fileCount from the files array it is supposed to describe (e.g. a hand edit or
    // partial corruption). If totalDelta were still trusting fileCount, it would come out as
    // 2 - 99 = -97 instead of matching the real file-list churn asserted below.
    const desyncedManifest: CodegraphLifecycleManifest = { ...priorManifest, fileCount: 99 };
    await fsp.writeFile(manifestPath, `${JSON.stringify(desyncedManifest, null, 2)}\n`, "utf8");

    await fsp.rm(path.join(root, "src/a.ts"));
    await writeFile(root, "src/c.ts", "export const c = 3;\n");

    const result = await syncCodegraphLifecycle(root);
    const currentFiles = result.manifest.files ?? [];

    expect(currentFiles).toEqual(["src/b.ts", "src/c.ts"]);
    expect(result.changedFiles.added).toBe(1);
    expect(result.changedFiles.removed).toBe(1);
    expect(result.changedFiles.totalDelta).toBe(currentFiles.length - previousFiles.length);
    expect(result.changedFiles.totalDelta).toBe(0);
    expect(result.changedFiles.totalDelta).toBe(result.changedFiles.added - result.changedFiles.removed);
  });

  it("sync falls back to net-delta approximation when the previous manifest predates per-file tracking", async () => {
    const root = await mkTmpDir("cg-life-sync-legacy-manifest-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);

    const manifestPath = codegraphLifecycleManifestPath(root);
    const legacyManifest = await readManifest(root);
    delete legacyManifest.files;
    await fsp.writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, "utf8");

    await writeFile(root, "src/extra.ts", "export const extra = 2;\n");

    const result = await syncCodegraphLifecycle(root);

    expect(result.changedFiles.added).toBeGreaterThanOrEqual(0);
    expect(result.changedFiles.removed).toBeGreaterThanOrEqual(0);
    expect(result.changedFiles.added).toBe(1);
    expect(result.changedFiles.removed).toBe(0);
    expect(result.manifest.fileCount).toBe(2);
    expect(result.manifest.files).toEqual(["src/extra.ts", "src/main.ts"]);
  });

  it("init and sync keep lifecycle metadata separate from the disk index cache", async () => {
    const root = await mkTmpDir("cg-life-cache-warm-");
    const cacheRoot = path.join(root, ".codegraph", "cache", "index-v1");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");

    await initCodegraphLifecycle(root);

    expect(await readCodegraphEntries(root)).toEqual(["manifest.json"]);
    await expectDiskIndexCacheHasArtifacts(root);

    await fsp.rm(cacheRoot, { recursive: true, force: true });
    await fsp.mkdir(cacheRoot, { recursive: true });
    await writeFile(root, "src/extra.ts", "export const extra = 2;\n");
    await syncCodegraphLifecycle(root);

    await expectDiskIndexCacheHasArtifacts(root);
    expect(await readCodegraphEntries(root)).toEqual(["manifest.json"]);
  });

  it("sync requires an initialized project unless --init is used", async () => {
    const root = await mkTmpDir("cg-life-sync-init-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");

    await expect(syncCodegraphLifecycle(root)).rejects.toThrow(/not initialized/);
    const result = await syncCodegraphLifecycle(root, { init: true });
    expect(result.initialized).toBeTruthy();
  });

  it("uninit removes recognized lifecycle files and refuses unknown entries", async () => {
    const root = await mkTmpDir("cg-life-uninit-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);
    await fsp.writeFile(path.join(root, ".codegraph", "keep.txt"), "operator data\n", "utf8");

    await expect(uninitCodegraphLifecycle(root)).rejects.toThrow(/unknown entries/);
    const result = await uninitCodegraphLifecycle(root, { force: true });

    expect(result.removed).toBeTruthy();
    await expectDiskIndexCacheHasArtifacts(root);
  });
  it("uninit refuses inherited lookup keys as unknown lifecycle entries", async () => {
    const inheritedEntries = ["toString", "__proto__"] as const;
    let verifiedEntries = 0;

    for (const entry of inheritedEntries) {
      const root = await mkTmpDir(`cg-life-uninit-inherited-${entry}-`);
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      await initCodegraphLifecycle(root);
      try {
        await fsp.writeFile(path.join(root, ".codegraph", entry), "operator data\n", "utf8");
      } catch (error) {
        if (
          process.platform === "win32" &&
          error instanceof Error &&
          "code" in error &&
          (error.code === "EINVAL" || error.code === "EPERM")
        ) {
          continue;
        }
        throw error;
      }

      await expect(uninitCodegraphLifecycle(root)).rejects.toThrow(new RegExp(`unknown entries: ${entry}`));
      verifiedEntries += 1;
    }

    expect(verifiedEntries).toBeGreaterThan(0);
  });

  it("refuses forced cleanup through a symlinked lifecycle directory", async () => {
    const root = await mkTmpDir("cg-life-uninit-symlink-root-");
    const externalDirectory = await mkTmpDir("cg-life-uninit-symlink-external-");
    const sentinelPath = path.join(externalDirectory, "sentinel.txt");
    await fsp.writeFile(sentinelPath, "operator data\n", "utf8");

    await fsp.symlink(
      externalDirectory,
      path.join(root, ".codegraph"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(uninitCodegraphLifecycle(root, { force: true })).rejects.toThrow(
      "Refusing to traverse symbolic link as .codegraph lifecycle directory",
    );
    await expect(fsp.readFile(sentinelPath, "utf8")).resolves.toBe("operator data\n");
  });

  it("uninit without --force removes the manifest while preserving the disk cache", async () => {
    const root = await mkTmpDir("cg-life-uninit-manifest-only-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);

    const result = await uninitCodegraphLifecycle(root);

    expect(result.removed).toBeTruthy();
    await expect(fsp.stat(codegraphLifecycleManifestPath(root))).rejects.toMatchObject({ code: "ENOENT" });
    await expectDiskIndexCacheHasArtifacts(root);
  });

  it("preserves server-only state without reporting lifecycle removal", async () => {
    const root = await mkTmpDir("cg-life-uninit-server-only-");
    const codegraphDirectory = path.join(root, ".codegraph");
    await fsp.mkdir(codegraphDirectory);
    await fsp.writeFile(path.join(codegraphDirectory, "server.json"), "{}\n", "utf8");
    await fsp.writeFile(path.join(codegraphDirectory, "server.log"), "server diagnostics\n", "utf8");

    const regularResult = await uninitCodegraphLifecycle(root);
    const forcedResult = await uninitCodegraphLifecycle(root, { force: true });

    expect(regularResult.removed).toBe(false);
    expect(forcedResult.removed).toBe(false);
    expect(await readCodegraphEntries(root)).toEqual(["server.json", "server.log"]);
  });

  describe("lifecycle root discovery", () => {
    it("does not change or freeze the index filesystem case mode during discovery", async () => {
      const root = await mkTmpDir("cg-life-discovery-case-mode-");
      const cache = path.join(root, ".codegraph", "cache", "index-v1");
      await writeFile(root, ".codegraph/manifest.json", "{}\n");
      await fsp.mkdir(cache, { recursive: true });
      const plain = await mkTmpDir("cg-life-discovery-plain-mode-");
      const git = await mkTmpDir("cg-life-discovery-git-mode-");
      await fsp.mkdir(path.join(git, ".git"));
      const home = path.join(plain, "unrelated-home");
      const originalMode = isFileIdentityCaseInsensitive();
      try {
        for (const cwd of [root, cache, plain, git]) {
          resetFileIdentityCaseSensitivityForTests(false);
          expect(isFileIdentityCaseInsensitive()).toBe(false);
          expect(discoverCodegraphLifecycleRoot(cwd, home).status).toBe("ok");
          expect(isFileIdentityCaseInsensitive()).toBe(false);
          setFileIdentityCaseInsensitive(true);
          expect(isFileIdentityCaseInsensitive()).toBe(true);
        }
      } finally {
        resetFileIdentityCaseSensitivityForTests(originalMode);
      }
    });

    it.each(["project", "subfolder"] as const)(
      "preserves the logical spelling of a linked %s cwd for implicit discovery",
      async (location) => {
        const root = await mkTmpDir("cg-life-logical-project-");
        const parent = await mkTmpDir("cg-life-logical-parent-");
        const logicalRoot = path.join(parent, "project");
        await writeFile(root, "src/deep/main.ts", "export const main = 1;\n");
        const manifest = (await initCodegraphLifecycle(root)).manifest;
        await fsp.symlink(root, logicalRoot, process.platform === "win32" ? "junction" : "dir");
        const cwd = location === "project" ? logicalRoot : path.join(logicalRoot, "src", "deep");

        expect(discoverCodegraphLifecycleRoot(cwd)).toEqual({ status: "ok", projectRootFs: logicalRoot });
        const implicit = await captureCli(["status", "--json"], { cwd });
        const explicit = await captureCli(["status", "--root", logicalRoot, "--json"], { cwd });

        expect(implicit.exitCode).toBeUndefined();
        expect(explicit.exitCode).toBeUndefined();
        expect(implicit.stderr).toBe("");
        expect(explicit.stderr).toBe("");
        const implicitPayload = JSON.parse(implicit.stdout) as CodegraphLifecycleStatus;
        const explicitPayload = JSON.parse(explicit.stdout) as CodegraphLifecycleStatus;
        expect(implicitPayload.root).toBe(logicalRoot);
        expect(implicitPayload.root).toBe(explicitPayload.root);
        expect(implicitPayload.root).not.toBe(root);
        expect(implicitPayload.initialized).toBeTruthy();
        expect(implicitPayload.manifestPath).toBe(codegraphLifecycleManifestPath(logicalRoot));
        expect(await readManifest(root)).toEqual(manifest);
        await expect(fsp.stat(path.join(logicalRoot, "src", "deep", ".codegraph"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );

    it("conservatively keeps a direct cache alias as the logical start without touching its physical owner", async () => {
      const root = await mkTmpDir("cg-life-logical-cache-owner-");
      const parent = await mkTmpDir("cg-life-logical-cache-parent-");
      const cwd = path.join(parent, "cache-alias");
      await writeFile(root, "main.ts", "export const main = 1;\n");
      const manifest = (await initCodegraphLifecycle(root)).manifest;
      const cache = path.join(root, ".codegraph", "cache", "index-v1");
      await fsp.symlink(cache, cwd, process.platform === "win32" ? "junction" : "dir");

      expect(discoverCodegraphLifecycleRoot(cwd)).toEqual({ status: "ok", projectRootFs: cwd });
      for (const args of [
        ["uninit", "--json"],
        ["uninit", "--purge", "--json"],
      ]) {
        const result = await captureCli(args, { cwd });
        expect(result.exitCode).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({ root: cwd, removed: false });
        expect(await readManifest(root)).toEqual(manifest);
        await expectDiskIndexCacheHasArtifacts(root);
      }
    });

    it("treats a directory link at .git as a boundary and leaves the initialized parent untouched", async () => {
      const parent = await mkTmpDir("cg-life-linked-git-parent-");
      await writeFile(parent, "main.ts", "export const parent = 1;\n");
      const manifest = (await initCodegraphLifecycle(parent)).manifest;
      const root = path.join(parent, "nested");
      const cwd = path.join(root, "src", "deep");
      await writeFile(cwd, "main.ts", "export const nested = 2;\n");
      await initializeGitRepository(root);
      const metadata = path.join(await mkTmpDir("cg-life-linked-git-metadata-"), "repository.git");
      await fsp.rename(path.join(root, ".git"), metadata);
      await fsp.symlink(metadata, path.join(root, ".git"), process.platform === "win32" ? "junction" : "dir");
      const head = await fsp.readFile(path.join(metadata, "HEAD"), "utf8");

      for (const start of [root, cwd]) {
        expect(discoverCodegraphLifecycleRoot(start)).toEqual({ status: "ok", projectRootFs: start });
        const result = await captureCli(["uninit", "--json"], { cwd: start });
        expect(result.exitCode).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({ root: start, removed: false });
        expect(await readManifest(parent)).toEqual(manifest);
        await expect(fsp.stat(path.join(start, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect((await fsp.lstat(path.join(root, ".git"))).isSymbolicLink()).toBeTruthy();
      expect(await fsp.readFile(path.join(metadata, "HEAD"), "utf8")).toBe(head);
    });

    it("honors an injected linked home from both logical and physical project and cache spellings", async () => {
      const home = await mkTmpDir("cg-life-physical-home-");
      const parent = await mkTmpDir("cg-life-linked-home-parent-");
      const logicalHome = path.join(parent, "home");
      await writeFile(home, "home.ts", "export const homeValue = 1;\n");
      const manifest = (await initCodegraphLifecycle(home)).manifest;
      await writeFile(home, ".codegraph/sentinel.txt", "home state\n");
      await fsp.symlink(home, logicalHome, process.platform === "win32" ? "junction" : "dir");
      await writeFile(home, "projects/myrepo/main.ts", "export const project = 2;\n");
      vi.spyOn(os, "homedir").mockReturnValue(logicalHome);

      for (const spelling of [home, logicalHome]) {
        expect(discoverCodegraphLifecycleRoot(spelling, logicalHome)).toEqual({
          status: "ok",
          projectRootFs: spelling,
        });
        for (const relative of ["projects/myrepo", ".codegraph/cache/index-v1"]) {
          const cwd = path.join(spelling, relative);
          expect(discoverCodegraphLifecycleRoot(cwd, logicalHome)).toEqual({ status: "ok", projectRootFs: cwd });
          for (const args of [
            ["uninit", "--json"],
            ["uninit", "--purge", "--json"],
          ]) {
            const result = await captureCli(args, { cwd });
            expect(result.exitCode).toBeUndefined();
            expect(result.stderr).toBe("");
            expect(JSON.parse(result.stdout)).toMatchObject({ root: cwd, removed: false });
            expect(await readManifest(home)).toEqual(manifest);
            expect(await fsp.readFile(path.join(home, ".codegraph", "sentinel.txt"), "utf8")).toBe("home state\n");
            await expectDiskIndexCacheHasArtifacts(home);
          }
          await expect(fsp.stat(path.join(cwd, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      expect((await fsp.lstat(logicalHome)).isSymbolicLink()).toBeTruthy();
    });

    it.each(["manifest", "Git boundary"] as const)(
      "%s candidate stat failures return root policy errors and clean CLI errors without changing state",
      async (kind) => {
        const root = await mkTmpDir("cg-life-discover-unreadable-");
        const cwd = path.join(root, "src", "deep");
        await writeFile(cwd, "main.ts", "export const main = 1;\n");
        const manifest = (await initCodegraphLifecycle(root)).manifest;
        if (kind === "manifest") await fsp.mkdir(path.join(cwd, ".codegraph"));
        const candidatePath = kind === "manifest" ? codegraphLifecycleManifestPath(cwd) : path.join(cwd, ".git");
        const originalLstatSync = fs.lstatSync.bind(fs);
        vi.spyOn(fs, "lstatSync").mockImplementation((target, options) => {
          if (target === candidatePath) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          return originalLstatSync(target, options as never);
        });
        const message = `Unable to discover Codegraph lifecycle root at ${candidatePath}: permission denied`;
        const expected = { status: "error", messages: [message] };

        expect(discoverCodegraphLifecycleRoot(cwd)).toEqual(expected);
        expect(
          resolveCliRootPolicy({ command: "status", positionals: [], rootOpt: undefined, cwd: () => cwd }),
        ).toEqual(expected);
        const result = await captureCli(["status", "--json"], { cwd });

        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(`${message}\n`);
        expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
        expect(await readManifest(root)).toEqual(manifest);
        await expectDiskIndexCacheHasArtifacts(root);
        if (kind === "manifest") expect(await fsp.readdir(path.join(cwd, ".codegraph"))).toEqual([]);
        else await expect(fsp.stat(path.join(cwd, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it.each([
      { location: "state projects", git: false },
      { location: "state projects", git: true },
      { location: "workspace", git: false },
    ])("does not select initialized home for $location with Git=$git", async ({ location, git }) => {
      const home = await mkTmpDir("cg-life-home-boundary-");
      await writeFile(home, "home.ts", "export const homeValue = 1;\n");
      const manifest = (await initCodegraphLifecycle(home)).manifest;
      await writeFile(home, ".codegraph/sentinel.txt", "home state\n");
      await writeFile(home, ".codegraph/server.log", "home diagnostics\n");
      const relative = location === "workspace" ? "workspace/myrepo" : ".codegraph/projects/myrepo";
      const cwd = path.join(home, relative);
      await writeFile(cwd, "main.ts", "export const project = 2;\n");
      if (git) await initializeGitRepository(cwd);
      vi.spyOn(os, "homedir").mockReturnValue(home);

      expect(discoverCodegraphLifecycleRoot(cwd, home)).toEqual({ status: "ok", projectRootFs: cwd });
      expect(discoverCodegraphLifecycleRoot(home, home)).toEqual({ status: "ok", projectRootFs: home });
      const status = await captureCli(["status", "--json"], { cwd });
      expect(status.exitCode).toBeUndefined();
      expect(status.stderr).toBe("");
      expect(JSON.parse(status.stdout)).toMatchObject({ root: cwd, initialized: false });
      for (const purge of [false, true]) {
        const args = ["uninit", "--json"];
        if (purge) args.push("--purge");
        const result = await captureCli(args, { cwd });
        expect(result.exitCode).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({ root: cwd, removed: false });
        expect(await readManifest(home)).toEqual(manifest);
        expect(await fsp.readFile(path.join(home, ".codegraph", "sentinel.txt"), "utf8")).toBe("home state\n");
        expect(await fsp.readFile(path.join(home, ".codegraph", "server.log"), "utf8")).toBe("home diagnostics\n");
        await expectDiskIndexCacheHasArtifacts(home);
      }
      await expect(fsp.stat(path.join(cwd, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
      if (location === "workspace") {
        const initialized = await captureCli(["init", "--json", "--no-progress"], { cwd });
        expect(initialized.exitCode).toBeUndefined();
        expect(initialized.stderr).toBe("");
        expect(JSON.parse(initialized.stdout)).toMatchObject({ root: cwd, initialized: true });
        expect((await readManifest(cwd)).fileCount).toBe(1);
        expect(await readManifest(home)).toEqual(manifest);
      }
    });

    it("does not walk above an uninitialized home when home is the real start", async () => {
      const parent = await mkTmpDir("cg-life-home-start-boundary-");
      await writeFile(parent, "main.ts", "export const main = 1;\n");
      const manifest = (await initCodegraphLifecycle(parent)).manifest;
      const home = path.join(parent, "home");
      await fsp.mkdir(home);
      vi.spyOn(os, "homedir").mockReturnValue(home);

      expect(discoverCodegraphLifecycleRoot(home, home)).toEqual({ status: "ok", projectRootFs: home });
      const result = await captureCli(["status", "--json"], { cwd: home });

      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ root: home, initialized: false });
      expect(await readManifest(parent)).toEqual(manifest);
      await expect(fsp.stat(path.join(home, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("does not select home through the cache segment rule", async () => {
      const home = await mkTmpDir("cg-life-home-cache-boundary-");
      const cwd = path.join(home, ".codegraph", "cache", "index-v1");
      await writeFile(cwd, "sentinel.txt", "home cache\n");
      vi.spyOn(os, "homedir").mockReturnValue(home);

      expect(discoverCodegraphLifecycleRoot(cwd, home)).toEqual({ status: "ok", projectRootFs: cwd });
      for (const args of [
        ["uninit", "--json"],
        ["uninit", "--purge", "--json"],
      ]) {
        const result = await captureCli(args, { cwd });
        expect(result.exitCode).toBeUndefined();
        expect(JSON.parse(result.stdout)).toMatchObject({ root: cwd, removed: false });
        expect(await fsp.readFile(path.join(cwd, "sentinel.txt"), "utf8")).toBe("home cache\n");
      }
    });

    it("does not inspect a filesystem-root manifest unless that root is the real start", async () => {
      const root = await mkTmpDir("cg-life-filesystem-boundary-");
      const cwd = path.join(root, "project");
      const home = path.join(root, "unrelated-home");
      await writeFile(cwd, "main.ts", "export const main = 1;\n");
      await writeFile(root, "state-fixture/manifest.json", "{}\n");
      const stateStats = await fsp.lstat(path.join(root, "state-fixture"));
      const manifestStats = await fsp.lstat(path.join(root, "state-fixture", "manifest.json"));
      const filesystemRoot = path.parse(root).root;
      const statePath = path.join(filesystemRoot, ".codegraph");
      const originalLstatSync = fs.lstatSync.bind(fs);
      const spy = vi.spyOn(fs, "lstatSync").mockImplementation((target, options) => {
        if (target === statePath) return stateStats;
        if (target === path.join(statePath, "manifest.json")) return manifestStats;
        return originalLstatSync(target, options as never);
      });

      expect(discoverCodegraphLifecycleRoot(cwd, home)).toEqual({ status: "ok", projectRootFs: cwd });
      expect(spy).not.toHaveBeenCalledWith(statePath, { throwIfNoEntry: false });
      expect(discoverCodegraphLifecycleRoot(filesystemRoot, home)).toEqual({
        status: "ok",
        projectRootFs: filesystemRoot,
      });
    });

    it("does not select a linked ancestor .codegraph or overwrite its external manifest during init", async () => {
      const root = await mkTmpDir("cg-life-linked-ancestor-");
      const external = await mkTmpDir("cg-life-linked-state-");
      const cwd = path.join(root, "src", "deep");
      await writeFile(cwd, "main.ts", "export const main = 1;\n");
      await writeFile(external, "manifest.json", "external lifecycle state\n");
      await fsp.symlink(external, path.join(root, ".codegraph"), process.platform === "win32" ? "junction" : "dir");

      expect(discoverCodegraphLifecycleRoot(cwd)).toEqual({ status: "ok", projectRootFs: cwd });
      const result = await captureCli(["init", "--json", "--no-progress"], { cwd });

      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ root: cwd, initialized: true });
      expect((await readManifest(cwd)).fileCount).toBe(1);
      expect(await fsp.readFile(path.join(external, "manifest.json"), "utf8")).toBe("external lifecycle state\n");
      expect((await fsp.lstat(path.join(root, ".codegraph"))).isSymbolicLink()).toBeTruthy();
    });

    it("does not treat a linked manifest as an initialized ancestor", async (context) => {
      const root = await mkTmpDir("cg-life-linked-manifest-");
      const cwd = path.join(root, "src", "deep");
      const external = await mkTmpDir("cg-life-linked-manifest-target-");
      await writeFile(cwd, "main.ts", "export const main = 1;\n");
      await writeFile(external, "manifest.json", "external lifecycle state\n");
      await fsp.mkdir(path.join(root, ".codegraph"));
      const linked = await tryCreateFileSymlink(
        path.join(external, "manifest.json"),
        codegraphLifecycleManifestPath(root),
      );
      if (!linked) context.skip();

      expect(discoverCodegraphLifecycleRoot(cwd)).toEqual({ status: "ok", projectRootFs: cwd });
      const result = await captureCli(["status", "--json"], { cwd });
      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ root: cwd, initialized: false });
      expect(await fsp.readFile(path.join(external, "manifest.json"), "utf8")).toBe("external lifecycle state\n");
      await expect(fsp.stat(path.join(cwd, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(["init", "status", "sync", "uninit"] as const)(
      "CLI %s refuses a missing cwd instead of walking into initialized ancestor state",
      async (command) => {
        const root = await mkTmpDir("cg-life-deleted-cwd-");
        await writeFile(root, "main.ts", "export const main = 1;\n");
        const manifest = (await initCodegraphLifecycle(root)).manifest;
        await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
        const cwd = path.join(root, "deleted");
        await fsp.mkdir(cwd);
        await fsp.rmdir(cwd);
        const args = [command, "--json"];
        if (command === "init" || command === "sync") args.push("--no-progress");
        if (command === "uninit") args.push("--purge");

        const result = await captureCli(args, { cwd });

        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(`Current directory ${cwd} is not accessible:`);
        expect(result.stderr).toContain("cd to the project directory and rerun.");
        expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
        expect(await readManifest(root)).toEqual(manifest);
        await expectDiskIndexCacheHasArtifacts(root);
        expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
      },
    );

    it("reports a permissions failure resolving the start without walking its ancestors", async () => {
      const root = await mkTmpDir("cg-life-inaccessible-start-");
      const cwd = path.join(root, "src", "deep");
      await writeFile(cwd, "main.ts", "export const main = 1;\n");
      const manifest = (await initCodegraphLifecycle(root)).manifest;
      const originalRealpath = fs.realpathSync.native.bind(fs.realpathSync);
      vi.spyOn(fs.realpathSync, "native").mockImplementation((target, options) => {
        if (target === cwd) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return originalRealpath(target, options as never);
      });

      const result = await captureCli(["status", "--json"], { cwd });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `Current directory ${cwd} is not accessible: permission denied. cd to the project directory and rerun.\n`,
      );
      expect(await readManifest(root)).toEqual(manifest);
    });

    it.runIf(process.platform !== "win32")(
      "the built CLI reports a cwd deleted by its own process without touching ancestor state",
      async () => {
        const root = await mkTmpDir("cg-life-deleted-built-cwd-");
        await writeFile(root, "main.ts", "export const main = 1;\n");
        const manifest = (await initCodegraphLifecycle(root)).manifest;
        await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
        const cwd = path.join(root, "deleted");
        await fsp.mkdir(cwd);
        const bundledCli = fileURLToPath(new URL("../dist/bin/cli.js", import.meta.url));
        expect((await fsp.stat(bundledCli)).isFile()).toBeTruthy();
        const script = [
          'import fs from "node:fs";',
          "const cwd = process.cwd();",
          "fs.rmdirSync(cwd);",
          `process.argv = [process.execPath, ${JSON.stringify(bundledCli)}, "uninit", "--purge", "--json"];`,
          "// Loading the CLI after deleting cwd exercises the startup boundary.",
          `await import(${JSON.stringify(pathToFileURL(bundledCli).href)});`,
        ].join("\n");
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
          windowsHide: true,
          cwd,
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 16 * 1024 * 1024,
        });

        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(`Current directory ${cwd} is not accessible:`);
        expect(result.stderr).toContain("cd to the project directory and rerun.");
        expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
        expect(await readManifest(root)).toEqual(manifest);
        await expectDiskIndexCacheHasArtifacts(root);
        expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
      },
    );

    it.runIf(process.platform === "win32")("resolves a .CODEGRAPH cache spelling to its owner", async () => {
      const root = await mkTmpDir("cg-life-case-discovery-");
      await writeFile(root, "main.ts", "export const main = 1;\n");
      const manifest = (await initCodegraphLifecycle(root)).manifest;
      const cwd = path.join(root, ".CODEGRAPH", "cache");

      expect(discoverCodegraphLifecycleRoot(cwd)).toEqual({ status: "ok", projectRootFs: root });
      const result = await captureCli(["status", "--json"], { cwd });
      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ root, initialized: true });
      expect(await readManifest(root)).toEqual(manifest);
    });

    it("stops at a Git boundary inside a cache before considering its .codegraph ancestor", async () => {
      const root = await mkTmpDir("cg-life-cache-git-boundary-");
      await writeFile(root, "main.ts", "export const main = 1;\n");
      const manifest = (await initCodegraphLifecycle(root)).manifest;
      const cwd = path.join(root, ".codegraph", "cache", "nested");
      await fsp.mkdir(path.join(cwd, ".git"), { recursive: true });

      expect(discoverCodegraphLifecycleRoot(cwd)).toEqual({ status: "ok", projectRootFs: cwd });
      const result = await captureCli(["uninit", "--json"], { cwd });
      expect(result.exitCode).toBeUndefined();
      expect(JSON.parse(result.stdout)).toMatchObject({ root: cwd, removed: false });
      expect(await readManifest(root)).toEqual(manifest);
    });

    it.each(["status", "sync", "uninit"] as const)(
      "CLI %s from a deep non-Git subfolder uses the initialized project root",
      async (command) => {
        const root = await mkTmpDir(`cg-life-discover-${command}-`);
        const cwd = path.join(root, "src", "nested", "deep");
        await fsp.mkdir(cwd, { recursive: true });
        await writeFile(root, "src/main.ts", "export const main = 1;\n");
        await initCodegraphLifecycle(root);
        await writeFile(root, "src/extra.ts", "export const extra = 2;\n");

        expect(discoverCodegraphLifecycleRoot(cwd)).toEqual({ status: "ok", projectRootFs: root });
        const args = [command, "--json"];
        if (command === "sync") args.push("--no-progress");
        const result = await captureCli(args, { cwd });

        expect(result.exitCode).toBeUndefined();
        expect(result.stderr).toBe("");
        const payload = JSON.parse(result.stdout) as
          | CodegraphLifecycleStatus
          | CodegraphLifecycleSyncResult
          | CodegraphLifecycleUninitResult;
        expect(payload.root).toBe(root);
        if (command === "status") {
          expect(payload).toMatchObject({ initialized: true, filesChanged: true, fileCount: { then: 1, current: 2 } });
        } else if (command === "sync") {
          expect(payload).toMatchObject({ initialized: true, manifest: { fileCount: 2 }, changedFiles: { added: 1 } });
          expect((await readManifest(root)).fileCount).toBe(2);
        } else {
          expect(payload).toMatchObject({ removed: true, removedEntries: ["manifest.json"] });
          await expect(fsp.stat(codegraphLifecycleManifestPath(root))).rejects.toMatchObject({ code: "ENOENT" });
          await expectDiskIndexCacheHasArtifacts(root);
        }
        for (const subfolder of ["src", "src/nested", "src/nested/deep"]) {
          await expect(fsp.stat(path.join(root, subfolder, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
        }
      },
    );

    it("CLI init from an initialized project's subfolder refreshes only the root manifest", async () => {
      const root = await mkTmpDir("cg-life-discover-init-");
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      const first = await initCodegraphLifecycle(root);
      const cwd = path.join(root, "src", "nested", "deep");
      await fsp.mkdir(cwd, { recursive: true });
      await writeFile(root, "src/extra.ts", "export const extra = 2;\n");

      const result = await captureCli(["init", "--json", "--no-progress"], { cwd });

      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as CodegraphLifecycleSyncResult;
      expect(payload.root).toBe(root);
      expect(payload.manifest.createdAt).toBe(first.manifest.createdAt);
      expect(payload.manifest.fileCount).toBe(2);
      expect(payload.changedFiles.added).toBe(1);
      expect(await readManifest(root)).toEqual(payload.manifest);
      for (const subfolder of ["src", "src/nested", "src/nested/deep"]) {
        await expect(fsp.stat(path.join(root, subfolder, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    });

    it.each([false, true])(
      "CLI uninit from inside the disk cache resolves its owning root and safely handles purge=%s",
      async (purge) => {
        const root = await mkTmpDir("cg-life-discover-cache-");
        await writeFile(root, "src/main.ts", "export const main = 1;\n");
        const manifest = (await initCodegraphLifecycle(root)).manifest;
        await expectDiskIndexCacheHasArtifacts(root);
        await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
        const cwd = path.join(root, ".codegraph", "cache", "index-v1");
        const args = ["uninit", "--json"];
        if (purge) args.push("--purge");

        const result = await captureCli(args, { cwd });

        if (purge) {
          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain(`Refusing to purge ${path.join(root, ".codegraph")} from inside it.`);
          expect(result.stderr).toContain(`Run cd "${root}" and rerun codegraph uninit --purge.`);
          expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
          expect(await readManifest(root)).toEqual(manifest);
          await expectDiskIndexCacheHasArtifacts(root);
          expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");

          const retried = await captureCli(args, { cwd: root });
          expect(retried.exitCode).toBeUndefined();
          expect(retried.stderr).toBe("");
          expect(JSON.parse(retried.stdout)).toMatchObject({
            root,
            removed: true,
            removedEntries: ["cache", "manifest.json", "server.log"],
          });
          await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(result.exitCode).toBeUndefined();
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout)).toMatchObject({ root, removed: true, removedEntries: ["manifest.json"] });
          await expect(fsp.stat(codegraphLifecycleManifestPath(root))).rejects.toMatchObject({ code: "ENOENT" });
          await expectDiskIndexCacheHasArtifacts(root);
          expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
          await expect(fsp.stat(path.join(cwd, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
        }
      },
    );

    it("CLI uninit --purge refuses from a cache-only project's cache, then succeeds from its root", async () => {
      const root = await mkTmpDir("cg-life-discover-cache-only-");
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      await initCodegraphLifecycle(root);
      await uninitCodegraphLifecycle(root);
      await expectDiskIndexCacheHasArtifacts(root);
      const cwd = path.join(root, ".codegraph", "cache", "index-v1");
      expect(discoverCodegraphLifecycleRoot(cwd)).toEqual({ status: "ok", projectRootFs: root });

      const result = await captureCli(["uninit", "--purge", "--json"], { cwd });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Refusing to purge ${path.join(root, ".codegraph")} from inside it.`);
      expect(result.stderr).toContain(`Run cd "${root}"`);
      expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
      await expectDiskIndexCacheHasArtifacts(root);
      await expect(fsp.stat(codegraphLifecycleManifestPath(root))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readCodegraphEntries(root)).toEqual([]);

      const retried = await captureCli(["uninit", "--purge", "--json"], { cwd: root });
      expect(retried.exitCode).toBeUndefined();
      expect(retried.stderr).toBe("");
      expect(JSON.parse(retried.stdout)).toMatchObject({ root, removed: true, removedEntries: ["cache"] });
      await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("finds the nearest initialized project nested inside a cache", async () => {
      const outer = await mkTmpDir("cg-life-discover-deepest-");
      const root = path.join(outer, ".codegraph", "cache", "nested");
      const cwd = path.join(root, ".codegraph", "cache", "index-v1");
      await writeFile(root, ".codegraph/manifest.json", "operator metadata\n");
      await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
      await writeFile(cwd, "artifact.json", "{}\n");

      expect(discoverCodegraphLifecycleRoot(cwd)).toEqual({ status: "ok", projectRootFs: root });
      expect(discoverCodegraphLifecycleRoot(path.join(root, ".codegraph"))).toEqual({
        status: "ok",
        projectRootFs: root,
      });
      const result = await captureCli(["uninit", "--purge", "--json"], { cwd });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Refusing to purge ${path.join(root, ".codegraph")} from inside it.`);
      expect(result.stderr).toContain(`Run cd "${root}"`);
      expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
      expect(await fsp.readFile(codegraphLifecycleManifestPath(root), "utf8")).toBe("operator metadata\n");
      expect(await fsp.readFile(path.join(cwd, "artifact.json"), "utf8")).toBe("{}\n");
      expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");

      const retried = await captureCli(["uninit", "--root", root, "--purge", "--json"], { cwd: root });
      expect(retried.exitCode).toBeUndefined();
      expect(retried.stderr).toBe("");
      expect(JSON.parse(retried.stdout)).toMatchObject({
        root,
        removedEntries: ["cache", "manifest.json", "server.log"],
      });
      await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fsp.stat(path.join(outer, ".codegraph"))).isDirectory()).toBeTruthy();
    });

    it.each(["directory", "file"] as const)(
      "a nested Git .git %s boundary excludes an initialized parent, then finds its own manifest",
      async (kind) => {
        const parent = await mkTmpDir("cg-life-discover-git-parent-");
        await writeFile(parent, "main.ts", "export const parent = 1;\n");
        const parentManifest = (await initCodegraphLifecycle(parent)).manifest;
        const root = path.join(parent, "nested");
        const cwd = path.join(root, "src", "deep");
        await fsp.mkdir(cwd, { recursive: true });
        await writeFile(root, "src/main.ts", "export const nested = 2;\n");
        await initializeGitRepository(root);
        if (kind === "file") {
          const metadata = path.join(await mkTmpDir("cg-life-discover-git-metadata-"), "repository.git");
          await fsp.rename(path.join(root, ".git"), metadata);
          await writeFile(root, ".git", `gitdir: ${metadata.replace(/\\/g, "/")}\n`);
        }

        for (const start of [root, cwd]) {
          expect(discoverCodegraphLifecycleRoot(start)).toEqual({ status: "ok", projectRootFs: start });
          const status = await captureCli(["status", "--json"], { cwd: start });
          expect(status.exitCode).toBeUndefined();
          expect(status.stderr).toBe("");
          expect(JSON.parse(status.stdout)).toMatchObject({ root: start, initialized: false });
          await expect(fsp.stat(path.join(start, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
        }
        const initialized = await captureCli(["init", "--json", "--no-progress"], { cwd: root });
        expect(initialized.exitCode).toBeUndefined();
        expect(initialized.stderr).toBe("");
        const manifest = (JSON.parse(initialized.stdout) as CodegraphLifecycleSyncResult).manifest;
        expect(JSON.parse(initialized.stdout)).toMatchObject({ root, initialized: true });
        await writeFile(root, "src/extra.ts", "export const extra = 3;\n");

        const refreshed = await captureCli(["init", "--json", "--no-progress"], { cwd });
        expect(refreshed.exitCode).toBeUndefined();
        expect(refreshed.stderr).toBe("");
        expect(JSON.parse(refreshed.stdout)).toMatchObject({
          root,
          manifest: { createdAt: manifest.createdAt, fileCount: 2 },
        });
        for (const start of [root, cwd]) {
          const status = await captureCli(["status", "--json"], { cwd: start });
          expect(status.exitCode).toBeUndefined();
          expect(status.stderr).toBe("");
          expect(JSON.parse(status.stdout)).toMatchObject({ root, initialized: true });
        }
        expect(await readManifest(parent)).toEqual(parentManifest);
        await expect(fsp.stat(path.join(cwd, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it("the nearest initialized nested project wins in a non-Git tree", async () => {
      const parent = await mkTmpDir("cg-life-discover-nearest-");
      await writeFile(parent, "main.ts", "export const parent = 1;\n");
      const parentManifest = (await initCodegraphLifecycle(parent)).manifest;
      const root = path.join(parent, "nested");
      const cwd = path.join(root, "src", "deep");
      await fsp.mkdir(cwd, { recursive: true });
      await writeFile(root, "src/main.ts", "export const nested = 2;\n");
      await initCodegraphLifecycle(root);

      expect(discoverCodegraphLifecycleRoot(root)).toEqual({ status: "ok", projectRootFs: root });
      expect(discoverCodegraphLifecycleRoot(cwd)).toEqual({ status: "ok", projectRootFs: root });
      const status = await captureCli(["status", "--json"], { cwd });
      expect(status.exitCode).toBeUndefined();
      expect(JSON.parse(status.stdout)).toMatchObject({ root, initialized: true });
      const removed = await captureCli(["uninit", "--json"], { cwd });
      expect(removed.exitCode).toBeUndefined();
      expect(JSON.parse(removed.stdout)).toMatchObject({ root, removed: true });
      expect(await readManifest(parent)).toEqual(parentManifest);
      await expect(fsp.stat(codegraphLifecycleManifestPath(root))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fsp.stat(path.join(cwd, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("init in an uninitialized Git repository still initializes the current subfolder, not the Git root", async () => {
      const root = await mkTmpDir("cg-life-discover-uninitialized-git-");
      await initializeGitRepository(root);
      const cwd = path.join(root, "src", "deep");
      await writeFile(cwd, "main.ts", "export const local = 1;\n");

      const result = await captureCli(["init", "--json", "--no-progress"], { cwd });

      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ root: cwd, manifest: { fileCount: 1 } });
      expect((await readManifest(cwd)).fileCount).toBe(1);
      await expect(fsp.stat(codegraphLifecycleManifestPath(root))).rejects.toMatchObject({ code: "ENOENT" });
      // Disk cache anchoring remains independent of the lifecycle project boundary.
      await expectDiskIndexCacheHasArtifacts(root);
      await expect(fsp.stat(path.join(root, "src", ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(["cache only", "server.log only", ".codegraph file", "manifest directory"] as const)(
      "an ancestor with %s does not establish a lifecycle root",
      async (kind) => {
        const root = await mkTmpDir("cg-life-discover-exclusion-");
        const cwd = path.join(root, "src", "deep");
        await fsp.mkdir(cwd, { recursive: true });
        if (kind === "cache only") {
          await writeFile(root, ".codegraph/cache/index-v1/artifact.json", "{}\n");
        } else if (kind === "server.log only") {
          await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
        } else if (kind === ".codegraph file") {
          await writeFile(root, ".codegraph", "not a directory\n");
        } else {
          await fsp.mkdir(codegraphLifecycleManifestPath(root), { recursive: true });
        }

        expect(discoverCodegraphLifecycleRoot(cwd)).toEqual({ status: "ok", projectRootFs: cwd });
        const result = await captureCli(["status", "--json"], { cwd });
        expect(result.exitCode).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({ root: cwd, initialized: false });
        await expect(fsp.stat(path.join(cwd, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it.each(
      (["init", "status", "sync", "uninit"] as const).flatMap((command) =>
        (["positional", "--root"] as const).map((mode) => ({ command, mode })),
      ),
    )("$command with an explicit $mode path bypasses discovery", async ({ command, mode }) => {
      const parent = await mkTmpDir("cg-life-discover-explicit-");
      const cwd = path.join(parent, "src", "deep");
      await writeFile(cwd, "main.ts", "export const nested = 1;\n");
      const parentManifest = (await initCodegraphLifecycle(parent)).manifest;
      const args = [command, "--json"];
      if (mode === "positional") args.push(".");
      else args.push("--root", ".");
      if (command === "sync") args.push("--init");
      if (command === "init" || command === "sync") args.push("--no-progress");

      const result = await captureCli(args, { cwd });

      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as { root: string };
      expect(payload.root).toBe(cwd);
      expect(await readManifest(parent)).toEqual(parentManifest);
      if (command === "init" || command === "sync") {
        expect((await readManifest(cwd)).fileCount).toBe(1);
      } else {
        expect(JSON.parse(result.stdout)).toMatchObject(
          command === "status" ? { initialized: false } : { removed: false },
        );
        await expect(fsp.stat(path.join(cwd, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(fsp.stat(path.join(parent, "src", ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("non-lifecycle commands keep the current directory as their default root", async () => {
      const root = await mkTmpDir("cg-life-discover-non-lifecycle-");
      const cwd = path.join(root, "src", "deep");
      await writeFile(cwd, "local.ts", "export const local = 1;\n");
      await writeFile(root, "parent.ts", "export const parent = 2;\n");
      const manifest = (await initCodegraphLifecycle(root)).manifest;

      const result = await captureCli(["orient", "--budget", "small", "--json"], { cwd });

      expect(result.exitCode).toBeUndefined();
      const payload = JSON.parse(result.stdout) as { root: string; tree: Array<{ path: string }> };
      expect(payload.root).toBe(cwd);
      expect(payload.tree.map((entry) => entry.path)).toContain("local.ts");
      expect(payload.tree.map((entry) => entry.path)).not.toContain("parent.ts");
      expect(await readManifest(root)).toEqual(manifest);
    });
  });

  describe("uninit --purge", () => {
    async function expectAliasedRootPurgeRefusal(linkType: "junction" | "dir"): Promise<void> {
      const root = await mkTmpDir("cg-life-purge-physical-root-");
      const parent = await mkTmpDir("cg-life-purge-root-alias-");
      const alias = path.join(parent, "project");
      await writeFile(root, "main.ts", "export const main = 1;\n");
      const manifest = (await initCodegraphLifecycle(root)).manifest;
      await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
      await fsp.symlink(root, alias, linkType);
      const cwd = path.join(root, ".codegraph", "cache", "index-v1");

      const promise = uninitCodegraphLifecycle(alias, { purge: true, force: true, cwd });
      await expect(promise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
      await expect(promise).rejects.toThrow(`Refusing to purge ${path.join(alias, ".codegraph")} from inside it.`);
      const result = await captureCli(["uninit", "--root", alias, "--purge", "--force", "--json"], { cwd });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Refusing to purge ${path.join(alias, ".codegraph")} from inside it.`);
      expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
      expect(await readManifest(root)).toEqual(manifest);
      await expectDiskIndexCacheHasArtifacts(root);
      expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
      expect((await fsp.lstat(alias)).isSymbolicLink()).toBeTruthy();
    }

    it.runIf(process.platform === "win32")(
      "refuses purge through a junction-aliased --root from the physical cache",
      async () => {
        await expectAliasedRootPurgeRefusal("junction");
      },
    );

    it.runIf(process.platform !== "win32")(
      "refuses purge through a symlinked --root from the physical cache",
      async () => {
        await expectAliasedRootPurgeRefusal("dir");
      },
    );

    it.runIf(process.platform === "win32")(
      "refuses purge across drive and accessible UNC administrative-share spellings",
      async (context) => {
        const root = await mkTmpDir("cg-life-purge-unc-identity-");
        const driveRoot = path.win32.parse(root).root;
        expect(driveRoot).toMatch(/^[A-Za-z]:\\$/);
        const share = `\\\\localhost\\${driveRoot[0]}$`;
        try {
          await fsp.stat(share);
        } catch {
          context.skip();
        }
        const uncRoot = share + root.slice(2).replaceAll("/", "\\");
        expect((await fsp.stat(uncRoot)).isDirectory()).toBeTruthy();
        await writeFile(root, "main.ts", "export const main = 1;\n");
        const manifest = (await initCodegraphLifecycle(root)).manifest;
        await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
        const cases = [
          { projectRoot: uncRoot, cwd: path.join(root, ".codegraph", "cache", "index-v1") },
          { projectRoot: root, cwd: path.join(uncRoot, ".codegraph", "cache", "index-v1") },
        ];

        for (const { projectRoot, cwd } of cases) {
          const promise = uninitCodegraphLifecycle(projectRoot, { purge: true, force: true, cwd });
          await expect(promise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
          await expect(promise).rejects.toThrow(
            `Refusing to purge ${path.join(projectRoot, ".codegraph")} from inside it.`,
          );
          const result = await captureCli(["uninit", "--root", projectRoot, "--purge", "--force", "--json"], { cwd });
          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain(`Refusing to purge ${path.join(projectRoot, ".codegraph")} from inside it.`);
          expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
          expect(await readManifest(root)).toEqual(manifest);
          await expectDiskIndexCacheHasArtifacts(root);
          expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
        }
      },
    );

    it("refuses --purge --force from a ..cache child without removing anything", async () => {
      const root = await mkTmpDir("cg-life-purge-dot-prefix-");
      await writeFile(root, "main.ts", "export const main = 1;\n");
      const manifest = (await initCodegraphLifecycle(root)).manifest;
      await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
      const cwd = path.join(root, ".codegraph", "..cache");
      await writeFile(cwd, "sentinel.txt", "operator data\n");

      const result = await captureCli(["uninit", "--purge", "--force", "--json"], { cwd });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Refusing to purge ${path.join(root, ".codegraph")} from inside it.`);
      expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
      expect(await readManifest(root)).toEqual(manifest);
      await expectDiskIndexCacheHasArtifacts(root);
      expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
      expect(await fsp.readFile(path.join(cwd, "sentinel.txt"), "utf8")).toBe("operator data\n");
    });

    it.each(["library", "CLI"] as const)(
      "%s purge reports a newly written server.json instead of reporting success",
      async (consumer) => {
        const root = await mkTmpDir("cg-life-purge-concurrent-entry-");
        await writeFile(root, "main.ts", "export const main = 1;\n");
        await initCodegraphLifecycle(root);
        await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
        const cache = path.join(root, ".codegraph", "cache");
        const registry = path.join(root, ".codegraph", "server.json");
        const originalRm = fsp.rm.bind(fsp);
        vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
          await originalRm(target, options);
          if (target === cache) await fsp.writeFile(registry, '{"owner":"new"}\n', "utf8");
        });

        if (consumer === "library") {
          const promise = uninitCodegraphLifecycle(root, { purge: true, force: true, cwd: root });
          await expect(promise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
          await expect(promise).rejects.toThrow("unexpected entries remain: server.json");
        } else {
          const result = await captureCli(["uninit", "--purge", "--force", "--json"], { cwd: root });
          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("unexpected entries remain: server.json");
          expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
        }
        expect(await fsp.readdir(path.join(root, ".codegraph"))).toEqual(["server.json"]);
        expect(await fsp.readFile(registry, "utf8")).toBe('{"owner":"new"}\n');
        for (const entry of ["cache", "manifest.json", "server.log"]) {
          await expect(fsp.stat(path.join(root, ".codegraph", entry))).rejects.toMatchObject({ code: "ENOENT" });
        }
      },
    );

    it("purges every local cache namespace but leaves a separately configured disk cache intact", async () => {
      const root = await mkTmpDir("cg-life-purge-cache-scope-");
      const external = await mkTmpDir("cg-life-purge-external-cache-");
      await writeFile(root, "main.ts", "export const main = 1;\n");
      await initCodegraphLifecycle(root);
      await expectDiskIndexCacheHasArtifacts(root);
      await writeFile(root, ".codegraph/cache/project-other/sentinel.txt", "other project cache\n");
      await initCodegraphLifecycle(root, { force: true, buildOptions: { cacheDir: external } });
      const externalCache = resolveCacheLocation(root, { cacheDir: external }).path;
      const externalEntries = await fsp.readdir(externalCache);
      expect(externalEntries.length).toBeGreaterThan(0);

      const result = await captureCli(["uninit", "--purge", "--json"], { cwd: root });

      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        root,
        removed: true,
        removedEntries: ["cache", "manifest.json"],
      });
      await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fsp.readdir(externalCache)).toEqual(externalEntries);
      expect(await fsp.readFile(path.join(root, "main.ts"), "utf8")).toBe("export const main = 1;\n");
    });

    it.each(["state", "cache", "project", "unrelated", "prefix sibling"] as const)(
      "library purge honors its cwd option for the %s directory",
      async (location) => {
        const root = await mkTmpDir("cg-life-purge-library-cwd-");
        await writeFile(root, "src/main.ts", "export const main = 1;\n");
        const manifest = (await initCodegraphLifecycle(root)).manifest;
        await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
        let cwd = root;
        if (location === "state") cwd = path.join(root, ".codegraph");
        else if (location === "cache") cwd = path.join(root, ".codegraph", "cache", "index-v1");
        else if (location === "unrelated") cwd = await mkTmpDir("cg-life-purge-unrelated-cwd-");
        else if (location === "prefix sibling") {
          cwd = path.join(root, ".codegraph-other");
          await fsp.mkdir(cwd);
        }
        const cwdIsInState = location === "state" || location === "cache";

        const promise = uninitCodegraphLifecycle(root, { purge: true, force: true, cwd });

        if (cwdIsInState) {
          await expect(promise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
          await expect(promise).rejects.toThrow(
            `Refusing to purge ${path.join(root, ".codegraph")} from inside it. Run cd "${root}" and rerun codegraph uninit --purge.`,
          );
          expect(await readManifest(root)).toEqual(manifest);
          await expectDiskIndexCacheHasArtifacts(root);
          expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
        } else {
          await expect(promise).resolves.toMatchObject({
            root,
            removed: true,
            removedEntries: ["cache", "manifest.json", "server.log"],
          });
          await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect((await fsp.stat(cwd)).isDirectory()).toBeTruthy();
        expect(await fsp.readFile(path.join(root, "src", "main.ts"), "utf8")).toBe("export const main = 1;\n");
      },
    );

    it("library purge defaults cwd to the real process current directory and refuses without deleting state", async () => {
      const root = await mkTmpDir("cg-life-purge-default-cwd-");
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      const manifest = (await initCodegraphLifecycle(root)).manifest;
      await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
      const previousCwd = process.cwd();
      try {
        process.chdir(path.join(root, ".codegraph", "cache", "index-v1"));
        const promise = uninitCodegraphLifecycle(root, { purge: true });
        await expect(promise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
        await expect(promise).rejects.toThrow(`Refusing to purge ${path.join(root, ".codegraph")} from inside it.`);
        await expect(promise).rejects.toThrow(`Run cd "${root}"`);
      } finally {
        process.chdir(previousCwd);
      }
      expect(await readManifest(root)).toEqual(manifest);
      await expectDiskIndexCacheHasArtifacts(root);
      expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
    });

    it.runIf(process.platform === "win32")(
      "library purge recognizes a differently cased cwd inside .codegraph",
      async () => {
        const root = await mkTmpDir("cg-life-purge-case-cwd-");
        await writeFile(root, "src/main.ts", "export const main = 1;\n");
        const manifest = (await initCodegraphLifecycle(root)).manifest;
        await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
        const cwd = path.join(root, ".codegraph", "cache", "index-v1").toUpperCase();

        await expect(uninitCodegraphLifecycle(root, { purge: true, cwd })).rejects.toThrow(
          `Refusing to purge ${path.join(root, ".codegraph")} from inside it.`,
        );

        expect(await readManifest(root)).toEqual(manifest);
        await expectDiskIndexCacheHasArtifacts(root);
        expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
      },
    );

    it("the built CLI refuses purge from a real cache cwd without removing state, then purges from the project root", async () => {
      const bundledCli = fileURLToPath(new URL("../dist/bin/cli.js", import.meta.url));
      expect((await fsp.stat(bundledCli)).isFile()).toBeTruthy();
      const root = await mkTmpDir("cg-life-purge-built-cwd-");
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      const manifest = (await initCodegraphLifecycle(root)).manifest;
      await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
      await expectDiskIndexCacheHasArtifacts(root);
      const cwd = path.join(root, ".codegraph", "cache", "index-v1");

      const result = spawnSync(process.execPath, [bundledCli, "uninit", "--purge", "--json"], {
        windowsHide: true,
        cwd,
        encoding: "utf8",
        env: process.env,
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      });

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Refusing to purge ${path.join(root, ".codegraph")} from inside it.`);
      expect(result.stderr).toContain(`Run cd "${root}" and rerun codegraph uninit --purge.`);
      expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
      expect(await readManifest(root)).toEqual(manifest);
      await expectDiskIndexCacheHasArtifacts(root);
      expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
      await expect(fsp.stat(path.join(cwd, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });

      const retried = spawnSync(process.execPath, [bundledCli, "uninit", "--purge", "--json"], {
        windowsHide: true,
        cwd: root,
        encoding: "utf8",
        env: process.env,
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(retried.error).toBeUndefined();
      expect(retried.status, retried.stderr).toBe(0);
      expect(JSON.parse(retried.stdout)).toMatchObject({
        root,
        removed: true,
        removedEntries: ["cache", "manifest.json", "server.log"],
      });
      await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(["--json", "--pretty"])(
      "removes real disk artifacts and logs with %s output, leaving the ignore rule",
      async (format) => {
        const root = await mkTmpDir("cg-life-purge-artifacts-");
        await initializeGitRepository(root);
        await writeFile(root, "src/main.ts", "export const main = 1;\n");
        await initCodegraphLifecycle(root);
        await expectDiskIndexCacheHasArtifacts(root);
        await writeFile(root, ".codegraph/server.log", "server diagnostics\n");

        const result = await captureCli(["uninit", "--purge", format], { cwd: root });

        expect(result.exitCode).toBeUndefined();
        expect(result.stderr).toBe("");
        if (format === "--json") {
          expect(JSON.parse(result.stdout)).toEqual({
            schemaVersion: 1,
            root,
            removed: true,
            removedEntries: ["cache", "manifest.json", "server.log"],
            manifestPath: codegraphLifecycleManifestPath(root),
          });
        } else {
          expect(result.stdout).toBe(`Purged Codegraph state at ${root}: cache, manifest.json, server.log.\n`);
        }
        await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fsp.readFile(path.join(root, ".gitignore"), "utf8")).toBe(".codegraph/\n");
        expect(await fsp.readFile(path.join(root, "src", "main.ts"), "utf8")).toBe("export const main = 1;\n");
      },
    );

    it.each([false, true])("refuses server.json before deleting anything, including force=%s", async (force) => {
      const root = await mkTmpDir("cg-life-purge-server-");
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      const manifest = (await initCodegraphLifecycle(root)).manifest;
      await writeFile(root, ".codegraph/server.json", "{}\n");
      await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
      const cacheRoot = path.join(root, ".codegraph", "cache", "index-v1");
      const cacheEntries = await fsp.readdir(cacheRoot);
      const promise = uninitCodegraphLifecycle(root, { purge: true, force });
      await expect(promise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
      await expect(promise).rejects.toThrow("codegraph server stop");

      const args = ["uninit", "--purge", "--json"];
      if (force) args.push("--force");
      const result = await captureCli(args, { cwd: root });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("codegraph server stop");
      expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
      expect(await readManifest(root)).toEqual(manifest);
      expect(await readCodegraphEntries(root)).toEqual(["manifest.json", "server.json", "server.log"]);
      expect(await fsp.readFile(path.join(root, ".codegraph", "server.json"), "utf8")).toBe("{}\n");
      expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
      expect(await fsp.readdir(cacheRoot)).toEqual(cacheEntries);
      await expectDiskIndexCacheHasArtifacts(root);
    });

    it.runIf(process.platform === "win32")(
      "respects case-insensitive server.json existence before forced purge",
      async () => {
        const root = await mkTmpDir("cg-life-purge-server-case-");
        await writeFile(root, "src/main.ts", "export const main = 1;\n");
        const manifest = (await initCodegraphLifecycle(root)).manifest;
        await writeFile(root, ".codegraph/SERVER.JSON", "{}\n");
        await writeFile(root, ".codegraph/server.log", "server diagnostics\n");

        const result = await captureCli(["uninit", "--purge", "--force"], { cwd: root });

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("codegraph server stop");
        expect(await readManifest(root)).toEqual(manifest);
        await expectDiskIndexCacheHasArtifacts(root);
        expect(await fsp.readFile(path.join(root, ".codegraph", "SERVER.JSON"), "utf8")).toBe("{}\n");
        expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
      },
    );

    it("refuses unknown entries before deleting anything, then --force purges them recursively", async () => {
      const root = await mkTmpDir("cg-life-purge-unknown-");
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      const manifest = (await initCodegraphLifecycle(root)).manifest;
      await writeFile(root, ".codegraph/operator/note.txt", "operator data\n");
      await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
      await expect(uninitCodegraphLifecycle(root, { purge: true })).rejects.toThrow("unknown entries: operator");

      const refused = await captureCli(["uninit", "--purge", "--json"], { cwd: root });
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("unknown entries: operator");
      expect(refused.stderr).toContain("--force");
      expect(await readManifest(root)).toEqual(manifest);
      await expectDiskIndexCacheHasArtifacts(root);
      expect(await readCodegraphEntries(root)).toEqual(["manifest.json", "operator", "server.log"]);
      expect(await fsp.readFile(path.join(root, ".codegraph", "operator", "note.txt"), "utf8")).toBe("operator data\n");
      expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");

      const result = await captureCli(["uninit", "--purge", "--force", "--json"], { cwd: root });
      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        root,
        removed: true,
        removedEntries: ["cache", "manifest.json", "operator", "server.log"],
      });
      await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(["missing", "empty"])("reports not initialized for a %s .codegraph directory with exit 0", async (kind) => {
      const root = await mkTmpDir("cg-life-purge-empty-");
      if (kind === "empty") await fsp.mkdir(path.join(root, ".codegraph"));

      const libraryResult = await uninitCodegraphLifecycle(root, { purge: true });
      expect(libraryResult).toMatchObject({ root, removed: false, removedEntries: [] });
      const result = await captureCli(["uninit", "--purge"], { cwd: root });
      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`Codegraph is not initialized at ${root}.\n`);
      await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses a symlinked .codegraph even with --purge --force without touching the target", async () => {
      const root = await mkTmpDir("cg-life-purge-symlink-root-");
      const external = await mkTmpDir("cg-life-purge-symlink-external-");
      await writeFile(external, "sentinel.txt", "operator data\n");
      await fsp.symlink(external, path.join(root, ".codegraph"), process.platform === "win32" ? "junction" : "dir");

      await expect(uninitCodegraphLifecycle(root, { purge: true, force: true })).rejects.toThrow(
        "Refusing to traverse symbolic link as .codegraph lifecycle directory",
      );
      const result = await captureCli(["uninit", "--purge", "--force"], { cwd: root });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Refusing to traverse symbolic link");
      expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
      expect((await fsp.lstat(path.join(root, ".codegraph"))).isSymbolicLink()).toBeTruthy();
      expect(await fsp.readFile(path.join(external, "sentinel.txt"), "utf8")).toBe("operator data\n");
    });

    it.each(["cache", "cache/index-v1/external"])(
      "removes the %s link without traversing its external target",
      async (entry) => {
        const root = await mkTmpDir("cg-life-purge-cache-link-");
        const external = await mkTmpDir("cg-life-purge-cache-target-");
        await writeFile(root, "src/main.ts", "export const main = 1;\n");
        await initCodegraphLifecycle(root);
        await expectDiskIndexCacheHasArtifacts(root);
        await writeFile(external, "sentinel.txt", "operator data\n");
        const link = path.join(root, ".codegraph", entry);
        if (entry === "cache") await fsp.rm(link, { recursive: true, force: true });
        await fsp.symlink(external, link, process.platform === "win32" ? "junction" : "dir");

        const result = await captureCli(["uninit", "--purge", "--json"], { cwd: root });

        expect(result.exitCode).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({ removed: true, removedEntries: ["cache", "manifest.json"] });
        await expect(fsp.lstat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fsp.stat(external)).isDirectory()).toBeTruthy();
        expect(await fsp.readdir(external)).toEqual(["sentinel.txt"]);
        expect(await fsp.readFile(path.join(external, "sentinel.txt"), "utf8")).toBe("operator data\n");
      },
    );

    it.each(["EBUSY", "EPERM", "EACCES"])(
      "continues removing other entries after %s, lists remaining paths, and allows retry",
      async (code) => {
        const root = await mkTmpDir("cg-life-purge-in-use-");
        await writeFile(root, "src/main.ts", "export const main = 1;\n");
        await initCodegraphLifecycle(root);
        await writeFile(root, ".codegraph/operator/note.txt", "operator data\n");
        await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
        const cachePath = path.join(root, ".codegraph", "cache");
        const blockedPaths = [cachePath];
        if (code === "EBUSY") blockedPaths.push(path.join(root, ".codegraph", "server.log"));
        const originalRm = fsp.rm.bind(fsp);
        const rmSpy = vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
          if (blockedPaths.includes(String(target))) throw Object.assign(new Error("file in use"), { code });
          return await originalRm(target, options);
        });

        const promise = uninitCodegraphLifecycle(root, { purge: true, force: true });
        await expect(promise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
        for (const blockedPath of blockedPaths) await expect(promise).rejects.toThrow(blockedPath);
        await expect(promise).rejects.toThrow(
          "may be in use by another process (for example a Codegraph MCP server for this project) or not writable",
        );
        await expect(promise).rejects.toThrow("Stop it or make the paths writable and rerun codegraph uninit --purge");
        await expectDiskIndexCacheHasArtifacts(root);
        await expect(fsp.stat(codegraphLifecycleManifestPath(root))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fsp.stat(path.join(root, ".codegraph", "operator"))).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fsp.readdir(path.join(root, ".codegraph"))).sort()).toEqual(
          blockedPaths.map((target) => path.basename(target)).sort(),
        );

        const result = await captureCli(["uninit", "--purge", "--force"], { cwd: root });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        for (const blockedPath of blockedPaths) expect(result.stderr).toContain(blockedPath);
        expect(result.stderr).toContain(
          "may be in use by another process (for example a Codegraph MCP server for this project) or not writable",
        );
        expect(result.stderr).not.toMatch(/^Error:|\n\s+at /m);
        rmSpy.mockRestore();

        const retried = await uninitCodegraphLifecycle(root, { purge: true });
        expect(retried.removedEntries).toEqual(blockedPaths.map((target) => path.basename(target)).sort());
        await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it("reports an in-use .codegraph directory after removing all its entries", async () => {
      const root = await mkTmpDir("cg-life-purge-rmdir-in-use-");
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      await initCodegraphLifecycle(root);
      const dir = path.join(root, ".codegraph");
      const originalRmdir = fsp.rmdir.bind(fsp);
      const spy = vi.spyOn(fsp, "rmdir").mockImplementation(async (target, options) => {
        if (target === dir) throw Object.assign(new Error("directory in use"), { code: "EACCES" });
        return await originalRmdir(target, options);
      });

      const result = await captureCli(["uninit", "--purge"], { cwd: root });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`these paths remain: ${dir}`);
      expect(result.stderr).toContain(
        "may be in use by another process (for example a Codegraph MCP server for this project) or not writable",
      );
      expect(await fsp.readdir(dir)).toEqual([]);
      spy.mockRestore();
      await uninitCodegraphLifecycle(root, { purge: true });
      await expect(fsp.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("keeps the existing lifecycle wrapping for removal errors other than files in use", async () => {
      const root = await mkTmpDir("cg-life-purge-io-error-");
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      const manifest = (await initCodegraphLifecycle(root)).manifest;
      const manifestPath = codegraphLifecycleManifestPath(root);
      const originalRm = fsp.rm.bind(fsp);
      vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
        if (target === manifestPath) throw Object.assign(new Error("disk I/O failure"), { code: "EIO" });
        return await originalRm(target, options);
      });

      const promise = uninitCodegraphLifecycle(root, { purge: true });
      await expect(promise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
      await expect(promise).rejects.toThrow(`Unable to remove ${manifestPath}: disk I/O failure`);
      const result = await captureCli(["uninit", "--purge"], { cwd: root });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`Unable to remove ${manifestPath}: disk I/O failure`);
      expect(result.stderr).not.toMatch(/another process|^Error:|\n\s+at /m);
      expect(await readManifest(root)).toEqual(manifest);
    });

    it.each([false, true])("without --purge preserves cache, registry, and log with force=%s", async (force) => {
      const root = await mkTmpDir("cg-life-uninit-preserve-state-");
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      await initCodegraphLifecycle(root);
      await writeFile(root, ".codegraph/server.json", "{}\n");
      await writeFile(root, ".codegraph/server.log", "server diagnostics\n");
      const args = ["uninit"];
      if (force) {
        args.push("--force");
        await writeFile(root, ".codegraph/operator/note.txt", "operator data\n");
      }

      const result = await captureCli(args, { cwd: root });

      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`Removed Codegraph lifecycle state at ${root}.\n`);
      await expectDiskIndexCacheHasArtifacts(root);
      expect(await readCodegraphEntries(root)).toEqual(["server.json", "server.log"]);
      expect(await fsp.readFile(path.join(root, ".codegraph", "server.json"), "utf8")).toBe("{}\n");
      expect(await fsp.readFile(path.join(root, ".codegraph", "server.log"), "utf8")).toBe("server diagnostics\n");
    });
  });

  it("CLI JSON captures cover lifecycle mutating commands with positional roots", async () => {
    const initRoot = await mkTmpDir("cg-life-cli-init-");
    await writeFile(initRoot, "src/main.ts", "export const main = 1;\n");

    const initResult = await captureCli(["init", initRoot, "--force", "--json", "--no-progress"]);

    expect(initResult.exitCode).toBeUndefined();
    expect(initResult.stderr).toBe("");
    const initPayload = JSON.parse(initResult.stdout) as CodegraphLifecycleSyncResult;
    expect(initPayload.root).toBe(initRoot);
    expect(initPayload.initialized).toBeTruthy();
    expect(initPayload.manifest.fileCount).toBe(1);
    expect(await readCodegraphEntries(initRoot)).toEqual(["manifest.json"]);

    const syncRoot = await mkTmpDir("cg-life-cli-sync-");
    await writeFile(syncRoot, "src/main.ts", "export const main = 1;\n");

    const syncInitResult = await captureCli(["sync", syncRoot, "--init", "--json", "--no-progress"]);

    expect(syncInitResult.exitCode).toBeUndefined();
    expect(syncInitResult.stderr).toBe("");
    const syncInitPayload = JSON.parse(syncInitResult.stdout) as CodegraphLifecycleSyncResult;
    expect(syncInitPayload.root).toBe(syncRoot);
    expect(syncInitPayload.initialized).toBeTruthy();
    expect(syncInitPayload.manifest.fileCount).toBe(1);
    expect(await readCodegraphEntries(syncRoot)).toEqual(["manifest.json"]);

    await writeFile(syncRoot, "src/extra.ts", "export const extra = 2;\n");
    const syncResult = await captureCli(["sync", syncRoot, "--json", "--no-progress"]);

    expect(syncResult.exitCode).toBeUndefined();
    expect(syncResult.stderr).toBe("");
    const syncPayload = JSON.parse(syncResult.stdout) as CodegraphLifecycleSyncResult;
    expect(syncPayload.root).toBe(syncRoot);
    expect(syncPayload.manifest.fileCount).toBe(2);
    expect(syncPayload.changedFiles.added).toBe(1);
    expect(await readCodegraphEntries(syncRoot)).toEqual(["manifest.json"]);

    const uninitResult = await captureCli(["uninit", syncRoot, "--force", "--json"]);

    expect(uninitResult.exitCode).toBeUndefined();
    expect(uninitResult.stderr).toBe("");
    const uninitPayload = JSON.parse(uninitResult.stdout) as CodegraphLifecycleUninitResult;
    expect(uninitPayload.root).toBe(syncRoot);
    expect(uninitPayload.removed).toBeTruthy();
    await expectDiskIndexCacheHasArtifacts(syncRoot);
  });

  it("CLI JSON and pretty output expose only initializing ignore-policy outcomes", async () => {
    const jsonRoot = await mkTmpDir("cg-life-cli-gitignore-json-");
    await initializeGitRepository(jsonRoot);
    await writeFile(jsonRoot, "src/main.ts", "export const main = 1;\n");

    const jsonResult = await captureCli(["init", jsonRoot, "--json"]);

    expect(jsonResult.exitCode).toBeUndefined();
    const payload = JSON.parse(jsonResult.stdout) as CodegraphLifecycleSyncResult;
    expect(payload.gitignore).toEqual({
      status: "added",
      path: ".gitignore",
      rules: [".codegraph/"],
    });

    const prettyRoot = await mkTmpDir("cg-life-cli-gitignore-pretty-");
    await initializeGitRepository(prettyRoot);
    await writeFile(prettyRoot, "src/main.ts", "export const main = 1;\n");
    const prettyResult = await captureCli(["init", prettyRoot]);
    expect(prettyResult.stdout).toContain(`Updated Git ignore policy at ${path.join(prettyRoot, ".gitignore")}`);
    expect(prettyResult.stdout).toContain("added .codegraph/");

    const trackedRoot = await mkTmpDir("cg-life-cli-gitignore-tracked-");
    await initializeGitRepository(trackedRoot);
    await writeFile(trackedRoot, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(trackedRoot, { updateGitignore: false });
    await execFileAsync("git", ["add", "--", ".codegraph/manifest.json"], { windowsHide: true, cwd: trackedRoot });
    const trackedResult = await captureCli(["init", trackedRoot]);
    expect(trackedResult.stdout).toContain("Warning: .codegraph/manifest.json is tracked by Git");

    const ordinary = await captureCli(["sync", jsonRoot, "--json"]);
    expect((JSON.parse(ordinary.stdout) as CodegraphLifecycleSyncResult).gitignore).toBeUndefined();

    const help = await captureCli(["init", "--help"]);
    expect(help.stdout).toContain("--no-update-gitignore");
    expect(help.stdout).toContain("sync --init");
  });

  it("CLI lifecycle commands reject positional roots when --root is supplied", async () => {
    const commands = ["init", "status", "sync", "uninit"] as const;

    for (const command of commands) {
      const cwd = await mkTmpDir(`cg-life-cli-root-conflict-${command}-`);
      const positionalRoot = path.join(cwd, "positional-root");
      const flagRoot = path.join(cwd, "flag-root");
      await fsp.mkdir(positionalRoot);
      await fsp.mkdir(flagRoot);
      const args = [command, positionalRoot, "--root", flagRoot, "--json"];
      if (command === "sync") args.push("--init");
      if (command === "uninit") args.push("--force");

      const result = await captureCli(args, { cwd });

      expect(result.exitCode, `${command} should reject a positional path combined with --root`).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(command);
      expect(result.stderr).toContain(positionalRoot);
      expect(result.stderr).toContain("--root");
      expect(result.stderr).toMatch(/positional/i);
    }
  });

  it("CLI lifecycle mutating commands honor --root without a positional path", async () => {
    const commands = ["init", "sync", "uninit"] as const;

    for (const command of commands) {
      const cwd = await mkTmpDir(`cg-life-cli-root-success-${command}-cwd-`);
      const flagRoot = await mkTmpDir(`cg-life-cli-root-success-${command}-root-`);
      await writeFile(flagRoot, "src/main.ts", "export const main = 1;\n");
      if (command === "uninit") {
        await initCodegraphLifecycle(flagRoot);
        expect(await readCodegraphEntries(flagRoot)).toEqual(["manifest.json"]);
      }

      const args = [command, "--root", flagRoot, "--json"];
      if (command === "sync") args.push("--init");
      if (command === "uninit") args.push("--force");
      if (command === "init" || command === "sync") args.push("--no-progress");

      const result = await captureCli(args, { cwd });

      expect(result.exitCode, `${command} --root should succeed`).toBeUndefined();
      expect(result.stderr, command).toBe("");

      if (command === "uninit") {
        const payload = JSON.parse(result.stdout) as CodegraphLifecycleUninitResult;
        expect(payload.root, command).toBe(flagRoot);
        expect(payload.removed, command).toBeTruthy();
        await expectDiskIndexCacheHasArtifacts(flagRoot);
      } else {
        const payload = JSON.parse(result.stdout) as CodegraphLifecycleSyncResult;
        expect(payload.root, command).toBe(flagRoot);
        expect(payload.initialized, command).toBeTruthy();
        expect(payload.manifest.fileCount, command).toBe(1);
        expect(await readCodegraphEntries(flagRoot)).toEqual(["manifest.json"]);
      }

      await expect(fsp.stat(path.join(cwd, ".codegraph")), `${command} must not touch cwd`).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("CLI status --root reports the flag root's lifecycle state regardless of cwd", async () => {
    const cwd = await mkTmpDir("cg-life-cli-root-success-status-cwd-");
    const flagRoot = await mkTmpDir("cg-life-cli-root-success-status-root-");
    await writeFile(flagRoot, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(flagRoot);

    const result = await captureCli(["status", "--root", flagRoot, "--json"], { cwd });

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as CodegraphLifecycleStatus;
    expect(payload.root).toBe(flagRoot);
    expect(payload.initialized).toBeTruthy();
    expect(payload.fileCount).toEqual({ then: 1, current: 1 });
    expect(payload.suggestedNextCommand).toBe("codegraph status");
  });

  it("CLI status --json reports initialized and uninitialized lifecycle state", async () => {
    const uninitializedRoot = await mkTmpDir("cg-life-cli-status-uninitialized-");
    await writeFile(uninitializedRoot, "src/main.ts", "export const main = 1;\n");

    const uninitializedResult = await captureCli(["status", uninitializedRoot, "--json"]);

    expect(uninitializedResult.exitCode).toBeUndefined();
    expect(uninitializedResult.stderr).toBe("");
    const uninitializedPayload = JSON.parse(uninitializedResult.stdout) as CodegraphLifecycleStatus;
    expect(uninitializedPayload.schemaVersion).toBe(1);
    expect(uninitializedPayload.root).toBe(uninitializedRoot);
    expect(uninitializedPayload.initialized).toBeFalsy();
    expect(uninitializedPayload.fileCount).toBeUndefined();
    expect(uninitializedPayload.suggestedNextCommand).toBe("codegraph init");

    const initializedRoot = await mkTmpDir("cg-life-cli-status-initialized-");
    await writeFile(initializedRoot, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(initializedRoot);

    const initializedResult = await captureCli(["status", initializedRoot, "--json"]);

    expect(initializedResult.exitCode).toBeUndefined();
    expect(initializedResult.stderr).toBe("");
    const initializedPayload = JSON.parse(initializedResult.stdout) as CodegraphLifecycleStatus;
    expect(initializedPayload.schemaVersion).toBe(1);
    expect(initializedPayload.root).toBe(initializedRoot);
    expect(initializedPayload.initialized).toBeTruthy();
    expect(initializedPayload.fileCount).toEqual({ then: 1, current: 1 });
    expect(initializedPayload.suggestedNextCommand).toBe("codegraph status");
  });

  it("CLI lifecycle user errors fail cleanly without stack traces", async () => {
    const syncRoot = await mkTmpDir("cg-life-cli-sync-user-error-");
    await writeFile(syncRoot, "src/main.ts", "export const main = 1;\n");

    const syncResult = await captureCli(["sync", syncRoot, "--json"]);

    expect(syncResult.exitCode).toBe(1);
    expect(syncResult.stdout).toBe("");
    expect(syncResult.stderr).toContain("not initialized");
    expect(syncResult.stderr).toContain("codegraph init");
    expect(syncResult.stderr).not.toMatch(/^Error:/m);
    expect(syncResult.stderr).not.toMatch(/\n\s+at /);

    const uninitRoot = await mkTmpDir("cg-life-cli-uninit-user-error-");
    await writeFile(uninitRoot, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(uninitRoot);
    await fsp.writeFile(path.join(uninitRoot, ".codegraph", "operator-note.txt"), "operator data\n", "utf8");

    const uninitResult = await captureCli(["uninit", uninitRoot, "--json"]);

    expect(uninitResult.exitCode).toBe(1);
    expect(uninitResult.stdout).toBe("");
    expect(uninitResult.stderr).toContain("unknown entries");
    expect(uninitResult.stderr).toContain("operator-note.txt");
    expect(uninitResult.stderr).toContain("--force");
    expect(uninitResult.stderr).not.toMatch(/^Error:/m);
    expect(uninitResult.stderr).not.toMatch(/\n\s+at /);
  });

  it("CLI lifecycle commands reject invalid positional roots instead of falling back to cwd", async () => {
    const commands = ["init", "status", "sync", "uninit"] as const;

    for (const command of commands) {
      const cwd = await mkTmpDir(`cg-life-cli-invalid-${command}-`);
      const invalidRoot = path.join(cwd, "missing-root");
      const args = [command, invalidRoot, "--json"];
      if (command === "sync") args.push("--init");
      if (command === "uninit") args.push("--force");

      const result = await captureCli(args, { cwd });

      expect(result.exitCode, `${command} should reject a missing positional root`).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(command);
      expect(result.stderr).toContain(invalidRoot);
    }
  });

  it("status short-circuits without hashing config or discovering files when uninitialized", async () => {
    const root = await mkTmpDir("cg-life-status-short-circuit-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");

    const configHashSpy = vi.spyOn(indexerManifest, "computeConfigHash");
    const listFilesSpy = vi.spyOn(agentSession, "listAgentSessionFiles");

    const status = await getCodegraphLifecycleStatus(root);

    expect(status.initialized).toBeFalsy();
    expect(configHashSpy).not.toHaveBeenCalled();
    expect(listFilesSpy).not.toHaveBeenCalled();
  });

  it("status treats an mtime-only rewrite as a file change even with byte-identical content", async () => {
    const root = await mkTmpDir("cg-life-status-mtime-");
    const relativePath = "src/main.ts";
    const content = "export const main = 1;\n";
    await writeFile(root, relativePath, content);
    await initCodegraphLifecycle(root);

    const initialStatus = await getCodegraphLifecycleStatus(root);
    expect(initialStatus.filesChanged).toBeFalsy();

    const filePath = path.join(root, relativePath);
    const originalStat = await fsp.stat(filePath);
    const futureDate = new Date(originalStat.mtime.getTime() + 60_000);
    await fsp.writeFile(filePath, content, "utf8");
    await fsp.utimes(filePath, futureDate, futureDate);

    const status = await getCodegraphLifecycleStatus(root);

    expect(status.filesChanged).toBeTruthy();
  });

  it("stableStringify omits undefined object values and disambiguates undefined array elements from empty arrays", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe(stableStringify({ b: 1 }));
    expect(stableStringify({ b: 1 })).toBe('{"b":1}');

    expect(stableStringify([])).not.toBe(stableStringify([undefined]));
    expect(stableStringify([undefined])).toBe("[null]");

    expect(stableStringify({ preset: undefined })).not.toContain("undefined");
  });

  it("stableStringify is total: top-level undefined, sparse arrays, and non-JSON leaves never yield the JS undefined value", () => {
    // 1. Top-level undefined must serialize to the real string "null", not the JS value undefined.
    expect(typeof stableStringify(undefined)).toBe("string");
    expect(stableStringify(undefined)).toBe("null");

    // 2. Sparse arrays (holes) must be read by index like JSON.stringify does, not silently
    // skipped by map/join, so they no longer collide with a true empty array.
    expect(stableStringify(new Array(1))).toBe("[null]"); // JSON.stringify(new Array(1)) === '[null]'
    expect(stableStringify(new Array(1))).not.toBe(stableStringify([]));
    expect(stableStringify(new Array(1))).toBe(stableStringify([undefined]));

    // 3. Leaves where JSON.stringify itself returns the JS value undefined (functions, symbols)
    // must still produce a real "null" string, never crash or leak undefined.
    expect(JSON.stringify(() => {})).toBeUndefined();
    expect(JSON.stringify(Symbol("x"))).toBeUndefined();
    expect(typeof stableStringify(() => {})).toBe("string");
    expect(stableStringify(() => {})).toBe("null");
    expect(stableStringify(Symbol("x"))).toBe("null");

    // 4. The same totality fix must apply recursively to nested object values, not just at the
    // top level or inside arrays.
    expect(stableStringify({ a: () => {} })).toContain('"a":null');
  });

  it("init cleans up its hidden temp manifest file when fs.rename fails", async () => {
    const root = await mkTmpDir("cg-life-write-failure-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");

    const manifestPath = codegraphLifecycleManifestPath(root);
    const renameError = new Error("injected rename failure");
    const realRename = fsp.rename.bind(fsp);
    const renameSpy = vi.spyOn(fsp, "rename").mockImplementation(async (oldPath, newPath) => {
      if (newPath === manifestPath) {
        throw renameError;
      }
      return realRename(oldPath, newPath);
    });

    await expect(initCodegraphLifecycle(root)).rejects.toThrow("injected rename failure");

    renameSpy.mockRestore();

    const entries = await fsp.readdir(path.join(root, ".codegraph"));
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("surfaces a non-ENOENT manifest read failure as CodegraphLifecycleUserError, not a raw Error", async () => {
    const root = await mkTmpDir("cg-life-read-failure-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);

    const manifestPath = codegraphLifecycleManifestPath(root);
    const originalReadFile = fsp.readFile.bind(fsp);
    const eaccesError = Object.assign(new Error(`EACCES: permission denied, open '${manifestPath}'`), {
      code: "EACCES",
    });
    const readFileSpy = vi.spyOn(fsp, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath === manifestPath) {
        throw eaccesError;
      }
      return await originalReadFile(filePath, options as never);
    });

    try {
      // A generic Error subclass would slip past cli.ts's lifecycle dispatch and print a raw
      // stack trace instead of a clean "message to stderr, exit code 1" error render, so this
      // must be the dedicated CodegraphLifecycleUserError, not merely `instanceof Error`.
      await expect(getCodegraphLifecycleStatus(root)).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
      await expect(getCodegraphLifecycleStatus(root)).rejects.toThrow(/Unable to read Codegraph lifecycle manifest/);
    } finally {
      readFileSpy.mockRestore();
    }

    // ENOENT (no manifest at all) must remain unaffected: readLifecycleManifest still resolves
    // to null rather than throwing, once the mocked permission failure is no longer in play.
    await fsp.rm(manifestPath, { force: true });
    const statusAfterRemoval = await getCodegraphLifecycleStatus(root);
    expect(statusAfterRemoval.initialized).toBe(false);
  });

  it("surfaces a non-ENOENT uninit directory-listing failure as CodegraphLifecycleUserError, not a raw Error", async () => {
    const root = await mkTmpDir("cg-life-uninit-readdir-failure-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);

    const dirPath = path.join(root, ".codegraph");
    const originalReaddir = fsp.readdir.bind(fsp);
    const eaccesError = Object.assign(new Error(`EACCES: permission denied, scandir '${dirPath}'`), {
      code: "EACCES",
    });
    // fsp.readdir is overloaded on its options; no single implementation signature
    // satisfies every overload, and this stub only needs to intercept one directory.
    const readdirImpl = (async (dir: PathLike, options: never) => {
      if (dir === dirPath) {
        throw eaccesError;
      }
      return await originalReaddir(dir, options);
    }) as typeof fsp.readdir;
    const readdirSpy = vi.spyOn(fsp, "readdir").mockImplementation(readdirImpl);

    try {
      const uninitPromise = uninitCodegraphLifecycle(root);
      // A generic Error subclass would slip past cli.ts's lifecycle dispatch and print a raw
      // stack trace instead of a clean "message to stderr, exit code 1" error render, so this
      // must be the dedicated CodegraphLifecycleUserError, not merely `instanceof Error`.
      await expect(uninitPromise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
      await expect(uninitPromise).rejects.toThrow(`Unable to read ${dirPath}`);
    } finally {
      readdirSpy.mockRestore();
    }

    // Real readdir must remain unaffected once the mocked permission failure is no longer in
    // play: an unrelated project's non-force uninit still lists and removes its manifest.
    const baselineRoot = await mkTmpDir("cg-life-uninit-readdir-baseline-");
    await writeFile(baselineRoot, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(baselineRoot);
    const baselineResult = await uninitCodegraphLifecycle(baselineRoot);
    expect(baselineResult.removed).toBe(true);
    await expectDiskIndexCacheHasArtifacts(baselineRoot);
  });

  it("surfaces a non-ENOTEMPTY/non-ENOENT uninit directory-removal failure as CodegraphLifecycleUserError, not a raw Error", async () => {
    const root = await mkTmpDir("cg-life-uninit-rmdir-failure-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);

    const dirPath = path.join(root, ".codegraph");
    const originalRmdir = fsp.rmdir.bind(fsp);
    const eaccesError = Object.assign(new Error(`EACCES: permission denied, rmdir '${dirPath}'`), {
      code: "EACCES",
    });
    const rmdirSpy = vi.spyOn(fsp, "rmdir").mockImplementation(async (dir, options) => {
      if (dir === dirPath) {
        throw eaccesError;
      }
      return await originalRmdir(dir, options as never);
    });

    try {
      // Without --force, uninit removes the manifest file for real and then hands the now-empty
      // .codegraph directory to removeDirIfEmpty, which is where the mocked rmdir failure bites.
      const uninitPromise = uninitCodegraphLifecycle(root);
      await expect(uninitPromise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
      await expect(uninitPromise).rejects.toThrow(`Unable to remove ${dirPath}`);
    } finally {
      rmdirSpy.mockRestore();
    }

    // Real rmdir must remain unaffected once the mocked permission failure is no longer in play:
    // an unrelated project's non-force uninit still removes its now-empty directory.
    const baselineRoot = await mkTmpDir("cg-life-uninit-rmdir-baseline-");
    await writeFile(baselineRoot, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(baselineRoot);
    const baselineResult = await uninitCodegraphLifecycle(baselineRoot);
    expect(baselineResult.removed).toBe(true);
    await expectDiskIndexCacheHasArtifacts(baselineRoot);
  });

  it("surfaces a non-ENOENT manifest write (rename) failure as CodegraphLifecycleUserError, not a raw Error", async () => {
    const root = await mkTmpDir("cg-life-write-eacces-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");

    const manifestPath = codegraphLifecycleManifestPath(root);
    const originalRename = fsp.rename.bind(fsp);
    const eaccesError = Object.assign(new Error(`EACCES: permission denied, rename to '${manifestPath}'`), {
      code: "EACCES",
    });
    const renameSpy = vi.spyOn(fsp, "rename").mockImplementation(async (oldPath, newPath) => {
      if (newPath === manifestPath) {
        throw eaccesError;
      }
      return await originalRename(oldPath, newPath as never);
    });

    try {
      // A generic Error subclass would slip past cli.ts's lifecycle dispatch and print a raw
      // stack trace instead of a clean "message to stderr, exit code 1" error render, so this
      // must be the dedicated CodegraphLifecycleUserError, not merely `instanceof Error`.
      const initPromise = initCodegraphLifecycle(root);
      await expect(initPromise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
      await expect(initPromise).rejects.toThrow(/Unable to write Codegraph lifecycle manifest/);
    } finally {
      renameSpy.mockRestore();
    }

    // Real rename must remain unaffected once the mocked permission failure is no longer in
    // play: an unrelated project's init still succeeds and produces a manifest.
    const baselineRoot = await mkTmpDir("cg-life-write-eacces-baseline-");
    await writeFile(baselineRoot, "src/main.ts", "export const main = 1;\n");
    const baselineResult = await initCodegraphLifecycle(baselineRoot);
    expect(baselineResult.manifest.fileCount).toBe(1);
  });

  it("surfaces a non-ENOENT/non-ENOTDIR file-signature stat failure as CodegraphLifecycleUserError, not a raw Error", async () => {
    const root = await mkTmpDir("cg-life-stat-failure-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await writeFile(root, "src/other.ts", "export const other = 2;\n");
    await initCodegraphLifecycle(root);

    const targetPath = path.join(root, "src/other.ts");
    const originalStat = fsp.stat.bind(fsp);
    const eaccesError = Object.assign(new Error(`EACCES: permission denied, stat '${targetPath}'`), {
      code: "EACCES",
    });
    const statSpy = vi.spyOn(fsp, "stat").mockImplementation(async (filePath, options) => {
      if (path.resolve(String(filePath)) === path.resolve(targetPath)) {
        throw eaccesError;
      }
      return await originalStat(filePath, options as never);
    });

    try {
      // A generic Error subclass would slip past cli.ts's lifecycle dispatch and print a raw
      // stack trace instead of a clean "message to stderr, exit code 1" error render, so this
      // must be the dedicated CodegraphLifecycleUserError, not merely `instanceof Error`.
      const statusPromise = getCodegraphLifecycleStatus(root);
      await expect(statusPromise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
      await expect(statusPromise).rejects.toThrow(/Unable to verify file signature/);
    } finally {
      statSpy.mockRestore();
    }

    // Real stat must remain unaffected once the mocked permission failure is no longer in play:
    // status for the same project resolves normally with no changes detected.
    const status = await getCodegraphLifecycleStatus(root);
    expect(status.filesChanged).toBeFalsy();
  });

  it("surfaces a non-ENOENT --force uninit removal failure as CodegraphLifecycleUserError, not a raw Error", async () => {
    const root = await mkTmpDir("cg-life-uninit-force-rm-failure-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);

    const manifestPath = codegraphLifecycleManifestPath(root);
    const originalRm = fsp.rm.bind(fsp);
    const eaccesError = Object.assign(new Error(`EACCES: permission denied, rm '${manifestPath}'`), {
      code: "EACCES",
    });
    const rmSpy = vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
      if (target === manifestPath) {
        throw eaccesError;
      }
      return await originalRm(target, options as never);
    });

    try {
      // A generic Error subclass would slip past cli.ts's lifecycle dispatch and print a raw
      // stack trace instead of a clean "message to stderr, exit code 1" error render, so this
      // must be the dedicated CodegraphLifecycleUserError, not merely `instanceof Error`.
      const uninitPromise = uninitCodegraphLifecycle(root, { force: true });
      await expect(uninitPromise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
      await expect(uninitPromise).rejects.toThrow(`Unable to remove ${manifestPath}`);
    } finally {
      rmSpy.mockRestore();
    }

    // Real rm must remain unaffected once the mocked permission failure is no longer in play: an
    // unrelated project's --force uninit still removes the whole .codegraph directory.
    const baselineRoot = await mkTmpDir("cg-life-uninit-force-rm-baseline-");
    await writeFile(baselineRoot, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(baselineRoot);
    const baselineResult = await uninitCodegraphLifecycle(baselineRoot, { force: true });
    expect(baselineResult.removed).toBe(true);
    await expectDiskIndexCacheHasArtifacts(baselineRoot);
  });

  it("surfaces a non-ENOENT non-force uninit manifest-removal failure as CodegraphLifecycleUserError, not a raw Error", async () => {
    const root = await mkTmpDir("cg-life-uninit-manifest-rm-failure-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);

    const manifestPath = codegraphLifecycleManifestPath(root);
    const originalRm = fsp.rm.bind(fsp);
    const eaccesError = Object.assign(new Error(`EACCES: permission denied, rm '${manifestPath}'`), {
      code: "EACCES",
    });
    const rmSpy = vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
      if (target === manifestPath) {
        throw eaccesError;
      }
      return await originalRm(target, options as never);
    });

    try {
      // A generic Error subclass would slip past cli.ts's lifecycle dispatch and print a raw
      // stack trace instead of a clean "message to stderr, exit code 1" error render, so this
      // must be the dedicated CodegraphLifecycleUserError, not merely `instanceof Error`.
      const uninitPromise = uninitCodegraphLifecycle(root);
      await expect(uninitPromise).rejects.toBeInstanceOf(CodegraphLifecycleUserError);
      await expect(uninitPromise).rejects.toThrow(`Unable to remove ${manifestPath}`);
    } finally {
      rmSpy.mockRestore();
    }

    // Real rm must remain unaffected once the mocked permission failure is no longer in play: an
    // unrelated project's non-force uninit still removes its manifest file.
    const baselineRoot = await mkTmpDir("cg-life-uninit-manifest-rm-baseline-");
    await writeFile(baselineRoot, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(baselineRoot);
    const baselineResult = await uninitCodegraphLifecycle(baselineRoot);
    expect(baselineResult.removed).toBe(true);
  });

  it("CLI status without --json prints a 'Files changed' line reflecting file drift", async () => {
    const root = await mkTmpDir("cg-life-cli-status-pretty-files-changed-");
    const relativePath = "src/main.ts";
    const content = "export const main = 1;\n";
    await writeFile(root, relativePath, content);
    await initCodegraphLifecycle(root);

    const unchangedResult = await captureCli(["status", root]);

    expect(unchangedResult.exitCode).toBeUndefined();
    expect(unchangedResult.stderr).toBe("");
    expect(unchangedResult.stdout).toContain("Files changed: no\n");

    // mtime-only rewrite: byte-identical content but a fresh mtime still counts as drift, matching
    // the "status treats an mtime-only rewrite as a file change" fixture above.
    const filePath = path.join(root, relativePath);
    const originalStat = await fsp.stat(filePath);
    const futureDate = new Date(originalStat.mtime.getTime() + 60_000);
    await fsp.writeFile(filePath, content, "utf8");
    await fsp.utimes(filePath, futureDate, futureDate);

    const changedResult = await captureCli(["status", root]);

    expect(changedResult.exitCode).toBeUndefined();
    expect(changedResult.stderr).toBe("");
    expect(changedResult.stdout).toContain("Files changed: yes\n");
  });

  it("CLI sync without --json prints explicit +added/-removed counts and omits the label when nothing changed", async () => {
    const root = await mkTmpDir("cg-life-cli-sync-pretty-delta-");
    await writeFile(root, "src/a.ts", "export const a = 1;\n");
    await writeFile(root, "src/b.ts", "export const b = 2;\n");
    await initCodegraphLifecycle(root);
    const manifestPath = codegraphLifecycleManifestPath(root);

    const unchangedResult = await captureCli(["sync", root, "--no-progress"]);

    expect(unchangedResult.exitCode).toBeUndefined();
    expect(unchangedResult.stderr).toBe("");
    expect(unchangedResult.stdout).toContain(`Synced Codegraph at ${root}: 2 files. Manifest: ${manifestPath}\n`);
    expect(unchangedResult.stdout).not.toContain("+0/-0");

    // Equal adds and removes net to a totalDelta of 0, which must not silently hide real churn.
    await fsp.rm(path.join(root, "src/a.ts"));
    await writeFile(root, "src/c.ts", "export const c = 3;\n");

    const churnedResult = await captureCli(["sync", root, "--no-progress"]);

    expect(churnedResult.exitCode).toBeUndefined();
    expect(churnedResult.stderr).toBe("");
    expect(churnedResult.stdout).toContain(`Synced Codegraph at ${root}: 2 files, +1/-1. Manifest: ${manifestPath}\n`);
  });
});
