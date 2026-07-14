import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
import * as indexerManifest from "../src/indexer/build-cache/manifest.js";
import * as agentSession from "../src/agent/session.js";
import type { BuildOptions } from "../src/indexer/types.js";
import { captureCli } from "./helpers/cli.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { CODEGRAPH_CONFIG_FILE } from "../src/config.js";

const execFileAsync = promisify(execFile);

async function initializeGitRepository(root: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "codegraph-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Codegraph Tests"], { cwd: root });
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
  return (await fsp.readdir(path.join(root, ".codegraph"))).sort();
}

async function expectDiskIndexCacheHasArtifacts(root: string): Promise<void> {
  const cacheRoot = path.join(root, ".codegraph-cache", "index-v1");
  const stats = await fsp.stat(cacheRoot);
  expect(stats.isDirectory()).toBeTruthy();
  const entries = await fsp.readdir(cacheRoot);
  expect(entries.length).toBeGreaterThan(0);
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

  it("init appends one root Git ignore rule while preserving file bytes, newline style, and permissions", async () => {
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

      expect(first.gitignore).toEqual({ status: "added", path: ".gitignore" });
      expect(second.gitignore).toEqual({ status: "already-ignored", path: ".gitignore" });
      expect(await fsp.readFile(path.join(root, ".gitignore"), "utf8")).toBe(testCase.expected);
      if (testCase.initial !== null && process.platform !== "win32") {
        expect((await fsp.stat(path.join(root, ".gitignore"))).mode & 0o777).toBe(0o640);
      }
      expect(await readCodegraphEntries(root)).toEqual(["manifest.json"]);
    }
  });

  it("init honors exact, broader, and repository-external effective Git ignore rules", async () => {
    const cases = [
      { name: "exact", policyPath: ".gitignore", policy: ".codegraph/manifest.json\n" },
      { name: "broader", policyPath: ".gitignore", policy: ".codegraph/\n" },
      { name: "info-exclude", policyPath: ".git/info/exclude", policy: ".codegraph/\n" },
    ] as const;

    for (const testCase of cases) {
      const root = await mkTmpDir(`cg-life-effective-ignore-${testCase.name}-`);
      await initializeGitRepository(root);
      await writeFile(root, "src/main.ts", "export const main = 1;\n");
      await writeFile(root, testCase.policyPath, testCase.policy);

      const result = await initCodegraphLifecycle(root);

      expect(result.gitignore).toEqual({ status: "already-ignored", path: ".gitignore" });
      if (testCase.policyPath !== ".gitignore") {
        await expect(fsp.stat(path.join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await fsp.readFile(path.join(root, ".gitignore"), "utf8")).toBe(testCase.policy);
      }
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

    expect(refreshed.gitignore).toEqual({ status: "added", path: ".gitignore" });
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
    expect(initialized.gitignore).toEqual({ status: "added", path: ".gitignore" });
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
    await execFileAsync("git", ["add", "--", ".codegraph/manifest.json"], { cwd: root });

    const result = await initCodegraphLifecycle(root);

    expect(result.gitignore).toEqual({ status: "tracked", path: ".gitignore" });
    await expect(fsp.stat(path.join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
    const { stdout } = await execFileAsync("git", ["ls-files", "--", ".codegraph/manifest.json"], { cwd: root });
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
    await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
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

      // computeConfigHash is also consulted by the indexer's own disk-cache build/manifest layers
      // (each logging their own generic "Warning: ..." message), so assert on the lifecycle-specific
      // wording rather than an exact call count.
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
        name: "native mode",
        initial: { native: "off" },
        current: { native: "auto" },
      },
      {
        name: "graph options",
        initial: { graph: { fast: true } },
        current: { graph: { fast: false } },
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

  it("status treats omitted and explicit default-equivalent native and graph options as current", async () => {
    const explicitDefaultGraphOptions: BuildOptions = {
      graph: { fast: false, resolveNodeModules: false, dynamicImportHeuristics: false },
    };
    const cases: { name: string; initial?: BuildOptions; current?: BuildOptions }[] = [
      {
        name: "omitted at init and explicit native auto at status",
        current: { native: "auto" },
      },
      {
        name: "explicit native auto at init and omitted at status",
        initial: { native: "auto" },
      },
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
    const cacheRoot = path.join(root, ".codegraph-cache", "index-v1");
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
    await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uninit without --force removes a manifest-only .codegraph directory", async () => {
    const root = await mkTmpDir("cg-life-uninit-manifest-only-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);

    const result = await uninitCodegraphLifecycle(root);

    expect(result.removed).toBeTruthy();
    await expect(fsp.stat(path.join(root, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("CLI JSON captures cover lifecycle mutating commands with positional roots", async () => {
    const initRoot = await mkTmpDir("cg-life-cli-init-");
    await writeFile(initRoot, "src/main.ts", "export const main = 1;\n");

    const initResult = await captureCli(["init", initRoot, "--force", "--json"]);

    expect(initResult.exitCode).toBeUndefined();
    expect(initResult.stderr).toBe("");
    const initPayload = JSON.parse(initResult.stdout) as CodegraphLifecycleSyncResult;
    expect(initPayload.root).toBe(initRoot);
    expect(initPayload.initialized).toBeTruthy();
    expect(initPayload.manifest.fileCount).toBe(1);
    expect(await readCodegraphEntries(initRoot)).toEqual(["manifest.json"]);

    const syncRoot = await mkTmpDir("cg-life-cli-sync-");
    await writeFile(syncRoot, "src/main.ts", "export const main = 1;\n");

    const syncInitResult = await captureCli(["sync", syncRoot, "--init", "--json"]);

    expect(syncInitResult.exitCode).toBeUndefined();
    expect(syncInitResult.stderr).toBe("");
    const syncInitPayload = JSON.parse(syncInitResult.stdout) as CodegraphLifecycleSyncResult;
    expect(syncInitPayload.root).toBe(syncRoot);
    expect(syncInitPayload.initialized).toBeTruthy();
    expect(syncInitPayload.manifest.fileCount).toBe(1);
    expect(await readCodegraphEntries(syncRoot)).toEqual(["manifest.json"]);

    await writeFile(syncRoot, "src/extra.ts", "export const extra = 2;\n");
    const syncResult = await captureCli(["sync", syncRoot, "--json"]);

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
    await expect(fsp.stat(path.join(syncRoot, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("CLI JSON and pretty output expose only initializing ignore-policy outcomes", async () => {
    const jsonRoot = await mkTmpDir("cg-life-cli-gitignore-json-");
    await initializeGitRepository(jsonRoot);
    await writeFile(jsonRoot, "src/main.ts", "export const main = 1;\n");

    const jsonResult = await captureCli(["init", jsonRoot, "--json"]);

    expect(jsonResult.exitCode).toBeUndefined();
    expect(jsonResult.stderr).toBe("");
    const payload = JSON.parse(jsonResult.stdout) as CodegraphLifecycleSyncResult;
    expect(payload.gitignore).toEqual({ status: "added", path: ".gitignore" });
    expect(jsonResult.stdout.trim().startsWith("{")).toBeTruthy();
    expect(jsonResult.stdout.trim().endsWith("}")).toBeTruthy();

    const prettyRoot = await mkTmpDir("cg-life-cli-gitignore-pretty-");
    await initializeGitRepository(prettyRoot);
    await writeFile(prettyRoot, "src/main.ts", "export const main = 1;\n");
    const prettyResult = await captureCli(["init", prettyRoot]);
    expect(prettyResult.stderr).toBe("");
    expect(prettyResult.stdout).toContain(`Updated Git ignore policy at ${path.join(prettyRoot, ".gitignore")}`);
    expect(prettyResult.stdout).toContain("added .codegraph/");

    const trackedRoot = await mkTmpDir("cg-life-cli-gitignore-tracked-");
    await initializeGitRepository(trackedRoot);
    await writeFile(trackedRoot, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(trackedRoot, { updateGitignore: false });
    await execFileAsync("git", ["add", "--", ".codegraph/manifest.json"], { cwd: trackedRoot });
    const trackedResult = await captureCli(["init", trackedRoot]);
    expect(trackedResult.stderr).toBe("");
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

      const result = await captureCli(args, { cwd });

      expect(result.exitCode, `${command} --root should succeed`).toBeUndefined();
      expect(result.stderr, command).toBe("");

      if (command === "uninit") {
        const payload = JSON.parse(result.stdout) as CodegraphLifecycleUninitResult;
        expect(payload.root, command).toBe(flagRoot);
        expect(payload.removed, command).toBeTruthy();
        await expect(fsp.stat(path.join(flagRoot, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
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
    const readdirSpy = vi.spyOn(fsp, "readdir").mockImplementation(async (dir, options) => {
      if (dir === dirPath) {
        throw eaccesError;
      }
      return await originalReaddir(dir, options as never);
    });

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
    await expect(fsp.stat(path.join(baselineRoot, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
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
    await expect(fsp.stat(path.join(baselineRoot, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
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

    const dirPath = path.join(root, ".codegraph");
    const originalRm = fsp.rm.bind(fsp);
    const eaccesError = Object.assign(new Error(`EACCES: permission denied, rm '${dirPath}'`), {
      code: "EACCES",
    });
    const rmSpy = vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
      if (target === dirPath) {
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
      await expect(uninitPromise).rejects.toThrow(`Unable to remove ${dirPath}`);
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
    await expect(fsp.stat(path.join(baselineRoot, ".codegraph"))).rejects.toMatchObject({ code: "ENOENT" });
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

    const unchangedResult = await captureCli(["sync", root]);

    expect(unchangedResult.exitCode).toBeUndefined();
    expect(unchangedResult.stderr).toBe("");
    expect(unchangedResult.stdout).toContain(`Synced Codegraph at ${root}: 2 files. Manifest: ${manifestPath}\n`);
    expect(unchangedResult.stdout).not.toContain("+0/-0");

    // Equal adds and removes net to a totalDelta of 0, which must not silently hide real churn.
    await fsp.rm(path.join(root, "src/a.ts"));
    await writeFile(root, "src/c.ts", "export const c = 3;\n");

    const churnedResult = await captureCli(["sync", root]);

    expect(churnedResult.exitCode).toBeUndefined();
    expect(churnedResult.stderr).toBe("");
    expect(churnedResult.stdout).toContain(`Synced Codegraph at ${root}: 2 files, +1/-1. Manifest: ${manifestPath}\n`);
  });
});
