import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  currentProjectIndexBuildOptions,
  loadCurrentProjectIndex,
  createCurrentProjectIndexLoader,
} from "../src/indexer/load-current-index.js";
import type { BuildReport, ProgressUpdate } from "../src/index.js";
import { createTempProjectRoot, normalizeTestPath } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

type LoadOptions = Parameters<typeof loadCurrentProjectIndex>[0]["options"];

const projectFiles = [
  {
    path: path.join("src", "a.ts"),
    contents: "import { b } from './b.js';\nexport function a() {\n  return b();\n}\n",
  },
  { path: path.join("src", "b.ts"), contents: "export function b() {\n  return 1;\n}\n" },
  { path: path.join("src", "c.ts"), contents: "export const c = 3;\n" },
];

async function createProject(prefix: string): Promise<string> {
  return await createTempProjectRoot(prefix, projectFiles);
}

async function createGitProject(prefix: string): Promise<string> {
  const root = await createProject(prefix);
  runGit(root, ["init"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "initial"]);
  return root;
}

function newReport(): BuildReport {
  return { timings: {} };
}

async function loadProjectScope(root: string, report: BuildReport, options?: LoadOptions) {
  return await loadCurrentProjectIndex({
    root,
    scope: { kind: "project" },
    options: { ...options, report },
  });
}

function indexedFiles(index: { byFile: ReadonlyMap<string, unknown> }): string[] {
  return [...index.byFile.keys()].map(normalizeTestPath).sort();
}

function fileNames(index: { byFile: ReadonlyMap<string, unknown> }): string[] {
  return indexedFiles(index).map((file) => path.posix.basename(file));
}

describe("loadCurrentProjectIndex build options", () => {
  it("defaults to the disk cache only when the caller omits a cache mode", () => {
    expect(currentProjectIndexBuildOptions({ kind: "project" }).cache).toBe("disk");
    expect(currentProjectIndexBuildOptions({ kind: "project" }, { cache: "off" }).cache).toBe("off");
    expect(currentProjectIndexBuildOptions({ kind: "project" }, { cache: "memory" }).cache).toBe("memory");
    expect(currentProjectIndexBuildOptions({ kind: "project" }, { cache: "disk" }).cache).toBe("disk");
  });

  it("encodes resolved-file scope as complete project scope, never as changed inputs", () => {
    const options = currentProjectIndexBuildOptions({
      kind: "resolved-files",
      files: ["/repo/src/a.ts", "/repo/src/b.ts"],
    });
    expect(options.files).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
    expect(options.filesAreProjectScope).toBe(true);
  });

  it("omits an explicit file list for project scope and copies additional files", () => {
    const additionalFiles = ["/repo/generated/x.ts"];
    const options = currentProjectIndexBuildOptions({ kind: "project", additionalFiles });
    expect(options.files).toBeUndefined();
    expect(options.filesAreProjectScope).toBeUndefined();
    expect(options.additionalFiles).toEqual(additionalFiles);
    expect(options.additionalFiles).not.toBe(additionalFiles);
  });

  it("strips change-range and reconciliation inputs forwarded by wider callers", () => {
    const wider = {
      cache: "disk" as const,
      keepParsed: true,
      files: ["/repo/src/a.ts"],
      filesAreProjectScope: false,
      gitBase: "HEAD~1",
      gitHead: "WORKTREE",
      changedSince: "3 days ago",
      reconciledManifestUpdatedAt: 5,
      reconciledWorkingTreeDiffFiles: ["/repo/src/a.ts"],
      reconciledUntrackedFiles: ["/repo/src/new.ts"],
    };
    const options = currentProjectIndexBuildOptions({ kind: "project" }, wider);
    expect(options.keepParsed).toBe(true);
    expect(options.files).toBeUndefined();
    expect(options.filesAreProjectScope).toBeUndefined();
    expect(options.gitBase).toBeUndefined();
    expect(options.gitHead).toBeUndefined();
    expect(options.changedSince).toBeUndefined();
    expect(options.reconciledManifestUpdatedAt).toBeUndefined();
    expect(options.reconciledWorkingTreeDiffFiles).toBeUndefined();
    expect(options.reconciledUntrackedFiles).toBeUndefined();
  });
});

