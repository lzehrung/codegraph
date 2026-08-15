import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { buildProjectIndex } from "../src/index.js";
import { fileIdentityKey } from "../src/util/paths.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Incremental cache modes", () => {
  const normalize = (p: string) => p.replace(/\\/g, "/");
  const diskCacheDbPathFor = (projectRoot: string): string =>
    path.join(projectRoot, ".codegraph-cache", "index-v1", "index-cache.sqlite");

  const readDiskCacheRow = (
    projectRoot: string,
    file: string,
  ): { sig: string; version: number; payload: Uint8Array; updated_at: number } | null => {
    const dbPath = diskCacheDbPathFor(projectRoot);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT sig, version, payload, updated_at FROM module_cache WHERE file = ?").get(file) as
        | { sig: string; version: number; payload: Uint8Array; updated_at: number }
        | undefined;
      return row ?? null;
    } finally {
      db.close();
    }
  };

  it("memory cache avoids recomputation on second run", async () => {
    const root = await mkTmpDir("dg-cache-mem-");
    const util = `export function a(){return 1}`;
    const utilPath = path.join(root, "util.ts");
    await fsp.writeFile(utilPath, util, "utf8");

    const first = await buildProjectIndex(root, { threads: 4, cache: "memory" });
    const second = await buildProjectIndex(root, { threads: 4, cache: "memory" });

    expect(first.byFile.size).toBeGreaterThan(0);
    expect(second.byFile.size).toBe(first.byFile.size);

    const fileId = fileIdentityKey(path.resolve(utilPath));
    const firstMod = first.byFile.get(fileId);
    const secondMod = second.byFile.get(fileId);
    expect(firstMod).toBeDefined();
    expect(secondMod).toBeDefined();
    // Memory cache should reuse the same ModuleIndex object instance.
    expect(secondMod).toBe(firstMod);

    // Memory cache should not create per-file module cache files on disk.
    const dbPath = diskCacheDbPathFor(root);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("disk cache persists across runs in the same directory", async () => {
    const root = await mkTmpDir("dg-cache-disk-");
    const util = `export function a(){return 1}`;
    const utilPath = path.join(root, "util.ts");
    await fsp.writeFile(utilPath, util, "utf8");
    const first = await buildProjectIndex(root, { threads: 2, cache: "disk" });
    const absoluteFile = normalize(path.resolve(utilPath));
    const storedFile = "util.ts";
    const dbPath = diskCacheDbPathFor(root);
    expect(first.byFile.size).toBeGreaterThan(0);
    expect(fs.existsSync(dbPath)).toBe(true);

    const row = readDiskCacheRow(root, storedFile);
    expect(row).not.toBeNull();
    expect(row?.version).toBe(4);
    expect(typeof row?.sig).toBe("string");
    const payload = JSON.parse(row?.payload ? brotliDecompressSync(row.payload).toString("utf8") : "null") as unknown;
    expect(typeof payload).toBe("object");
    expect(payload).not.toBeNull();
    if (payload && typeof payload === "object" && "file" in payload) {
      expect(payload.file).toBe(storedFile);
    }

    // Build again; should hit disk cache file and resolve its relative key.
    const second = await buildProjectIndex(root, { threads: 2, cache: "disk" });
    expect(second.byFile.size).toBe(first.byFile.size);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(second.byFile.get(fileIdentityKey(absoluteFile))?.file).toBe(absoluteFile);
  });
});
