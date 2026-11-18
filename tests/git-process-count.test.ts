import fsp from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildProjectIndex } from "../src/index.js";
import {
  createGitDiscoveryCache,
  getGitRepositoryRoot,
  isGitRepo,
  listChangedFiles,
  listGitExcludeFiles,
  listUntrackedFiles,
} from "../src/util/git.js";
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
  it("shares working-tree diffs within an operation without retaining them across updates", async () => {
    const root = await temps.create("codegraph-git-working-diff-");
    await fsp.writeFile(path.join(root, "tracked.ts"), "export const tracked = 1;\n");
    runGit(root, ["init"]);
    runGit(root, ["add", "tracked.ts"]);
    runGit(root, ["commit", "-m", "base"]);
    const traceFile = path.join(root, "git-trace.log");
    const originalGitTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = traceFile;
    const cache = createGitDiscoveryCache();
    const options = { base: "HEAD", head: "WORKTREE", discoveryCache: cache };
    try {
      expect(await Promise.all([listChangedFiles(root, options), listChangedFiles(root, options)])).toEqual([[], []]);
      await fsp.writeFile(path.join(root, "tracked.ts"), "export const tracked = 2;\n");
      expect(await listChangedFiles(root, options)).toEqual([]);
      const fresh = await listChangedFiles(root, { ...options, discoveryCache: createGitDiscoveryCache() });
      expect(fresh.map((file) => path.basename(file))).toEqual(["tracked.ts"]);
    } finally {
      if (originalGitTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = originalGitTrace;
    }
    const trace = await fsp.readFile(traceFile, "utf8");
    expect(trace.match(/git diff [^\r\n]*--name-only/g)).toHaveLength(2);
  });
  it("keeps complete rename history separate from destination-only working-tree diffs", async () => {
    const root = await temps.create("codegraph-git-rename-history-");
    await fsp.writeFile(path.join(root, "before.ts"), "export const value = 1;\n");
    runGit(root, ["init"]);
    runGit(root, ["add", "before.ts"]);
    runGit(root, ["commit", "-m", "base"]);
    runGit(root, ["mv", "before.ts", "after.ts"]);
    const options = { base: "HEAD", head: "WORKTREE", discoveryCache: createGitDiscoveryCache() };
    const destinations = await listChangedFiles(root, options);
    expect(destinations.map((file) => path.basename(file))).toEqual(["after.ts"]);
    const history = await listChangedFiles(root, { ...options, includeRenameSources: true });
    expect(history.map((file) => path.basename(file)).sort()).toEqual(["after.ts", "before.ts"]);
  });
  it("resolves the work tree once when repository, root, and exclude lookups share a cache", async () => {
    const root = await temps.create("codegraph-git-root-once-");
    runGit(root, ["init"]);
    const traceFile = path.join(root, "git-trace.log");
    const cache = createGitDiscoveryCache();
    const originalGitTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = traceFile;
    try {
      expect(await isGitRepo(root, cache)).toBe(true);
      expect(await getGitRepositoryRoot(root, cache)).toBe(path.resolve(root).replace(/\\/g, "/"));
      const excludes = await listGitExcludeFiles(root, { discoveryCache: cache });
      expect(Array.isArray(excludes)).toBe(true);
    } finally {
      if (originalGitTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = originalGitTrace;
    }
    const trace = await fsp.readFile(traceFile, "utf8");
    expect(trace.match(/git rev-parse --is-inside-work-tree/g)).toHaveLength(1);
    expect(trace.match(/git rev-parse --show-toplevel/g)?.length ?? trace.match(/--show-toplevel/g)?.length).toBe(1);
  });

  const buildOptions = { cache: "disk" as const, threads: 1, useNativeWorkers: false };

  function cacheAnchor(cacheRootDir: string | undefined): string {
    const normalized = (cacheRootDir ?? "").replace(/\\/g, "/");
    const marker = "/.codegraph/";
    const at = normalized.toLowerCase().indexOf(marker);
    return at >= 0 ? normalized.slice(0, at) : normalized;
  }

  function anchorsAt(cacheRootDir: string | undefined, directory: string): boolean {
    const actual = cacheAnchor(cacheRootDir);
    const expected = path.resolve(directory).replace(/\\/g, "/");
    if (process.platform === "win32") return actual.toLowerCase() === expected.toLowerCase();
    return actual === expected;
  }

  async function withoutCacheDirEnv<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.CODEGRAPH_CACHE_DIR;
    delete process.env.CODEGRAPH_CACHE_DIR;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_CACHE_DIR;
      else process.env.CODEGRAPH_CACHE_DIR = previous;
    }
  }

  async function writeChild(parent: string): Promise<string> {
    const child = path.join(parent, "sub");
    await fsp.mkdir(child, { recursive: true });
    await fsp.writeFile(path.join(child, "a.ts"), "export const a = 1;\n");
    return child;
  }

  it("sees a .git directory added or removed between builds", async () => {
    const parent = await temps.create("codegraph-anchor-git-");
    const child = await writeChild(parent);
    await withoutCacheDirEnv(async () => {
      const before = await buildProjectIndex(child, buildOptions);
      expect(anchorsAt(before.cacheRootDir, child)).toBe(true);
      runGit(parent, ["init"]);
      const withGit = await buildProjectIndex(child, buildOptions);
      expect(anchorsAt(withGit.cacheRootDir, parent)).toBe(true);
      await fsp.rm(path.join(parent, ".git"), { recursive: true, force: true });
      const removed = await buildProjectIndex(child, buildOptions);
      expect(anchorsAt(removed.cacheRootDir, child)).toBe(true);
    });
  });

  it("sees a .git directory created before a rebuild scheduled during the build", async () => {
    const parent = await temps.create("codegraph-anchor-callback-");
    const child = await writeChild(parent);
    await withoutCacheDirEnv(async () => {
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let inner: Promise<string | undefined> | undefined;
      const first = await buildProjectIndex(child, {
        ...buildOptions,
        onProgress: () => {
          if (inner) return;
          inner = new Promise((resolve, reject) => {
            setImmediate(() => {
              void gate
                .then(async () => {
                  runGit(parent, ["init"]);
                  const again = await buildProjectIndex(child, buildOptions);
                  resolve(again.cacheRootDir);
                })
                .catch(reject);
            });
          });
        },
      });
      expect(anchorsAt(first.cacheRootDir, child)).toBe(true);
      if (!inner) throw new Error("expected a progress callback");
      release();
      expect(anchorsAt(await inner, parent)).toBe(true);
    });
  });

  it("keeps two concurrent builds on their own anchors", async () => {
    const parentA = await temps.create("codegraph-anchor-a-");
    const parentB = await temps.create("codegraph-anchor-b-");
    const childA = await writeChild(parentA);
    const childB = await writeChild(parentB);
    runGit(parentA, ["init"]);
    await withoutCacheDirEnv(async () => {
      const [indexA, indexB] = await Promise.all([
        buildProjectIndex(childA, buildOptions),
        buildProjectIndex(childB, buildOptions),
      ]);
      expect(anchorsAt(indexA.cacheRootDir, parentA)).toBe(true);
      expect(anchorsAt(indexB.cacheRootDir, childB)).toBe(true);
    });
  });
});
