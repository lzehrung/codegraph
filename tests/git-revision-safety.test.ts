import { describe, expect, it } from "vitest";
import { assertSafeRevision, gitDiffArgs, getUnifiedDiff, listChangedFiles } from "../src/util/git.js";

describe("git revision safety", () => {
  it("rejects revisions that start with -", () => {
    expect(() => assertSafeRevision("--output=/tmp/evil", "base")).toThrow(/must not start with "-"/);
    expect(() => assertSafeRevision("", "head")).toThrow(/must not be empty/);
  });

  it("places --end-of-options immediately before revision arguments in gitDiffArgs", () => {
    expect(gitDiffArgs("main", "HEAD")).toEqual(["diff", "--end-of-options", "main..HEAD"]);
    expect(gitDiffArgs("main", "WORKTREE", ["--name-only"])).toEqual([
      "diff",
      "--name-only",
      "--end-of-options",
      "main",
    ]);
    expect(gitDiffArgs("main", "STAGED", ["--name-only"])).toEqual([
      "diff",
      "--cached",
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
