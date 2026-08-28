import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canUseIncrementalDiscoveryFastPath,
  collectDeletedTrackedFileDependents,
  collectTrackedFileDependents,
  listUntrackedProjectFiles,
  resolveIncrementalFileList,
} from "../src/indexer/incremental-plan.js";
import type { ManifestFileEntry } from "../src/indexer/build-cache.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import type { Edge } from "../src/types.js";
import * as projectFilesModule from "../src/util/projectFiles.js";
import { isSymlinkUnavailable, mkTmpDir } from "./helpers/filesystem.js";
import { runGit as git } from "./helpers/git.js";

function fileEdge(from: string, to: string): Edge {
  return { from, to: { type: "file", path: to }, raw: `./${to}` };
}

function entry(edges: Edge[]): ManifestFileEntry {
  return { sig: "sig", edges };
}

function manifestPathFor(root: string): string {
  return path.join(root, ".codegraph", "cache", "index-v1", "manifest.json");
}

describe("incremental-plan dependents", () => {
  it("collects transitive dependents of changed files", () => {
    const trackedEntries: Record<string, ManifestFileEntry> = {
      "/proj/a.ts": entry([fileEdge("/proj/a.ts", "/proj/b.ts")]),
      "/proj/b.ts": entry([fileEdge("/proj/b.ts", "/proj/c.ts")]),
      "/proj/c.ts": entry([]),
    };

    const changed = new Set(["/proj/c.ts"]);
    expect(collectTrackedFileDependents(trackedEntries, changed)).toEqual(new Set(["/proj/b.ts", "/proj/a.ts"]));
  });

  it("still collects dependents of deleted tracked files", () => {
    const trackedEntries: Record<string, ManifestFileEntry> = {
      "/proj/a.ts": entry([fileEdge("/proj/a.ts", "/proj/b.ts")]),
      "/proj/b.ts": entry([]),
    };
    const deleted = new Set(["/proj/b.ts"]);
    expect(collectDeletedTrackedFileDependents(trackedEntries, deleted)).toEqual(new Set(["/proj/a.ts"]));
  });
});

describe("canUseIncrementalDiscoveryFastPath", () => {
  it("requires a Git repo and no --cache-strict", () => {
    expect(canUseIncrementalDiscoveryFastPath(true, undefined)).toBe(true);
    expect(canUseIncrementalDiscoveryFastPath(false, undefined)).toBe(false);
    expect(canUseIncrementalDiscoveryFastPath(true, true)).toBe(false);
  });
});

