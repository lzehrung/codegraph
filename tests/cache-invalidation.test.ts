import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildProjectIndex, buildProjectIndexIncremental, type BuildReport } from "../src/index.js";
import * as indexer from "../src/indexer.js";
import * as buildCache from "../src/indexer/build-cache.js";
import {
  MANIFEST_VERSION,
  summarizeBuildOptions,
  writeManifest,
  type IndexManifest,
} from "../src/indexer/build-cache.js";
import { collectGraph } from "../src/graphs.js";
import {
  getGitBlobHash,
  listProjectFiles,
  resolveSpecifier,
  loadNearestTsconfigFor,
  loadWorkspaceConfig,
  clearImportResolutionCaches,
  clearResolutionCaches,
} from "../src/util.js";
import * as util from "../src/util.js";
import * as projectFilesModule from "../src/util/projectFiles.js";
import * as gitModule from "../src/util/git.js";
import * as incrementalPlan from "../src/indexer/incremental-plan.js";
import * as filePrep from "../src/languages/filePrep.js";
import { runGit } from "./helpers/git.js";
import { createTempProjectRoot, mkTmpDir } from "./helpers/filesystem.js";

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

function diskCacheDbPathFor(root: string): string {
  return path.join(root, ".codegraph-cache", "index-v1", "index-cache.sqlite");
}

function readModuleCacheUpdatedAt(root: string, file: string): number | null {
  const dbPath = diskCacheDbPathFor(root);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT updated_at FROM module_cache WHERE file = ?").get(file) as
      | { updated_at: number }
      | undefined;
    return row?.updated_at ?? null;
  } finally {
    db.close();
  }
}

function manifestPathFor(root: string): string {
  return path.join(root, ".codegraph-cache", "index-v1", "manifest.json");
}

function projectSnapshotPathFor(root: string): string {
  return path.join(root, ".codegraph-cache", "index-v1", "project-index-snapshot.json");
}

async function readManifest(root: string): Promise<IndexManifest> {
  const mf = path.join(root, ".codegraph-cache", "index-v1", "manifest.json");
  const raw = await fsp.readFile(mf, "utf8");
  return JSON.parse(raw) as IndexManifest;
}

function createManifest(root: string): IndexManifest {
  return {
    version: MANIFEST_VERSION,
    projectRoot: normalize(path.resolve(root)),
    updatedAt: Date.now(),
    files: {},
  };
}

