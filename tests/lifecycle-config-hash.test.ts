import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codegraphLifecycleManifestPath,
  getCodegraphLifecycleStatus,
  initCodegraphLifecycle,
  type CodegraphLifecycleManifest,
} from "../src/lifecycle/manifest.js";
import * as indexerManifest from "../src/indexer/build-cache/manifest.js";
import * as agentSession from "../src/agent/session.js";
import type { AgentProjectSnapshot, AgentSession } from "../src/agent/session.js";
import type { ProgressUpdate } from "../src/types.js";
import { captureCli } from "./helpers/cli.js";
import { mkTmpDir } from "./helpers/filesystem.js";

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

async function readLifecycleManifest(root: string): Promise<CodegraphLifecycleManifest> {
  const raw = await fsp.readFile(codegraphLifecycleManifestPath(root), "utf8");
  return JSON.parse(raw) as CodegraphLifecycleManifest;
}

function lifecycleSnapshot(root: string, files: string[]): AgentProjectSnapshot {
  const index = {
    graph: { nodes: new Set(files), edges: [] },
    modules: new Map(),
    byFile: new Map(),
    exportCache: new Map(),
    scopeCache: new Map(),
    manifestEntries: new Map(files.map((file) => [file, { sig: "1:1" }])),
    manifestSignaturesFresh: true,
  } as AgentProjectSnapshot["index"];
  return {
    root,
    files,
    index,
    fileGraph: index.graph,
    symbolGraph: { nodes: new Map(), edges: [] },
    analysis: {
      mode: "reduced",
      backend: "graph-only",
      parserDegradedFiles: 0,
      fallbackImportExtractionFiles: 0,
      nativeFilesUsed: 0,
      nativeFilesFellBack: 0,
      label: "reduced graph-only",
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

function namedCheckStarts(progress: readonly ProgressUpdate[]): string[] {
  return progress
    .filter((update) => update.phase === "start" && update.mode === "check" && update.activity)
    .map((update) => update.activity ?? "");
}

describe("lifecycle config hash reuse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("init on a Git fixture does not call computeConfigHash after the index build", async () => {
    const root = await mkTmpDir("cg-life-hash-reuse-");
    await initializeGitRepository(root);
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await writeFile(root, "package.json", `${JSON.stringify({ name: "fixture" })}\n`);

    const configHashSpy = vi.spyOn(indexerManifest, "computeConfigHash");
    const originalCreate = agentSession.createAgentSession;
    let computeCallsWhenIndexReady = 0;
    const sessionSpy = vi.spyOn(agentSession, "createAgentSession").mockImplementation((options) => {
      const session = originalCreate(options);
      const loadProject = session.loadProject.bind(session);
      return {
        ...session,
        loadProject: async (loadOptions) => {
          const snapshot = await loadProject(loadOptions);
          computeCallsWhenIndexReady = configHashSpy.mock.calls.length;
          return snapshot;
        },
      };
    });

    await initCodegraphLifecycle(root, { updateGitignore: false });

    expect(sessionSpy).toHaveBeenCalled();
    expect(configHashSpy.mock.calls.length).toBe(computeCallsWhenIndexReady);
  });

  it("init writes the index manifest configHash into the lifecycle manifest", async () => {
    const root = await mkTmpDir("cg-life-hash-match-");
    await initializeGitRepository(root);
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await writeFile(root, "package.json", `${JSON.stringify({ name: "fixture" })}\n`);

    await initCodegraphLifecycle(root, { updateGitignore: false });

    const lifecycle = await readLifecycleManifest(root);
    const indexManifest = await indexerManifest.loadManifest(root, { cache: "disk" });
    expect(indexManifest?.configHash).toEqual(expect.stringMatching(/^[0-9a-f]+$/));
    expect(lifecycle.configHash).toBe(indexManifest?.configHash);
  });

  it("init falls back to hashConfig when the index manifest has no configHash", async () => {
    const root = await mkTmpDir("cg-life-hash-fallback-");
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await writeFile(root, "package.json", `${JSON.stringify({ name: "fixture" })}\n`);
    const file = path.join(root, "src/main.ts");
    vi.spyOn(agentSession, "createAgentSession").mockReturnValue(lifecycleSession(lifecycleSnapshot(root, [file])));
    vi.spyOn(indexerManifest, "loadManifest").mockResolvedValue({
      version: 5,
      projectRoot: root.replace(/\\/g, "/"),
      updatedAt: Date.now(),
      files: {},
    });
    const configHashSpy = vi.spyOn(indexerManifest, "computeConfigHash");

    const result = await initCodegraphLifecycle(root, { updateGitignore: false });

    expect(configHashSpy).toHaveBeenCalled();
    const fallbackHash = await configHashSpy.mock.results.at(-1)?.value;
    expect(result.manifest.configHash).toMatch(/^[0-9a-f]+$/);
    expect(result.manifest.configHash).toBe(fallbackHash?.hash);
  });

  it("status detects config drift after a tracked config file changes", async () => {
    const root = await mkTmpDir("cg-life-hash-status-drift-");
    await initializeGitRepository(root);
    await writeFile(root, "src/main.ts", "export const main = 1;\n");
    await writeFile(root, "package.json", `${JSON.stringify({ name: "fixture", version: "1.0.0" })}\n`);
    await initCodegraphLifecycle(root, { updateGitignore: false });

    const before = await getCodegraphLifecycleStatus(root);
    expect(before.configChanged).toBeFalsy();

    await writeFile(root, "package.json", `${JSON.stringify({ name: "fixture", version: "2.0.0" })}\n`);
    const after = await getCodegraphLifecycleStatus(root);

    expect(after.configChanged).toBeTruthy();
    expect(after.suggestedNextCommand).toBe("codegraph sync");
  });

  it("init --progress names post-build lifecycle phases", async () => {
    const root = await mkTmpDir("cg-life-hash-progress-");
    await initializeGitRepository(root);
    await writeFile(root, "src/main.ts", "export const main = 1;\n");

    const progress: ProgressUpdate[] = [];
    await initCodegraphLifecycle(root, {
      updateGitignore: false,
      buildOptions: {
        onProgress: (update) => {
          progress.push(update);
        },
      },
    });

    const named = namedCheckStarts(progress);
    for (const activity of [
      "Closing disk cache",
      "Reading index config hash",
      "Hashing file signatures",
      "Writing lifecycle manifest",
    ]) {
      const starts = progress.filter(
        (update) => update.activity === activity && update.phase === "start" && update.mode === "check",
      );
      expect(starts.length, activity).toBeTruthy();
      expect(
        starts.every((update) => update.current === 0 && update.total === 0),
        activity,
      ).toBeTruthy();
    }
    expect(named).toContain("Closing disk cache");
    expect(named.indexOf("Closing disk cache")).toBeLessThan(named.indexOf("Writing lifecycle manifest"));

    const cli = await captureCli(["init", root, "--force", "--progress", "--no-update-gitignore"]);
    expect(cli.exitCode).toBeUndefined();
    expect(cli.stderr).toContain("Closing disk cache");
    expect(cli.stderr).toContain("Writing lifecycle manifest");
    expect(cli.stdout).toContain("Initialized Codegraph");
  });
});
