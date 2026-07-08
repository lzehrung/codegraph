import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  codegraphLifecycleManifestPath,
  getCodegraphLifecycleStatus,
  initCodegraphLifecycle,
  syncCodegraphLifecycle,
  uninitCodegraphLifecycle,
  type CodegraphLifecycleManifest,
  type CodegraphLifecycleStatus,
  type CodegraphLifecycleSyncResult,
  type CodegraphLifecycleUninitResult,
} from "../src/lifecycle/manifest.js";
import type { BuildOptions } from "../src/indexer/types.js";
import { captureCli } from "./helpers/cli.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { CODEGRAPH_CONFIG_FILE } from "../src/config.js";

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
});
