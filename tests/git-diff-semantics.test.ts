import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listChangedFiles, listUntrackedFiles, getUnifiedDiff } from "../src/util.js";
import { runGit as git } from "./helpers/git.js";

function makeGitTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeGitTempDir(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

describe("git diff semantics", () => {
  it("uses explicit base..head ranges", async () => {
    const root = await makeGitTempDir("codegraph-git-range-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const file = path.join(root, "a.ts");
      await fs.writeFile(file, "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      const base = git(root, ["rev-parse", "HEAD"]);

      await fs.writeFile(file, "export const a = 2;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "head"]);
      const head = git(root, ["rev-parse", "HEAD"]);

      const changed = await listChangedFiles(root, { base, head });
      expect(changed.some((entry) => entry.endsWith("/a.ts"))).toBe(true);

      const diff = await getUnifiedDiff(root, { base, head });
      expect(diff).toContain("diff --git a/a.ts b/a.ts");
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("uses changedSince as git diff <rev> against working tree/index", async () => {
    const root = await makeGitTempDir("codegraph-git-since-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const file = path.join(root, "a.ts");
      await fs.writeFile(file, "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      const base = git(root, ["rev-parse", "HEAD"]);

      await fs.writeFile(file, "export const a = 3;\n", "utf8");

      const changed = await listChangedFiles(root, { changedSince: base });
      expect(changed.some((entry) => entry.endsWith("/a.ts"))).toBe(true);

      const diff = await getUnifiedDiff(root, { changedSince: base });
      expect(diff).toContain("+export const a = 3;");
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("supports WORKTREE as a base/head sentinel against the working tree", async () => {
    const root = await makeGitTempDir("codegraph-git-worktree-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const modifiedFile = path.join(root, "a.ts");
      const addedFile = path.join(root, "b.ts");
      await fs.writeFile(modifiedFile, "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      const base = git(root, ["rev-parse", "HEAD"]);

      await fs.writeFile(modifiedFile, "export const a = 2;\n", "utf8");
      await fs.writeFile(addedFile, "export const b = 1;\n", "utf8");
      git(root, ["add", "b.ts"]);

      const changed = await listChangedFiles(root, { base, head: "WORKTREE" });
      expect(changed.some((entry) => entry.endsWith("/a.ts"))).toBe(true);
      expect(changed.some((entry) => entry.endsWith("/b.ts"))).toBe(true);

      const diff = await getUnifiedDiff(root, { base, head: "WORKTREE" });
      expect(diff).toContain("+export const a = 2;");
      expect(diff).toContain("diff --git a/b.ts b/b.ts");
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("supports STAGED and INDEX as base/head sentinels against the current index", async () => {
    const root = await makeGitTempDir("codegraph-git-index-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const unstagedFile = path.join(root, "a.ts");
      const stagedFile = path.join(root, "b.ts");
      await fs.writeFile(unstagedFile, "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      const base = git(root, ["rev-parse", "HEAD"]);

      await fs.writeFile(unstagedFile, "export const a = 2;\n", "utf8");
      await fs.writeFile(stagedFile, "export const b = 1;\n", "utf8");
      git(root, ["add", "b.ts"]);

      const stagedChanged = await listChangedFiles(root, { base, head: "STAGED" });
      const indexChanged = await listChangedFiles(root, { base, head: "INDEX" });
      expect(stagedChanged.some((entry) => entry.endsWith("/b.ts"))).toBe(true);
      expect(stagedChanged.some((entry) => entry.endsWith("/a.ts"))).toBe(false);
      expect(indexChanged).toEqual(stagedChanged);

      const diff = await getUnifiedDiff(root, { base, head: "STAGED" });
      expect(diff).toContain("diff --git a/b.ts b/b.ts");
      expect(diff).not.toContain("+export const a = 2;");
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("surfaces invalid git revisions instead of returning empty results", async () => {
    const root = await makeGitTempDir("codegraph-git-invalid-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const file = path.join(root, "a.ts");
      await fs.writeFile(file, "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      await expect(listChangedFiles(root, { base: "definitely-not-a-ref", head: "HEAD" })).rejects.toThrow(
        /definitely-not-a-ref/,
      );
      await expect(getUnifiedDiff(root, { base: "definitely-not-a-ref", head: "HEAD" })).rejects.toThrow(
        /definitely-not-a-ref/,
      );
    } finally {
      await removeGitTempDir(root);
    }
  });
});

describe("listUntrackedFiles", () => {
  it("lists new files Git has not been told to track", async () => {
    const root = await makeGitTempDir("codegraph-git-untracked-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const trackedFile = path.join(root, "tracked.ts");
      await fs.writeFile(trackedFile, "export const tracked = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      const untrackedFile = path.join(root, "fresh.ts");
      await fs.writeFile(untrackedFile, "export const fresh = 1;\n", "utf8");

      const untracked = await listUntrackedFiles(root);
      expect(untracked.some((entry) => entry.endsWith("/fresh.ts"))).toBe(true);
      expect(untracked.some((entry) => entry.endsWith("/tracked.ts"))).toBe(false);
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("excludes gitignored untracked files by default and includes them when respectGitignore is false", async () => {
    const root = await makeGitTempDir("codegraph-git-untracked-ignore-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, ".gitignore"), "ignored.ts\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      await fs.writeFile(path.join(root, "ignored.ts"), "export const ignored = 1;\n", "utf8");
      await fs.writeFile(path.join(root, "kept.ts"), "export const kept = 1;\n", "utf8");

      const respectingGitignore = await listUntrackedFiles(root);
      expect(respectingGitignore.some((entry) => entry.endsWith("/kept.ts"))).toBe(true);
      expect(respectingGitignore.some((entry) => entry.endsWith("/ignored.ts"))).toBe(false);

      const allUntracked = await listUntrackedFiles(root, { respectGitignore: false });
      expect(allUntracked.some((entry) => entry.endsWith("/ignored.ts"))).toBe(true);
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("returns an empty list without invoking Git when gitAvailable is false", async () => {
    const root = await makeGitTempDir("codegraph-git-untracked-unavailable-");
    try {
      // No `git init`: any accidental git invocation here would throw, not return [].
      const untracked = await listUntrackedFiles(root, { gitAvailable: false });
      expect(untracked).toEqual([]);
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("surfaces Git failures instead of silently returning an empty list", async () => {
    const root = await makeGitTempDir("codegraph-git-untracked-not-a-repo-");
    try {
      // No `git init`, so `git ls-files` fails; callers decide their own fallback policy.
      await expect(listUntrackedFiles(root)).rejects.toThrow();
    } finally {
      await removeGitTempDir(root);
    }
  });
});
