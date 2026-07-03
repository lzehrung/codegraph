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

describe("project lifecycle commands", () => {
  it("init creates a manifest and is idempotent when current", async () => {
    const root = await mkTmpDir("cg-life-init-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");

    const first = await initCodegraphLifecycle(root);
    const second = await initCodegraphLifecycle(root);

    expect(first.manifest.fileCount).toBe(1);
    expect(second.changedFiles.totalDelta).toBe(0);
    expect(await readManifest(root)).toEqual(first.manifest);
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

  it("status detects config hash changes", async () => {
    const root = await mkTmpDir("cg-life-config-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await writeFile(root, "codegraph.config.json", `${JSON.stringify({ discovery: { useGitignore: true } })}\n`);
    await initCodegraphLifecycle(root);
    await writeFile(root, "codegraph.config.json", `${JSON.stringify({ discovery: { useGitignore: false } })}\n`);

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

  it("CLI status --json returns a stable lifecycle envelope", async () => {
    const root = await mkTmpDir("cg-life-cli-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");

    const initResult = await captureCli(["init", root, "--json"]);
    const statusResult = await captureCli(["status", root, "--json"]);

    expect(initResult.exitCode).toBeUndefined();
    expect(statusResult.exitCode).toBeUndefined();
    const status = JSON.parse(statusResult.stdout) as { schemaVersion?: number; initialized?: boolean };
    expect(status.schemaVersion).toBe(1);
    expect(status.initialized).toBeTruthy();
  });
});
