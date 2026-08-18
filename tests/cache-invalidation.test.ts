import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
  findReferences,
  resolveExport,
  type BuildReport,
} from "../src/index.js";
import type { ModuleIndex, ProjectIndex } from "../src/indexer/types.js";
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
  getGitBlobHashes,
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
import { getAllLanguages, getLanguageById } from "../src/languages/registry.js";
import type { LanguageDefinition } from "../src/languages/types.js";
import {
  clearImplementationFingerprintCache,
  languageDefinitionFingerprintCoverage,
} from "../src/indexer/build-cache/options.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { runGit } from "./helpers/git.js";
import { createTempProjectRoot, mkTmpDir } from "./helpers/filesystem.js";

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

function diskCacheDbPathFor(root: string): string {
  return path.join(root, ".codegraph-cache", "index-v1", "index-cache.sqlite");
}

function cacheFile(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, "/");
}

function readModuleCacheUpdatedAt(root: string, file: string): number | null {
  const dbPath = diskCacheDbPathFor(root);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT updated_at FROM module_cache WHERE file = ?").get(cacheFile(root, file)) as
      | { updated_at: number }
      | undefined;
    return row?.updated_at ?? null;
  } finally {
    db.close();
  }
}

function readModuleCacheSignature(root: string, file: string): string | null {
  const dbPath = diskCacheDbPathFor(root);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT sig FROM module_cache WHERE file = ?").get(cacheFile(root, file)) as
      | { sig: string }
      | undefined;
    return row?.sig ?? null;
  } finally {
    db.close();
  }
}

function moduleForPath(index: ProjectIndex, filePath: string): ModuleIndex | undefined {
  const identity = fileIdentityKey(filePath);
  return Array.from(index.byFile.entries()).find(([file]) => fileIdentityKey(file) === identity)?.[1];
}

function manifestPathFor(root: string): string {
  return path.join(root, ".codegraph-cache", "index-v1", "manifest.json");
}

