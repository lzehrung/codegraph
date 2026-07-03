import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { captureCli, runCliOrThrow } from "./helpers/cli.js";
import { mkTmpDir, normalizeTestPath } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

type ProjectFile = {
  path: string;
  contents: string;
};

type AffectedTestEntry = {
  file: string;
  reasons: string[];
  depth: number;
};

type AffectedJsonReport = {
  schemaVersion: 1;
  root: string;
  changedFiles: string[];
  affectedTests: AffectedTestEntry[];
  omittedCounts: {
    changedFiles: number;
    filteredTests: number;
  };
};

const affectedCliTimeoutMs = 30_000;

async function writeProjectFile(root: string, file: ProjectFile): Promise<void> {
  const absolutePath = path.join(root, file.path);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, file.contents, "utf8");
}

async function createTypescriptProject(prefix: string, files: readonly ProjectFile[]): Promise<string> {
  const root = await mkTmpDir(prefix);
  await Promise.all(files.map(async (file) => await writeProjectFile(root, file)));
  return root;
}

async function runAffectedJson(
  root: string,
  args: readonly string[],
  stdin?: string,
  cwd = root,
): Promise<AffectedJsonReport> {
  const result = await runCliOrThrow(["affected", "--root", root, "--cache", "memory", "--json", ...args], {
    cwd,
    stdin,
  });
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as AffectedJsonReport;
}

async function runAffectedQuiet(root: string, args: readonly string[]): Promise<string[]> {
  const result = await runCliOrThrow(["affected", "--root", root, "--cache", "memory", "--quiet", ...args], {
    cwd: root,
  });
  expect(result.stderr).toBe("");
  return result.stdout.trimEnd().split("\n").filter(Boolean);
}

function expectReasonMentions(entry: AffectedTestEntry | undefined, expectedPath: string): void {
  expect(entry).toBeDefined();
  expect(entry?.reasons).toEqual(expect.arrayContaining([expect.stringContaining(expectedPath)]));
}

