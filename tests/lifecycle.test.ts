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
  type CodegraphLifecycleSyncResult,
  type CodegraphLifecycleUninitResult,
} from "../src/lifecycle/manifest.js";
import { captureCli } from "./helpers/cli.js";
import { mkTmpDir } from "./helpers/filesystem.js";

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

  it("init --force rebuilds and updates lastSyncAt", async () => {
    const root = await mkTmpDir("cg-life-force-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await initCodegraphLifecycle(root);
    const manifestPath = codegraphLifecycleManifestPath(root);
    const manifest = await readManifest(root);
    const oldManifest = {
      ...manifest,
      lastSyncAt: "2000-01-01T00:00:00.000Z",
    };
    await fsp.writeFile(manifestPath, `${JSON.stringify(oldManifest, null, 2)}\n`, "utf8");

    const result = await initCodegraphLifecycle(root, { force: true });

    expect(result.manifest.createdAt).toBe(manifest.createdAt);
    expect(result.manifest.lastSyncAt).not.toBe(oldManifest.lastSyncAt);
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
