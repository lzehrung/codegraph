import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const walkState = { count: 0 };

vi.mock("../src/util/projectFiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/projectFiles.js")>();
  return {
    ...actual,
    listProjectFiles: async (
      ...args: Parameters<typeof actual.listProjectFiles>
    ): ReturnType<typeof actual.listProjectFiles> => {
      walkState.count += 1;
      return await actual.listProjectFiles(...args);
    },
    listProjectFilesWithGitCandidates: async (
      ...args: Parameters<typeof actual.listProjectFilesWithGitCandidates>
    ): ReturnType<typeof actual.listProjectFilesWithGitCandidates> => {
      walkState.count += 1;
      return await actual.listProjectFilesWithGitCandidates(...args);
    },
  };
});

import { parseCliArgs } from "../src/cli/context.js";
import * as cliContext from "../src/cli/context.js";
import { createCliBaseContext, loadCliProjectContext } from "../src/cli/invocationContext.js";
import { normalizePath } from "../src/util/paths.js";
import * as projectFilesModule from "../src/util/projectFiles.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

const tempRoots = createTempRootRegistry();

async function writeFile(root: string, relativePath: string, contents: string): Promise<string> {
  const absolutePath = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, contents, "utf8");
  return normalizePath(absolutePath);
}

async function createGitFixture(): Promise<string> {
  const root = await tempRoots.create("cg-cli-resolve-disc-");
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "tests@example.com"]);
  runGit(root, ["config", "user.name", "Tests"]);
  await writeFile(root, ".gitignore", "build_artifacts/\n");
  await writeFile(root, "src/app.py", "def app():\n    return 1\n");
  await writeFile(root, "src/util.py", "def util():\n    return 2\n");
  await writeFile(root, "pkg/a/main.py", "def a():\n    return 3\n");
  await writeFile(root, "pkg/b/main.py", "def b():\n    return 4\n");
  await writeFile(root, "pkg/b/extra.py", "def extra():\n    return 5\n");
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-m", "fixtures"]);
  return root;
}

async function loadContext(root: string, args: string[]) {
  const parsed = parseCliArgs("graph", ["--root", root, ...args]);
  const base = createCliBaseContext("graph", parsed);
  return await loadCliProjectContext(base);
}

describe("CLI resolve discovery", () => {
  afterEach(async () => {
    walkState.count = 0;
    vi.restoreAllMocks();
    await tempRoots.cleanup();
  });

  test("resolveFilesFromRoots performs one project walk without CLI globs and matches prior result shape", async () => {
    const root = await createGitFixture();
    const expected = await projectFilesModule.listProjectFiles(root, undefined, {
      gitignoreRoot: root,
    });
    walkState.count = 0;

    const ctx = await loadContext(root, []);
    const actual = await ctx.resolveFilesFromRoots();

    expect(walkState.count).toBe(1);
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  test("emits include-glob and ignore-glob diagnostics including Did you mean suggestions", async () => {
    const root = await createGitFixture();
    const stderr: string[] = [];
    vi.spyOn(cliContext, "writeStderrLine").mockImplementation((message: string) => {
      stderr.push(message);
    });

    const ctx = await loadContext(root, [
      "pkg/b",
      "--include-glob",
      "pkg/b/**/*.ts",
      "--ignore-glob",
      "pkg/b/missing/**",
    ]);
    const files = await ctx.resolveFilesFromRoots();

    expect(files).toEqual([]);
    expect(stderr).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Warning: --include-glob "pkg/b/**/*.ts" matched no files under scan root "pkg/b"'),
        expect.stringContaining('Did you mean "**/*.ts"?'),
        expect.stringContaining('Warning: --ignore-glob "pkg/b/missing/**" matched no files under scan root "pkg/b"'),
        expect.stringContaining('Did you mean "missing/**"?'),
      ]),
    );
  });

  test("successive resolveFiles calls and listProjectFilesForScan share one filesystem walk", async () => {
    const root = await createGitFixture();
    const ctx = await loadContext(root, []);
    walkState.count = 0;

    const first = await ctx.resolveFiles();
    const second = await ctx.resolveFiles();
    const scanned = await ctx.listProjectFilesForScan(ctx.projectRootFs);

    expect(walkState.count).toBe(1);
    expect([...second].sort()).toEqual([...first].sort());
    expect([...scanned].sort()).toEqual([...first].sort());
  });

  test("gitignoreRoot equal to the scan root still uses Git candidates", async () => {
    const root = await createGitFixture();
    const steps: Array<{ name: string }> = [];
    await projectFilesModule.listProjectFilesWithGitCandidates(root, undefined, {
      gitignoreRoot: root,
      onDiscoveryTiming: (step) => {
        steps.push(step);
      },
    });
    expect(steps.some((step) => step.name === "git-list")).toBe(true);
    expect(steps.some((step) => step.name === "filesystem-scan")).toBe(false);
  });

  test("include-root resolution stays scoped and CLI globs apply per scan root", async () => {
    const root = await createGitFixture();
    const stderr: string[] = [];
    vi.spyOn(cliContext, "writeStderrLine").mockImplementation((message: string) => {
      stderr.push(message);
    });
    const ctx = await loadContext(root, ["pkg/a", "pkg/b", "--include-glob", "**/extra.py"]);
    const files = await ctx.resolveFilesFromRoots();
    const normalized = files.map((file) => normalizePath(file)).sort();

    expect(normalized).toEqual([normalizePath(path.join(root, "pkg/b/extra.py"))]);
    expect(normalized.every((file) => file.includes("/pkg/"))).toBe(true);
    expect(normalized.some((file) => file.includes("/src/"))).toBe(false);
    expect(stderr.some((line) => line.includes('scan root "pkg/a"'))).toBe(true);
  });

  test("CLI include-glob and ignore-glob results match walker-baked discoveryOptions", async () => {
    const root = await createGitFixture();
    vi.spyOn(cliContext, "writeStderrLine").mockImplementation(() => {});

    const includeCtx = await loadContext(root, ["--include-glob", "pkg/b/**"]);
    const includeActual = await includeCtx.resolveFilesFromRoots();
    const includeExpected = await projectFilesModule.listProjectFiles(root, undefined, {
      ...includeCtx.discoveryOptions,
      gitignoreRoot: root,
    });
    expect([...includeActual].sort()).toEqual([...includeExpected].sort());
    expect(includeActual.length).toBeGreaterThan(0);

    const ignoreCtx = await loadContext(root, ["--ignore-glob", "pkg/a/**"]);
    const ignoreActual = await ignoreCtx.resolveFilesFromRoots();
    const ignoreExpected = await projectFilesModule.listProjectFiles(root, undefined, {
      ...ignoreCtx.discoveryOptions,
      gitignoreRoot: root,
    });
    expect([...ignoreActual].sort()).toEqual([...ignoreExpected].sort());
    expect(ignoreActual.length).toBeGreaterThan(0);
    expect(ignoreActual.map((file) => normalizePath(file))).not.toContain(
      normalizePath(path.join(root, "pkg/a/main.py")),
    );
  });
});
