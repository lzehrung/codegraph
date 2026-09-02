import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildProjectIndex, buildProjectIndexFromFiles, buildProjectIndexIncremental } from "../src/index.js";
import { findReferences } from "../src/indexer/navigation.js";
import type { BuildReport } from "../src/indexer/types.js";
import type { ProgressUpdate } from "../src/types.js";
import {
  fileIdentityKey,
  initializeFileIdentityCaseSensitivity,
  isFileIdentityCaseInsensitive,
  resetFileIdentityCaseSensitivityForTests,
  setFileIdentityCaseInsensitive,
} from "../src/util/paths.js";
import { setAfterConfinedPathVerifiedForTests } from "../src/util/confinedFile.js";
import { runGit as git } from "./helpers/git.js";
import { createTestIndex, expectFileInIndex, expectModuleCount } from "./test-utils.js";

describe("Project Indexing", () => {
  it("does not add workspace manifest edges outside explicit file-list indexes", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-explicit-manifest-scope-"));
    const appManifest = path.join(root, "apps", "app", "package.json");
    const libManifest = path.join(root, "packages", "lib", "package.json");

    await fsp.mkdir(path.dirname(appManifest), { recursive: true });
    await fsp.mkdir(path.dirname(libManifest), { recursive: true });
    await fsp.writeFile(
      appManifest,
      JSON.stringify(
        {
          name: "app",
          dependencies: {
            lib: "workspace:*",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(libManifest, JSON.stringify({ name: "lib" }, null, 2), "utf8");

    const index = await buildProjectIndexFromFiles(root, [appManifest]);

    expect(index.byFile.has(fileIdentityKey(appManifest.replace(/\\/g, "/")))).toBe(true);
    expect(index.byFile.has(fileIdentityKey(libManifest.replace(/\\/g, "/")))).toBe(false);
    expect(
      index.graph.edges.some(
        (edge) =>
          edge.from === appManifest.replace(/\\/g, "/") &&
          edge.to.type === "file" &&
          edge.to.path === libManifest.replace(/\\/g, "/"),
      ),
    ).toBe(false);
  });

  it("reports full-build lifecycle before file progress", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-progress-"));
    const file = path.join(root, "main.ts");
    const updates: ProgressUpdate[] = [];
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndexFromFiles(root, [file], {
        cache: "off",
        onProgress: (update) => updates.push(update),
      });

      expect(updates.map((update) => update.phase)).toEqual(["start", "update", "complete"]);
      expect(updates[0]).toMatchObject({ mode: "build", current: 0, total: 1 });
      expect(updates[1]).toMatchObject({ mode: "build", current: 1, total: 1 });
      expect(updates[2]).toMatchObject({ mode: "build", current: 1, total: 1 });
      expect(updates[2]?.elapsedMs).toBeTypeOf("number");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports build completion elapsed from the caller's discovery start", async () => {
    // Lifecycle and agent commands discover files before the build. Timing from the first
    // parsed file reported a fraction of the wait, so a multi-minute discovery followed by a
    // short parse looked like a fast build.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-progress-origin-"));
    const file = path.join(root, "main.ts");
    const updates: ProgressUpdate[] = [];
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");
    const discoveryMs = 5_000;

    try {
      await buildProjectIndexFromFiles(root, [file], {
        cache: "off",
        progressStartedAt: performance.now() - discoveryMs,
        onProgress: (update) => updates.push(update),
      });

      const completion = updates.find((update) => update.phase === "complete");
      expect(completion?.elapsedMs).toBeGreaterThanOrEqual(discoveryMs);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("starts full discovery progress before listing source files", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-full-discovery-progress-"));
    const file = path.join(root, "main.ts");
    const updates: ProgressUpdate[] = [];
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndex(root, { cache: "off", native: "off", onProgress: (update) => updates.push(update) });

      expect(updates[0]).toMatchObject({
        phase: "start",
        mode: "check",
        activity: "Discovering source files",
        current: 0,
        total: 0,
      });
      expect(updates.some((update) => update.phase === "start" && update.mode === "build")).toBeTruthy();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports source and metadata discovery timings for a cold full incremental build", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-discovery-timing-"));
    const file = path.join(root, "main.ts");
    const report: BuildReport = { timings: {} };
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndexIncremental(root, {
        cache: "disk",
        native: "off",
        report,
      });

      expect(report.timings.sourceDiscoveryMs).toBeTypeOf("number");
      expect(report.timings.sourceDiscoveryMs).toBeGreaterThanOrEqual(0);
      expect(report.timings.metadataDiscoveryMs).toBeTypeOf("number");
      expect(report.timings.metadataDiscoveryMs).toBeGreaterThanOrEqual(0);
      expect(report.timings.filesystemScanMs).toBeTypeOf("number");
      expect(report.timings.steps?.some((step) => step.name === "filesystem-scan")).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports metadata discovery for an incremental update", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-incremental-metadata-timing-"));
    await fsp.writeFile(path.join(root, "main.ts"), "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndexIncremental(root, { cache: "disk", native: "off" });
      await fsp.writeFile(path.join(root, "extra.ts"), "export const extra = 2;\n", "utf8");
      const report: BuildReport = { timings: {} };

      await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });

      expect(report.timings.sourceDiscoveryMs).toBeTypeOf("number");
      expect(report.timings.metadataDiscoveryMs).toBeTypeOf("number");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports Git-backed untracked source discovery for an incremental update", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-git-discovery-timing-"));
    const main = path.join(root, "main.ts");
    const extra = path.join(root, "extra.ts");
    await fsp.writeFile(path.join(root, ".gitignore"), ".codegraph/\n", "utf8");
    await fsp.writeFile(main, "export const value = 1;\n", "utf8");
    git(root, ["init"]);
    git(root, ["config", "user.email", "tests@example.com"]);
    git(root, ["config", "user.name", "Tests"]);
    git(root, ["add", ".gitignore", "main.ts"]);
    git(root, ["commit", "-m", "initial source"]);

    try {
      await buildProjectIndexIncremental(root, { cache: "disk", native: "off" });
      await fsp.writeFile(extra, "export const extra = 2;\n", "utf8");
      const report: BuildReport = { timings: {} };

      await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });

      expect(report.timings.sourceDiscoveryMs).toBeTypeOf("number");
      expect(report.timings.metadataDiscoveryMs).toBeTypeOf("number");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports Git listing progress and gitListMs for a cold Git-backed build", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-git-list-progress-"));
    const file = path.join(root, "main.ts");
    const updates: ProgressUpdate[] = [];
    const report: BuildReport = { timings: {} };
    await fsp.writeFile(path.join(root, ".gitignore"), ".codegraph/\n", "utf8");
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");
    git(root, ["init"]);
    git(root, ["config", "user.email", "tests@example.com"]);
    git(root, ["config", "user.name", "Tests"]);
    git(root, ["add", ".gitignore", "main.ts"]);
    git(root, ["commit", "-m", "initial source"]);

    try {
      await buildProjectIndexIncremental(root, {
        cache: "disk",
        native: "off",
        report,
        onProgress: (update) => updates.push(update),
      });

      expect(updates.some((update) => update.activity === "Listing Git files")).toBe(true);
      expect(updates.some((update) => update.activity === "Listing Git ignore files")).toBe(true);
      expect(report.timings.gitListMs).toBeTypeOf("number");
      expect(report.timings.steps?.some((step) => step.name === "git-list")).toBe(true);
      expect(report.timings.filesystemScanMs).toBeUndefined();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("replaces discovery steps when the same report object is reused", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-reused-report-steps-"));
    const file = path.join(root, "main.ts");
    const extra = path.join(root, "extra.ts");
    const report: BuildReport = { timings: {} };
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });
      expect(report.timings.steps?.filter((step) => step.name === "filesystem-scan")).toHaveLength(1);
      report.timings.gitListMs = 9999;
      (report.timings.steps ??= []).push({ name: "git-list", ms: 9999 });

      await fsp.writeFile(extra, "export const extra = 2;\n", "utf8");
      await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });

      expect(report.timings.gitListMs).toBeUndefined();
      expect(report.timings.steps?.some((step) => step.name === "git-list")).toBe(false);
      expect(report.timings.steps?.filter((step) => step.name === "filesystem-scan")).toHaveLength(1);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("drops unused source discovery timing when a reused report skips discovery", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-reused-report-skip-source-"));
    const file = path.join(root, "main.ts");
    const report: BuildReport = { timings: {} };
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });
      expect(report.timings.sourceDiscoveryMs).toBeTypeOf("number");
      expect(report.timings.metadataDiscoveryMs).toBeTypeOf("number");

      await buildProjectIndexIncremental(root, {
        cache: "disk",
        native: "off",
        report,
        files: [file],
        filesAreProjectScope: true,
      });

      expect(report.timings.sourceDiscoveryMs).toBeUndefined();
      expect(report.timings.metadataDiscoveryMs).toBeUndefined();
      expect(report.timings.filesystemScanMs).toBeUndefined();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("drops leftover metadata discovery timing when a reused report hits a warm snapshot", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-reused-report-warm-snapshot-"));
    const file = path.join(root, "main.ts");
    const report: BuildReport = { timings: {} };
    await fsp.writeFile(path.join(root, ".gitignore"), ".codegraph/\n", "utf8");
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");
    git(root, ["init"]);
    git(root, ["config", "user.email", "tests@example.com"]);
    git(root, ["config", "user.name", "Tests"]);
    git(root, ["add", ".gitignore", "main.ts"]);
    git(root, ["commit", "-m", "initial source"]);

    try {
      await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });
      expect(report.timings.metadataDiscoveryMs).toBeTypeOf("number");
      expect(report.timings.gitListMs).toBeTypeOf("number");

      await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });

      expect(report.timings.gitListMs).toBeUndefined();
      expect(report.timings.filesystemScanMs).toBeUndefined();
      expect(report.timings.metadataDiscoveryMs).toBeUndefined();
      expect(report.timings.sourceDiscoveryMs).toBeTypeOf("number");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports finalization metadata discovery for explicit files", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-explicit-metadata-timing-"));
    const file = path.join(root, "main.ts");
    const report: BuildReport = { timings: {} };
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndexFromFiles(root, [file], { native: "off", report });

      expect(report.timings.sourceDiscoveryMs).toBeUndefined();
      expect(report.timings.metadataDiscoveryMs).toBeTypeOf("number");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("omits source discovery timing for an explicit incremental project scope", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-no-discovery-timing-"));
    const file = path.join(root, "main.ts");
    const report: BuildReport = { timings: {} };
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndexIncremental(root, {
        cache: "off",
        files: [file],
        filesAreProjectScope: true,
        native: "off",
        report,
      });

      expect(report.timings.sourceDiscoveryMs).toBeUndefined();
      expect(report.timings.metadataDiscoveryMs).toBeTypeOf("number");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps discovery timings private when an incremental caller omits a report", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-index-private-discovery-timing-"));
    const file = path.join(root, "main.ts");
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndexIncremental(root, { cache: "disk", native: "off" });
      const index = await buildProjectIndexIncremental(root, { cache: "disk", native: "off" });

      expect(index.buildReport?.timings.sourceDiscoveryMs).toBeUndefined();
      expect(index.buildReport?.timings.metadataDiscoveryMs).toBeUndefined();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports source and metadata discovery during a cold incremental build", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cold-index-progress-"));
    const file = path.join(root, "main.ts");
    const updates: ProgressUpdate[] = [];
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, "package.json"), '{"name":"progress-test"}\n', "utf8");

    try {
      await buildProjectIndexIncremental(root, {
        cache: "disk",
        onProgress: (update) => updates.push(update),
      });

      const discoveryUpdates = updates.filter((update) => update.phase === "update" && update.mode === "check");
      expect(discoveryUpdates.map((update) => update.activity)).toEqual(
        expect.arrayContaining([
          "Discovering source files",
          "Scanning project files",
          "Checking source file paths",
          "Discovering project metadata",
          "Checking project metadata files",
        ]),
      );
      expect(discoveryUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ activity: "Checking source file paths", current: 0, total: 2 }),
          expect.objectContaining({ activity: "Checking source file paths", current: 2, total: 2 }),
          expect.objectContaining({ activity: "Checking project metadata files", current: 0, total: 1 }),
          expect.objectContaining({ activity: "Checking project metadata files", current: 1, total: 1 }),
        ]),
      );
      expect(updates.findIndex((update) => update.activity === "Discovering source files")).toBeGreaterThan(0);
      expect(updates.findIndex((update) => update.phase === "start" && update.mode === "build")).toBeGreaterThan(
        updates.findIndex((update) => update.activity === "Discovering project metadata"),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports snapshot checks and stale-index updates", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-incremental-progress-"));
    const file = path.join(root, "main.ts");
    const buildOptions = { cache: "disk" as const, cacheStrict: true };
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndex(root, buildOptions);

      const warmCacheUpdates: ProgressUpdate[] = [];
      await buildProjectIndex(root, {
        cache: "disk",
        onProgress: (update) => warmCacheUpdates.push(update),
      });
      expect(warmCacheUpdates).toEqual([]);

      const strictFullCacheUpdates: ProgressUpdate[] = [];
      await buildProjectIndex(root, {
        ...buildOptions,
        onProgress: (update) => strictFullCacheUpdates.push(update),
      });
      expect(strictFullCacheUpdates[0]).toMatchObject({
        phase: "start",
        mode: "check",
        activity: "Discovering source files",
      });

      const cachedUpdates: ProgressUpdate[] = [];
      await buildProjectIndexIncremental(root, {
        ...buildOptions,
        files: [file],
        onProgress: (update) => cachedUpdates.push(update),
      });
      expect(cachedUpdates).toHaveLength(2);
      expect(cachedUpdates[0]).toMatchObject({ phase: "start", mode: "check", current: 0, total: 0 });
      expect(cachedUpdates[1]).toMatchObject({ phase: "complete", mode: "check", current: 1, total: 1 });

      await fsp.rm(path.join(root, ".codegraph", "cache", "index-v1", "project-index-snapshot.json"), {
        force: true,
      });
      const moduleCacheUpdates: ProgressUpdate[] = [];
      await buildProjectIndexIncremental(root, {
        ...buildOptions,
        files: [file],
        onProgress: (update) => moduleCacheUpdates.push(update),
      });
      expect(moduleCacheUpdates).toHaveLength(2);
      expect(moduleCacheUpdates[0]).toMatchObject({ phase: "start", mode: "check", current: 0, total: 0 });
      expect(moduleCacheUpdates[1]).toMatchObject({ phase: "complete", mode: "check", current: 1, total: 1 });

      await fsp.writeFile(file, "export const value = 2;\n", "utf8");
      const staleUpdates: ProgressUpdate[] = [];
      await buildProjectIndexIncremental(root, {
        ...buildOptions,
        onProgress: (update) => staleUpdates.push(update),
      });

      expect(staleUpdates[0]).toMatchObject({ phase: "start", mode: "check", current: 0, total: 0 });
      expect(staleUpdates.some((update) => update.phase === "start" && update.mode === "update")).toBe(true);
      expect(staleUpdates.at(-1)).toMatchObject({ phase: "complete", mode: "update", current: 1, total: 1 });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects explicit file-list inputs outside the project root", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-explicit-file-root-"));
    const outsideFile = path.resolve("README.md");

    await expect(buildProjectIndexFromFiles(root, [outsideFile], { cache: "memory" })).rejects.toThrow(
      /outside project root/,
    );
  });
  it("rejects an explicit in-root file when its target swaps outside during the read", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-explicit-file-toctou-"));
    const victim = path.join(root, "victim.ts");
    const outside = path.join(path.dirname(root), "outside.ts");
    await fsp.writeFile(victim, "export const safe = 1;\n", "utf8");
    await fsp.writeFile(outside, "export const secret = 2;\n", "utf8");
    try {
      setAfterConfinedPathVerifiedForTests(async (realPath) => {
        if (path.resolve(realPath) !== path.resolve(victim)) return;
        await fsp.unlink(victim);
        await fsp.symlink(outside, victim, "file");
      });
      await expect(buildProjectIndexFromFiles(root, [victim], { cache: "disk" })).rejects.toThrow(
        /changed between verification and open|outside project root/,
      );
    } finally {
      setAfterConfinedPathVerifiedForTests(undefined);
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(outside, { force: true });
    }
  });

  describe("TypeScript Project", () => {
    it("should index all TypeScript files", async () => {
      const index = await createTestIndex("typescript");

      expectModuleCount(index, 10);

      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      expectFileInIndex(index, path.join(samplePath, "main.ts").replace(/\\/g, "/"));
      expectFileInIndex(index, path.join(samplePath, "utils.ts").replace(/\\/g, "/"));
      expectFileInIndex(index, path.join(samplePath, "helpers.ts").replace(/\\/g, "/"));
      expectFileInIndex(index, path.join(samplePath, "dynamic-import.ts").replace(/\\/g, "/"));
      expectFileInIndex(index, path.join(samplePath, "abstract-implementation.ts").replace(/\\/g, "/"));
      expectFileInIndex(index, path.join(samplePath, "tsconfig.json").replace(/\\/g, "/"));
    });

    it("should detect imports and exports", async () => {
      const index = await createTestIndex("typescript");

      // Check that utils.ts has exports
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const utilsFile = path.join(samplePath, "utils.ts").replace(/\\/g, "/");
      const utilsModule = index.byFile.get(fileIdentityKey(utilsFile));

      expect(utilsModule).toBeDefined();
      expect(utilsModule!.exports.length).toBeGreaterThan(0);
      expect(utilsModule!.locals.length).toBeGreaterThan(0);
    });

    it("should detect imports in main.ts", async () => {
      const index = await createTestIndex("typescript");

      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const mainFile = path.join(samplePath, "main.ts").replace(/\\/g, "/");
      const mainModule = index.byFile.get(fileIdentityKey(mainFile));

      expect(mainModule).toBeDefined();
      expect(mainModule!.imports.length).toBeGreaterThan(0);
    });
  });

  describe("Python Project", () => {
    it("indexes the complete Python fixture inventory", async () => {
      const index = await createTestIndex("python");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const expectedFiles = [
        "main.py",
        "utils.py",
        "helpers.py",
        "relative-imports.py",
        "__init__.py",
        "match_patterns.py",
        ".regressions/unicode_consumer.py",
        ".regressions/unicode_def.py",
        ".regressions/unicode_nfc_def.py",
        ".regressions/unicode_nfc_consumer.py",
        ".regressions/unicode_nfd_def.py",
        ".regressions/unicode_nfd_consumer.py",
        "package_consumer.py",
        "package_exports/__init__.py",
        "package_exports/values.py",
      ].map((file) => path.join(samplePath, file).replace(/\\/g, "/"));

      expect([...index.byFile.keys()].sort()).toEqual(expectedFiles.map(fileIdentityKey).sort());
    });

    it("should detect Python imports and exports", async () => {
      const index = await createTestIndex("python");

      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const utilsFile = path.join(samplePath, "utils.py").replace(/\\/g, "/");
      const utilsModule = index.byFile.get(fileIdentityKey(utilsFile));

      expect(utilsModule).toBeDefined();
      expect(utilsModule!.exports.length).toBeGreaterThan(0);
      expect(utilsModule!.locals.length).toBeGreaterThan(0);
    });

    it("should detect Python imports in main.py", async () => {
      const index = await createTestIndex("python");

      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const mainFile = path.join(samplePath, "main.py").replace(/\\/g, "/");
      const mainModule = index.byFile.get(fileIdentityKey(mainFile));

      expect(mainModule).toBeDefined();
      expect(mainModule!.imports.length).toBeGreaterThan(0);
    });
  });

  describe("JavaScript Project", () => {
    it("should index all JavaScript files", async () => {
      const index = await createTestIndex("javascript");

      expectModuleCount(index, 7);

      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      expectFileInIndex(index, path.join(samplePath, "main.js").replace(/\\/g, "/"));
      expectFileInIndex(index, path.join(samplePath, "utils.js").replace(/\\/g, "/"));
      expectFileInIndex(index, path.join(samplePath, "helpers.js").replace(/\\/g, "/"));
      expectFileInIndex(index, path.join(samplePath, "dynamic-import.js").replace(/\\/g, "/"));
      expectFileInIndex(index, path.join(samplePath, "legacy.js").replace(/\\/g, "/"));
      expectFileInIndex(index, path.join(samplePath, "mixed.js").replace(/\\/g, "/"));
      expectFileInIndex(index, path.join(samplePath, "package.json").replace(/\\/g, "/"));
    });

    it("should detect JavaScript ES6 imports and exports", async () => {
      const index = await createTestIndex("javascript");

      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const utilsFile = path.join(samplePath, "utils.js").replace(/\\/g, "/");
      const utilsModule = index.byFile.get(fileIdentityKey(utilsFile));

      expect(utilsModule).toBeDefined();
      expect(utilsModule!.exports.length).toBeGreaterThan(0);
      expect(utilsModule!.locals.length).toBeGreaterThan(0);
    });

    it("should detect JavaScript imports in main.js", async () => {
      const index = await createTestIndex("javascript");

      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const mainFile = path.join(samplePath, "main.js").replace(/\\/g, "/");
      const mainModule = index.byFile.get(fileIdentityKey(mainFile));

      expect(mainModule).toBeDefined();
      expect(mainModule!.imports.length).toBeGreaterThan(0);
    });

    it("should detect CommonJS require statements", async () => {
      const index = await createTestIndex("javascript");

      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const mainFile = path.join(samplePath, "main.js").replace(/\\/g, "/");
      const mainModule = index.byFile.get(fileIdentityKey(mainFile));

      expect(mainModule).toBeDefined();

      // Should detect both ES6 imports and CommonJS requires
      const hasES6Import = mainModule!.imports.some(
        (imp) => imp.kind === "default" || imp.kind === "named" || imp.kind === "namespace",
      );
      const hasCommonJSRequire = mainModule!.imports.some((imp) => imp.mechanism === "cjs");

      expect(hasES6Import || hasCommonJSRequire).toBe(true);
    });

    it("should detect mixed module systems", async () => {
      const index = await createTestIndex("javascript");

      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const mixedFile = path.join(samplePath, "mixed.js").replace(/\\/g, "/");
      const mixedModule = index.byFile.get(fileIdentityKey(mixedFile));

      expect(mixedModule).toBeDefined();
      expect(mixedModule!.imports.length).toBeGreaterThan(0);
      expect(mixedModule!.exports.length).toBeGreaterThan(0);
    });
  });

  describe("Graph-Only Document Projects", () => {
    it("keeps graph-only modules semantically inert while preserving imports", async () => {
      const markdownPath = path.resolve(process.cwd(), "tests", "samples", "markdown");
      const mdxPath = path.resolve(process.cwd(), "tests", "samples", "mdx");
      const rstPath = path.resolve(process.cwd(), "tests", "samples", "rst");
      const adocPath = path.resolve(process.cwd(), "tests", "samples", "adoc");

      const markdownFile = path.join(markdownPath, "index.md").replace(/\\/g, "/");
      const mdxFile = path.join(mdxPath, "page.mdx").replace(/\\/g, "/");
      const rstFile = path.join(rstPath, "index.rst").replace(/\\/g, "/");
      const adocFile = path.join(adocPath, "index.adoc").replace(/\\/g, "/");

      const markdownIndex = await buildProjectIndexFromFiles(markdownPath, [
        markdownFile,
        path.join(markdownPath, "guide.md").replace(/\\/g, "/"),
      ]);
      const mdxIndex = await buildProjectIndexFromFiles(mdxPath, [
        mdxFile,
        path.join(mdxPath, "guide.md").replace(/\\/g, "/"),
        path.join(mdxPath, "components", "Card.tsx").replace(/\\/g, "/"),
      ]);
      const rstIndex = await buildProjectIndexFromFiles(rstPath, [
        rstFile,
        path.join(rstPath, "guide.rst").replace(/\\/g, "/"),
      ]);
      const adocIndex = await buildProjectIndexFromFiles(adocPath, [
        adocFile,
        path.join(adocPath, "guide.adoc").replace(/\\/g, "/"),
      ]);

      const markdownModule = markdownIndex.byFile.get(fileIdentityKey(markdownFile));
      const mdxModule = mdxIndex.byFile.get(fileIdentityKey(mdxFile));
      const rstModule = rstIndex.byFile.get(fileIdentityKey(rstFile));
      const adocModule = adocIndex.byFile.get(fileIdentityKey(adocFile));

      expect(markdownModule).toBeDefined();
      expect(markdownModule!.imports.length).toBeGreaterThan(0);
      expect(markdownModule!.exports).toHaveLength(0);
      expect(markdownModule!.locals).toHaveLength(0);

      expect(mdxModule).toBeDefined();
      expect(mdxModule!.imports.length).toBeGreaterThan(0);
      expect(mdxModule!.exports).toHaveLength(0);
      expect(mdxModule!.locals).toHaveLength(0);

      expect(rstModule).toBeDefined();
      expect(rstModule!.imports.length).toBeGreaterThan(0);
      expect(rstModule!.exports).toHaveLength(0);
      expect(rstModule!.locals).toHaveLength(0);

      expect(adocModule).toBeDefined();
      expect(adocModule!.imports.length).toBeGreaterThan(0);
      expect(adocModule!.exports).toHaveLength(0);
      expect(adocModule!.locals).toHaveLength(0);
    });
  });
  it("merges cased import targets only on configured case-insensitive filesystems", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-file-identity-"));
    const mainFile = path.join(root, "main.ts");
    const upperCaseUtility = path.join(root, "Util.ts");
    const lowerCaseUtility = path.join(root, "util.ts");

    await fsp.writeFile(
      mainFile,
      'import { value } from "./Util";\nexport function consume() { return value; }\n',
      "utf8",
    );
    await fsp.writeFile(upperCaseUtility, "export const value = 1;\n", "utf8");
    await fsp.writeFile(lowerCaseUtility, "export const value = 2;\n", "utf8");

    await initializeFileIdentityCaseSensitivity(root);
    const originalCaseSensitivity = isFileIdentityCaseInsensitive();
    try {
      resetFileIdentityCaseSensitivityForTests(true);
      setFileIdentityCaseInsensitive(true);
      const merged = await buildProjectIndexFromFiles(root, [mainFile, upperCaseUtility, lowerCaseUtility]);
      const mergedUtility = merged.byFile.get(fileIdentityKey(lowerCaseUtility));
      const mergedMain = merged.byFile.get(fileIdentityKey(mainFile));

      expect(fileIdentityKey(upperCaseUtility)).toBe(fileIdentityKey(lowerCaseUtility));
      expect(merged.byFile.size).toBe(2);
      const valueDefinition = mergedUtility?.locals.find((local) => local.localName === "value");
      if (!valueDefinition) throw new Error("Expected merged utility export.");
      const references = await findReferences(merged, { def: valueDefinition });

      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.references.map((reference) => fileIdentityKey(reference.file))).toContain(
          fileIdentityKey(mainFile),
        );
      }
      expect(mergedUtility?.file).toBe(lowerCaseUtility.replace(/\\/g, "/"));
      expect(mergedMain?.imports[0]?.resolved).toBe(upperCaseUtility.replace(/\\/g, "/"));

      resetFileIdentityCaseSensitivityForTests(false);
      setFileIdentityCaseInsensitive(false);
      const distinct = await buildProjectIndexFromFiles(root, [mainFile, upperCaseUtility, lowerCaseUtility]);

      expect(fileIdentityKey(upperCaseUtility)).not.toBe(fileIdentityKey(lowerCaseUtility));
      expect(distinct.byFile.size).toBe(3);
      expect(distinct.byFile.get(fileIdentityKey(upperCaseUtility))).not.toBe(
        distinct.byFile.get(fileIdentityKey(lowerCaseUtility)),
      );
    } finally {
      resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
