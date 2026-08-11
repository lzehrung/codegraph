import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { brotliDecompressSync } from "node:zlib";

import { buildProjectIndex, findDuplicates, type BuildReport } from "../src/index.js";
import { closeDuplicateUnitCacheDatabase } from "../src/duplicates.js";
import { SqliteDatabase } from "../src/sqlite-driver.js";
import { mkTmpDir } from "./helpers/filesystem.js";

function cacheDir(root: string): string {
  return path.join(root, ".codegraph-cache", "index-v1");
}

function moduleCacheDbPath(root: string): string {
  return path.join(cacheDir(root), "index-cache.sqlite");
}

function duplicateCacheDbPath(root: string): string {
  return path.join(cacheDir(root), "duplicate-unit-cache.sqlite");
}

function normalizePathForSql(file: string): string {
  return path.resolve(file).replace(/\\/g, "/");
}

function readSqliteMetadata(dbPath: string, key: string): string | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT value FROM cache_schema_metadata WHERE key = ?").get(key) as
      { value?: unknown } | undefined;
    return typeof row?.value === "string" ? row.value : undefined;
  } finally {
    db.close();
  }
}

function readTableColumns(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    return rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
  } finally {
    db.close();
  }
}

function readRowCount(dbPath: string, sql: string, param?: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const statement = db.prepare(sql);
    let row: { count?: unknown } | undefined;
    if (param === undefined) row = statement.get() as { count?: unknown } | undefined;
    else row = statement.get(param) as { count?: unknown } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  } finally {
    db.close();
  }
}

async function writeDuplicateProject(root: string): Promise<void> {
  const duplicateSource = `
export function normalizeInvoiceRows(rows: Array<{ amount: number; tax: number }>) {
  const totals: number[] = [];
  const labels: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    labels.push(label);
    totals.push(rounded);
  }
  const encoded = totals.map((value, index) => labels[index] + ":" + value.toFixed(2));
  return encoded.filter((value) => value.includes(":")).join(",");
}
`;
  await fsp.mkdir(path.join(root, "src"), { recursive: true });
  await fsp.writeFile(path.join(root, "src", "a.ts"), duplicateSource, "utf8");
  await fsp.writeFile(path.join(root, "src", "b.ts"), duplicateSource, "utf8");
}