describe("affected CLI", () => {
  it(
    "maps positional source files to direct importing tests and emits sorted root-relative JSON",
    async () => {
      const root = await createTypescriptProject("cg-affected-direct-", [
        {
          path: "src/format.ts",
          contents: "export function formatName(name: string) { return name.trim().toUpperCase(); }\n",
        },
        {
          path: "src/math.ts",
          contents: "export function add(left: number, right: number) { return left + right; }\n",
        },
        {
          path: "tests/z-format.test.ts",
          contents:
            "import { formatName } from '../src/format';\nif (formatName(' Ada ') !== 'ADA') throw new Error('bad format');\n",
        },
        {
          path: "tests/a-math.test.ts",
          contents: "import { add } from '../src/math';\nif (add(1, 2) !== 3) throw new Error('bad math');\n",
        },
        {
          path: "tests/unrelated.test.ts",
          contents: "const untouched = 1;\nif (untouched !== 1) throw new Error('unreachable');\n",
        },
      ]);

      const report = await runAffectedJson(root, ["src/math.ts", "src/format.ts"]);

      expect(report.schemaVersion).toBe(1);
      expect(normalizeTestPath(report.root)).toBe(normalizeTestPath(root));
      expect(report.changedFiles).toEqual(["src/format.ts", "src/math.ts"]);
      expect(report.affectedTests.map(({ file, depth }) => ({ file, depth }))).toEqual([
        { file: "tests/a-math.test.ts", depth: 1 },
        { file: "tests/z-format.test.ts", depth: 1 },
      ]);
      const sortedAffectedFiles = report.affectedTests.map((entry) => entry.file).sort();
      expect(report.affectedTests.map((entry) => entry.file)).toEqual(sortedAffectedFiles);
      expectReasonMentions(report.affectedTests[0], "src/math.ts");
      expectReasonMentions(report.affectedTests[1], "src/format.ts");
      expect(report.omittedCounts).toEqual({ changedFiles: 0, filteredTests: 0 });
    },
    affectedCliTimeoutMs,
  );

  it(
    "walks transitive reverse dependencies up to the requested depth",
    async () => {
      const root = await createTypescriptProject("cg-affected-transitive-", [
        {
          path: "src/core.ts",
          contents: "export function loadUser(id: string) { return { id, name: 'Ada' }; }\n",
        },
        {
          path: "src/service.ts",
          contents:
            "import { loadUser } from './core';\nexport function renderUser(id: string) { return loadUser(id).name; }\n",
        },
        {
          path: "tests/service.test.ts",
          contents:
            "import { renderUser } from '../src/service';\nif (renderUser('42') !== 'Ada') throw new Error('bad user');\n",
        },
      ]);

      const shallowReport = await runAffectedJson(root, ["src/core.ts", "--depth", "1"]);
      const report = await runAffectedJson(root, ["src/core.ts", "--depth", "2"]);

      expect(shallowReport.changedFiles).toEqual(["src/core.ts"]);
      expect(shallowReport.affectedTests).toEqual([]);
      expect(report.changedFiles).toEqual(["src/core.ts"]);
      expect(report.affectedTests.map(({ file, depth }) => ({ file, depth }))).toEqual([
        { file: "tests/service.test.ts", depth: 2 },
      ]);
      expectReasonMentions(report.affectedTests[0], "src/core.ts");
    },
    affectedCliTimeoutMs,
  );

  it(
    "with --depth 0 reports directly changed tests but not tests that only import changed sources",
    async () => {
      const root = await createTypescriptProject("cg-affected-depth-zero-", [
        {
          path: "src/core.ts",
          contents: "export function value() { return 42; }\n",
        },
        {
          path: "tests/core.test.ts",
          contents: "import { value } from '../src/core';\nif (value() !== 42) throw new Error('bad value');\n",
        },
        {
          path: "tests/changed.test.ts",
          contents: "const changedTestStillRuns = true;\nif (!changedTestStillRuns) throw new Error('bad test');\n",
        },
      ]);

      const report = await runAffectedJson(root, ["src/core.ts", "tests/changed.test.ts", "--depth", "0"]);

      expect(report.changedFiles).toEqual(["src/core.ts", "tests/changed.test.ts"]);
      expect(report.affectedTests.map(({ file, depth }) => ({ file, depth }))).toEqual([
        { file: "tests/changed.test.ts", depth: 0 },
      ]);
      expect(report.affectedTests[0]?.reasons).toEqual(["changed test file"]);
    },
    affectedCliTimeoutMs,
  );

  it(
    "reads newline-delimited changed paths from --stdin",
    async () => {
      const root = await createTypescriptProject("cg-affected-stdin-", [
        {
          path: "src/parser.ts",
          contents: "export function parseFlag(input: string) { return input === 'yes'; }\n",
        },
        {
          path: "tests/parser.test.ts",
          contents:
            "import { parseFlag } from '../src/parser';\nif (!parseFlag('yes')) throw new Error('bad parser');\n",
        },
      ]);

      const report = await runAffectedJson(root, ["--stdin"], "\nsrc/parser.ts\n\n");

      expect(report.changedFiles).toEqual(["src/parser.ts"]);
      expect(report.affectedTests.map(({ file, depth }) => ({ file, depth }))).toEqual([
        { file: "tests/parser.test.ts", depth: 1 },
      ]);
      expectReasonMentions(report.affectedTests[0], "src/parser.ts");
    },
    affectedCliTimeoutMs,
  );

  it(
    "resolves --root as the project boundary when invoked from another cwd",
    async () => {
      const root = await createTypescriptProject("cg-affected-root-cwd-", [
        {
          path: "src/widget.ts",
          contents: "export function renderWidget() { return 'widget'; }\n",
        },
        {
          path: "tests/widget.test.ts",
          contents:
            "import { renderWidget } from '../src/widget';\nif (renderWidget() !== 'widget') throw new Error('bad widget');\n",
        },
      ]);
      const cwd = await mkTmpDir("cg-affected-outside-cwd-");

      const report = await runAffectedJson(root, ["src/widget.ts"], undefined, cwd);

      expect(normalizeTestPath(report.root)).toBe(normalizeTestPath(root));
      expect(report.changedFiles).toEqual(["src/widget.ts"]);
      expect(report.affectedTests.map(({ file, depth }) => ({ file, depth }))).toEqual([
        { file: "tests/widget.test.ts", depth: 1 },
      ]);
      expectReasonMentions(report.affectedTests[0], "src/widget.ts");
    },
    affectedCliTimeoutMs,
  );

  it(
    "rejects --base without --head with a nonzero usage error",
    async () => {
      const root = await createTypescriptProject("cg-affected-base-without-head-", [
        {
          path: "src/api.ts",
          contents: "export const api = 1;\n",
        },
      ]);

      const result = await captureCli(["affected", "--root", root, "--cache", "memory", "--json", "--base", "HEAD"], {
        cwd: root,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--base and --head must be provided together");
    },
    affectedCliTimeoutMs,
  );

  it(
    "applies --filter to the affected test set after graph traversal",
    async () => {
      const root = await createTypescriptProject("cg-affected-filter-", [
        {
          path: "src/user.ts",
          contents: "export function displayUser(name: string) { return `user:${name}`; }\n",
        },
        {
          path: "tests/integration/user.spec.ts",
          contents:
            "import { displayUser } from '../../src/user';\nif (displayUser('Ada') !== 'user:Ada') throw new Error('bad integration');\n",
        },
        {
          path: "tests/unit/user.test.ts",
          contents:
            "import { displayUser } from '../../src/user';\nif (displayUser('Ada') !== 'user:Ada') throw new Error('bad unit');\n",
        },
      ]);

      const report = await runAffectedJson(root, ["src/user.ts", "--filter", "tests/unit/**"]);

      expect(report.changedFiles).toEqual(["src/user.ts"]);
      expect(report.affectedTests.map(({ file, depth }) => ({ file, depth }))).toEqual([
        { file: "tests/unit/user.test.ts", depth: 1 },
      ]);
      expectReasonMentions(report.affectedTests[0], "src/user.ts");
      expect(report.omittedCounts).toEqual({ changedFiles: 0, filteredTests: 1 });
    },
    affectedCliTimeoutMs,
  );

  it(
    "derives changed files from --base/--head git diff without mutating the checkout",
    async () => {
      const root = await createTypescriptProject("cg-affected-git-", [
        {
          path: ".gitignore",
          contents: ".codegraph-cache/\n",
        },
        {
          path: "src/api.ts",
          contents: "export function answer() { return 41; }\n",
        },
        {
          path: "tests/api.test.ts",
          contents: "import { answer } from '../src/api';\nif (answer() !== 42) throw new Error('old api');\n",
        },
      ]);
      runGit(root, ["init"]);
      runGit(root, ["add", "."]);
      runGit(root, ["commit", "-m", "base"]);
      await writeProjectFile(root, {
        path: "src/api.ts",
        contents: "export function answer() { return 42; }\n",
      });
      runGit(root, ["add", "."]);
      runGit(root, ["commit", "-m", "head"]);
      const headBefore = runGit(root, ["rev-parse", "HEAD"]);
      const statusBefore = runGit(root, ["status", "--short"]);

      const report = await runAffectedJson(root, ["--base", "HEAD~1", "--head", "HEAD"]);
      const headAfter = runGit(root, ["rev-parse", "HEAD"]);
      const statusAfter = runGit(root, ["status", "--short"]);

      expect(report.changedFiles).toEqual(["src/api.ts"]);
      expect(report.affectedTests.map(({ file, depth }) => ({ file, depth }))).toEqual([
        { file: "tests/api.test.ts", depth: 1 },
      ]);
      expectReasonMentions(report.affectedTests[0], "src/api.ts");
      expect(headAfter).toBe(headBefore);
      expect(statusAfter).toBe(statusBefore);
    },
    affectedCliTimeoutMs,
  );

  it(
    "reports existing tests that import a source file deleted across --base/--head",
    async () => {
      const root = await createTypescriptProject("cg-affected-git-deleted-", [
        {
          path: ".gitignore",
          contents: ".codegraph-cache/\n",
        },
        {
          path: "src/legacy.ts",
          contents: "export function legacyValue() { return 7; }\n",
        },
        {
          path: "tests/legacy.test.ts",
          contents:
            "import { legacyValue } from '../src/legacy';\nif (legacyValue() !== 7) throw new Error('bad legacy');\n",
        },
      ]);
      runGit(root, ["init"]);
      runGit(root, ["add", "."]);
      runGit(root, ["commit", "-m", "base"]);
      runGit(root, ["rm", "src/legacy.ts"]);
      runGit(root, ["commit", "-m", "delete legacy"]);

      const report = await runAffectedJson(root, ["--base", "HEAD~1", "--head", "HEAD"]);

      expect(report.changedFiles).toEqual(["src/legacy.ts"]);
      expect(report.affectedTests.map(({ file, depth }) => ({ file, depth }))).toEqual([
        { file: "tests/legacy.test.ts", depth: 1 },
      ]);
      expectReasonMentions(report.affectedTests[0], "src/legacy.ts");
    },
    affectedCliTimeoutMs,
  );

  it(
    "prints only stable sorted test paths with --quiet",
    async () => {
      const root = await createTypescriptProject("cg-affected-quiet-", [
        {
          path: "src/shared.ts",
          contents: "export function shared() { return 'shared'; }\n",
        },
        {
          path: "tests/z-shared.test.ts",
          contents: "import { shared } from '../src/shared';\nif (shared() !== 'shared') throw new Error('bad z');\n",
        },
        {
          path: "tests/a-shared.spec.ts",
          contents: "import { shared } from '../src/shared';\nif (shared() !== 'shared') throw new Error('bad a');\n",
        },
      ]);

      const lines = await runAffectedQuiet(root, ["src/shared.ts"]);

      expect(lines).toEqual(["tests/a-shared.spec.ts", "tests/z-shared.test.ts"]);
    },
    affectedCliTimeoutMs,
  );
});
