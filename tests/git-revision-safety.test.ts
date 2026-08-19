import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertSafeRevision, gitDiffArgs, getUnifiedDiff, listChangedFiles } from "../src/util/git.js";
import { setGitExecutableForTests } from "../src/util/git.js";

afterEach(() => {
  setGitExecutableForTests(null);
  delete process.env.CODEGRAPH_GIT_ARGS_CAPTURE;
});

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
  it("constructs changedSince args with one copy of every diff safety flag", async () => {
    const captureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-git-args-"));
    const capturePath = path.join(captureRoot, "args.json");
    const captureScript =
      "import fs from 'node:fs'; fs.writeFileSync(process.env.CODEGRAPH_GIT_ARGS_CAPTURE, JSON.stringify(['diff', ...process.argv.slice(2)]));";
    await fsp.writeFile(path.join(captureRoot, "diff"), captureScript, "utf8");
    process.env.CODEGRAPH_GIT_ARGS_CAPTURE = capturePath;
    setGitExecutableForTests(process.execPath);
    try {
      await listChangedFiles(captureRoot, { changedSince: "HEAD" });
      const listArgs = JSON.parse(await fsp.readFile(capturePath, "utf8")) as string[];
      expect(listArgs).toEqual([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--name-only",
        "-z",
        "--diff-filter=ACDMRTUXB",
        "--end-of-options",
        "HEAD",
        "--",
      ]);

      await getUnifiedDiff(captureRoot, { changedSince: "HEAD" });
      const unifiedArgs = JSON.parse(await fsp.readFile(capturePath, "utf8")) as string[];
      expect(unifiedArgs).toEqual([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--unified=0",
        "--no-color",
        "--diff-filter=ACDMRTUXB",
        "--end-of-options",
        "HEAD",
        "--",
      ]);
    } finally {
      await fsp.rm(captureRoot, { recursive: true, force: true });
    }
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
