import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getDiff } from "../src/impact/providers/base.js";

const gitRepoRoots: string[] = [];

afterEach(() => {
  for (const root of gitRepoRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Codegraph Test",
      GIT_AUTHOR_EMAIL: "codegraph@example.test",
      GIT_COMMITTER_NAME: "Codegraph Test",
      GIT_COMMITTER_EMAIL: "codegraph@example.test",
    },
  }).trim();
}

function writeFile(root: string, relativePath: string, text: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function createGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-git-provider-"));
  gitRepoRoots.push(root);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "core.autocrlf", "false"]);
  return root;
}

function commitAll(root: string, message: string): string {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

describe("Impact: git provider", () => {
  it("compares arbitrary commit ranges with normal git revisions", async () => {
    const root = createGitRepo();
    writeFile(
      root,
      "src/main.ts",
      `export function main() {
  return 1;
}
`,
    );
    writeFile(root, "src/config.ts", "export const config = { enabled: true };\n");
    const base = commitAll(root, "initial");

    writeFile(
      root,
      "src/main.ts",
      `export function main() {
  return 2;
}

export function extra() {
  return main();
}
`,
    );
    writeFile(root, "src/config.ts", "export const config = { enabled: false, retries: 3 };\n");
    writeFile(root, "src/feature.ts", "export const feature = true;\n");
    const head = commitAll(root, "meaty change");

    const diff = await getDiff({ provider: "git", cwd: root, base, head });

    expect(diff.files.map((file) => file.path).sort()).toEqual(["src/config.ts", "src/feature.ts", "src/main.ts"]);
    expect(diff.files.find((file) => file.path === "src/feature.ts")?.kind).toBe("added");
    expect(diff.files.find((file) => file.path === "src/main.ts")?.hunks.length).toBeGreaterThan(0);
  });

  it("supports WORKTREE as the git provider head sentinel for staged and unstaged changes", async () => {
    const root = createGitRepo();
    writeFile(root, "src/main.ts", "export const value = 1;\n");
    const base = commitAll(root, "initial");

    writeFile(root, "src/main.ts", "export const value = 2;\n");
    writeFile(root, "src/added.ts", "export const added = true;\n");
    git(root, ["add", "src/added.ts"]);

    const diff = await getDiff({ provider: "git", cwd: root, base, head: "WORKTREE" });

    expect(diff.files.map((file) => file.path).sort()).toEqual(["src/added.ts", "src/main.ts"]);
    expect(diff.files.find((file) => file.path === "src/added.ts")?.kind).toBe("added");
    expect(diff.files.find((file) => file.path === "src/main.ts")?.kind).toBe("modified");
  });

  it("supports STAGED and INDEX as staged-only git provider head sentinels against HEAD", async () => {
    const root = createGitRepo();
    writeFile(root, "src/main.ts", "export const value = 1;\n");
    const base = commitAll(root, "initial");

    writeFile(root, "src/main.ts", "export const value = 2;\n");
    writeFile(root, "src/staged.ts", "export const staged = true;\n");
    git(root, ["add", "src/staged.ts"]);

    const stagedDiff = await getDiff({ provider: "git", cwd: root, base, head: "STAGED" });
    const indexDiff = await getDiff({ provider: "git", cwd: root, base, head: "INDEX" });

    expect(stagedDiff.files.map((file) => file.path)).toEqual(["src/staged.ts"]);
    expect(indexDiff.files.map((file) => file.path)).toEqual(["src/staged.ts"]);
  });

  it("compares an arbitrary base to the current index for STAGED and INDEX sentinels", async () => {
    const root = createGitRepo();
    writeFile(root, "src/base.ts", "export const base = 1;\n");
    const base = commitAll(root, "base");

    writeFile(root, "src/base.ts", "export const base = 2;\n");
    writeFile(root, "src/committed.ts", "export const committed = true;\n");
    commitAll(root, "committed change");

    writeFile(root, "src/staged.ts", "export const staged = true;\n");
    writeFile(root, "src/unstaged.ts", "export const unstaged = true;\n");
    git(root, ["add", "src/staged.ts"]);

    const stagedDiff = await getDiff({ provider: "git", cwd: root, base, head: "STAGED" });
    const indexDiff = await getDiff({ provider: "git", cwd: root, base, head: "INDEX" });
    const expectedFiles = ["src/base.ts", "src/committed.ts", "src/staged.ts"];

    expect(stagedDiff.files.map((file) => file.path).sort()).toEqual(expectedFiles);
    expect(indexDiff.files.map((file) => file.path).sort()).toEqual(expectedFiles);
  });
});