describe("loadCurrentProjectIndex freshness decisions", () => {
  it("builds and writes usable cache state when no manifest exists", async () => {
    const root = await createProject("dg-load-current-cold-");
    const report = newReport();
    const index = await loadProjectScope(root, report);
    expect(fileNames(index)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(report.files?.parsed).toBe(3);
    expect(report.manifest?.reason).toBe("missing");
    expect(report.manifest?.reused).toBe(false);
    await expect(fsp.stat(path.join(root, ".codegraph-cache", "index-v1", "manifest.json"))).resolves.toBeDefined();
  });

  it("reuses the snapshot with zero parsed files on an unchanged second load", async () => {
    const root = await createProject("dg-load-current-warm-");
    await loadProjectScope(root, newReport());
    const warmReport = newReport();
    const progressModes: string[] = [];
    const index = await loadProjectScope(root, warmReport, {
      onProgress: (progress: ProgressUpdate) => {
        if (progress.type === "progress" && progress.mode) progressModes.push(progress.mode);
      },
    });
    expect(fileNames(index)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(warmReport.files?.parsed ?? 0).toBe(0);
    expect(warmReport.manifest?.reused).toBe(true);
    expect(new Set(progressModes)).toEqual(new Set(["check"]));
  });

  it("reparses a modified file and its dependents", async () => {
    const root = await createProject("dg-load-current-modified-");
    await loadProjectScope(root, newReport());
    await fsp.writeFile(
      path.join(root, "src", "b.ts"),
      "export function b() {\n  return 2;\n}\nexport const extra = 1;\n",
      "utf8",
    );
    const report = newReport();
    const index = await loadProjectScope(root, report);
    expect(report.files?.parsed).toBeGreaterThanOrEqual(1);
    const b = index.byFile.get([...index.byFile.keys()].find((file) => normalizeTestPath(file).endsWith("src/b.ts"))!);
    expect(b?.exports.map((entry) => ("exportedAs" in entry ? entry.exportedAs : "")).sort()).toEqual(["b", "extra"]);
  });

  it("detects a staged change before it is committed", async () => {
    const root = await createGitProject("dg-load-current-staged-");
    await loadProjectScope(root, newReport());
    await fsp.writeFile(path.join(root, "src", "c.ts"), "export const c = 4;\nexport const staged = true;\n", "utf8");
    runGit(root, ["add", path.join("src", "c.ts")]);
    const report = newReport();
    const index = await loadProjectScope(root, report);
    expect(report.files?.parsed).toBeGreaterThanOrEqual(1);
    const c = index.byFile.get([...index.byFile.keys()].find((file) => normalizeTestPath(file).endsWith("src/c.ts"))!);
    expect(c?.exports.map((entry) => ("exportedAs" in entry ? entry.exportedAs : "")).sort()).toEqual(["c", "staged"]);
  });

  it("indexes a new untracked eligible file", async () => {
    const root = await createGitProject("dg-load-current-untracked-");
    await loadProjectScope(root, newReport());
    await fsp.writeFile(path.join(root, "src", "d.ts"), "export const d = 4;\n", "utf8");
    const index = await loadProjectScope(root, newReport());
    expect(fileNames(index)).toContain("d.ts");
  });

  it("removes deleted and renamed files while keeping dependent invalidation", async () => {
    const root = await createProject("dg-load-current-deleted-");
    await loadProjectScope(root, newReport());
    await fsp.rm(path.join(root, "src", "c.ts"));
    await fsp.rename(path.join(root, "src", "b.ts"), path.join(root, "src", "b2.ts"));
    const report = newReport();
    const index = await loadProjectScope(root, report);
    expect(fileNames(index)).toEqual(["a.ts", "b2.ts"]);
    const a = index.byFile.get([...index.byFile.keys()].find((file) => normalizeTestPath(file).endsWith("src/a.ts"))!);
    expect(a?.imports.length).toBe(1);
    expect(report.files?.parsed).toBeGreaterThanOrEqual(1);
  });

  it("rebuilds safely when graph options no longer match the manifest", async () => {
    const root = await createProject("dg-load-current-options-");
    await loadProjectScope(root, newReport());
    const report = newReport();
    await loadProjectScope(root, report, { graph: { resolveNodeModules: true } });
    expect(report.manifest?.reused).toBe(false);
    expect(report.manifest?.reason).toBe("graphOptionsMismatch");
    expect(report.files?.parsed).toBe(3);
  });

  it("falls back safely when the persisted snapshot is malformed", async () => {
    const root = await createProject("dg-load-current-malformed-");
    await loadProjectScope(root, newReport());
    await fsp.writeFile(
      path.join(root, ".codegraph-cache", "index-v1", "project-index-snapshot.json"),
      "{ not valid json",
      "utf8",
    );
    const index = await loadProjectScope(root, newReport());
    expect(fileNames(index)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("preserves cache off semantics without claiming a disk cache hit", async () => {
    const root = await createProject("dg-load-current-cache-off-");
    await loadProjectScope(root, newReport());
    const report = newReport();
    const index = await loadProjectScope(root, report, { cache: "off" });
    expect(fileNames(index)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(report.cache).toBeUndefined();
    expect(report.manifest).toEqual({ used: false, reused: false });
    expect(report.files?.parsed).toBe(3);
  });

  it("keeps exhaustive validation paths available for verify and strict modes", async () => {
    const root = await createProject("dg-load-current-verify-");
    await loadProjectScope(root, newReport());
    const verifyReport = newReport();
    await loadProjectScope(root, verifyReport, { cacheVerify: true });
    expect(verifyReport.manifest?.used).toBe(true);
    expect(verifyReport.files?.parsed ?? 0).toBe(0);

    await fsp.writeFile(path.join(root, "src", "c.ts"), "export const c = 5;\n", "utf8");
    const strictReport = newReport();
    await loadProjectScope(root, strictReport, { cacheStrict: true, cacheVerify: true });
    expect(strictReport.files?.parsed).toBeGreaterThanOrEqual(1);
  });

  it("sees a new file under cache-strict, which cannot use the cheap Git untracked scan", async () => {
    const root = await createGitProject("dg-load-current-strict-new-");
    await loadProjectScope(root, newReport());
    await fsp.writeFile(path.join(root, "src", "f.ts"), "export const f = 6;\n", "utf8");
    const index = await loadProjectScope(root, newReport(), { cacheStrict: true });
    expect(fileNames(index)).toContain("f.ts");
  });

  it("treats resolved-file scope as the complete scope instead of changed inputs", async () => {
    const root = await createProject("dg-load-current-scope-");
    const files = [path.join(root, "src", "a.ts"), path.join(root, "src", "b.ts")];
    const coldReport = newReport();
    const coldIndex = await loadCurrentProjectIndex({
      root,
      scope: { kind: "resolved-files", files },
      options: { report: coldReport },
    });
    expect(fileNames(coldIndex)).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));

    const warmReport = newReport();
    await loadCurrentProjectIndex({
      root,
      scope: { kind: "resolved-files", files },
      options: { report: warmReport },
    });
    expect(warmReport.files?.parsed ?? 0).toBe(0);
    expect(warmReport.manifest?.reused).toBe(true);
  });

  it("unions project-scope additional files outside discovery", async () => {
    const root = await createProject("dg-load-current-additional-");
    const outside = path.join(root, "ignored", "extra.ts");
    await fsp.mkdir(path.dirname(outside), { recursive: true });
    await fsp.writeFile(outside, "export const extra = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf8");
    const index = await loadCurrentProjectIndex({
      root,
      scope: { kind: "project", additionalFiles: [outside] },
      options: { report: newReport() },
    });
    expect(fileNames(index)).toContain("extra.ts");
  });

  it("stays correct for a non-Git project through full discovery fallback", async () => {
    const root = await createProject("dg-load-current-nongit-");
    await loadProjectScope(root, newReport());
    await fsp.writeFile(path.join(root, "src", "e.ts"), "export const e = 5;\n", "utf8");
    const index = await loadProjectScope(root, newReport());
    expect(fileNames(index)).toContain("e.ts");
  });

  it("binds a project-scope loader for injected handlers", async () => {
    const root = await createProject("dg-load-current-bound-");
    const report = newReport();
    const load = createCurrentProjectIndexLoader(root, { report });
    const index = await load();
    expect(fileNames(index)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(index.cacheMode).toBe("disk");
  });
});
