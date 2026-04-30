import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { buildProjectIndex, buildProjectIndexIncremental, type BuildReport } from "../src/index.js";
import * as indexer from "../src/indexer.js";
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
import * as filePrep from "../src/languages/filePrep.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

function diskCacheDbPathFor(root: string): string {
  return path.join(root, ".codegraph-cache", "index-v1", "index-cache.sqlite");
}

function loadBetterSqlite3() {
  const require = createRequire(import.meta.url);
  return require("better-sqlite3") as typeof import("better-sqlite3");
}

function readModuleCacheUpdatedAt(root: string, file: string): number | null {
  const dbPath = diskCacheDbPathFor(root);
  const BetterSqlite3 = loadBetterSqlite3();
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT updated_at FROM module_cache WHERE file = ?").get(file) as
      | { updated_at: number }
      | undefined;
    return row?.updated_at ?? null;
  } finally {
    db.close();
  }
}

async function readManifest(root: string) {
  const mf = path.join(root, ".codegraph-cache", "index-v1", "manifest.json");
  const raw = await fsp.readFile(mf, "utf8");
  return JSON.parse(raw);
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe("Cache invalidation and strict hashing", () => {
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
    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });
    expect(prepSpy).not.toHaveBeenCalled();
    prepSpy.mockRestore();

    const aEdges = incremental.graph.edges.filter((edge) => edge.from === normalize(aPath));
    expect(aEdges).toEqual(aEntryBefore.edges);
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
    const root = await mkTmpDir("dg-incremental-explicit-root-");
    const insideFile = path.join(root, "inside.ts");
    await fsp.writeFile(insideFile, `export const inside = 1;\n`, "utf8");
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
});
