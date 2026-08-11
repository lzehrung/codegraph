import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProjectIndex } from "../src/index.js";
import { copyFixtureSubset, mkTmpDir, withCopiedFixture } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

const cleanlinessScript = path.resolve(process.cwd(), "scripts", "check-fixture-cleanliness.mjs");

function runCleanlinessScript(repoRoot: string, extraArgs: readonly string[] = []) {
  return spawnSync(process.execPath, [cleanlinessScript, "--root", repoRoot, ...extraArgs], {
    encoding: "utf8",
  });
}

async function writeFixtureFile(root: string, relativePath: string, contents = "fixture\n"): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, contents, "utf8");
}

describe("fixture copies", () => {
  it("copies only the requested subset and excludes Codegraph caches", async () => {
    const sourceRoot = await mkTmpDir("codegraph-fixture-source-");
    const destinationRoot = await mkTmpDir("codegraph-fixture-destination-");
    try {
      await writeFixtureFile(sourceRoot, "root.ts");
      await writeFixtureFile(sourceRoot, path.join("nested", "kept.ts"));
      await writeFixtureFile(sourceRoot, path.join("nested", ".codegraph", "manifest.json"));
      await writeFixtureFile(sourceRoot, path.join("nested", ".codegraph-cache", "index-v1", "cache.json"));

      await copyFixtureSubset(sourceRoot, destinationRoot, { subset: ["nested"] });

      await expect(fsp.readFile(path.join(destinationRoot, "nested", "kept.ts"), "utf8")).resolves.toBe("fixture\n");
      expect(fs.existsSync(path.join(destinationRoot, "root.ts"))).toBe(false);
      expect(fs.existsSync(path.join(destinationRoot, "nested", ".codegraph"))).toBe(false);
      expect(fs.existsSync(path.join(destinationRoot, "nested", ".codegraph-cache"))).toBe(false);
    } finally {
      await Promise.all([
        fsp.rm(sourceRoot, { recursive: true, force: true }),
        fsp.rm(destinationRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("keeps cache-off indexing read-only", async () => {
    const root = await mkTmpDir("codegraph-read-only-index-");
    try {
      await writeFixtureFile(root, "source.ts", "export const value = 1;\n");
      await buildProjectIndex(root, { cache: "off" });
      expect(fs.existsSync(path.join(root, ".codegraph-cache"))).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("gives concurrent workers distinct copies and removes them afterward", async () => {
    const sourceRoot = await mkTmpDir("codegraph-fixture-concurrent-source-");
    await writeFixtureFile(sourceRoot, "fixture.ts");
    const previousKeepValue = process.env.CODEGRAPH_KEEP_FIXTURE_TEMP;
    delete process.env.CODEGRAPH_KEEP_FIXTURE_TEMP;
    const enteredRoots: string[] = [];
    const bothWorkersEntered = Promise.withResolvers<void>();

    try {
      const copiedRoots = await Promise.all(
        ["first", "second"].map(
          async (worker) =>
            await withCopiedFixture(
              sourceRoot,
              async (fixtureRoot) => {
                enteredRoots.push(fixtureRoot);
                if (enteredRoots.length === 2) bothWorkersEntered.resolve();
                await bothWorkersEntered.promise;
                await fsp.writeFile(path.join(fixtureRoot, `${worker}.txt`), worker, "utf8");
                return fixtureRoot;
              },
              { prefix: "codegraph-fixture-worker-" },
            ),
        ),
      );

      expect(new Set(copiedRoots).size).toBe(2);
      expect(copiedRoots.every((fixtureRoot) => !fs.existsSync(fixtureRoot))).toBe(true);
    } finally {
      if (previousKeepValue === undefined) delete process.env.CODEGRAPH_KEEP_FIXTURE_TEMP;
      else process.env.CODEGRAPH_KEEP_FIXTURE_TEMP = previousKeepValue;
      await fsp.rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("retains and reports a fixture copy only when debug retention is enabled", async () => {
    const sourceRoot = await mkTmpDir("codegraph-fixture-retained-source-");
    await writeFixtureFile(sourceRoot, "fixture.ts");
    const previousKeepValue = process.env.CODEGRAPH_KEEP_FIXTURE_TEMP;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let retainedRoot = "";
    process.env.CODEGRAPH_KEEP_FIXTURE_TEMP = "1";

    try {
      retainedRoot = await withCopiedFixture(sourceRoot, async (fixtureRoot) => fixtureRoot);
      expect(fs.existsSync(retainedRoot)).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(`Retained fixture copy: ${retainedRoot}`);
    } finally {
      if (previousKeepValue === undefined) delete process.env.CODEGRAPH_KEEP_FIXTURE_TEMP;
      else process.env.CODEGRAPH_KEEP_FIXTURE_TEMP = previousKeepValue;
      errorSpy.mockRestore();
      await fsp.rm(sourceRoot, { recursive: true, force: true });
      if (retainedRoot) await fsp.rm(retainedRoot, { recursive: true, force: true });
    }
  });
});

describe("fixture cleanliness gate", () => {
  it("rejects caches, generated locks, temp artifacts, and tracked fixture mutations", async () => {
    const repoRoot = await mkTmpDir("codegraph-cleanliness-repo-");
    try {
      await writeFixtureFile(repoRoot, path.join("tests", "samples", "clean.ts"), "export const clean = true;\n");
      await writeFixtureFile(repoRoot, path.join("tests", "samples", "package-lock.json"), "{}\n");
      runGit(repoRoot, ["init"]);
      runGit(repoRoot, ["add", "."]);
      runGit(repoRoot, ["commit", "-m", "fixture baseline"]);

      const cleanResult = runCleanlinessScript(repoRoot);
      expect(cleanResult.status, cleanResult.stderr).toBe(0);
      const cleanJsonResult = runCleanlinessScript(repoRoot, ["--json"]);
      expect(cleanJsonResult.status, cleanJsonResult.stderr).toBe(0);
      const cleanReport = JSON.parse(cleanJsonResult.stdout) as {
        schemaVersion: number;
        status: string;
        fixtureRoots: string[];
        violations: unknown[];
      };
      expect(cleanReport).toEqual({
        schemaVersion: 1,
        status: "pass",
        fixtureRoots: ["tests/samples", "tests/fixtures", "tests/languages/samples"],
        violations: [],
      });

      const cacheRoot = path.join(repoRoot, "tests", "samples", "writer", ".codegraph-cache");
      await writeFixtureFile(cacheRoot, path.join("index-v1", "manifest.json"), "{}\n");
      await writeFixtureFile(repoRoot, path.join("tests", "samples", "writer", ".codegraph", "state.json"), "{}\n");
      await writeFixtureFile(
        repoRoot,
        path.join("tests", "languages", "samples", ".codegraph-cache", "index-v1", "manifest.json"),
        "{}\n",
      );
      const cacheResult = runCleanlinessScript(repoRoot);
      expect(cacheResult.status).toBe(1);
      expect(cacheResult.stderr).toContain("[cache-artifact]");
      expect(cacheResult.stderr.replaceAll("\\", "/")).toContain("tests/samples/writer/.codegraph-cache");
      expect(cacheResult.stderr.replaceAll("\\", "/")).toMatch(/tests\/samples\/writer\/\.codegraph(?!-cache)/);
      expect(cacheResult.stderr.replaceAll("\\", "/")).toContain("tests/languages/samples/.codegraph-cache");
      const cacheJsonResult = runCleanlinessScript(repoRoot, ["--json"]);
      expect(cacheJsonResult.status, cacheJsonResult.stderr).toBe(1);
      const cacheReport = JSON.parse(cacheJsonResult.stdout) as {
        status: string;
        violations: Array<{ code: string }>;
      };
      expect(cacheReport.status).toBe("fail");
      expect(cacheReport.violations.filter((violation) => violation.code === "cache-artifact")).toHaveLength(3);
      await fsp.rm(path.join(repoRoot, "tests", "samples", "writer"), { recursive: true, force: true });
      await fsp.rm(path.join(repoRoot, "tests", "languages", "samples", ".codegraph-cache"), {
        recursive: true,
        force: true,
      });

      const generatedLock = path.join(repoRoot, "tests", "samples", "pnpm-lock.yaml");
      await fsp.writeFile(generatedLock, "lockfileVersion: '9.0'\n", "utf8");
      const lockResult = runCleanlinessScript(repoRoot);
      expect(lockResult.status).toBe(1);
      expect(lockResult.stderr).toContain("[generated-lock]");
      await fsp.rm(generatedLock, { force: true });

      const temporaryArtifact = path.join(repoRoot, "tests", "samples", ".tmp-worker");
      await fsp.writeFile(temporaryArtifact, "temporary\n", "utf8");
      const temporaryResult = runCleanlinessScript(repoRoot);
      expect(temporaryResult.status).toBe(1);
      expect(temporaryResult.stderr).toContain("[temporary-artifact]");
      await fsp.rm(temporaryArtifact, { force: true });

      await fsp.writeFile(path.join(repoRoot, "tests", "samples", "clean.ts"), "export const clean = false;\n");
      const modifiedResult = runCleanlinessScript(repoRoot);
      expect(modifiedResult.status).toBe(1);
      expect(modifiedResult.stderr).toContain("[modified-tracked-fixture]");
    } finally {
      await fsp.rm(repoRoot, { recursive: true, force: true });
    }
  });
});
