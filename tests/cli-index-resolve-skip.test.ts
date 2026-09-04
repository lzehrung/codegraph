import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { handleIndexCommand, type IndexCommandContext } from "../src/cli/index.js";
import * as indexerBuild from "../src/indexer/build-index.js";
import type { ProjectIndex } from "../src/indexer.js";
import { captureCli } from "./helpers/cli.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

const emptyIndex: ProjectIndex = {
  graph: { nodes: new Set<string>(), edges: [] },
  modules: new Map(),
  byFile: new Map(),
  exportCache: new Map(),
  scopeCache: new Map(),
};

function createIndexContext(overrides: Partial<IndexCommandContext>): IndexCommandContext {
  const projectRoot = path.join("tmp", "codegraph-index-resolve-skip").replace(/\\/g, "/");
  return {
    projectRootFs: projectRoot,
    includeRootsAbs: [],
    languageExtensions: undefined,
    gitBase: undefined,
    changedSince: undefined,
    discoveryOptions: {},
    nativeMode: "off",
    workerOpts: {},
    cacheLocation: undefined,
    progressHandler: undefined,
    graphOptions: undefined,
    reportEnabled: false,
    reportFile: undefined,
    showProgress: false,
    getOpt: (name) => (name === "--cache" ? "off" : undefined),
    hasFlag: () => false,
    resolveFiles: async () => [],
    writeJSONLine: () => {
      throw new Error("unexpected json output");
    },
    writeStdoutLine: () => {},
    writeStderrLine: () => {
      throw new Error("unexpected stderr");
    },
    writeCommandReport: async () => {},
    maybeWriteNativeBackendStatus: () => {},
    ...overrides,
  };
}

describe("index resolve skip for whole-project runs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("whole-project index without include roots, git range, or CLI globs does not call resolveFiles", async () => {
    const root = await mkTmpDir("codegraph-index-resolve-skip-whole-");
    let resolveCalls = 0;
    const incrementalSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockResolvedValue(emptyIndex);
    const fromFilesSpy = vi.spyOn(indexerBuild, "buildProjectIndexFromFiles").mockResolvedValue(emptyIndex);

    try {
      await handleIndexCommand(
        createIndexContext({
          projectRootFs: root,
          includeRootsAbs: [],
          resolveFiles: async () => {
            resolveCalls += 1;
            return [];
          },
        }),
      );

      expect(resolveCalls).toBe(0);
      expect(incrementalSpy).toHaveBeenCalledOnce();
      expect(fromFilesSpy).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("scoped include roots and git-base runs resolve once and pass the list to buildProjectIndexFromFiles", async () => {
    const root = await mkTmpDir("codegraph-index-resolve-skip-scoped-");
    const entryFile = path.join(root, "entry.ts").replace(/\\/g, "/");
    await fsp.writeFile(entryFile, "export const value = 1;\n", "utf8");
    const resolvedFiles = [entryFile];
    const fromFilesSpy = vi.spyOn(indexerBuild, "buildProjectIndexFromFiles").mockResolvedValue(emptyIndex);
    const incrementalSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockResolvedValue(emptyIndex);

    try {
      let scopedResolveCalls = 0;
      await handleIndexCommand(
        createIndexContext({
          projectRootFs: root,
          includeRootsAbs: [root.replace(/\\/g, "/")],
          resolveFiles: async () => {
            scopedResolveCalls += 1;
            return resolvedFiles;
          },
        }),
      );
      expect(scopedResolveCalls).toBe(1);
      expect(fromFilesSpy).toHaveBeenCalledWith(root, resolvedFiles, expect.any(Object));
      expect(incrementalSpy).not.toHaveBeenCalled();

      fromFilesSpy.mockClear();
      incrementalSpy.mockClear();

      let baseResolveCalls = 0;
      await handleIndexCommand(
        createIndexContext({
          projectRootFs: root,
          includeRootsAbs: [],
          gitBase: "HEAD~1",
          resolveFiles: async () => {
            baseResolveCalls += 1;
            return resolvedFiles;
          },
        }),
      );
      expect(baseResolveCalls).toBe(1);
      expect(fromFilesSpy).toHaveBeenCalledWith(root, resolvedFiles, expect.any(Object));
      expect(incrementalSpy).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("resolveFilesMs is omitted when resolve is skipped and present when resolve runs", async () => {
    const root = await mkTmpDir("codegraph-index-resolve-skip-timing-");
    vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockResolvedValue(emptyIndex);
    vi.spyOn(indexerBuild, "buildProjectIndexFromFiles").mockResolvedValue(emptyIndex);

    try {
      const skippedReports: unknown[] = [];
      await handleIndexCommand(
        createIndexContext({
          projectRootFs: root,
          includeRootsAbs: [],
          reportEnabled: true,
          writeCommandReport: async (report) => {
            skippedReports.push(report);
          },
        }),
      );
      const skipped = skippedReports[0] as { timings?: { resolveFilesMs?: number } };
      expect(skipped.timings).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(skipped.timings, "resolveFilesMs")).toBe(false);

      const resolvedReports: unknown[] = [];
      await handleIndexCommand(
        createIndexContext({
          projectRootFs: root,
          includeRootsAbs: [root.replace(/\\/g, "/")],
          reportEnabled: true,
          resolveFiles: async () => [],
          writeCommandReport: async (report) => {
            resolvedReports.push(report);
          },
        }),
      );
      const resolved = resolvedReports[0] as { timings?: { resolveFilesMs?: number } };
      expect(typeof resolved.timings?.resolveFilesMs).toBe("number");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("whole-project index with a matching-nothing --include-glob still warns on stderr", async () => {
    const root = await mkTmpDir("codegraph-index-resolve-skip-glob-");
    await fsp.writeFile(path.join(root, "entry.ts"), "export const value = 1;\n", "utf8");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);

    try {
      const result = await captureCli(
        ["index", "--root", ".", "--cache", "off", "--native", "off", "--include-glob", "does-not-exist/**"],
        { cwd: root },
      );
      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toContain(
        'Warning: --include-glob "does-not-exist/**" matched no files under scan root "."',
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