describe("listUntrackedProjectFiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds new files matching project discovery patterns and excludes tracked or non-project files", async () => {
    const root = await mkTmpDir("codegraph-untracked-project-files-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "tracked.ts"), "export const tracked = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      await fs.writeFile(path.join(root, "fresh.ts"), "export const fresh = 1;\n", "utf8");
      await fs.writeFile(path.join(root, "notes.txt"), "not a project file pattern\n", "utf8");

      const files = await listUntrackedProjectFiles(root, undefined, true);
      const normalized = files.map((file) => file.replace(/\\/g, "/"));
      expect(normalized).toContain(`${root.replace(/\\/g, "/")}/fresh.ts`);
      expect(normalized.some((file) => file.endsWith("/notes.txt"))).toBe(false);
      expect(normalized.some((file) => file.endsWith("/tracked.ts"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns an empty list when Git is unavailable", async () => {
    const root = await mkTmpDir("codegraph-untracked-project-files-disabled-");
    try {
      expect(await listUntrackedProjectFiles(root, undefined, false)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("includes gitignored untracked files when useGitignore is false, instead of giving up", async () => {
    const root = await mkTmpDir("codegraph-untracked-project-files-no-gitignore-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, ".gitignore"), "ignored.ts\n", "utf8");
      await fs.writeFile(path.join(root, "tracked.ts"), "export const tracked = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      await fs.writeFile(path.join(root, "ignored.ts"), "export const ignored = 1;\n", "utf8");

      const respectingGitignore = await listUntrackedProjectFiles(root, undefined, true);
      expect(respectingGitignore.some((file) => file.endsWith("/ignored.ts"))).toBe(false);

      const includingGitignored = await listUntrackedProjectFiles(root, { useGitignore: false }, true);
      const normalized = includingGitignored.map((file) => file.replace(/\\/g, "/"));
      expect(normalized.some((file) => file.endsWith("/ignored.ts"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("excludes untracked symlinks whose realpath escapes the project root", async () => {
    const root = await mkTmpDir("codegraph-untracked-project-files-symlink-root-");
    const outside = await mkTmpDir("codegraph-untracked-project-files-symlink-outside-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "tracked.ts"), "export const tracked = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      const outsideFile = path.join(outside, "secret.ts");
      const linkedFile = path.join(root, "linked-secret.ts");
      await fs.writeFile(outsideFile, "export const secret = 1;\n", "utf8");
      try {
        await fs.symlink(outsideFile, linkedFile, "file");
      } catch (error) {
        if (isSymlinkUnavailable(error)) return;
        throw error;
      }

      const files = await listUntrackedProjectFiles(root, undefined, true);
      const normalized = files.map((file) => file.replace(/\\/g, "/"));
      expect(normalized.some((file) => file.endsWith("/linked-secret.ts"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("resolveIncrementalFileList", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no manifest exists yet", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-no-manifest-");
    try {
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
      expect(await resolveIncrementalFileList(root, { cache: "disk" })).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns null for older manifests that do not record build options", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-missing-build-options-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      await buildProjectIndex(root, { cache: "disk" });

      const manifestPath = manifestPathFor(root);
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { buildOptions?: unknown };
      delete manifest.buildOptions;
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

      expect(await resolveIncrementalFileList(root, { cache: "disk" })).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns null for non-Git projects even with a manifest present", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-non-git-");
    try {
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
      await buildProjectIndex(root, { cache: "disk" });
      expect(await resolveIncrementalFileList(root, { cache: "disk" })).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns null when --cache-strict is requested", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-strict-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      await buildProjectIndex(root, { cache: "disk" });

      expect(await resolveIncrementalFileList(root, { cache: "disk", cacheStrict: true })).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns null when discovery options changed since the manifest was written", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-discovery-change-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      await buildProjectIndex(root, { cache: "disk" });

      const changedDiscovery = { cache: "disk" as const, discovery: { ignoreGlobs: ["**/*.spec.ts"] } };
      expect(await resolveIncrementalFileList(root, changedDiscovery)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves tracked and newly created untracked files without a full recursive scan", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-fast-path-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "tracked.ts"), "export const tracked = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      await buildProjectIndex(root, { cache: "disk" });

      await fs.writeFile(path.join(root, "fresh.ts"), "export const fresh = 1;\n", "utf8");
      const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");

      const files = await resolveIncrementalFileList(root, { cache: "disk" });

      expect(files).not.toBeNull();
      const normalized = (files ?? []).map((file) => file.replace(/\\/g, "/"));
      expect(normalized.some((file) => file.endsWith("/tracked.ts"))).toBe(true);
      expect(normalized.some((file) => file.endsWith("/fresh.ts"))).toBe(true);
      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves modified and deleted tracked files after a new commit without a full recursive scan", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-commit-diff-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "kept.ts"), "export const kept = 1;\n", "utf8");
      await fs.writeFile(path.join(root, "removed.ts"), "export const removed = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      await buildProjectIndex(root, { cache: "disk" });

      await fs.writeFile(path.join(root, "kept.ts"), "export const kept = 2;\n", "utf8");
      await fs.rm(path.join(root, "removed.ts"));
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "head"]);

      const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
      const files = await resolveIncrementalFileList(root, { cache: "disk" });

      expect(files).not.toBeNull();
      const normalized = (files ?? []).map((file) => file.replace(/\\/g, "/"));
      expect(normalized.some((file) => file.endsWith("/kept.ts"))).toBe(true);
      expect(normalized.some((file) => file.endsWith("/removed.ts"))).toBe(false);
      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a newly staged (git add, not committed) file without a full recursive scan", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-staged-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "tracked.ts"), "export const tracked = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      await buildProjectIndex(root, { cache: "disk" });

      // A staged-but-uncommitted file is neither a tracked manifest entry nor reported by
      // `git ls-files --others` (staging removes it from "untracked"), so only a diff
      // against the working tree (not just the commit) can find it while HEAD is unmoved.
      const stagedPath = path.join(root, "staged.ts");
      await fs.writeFile(stagedPath, "export const staged = 1;\n", "utf8");
      git(root, ["add", "staged.ts"]);

      const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
      const files = await resolveIncrementalFileList(root, { cache: "disk" });

      expect(files).not.toBeNull();
      const normalized = (files ?? []).map((file) => file.replace(/\\/g, "/"));
      expect(normalized.some((file) => file.endsWith("/tracked.ts"))).toBe(true);
      expect(normalized.some((file) => file.endsWith("/staged.ts"))).toBe(true);
      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
