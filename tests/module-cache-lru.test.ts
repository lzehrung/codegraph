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
    closeDiskCacheDatabase(root, { cache: "disk" });
    clearMemoryCache();
  }
});