describe("Cache invalidation and strict hashing", () => {
  it("retries transient manifest write contention without warning after recovery", async () => {
    const root = await mkTmpDir("dg-manifest-retry-");
    const transientError = Object.assign(new Error("resource busy or locked"), {
      code: "EBUSY",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fsp, "writeFile").mockImplementationOnce(async () => {
      throw transientError;
    });

    try {
      await writeManifest(root, { logLevel: "warn" }, createManifest(root));

      expect(writeSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).not.toHaveBeenCalled();
      const manifest = await readManifest(root);
      expect(manifest.version).toBe(MANIFEST_VERSION);
      expect(manifest.projectRoot).toBe(normalize(path.resolve(root)));
    } finally {
      writeSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("disk cache invalidates when content hash changes even if mtime is restored", async () => {
    const root = await mkTmpDir("dg-cache-inv-");
    const utilPath = path.join(root, "util.ts");
    const v1 = `export function a(){ return 1 }\n`;
    await fsp.writeFile(utilPath, v1, "utf8");
    const st1 = await fsp.stat(utilPath);

    const idx1 = await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const utilFile = Array.from(idx1.byFile.keys()).find((f) => f.endsWith("/util.ts") || f.endsWith("\\util.ts"))!;
    const mod1 = idx1.byFile.get(utilFile)!;
    expect(mod1.locals.some((l) => l.localName === "a")).toBe(true);

    // Change content but keep length and restore mtime
    const v2 = `export function b(){ return 2 }\n`; // same length as v1
    await fsp.writeFile(utilPath, v2, "utf8");
    await fsp.utimes(utilPath, st1.atime, st1.mtime);
    const st2 = await fsp.stat(utilPath);
    expect(st2.size).toBe(st1.size);
    // Allow small filesystem timestamp jitter (e.g., +/-1ms)
    const deltaMs = Math.abs(st2.mtimeMs - st1.mtimeMs);
    expect(deltaMs).toBeLessThan(3);

    // Disk cache validation should pick up content changes even if mtime matches
    const idx2 = await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const mod2 = idx2.byFile.get(utilFile)!;
    expect(mod2.locals.some((l) => l.localName === "b")).toBe(true);

    // Strict: should also invalidate and pick up 'b'
    const idx3 = await buildProjectIndex(root, {
      threads: 2,
      cache: "disk",
      cacheStrict: true,
    });
    const mod3 = idx3.byFile.get(utilFile)!;
    expect(mod3.locals.some((l) => l.localName === "b")).toBe(true);
  });

  it("supports incremental rebuilds with manifest reuse", async () => {
    const root = await mkTmpDir("dg-incremental-");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(filePath, `export const a = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const fileId = normalize(path.resolve(filePath));
    const dbPath = diskCacheDbPathFor(root);
    expect(fs.existsSync(dbPath)).toBe(true);
    const beforeUpdatedAt = readModuleCacheUpdatedAt(root, fileId);
    if (beforeUpdatedAt === null) throw new Error("missing disk cache row");
    const idxNoChange = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });
    const afterUpdatedAt = readModuleCacheUpdatedAt(root, fileId);
    expect(afterUpdatedAt).toBe(beforeUpdatedAt);
    const modA = idxNoChange.byFile.get(fileId)!;
    expect(modA.locals.some((l) => l.localName === "a")).toBe(true);

    await fsp.writeFile(filePath, `export const b = 2;\n`, "utf8");
    const beforeChangeUpdatedAt = readModuleCacheUpdatedAt(root, fileId);
    if (beforeChangeUpdatedAt === null) throw new Error("missing disk cache row before change");
    const idxChanged = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });
    const afterChangeUpdatedAt = readModuleCacheUpdatedAt(root, fileId);
    if (afterChangeUpdatedAt === null) throw new Error("missing disk cache row after change");
    expect(afterChangeUpdatedAt).toBeGreaterThan(beforeChangeUpdatedAt);
    const modB = idxChanged.byFile.get(fileId)!;
    expect(modB.locals.some((l) => l.localName === "b")).toBe(true);

    await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      graph: { fast: true },
    });
    const manifest = await readManifest(root);
    expect(manifest.graphOptions.fast).toBe(true);
  });

  it("rebuilds incremental indexes when discovery globRoot changes", async () => {
    const root = await mkTmpDir("dg-discovery-glob-root-cache-");
    const testsRoot = path.join(root, "tests");
    const unitPath = path.join(testsRoot, "unit", "app.test.ts");
    const samplePath = path.join(testsRoot, "samples", "fixture.ts");
    await fsp.mkdir(path.dirname(unitPath), { recursive: true });
    await fsp.mkdir(path.dirname(samplePath), { recursive: true });
    await fsp.writeFile(unitPath, "export const unit = 1;\n", "utf8");
    await fsp.writeFile(samplePath, "export const fixture = 1;\n", "utf8");

    const first = await buildProjectIndex(testsRoot, {
      cache: "disk",
      discovery: {
        globRoot: root,
        ignoreGlobs: ["tests/samples/**"],
        useGitignore: false,
      },
      logLevel: "silent",
    });
    const normalizedUnitPath = normalize(unitPath);
    const normalizedSamplePath = normalize(samplePath);
    expect(first.byFile.has(normalizedUnitPath)).toBe(true);
    expect(first.byFile.has(normalizedSamplePath)).toBe(false);

    const manifestAfterFirstBuild = await readManifest(testsRoot);
    expect(manifestAfterFirstBuild.buildOptions?.discovery?.globRoot).toBe(normalize(path.resolve(root)));

    const report: BuildReport = { timings: {} };
    const second = await buildProjectIndexIncremental(testsRoot, {
      cache: "disk",
      discovery: {
        ignoreGlobs: ["tests/samples/**"],
        useGitignore: false,
      },
      logLevel: "silent",
      report,
    });

    expect(report.manifest?.used).toBe(true);
    expect(report.manifest?.reused).toBe(false);
    expect(report.manifest?.optionsMismatch).toContain("discovery");
    expect(second.byFile.has(normalizedUnitPath)).toBe(true);
    expect(second.byFile.has(normalizedSamplePath)).toBe(true);
  });

  it("normalizes discovery glob separators before comparing manifest build options", () => {
    const buildOptions = summarizeBuildOptions({
      discovery: {
        includeGlobs: ["src\\**\\*.ts"],
        ignoreGlobs: [" tests\\samples\\** ", "tests/samples/**"],
        useGitignore: false,
      },
    });

    expect(buildOptions.discovery?.includeGlobs).toEqual(["src/**/*.ts"]);
    expect(buildOptions.discovery?.ignoreGlobs).toEqual(["tests/samples/**"]);
  });

  it("falls back to a full incremental rebuild when the manifest commit no longer exists", async () => {
    const root = await mkTmpDir("dg-stale-manifest-commit-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@example.com"]);
    runGit(root, ["config", "user.name", "Test User"]);

    const entry = path.join(root, "entry.ts");
    await fsp.writeFile(entry, "export const value = 1;\n", "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    await buildProjectIndex(root, { cache: "disk", logLevel: "silent" });

    const manifestPath = manifestPathFor(root);
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as IndexManifest;
    await fsp.writeFile(
      manifestPath,
      JSON.stringify(
        {
          ...manifest,
          lastCommit: "05a528dfce570141bfe11d066824d2bed9d72ce2",
        },
        null,
        2,
      ),
      "utf8",
    );

    const report: BuildReport = { timings: {} };
    const index = await buildProjectIndexIncremental(root, {
      cache: "disk",
      logLevel: "silent",
      report,
    });

    expect(index.byFile.has(normalize(entry))).toBe(true);
    expect(report.manifest?.used).toBe(true);
    expect(report.manifest?.reused).toBe(false);
    expect(report.manifest?.reason).toBe("staleGitCommit");
  });

  it("persists SQL corpus signatures so disk graph cache reuses SQL edges", async () => {
    const root = await mkTmpDir("dg-sql-edge-cache-manifest-");
    const schemaPath = path.join(root, "schema.sql");
    const reportPath = path.join(root, "report.sql");
    await fsp.writeFile(schemaPath, "CREATE TABLE users (id integer);\n", "utf8");
    await fsp.writeFile(reportPath, "SELECT id FROM users;\n", "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const reportFile = normalize(path.resolve(reportPath));
    const schemaFile = normalize(path.resolve(schemaPath));
    const manifest = await readManifest(root);
    const reportEntry = manifest.files[reportFile];
    expect(reportEntry?.sqlCorpusSig).toEqual(expect.any(String));
    if (!reportEntry) throw new Error("missing SQL report manifest entry");
    reportEntry.edges = reportEntry.edges.map((edge) =>
      edge.raw === "sql:reads_from:users" ? { ...edge, raw: "sql:cached:reads_from:users" } : edge,
    );
    await fsp.writeFile(manifestPathFor(root), JSON.stringify(manifest, null, 2), "utf8");

    const rebuilt = await buildProjectIndex(root, { threads: 2, cache: "disk" });

    expect(rebuilt.graph.edges).toContainEqual(
      expect.objectContaining({
        from: reportFile,
        raw: "sql:cached:reads_from:users",
        to: { type: "file", path: schemaFile },
      }),
    );
  });

  it("reuses cached SQL edges without rereading the SQL corpus", async () => {
    const root = await mkTmpDir("dg-sql-edge-cache-no-read-");
    const schemaPath = path.join(root, "schema.sql");
    const reportPath = path.join(root, "report.sql");
    await fsp.writeFile(schemaPath, "CREATE TABLE users (id integer);\n", "utf8");
    await fsp.writeFile(reportPath, "SELECT id FROM users;\n", "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk", useBloomFilters: false });

    const originalReadFile = fsp.readFile.bind(fsp);
    const readSpy = vi.spyOn(fsp, "readFile").mockImplementation(originalReadFile);
    try {
      const rebuilt = await buildProjectIndex(root, { threads: 2, cache: "disk", useBloomFilters: false });
      const reportFile = normalize(path.resolve(reportPath));
      const schemaFile = normalize(path.resolve(schemaPath));

      expect(rebuilt.graph.edges).toContainEqual(
        expect.objectContaining({
          from: reportFile,
          raw: "sql:reads_from:users",
          to: { type: "file", path: schemaFile },
        }),
      );
      const sqlReads = readSpy.mock.calls
        .map((call) => String(call[0]).replace(/\\/g, "/"))
        .filter((file) => file.endsWith(".sql"));
      expect(sqlReads.length).toBeLessThanOrEqual(2);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("stores git signatures for tracked files and reuses cached edges by git hash", async () => {
    const root = await mkTmpDir("dg-git-sig-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "cache@test.local"]);
    runGit(root, ["config", "user.name", "Cache Test"]);

    const trackedPath = path.join(root, "tracked.ts");
    const depPath = path.join(root, "dep.ts");
    const untrackedPath = path.join(root, "untracked.ts");
    await fsp.writeFile(trackedPath, `import './dep';\n`, "utf8");
    await fsp.writeFile(depPath, `export const dep = 1;\n`, "utf8");
    await fsp.writeFile(untrackedPath, `export const scratch = 2;\n`, "utf8");

    runGit(root, ["add", "tracked.ts", "dep.ts"]);
    runGit(root, ["commit", "-m", "init"]);

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const manifest = await readManifest(root);
    const trackedEntry = manifest.files[normalize(trackedPath)];
    const untrackedEntry = manifest.files[normalize(untrackedPath)];
    expect(typeof trackedEntry.gitSig).toBe("string");
    expect(untrackedEntry.gitSig).toBeUndefined();

    const gitSig = await getGitBlobHash(root, trackedPath);
    expect(typeof gitSig).toBe("string");

    const cachedEdges = [
      {
        from: normalize(trackedPath),
        to: { type: "file", path: normalize(depPath) },
        raw: "./dep",
      },
    ];

    const fileSignatures = new Map<string, { sig: string; gitSig?: string }>([
      [normalize(trackedPath), { sig: "mtime:changed", gitSig: gitSig ?? undefined }],
    ]);
    const cachedFileEdges = new Map<string, { sig: string; gitSig?: string; edges: typeof cachedEdges }>([
      [
        normalize(trackedPath),
        {
          sig: "old-sig",
          gitSig: gitSig ?? undefined,
          edges: cachedEdges,
        },
      ],
    ]);

    const prepSpy = vi.spyOn(filePrep, "prepareSourceInput");
    const graph = await collectGraph(root, [trackedPath], {
      fileSignatures,
      cachedFileEdges,
    });

    expect(prepSpy).not.toHaveBeenCalled();

    prepSpy.mockRestore();
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]?.from).toBe(normalize(trackedPath));
  });

  it("does not reparse dirty worktree files once their signatures already match the cache", async () => {
    const root = await mkTmpDir("dg-dirty-worktree-settle-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "cache@test.local"]);
    runGit(root, ["config", "user.name", "Cache Test"]);

    const mainPath = path.join(root, "main.ts");
    const helperPath = path.join(root, "helper.ts");
    await fsp.writeFile(mainPath, `import { helper } from "./helper";\nexport const main = helper;\n`, "utf8");
    await fsp.writeFile(helperPath, `export const helper = 1;\n`, "utf8");
    runGit(root, ["add", "main.ts", "helper.ts"]);
    runGit(root, ["commit", "-m", "init"]);

    await buildProjectIndex(root, { threads: 2, cache: "disk" });

    await fsp.writeFile(helperPath, `export const helper = 2;\n`, "utf8");
    const firstDirtyReport: BuildReport = { timings: {} };
    await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      report: firstDirtyReport,
    });
    expect((firstDirtyReport.files?.parsed ?? 0) > 0).toBe(true);

    const secondDirtyReport: BuildReport = { timings: {} };
    await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      report: secondDirtyReport,
    });
    expect(secondDirtyReport.files?.parsed ?? 0).toBe(0);
    expect(secondDirtyReport.files?.changed ?? 0).toBe(0);
  });

  it("ignores Codegraph cache and lifecycle paths during discovery even with broad includes", async () => {
    const root = await mkTmpDir("dg-ignore-codegraph-cache-");
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.mkdir(path.join(root, ".codegraph-cache", "index-v1"), { recursive: true });
    await fsp.mkdir(path.join(root, ".codegraph"), { recursive: true });
    await fsp.writeFile(path.join(root, "src", "app.ts"), "export const app = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, ".codegraph-cache", "index-v1", "stale.ts"), "export const stale = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, ".codegraph", "note.md"), "# note\n", "utf8");

    const discovered = await listProjectFiles(root, ["**/*.{ts,md}"], { ignoreGlobs: [] });
    const normalized = discovered.map(normalize);
    expect(normalized.some((file) => file.endsWith("/src/app.ts"))).toBe(true);
    expect(normalized.some((file) => file.includes("/.codegraph-cache/"))).toBe(false);
    expect(normalized.some((file) => file.includes("/.codegraph/"))).toBe(false);
  });

  it("rebuilds when cache verification detects manifest mismatches", async () => {
    const root = await mkTmpDir("dg-cache-verify-");
    const filePath = path.join(root, "verify.ts");
    await fsp.writeFile(filePath, `export const a = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const manifestPath = path.join(root, ".codegraph-cache", "index-v1", "manifest.json");
    const manifest = await readManifest(root);
    manifest.files[normalize(filePath)].sig = "bad-signature";
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    // Create a ghost file that is not in the manifest.
    // In a purely incremental build (without git), this file would be ignored.
    // A full build will find it via filesystem scanning.
    const ghostPath = path.join(root, "ghost.ts");
    await fsp.writeFile(ghostPath, `export const ghost = 1;\n`, "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const idx = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      cacheVerify: true,
    });
    expect(warnSpy).toHaveBeenCalled();

    // If full build triggered, ghost file should be indexed
    expect(idx.byFile.has(normalize(ghostPath))).toBe(true);

    warnSpy.mockRestore();
  });

  it("forces full parsing when incremental strict mode is enabled", async () => {
    const root = await mkTmpDir("dg-incremental-strict-");
    const filePath = path.join(root, "strict.ts");
    await fsp.writeFile(filePath, `export const a = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      graph: { fast: true },
      incrementalStrict: true,
    });
    const manifest = await readManifest(root);
    expect(manifest.graphOptions.fast).toBe(false);
  });

  it("keeps unchanged graph edges and refreshes changed ones during incremental builds", async () => {
    const root = await mkTmpDir("dg-incremental-edges-");
    const aPath = path.join(root, "a.ts");
    const bPath = path.join(root, "b.ts");
    const cPath = path.join(root, "c.ts");
    const dPath = path.join(root, "d.ts");

    await fsp.writeFile(aPath, `import './b';\n`, "utf8");
    await fsp.writeFile(bPath, `import './c';\n`, "utf8");
    await fsp.writeFile(cPath, `export const c = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const manifestBefore = await readManifest(root);
    const aEntryBefore = manifestBefore.files[normalize(aPath)];
    const bEntryBefore = manifestBefore.files[normalize(bPath)];

    expect(aEntryBefore.edges).toEqual([
      {
        from: normalize(aPath),
        to: { type: "file", path: normalize(bPath) },
        raw: "./b",
      },
    ]);
    expect(bEntryBefore.edges).toEqual([
      {
        from: normalize(bPath),
        to: { type: "file", path: normalize(cPath) },
        raw: "./c",
      },
    ]);

    await fsp.writeFile(bPath, `import './d';\n`, "utf8");
    await fsp.writeFile(dPath, `export const d = 2;\n`, "utf8");

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });
    const manifestAfter = await readManifest(root);
    const aEntryAfter = manifestAfter.files[normalize(aPath)];
    const bEntryAfter = manifestAfter.files[normalize(bPath)];

    expect(aEntryAfter.edges).toEqual(aEntryBefore.edges);
    expect(bEntryAfter.edges).toEqual([
      {
        from: normalize(bPath),
        to: { type: "file", path: normalize(dPath) },
        raw: "./d",
      },
    ]);

    const aEdges = incremental.graph.edges.filter((edge) => edge.from === normalize(aPath));
    const bEdges = incremental.graph.edges.filter((edge) => edge.from === normalize(bPath));

    expect(aEdges).toEqual(aEntryAfter.edges);
    expect(bEdges).toEqual(bEntryAfter.edges);
  });

  it("invalidates transitive dependents when an imported file changes", async () => {
    const root = await mkTmpDir("dg-incremental-dependents-");
    const aPath = path.join(root, "a.ts");
    const bPath = path.join(root, "b.ts");
    const cPath = path.join(root, "c.ts");

    await fsp.writeFile(aPath, `import './b';\n`, "utf8");
    await fsp.writeFile(bPath, `import './c';\nexport { c } from './c';\n`, "utf8");
    await fsp.writeFile(cPath, `export const c = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });

    await fsp.writeFile(cPath, `export const c = 2;\nexport const c2 = 3;\n`, "utf8");

    const prepSpy = vi.spyOn(filePrep, "prepareSourceInput");
    const report: BuildReport = { timings: {} };
    await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      report,
    });

    const preparedFiles = prepSpy.mock.calls.map(([filePath]) => normalize(String(filePath))).sort();
    prepSpy.mockRestore();

    expect(report.files?.changed).toBe(3);
    expect(report.files?.cached ?? 0).toBe(0);
    expect(report.files?.parsed).toBe(3);
    expect(new Set(preparedFiles)).toEqual(new Set([normalize(aPath), normalize(bPath), normalize(cPath)]));
  });

  it("reuses cached graph edges when no files change", async () => {
    const root = await mkTmpDir("dg-incremental-nochange-");
    const aPath = path.join(root, "a.ts");
    const bPath = path.join(root, "b.ts");

    await fsp.writeFile(aPath, `import './b';\n`, "utf8");
    await fsp.writeFile(bPath, `export const b = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const manifestBefore = await readManifest(root);
    const aEntryBefore = manifestBefore.files[normalize(aPath)];

    const prepSpy = vi.spyOn(filePrep, "prepareSourceInput");
    const report: BuildReport = { timings: {} };
    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      report,
    });
    expect(prepSpy).not.toHaveBeenCalled();
    prepSpy.mockRestore();

    const aEdges = incremental.graph.edges.filter((edge) => edge.from === normalize(aPath));
    expect(aEdges).toEqual(aEntryBefore.edges);
    expect(report.files?.total).toBe(2);
    expect(report.files?.cached).toBe(2);
    expect(report.timings?.manifestMs).toEqual(expect.any(Number));
    expect(report.timings?.graphMs).toEqual(expect.any(Number));
    expect(report.timings?.writeManifestMs).toBeUndefined();
    expect(report.timings?.totalMs).toEqual(expect.any(Number));
  });

  it("loads unchanged incremental indexes from a project snapshot", async () => {
    const root = await mkTmpDir("dg-incremental-project-snapshot-");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(filePath, `export const snap = 1;\n`, "utf8");
    runGit(root, ["init"]);
    runGit(root, ["add", "foo.ts"]);
    runGit(root, ["commit", "-m", "initial"]);

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    await expect(fsp.stat(projectSnapshotPathFor(root))).resolves.toBeTruthy();

    const db = new DatabaseSync(diskCacheDbPathFor(root));
    try {
      db.prepare("UPDATE module_cache SET payload = ?").run("{bad json");
    } finally {
      db.close();
    }

    const manifestBefore = await fsp.readFile(manifestPathFor(root), "utf8");
    const prepSpy = vi.spyOn(filePrep, "prepareSourceInput");
    const signatureSpy = vi.spyOn(buildCache, "fileSignature");
    try {
      const incremental = await buildProjectIndexIncremental(root, {
        threads: 2,
        cache: "disk",
      });

      expect(prepSpy).not.toHaveBeenCalled();
      expect(signatureSpy).not.toHaveBeenCalled();
      expect(await fsp.readFile(manifestPathFor(root), "utf8")).toBe(manifestBefore);
      const moduleIndex = incremental.byFile.get(normalize(filePath));
      expect(moduleIndex?.locals.some((local) => local.localName === "snap")).toBe(true);
    } finally {
      prepSpy.mockRestore();
      signatureSpy.mockRestore();
    }
  });

  it("loads unchanged project snapshots when a build report is requested", async () => {
    const root = await mkTmpDir("dg-incremental-project-snapshot-report-");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(filePath, `export const reportedSnap = 1;\n`, "utf8");

    const initialReport: BuildReport = { timings: {} };
    await buildProjectIndex(root, { threads: 2, cache: "disk", report: initialReport });
    const snapshotPath = projectSnapshotPathFor(root);
    await expect(fsp.stat(snapshotPath)).resolves.toBeTruthy();
    const snapshot = JSON.parse(await fsp.readFile(snapshotPath, "utf8")) as {
      analysis?: {
        backend?: unknown;
        label?: unknown;
      };
      analysisReport?: {
        backend?: unknown;
        graph?: unknown;
      };
    };
    expect(typeof snapshot.analysis?.backend).toBe("string");
    expect(typeof snapshot.analysis?.label).toBe("string");
    expect(snapshot.analysisReport?.backend).toBeDefined();
    expect(snapshot.analysisReport?.graph).toBeDefined();

    const db = new DatabaseSync(diskCacheDbPathFor(root));
    try {
      db.prepare("UPDATE module_cache SET payload = ?").run("{bad json");
    } finally {
      db.close();
    }

    const report: BuildReport = { timings: {} };
    const prepSpy = vi.spyOn(filePrep, "prepareSourceInput");
    try {
      const incremental = await buildProjectIndexIncremental(root, {
        threads: 2,
        cache: "disk",
        report,
      });

      expect(prepSpy).not.toHaveBeenCalled();
      expect(incremental.buildReport).toBe(report);
      expect(incremental.analysis?.backend).toBe(snapshot.analysis?.backend);
      expect(incremental.analysis?.label).toBe(snapshot.analysis?.label);
      expect(report.backend).toEqual(snapshot.analysisReport?.backend);
      expect(report.graph).toEqual(snapshot.analysisReport?.graph);
      const moduleIndex = incremental.byFile.get(normalize(filePath));
      expect(moduleIndex?.locals.some((local) => local.localName === "reportedSnap")).toBe(true);
    } finally {
      prepSpy.mockRestore();
    }
  });

  it("reuses unchanged project-scope file lists with reports without reparsing or rediscovering", async () => {
    const root = await mkTmpDir("dg-incremental-project-scope-report-");
    const firstPath = path.join(root, "first.ts");
    const secondPath = path.join(root, "second.ts");
    await fsp.writeFile(firstPath, "export const first = 1;\n", "utf8");
    await fsp.writeFile(secondPath, "export const second = 2;\n", "utf8");

    await buildProjectIndex(root, { cache: "disk", threads: 2 });

    const report: BuildReport = { timings: {} };
    const prepSpy = vi.spyOn(filePrep, "prepareSourceInput");
    const discoverSpy = vi.spyOn(projectFilesModule, "discoverProjectFiles");
    try {
      const incremental = await buildProjectIndexIncremental(root, {
        cache: "disk",
        threads: 2,
        report,
        files: [firstPath, secondPath],
        filesAreProjectScope: true,
      });

      expect(prepSpy).not.toHaveBeenCalled();
      expect(discoverSpy).not.toHaveBeenCalled();
      expect(report.files?.total).toBe(2);
      expect(report.files?.changed).toBe(0);
      expect(report.files?.cached).toBe(2);
      expect(incremental.byFile.has(normalize(firstPath))).toBe(true);
      expect(incremental.byFile.has(normalize(secondPath))).toBe(true);
    } finally {
      prepSpy.mockRestore();
      discoverSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back when the project snapshot payload is malformed", async () => {
    const root = await mkTmpDir("dg-incremental-bad-project-snapshot-");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(filePath, `export const snap = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const snapshotPath = projectSnapshotPathFor(root);
    const snapshot = JSON.parse(await fsp.readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot.modules = [{}];
    await fsp.writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    const moduleIndex = incremental.byFile.get(normalize(filePath));
    expect(moduleIndex?.locals.some((local) => local.localName === "snap")).toBe(true);
  });

  it("falls back when project snapshot symbol entries are malformed", async () => {
    const root = await mkTmpDir("dg-incremental-bad-project-snapshot-symbol-");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(filePath, `export const snap = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const snapshotPath = projectSnapshotPathFor(root);
    const snapshot = JSON.parse(await fsp.readFile(snapshotPath, "utf8")) as {
      modules?: Array<{ locals?: unknown[] }>;
    };
    if (snapshot.modules?.[0]) snapshot.modules[0].locals = [{}];
    await fsp.writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    const moduleIndex = incremental.byFile.get(normalize(filePath));
    expect(moduleIndex?.locals.some((local) => local.localName === "snap")).toBe(true);
  });

  it("falls back when project snapshot imports or exports are malformed", async () => {
    const root = await mkTmpDir("dg-incremental-bad-project-snapshot-bindings-");
    const depPath = path.join(root, "dep.ts");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(depPath, `export const dep = 1;\n`, "utf8");
    await fsp.writeFile(filePath, `import { dep } from "./dep";\nexport const snap = dep;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const snapshotPath = projectSnapshotPathFor(root);
    const snapshot = JSON.parse(await fsp.readFile(snapshotPath, "utf8")) as {
      modules?: Array<{ file?: string; imports?: unknown[]; exports?: unknown[] }>;
    };
    const moduleSnapshot = snapshot.modules?.find((moduleIndex) => moduleIndex.file === normalize(filePath));
    if (moduleSnapshot) {
      moduleSnapshot.imports = [{}];
      moduleSnapshot.exports = [{}];
    }
    await fsp.writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    const moduleIndex = incremental.byFile.get(normalize(filePath));
    expect(moduleIndex?.locals.some((local) => local.localName === "snap")).toBe(true);
  });

  it("falls back when project snapshot metadata fields are malformed", async () => {
    const root = await mkTmpDir("dg-incremental-bad-project-snapshot-metadata-");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(filePath, `export const snap = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const snapshotPath = projectSnapshotPathFor(root);
    const snapshot = JSON.parse(await fsp.readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot.projectRoot = 1;
    snapshot.nativeMode = "sometimes";
    snapshot.projectFiles = [{}];
    await fsp.writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    const moduleIndex = incremental.byFile.get(normalize(filePath));
    expect(moduleIndex?.locals.some((local) => local.localName === "snap")).toBe(true);
  });

  it("falls back when project snapshot graph edges are malformed", async () => {
    const root = await mkTmpDir("dg-incremental-bad-project-snapshot-edge-");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(filePath, `export const snap = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const snapshotPath = projectSnapshotPathFor(root);
    const snapshot = JSON.parse(await fsp.readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot.graph = { nodes: [normalize(filePath)], edges: [{ from: normalize(filePath), to: {} }] };
    await fsp.writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    const moduleIndex = incremental.byFile.get(normalize(filePath));
    expect(moduleIndex?.locals.some((local) => local.localName === "snap")).toBe(true);
  });
  it("drops manifest edges for deleted files during incremental builds", async () => {
    const root = await mkTmpDir("dg-incremental-delete-");
    const aPath = path.join(root, "a.ts");
    const bPath = path.join(root, "b.ts");

    await fsp.writeFile(aPath, `import './b';\n`, "utf8");
    await fsp.writeFile(bPath, `export const b = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    await fsp.unlink(aPath);

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });
    const manifestAfter = await readManifest(root);

    expect(manifestAfter.files[normalize(aPath)]).toBeUndefined();
    const aEdges = incremental.graph.edges.filter((edge) => edge.from === normalize(aPath));
    expect(aEdges).toEqual([]);
  });

  it("recomputes unchanged importers when a referenced dependency is deleted", async () => {
    const root = await mkTmpDir("dg-incremental-deleted-dependency-");
    const mainPath = path.join(root, "main.ts");
    const utilPath = path.join(root, "util.ts");

    await fsp.writeFile(mainPath, `import { helper } from "./util";\nexport const run = () => helper();\n`, "utf8");
    await fsp.writeFile(utilPath, `export function helper() { return 1; }\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    await fsp.unlink(utilPath);

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });
    const manifestAfter = await readManifest(root);
    const normalizedMain = normalize(mainPath);
    const normalizedUtil = normalize(utilPath);

    expect(manifestAfter.files[normalizedUtil]).toBeUndefined();
    expect(incremental.graph.nodes.has(normalizedUtil)).toBe(false);
    expect(
      incremental.graph.edges.some(
        (edge) => edge.from === normalizedMain && edge.to.type === "file" && edge.to.path === normalizedUtil,
      ),
    ).toBe(false);

    const mainModule = incremental.byFile.get(normalizedMain);
    expect(mainModule).toBeDefined();
    expect(mainModule?.imports.some((imp) => typeof imp.resolved === "string" && imp.resolved === normalizedUtil)).toBe(
      false,
    );
  });

  it("persists an empty manifest when incremental rebuild deletes the last tracked file", async () => {
    const root = await mkTmpDir("dg-incremental-empty-after-delete-");
    const onlyPath = path.join(root, "only.ts");

    await fsp.writeFile(onlyPath, `export const value = 1;\n`, "utf8");
    await buildProjectIndex(root, { threads: 2, cache: "disk" });

    await fsp.unlink(onlyPath);

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });
    const manifestAfter = await readManifest(root);

    expect(incremental.graph.nodes.size).toBe(0);
    expect(incremental.graph.edges).toEqual([]);
    expect(Object.keys(manifestAfter.files)).toEqual([]);
  });

  it("updates only explicit files in incremental builds", async () => {
    const root = await mkTmpDir("dg-incremental-explicit-");
    const aPath = path.join(root, "a.ts");
    const bPath = path.join(root, "b.ts");
    const cPath = path.join(root, "c.ts");
    const dPath = path.join(root, "d.ts");

    await fsp.writeFile(aPath, `import './b';\n`, "utf8");
    await fsp.writeFile(bPath, `export const b = 1;\n`, "utf8");
    await fsp.writeFile(cPath, `import './d';\n`, "utf8");
    await fsp.writeFile(dPath, `export const d = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const manifestBefore = await readManifest(root);
    const cEntryBefore = manifestBefore.files[normalize(cPath)];

    await fsp.writeFile(aPath, `import './d';\n`, "utf8");

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      files: [aPath],
    });
    const manifestAfter = await readManifest(root);

    expect(manifestAfter.files[normalize(cPath)].edges).toEqual(cEntryBefore.edges);
    const cEdges = incremental.graph.edges.filter((edge) => edge.from === normalize(cPath));
    expect(cEdges).toEqual(cEntryBefore.edges);
  });

  it("rejects explicit incremental files outside the project root", async () => {
    const root = await createTempProjectRoot("dg-incremental-explicit-root-", [
      { path: "inside.ts", contents: "export const inside = 1;\n" },
    ]);
    await buildProjectIndex(root, { threads: 2, cache: "disk" });

    await expect(
      buildProjectIndexIncremental(root, {
        threads: 2,
        cache: "disk",
        files: [path.resolve("README.md")],
      }),
    ).rejects.toThrow(/outside project root/);
  });

  it("drops out-of-root manifest entries during incremental reuse", async () => {
    const root = await mkTmpDir("dg-incremental-manifest-sanitize-");
    const insideFile = path.join(root, "inside.ts");
    const outsideFile = path.join(os.tmpdir(), `dg-outside-${Date.now()}.ts`);

    await fsp.writeFile(insideFile, `export const inside = 1;\n`, "utf8");
    await fsp.writeFile(outsideFile, `export const outside = 1;\n`, "utf8");
    await buildProjectIndex(root, { threads: 2, cache: "disk" });

    const manifest = await readManifest(root);
    manifest.files[normalize(outsideFile)] = {
      sig: "synthetic",
      edges: [],
    };
    await fsp.writeFile(
      path.join(root, ".codegraph-cache", "index-v1", "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );

    try {
      const incremental = await buildProjectIndexIncremental(root, {
        threads: 2,
        cache: "disk",
      });
      const manifestAfter = await readManifest(root);

      expect(incremental.byFile.has(normalize(outsideFile))).toBe(false);
      expect([...incremental.graph.nodes].includes(normalize(outsideFile))).toBe(false);
      expect(Object.keys(manifestAfter.files)).not.toContain(normalize(outsideFile));
    } finally {
      await fsp.rm(outsideFile, { force: true });
    }
  });

  it("rebuilds when graph options change", async () => {
    const root = await mkTmpDir("dg-incremental-graph-opts-");
    const aPath = path.join(root, "a.ts");

    await fsp.writeFile(aPath, `import './b';\n`, "utf8");
    await buildProjectIndex(root, { threads: 2, cache: "disk" });

    const prepSpy = vi.spyOn(filePrep, "prepareSourceInput");
    await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      graph: { fast: true },
    });

    expect(prepSpy).toHaveBeenCalled();
    prepSpy.mockRestore();
  });

  it("refreshes incremental manifest when HEAD diverges and picks up new commit files", async () => {
    const root = await mkTmpDir("dg-manifest-head-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "cache@test.local"]);
    runGit(root, ["config", "user.name", "Cache Test"]);

    const firstPath = path.join(root, "first.ts");
    await fsp.writeFile(firstPath, `export const first = 1;\n`, "utf8");
    runGit(root, ["add", "first.ts"]);
    runGit(root, ["commit", "-m", "first"]);

    await buildProjectIndex(root, { threads: 2, cache: "disk" });

    const nextPath = path.join(root, "next.ts");
    await fsp.writeFile(nextPath, `export const next = 2;\n`, "utf8");
    runGit(root, ["add", "next.ts"]);
    runGit(root, ["commit", "-m", "next"]);

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    const nextModule = incremental.byFile.get(normalize(nextPath));
    expect(nextModule).toBeDefined();
    expect(nextModule?.locals.some((l) => l.localName === "next")).toBe(true);
  });

  it("reuses persisted bloom filters from the project snapshot on unchanged incremental loads", async () => {
    const root = await mkTmpDir("dg-snapshot-bloom-reuse-");
    const alphaPath = path.join(root, "alpha.ts");
    const betaPath = path.join(root, "beta.ts");
    await fsp.writeFile(alphaPath, "export const alphaValue = 1;\n", "utf8");
    await fsp.writeFile(
      betaPath,
      'import { alphaValue } from "./alpha";\nexport const betaValue = alphaValue;\n',
      "utf8",
    );

    await buildProjectIndex(root, { threads: 2, cache: "disk", useBloomFilters: true });

    const bloomSpy = vi.spyOn(buildCache, "buildBloomFilterForFile");

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      useBloomFilters: true,
    });

    expect(bloomSpy).not.toHaveBeenCalled();
    expect(incremental.bloomFilters?.size()).toBe(2);
    expect(incremental.bloomFilters?.get(normalize(alphaPath))?.mightContain("alphaValue")).toBe(true);

    bloomSpy.mockRestore();
  });

  it("reuses persisted bloom filters for unchanged files during a genuine incremental rebuild", async () => {
    const root = await mkTmpDir("dg-snapshot-bloom-partial-reuse-");
    const alphaPath = path.join(root, "alpha.ts");
    const betaPath = path.join(root, "beta.ts");
    const gammaPath = path.join(root, "gamma.ts");
    await fsp.writeFile(alphaPath, "export const alphaValue = 1;\n", "utf8");
    await fsp.writeFile(betaPath, "export const betaValue = 2;\n", "utf8");
    await fsp.writeFile(gammaPath, "export const gammaValue = 3;\n", "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk", useBloomFilters: true });

    // Modify only gamma.ts: alpha.ts and beta.ts stay genuine, provable cache hits, but the
    // snapshot as a whole can no longer be reused wholesale (`changedFiles.size` is nonzero),
    // so the incremental builder must fall through to the per-file cache-hit loop -- exactly
    // the path that used to rebuild every unchanged file's bloom filter from source even
    // though the persisted snapshot already had it.
    await fsp.writeFile(gammaPath, "export const gammaValue = 999;\n", "utf8");

    const bloomSpy = vi.spyOn(buildCache, "buildBloomFilterForFile");

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      useBloomFilters: true,
    });

    // alpha.ts and beta.ts are unchanged cache hits: their filters come from the persisted
    // snapshot. gamma.ts is reparsed fresh and gets its filter from the in-memory source
    // during parsing, not from `buildBloomFilterForFile`. Neither path re-reads any file
    // from disk just to rebuild a filter it already has.
    expect(bloomSpy).not.toHaveBeenCalled();
    expect(incremental.bloomFilters?.size()).toBe(3);
    expect(incremental.bloomFilters?.get(normalize(alphaPath))?.mightContain("alphaValue")).toBe(true);
    expect(incremental.bloomFilters?.get(normalize(betaPath))?.mightContain("betaValue")).toBe(true);
    expect(incremental.bloomFilters?.get(normalize(gammaPath))?.mightContain("gammaValue")).toBe(true);

    bloomSpy.mockRestore();
  });

  it("does not hydrate persisted bloom filters when bloom filters are disabled", async () => {
    const root = await mkTmpDir("dg-snapshot-bloom-disabled-");
    const entryPath = path.join(root, "entry.ts");
    await fsp.writeFile(entryPath, "export const disabledBloom = 1;\n", "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk", useBloomFilters: true });

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      useBloomFilters: false,
    });

    expect(
      incremental.byFile.get(normalize(entryPath))?.locals.some((local) => local.localName === "disabledBloom"),
    ).toBe(true);
    expect(incremental.bloomFilters).toBeUndefined();
  });

  it("falls back when project snapshot bloom filters are malformed", async () => {
    const root = await mkTmpDir("dg-snapshot-bloom-malformed-");
    const entryPath = path.join(root, "entry.ts");
    await fsp.writeFile(entryPath, "export const guarded = 1;\n", "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk", useBloomFilters: true });
    const snapshotPath = projectSnapshotPathFor(root);
    const snapshot = JSON.parse(await fsp.readFile(snapshotPath, "utf8")) as {
      bloomFilters?: Record<string, unknown>;
    };
    snapshot.bloomFilters = {
      [normalize(entryPath)]: {
        size: 1_000,
        hashCount: 3,
        bitsBase64: "AAAA",
      },
    };
    await fsp.writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");

    const rebuilt = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      useBloomFilters: true,
    });

    expect(rebuilt.byFile.get(normalize(entryPath))?.locals.some((local) => local.localName === "guarded")).toBe(true);
    expect(rebuilt.bloomFilters?.get(normalize(entryPath))?.mightContain("guarded")).toBe(true);
  });

  it("falls back from older project snapshot versions and rewrites the current schema", async () => {
    const root = await mkTmpDir("dg-snapshot-version-upgrade-");
    const entryPath = path.join(root, "entry.ts");
    await fsp.writeFile(entryPath, "export const versioned = 1;\n", "utf8");

    const initial = await buildProjectIndex(root, { threads: 2, cache: "disk", useBloomFilters: true });
    const snapshotPath = projectSnapshotPathFor(root);
    const originalSnapshot = JSON.parse(await fsp.readFile(snapshotPath, "utf8")) as {
      version: number;
      filesSignature: string;
      graph: unknown;
      modules: unknown;
      projectRoot?: string;
      nativeMode?: string;
      projectFiles?: unknown;
    };

    await fsp.writeFile(
      snapshotPath,
      JSON.stringify({
        version: 1,
        filesSignature: originalSnapshot.filesSignature,
        graph: originalSnapshot.graph,
        modules: originalSnapshot.modules,
        ...(originalSnapshot.projectRoot ? { projectRoot: originalSnapshot.projectRoot } : {}),
        ...(originalSnapshot.nativeMode ? { nativeMode: originalSnapshot.nativeMode } : {}),
        ...(originalSnapshot.projectFiles ? { projectFiles: originalSnapshot.projectFiles } : {}),
      }),
      "utf8",
    );

    const rebuilt = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      useBloomFilters: true,
    });
    const rewrittenSnapshot = JSON.parse(await fsp.readFile(snapshotPath, "utf8")) as {
      version: number;
      bloomFilters?: Record<string, unknown>;
      nativeRuntimeFingerprint?: string;
    };

    expect(initial.byFile.has(normalize(entryPath))).toBe(true);
    expect(rebuilt.byFile.has(normalize(entryPath))).toBe(true);
    expect(rebuilt.bloomFilters?.get(normalize(entryPath))?.mightContain("versioned")).toBe(true);
    expect(rewrittenSnapshot.version).toBe(3);
    expect(rewrittenSnapshot.nativeRuntimeFingerprint).toBeTypeOf("string");
    expect(rewrittenSnapshot.bloomFilters?.[normalize(entryPath)]).toBeDefined();
  });

  it("clears stale negative resolve caches when requested", async () => {
    const root = await mkTmpDir("dg-resolve-cache-clear-");
    const main = path.join(root, "main.ts");
    await fsp.writeFile(main, "import { dep } from './dep'\n", "utf8");

    const missing = await resolveSpecifier(main, "./dep", root);
    expect(typeof missing).toBe("object");

    const depPath = path.join(root, "dep.ts");
    await fsp.writeFile(depPath, "export const dep = 1\n", "utf8");

    const stale = await resolveSpecifier(main, "./dep", root);
    expect(typeof stale).toBe("object");

    clearResolutionCaches();

    const fresh = await resolveSpecifier(main, "./dep", root);
    expect(typeof fresh).toBe("string");
    if (typeof fresh === "string") {
      expect(normalize(fresh)).toBe(normalize(depPath));
    }
  });

  it("clears stale positive resolve caches across index builds", async () => {
    const root = await mkTmpDir("dg-resolve-cache-positive-");
    const main = path.join(root, "main.ts");
    const depPath = path.join(root, "dep.ts");

    await fsp.writeFile(main, "import { dep } from './dep'\n", "utf8");
    await fsp.writeFile(depPath, "export const dep = 1\n", "utf8");

    const first = await buildProjectIndex(root);
    expect(
      first.graph.edges.some(
        (edge) => edge.from === normalize(main) && edge.to.type === "file" && edge.to.path === normalize(depPath),
      ),
    ).toBe(true);

    await fsp.unlink(depPath);

    const rebuilt = await buildProjectIndex(root);
    expect(
      rebuilt.graph.edges.some(
        (edge) => edge.from === normalize(main) && edge.to.type === "file" && edge.to.path === normalize(depPath),
      ),
    ).toBe(false);
    const mainModule = rebuilt.byFile.get(normalize(main));
    expect(mainModule).toBeDefined();
    expect(
      mainModule?.imports.some((imp) => typeof imp.resolved === "string" && imp.resolved === normalize(depPath)),
    ).toBe(false);
  });

  it("writes a string config hash after incremental updates and reuses it", async () => {
    const root = await mkTmpDir("dg-incremental-config-hash-");
    const entryFile = path.join(root, "entry.ts");
    await fsp.writeFile(entryFile, "export const value = 1;\n", "utf8");

    await buildProjectIndex(root, { cache: "disk" });
    await fsp.writeFile(entryFile, "export const value = 2;\n", "utf8");

    await buildProjectIndexIncremental(root, { cache: "disk" });

    const manifestPath = path.join(root, ".codegraph-cache", "index-v1", "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as { configHash?: unknown };
    expect(typeof manifest.configHash).toBe("string");

    const report: BuildReport = { timings: {} };
    await buildProjectIndexIncremental(root, {
      cache: "disk",
      logLevel: "silent",
      report,
    });

    expect(report.manifest?.used).toBe(true);
    expect(report.manifest?.reused).toBe(true);
    expect(report.manifest?.reason).toBeUndefined();
  });

  it("invalidates the disk manifest cache when codegraph.config.json content changes", async () => {
    const root = await mkTmpDir("dg-config-json-hash-");
    const entryFile = path.join(root, "entry.ts");
    const configPath = path.join(root, "codegraph.config.json");

    await fsp.writeFile(entryFile, "export const value = 1;\n", "utf8");
    await fsp.writeFile(configPath, JSON.stringify({ discovery: { ignoreGlobs: ["dist/**"] } }), "utf8");

    await buildProjectIndex(root, { cache: "disk" });

    const manifestPath = path.join(root, ".codegraph-cache", "index-v1", "manifest.json");
    const manifestBefore = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as { configHash?: unknown };
    expect(typeof manifestBefore.configHash).toBe("string");

    await fsp.writeFile(configPath, JSON.stringify({ discovery: { ignoreGlobs: ["build/**"] } }), "utf8");

    const report: BuildReport = { timings: {} };
    await buildProjectIndexIncremental(root, {
      cache: "disk",
      logLevel: "silent",
      report,
    });

    expect(report.manifest?.used).toBe(true);
    expect(report.manifest?.reused).toBe(false);
    expect(report.manifest?.reason).toBeTruthy();

    const manifestAfter = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as { configHash?: unknown };
    expect(typeof manifestAfter.configHash).toBe("string");
    expect(manifestAfter.configHash).not.toBe(manifestBefore.configHash);
  });

  it("preserves stable config caches when clearing import resolution state", async () => {
    const root = await mkTmpDir("dg-import-cache-preserve-");
    const srcDir = path.join(root, "src");
    const pkgDir = path.join(root, "packages", "shared");
    const tsconfigPath = path.join(root, "tsconfig.json");
    const packageJsonPath = path.join(root, "package.json");
    const sourceFile = path.join(srcDir, "main.ts");
    const sharedManifestPath = path.join(pkgDir, "package.json");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(pkgDir, { recursive: true });
    await fsp.writeFile(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@shared/*": ["packages/shared/src/*"] },
        },
      }),
      "utf8",
    );
    await fsp.writeFile(packageJsonPath, JSON.stringify({ private: true, workspaces: ["packages/*"] }), "utf8");
    await fsp.writeFile(sharedManifestPath, JSON.stringify({ name: "@shared/core" }), "utf8");
    await fsp.writeFile(sourceFile, "import { shared } from '@shared/core';\nexport const main = shared;\n", "utf8");

    const originalReadFile = fsp.readFile.bind(fsp);
    const readSpy = vi.spyOn(fsp, "readFile").mockImplementation(async (filePath, options) => {
      return await originalReadFile(filePath, options as never);
    });

    try {
      await loadNearestTsconfigFor(sourceFile);
      await loadWorkspaceConfig(root);

      clearImportResolutionCaches();

      await loadNearestTsconfigFor(sourceFile);
      await loadWorkspaceConfig(root);

      const tsconfigReads = readSpy.mock.calls.filter(
        ([filePath]) => normalize(String(filePath)) === normalize(tsconfigPath),
      );
      const rootPackageReads = readSpy.mock.calls.filter(
        ([filePath]) => normalize(String(filePath)) === normalize(packageJsonPath),
      );
      const sharedManifestReads = readSpy.mock.calls.filter(
        ([filePath]) => normalize(String(filePath)) === normalize(sharedManifestPath),
      );
      expect(tsconfigReads).toHaveLength(1);
      expect(rootPackageReads).toHaveLength(3);
      expect(sharedManifestReads).toHaveLength(1);
    } finally {
      readSpy.mockRestore();
      clearResolutionCaches();
    }
  });

  it("rebuilds when .gitignore files change", async () => {
    const root = await mkTmpDir("dg-gitignore-config-");
    const trackedPath = path.join(root, "src", "main.ts");
    const generatedPath = path.join(root, "src", "generated.ts");

    await fsp.mkdir(path.dirname(trackedPath), { recursive: true });
    await fsp.writeFile(trackedPath, "export const main = 1;\n", "utf8");
    await fsp.writeFile(generatedPath, "export const generated = 1;\n", "utf8");

    const initial = await buildProjectIndex(root, {
      threads: 2,
      cache: "disk",
    });
    expect(initial.byFile.has(normalize(generatedPath))).toBe(true);

    await fsp.writeFile(path.join(root, ".gitignore"), "src/generated.ts\n", "utf8");

    const rebuilt = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    expect(rebuilt.byFile.has(normalize(trackedPath))).toBe(true);
    expect(rebuilt.byFile.has(normalize(generatedPath))).toBe(false);
  });

  it("picks up a newly created untracked file on an incremental build without an explicit file list", async () => {
    const root = await mkTmpDir("dg-incremental-untracked-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    const trackedPath = path.join(root, "tracked.ts");
    await fsp.writeFile(trackedPath, "export const tracked = 1;\n", "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);
    await buildProjectIndex(root, { cache: "disk" });

    const freshPath = path.join(root, "fresh.ts");
    await fsp.writeFile(freshPath, "export const fresh = 1;\n", "utf8");
    // build-index.ts imports listProjectFiles directly from util/projectFiles.js, not
    // through the src/util.js barrel, so the spy must target that module to actually
    // intercept the call this test is asserting against.
    const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
    try {
      // No explicit `files` override: the incremental builder must discover the new
      // untracked file itself via Git rather than requiring a caller-supplied file list.
      const rebuilt = await buildProjectIndexIncremental(root, { cache: "disk" });

      expect(rebuilt.byFile.has(normalize(trackedPath))).toBe(true);
      expect(rebuilt.byFile.has(normalize(freshPath))).toBe(true);
      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      scanSpy.mockRestore();
    }
  });

  it("skips full signature validation on a warm run when an already-indexed untracked file is unchanged", async () => {
    const root = await mkTmpDir("dg-incremental-untracked-warm-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    const trackedPath = path.join(root, "tracked.ts");
    await fsp.writeFile(trackedPath, "export const tracked = 1;\n", "utf8");
    runGit(root, ["add", "tracked.ts"]);
    runGit(root, ["commit", "-m", "base"]);
    // A file that is untracked from Git's perspective (never added or committed) but has
    // already been indexed once, mirroring a routine build artifact or scratch file that
    // stays untracked forever. Its mere presence must not permanently disable the snapshot
    // fast path on every later run.
    const scratchPath = path.join(root, "scratch.ts");
    await fsp.writeFile(scratchPath, "export const scratch = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk" });

    // `getGitBlobHashes` is only reached once the whole-snapshot fast path is skipped, and
    // (unlike `tryLoadFromCache`) it runs before the later full-validation pass can also
    // find nothing changed and short-circuit on its own -- so it is a reliable signal that
    // the *early* snapshot fast path, gated on untracked-file presence, was actually taken.
    const gitSigSpy = vi.spyOn(gitModule, "getGitBlobHashes");
    try {
      const rebuilt = await buildProjectIndexIncremental(root, { cache: "disk" });

      expect(gitSigSpy).not.toHaveBeenCalled();
      expect(rebuilt.byFile.has(normalize(trackedPath))).toBe(true);
      expect(rebuilt.byFile.has(normalize(scratchPath))).toBe(true);
    } finally {
      gitSigSpy.mockRestore();
    }
  });

  it("still detects a content change to an already-indexed untracked file", async () => {
    const root = await mkTmpDir("dg-incremental-untracked-stale-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    const trackedPath = path.join(root, "tracked.ts");
    await fsp.writeFile(trackedPath, "export const tracked = 1;\n", "utf8");
    runGit(root, ["add", "tracked.ts"]);
    runGit(root, ["commit", "-m", "base"]);
    const scratchPath = path.join(root, "scratch.ts");
    await fsp.writeFile(scratchPath, "export const scratchOriginal = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk" });

    // Git has no diff history for an untracked file, so nothing short of re-checking this
    // specific file's own signature can prove it is still current. An already-known
    // untracked file must therefore stay eligible for the fast path only while its content
    // provably has not changed -- never unconditionally once it is merely "seen before".
    await fsp.writeFile(scratchPath, "export const scratchUpdated = 2;\n", "utf8");
    const rebuilt = await buildProjectIndexIncremental(root, { cache: "disk" });

    const scratchModule = rebuilt.byFile.get(normalize(scratchPath));
    expect(scratchModule?.locals.some((local) => local.localName === "scratchUpdated")).toBe(true);
    expect(scratchModule?.locals.some((local) => local.localName === "scratchOriginal")).toBe(false);
  });

  it("picks up a newly staged (git add, not committed) file on an incremental build", async () => {
    const root = await mkTmpDir("dg-incremental-staged-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    const trackedPath = path.join(root, "tracked.ts");
    await fsp.writeFile(trackedPath, "export const tracked = 1;\n", "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);
    await buildProjectIndex(root, { cache: "disk" });

    // Staging a new file removes it from `git ls-files --others` (it is no longer
    // "untracked"), and it has no manifest entry either, so only a diff against the
    // working tree (not just the last commit) can find it while HEAD is unmoved.
    const stagedPath = path.join(root, "staged.ts");
    await fsp.writeFile(stagedPath, "export const staged = 1;\n", "utf8");
    runGit(root, ["add", "staged.ts"]);
    const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
    try {
      const rebuilt = await buildProjectIndexIncremental(root, { cache: "disk" });

      expect(rebuilt.byFile.has(normalize(trackedPath))).toBe(true);
      expect(rebuilt.byFile.has(normalize(stagedPath))).toBe(true);
      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      scanSpy.mockRestore();
    }
  });

  it("falls back to a full rebuild instead of an incomplete index when listing untracked files fails", async () => {
    const root = await mkTmpDir("dg-incremental-untracked-failure-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    const trackedPath = path.join(root, "tracked.ts");
    await fsp.writeFile(trackedPath, "export const tracked = 1;\n", "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);
    await buildProjectIndex(root, { cache: "disk" });

    const freshPath = path.join(root, "fresh.ts");
    await fsp.writeFile(freshPath, "export const fresh = 1;\n", "utf8");
    const untrackedSpy = vi
      .spyOn(incrementalPlan, "listUntrackedProjectFiles")
      .mockRejectedValue(new Error("simulated git failure"));
    try {
      // A failure discovering untracked files must not silently produce an index that is
      // missing a real project file; it must fall back to a full rebuild instead, which
      // reaches `fresh.ts` through the ordinary full-scan path.
      const rebuilt = await buildProjectIndexIncremental(root, { cache: "disk" });

      expect(rebuilt.byFile.has(normalize(trackedPath))).toBe(true);
      expect(rebuilt.byFile.has(normalize(freshPath))).toBe(true);
    } finally {
      untrackedSpy.mockRestore();
    }
  });

  it("persists discovered symlink directories in the manifest for reuse on the next full build", async () => {
    const root = await mkTmpDir("dg-manifest-symlink-persist-");
    const packageDir = path.join(root, "packages", "core");
    const linkedPackage = path.join(root, "linked-core");
    await fsp.mkdir(path.join(packageDir, "src"), { recursive: true });
    await fsp.writeFile(path.join(packageDir, "src", "index.ts"), "export const core = 1;\n", "utf8");

    try {
      await fsp.symlink(packageDir, linkedPackage, "junction");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await buildProjectIndex(root, { cache: "disk" });
    const manifest = await readManifest(root);

    expect(manifest.symlinkDirectories).toBeDefined();
    expect((manifest.symlinkDirectories ?? []).map(normalize)).toContain(normalize(linkedPackage));
  });

  it("prunes stale symlink directory hints from the manifest after warm re-verification", async () => {
    const root = await mkTmpDir("dg-manifest-symlink-prune-stale-");
    const packageDir = path.join(root, "packages", "core");
    const linkedPackage = path.join(root, "linked-core");
    await fsp.mkdir(path.join(packageDir, "src"), { recursive: true });
    await fsp.writeFile(path.join(packageDir, "src", "index.ts"), "export const core = 1;\n", "utf8");

    try {
      await fsp.symlink(packageDir, linkedPackage, "junction");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await buildProjectIndex(root, { cache: "disk" });
    const staleManifest = await readManifest(root);
    expect((staleManifest.symlinkDirectories ?? []).map(normalize)).toContain(normalize(linkedPackage));

    await fsp.rm(linkedPackage, { recursive: true, force: true });
    await buildProjectIndex(root, { cache: "disk" });
    const refreshedManifest = await readManifest(root);

    expect(refreshedManifest.symlinkDirectories).toEqual([]);
  });

  it("re-probes for symlinks under --cache-strict even when the manifest hint says none exist", async () => {
    const root = await mkTmpDir("dg-manifest-symlink-force-reprobe-");
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");

    await buildProjectIndex(root, { cache: "disk" });
    const staleManifest = await readManifest(root);
    expect(staleManifest.symlinkDirectories).toEqual([]);

    // A symlinked directory created after the "no symlinks" hint was recorded (e.g. an
    // `npm link`) must still be discovered on the next full build when the user asks for
    // maximum correctness, rather than being silently skipped because the stale hint
    // disables probing entirely.
    const packageDir = path.join(root, "packages", "core");
    const linkedPackage = path.join(root, "linked-core");
    await fsp.mkdir(path.join(packageDir, "src"), { recursive: true });
    await fsp.writeFile(path.join(packageDir, "src", "index.ts"), "export const core = 1;\n", "utf8");
    try {
      await fsp.symlink(packageDir, linkedPackage, "junction");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const rebuilt = await buildProjectIndex(root, { cache: "disk", cacheStrict: true });

    expect(rebuilt.byFile.has(normalize(path.join(linkedPackage, "src", "index.ts")))).toBe(true);
    const refreshedManifest = await readManifest(root);
    expect((refreshedManifest.symlinkDirectories ?? []).map(normalize)).toContain(normalize(linkedPackage));
  });

  it("persists an empty symlinkDirectories list for projects without symlinks", async () => {
    const root = await mkTmpDir("dg-manifest-symlink-empty-");
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");

    await buildProjectIndex(root, { cache: "disk" });
    const manifest = await readManifest(root);

    expect(manifest.symlinkDirectories).toEqual([]);
  });

  it("rebuilds successfully from a pre-existing manifest that predates the symlinkDirectories field", async () => {
    const root = await mkTmpDir("dg-manifest-symlink-migration-");
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    await fsp.mkdir(path.join(root, ".codegraph-cache", "index-v1"), { recursive: true });
    const oldSchemaManifest = createManifest(root);
    expect("symlinkDirectories" in oldSchemaManifest).toBe(false);
    expect("transientFiles" in oldSchemaManifest).toBe(false);
    await fsp.writeFile(manifestPathFor(root), JSON.stringify(oldSchemaManifest, null, 2), "utf8");

    // graphOptions mismatch (missing on the fixture manifest) forces a full rebuild path,
    // exercising exactly the branch that reads a possibly-absent symlinkDirectories hint.
    const rebuilt = await buildProjectIndexIncremental(root, { cache: "disk" });
    expect(rebuilt.byFile.has(normalize(path.join(root, "a.ts")))).toBe(true);

    const backfilledManifest = await readManifest(root);
    expect(backfilledManifest.symlinkDirectories).toEqual([]);
    expect(backfilledManifest.transientFiles).toEqual([]);
  });
});
