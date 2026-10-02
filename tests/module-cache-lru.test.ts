import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import {
  cacheDatabasePath,
  cacheRelativePath,
  clearMemoryCache,
  closeDiskCacheDatabase,
  diskModuleCacheExists,
  memoryCacheEvictionSerial,
  memoryCacheLostPayloads,
  settleMemoryCacheEvictions,
  removeModulesFromCache,
  resetDiskModuleCacheSqliteStateForTests,
  transformPersistedExportFromModule,
  tryLoadFromCache,
  writeToCache,
} from "../src/indexer/build-cache/module-cache.js";
import { SqliteDatabase } from "../src/sqlite-driver.js";
import type { BuildReport, ModuleIndex } from "../src/indexer/types.js";
import { SymbolKind } from "../src/indexer/types.js";

function moduleFor(file: string, label: string): ModuleIndex {
  return {
    file,
    exports: [],
    imports: [],
    locals: [
      {
        file,
        localName: label,
        kind: SymbolKind.Variable,
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
      },
    ],
  };
}

function referenceWriteTransform(projectRoot: string, module: ModuleIndex): ModuleIndex {
  const copy = structuredClone(module);
  const transform = (file: string): string => cacheRelativePath(projectRoot, file);
  copy.file = transform(copy.file);
  for (const local of copy.locals) local.file = transform(local.file);
  for (const entry of copy.exports) {
    if (entry.type === "local") {
      entry.target.file = transform(entry.target.file);
    } else {
      transformPersistedExportFromModule(projectRoot, entry, true);
    }
  }
  for (const binding of copy.imports) {
    if (typeof binding.resolved === "string") binding.resolved = transform(binding.resolved);
  }
  return copy;
}

function readCachedPayload(projectRoot: string, file: string): ModuleIndex {
  const db = new DatabaseSync(cacheDatabasePath(projectRoot, { cache: "disk" }, "index-cache.sqlite"));
  try {
    const row = db
      .prepare("SELECT payload FROM module_cache WHERE file = ?")
      .get(cacheRelativePath(projectRoot, file)) as { payload: Uint8Array } | undefined;
    if (!row) throw new Error("Expected a persisted module cache row.");

    return JSON.parse(brotliDecompressSync(row.payload).toString("utf8")) as ModuleIndex;
  } finally {
    db.close();
  }
}

function pathFixture(root: string): ModuleIndex {
  const projectPath = (...parts: string[]): string => path.join(root, ...parts).replace(/\\/g, "/");
  const file = projectPath("src", "entry.ts");
  const dependency = projectPath("src", "dependency.ts");
  const namespace = projectPath("src", "namespace.ts");
  return {
    file,
    exports: [
      {
        type: "local",
        exportedAs: "entryValue",
        target: {
          file,
          localName: "entryValue",
          kind: SymbolKind.Variable,
          range: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
        },
      },
      {
        type: "reexport",
        exportedAs: "dependencyValue",
        fromModule: dependency,
        moduleSpecifier: "./dependency",
        sourceSpecifier: "./dependency",
      },
      {
        type: "reexport",
        exportedAs: "packageValue",
        fromModule: "package-name",
        moduleSpecifier: "package-name",
        sourceSpecifier: "package-name",
      },
      {
        type: "namespaceReexport",
        exportedAs: "namespace",
        fromModule: namespace,
        moduleSpecifier: "./namespace",
      },
    ],
    imports: [
      {
        kind: "default",
        local: "dependency",
        from: "./dependency",
        resolved: dependency,
      },
      {
        kind: "star",
        from: "package-name",
      },
    ],
    locals: [
      {
        file,
        localName: "entryValue",
        kind: SymbolKind.Variable,
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
      },
      {
        file: dependency,
        localName: "dependencyValue",
        kind: SymbolKind.Function,
        callable: { key: `${dependency}\0dependencyValue`, owner: "module", kind: "function", arity: null },
        range: { start: { line: 2, column: 0 }, end: { line: 3, column: 1 } },
      },
    ],
  };
}

