import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  clearMemoryCache,
  closeDiskCacheDatabase,
  diskModuleCacheExists,
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
