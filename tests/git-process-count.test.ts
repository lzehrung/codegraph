import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isGitRepo } from "../src/util/git.js";
import { runGit } from "./helpers/git.js";

describe("Git process reuse", () => {
  it("memoizes concurrent repository checks per resolved root", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-git-processes-"));
    runGit(root, ["init"]);
    const traceFile = path.join(root, "git-trace.log");
    const originalGitTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = traceFile;
    let results: boolean[];
    try {
      results = await Promise.all([isGitRepo(root), isGitRepo(root), isGitRepo(path.resolve(root))]);
    } finally {
      if (originalGitTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = originalGitTrace;
    }

    expect(results).toEqual([true, true, true]);
    const trace = await fsp.readFile(traceFile, "utf8");
    expect(trace.match(/git rev-parse --is-inside-work-tree/g)).toHaveLength(1);
  });
});
