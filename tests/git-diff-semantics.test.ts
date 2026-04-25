import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listChangedFiles, getUnifiedDiff } from "../src/util.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("git diff semantics", () => {
  it("uses explicit base..head ranges", async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), "tmp-git-range-"));
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
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses changedSince as git diff <rev> against working tree/index", async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), "tmp-git-since-"));
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
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces invalid git revisions instead of returning empty results", async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), "tmp-git-invalid-"));
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const file = path.join(root, "a.ts");
      await fs.writeFile(file, "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      await expect(
        listChangedFiles(root, { base: "definitely-not-a-ref", head: "HEAD" }),
      ).rejects.toThrow(/definitely-not-a-ref/);
      await expect(
        getUnifiedDiff(root, { base: "definitely-not-a-ref", head: "HEAD" }),
      ).rejects.toThrow(/definitely-not-a-ref/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
