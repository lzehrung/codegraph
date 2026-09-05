import fsp from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createGitDiscoveryCache, isGitRepo, listGitExcludeFiles, listUntrackedFiles } from "../src/util/git.js";
import { runGit } from "./helpers/git.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const temps = createTempRootRegistry();
afterAll(async () => {
  await temps.cleanup();
});

describe("Git process reuse", () => {
  it("memoizes concurrent repository checks per resolved root when callers share one GitDiscoveryCache", async () => {
    const root = await temps.create("codegraph-git-processes-");
    runGit(root, ["init"]);
    const traceFile = path.join(root, "git-trace.log");
    const cache = createGitDiscoveryCache();
    const originalGitTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = traceFile;
    let results: boolean[];
    try {
      results = await Promise.all([
        isGitRepo(root, cache),
        isGitRepo(root, cache),
        isGitRepo(path.resolve(root), cache),
      ]);
    } finally {
      if (originalGitTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = originalGitTrace;
    }

    expect(results).toEqual([true, true, true]);
    const trace = await fsp.readFile(traceFile, "utf8");
    expect(trace.match(/git rev-parse --is-inside-work-tree/g)).toHaveLength(1);
  });

  it("does not share repository checks across callers with no explicit GitDiscoveryCache", async () => {
    // Without an explicit cache, isGitRepo must stay fresh: no hidden module-global memo
    // may serve a stale answer to an unrelated caller in the same process.
    const root = await temps.create("codegraph-git-processes-uncached-");
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
    expect(trace.match(/git rev-parse --is-inside-work-tree/g)).toHaveLength(3);
  });

  it("detects a non-Git directory becoming a Git repository without a stale cached answer", async () => {
    const root = await temps.create("codegraph-git-transition-");

    expect(await isGitRepo(root)).toBe(false);

    runGit(root, ["init"]);

    expect(await isGitRepo(root)).toBe(true);
  });

  it("reflects a configured core.excludesFile change in a fresh GitDiscoveryCache but not a reused one", async () => {
    const root = await temps.create("codegraph-git-excludes-fresh-");
    runGit(root, ["init"]);
    const firstExcludes = path.join(root, "first-excludes.txt");
    const secondExcludes = path.join(root, "second-excludes.txt");
    await fsp.writeFile(firstExcludes, "first.ignored\n", "utf8");
    await fsp.writeFile(secondExcludes, "second.ignored\n", "utf8");
    runGit(root, ["config", "core.excludesFile", firstExcludes]);

    const reusedCache = createGitDiscoveryCache();
    const beforeChange = await listGitExcludeFiles(root, { discoveryCache: reusedCache });
    expect(beforeChange.map((source) => path.resolve(source.file))).toContain(path.resolve(firstExcludes));

    runGit(root, ["config", "core.excludesFile", secondExcludes]);

    // The same cache instance still answers for this operation: it must not re-probe Git
    // mid-operation and silently change the config-hash input set out from under a caller.
    const stillReused = await listGitExcludeFiles(root, { discoveryCache: reusedCache });
    expect(stillReused.map((source) => path.resolve(source.file))).toContain(path.resolve(firstExcludes));
    expect(stillReused.map((source) => path.resolve(source.file))).not.toContain(path.resolve(secondExcludes));

    // A fresh context for the next operation must see the current configured excludes file,
    // proving no hidden global memo pins the stale answer beyond its own operation.
    const freshCache = createGitDiscoveryCache();
    const afterChange = await listGitExcludeFiles(root, { discoveryCache: freshCache });
    expect(afterChange.map((source) => path.resolve(source.file))).toContain(path.resolve(secondExcludes));
    expect(afterChange.map((source) => path.resolve(source.file))).not.toContain(path.resolve(firstExcludes));
  });

  it("keeps respectGitignore:true and respectGitignore:false results distinct within one shared GitDiscoveryCache", async () => {
    const root = await temps.create("codegraph-git-untracked-respect-");
    runGit(root, ["init"]);
    await fsp.writeFile(path.join(root, ".gitignore"), "ignored.txt\n", "utf8");
    runGit(root, ["add", ".gitignore"]);
    runGit(root, ["commit", "-m", "ignore rule"]);
    await fsp.writeFile(path.join(root, "plain.txt"), "plain\n", "utf8");
    await fsp.writeFile(path.join(root, "ignored.txt"), "ignored\n", "utf8");

    const cache = createGitDiscoveryCache();
    const respecting = await listUntrackedFiles(root, { discoveryCache: cache, respectGitignore: true });
    const ignoringRules = await listUntrackedFiles(root, { discoveryCache: cache, respectGitignore: false });

    const respectingNames = respecting.map((file) => path.basename(file)).sort();
    const ignoringNames = ignoringRules.map((file) => path.basename(file)).sort();

    expect(respectingNames).toEqual(["plain.txt"]);
    expect(ignoringNames).toEqual(["ignored.txt", "plain.txt"]);
  });

  it("shows newly added untracked files to a fresh GitDiscoveryCache while a reused cache stays stable", async () => {
    const root = await temps.create("codegraph-git-untracked-fresh-");
    runGit(root, ["init"]);
    await fsp.writeFile(path.join(root, "first.txt"), "first\n", "utf8");

    const reusedCache = createGitDiscoveryCache();
    const beforeAdd = await listUntrackedFiles(root, { discoveryCache: reusedCache });
    expect(beforeAdd.map((file) => path.basename(file)).sort()).toEqual(["first.txt"]);

    await fsp.writeFile(path.join(root, "second.txt"), "second\n", "utf8");

    const stillReused = await listUntrackedFiles(root, { discoveryCache: reusedCache });
    expect(stillReused.map((file) => path.basename(file)).sort()).toEqual(["first.txt"]);

    const freshCache = createGitDiscoveryCache();
    const afterAdd = await listUntrackedFiles(root, { discoveryCache: freshCache });
    expect(afterAdd.map((file) => path.basename(file)).sort()).toEqual(["first.txt", "second.txt"]);
  });
});