describe("typed module cache path transforms", () => {
  it("matches the structured-clone reference and leaves the input unchanged", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cache-typed-transform-"));
    const module = pathFixture(root);
    const before = structuredClone(module);
    try {
      writeToCache(root, module.file, "sig-typed", module, { cache: "disk" });
      expect(module).toStrictEqual(before);

      closeDiskCacheDatabase(root, { cache: "disk" });
      expect(readCachedPayload(root, module.file)).toStrictEqual(referenceWriteTransform(root, module));
    } finally {
      closeDiskCacheDatabase(root, { cache: "disk" });
      clearMemoryCache();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("restores absolute paths through a disk-cache round trip", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cache-typed-round-trip-"));
    const module = pathFixture(root);
    try {
      writeToCache(root, module.file, "sig-round-trip", module, { cache: "disk" });
      closeDiskCacheDatabase(root, { cache: "disk" });

      const loaded = tryLoadFromCache(root, module.file, "sig-round-trip", { cache: "disk" });
      expect(loaded).toStrictEqual(module);
      expect(loaded?.file).toBe(module.file);
      expect(loaded?.imports[0]?.resolved).toBe(module.imports[0]?.resolved);
    } finally {
      closeDiskCacheDatabase(root, { cache: "disk" });
      clearMemoryCache();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a cached module path that escapes the project root", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cache-typed-confinement-"));
    const file = path.join(root, "entry.ts");
    try {
      writeToCache(root, file, "sig-escape", moduleFor(file, "entry"), { cache: "disk" });
      closeDiskCacheDatabase(root, { cache: "disk" });

      const db = new DatabaseSync(cacheDatabasePath(root, { cache: "disk" }, "index-cache.sqlite"));
      try {
        const maliciousModule: ModuleIndex = { file: "../outside.ts", exports: [], imports: [], locals: [] };
        const payload = brotliCompressSync(Buffer.from(JSON.stringify(maliciousModule)));
        db.prepare("UPDATE module_cache SET payload = ? WHERE file = ?").run(payload, cacheRelativePath(root, file));
      } finally {
        db.close();
      }

      expect(tryLoadFromCache(root, file, "sig-escape", { cache: "disk" })).toBeNull();
    } finally {
      closeDiskCacheDatabase(root, { cache: "disk" });
      clearMemoryCache();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("module memory cache bounds", () => {
  it("evicts oldest entries and clears on teardown", () => {
    const rootA = path.join(os.tmpdir(), "dg-cache-a");
    const rootB = path.join(os.tmpdir(), "dg-cache-b");
    const sig = "sig-1";

    for (let i = 0; i < 5001; i += 1) {
      writeToCache(rootA, `/files/a-${i}.ts`, sig, moduleFor(`/files/a-${i}.ts`, `a-${i}`), { cache: "memory" });
    }

    expect(tryLoadFromCache(rootA, "/files/a-0.ts", sig, { cache: "memory" })).toBeNull();
    expect(tryLoadFromCache(rootA, "/files/a-5000.ts", sig, { cache: "memory" })?.locals[0]?.localName).toBe("a-5000");

    writeToCache(rootB, "/files/b.ts", sig, moduleFor("/files/b.ts", "b"), { cache: "memory" });
    expect(tryLoadFromCache(rootB, "/files/b.ts", sig, { cache: "memory" })?.locals[0]?.localName).toBe("b");

    clearMemoryCache();
    expect(tryLoadFromCache(rootA, "/files/a-5000.ts", sig, { cache: "memory" })).toBeNull();
    expect(tryLoadFromCache(rootB, "/files/b.ts", sig, { cache: "memory" })).toBeNull();
  });

  it("deletes stale signature mismatches instead of refreshing them", () => {
    const root = path.join(os.tmpdir(), "dg-cache-stale-signature");
    clearMemoryCache();

    writeToCache(root, "/files/stale.ts", "old-sig", moduleFor("/files/stale.ts", "stale"), { cache: "memory" });
    for (let i = 0; i < 4999; i += 1) {
      const file = `/files/current-${i}.ts`;
      writeToCache(root, file, "sig", moduleFor(file, `current-${i}`), { cache: "memory" });
    }

    expect(tryLoadFromCache(root, "/files/stale.ts", "new-sig", { cache: "memory" })).toBeNull();
    writeToCache(root, "/files/extra.ts", "sig", moduleFor("/files/extra.ts", "extra"), { cache: "memory" });

    expect(tryLoadFromCache(root, "/files/stale.ts", "old-sig", { cache: "memory" })).toBeNull();
    expect(tryLoadFromCache(root, "/files/extra.ts", "sig", { cache: "memory" })?.locals[0]?.localName).toBe("extra");
    clearMemoryCache();
  });

  it("flags only the project whose payloads were evicted, and only once one is", () => {
    const root = path.join(os.tmpdir(), "dg-cache-evicted-root");
    const other = path.join(os.tmpdir(), "dg-cache-evicted-other");
    clearMemoryCache();
    try {
      writeToCache(other, "/files/o.ts", "sig", moduleFor("/files/o.ts", "o"), { cache: "memory" });
      for (let i = 0; i < 4999; i += 1) {
        writeToCache(root, `/files/a-${i}.ts`, "sig", moduleFor(`/files/a-${i}.ts`, `a-${i}`), { cache: "memory" });
      }
      // The cache holds exactly its capacity: nothing has been evicted yet.
      expect(memoryCacheLostPayloads(root)).toBe(false);
      // Rewriting a cached file replaces its row and evicts nothing.
      writeToCache(root, "/files/a-1.ts", "sig-2", moduleFor("/files/a-1.ts", "a-1"), { cache: "memory" });
      expect(memoryCacheLostPayloads(root)).toBe(false);
      writeToCache(root, "/files/extra.ts", "sig", moduleFor("/files/extra.ts", "extra"), { cache: "memory" });
      // The oldest payload belongs to `other`, so `other` lost a payload and `root` did not.
      expect(tryLoadFromCache(other, "/files/o.ts", "sig", { cache: "memory" })).toBeNull();
      expect(memoryCacheLostPayloads(other)).toBe(true);
      expect(memoryCacheLostPayloads(root)).toBe(false);
      writeToCache(root, "/files/extra-2.ts", "sig", moduleFor("/files/extra-2.ts", "extra-2"), { cache: "memory" });
      expect(memoryCacheLostPayloads(root)).toBe(true);
    } finally {
      clearMemoryCache();
    }
    expect(memoryCacheLostPayloads(root)).toBe(false);
    expect(memoryCacheLostPayloads(other)).toBe(false);
  });

  it("forgets lost payloads only when no eviction happened since the build started", () => {
    const root = path.join(os.tmpdir(), "dg-cache-settle-root");
    clearMemoryCache();
    try {
      const memory = { cache: "memory" as const };
      const fill = (label: string, count: number): void => {
        for (let i = 0; i < count; i += 1) {
          writeToCache(root, `/files/${label}-${i}.ts`, "sig", moduleFor(`/files/${label}-${i}.ts`, label), memory);
        }
      };
      fill("a", 5001);
      expect(memoryCacheLostPayloads(root)).toBe(true);

      // A build that started before another eviction cannot vouch for the missing row.
      const startedEarly = memoryCacheEvictionSerial();
      fill("b", 1);
      settleMemoryCacheEvictions(root, startedEarly);
      expect(memoryCacheLostPayloads(root)).toBe(true);

      // A build that started after the last eviction restored what it needs.
      settleMemoryCacheEvictions(root, memoryCacheEvictionSerial());
      expect(memoryCacheLostPayloads(root)).toBe(false);
    } finally {
      clearMemoryCache();
    }
  });

  it("retires removed rows", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cache-remove-"));
    clearMemoryCache();
    try {
      const memoryOpts = { cache: "memory" as const };
      writeToCache(root, "/files/keep.ts", "sig", moduleFor("/files/keep.ts", "keep"), memoryOpts);
      writeToCache(root, "/files/gone.ts", "sig", moduleFor("/files/gone.ts", "gone"), memoryOpts);
      removeModulesFromCache(root, ["/files/gone.ts"], memoryOpts);
      expect(tryLoadFromCache(root, "/files/gone.ts", "sig", memoryOpts)).toBeNull();
      expect(tryLoadFromCache(root, "/files/keep.ts", "sig", memoryOpts)).not.toBeNull();

      const diskOpts = { cache: "disk" as const };
      const kept = path.join(root, "kept.ts");
      const gone = path.join(root, "gone.ts");
      writeToCache(root, kept, "sig", moduleFor(kept, "kept"), diskOpts);
      writeToCache(root, gone, "sig", moduleFor(gone, "gone"), diskOpts);
      expect(tryLoadFromCache(root, gone, "sig", diskOpts)).not.toBeNull();
      removeModulesFromCache(root, [gone], diskOpts);
      expect(tryLoadFromCache(root, gone, "sig", diskOpts)).toBeNull();
      expect(tryLoadFromCache(root, kept, "sig", diskOpts)).not.toBeNull();
      // Removing an absent row is a no-op, and an empty list never touches SQLite.
      removeModulesFromCache(root, [path.join(root, "never.ts")], diskOpts);
      removeModulesFromCache(root, [], diskOpts);
    } finally {
      clearMemoryCache();
      closeDiskCacheDatabase(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("clears only the closed project from the memory cache", () => {
    const rootA = path.join(os.tmpdir(), "dg-cache-close-a");
    const rootB = path.join(os.tmpdir(), "dg-cache-close-b");
    const sig = "sig-2";

    writeToCache(rootA, "/files/a.ts", sig, moduleFor("/files/a.ts", "a"), { cache: "memory" });
    writeToCache(rootB, "/files/b.ts", sig, moduleFor("/files/b.ts", "b"), { cache: "memory" });

    closeDiskCacheDatabase(rootA);

    expect(tryLoadFromCache(rootA, "/files/a.ts", sig, { cache: "memory" })).toBeNull();
    expect(tryLoadFromCache(rootB, "/files/b.ts", sig, { cache: "memory" })?.locals[0]?.localName).toBe("b");
    clearMemoryCache();
  });
});
it("records a known-absent disk cache miss without creating SQLite", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cache-known-absent-"));
  const opts = { cache: "disk" as const };
  const report: BuildReport = { timings: {} };
  const databasePath = path.join(root, ".codegraph", "cache", "index-v1", "index-cache.sqlite");
  try {
    expect(diskModuleCacheExists(root, opts)).toBe(false);
    expect(tryLoadFromCache(root, path.join(root, "missing.ts"), "sig", opts, report, false)).toBeNull();
    expect(report.cache).toMatchObject({ mode: "disk", hits: 0, misses: 1 });
    await expect(fsp.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("degrades disk cache cleanly when node:sqlite lacks setReturnArrays", () => {
  const root = path.join(os.tmpdir(), "dg-cache-old-node-sqlite");
  const sig = "sig-disk";
  const prepare = vi.spyOn(SqliteDatabase.prototype, "prepare").mockImplementation(() => {
    throw new TypeError("this.statement.setReturnArrays is not a function");
  });

  try {
    expect(() =>
      writeToCache(root, "/files/disk.ts", sig, moduleFor("/files/disk.ts", "disk"), { cache: "disk" }),
    ).not.toThrow();
    expect(tryLoadFromCache(root, "/files/disk.ts", sig, { cache: "disk" })).toBeNull();
  } finally {
    prepare.mockRestore();
    resetDiskModuleCacheSqliteStateForTests();
    closeDiskCacheDatabase(root, { cache: "disk" });
    clearMemoryCache();
  }
});