describe("disk cache uses sqlite backend", () => {
  it("persists module cache in sqlite and reuses entries", async () => {
    const root = await mkTmpDir("dg-disk-cache-");
    await fsp.writeFile(path.join(root, "a.ts"), 'import { b } from "./b";\nexport const a = b + 1;\n', "utf8");
    await fsp.writeFile(path.join(root, "b.ts"), "export const b = 2;\n", "utf8");

    const report1: BuildReport = {};
    await buildProjectIndex(root, {
      cache: "disk",
      keepParsed: false,
      report: report1,
      threads: 1,
    });

    const report2: BuildReport = {};
    await buildProjectIndex(root, {
      cache: "disk",
      keepParsed: false,
      report: report2,
      threads: 1,
    });

    const entries = await fsp.readdir(cacheDir(root));

    expect(entries.includes("index-cache.sqlite")).toBe(true);
    const hashedJsonEntries = entries.filter((name) => /^[a-f0-9]{40}\.json$/.test(name));
    expect(hashedJsonEntries.length).toBe(0);
    expect((report2.cache?.hits ?? 0) > 0).toBe(true);
  });

  it("prepares module cache hot-path statements once per database", async () => {
    const root = await mkTmpDir("dg-disk-cache-prepared-");
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, "b.ts"), "export const b = 2;\n", "utf8");
    const prepareSpy = vi.spyOn(SqliteDatabase.prototype, "prepare");

    await buildProjectIndex(root, { cache: "disk", threads: 1 });

    const sql = prepareSpy.mock.calls.map(([statement]) => statement);
    prepareSpy.mockRestore();
    expect(
      sql.filter((statement) => statement.startsWith("SELECT sig, version, payload FROM module_cache")),
    ).toHaveLength(1);
    expect(sql.filter((statement) => statement.startsWith("INSERT INTO module_cache"))).toHaveLength(1);
  });

  it("prunes module cache rows for files outside the successful manifest", async () => {
    const root = await mkTmpDir("dg-disk-cache-prune-");
    const retainedPath = path.join(root, "retained.ts");
    const deletedPath = path.join(root, "deleted.ts");
    await fsp.writeFile(retainedPath, "export const retained = 1;\n", "utf8");
    await fsp.writeFile(deletedPath, "export const deleted = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });

    await fsp.rm(deletedPath);
    await buildProjectIndex(root, { cache: "disk", threads: 1 });

    expect(
      readRowCount(
        moduleCacheDbPath(root),
        "SELECT COUNT(*) AS count FROM module_cache WHERE file = ?",
        normalizePathForSql(retainedPath),
      ),
    ).toBe(1);
    expect(
      readRowCount(
        moduleCacheDbPath(root),
        "SELECT COUNT(*) AS count FROM module_cache WHERE file = ?",
        normalizePathForSql(deletedPath),
      ),
    ).toBe(0);
  });

  it("preserves module cache rows when manifest persistence fails", async () => {
    const root = await mkTmpDir("dg-disk-cache-prune-failed-manifest-");
    const deletedPath = path.join(root, "deleted.ts");
    await fsp.writeFile(path.join(root, "retained.ts"), "export const retained = 1;\n", "utf8");
    await fsp.writeFile(deletedPath, "export const deleted = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });
    await fsp.rm(deletedPath);
    const renameSpy = vi
      .spyOn(fsp, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));

    await buildProjectIndex(root, { cache: "disk", threads: 1 });
    renameSpy.mockRestore();

    expect(
      readRowCount(
        moduleCacheDbPath(root),
        "SELECT COUNT(*) AS count FROM module_cache WHERE file = ?",
        normalizePathForSql(deletedPath),
      ),
    ).toBe(1);
  });

  it("migrates an older module cache sqlite schema", async () => {
    const root = await mkTmpDir("dg-disk-cache-old-module-");
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    await fsp.mkdir(cacheDir(root), { recursive: true });

    const db = new DatabaseSync(moduleCacheDbPath(root));
    db.exec(`
      CREATE TABLE module_cache (
        file TEXT PRIMARY KEY,
        sig TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    db.close();

    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const columns = readTableColumns(moduleCacheDbPath(root), "module_cache");

    expect(Array.from(index.modules.keys()).some((file) => file.endsWith("a.ts"))).toBe(true);
    expect(columns).toContain("updated_at");
    expect(readSqliteMetadata(moduleCacheDbPath(root), "module_cache.schema_version")).toBe("1");
  });

  it("rebuilds the module cache table when schema metadata is corrupt", async () => {
    const root = await mkTmpDir("dg-disk-cache-corrupt-module-");
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    await fsp.mkdir(cacheDir(root), { recursive: true });

    const db = new DatabaseSync(moduleCacheDbPath(root));
    db.exec(`
      CREATE TABLE cache_schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO cache_schema_metadata (key, value) VALUES ('module_cache.schema_version', 'not-a-number');
      CREATE TABLE module_cache (
        file TEXT PRIMARY KEY
      );
      INSERT INTO module_cache (file) VALUES ('stale.ts');
    `);
    db.close();

    await buildProjectIndex(root, { cache: "disk", threads: 1 });

    expect(readSqliteMetadata(moduleCacheDbPath(root), "module_cache.schema_version")).toBe("1");
    expect(
      readRowCount(moduleCacheDbPath(root), "SELECT COUNT(*) AS count FROM module_cache WHERE file = ?", "stale.ts"),
    ).toBe(0);
    expect(readTableColumns(moduleCacheDbPath(root), "module_cache")).toContain("updated_at");
  });

  it("migrates an older duplicate unit cache sqlite schema", async () => {
    const root = await mkTmpDir("dg-disk-cache-old-duplicates-");
    await writeDuplicateProject(root);
    await fsp.mkdir(cacheDir(root), { recursive: true });

    const db = new DatabaseSync(duplicateCacheDbPath(root));
    db.exec(`
      CREATE TABLE duplicate_unit_cache (
        file TEXT NOT NULL,
        variant TEXT NOT NULL,
        sig TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (file, variant)
      );
    `);
    db.close();

    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const result = await findDuplicates(index, { minConfidence: "high", limit: 5 });
    const columns = readTableColumns(duplicateCacheDbPath(root), "duplicate_unit_cache");

    expect(result.groups.length).toBeGreaterThan(0);
    expect(columns).toContain("updated_at");
    expect(readSqliteMetadata(duplicateCacheDbPath(root), "duplicate_unit_cache.schema_version")).toBe("1");
  });

  it("rebuilds the duplicate unit cache table when schema metadata is corrupt", async () => {
    const root = await mkTmpDir("dg-disk-cache-corrupt-duplicates-");
    await writeDuplicateProject(root);
    await fsp.mkdir(cacheDir(root), { recursive: true });

    const db = new DatabaseSync(duplicateCacheDbPath(root));
    db.exec(`
      CREATE TABLE cache_schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO cache_schema_metadata (key, value) VALUES ('duplicate_unit_cache.schema_version', 'not-a-number');
      CREATE TABLE duplicate_unit_cache (
        file TEXT NOT NULL,
        variant TEXT NOT NULL,
        PRIMARY KEY (file, variant)
      );
      INSERT INTO duplicate_unit_cache (file, variant) VALUES ('stale.ts', 'stale');
    `);
    db.close();

    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const result = await findDuplicates(index, { minConfidence: "high", limit: 5 });

    expect(result.groups.length).toBeGreaterThan(0);
    expect(readSqliteMetadata(duplicateCacheDbPath(root), "duplicate_unit_cache.schema_version")).toBe("1");
    expect(
      readRowCount(
        duplicateCacheDbPath(root),
        "SELECT COUNT(*) AS count FROM duplicate_unit_cache WHERE file = ?",
        "stale.ts",
      ),
    ).toBe(0);
    expect(readTableColumns(duplicateCacheDbPath(root), "duplicate_unit_cache")).toContain("updated_at");
  });

  it("prepares duplicate cache hot-path statements once per analysis", async () => {
    const root = await mkTmpDir("dg-disk-cache-prepared-duplicates-");
    await writeDuplicateProject(root);
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const prepareSpy = vi.spyOn(SqliteDatabase.prototype, "prepare");

    await findDuplicates(index, { minConfidence: "high", limit: 5 });

    const sql = prepareSpy.mock.calls.map(([statement]) => statement);
    prepareSpy.mockRestore();
    expect(
      sql.filter((statement) => statement.startsWith("SELECT sig, version, payload FROM duplicate_unit_cache")),
    ).toHaveLength(1);
    expect(sql.filter((statement) => statement.startsWith("INSERT INTO duplicate_unit_cache"))).toHaveLength(1);
  });

  it("prunes expired duplicate cache variants when duplicate analysis opens the cache", async () => {
    const root = await mkTmpDir("dg-disk-cache-prune-duplicates-");
    await writeDuplicateProject(root);
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    await findDuplicates(index, { minConfidence: "high", limit: 5 });
    closeDuplicateUnitCacheDatabase(root);
    const db = new DatabaseSync(duplicateCacheDbPath(root));
    db.prepare(
      `INSERT INTO duplicate_unit_cache(file, variant, sig, version, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(normalizePathForSql(path.join(root, "src", "a.ts")), "expired", "old", 2, "[]", 0);
    db.close();

    const reopenedIndex = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    await findDuplicates(reopenedIndex, { minConfidence: "high", limit: 5 });

    expect(
      readRowCount(
        duplicateCacheDbPath(root),
        "SELECT COUNT(*) AS count FROM duplicate_unit_cache WHERE variant = ?",
        "expired",
      ),
    ).toBe(0);
  });

  it("enforces the duplicate cache row cap after analysis writes", async () => {
    const root = await mkTmpDir("dg-disk-cache-cap-duplicates-");
    await writeDuplicateProject(root);
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    await findDuplicates(index, { minConfidence: "high", limit: 5 });
    closeDuplicateUnitCacheDatabase(root);
    const db = new DatabaseSync(duplicateCacheDbPath(root));
    const insert = db.prepare(
      `INSERT INTO duplicate_unit_cache(file, variant, sig, version, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    db.exec("BEGIN");
    for (let row = 0; row < 5_001; row++) {
      insert.run(
        normalizePathForSql(path.join(root, "src", "a.ts")),
        `seed-${row}`,
        "current",
        2,
        "[]",
        Date.now() + row,
      );
    }
    db.exec("COMMIT");
    db.close();

    await findDuplicates(index, { minConfidence: "high", limit: 5 });

    expect(readRowCount(duplicateCacheDbPath(root), "SELECT COUNT(*) AS count FROM duplicate_unit_cache")).toBe(5_000);
    expect(
      readRowCount(
        duplicateCacheDbPath(root),
        "SELECT COUNT(*) AS count FROM duplicate_unit_cache WHERE variant = ?",
        "seed-5000",
      ),
    ).toBe(1);
  });

  it("compresses duplicate cache payloads and drops fields unused after construction", async () => {
    const root = await mkTmpDir("dg-disk-cache-compressed-duplicates-");
    await writeDuplicateProject(root);
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const result = await findDuplicates(index, { minConfidence: "high", limit: 5 });
    expect(result.groups.length).toBeGreaterThan(0);

    const db = new DatabaseSync(duplicateCacheDbPath(root));
    const row = db
      .prepare("SELECT version, payload FROM duplicate_unit_cache WHERE file = ?")
      .get(normalizePathForSql(path.join(root, "src", "a.ts"))) as { version: number; payload: Uint8Array } | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.version).toBe(3);
    const decompressed = brotliDecompressSync(row!.payload).toString("utf8");
    const units = JSON.parse(decompressed) as Array<Record<string, unknown>>;
    expect(units.length).toBeGreaterThan(0);
    expect(units[0]).not.toHaveProperty("text");
    expect(units[0]).not.toHaveProperty("normalizedTokens");
    expect(() => JSON.parse(Buffer.from(row!.payload).toString("utf8"))).toThrow();
  });

  it("ignores duplicate cache rows written by an older payload version", async () => {
    const root = await mkTmpDir("dg-disk-cache-stale-duplicates-");
    await writeDuplicateProject(root);
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    await findDuplicates(index, { minConfidence: "high", limit: 5 });
    closeDuplicateUnitCacheDatabase(root);

    const aFile = normalizePathForSql(path.join(root, "src", "a.ts"));
    const staleDb = new DatabaseSync(duplicateCacheDbPath(root));
    staleDb
      .prepare("UPDATE duplicate_unit_cache SET version = 2, payload = ? WHERE file = ?")
      .run('[{"text":"stale","normalizedTokens":["stale"]}]', aFile);
    staleDb.close();

    const reopenedIndex = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const result = await findDuplicates(reopenedIndex, { minConfidence: "high", limit: 5 });
    expect(result.groups.length).toBeGreaterThan(0);

    const after = new DatabaseSync(duplicateCacheDbPath(root));
    const row = after.prepare("SELECT version FROM duplicate_unit_cache WHERE file = ?").get(aFile) as
      { version: number } | undefined;
    after.close();
    expect(row?.version).toBe(3);
  });
});