describe("navigation package cache invalidation", () => {
  it("resolves Go sibling symbols using the package name from the rebuilt index", async () => {
    const root = await mkTmpDir("codegraph-go-package-cache-");
    const oldPackageFile = normalize(path.join(root, "old.go"));
    const newPackageFile = normalize(path.join(root, "new.go"));
    const consumerFile = normalize(path.join(root, "consumer.go"));
    try {
      await fsp.writeFile(oldPackageFile, "package old\nfunc Symbol() {}\n", "utf8");
      await fsp.writeFile(newPackageFile, "package new\nfunc Symbol() {}\n", "utf8");
      await fsp.writeFile(consumerFile, "package old\nfunc Use() { Symbol() }\n", "utf8");

      const firstIndex = await buildProjectIndex(root, { cache: "off" });
      const first = resolveExport(firstIndex, consumerFile, "Symbol");
      expect(first?.kind).toBe("resolved");
      if (first?.kind === "resolved") expect(first.def.file).toBe(oldPackageFile);

      await fsp.writeFile(consumerFile, "package new\nfunc Use() { Symbol() }\n", "utf8");
      const rebuiltIndex = await buildProjectIndex(root, { cache: "off" });
      const rebuilt = resolveExport(rebuiltIndex, consumerFile, "Symbol");
      expect(rebuilt?.kind).toBe("resolved");
      if (rebuilt?.kind === "resolved") expect(rebuilt.def.file).toBe(newPackageFile);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds cache-off indexes after a same-metadata source mutation", async () => {
    const root = await mkTmpDir("codegraph-cache-off-signature-");
    const sourceFile = path.join(root, "source.ts");
    const firstSource = "export const first = 1;\n";
    const secondSource = "export const nextt = 2;\n";
    try {
      await fsp.writeFile(sourceFile, firstSource, "utf8");
      const firstIndex = await buildProjectIndex(root, { cache: "off" });
      expect(moduleForPath(firstIndex, sourceFile)?.locals.some((local) => local.localName === "first")).toBe(true);

      const originalStat = await fsp.stat(sourceFile);
      await fsp.writeFile(sourceFile, secondSource, "utf8");
      await fsp.utimes(sourceFile, originalStat.atime, originalStat.mtime);
      const changedStat = await fsp.stat(sourceFile);
      expect(changedStat.size).toBe(originalStat.size);
      expect(Math.abs(changedStat.mtimeMs - originalStat.mtimeMs)).toBeLessThan(3);

      const rebuiltIndex = await buildProjectIndex(root, { cache: "off" });
      const rebuiltModule = moduleForPath(rebuiltIndex, sourceFile);
      expect(rebuiltModule?.locals.some((local) => local.localName === "nextt")).toBe(true);
      expect(rebuiltModule?.locals.some((local) => local.localName === "first")).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

function projectSnapshotPathFor(root: string): string {
  return path.join(root, ".codegraph-cache", "index-v1", "project-index-snapshot.json");
}

async function readProjectSnapshot(snapshotPath: string): Promise<Record<string, unknown>> {
  const raw = await fsp.readFile(snapshotPath);
  return JSON.parse(brotliDecompressSync(raw).toString("utf8")) as Record<string, unknown>;
}

async function writeProjectSnapshot(snapshotPath: string, snapshot: unknown): Promise<void> {
  await fsp.writeFile(
    snapshotPath,
    brotliCompressSync(JSON.stringify(snapshot), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }),
  );
}
async function projectSnapshotTempNames(root: string): Promise<string[]> {
  const cacheDir = path.dirname(projectSnapshotPathFor(root));
  const snapshotName = path.basename(projectSnapshotPathFor(root));
  const prefix = `.${snapshotName}.`;
  const names = await fsp.readdir(cacheDir);
  return names.filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"));
}
async function rewriteProjectSnapshot(root: string, index: ProjectIndex): Promise<void> {
  const manifest = await readManifest(root);
  const entries = new Map(Object.entries(manifest.files));
  await buildCache.writeProjectIndexSnapshot(
    root,
    { cache: "disk", threads: 1 },
    index,
    buildCache.projectSnapshotFilesSignature(entries),
  );
}

async function readManifest(root: string): Promise<IndexManifest> {
  const manifestPath = path.join(root, ".codegraph-cache", "index-v1", "manifest.json");
  const raw = await fsp.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as IndexManifest;
  const files: Record<string, (typeof manifest.files)[string]> = {};
  for (const [file, entry] of Object.entries(manifest.files)) {
    const absoluteFile = normalize(path.resolve(root, file));
    const hydratedEdges = entry.edges?.map((edge) => ({
      ...edge,
      from: normalize(path.resolve(root, edge.from)),
      to: edge.to.type === "file" ? { ...edge.to, path: normalize(path.resolve(root, edge.to.path)) } : edge.to,
    }));
    files[absoluteFile] = hydratedEdges ? { ...entry, edges: hydratedEdges } : entry;
    Object.defineProperty(files, file, { value: files[absoluteFile], enumerable: false });
  }
  return { ...manifest, files };
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
    const mod1 = idx1.byFile.get(fileIdentityKey(utilFile))!;
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
    const mod2 = idx2.byFile.get(fileIdentityKey(utilFile))!;
    expect(mod2.locals.some((l) => l.localName === "b")).toBe(true);

    // Strict: should also invalidate and pick up 'b'
    const idx3 = await buildProjectIndex(root, {
      threads: 2,
      cache: "disk",
      cacheStrict: true,
    });
    const mod3 = idx3.byFile.get(fileIdentityKey(utilFile))!;
    expect(mod3.locals.some((l) => l.localName === "b")).toBe(true);
  });

  it("does not reuse a stale snapshot module or bloom filter when sig matches but cacheSig differs", async () => {
    const root = await mkTmpDir("dg-snapshot-cachesig-");
    const utilPath = path.join(root, "util.ts");
    const v1 = `export function a(){ return 1 }\n`;
    await fsp.writeFile(utilPath, v1, "utf8");

    // Non-strict, non-git: `sig` alone is the cheap `mtime:size` form, so this scenario is
    // exactly the one where the snapshot/bloom fast paths must fall back to the stronger
    // content-hash-derived `cacheSig` rather than the weak `sig`.
    const idx1 = await buildProjectIndex(root, { threads: 1, cache: "disk", cacheStrict: false });
    const utilFile = Array.from(idx1.byFile.keys()).find((f) => f.endsWith("/util.ts") || f.endsWith("\\util.ts"))!;
    const persistedSignature = Array.from(idx1.manifestEntries ?? []).find(
      ([file]) => fileIdentityKey(file) === utilFile,
    )?.[1];
    if (!persistedSignature) throw new Error("Expected a persisted manifest entry for util.ts.");

    // A genuinely unchanged file (identical sig and cacheSig) must still be reused.
    const unchangedSnapshotModules = await buildCache.tryLoadProjectSnapshotModules(
      root,
      { cache: "disk", cacheStrict: false },
      new Map([[fileIdentityKey(utilFile), persistedSignature]]),
    );
    expect(unchangedSnapshotModules?.has(fileIdentityKey(utilFile))).toBe(true);

    // Simulate the reported collision directly (independent of filesystem mtime-write precision):
    // the OS reports the exact same `mtime:size` `sig` string as before, but the real content
    // (and therefore `cacheSig`) has changed.
    const v2 = `export function b(){ return 2 }\n`; // same length as v1
    await fsp.writeFile(utilPath, v2, "utf8");
    const realCurrentSignature = await buildCache.fileSignature(utilFile, false, undefined, { forceContentHash: true });
    expect(realCurrentSignature.cacheSig).not.toBe(persistedSignature.cacheSig);
    const collidingSignature = { ...realCurrentSignature, sig: persistedSignature.sig };

    const snapshotModules = await buildCache.tryLoadProjectSnapshotModules(
      root,
      { cache: "disk", cacheStrict: false },
      new Map([[fileIdentityKey(utilFile), collidingSignature]]),
    );
    expect(snapshotModules?.has(fileIdentityKey(utilFile))).toBe(false);

    const persistedBloomFilters = await buildCache.tryLoadPersistedBloomFilters(root, {
      cache: "disk",
      cacheStrict: false,
    });
    expect(persistedBloomFilters?.get(utilFile, collidingSignature)).toBeUndefined();
  });

  it("resolves snapshot module reuse when the caller's fileSignatures map is keyed by a raw display path", async () => {
    const root = await mkTmpDir("dg-snapshot-display-path-");
    const utilPath = path.join(root, "util.ts").replace(/\\/g, "/");
    await fsp.writeFile(utilPath, "export function a(){ return 1 }\n", "utf8");

    const idx1 = await buildProjectIndex(root, { threads: 1, cache: "disk", cacheStrict: false });
    const utilFile = Array.from(idx1.byFile.keys()).find((f) => f.endsWith("/util.ts") || f.endsWith("\\util.ts"))!;
    const currentSignature = await buildCache.fileSignature(utilPath, false, undefined, { forceContentHash: true });

    // `prepareFileSignatures` (build-index.ts) keys its map by whatever raw display path each
    // file was discovered under, not `fileIdentityKey`. On a case-insensitive filesystem a
    // mixed-case root (as `mkTmpDir` produces on Windows) makes that key differ from the
    // lowercase `fileIdentityKey` form the snapshot module lookup uses internally.
    const snapshotModules = await buildCache.tryLoadProjectSnapshotModules(
      root,
      { cache: "disk", cacheStrict: false },
      new Map([[utilPath, currentSignature]]),
    );
    expect(snapshotModules?.has(fileIdentityKey(utilFile))).toBe(true);
  });

  it("preserves content-hash cacheSig for changed files' manifestEntries after an incremental build", async () => {
    const root = await mkTmpDir("dg-incremental-cachesig-");
    const filePath = path.join(root, "entry.ts");
    await fsp.writeFile(filePath, "export const value = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", cacheStrict: false, threads: 1 });

    // Non-git: a content change here is the exact scenario snapshotSignatureMatches relies on
    // cacheSig to distinguish from a same-mtime/size collision. Prove the incremental write path
    // actually persists that stronger identity instead of leaving it undefined.
    await fsp.writeFile(filePath, "export const value = 2;\n", "utf8");
    const incremental = await buildProjectIndexIncremental(root, { cache: "disk", cacheStrict: false, threads: 1 });

    const entry = Array.from(incremental.manifestEntries ?? []).find(
      ([file]) => fileIdentityKey(file) === fileIdentityKey(filePath),
    )?.[1];
    expect(entry?.cacheSig).toBeDefined();
    expect(entry?.cacheSig).toMatch(/^[a-f0-9]{40}$/);
  });

  it("rebuilds when the generated language-definition fingerprint changes without source changes", async () => {
    const root = await mkTmpDir("dg-implementation-fingerprint-");
    const entryPath = path.join(root, "entry.ts");
    const source = "export const fingerprinted = 1;\n";
    await fsp.writeFile(entryPath, source, "utf8");
    const file = normalize(path.resolve(entryPath));
    const typescript = getLanguageById("ts");
    if (!typescript) throw new Error("Expected TypeScript language definition.");
    const originalImportsQuery = typescript.graph.imports;

    clearImplementationFingerprintCache();
    try {
      await buildProjectIndex(root, { threads: 2, cache: "disk" });
      const initialSignature = readModuleCacheSignature(root, file);
      if (!initialSignature) throw new Error("Expected a cached module signature.");

      typescript.graph.imports = `${originalImportsQuery}\n`;
      clearImplementationFingerprintCache();
      const report: BuildReport = { timings: {} };
      const rebuilt = await buildProjectIndexIncremental(root, {
        threads: 2,
        cache: "disk",
        report,
      });
      const rebuiltSignature = readModuleCacheSignature(root, file);

      expect(await fsp.readFile(entryPath, "utf8")).toBe(source);
      expect(rebuiltSignature).not.toBe(initialSignature);
      expect(report.manifest?.optionsMismatch).toContain("implementation");
      expect(report.files?.parsed).toBe(1);
      expect(moduleForPath(rebuilt, entryPath)?.locals.some((local) => local.localName === "fingerprinted")).toBe(true);
    } finally {
      typescript.graph.imports = originalImportsQuery;
      clearImplementationFingerprintCache();
    }
  });

  // Each mutation changes only the named definition field; source bytes stay fixed.
  // Values are chosen to flip the field's effective behavior (or, for hooks, to
  // introduce a behavior-neutral hook where none existed) so any fingerprint
  // change is attributable to descriptor coverage alone.
  const snapshotField = <K extends keyof LanguageDefinition>(
    definition: LanguageDefinition,
    field: K,
  ): (() => void) => {
    if (field in definition) {
      const value = definition[field];
      return () => {
        definition[field] = value;
      };
    }
    return () => {
      delete definition[field];
    };
  };

  const definitionFieldMutations: Array<{
    field: "scopeDeclarationNames" | "normalizeIdentifier" | "usesQueryDrivenLocals" | "membersAreImplicitlyInScope";
    apply: (definition: LanguageDefinition) => void;
  }> = [
    {
      field: "scopeDeclarationNames",
      apply: (definition) => {
        definition.scopeDeclarationNames = () => false;
      },
    },
    {
      field: "normalizeIdentifier",
      apply: (definition) => {
        definition.normalizeIdentifier = (name) => name;
      },
    },
    {
      field: "usesQueryDrivenLocals",
      apply: (definition) => {
        definition.usesQueryDrivenLocals = true;
      },
    },
    {
      field: "membersAreImplicitlyInScope",
      apply: (definition) => {
        definition.membersAreImplicitlyInScope = true;
      },
    },
  ];

  for (const { field, apply } of definitionFieldMutations) {
    it(`rebuilds when language-definition field ${field} changes without source changes`, async () => {
      const root = await mkTmpDir(`dg-implementation-fingerprint-${field}-`);
      const entryPath = path.join(root, "entry.ts");
      const source = "export const fingerprinted = 1;\n";
      await fsp.writeFile(entryPath, source, "utf8");
      const file = normalize(path.resolve(entryPath));
      const typescript = getLanguageById("ts");
      if (!typescript) throw new Error("Expected TypeScript language definition.");
      const restore = snapshotField(typescript, field);

      clearImplementationFingerprintCache();
      try {
        await buildProjectIndex(root, { threads: 2, cache: "disk" });
        const initialSignature = readModuleCacheSignature(root, file);
        if (!initialSignature) throw new Error("Expected a cached module signature.");

        apply(typescript);
        clearImplementationFingerprintCache();
        const report: BuildReport = { timings: {} };
        const rebuilt = await buildProjectIndexIncremental(root, {
          threads: 2,
          cache: "disk",
          report,
        });
        const rebuiltSignature = readModuleCacheSignature(root, file);

        expect(await fsp.readFile(entryPath, "utf8")).toBe(source);
        expect(rebuiltSignature).not.toBe(initialSignature);
        expect(report.manifest?.optionsMismatch).toContain("implementation");
        expect(report.files?.parsed).toBe(1);
        expect(moduleForPath(rebuilt, entryPath)?.locals.some((local) => local.localName === "fingerprinted")).toBe(
          true,
        );
      } finally {
        restore();
        clearImplementationFingerprintCache();
      }
    });
  }

  it("guards that every LanguageDefinition field is covered by the implementation fingerprint", () => {
    for (const definition of getAllLanguages()) {
      const uncovered = Object.keys(definition).filter((key) => !(key in languageDefinitionFingerprintCoverage));
      expect(uncovered, `${definition.id} carries definition fields without fingerprint coverage`).toEqual([]);
    }

    // Demonstrate the guard: a field added to a definition without descriptor
    // coverage is detected instead of silently outliving the on-disk index.
    const typescript = getLanguageById("ts");
    if (!typescript) throw new Error("Expected TypeScript language definition.");
    const probe = { ...typescript, someFutureSemanticField: true };
    const uncoveredInProbe = Object.keys(probe).filter((key) => !(key in languageDefinitionFingerprintCoverage));
    expect(uncoveredInProbe).toEqual(["someFutureSemanticField"]);
  });

  it("namespaces shared custom cache directories and rejects a manifest from another root", async () => {
    const parentRoot = await mkTmpDir("dg-cache-root-parent-");
    const childRoot = path.join(parentRoot, "child");
    const sharedCacheDir = await mkTmpDir("dg-cache-root-shared-");
    const outsidePath = path.join(parentRoot, "outside.ts");
    const childEntryPath = path.join(childRoot, "entry.ts");
    const options = { cache: "disk" as const, cacheDir: sharedCacheDir, threads: 2 };
    await fsp.mkdir(childRoot, { recursive: true });
    await fsp.writeFile(outsidePath, "export const outside = 1;\n", "utf8");
    await fsp.writeFile(childEntryPath, 'import { outside } from "../outside";\nexport { outside };\n', "utf8");

    const parentIndex = await buildProjectIndex(parentRoot, options);
    const parentCacheRoot = buildCache.cacheRoot(parentRoot, options);
    const childCacheRoot = buildCache.cacheRoot(childRoot, options);
    const parentManifest = await fsp.readFile(path.join(parentCacheRoot, "manifest.json"), "utf8");
    await fsp.mkdir(childCacheRoot, { recursive: true });
    await fsp.writeFile(path.join(childCacheRoot, "manifest.json"), parentManifest, "utf8");
    expect(await buildCache.loadManifest(childRoot, options)).not.toBeNull();

    expect(parentCacheRoot).not.toBe(childCacheRoot);
    expect(
      parentIndex.graph.edges.some(
        (edge) =>
          edge.from === normalize(childEntryPath) && edge.to.type === "file" && edge.to.path === normalize(outsidePath),
      ),
    ).toBe(true);

    const childIndex = await buildProjectIndex(childRoot, options);

    expect(
      childIndex.graph.edges.some((edge) => edge.to.type === "file" && edge.to.path === normalize(outsidePath)),
    ).toBe(false);
    expect(
      Array.from(childIndex.byFile.keys()).some((file) => fileIdentityKey(file) === fileIdentityKey(outsidePath)),
    ).toBe(false);
  });

  it("rejects and rebuilds a pre-implementation-fingerprint manifest", async () => {
    const root = await mkTmpDir("dg-cache-legacy-manifest-");
    const entryPath = path.join(root, "entry.ts");
    const file = normalize(path.resolve(entryPath));
    await fsp.writeFile(entryPath, "export const current = 1;\n", "utf8");
    await fsp.mkdir(path.dirname(manifestPathFor(root)), { recursive: true });
    await fsp.writeFile(
      manifestPathFor(root),
      JSON.stringify({
        version: 2,
        projectRoot: normalize(path.resolve(root)),
        updatedAt: Date.now(),
        graphOptions: {},
        buildOptions: { cache: "disk" },
        files: {
          [file]: {
            sig: "legacy-signature",
            edges: [
              {
                from: file,
                to: { type: "file", path: normalize(path.join(root, "stale.ts")) },
                raw: "./stale",
              },
            ],
          },
        },
      }),
      "utf8",
    );

    const rebuilt = await buildProjectIndexIncremental(root, { threads: 2, cache: "disk" });
    const manifest = await readManifest(root);
    expect(rebuilt.graph.edges.some((edge) => edge.to.type === "file" && edge.to.path.endsWith("/stale.ts"))).toBe(
      false,
    );
    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(manifest.buildOptions?.implementationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects and rewrites a project snapshot stored for another root", async () => {
    const root = await mkTmpDir("dg-cache-snapshot-root-");
    const entryPath = path.join(root, "entry.ts");
    await fsp.writeFile(entryPath, "export const rooted = 1;\n", "utf8");
    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const manifest = await readManifest(root);
    const snapshotPath = projectSnapshotPathFor(root);
    const snapshot = await readProjectSnapshot(snapshotPath);
    const otherRoot = await mkTmpDir("dg-cache-other-root-");
    snapshot.projectRoot = normalize(otherRoot);
    await writeProjectSnapshot(snapshotPath, snapshot);

    const entries = new Map(Object.entries(manifest.files));
    expect(await buildCache.tryLoadProjectIndexSnapshot(root, { cache: "disk" }, entries)).not.toBeNull();

    const rebuilt = await buildProjectIndexIncremental(root, { threads: 2, cache: "disk" });
    const rewritten = await readProjectSnapshot(snapshotPath);
    expect(moduleForPath(rebuilt, entryPath)?.locals.some((local) => local.localName === "rooted")).toBe(true);
    expect(rewritten.projectRoot).toBe(normalize(otherRoot));
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
    const modA = idxNoChange.byFile.get(fileIdentityKey(fileId))!;
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
    const modB = idxChanged.byFile.get(fileIdentityKey(fileId))!;
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
    expect(first.byFile.has(fileIdentityKey(normalizedUnitPath))).toBe(true);
    expect(first.byFile.has(fileIdentityKey(normalizedSamplePath))).toBe(false);

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
    expect(second.byFile.has(fileIdentityKey(normalizedUnitPath))).toBe(true);
    expect(second.byFile.has(fileIdentityKey(normalizedSamplePath))).toBe(true);
  });

  it("rediscovers newly supported files when language extensions change incrementally", async () => {
    const root = await mkTmpDir("dg-incremental-language-extension-discovery-");
    const mappedPath = path.join(root, "newly-supported.tpl");
    await fsp.writeFile(mappedPath, "<?php function newly_mapped() { return 1; }\n", "utf8");

    await buildProjectIndex(root, {
      cache: "disk",
      logLevel: "silent",
      threads: 1,
    });

    const afterMapping = await buildProjectIndexIncremental(root, {
      cache: "disk",
      languageExtensions: { ".tpl": "php" },
      logLevel: "silent",
      threads: 1,
    });

    expect(
      afterMapping.byFile.get(fileIdentityKey(normalize(mappedPath)))?.locals.map((local) => local.localName),
    ).toContain("newly_mapped");
  });

  it("recomputes manifest graph edges when a custom extension is remapped", async () => {
    const root = await mkTmpDir("dg-full-language-extension-graph-");
    const mappedPath = path.join(root, "entry.tpl");
    const dependencyPath = path.join(root, "dependency.ts");
    await fsp.writeFile(mappedPath, 'import "./dependency";\n', "utf8");
    await fsp.writeFile(dependencyPath, "export const dependency = 1;\n", "utf8");

    const htmlIndex = await buildProjectIndex(root, {
      cache: "disk",
      languageExtensions: { ".tpl": "html" },
      logLevel: "silent",
      threads: 1,
    });
    expect(htmlIndex.graph.edges.filter((edge) => edge.from === normalize(mappedPath))).toEqual([]);

    const tsIndex = await buildProjectIndex(root, {
      cache: "disk",
      languageExtensions: { ".tpl": "ts" },
      logLevel: "silent",
      threads: 1,
    });

    expect(tsIndex.graph.edges).toContainEqual({
      from: normalize(mappedPath),
      to: { type: "file", path: normalize(dependencyPath) },
      raw: "./dependency",
    });
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

    expect(index.byFile.has(fileIdentityKey(normalize(entry)))).toBe(true);
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

  it("rebuilds cross-file SQL edges when a custom-mapped SQL definition changes", async () => {
    const root = await mkTmpDir("dg-mapped-sql-corpus-cache-");
    const schemaPath = path.join(root, "schema.ddl");
    const reportPath = path.join(root, "report.sql");
    const schemaFile = normalize(path.resolve(schemaPath));
    const reportFile = normalize(path.resolve(reportPath));
    await fsp.writeFile(schemaPath, "CREATE TABLE users (id integer);\n", "utf8");
    await fsp.writeFile(reportPath, "SELECT id FROM users;\nSELECT id FROM accounts;\n", "utf8");

    const initial = await buildProjectIndex(root, {
      threads: 2,
      cache: "disk",
      languageExtensions: { ".ddl": "sql" },
    });

    expect(initial.graph.edges).toContainEqual(
      expect.objectContaining({
        from: reportFile,
        raw: "sql:reads_from:users",
        to: { type: "file", path: schemaFile },
      }),
    );

    await fsp.writeFile(schemaPath, "CREATE TABLE accounts (id integer, active boolean);\n", "utf8");
    const rebuilt = await buildProjectIndex(root, {
      threads: 2,
      cache: "disk",
      languageExtensions: { ".ddl": "sql" },
    });

    expect(rebuilt.graph.edges).not.toContainEqual(
      expect.objectContaining({
        from: reportFile,
        raw: "sql:reads_from:users",
        to: { type: "file", path: schemaFile },
      }),
    );
    expect(rebuilt.graph.edges).toContainEqual(
      expect.objectContaining({
        from: reportFile,
        raw: "sql:reads_from:accounts",
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

    const gitSig = (await getGitBlobHashes(root, [trackedPath])).get(normalize(trackedPath));
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

  it("returns git signatures for every file even past the Windows command-line argv limit", async () => {
    const root = await mkTmpDir("dg-git-sig-argv-limit-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "cache@test.local"]);
    runGit(root, ["config", "user.name", "Cache Test"]);

    // Windows caps a single process's command line around 32,767 characters. Passing one
    // argv entry per requested file used to fail the whole `git ls-files` call with
    // ENAMETOOLONG, silently discarding every git signature and falling back to full
    // content hashing for the entire project. A subdirectory name pads each relative path
    // enough that 700 files reliably crosses the threshold (~36,000 argv characters using
    // the old one-argument-per-file form) without needing thousands of files.
    const subdir = "padding-directory-for-argv-length-testing";
    await fsp.mkdir(path.join(root, subdir), { recursive: true });
    const fileCount = 700;
    const fileNames = Array.from({ length: fileCount }, (_, i) => `${subdir}/f${i}.ts`);
    // Sanity-check the fixture still exceeds Windows' ~32,767-character argv limit under the
    // old one-path-per-argv form, so a later shrink of fileCount/subdir cannot silently
    // stop exercising the bug (CI runs on Linux and would not otherwise notice).
    const WINDOWS_ARGV_LIMIT = 32_767;
    const estimatedOldArgvChars = "ls-files".length + 1 + fileNames.reduce((sum, name) => sum + 1 + name.length, 0);
    expect(estimatedOldArgvChars).toBeGreaterThan(WINDOWS_ARGV_LIMIT);
    await Promise.all(
      fileNames.map((name, i) => fsp.writeFile(path.join(root, name), `export const v${i} = ${i};\n`, "utf8")),
    );
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-m", "bulk"]);

    const filePaths = fileNames.map((name) => path.join(root, name));
    const hashes = await gitModule.getGitBlobHashes(root, filePaths);

    expect(hashes.size).toBe(fileCount);
    for (const filePath of filePaths) {
      const hash = hashes.get(normalize(filePath));
      expect(typeof hash).toBe("string");
      expect(hash?.length).toBe(40);
    }
    // Writing 700 files then running add/commit/hash-object is filesystem-bound, and a
    // Windows CI runner can exceed the 30s default. The assertions are deterministic; only
    // the wall clock is host-dependent, so give it headroom instead of letting it flake.
  }, 120_000);

  it("resolves git signatures when the project root is a repository subdirectory (C1)", async () => {
    const root = await mkTmpDir("dg-git-sig-subdir-root-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "cache@test.local"]);
    runGit(root, ["config", "user.name", "Cache Test"]);

    // `git hash-object --stdin-paths` resolves stdin paths against the repository root, not
    // the spawned cwd, unlike `git ls-files`. A project root that is a subdirectory of the
    // repo previously fed cwd-relative paths straight into that call, so every path failed
    // to open and the whole call silently discarded every git signature for the build.
    const subdirRoot = path.join(root, "src");
    await fsp.mkdir(subdirRoot, { recursive: true });
    const filePath = path.join(subdirRoot, "a.ts");
    await fsp.writeFile(filePath, "export const a = 1;\n", "utf8");
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-m", "init"]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hashes = await gitModule.getGitBlobHashes(subdirRoot, [filePath]);

      expect(hashes.size).toBe(1);
      const hash = hashes.get(normalize(filePath));
      expect(typeof hash).toBe("string");
      expect(hash?.length).toBe(40);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("Failed to read Git blob hashes"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns git signatures for tracked paths containing leading whitespace", async () => {
    const root = await mkTmpDir("dg-git-sig-special-paths-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "cache@test.local"]);
    runGit(root, ["config", "user.name", "Cache Test"]);

    const filePaths = [path.join(root, " leading-and-internal whitespace.ts"), path.join(root, "ordinary.ts")];
    await Promise.all(
      filePaths.map((file, index) => fsp.writeFile(file, `export const value${index} = ${index};\n`, "utf8")),
    );
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-m", "special paths"]);

    const hashes = await gitModule.getGitBlobHashes(root, filePaths);

    expect(hashes.size).toBe(filePaths.length);
    for (const filePath of filePaths) {
      expect(hashes.get(normalize(filePath))).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  // `hash-object --stdin-paths` newline-delimits its input, so it cannot represent a
  // pathname that itself contains a newline; this is the specific case the argv-based
  // implementation in `hashGitPaths` exists to support. NTFS rejects `\n` in filenames, so
  // this only runs on POSIX filesystems.
  it.skipIf(process.platform === "win32")(
    "returns a git signature for a tracked path containing a newline",
    async () => {
      const root = await mkTmpDir("dg-git-sig-newline-path-");
      runGit(root, ["init"]);
      runGit(root, ["config", "user.email", "cache@test.local"]);
      runGit(root, ["config", "user.name", "Cache Test"]);

      const filePath = path.join(root, "line1\nline2.ts");
      await fsp.writeFile(filePath, "export const value = 1;\n", "utf8");
      runGit(root, ["add", "-A"]);
      runGit(root, ["commit", "-m", "newline path"]);

      const hashes = await gitModule.getGitBlobHashes(root, [filePath]);

      expect(hashes.size).toBe(1);
      expect(hashes.get(normalize(filePath))).toMatch(/^[0-9a-f]{40}$/);
    },
  );

  it("surfaces a genuine git invocation failure instead of silently discarding signatures", async () => {
    const root = await mkTmpDir("dg-git-sig-invocation-failure-");
    // No `git init`: the directory is not a repository, so `git ls-files` genuinely fails
    // (non-zero exit), distinct from the caller-known "no git repo" case that already
    // short-circuits before any command runs. This exercises the catch block, which used
    // to return an empty Map with no signal at all.
    const scratchPath = path.join(root, "scratch.ts");
    await fsp.writeFile(scratchPath, "export const scratch = 1;\n", "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hashes = await gitModule.getGitBlobHashes(root, [scratchPath], { gitAvailable: true });

      expect(hashes.size).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("Failed to read Git blob hashes"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
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
    await fsp.writeFile(
      path.join(root, ".codegraph-cache", "index-v1", "stale.ts"),
      "export const stale = 1;\n",
      "utf8",
    );
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
    expect(idx.byFile.has(fileIdentityKey(normalize(ghostPath)))).toBe(true);

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

  it("rejects manifest edges outside the project before probing or reusing them", async () => {
    const root = await mkTmpDir("dg-manifest-edge-confinement-");
    const sourcePath = path.join(root, "source.ts");
    const dependencyPath = path.join(root, "dependency.ts");
    const outsideRoot = await mkTmpDir("dg-manifest-edge-outside-");
    const outsideSource = normalize(path.join(outsideRoot, "source.ts"));
    const outsideDependency = normalize(path.join(outsideRoot, "dependency.ts"));
    await fsp.writeFile(sourcePath, "import { value } from './dependency';\nexport { value };\n", "utf8");
    await fsp.writeFile(dependencyPath, "export const value = 1;\n", "utf8");
    await fsp.writeFile(outsideSource, "export const outsideSource = true;\n", "utf8");
    await fsp.writeFile(outsideDependency, "export const outsideDependency = true;\n", "utf8");

    await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const manifestPath = manifestPathFor(root);
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as IndexManifest;
    const sourceEntry = manifest.files["source.ts"];
    if (!sourceEntry?.edges.length) throw new Error("expected a persisted source edge");
    sourceEntry.edges[0] = {
      ...sourceEntry.edges[0],
      from: normalize(path.relative(root, outsideSource)),
      to: { type: "file", path: normalize(path.relative(root, outsideDependency)) },
    };
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const existsSpy = vi.spyOn(incrementalPlan, "pathExists");
    const accessSpy = vi.spyOn(fsp, "access");
    try {
      const rebuilt = await buildProjectIndexFromFiles(root, [sourcePath, dependencyPath], {
        cache: "disk",
        threads: 1,
      });

      expect(existsSpy).not.toHaveBeenCalledWith(outsideDependency);
      expect(accessSpy).not.toHaveBeenCalledWith(outsideDependency);
      expect(rebuilt.graph.edges).not.toContainEqual(
        expect.objectContaining({ from: outsideSource, to: { type: "file", path: outsideDependency } }),
      );
      expect(rebuilt.graph.edges).toContainEqual(
        expect.objectContaining({
          from: normalize(sourcePath),
          to: { type: "file", path: normalize(dependencyPath) },
        }),
      );
    } finally {
      existsSpy.mockRestore();
      accessSpy.mockRestore();
    }
  });

  it("loads unchanged incremental indexes from a project snapshot", async () => {
    const root = await mkTmpDir("dg-incremental-project-snapshot-");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(filePath, `export const snap = 1;\n`, "utf8");
    runGit(root, ["init"]);
    runGit(root, ["add", "foo.ts"]);
    runGit(root, ["commit", "-m", "initial"]);

    const initial = await buildProjectIndex(root, { threads: 2, cache: "disk" });
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
      const moduleIndex = incremental.byFile.get(fileIdentityKey(normalize(filePath)));
      expect(moduleIndex?.locals.some((local) => local.localName === "snap")).toBe(true);
      // Compare sig/gitSig identity only: `cacheSig` is an optional strengthening field whose
      // presence depends on which internal reuse path populated the entry (fresh computation
      // vs. disk-manifest-derived reuse), not a guarantee both builds must expose identically.
      const toIdentity = (entries: [string, { sig: string; gitSig?: string }][]) =>
        entries.map(([file, entry]) => [file, { sig: entry.sig, gitSig: entry.gitSig }]);
      expect(toIdentity([...(incremental.manifestEntries?.entries() ?? [])])).toEqual(
        toIdentity([...(initial.manifestEntries?.entries() ?? [])]),
      );
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
    const snapshot = (await readProjectSnapshot(snapshotPath)) as {
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
      const moduleIndex = incremental.byFile.get(fileIdentityKey(normalize(filePath)));
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
      expect(incremental.byFile.has(fileIdentityKey(normalize(firstPath)))).toBe(true);
      expect(incremental.byFile.has(fileIdentityKey(normalize(secondPath)))).toBe(true);
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
    const snapshot = await readProjectSnapshot(snapshotPath);
    snapshot.modules = [{}];
    await writeProjectSnapshot(snapshotPath, snapshot);

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    const moduleIndex = incremental.byFile.get(fileIdentityKey(normalize(filePath)));
    expect(moduleIndex?.locals.some((local) => local.localName === "snap")).toBe(true);
  });

  it("falls back when project snapshot symbol entries are malformed", async () => {
    const root = await mkTmpDir("dg-incremental-bad-project-snapshot-symbol-");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(filePath, `export const snap = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const snapshotPath = projectSnapshotPathFor(root);
    const snapshot = (await readProjectSnapshot(snapshotPath)) as {
      modules?: Array<{ locals?: unknown[] }>;
    };
    if (snapshot.modules?.[0]) snapshot.modules[0].locals = [{}];
    await writeProjectSnapshot(snapshotPath, snapshot);

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    const moduleIndex = incremental.byFile.get(fileIdentityKey(normalize(filePath)));
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
    const snapshot = (await readProjectSnapshot(snapshotPath)) as {
      modules?: Array<{ file?: string; imports?: unknown[]; exports?: unknown[] }>;
    };
    const moduleSnapshot = snapshot.modules?.find((moduleIndex) => moduleIndex.file === normalize(filePath));
    if (moduleSnapshot) {
      moduleSnapshot.imports = [{}];
      moduleSnapshot.exports = [{}];
    }
    await writeProjectSnapshot(snapshotPath, snapshot);

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    const moduleIndex = incremental.byFile.get(fileIdentityKey(normalize(filePath)));
    expect(moduleIndex?.locals.some((local) => local.localName === "snap")).toBe(true);
  });

  it("falls back when project snapshot metadata fields are malformed", async () => {
    const root = await mkTmpDir("dg-incremental-bad-project-snapshot-metadata-");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(filePath, `export const snap = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const snapshotPath = projectSnapshotPathFor(root);
    const snapshot = await readProjectSnapshot(snapshotPath);
    snapshot.projectRoot = 1;
    snapshot.nativeMode = "sometimes";
    snapshot.projectFiles = [{}];
    await writeProjectSnapshot(snapshotPath, snapshot);

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    const moduleIndex = incremental.byFile.get(fileIdentityKey(normalize(filePath)));
    expect(moduleIndex?.locals.some((local) => local.localName === "snap")).toBe(true);
  });

  it("falls back when project snapshot graph edges are malformed", async () => {
    const root = await mkTmpDir("dg-incremental-bad-project-snapshot-edge-");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(filePath, `export const snap = 1;\n`, "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const snapshotPath = projectSnapshotPathFor(root);
    const snapshot = await readProjectSnapshot(snapshotPath);
    snapshot.graph = { nodes: [normalize(filePath)], edges: [{ from: normalize(filePath), to: {} }] };
    await writeProjectSnapshot(snapshotPath, snapshot);

    const incremental = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    const moduleIndex = incremental.byFile.get(fileIdentityKey(normalize(filePath)));
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

    const mainModule = incremental.byFile.get(fileIdentityKey(normalizedMain));
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

      expect(incremental.byFile.has(fileIdentityKey(normalize(outsideFile)))).toBe(false);
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

    const nextModule = incremental.byFile.get(fileIdentityKey(normalize(nextPath)));
    expect(nextModule).toBeDefined();
    expect(nextModule?.locals.some((l) => l.localName === "next")).toBe(true);
  });

  it("parses an unchanged project snapshot once across repeated loads", async () => {
    const root = await mkTmpDir("dg-snapshot-parse-memo-");
    await fsp.writeFile(path.join(root, "main.ts"), "export const value = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const manifest = await readManifest(root);
    const entries = new Map(Object.entries(manifest.files));
    const snapshotPath = projectSnapshotPathFor(root);
    const snapshotBytes = await fsp.readFile(snapshotPath);
    await fsp.writeFile(snapshotPath, Buffer.concat([snapshotBytes, Buffer.from("\n")]));
    const originalReadFile = fsp.readFile.bind(fsp);
    let snapshotReads = 0;
    const readSpy = vi.spyOn(fsp, "readFile").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(snapshotPath)) snapshotReads++;
      return await originalReadFile(...args);
    });

    const first = await buildCache.tryLoadProjectIndexSnapshot(root, { cache: "disk" }, entries);
    const firstModule = first?.index.byFile.get(fileIdentityKey(normalize(path.join(root, "main.ts"))));
    if (!firstModule) throw new Error("Expected cached module.");
    firstModule.locals.length = 0;
    const second = await buildCache.tryLoadProjectIndexSnapshot(root, { cache: "disk" }, entries);
    const beforeRewrite = await fsp.stat(snapshotPath);
    const unchangedBytes = (await originalReadFile(snapshotPath)) as Buffer;
    await fsp.writeFile(snapshotPath, unchangedBytes);
    await fsp.utimes(snapshotPath, beforeRewrite.atime, beforeRewrite.mtime);
    const third = await buildCache.tryLoadProjectIndexSnapshot(root, { cache: "disk" }, entries);
    readSpy.mockRestore();

    expect(
      second?.index.byFile.get(fileIdentityKey(normalize(path.join(root, "main.ts"))))?.locals.length,
    ).toBeGreaterThan(0);
    expect(third?.index.byFile.size).toBe(1);
    expect(snapshotReads).toBe(2);
  });
  it("writes project snapshots atomically and cleans only stale temporary files", async () => {
    const root = await mkTmpDir("dg-snapshot-atomic-");
    const sourcePath = path.join(root, "main.ts");
    await fsp.writeFile(sourcePath, "export const value = 1;\n", "utf8");
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const snapshotPath = projectSnapshotPathFor(root);
    const initialSnapshot = await readProjectSnapshot(snapshotPath);
    expect(await projectSnapshotTempNames(root)).toEqual([]);

    index.graph.nodes.add(normalize(path.join(root, "rename-failure.ts")));
    const originalRename = fsp.rename.bind(fsp);
    const renameSpy = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(snapshotPath)) {
        throw new Error("simulated interrupted snapshot rename");
      }
      return await originalRename(from, to);
    });
    try {
      await rewriteProjectSnapshot(root, index);
    } finally {
      renameSpy.mockRestore();
    }
    expect(await readProjectSnapshot(snapshotPath)).toEqual(initialSnapshot);
    expect(await projectSnapshotTempNames(root)).toEqual([]);

    index.graph.nodes.add(normalize(path.join(root, "partial-write.ts")));
    let readableDuringPartialWrite = false;
    const originalWriteFile = fsp.writeFile.bind(fsp);
    const partialWriteSpy = vi.spyOn(fsp, "writeFile").mockImplementation(async (...args) => {
      const candidate = typeof args[0] === "string" ? args[0] : undefined;
      const snapshotPrefix = `.${path.basename(snapshotPath)}.`;
      if (!candidate || !path.basename(candidate).startsWith(snapshotPrefix)) {
        return await originalWriteFile(...args);
      }
      await originalWriteFile(candidate, Buffer.from("truncated snapshot"), { flag: "wx" });
      try {
        await readProjectSnapshot(snapshotPath);
        readableDuringPartialWrite = true;
      } catch {
        readableDuringPartialWrite = false;
      }
      throw new Error("simulated interrupted snapshot write");
    });
    try {
      await rewriteProjectSnapshot(root, index);
    } finally {
      partialWriteSpy.mockRestore();
    }
    expect(readableDuringPartialWrite).toBe(true);
    expect(await readProjectSnapshot(snapshotPath)).toEqual(initialSnapshot);
    expect(await projectSnapshotTempNames(root)).toEqual([]);

    const staleTempPath = path.join(
      path.dirname(snapshotPath),
      `.${path.basename(snapshotPath)}.123.00000000-0000-0000-0000-000000000001.tmp`,
    );
    const freshTempPath = path.join(
      path.dirname(snapshotPath),
      `.${path.basename(snapshotPath)}.456.00000000-0000-0000-0000-000000000002.tmp`,
    );
    await fsp.writeFile(staleTempPath, "stale", "utf8");
    const staleTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    await fsp.utimes(staleTempPath, staleTime, staleTime);
    await fsp.writeFile(freshTempPath, "active", "utf8");

    index.graph.nodes.add(normalize(path.join(root, "successful-write.ts")));
    await rewriteProjectSnapshot(root, index);

    await expect(fsp.stat(staleTempPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.readFile(freshTempPath, "utf8")).resolves.toBe("active");
    expect(await projectSnapshotTempNames(root)).toEqual([path.basename(freshTempPath)]);
    const finalSnapshot = await readProjectSnapshot(snapshotPath);
    expect(finalSnapshot.graph).not.toEqual(initialSnapshot.graph);
  });

  it("does not read unchanged tracked source files for partial cache validation", async () => {
    const root = await mkTmpDir("dg-git-signature-reuse-");
    const unchangedPath = path.join(root, "unchanged.ts");
    const changedPath = path.join(root, "changed.ts");
    await fsp.writeFile(unchangedPath, "export const unchanged = 1;\n", "utf8");
    await fsp.writeFile(changedPath, "export const changed = 1;\n", "utf8");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);
    await buildProjectIndex(root, { cache: "disk", cacheStrict: false, threads: 1, useBloomFilters: false });
    await fsp.writeFile(changedPath, "export const changed = 2;\n", "utf8");
    const originalReadFile = fsp.readFile.bind(fsp);
    let unchangedReads = 0;
    const readSpy = vi.spyOn(fsp, "readFile").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(unchangedPath)) unchangedReads++;
      return await originalReadFile(...args);
    });

    await buildProjectIndexIncremental(root, {
      cache: "disk",
      cacheStrict: false,
      threads: 1,
      useBloomFilters: false,
    });
    readSpy.mockRestore();

    expect(unchangedReads).toBe(0);
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
    const bloomSidecarPath = path.join(root, ".codegraph-cache", "index-v1", "bloom-filters.json");
    expect(await fsp.stat(bloomSidecarPath)).toBeTruthy();
    await fsp.rm(bloomSidecarPath);

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

  it("rejects version 3 bloom sidecars instead of reusing their filters", async () => {
    const root = await mkTmpDir("dg-stale-bloom-version-");
    const alphaPath = path.join(root, "alpha.ts");
    const triggerPath = path.join(root, "trigger.ts");
    await fsp.writeFile(alphaPath, "export const alphaValue = 1;\n", "utf8");
    await fsp.writeFile(triggerPath, "export const triggerValue = 1;\n", "utf8");
    await buildProjectIndex(root, { threads: 1, cache: "disk", useBloomFilters: true });

    const sidecarPath = path.join(root, ".codegraph-cache", "index-v1", "bloom-filters.json");
    const staleSidecar = await readProjectSnapshot(sidecarPath);
    staleSidecar.version = 3;
    await writeProjectSnapshot(sidecarPath, staleSidecar);

    const snapshotPath = projectSnapshotPathFor(root);
    const projectSnapshot = await readProjectSnapshot(snapshotPath);
    delete projectSnapshot.bloomFilters;
    await writeProjectSnapshot(snapshotPath, projectSnapshot);

    await fsp.writeFile(triggerPath, "export const triggerValue = 2;\n", "utf8");
    const bloomSpy = vi.spyOn(buildCache, "buildBloomFilterForFile");
    const incremental = await buildProjectIndexIncremental(root, {
      threads: 1,
      cache: "disk",
      useBloomFilters: true,
    });

    expect(bloomSpy).toHaveBeenCalled();
    expect(incremental.bloomFilters?.get(normalize(alphaPath))?.mightContain("alphaValue")).toBe(true);
    bloomSpy.mockRestore();
  });
  it("rejects stale snapshot modules after the manifest has advanced", async () => {
    const root = await mkTmpDir("dg-stale-snapshot-modules-");
    const entryPath = path.join(root, "entry.ts");
    await fsp.writeFile(entryPath, "export const staleSnapshotValue = 1;\n", "utf8");
    await buildProjectIndex(root, { threads: 1, cache: "disk", useBloomFilters: true });

    const snapshotPath = projectSnapshotPathFor(root);
    const staleSnapshot = await fsp.readFile(snapshotPath);
    await fsp.writeFile(entryPath, "export const currentSnapshotValue = 2;\n", "utf8");
    await buildProjectIndexIncremental(root, { threads: 1, cache: "disk", useBloomFilters: true });
    await fsp.writeFile(snapshotPath, staleSnapshot);

    const recovered = await buildProjectIndexIncremental(root, {
      threads: 1,
      cache: "disk",
      useBloomFilters: true,
    });
    const entry = recovered.byFile.get(fileIdentityKey(normalize(entryPath)));

    expect(entry?.locals.some((local) => local.localName === "currentSnapshotValue")).toBe(true);
    expect(entry?.locals.some((local) => local.localName === "staleSnapshotValue")).toBe(false);
  });

  it("rejects stale bloom sidecars and recovers semantic references", async () => {
    const root = await mkTmpDir("dg-stale-bloom-sidecar-");
    const definitionPath = path.join(root, "definition.ts");
    const consumerPath = path.join(root, "consumer.ts");
    const triggerPath = path.join(root, "trigger.ts");
    await fsp.writeFile(definitionPath, "export class Worker { staleBloomMethod() {} }\n", "utf8");
    await fsp.writeFile(
      consumerPath,
      'import { Worker } from "./definition";\nexport const consumer = new Worker().staleBloomMethod();\n',
      "utf8",
    );
    await fsp.writeFile(triggerPath, "export const trigger = 1;\n", "utf8");
    await buildProjectIndex(root, { threads: 1, cache: "disk", useBloomFilters: true });

    const snapshotPath = projectSnapshotPathFor(root);
    const sidecarPath = path.join(root, ".codegraph-cache", "index-v1", "bloom-filters.json");
    const staleSnapshot = await fsp.readFile(snapshotPath);
    const staleSidecar = await fsp.readFile(sidecarPath);
    await fsp.writeFile(definitionPath, "export class Worker { currentBloomMethod() {} }\n", "utf8");
    await fsp.writeFile(
      consumerPath,
      'import { Worker } from "./definition";\nexport const consumer = new Worker().currentBloomMethod();\n',
      "utf8",
    );
    await buildProjectIndexIncremental(root, { threads: 1, cache: "disk", useBloomFilters: true });
    await fsp.writeFile(snapshotPath, staleSnapshot);
    await fsp.writeFile(sidecarPath, staleSidecar);
    await fsp.writeFile(triggerPath, "export const trigger = 2;\n", "utf8");

    const recovered = await buildProjectIndexIncremental(root, {
      threads: 1,
      cache: "disk",
      useBloomFilters: true,
    });
    const definition = recovered.byFile
      .get(fileIdentityKey(normalize(definitionPath)))
      ?.locals.find((local) => local.localName === "currentBloomMethod");
    if (!definition) throw new Error("Expected current bloom definition");

    const references = await findReferences(recovered, { def: definition });

    expect(recovered.bloomFilters?.get(normalize(consumerPath))?.mightContain("currentBloomMethod")).toBe(true);
    expect(references.status).toBe("ok");
    if (references.status === "ok") {
      expect(references.references.some((reference) => normalize(reference.file) === normalize(consumerPath))).toBe(
        true,
      );
    }
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
      incremental.byFile
        .get(fileIdentityKey(normalize(entryPath)))
        ?.locals.some((local) => local.localName === "disabledBloom"),
    ).toBe(true);
    expect(incremental.bloomFilters).toBeUndefined();
  });

  it("rejects same-length invalid-base64 bloom payloads", async () => {
    const root = await mkTmpDir("dg-snapshot-bloom-malformed-");
    const entryPath = path.join(root, "entry.ts");
    await fsp.writeFile(entryPath, "export const guarded = 1;\n", "utf8");

    await buildProjectIndex(root, { threads: 2, cache: "disk", useBloomFilters: true });
    const snapshotPath = projectSnapshotPathFor(root);
    const snapshot = (await readProjectSnapshot(snapshotPath)) as {
      bloomFilters?: Record<string, { bitsBase64?: string }>;
    };
    const [key, original] = Object.entries(snapshot.bloomFilters ?? {})[0] ?? [];
    if (!key || !original?.bitsBase64) throw new Error("missing persisted bloom filter");
    snapshot.bloomFilters = {
      [key]: { ...original, bitsBase64: `!${original.bitsBase64.slice(1)}` },
    };
    await writeProjectSnapshot(snapshotPath, snapshot);

    const rebuilt = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      useBloomFilters: true,
    });

    expect(
      rebuilt.byFile.get(fileIdentityKey(normalize(entryPath)))?.locals.some((local) => local.localName === "guarded"),
    ).toBe(true);
    expect(rebuilt.bloomFilters?.get(normalize(entryPath))?.mightContain("guarded")).toBe(true);
  });

  it("falls back from older project snapshot versions and rewrites the current schema", async () => {
    const root = await mkTmpDir("dg-snapshot-version-upgrade-");
    const entryPath = path.join(root, "entry.ts");
    await fsp.writeFile(entryPath, "export const versioned = 1;\n", "utf8");

    const initial = await buildProjectIndex(root, { threads: 2, cache: "disk", useBloomFilters: true });
    const snapshotPath = projectSnapshotPathFor(root);
    const originalSnapshot = (await readProjectSnapshot(snapshotPath)) as {
      version: number;
      filesSignature: string;
      graph: unknown;
      modules: unknown;
      projectRoot?: string;
      nativeMode?: string;
      projectFiles?: unknown;
    };

    await writeProjectSnapshot(snapshotPath, {
      version: 1,
      filesSignature: originalSnapshot.filesSignature,
      graph: originalSnapshot.graph,
      modules: originalSnapshot.modules,
      ...(originalSnapshot.projectRoot ? { projectRoot: originalSnapshot.projectRoot } : {}),
      ...(originalSnapshot.nativeMode ? { nativeMode: originalSnapshot.nativeMode } : {}),
      ...(originalSnapshot.projectFiles ? { projectFiles: originalSnapshot.projectFiles } : {}),
    });

    const rebuilt = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
      useBloomFilters: true,
    });
    const rewrittenSnapshot = (await readProjectSnapshot(snapshotPath)) as {
      version: number;
      bloomFilters?: Record<string, unknown>;
      nativeRuntimeFingerprint?: string;
      implementationFingerprint?: string;
    };
    expect(rewrittenSnapshot.version).toBe(9);
    expect(initial.byFile.has(fileIdentityKey(normalize(entryPath)))).toBe(true);
    expect(rebuilt.byFile.has(fileIdentityKey(normalize(entryPath)))).toBe(true);
    expect(rebuilt.bloomFilters?.get(normalize(entryPath))?.mightContain("versioned")).toBe(true);
    expect(rewrittenSnapshot.nativeRuntimeFingerprint).toBeTypeOf("string");
    expect(rewrittenSnapshot.implementationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(rewrittenSnapshot.bloomFilters?.["entry.ts"]).toBeDefined();
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
    const mainModule = rebuilt.byFile.get(fileIdentityKey(normalize(main)));
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
      await loadNearestTsconfigFor(sourceFile, root);
      await loadWorkspaceConfig(root);

      clearImportResolutionCaches();

      await loadNearestTsconfigFor(sourceFile, root);
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
    expect(initial.byFile.has(fileIdentityKey(normalize(generatedPath)))).toBe(true);

    await fsp.writeFile(path.join(root, ".gitignore"), "src/generated.ts\n", "utf8");

    const rebuilt = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: "disk",
    });

    expect(rebuilt.byFile.has(fileIdentityKey(normalize(trackedPath)))).toBe(true);
    expect(rebuilt.byFile.has(fileIdentityKey(normalize(generatedPath)))).toBe(false);
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

      expect(rebuilt.byFile.has(fileIdentityKey(normalize(trackedPath)))).toBe(true);
      expect(rebuilt.byFile.has(fileIdentityKey(normalize(freshPath)))).toBe(true);
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
    // Explicit cacheStrict:false writes non-strict `${mtimeMs}:${size}` signatures (no
    // trailing :hash). The untracked freshness gate must accept that form, not only the
    // strict `${mtimeMs}:${size}:${hash}` shape.
    await buildProjectIndex(root, { cache: "disk", cacheStrict: false });

    // `getGitBlobHashes` is only reached once the whole-snapshot fast path is skipped, and
    // (unlike `tryLoadFromCache`) it runs before the later full-validation pass can also
    // find nothing changed and short-circuit on its own -- so it is a reliable signal that
    // the *early* snapshot fast path, gated on untracked-file presence, was actually taken.
    const gitSigSpy = vi.spyOn(gitModule, "getGitBlobHashes");
    try {
      const rebuilt = await buildProjectIndexIncremental(root, { cache: "disk", cacheStrict: false });

      expect(gitSigSpy).not.toHaveBeenCalled();
      expect(rebuilt.byFile.has(fileIdentityKey(normalize(trackedPath)))).toBe(true);
      expect(rebuilt.byFile.has(fileIdentityKey(normalize(scratchPath)))).toBe(true);
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

    const scratchModule = rebuilt.byFile.get(fileIdentityKey(normalize(scratchPath)));
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

      expect(rebuilt.byFile.has(fileIdentityKey(normalize(trackedPath)))).toBe(true);
      expect(rebuilt.byFile.has(fileIdentityKey(normalize(stagedPath)))).toBe(true);
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

      expect(rebuilt.byFile.has(fileIdentityKey(normalize(trackedPath)))).toBe(true);
      expect(rebuilt.byFile.has(fileIdentityKey(normalize(freshPath)))).toBe(true);
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

    expect(manifest.symlinkDirectories).toContain("linked-core");
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
    expect(staleManifest.symlinkDirectories).toContain("linked-core");

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

    expect(rebuilt.byFile.has(fileIdentityKey(normalize(path.join(linkedPackage, "src", "index.ts"))))).toBe(true);
    const refreshedManifest = await readManifest(root);
    expect(refreshedManifest.symlinkDirectories).toContain("linked-core");
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
    expect(rebuilt.byFile.has(fileIdentityKey(normalize(path.join(root, "a.ts"))))).toBe(true);

    const backfilledManifest = await readManifest(root);
    expect(backfilledManifest.symlinkDirectories).toEqual([]);
    expect(backfilledManifest.transientFiles).toEqual([]);
  });
  it("reuses relative caches after moving a project tree", async () => {
    const sourceRoot = await mkTmpDir("dg-cache-move-source-");
    const movedRoot = `${sourceRoot}-moved`;
    await fsp.writeFile(path.join(sourceRoot, "dependency.ts"), "export const dependency = 1;\n", "utf8");
    await fsp.writeFile(path.join(sourceRoot, "entry.ts"), "export { dependency } from './dependency';\n", "utf8");
    await buildProjectIndex(sourceRoot, { cache: "disk", threads: 1 });
    const snapshot = (await readProjectSnapshot(projectSnapshotPathFor(sourceRoot))) as {
      version?: number;
      modules?: Array<{ file?: string; exports?: Array<{ type?: string; fromModule?: string }> }>;
    };
    const entryModule = snapshot.modules?.find((module) => module.file === "entry.ts");
    const reexport = entryModule?.exports?.find((entry) => entry.type === "reexport");
    if (!reexport) throw new Error("expected persisted reexport");
    snapshot.version = 5;
    reexport.fromModule = normalize(path.join(sourceRoot, "dependency.ts"));
    await writeProjectSnapshot(projectSnapshotPathFor(sourceRoot), snapshot);
    await fsp.rename(sourceRoot, movedRoot);

    const report: BuildReport = { timings: {} };
    const moved = await buildProjectIndexIncremental(movedRoot, { cache: "disk", threads: 1, report });
    expect(moved.byFile.has(fileIdentityKey(normalize(path.join(movedRoot, "entry.ts"))))).toBe(true);
    const resolved = resolveExport(moved, normalize(path.join(movedRoot, "entry.ts")), "dependency");
    expect(resolved?.kind).toBe("resolved");
    if (resolved?.kind === "resolved") {
      expect(resolved.def.file).toBe(normalize(path.join(movedRoot, "dependency.ts")));
    }
    expect(report.cache?.misses ?? 0).toBe(0);
    expect(report.files?.cached).toBeGreaterThan(0);
  });

  it("reuses cached graph edges (not just modules) after moving a project tree", async () => {
    const sourceRoot = await mkTmpDir("dg-cache-move-edges-source-");
    const movedRoot = `${sourceRoot}-moved`;
    await fsp.writeFile(path.join(sourceRoot, "dependency.ts"), "export const dependency = 1;\n", "utf8");
    await fsp.writeFile(path.join(sourceRoot, "entry.ts"), "export { dependency } from './dependency';\n", "utf8");
    await buildProjectIndex(sourceRoot, { cache: "disk", threads: 1 });
    await fsp.rename(sourceRoot, movedRoot);

    // A stale `manifest.projectRoot` (left pointing at the pre-move root after rebasing entries)
    // makes `collectEdgesForFile`'s `cachedFileEdgesProjectRoot` check reject every cached edge,
    // forcing every unchanged file back through source parsing on the very next rebuild.
    const prepSpy = vi.spyOn(filePrep, "prepareSourceInput");
    try {
      const moved = await buildProjectIndex(movedRoot, { cache: "disk", threads: 1 });
      expect(moved.byFile.has(fileIdentityKey(normalize(path.join(movedRoot, "entry.ts"))))).toBe(true);
      expect(prepSpy).not.toHaveBeenCalled();
    } finally {
      prepSpy.mockRestore();
    }
  });

  it("reuses symlink directory hints after moving a project tree", async () => {
    const sourceRoot = await mkTmpDir("dg-cache-move-symlink-source-");
    const movedRoot = `${sourceRoot}-moved`;
    const sourcePackage = path.join(sourceRoot, "packages", "core");
    const sourceLink = path.join(sourceRoot, "linked-core");
    await fsp.mkdir(sourcePackage, { recursive: true });
    await fsp.writeFile(path.join(sourcePackage, "entry.ts"), "export const entry = 1;\n", "utf8");

    try {
      await fsp.symlink(sourcePackage, sourceLink, "junction");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await buildProjectIndex(sourceRoot, { cache: "disk", threads: 1 });
    const persisted = await readManifest(sourceRoot);
    expect(persisted.symlinkDirectories).toEqual(["linked-core"]);

    await fsp.rename(sourceRoot, movedRoot);
    const movedPackage = path.join(movedRoot, "packages", "core");
    const movedLink = path.join(movedRoot, "linked-core");
    await fsp.rm(movedLink, { recursive: true, force: true });
    await fsp.symlink(movedPackage, movedLink, "junction");

    const report: BuildReport = { timings: {} };
    const moved = await buildProjectIndexIncremental(movedRoot, { cache: "disk", threads: 1, report });

    expect(moved.byFile.has(fileIdentityKey(normalize(path.join(movedLink, "entry.ts"))))).toBe(true);
    expect(report.cache?.misses ?? 0).toBe(0);
    expect(report.files?.cached).toBeGreaterThan(0);
  });

  it("namespaces cache roots under repository anchors and accepts a git file", async () => {
    const repoRoot = await mkTmpDir("dg-cache-anchor-repo-");
    const projectRoot = path.join(repoRoot, "packages", "app");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.writeFile(path.join(repoRoot, ".git"), "gitdir: external\n", "utf8");
    await fsp.writeFile(path.join(projectRoot, "entry.ts"), "export const entry = 1;\n", "utf8");
    const cachePath = buildCache.cacheRoot(projectRoot, { cache: "disk" });
    const siblingRoot = path.join(repoRoot, "packages", "other");
    await fsp.mkdir(siblingRoot, { recursive: true });
    const siblingCachePath = buildCache.cacheRoot(siblingRoot, { cache: "disk" });
    expect(cachePath).not.toBe(path.join(projectRoot, ".codegraph-cache", "index-v1"));
    expect(cachePath).not.toBe(siblingCachePath);
  });

  it("reports the legacy in-project anchor and layer when reusing a legacy cache under a git anchor", async () => {
    const repoRoot = await mkTmpDir("dg-cache-legacy-anchor-repo-");
    const projectRoot = path.join(repoRoot, "packages", "app");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.writeFile(path.join(repoRoot, ".git"), "gitdir: external\n", "utf8");
    const legacyCachePath = path.join(projectRoot, ".codegraph-cache", "index-v1");
    await fsp.mkdir(legacyCachePath, { recursive: true });

    const resolution = buildCache.resolveCacheLocation(projectRoot, { cache: "disk" });

    expect(resolution.path).toBe(legacyCachePath);
    expect(fileIdentityKey(resolution.anchor)).toBe(fileIdentityKey(projectRoot));
    expect(resolution.layer).toBe("project");
  });

  it("keeps the repo-anchored cache namespace stable when the repository moves", async () => {
    const parent = await mkTmpDir("dg-cache-namespace-move-");
    const repoRoot = path.join(parent, "repo-a");
    const projectRoot = path.join(repoRoot, "packages", "app");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.writeFile(path.join(repoRoot, ".git"), "gitdir: external\n", "utf8");
    const before = buildCache.cacheRoot(projectRoot, { cache: "disk" });

    const movedRepoRoot = path.join(parent, "repo-a-renamed");
    await fsp.rename(repoRoot, movedRepoRoot);
    const movedProjectRoot = path.join(movedRepoRoot, "packages", "app");
    const after = buildCache.cacheRoot(movedProjectRoot, { cache: "disk" });

    expect(path.basename(after)).toBe(path.basename(before));
  });

  it("reports the environment cache anchor even when CODEGRAPH_CACHE_DIR does not exist yet", async () => {
    const root = await mkTmpDir("dg-cache-env-anchor-");
    await fsp.writeFile(path.join(root, "entry.ts"), "export const entry = 1;\n", "utf8");
    const envParent = await mkTmpDir("dg-cache-env-target-");
    const envTarget = path.join(envParent, "not-created-yet");
    vi.stubEnv("CODEGRAPH_CACHE_DIR", envTarget);
    try {
      const resolution = buildCache.resolveCacheLocation(root, { cache: "disk" });
      expect(fileIdentityKey(resolution.anchor)).toBe(fileIdentityKey(path.resolve(envTarget)));
      expect(resolution.layer).toBe("environment");
      expect(normalize(resolution.path).startsWith(normalize(path.resolve(envTarget)))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a cacheLocation that is not project/repo/user/absolute", async () => {
    const root = await mkTmpDir("dg-cache-invalid-location-");
    await fsp.writeFile(path.join(root, "entry.ts"), "export const entry = 1;\n", "utf8");
    expect(() => buildCache.resolveCacheLocation(root, { cacheLocation: "relative-dir" })).toThrow(
      /Cache location must be "project", "repo", "user", or an absolute path/,
    );
  });

  it("reuses a legacy v4 project snapshot missing fileSignatures instead of crashing to a forced miss", async () => {
    const root = await mkTmpDir("dg-cache-legacy-v4-");
    await fsp.writeFile(path.join(root, "entry.ts"), "export const entry = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const manifest = await readManifest(root);
    const entries = new Map(Object.entries(manifest.files));

    const snapshotPath = projectSnapshotPathFor(root);
    const snapshot = (await readProjectSnapshot(snapshotPath)) as Record<string, unknown>;
    delete snapshot.fileSignatures;
    delete snapshot.nativeMode;
    delete snapshot.projectFiles;
    delete snapshot.bloomFilters;
    snapshot.version = 4;
    await writeProjectSnapshot(snapshotPath, snapshot);

    // Previously, iterating the missing `fileSignatures` field during v4 migration threw and
    // was swallowed by the outer try/catch, forcing a cache miss even when the rest of the
    // migrated payload (fingerprints, files signature, graph) was otherwise still compatible.
    const loaded = await buildCache.tryLoadProjectIndexSnapshot(root, { cache: "disk" }, entries);
    expect(loaded).not.toBeNull();
    expect(loaded?.index.byFile.has(fileIdentityKey(normalize(path.join(root, "entry.ts"))))).toBe(true);

    const rebuilt = await buildProjectIndexIncremental(root, { threads: 2, cache: "disk" });
    expect(rebuilt.byFile.size).toBeGreaterThan(0);
  });

  it("reuses per-file modules and bloom filters after a project move even when a sibling file changed", async () => {
    const sourceRoot = await mkTmpDir("dg-cache-partial-move-source-");
    const movedRoot = `${sourceRoot}-moved`;
    await fsp.writeFile(path.join(sourceRoot, "unchanged.ts"), "export const unchanged = 1;\n", "utf8");
    await fsp.writeFile(path.join(sourceRoot, "entry.ts"), "export const entry = 1;\n", "utf8");
    await buildProjectIndex(sourceRoot, { cache: "disk", threads: 1 });
    await fsp.rename(sourceRoot, movedRoot);

    const bloomFilters = await buildCache.tryLoadPersistedBloomFilters(movedRoot, { cache: "disk" });
    expect(bloomFilters).not.toBeNull();

    await fsp.writeFile(path.join(movedRoot, "entry.ts"), "export const entry = 2;\n", "utf8");
    const report: BuildReport = { timings: {} };
    const rebuilt = await buildProjectIndexIncremental(movedRoot, { cache: "disk", threads: 1, report });

    expect(rebuilt.byFile.has(fileIdentityKey(normalize(path.join(movedRoot, "unchanged.ts"))))).toBe(true);
    expect(report.files?.cached).toBeGreaterThan(0);
    expect(report.cache?.misses ?? 0).toBeLessThanOrEqual(1);
  });

  it("resolves ProjectIndex.projectRoot to an absolute path even when a relative root is passed in", async () => {
    const root = await mkTmpDir("dg-cache-relative-root-");
    await fsp.writeFile(path.join(root, "entry.ts"), "export const entry = 1;\n", "utf8");
    const relativeRoot = path.relative(process.cwd(), root);

    const index = await buildProjectIndex(relativeRoot, { cache: "off", threads: 1 });

    expect(index.projectRoot).toBe(normalize(path.resolve(root)));
  });

  it("rebases legacy v3 absolute transientFiles from the stored root after a project move", async () => {
    const sourceRoot = await mkTmpDir("dg-manifest-transient-move-source-");
    const movedRoot = `${sourceRoot}-moved`;
    await fsp.writeFile(path.join(sourceRoot, "entry.ts"), "export const entry = 1;\n", "utf8");
    await fsp.writeFile(path.join(sourceRoot, ".gitignore"), "outside/\n", "utf8");
    const outsideFile = path.join(sourceRoot, "outside", "extra.ts");
    await fsp.mkdir(path.dirname(outsideFile), { recursive: true });
    await fsp.writeFile(outsideFile, "export const extra = 1;\n", "utf8");

    await buildProjectIndexIncremental(sourceRoot, { cache: "disk", threads: 1, additionalFiles: [outsideFile] });
    const manifestPath = manifestPathFor(sourceRoot);
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as {
      version: number;
      transientFiles?: string[];
    };
    expect(manifest.transientFiles).toEqual(["outside/extra.ts"]);
    // Simulate a genuine legacy v3 manifest, which persisted transientFiles as absolute paths.
    manifest.version = 3;
    manifest.transientFiles = [normalize(outsideFile)];
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    await fsp.rename(sourceRoot, movedRoot);
    const movedOutsideFile = path.join(movedRoot, "outside", "extra.ts");
    // Force a genuine content change so the incremental diff/manifest-rewrite path runs
    // instead of the whole-snapshot fast path (which leaves manifest.json untouched when
    // nothing changed and would otherwise mask this migration).
    await fsp.writeFile(path.join(movedRoot, "entry.ts"), "export const entry = 2;\n", "utf8");

    const rebuilt = await buildProjectIndexIncremental(movedRoot, {
      cache: "disk",
      threads: 1,
      additionalFiles: [movedOutsideFile],
    });

    expect(rebuilt.byFile.has(fileIdentityKey(normalize(movedOutsideFile)))).toBe(true);
    const rebuiltManifest = JSON.parse(await fsp.readFile(manifestPathFor(movedRoot), "utf8")) as {
      version: number;
      transientFiles?: string[];
    };
    expect(rebuiltManifest.version).toBe(MANIFEST_VERSION);
    expect(rebuiltManifest.transientFiles).toEqual(["outside/extra.ts"]);
  });
});
