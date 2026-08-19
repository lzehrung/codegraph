import { describe, expect, it } from "vitest";
import { assertSafeRevision, gitDiffArgs, getUnifiedDiff, listChangedFiles } from "../src/util/git.js";

describe("git revision safety", () => {
  it("rejects revisions that could be parsed as options or additional requests", () => {
    expect(() => assertSafeRevision("--output=/tmp/evil", "base")).toThrow(/must not start with "-"/);
    expect(() => assertSafeRevision("", "head")).toThrow(/must not be empty/);
    for (const revision of ["HEAD\nHEAD", "HEAD\rHEAD", "HEAD\0HEAD"]) {
      expect(() => assertSafeRevision(revision, "base")).toThrow(/must not contain NUL or newline characters/);
    }
  });

  it("places diff safety and --end-of-options before revision arguments in gitDiffArgs", () => {
    expect(gitDiffArgs("main", "HEAD")).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--end-of-options",
      "main..HEAD",
    ]);
    expect(gitDiffArgs("main", "WORKTREE", ["--name-only"])).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--name-only",
      "--end-of-options",
      "main",
    ]);
    expect(gitDiffArgs("main", "STAGED", ["--name-only"])).toEqual([
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--name-only",
      "--end-of-options",
      "main",
    ]);
  });

  it("rejects unsafe changedSince values before invoking git", async () => {
    await expect(listChangedFiles(process.cwd(), { changedSince: "--output=/tmp/evil" })).rejects.toThrow(
      /must not start with "-"/,
    );
    await expect(getUnifiedDiff(process.cwd(), { changedSince: "--upload-pack=evil" })).rejects.toThrow(
      /must not start with "-"/,
    );
  });

  it("rejects unsafe base/head values before invoking git", async () => {
    await expect(listChangedFiles(process.cwd(), { base: "--output=/tmp/evil", head: "HEAD" })).rejects.toThrow(
      /must not start with "-"/,
    );
  });
});
