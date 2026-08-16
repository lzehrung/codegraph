import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

import { buildProjectIndex, findDuplicates, type BuildReport } from "../src/index.js";
import { closeDuplicateUnitCacheDatabase } from "../src/duplicates.js";
import {
  tryLoadDuplicateUnitsFromCache,
  writeDuplicateUnitsBatchToCache,
  writeDuplicateUnitsToCache,
} from "../src/duplicates/unitCache.js";
import { buildInternalUnit, formatDuplicateSqlHandle, formatDuplicateSymbolHandle } from "../src/duplicates/units.js";
import * as buildCache from "../src/indexer/build-cache.js";
import { SqliteDatabase, SqliteStatement } from "../src/sqlite-driver.js";
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

function normalizePathForSql(file: string, root?: string): string {
  return (root ? path.relative(root, file) : path.resolve(file)).replace(/\\/g, "/");
}

function readSqliteMetadata(dbPath: string, key: string): string | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT value FROM cache_schema_metadata WHERE key = ?").get(key) as
      | { value?: unknown }
      | undefined;
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

async function writeDuplicateSqlProject(root: string): Promise<void> {
  const duplicateSource = `
CREATE TABLE invoice_entries (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
  await fsp.mkdir(path.join(root, "schema"), { recursive: true });
  await fsp.writeFile(path.join(root, "schema", "a.sql"), duplicateSource, "utf8");
  await fsp.writeFile(path.join(root, "schema", "b.sql"), duplicateSource, "utf8");
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
  it("rolls back a failed module cache batch without a partial row", async () => {
    const root = await mkTmpDir("dg-disk-cache-batch-rollback-");
    const firstPath = path.join(root, "first.ts");
    const secondPath = path.join(root, "second.ts");
    await fsp.writeFile(firstPath, "export const first = 1;\n", "utf8");
    await fsp.writeFile(secondPath, "export const second = 2;\n", "utf8");
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const first = Array.from(index.byFile.values()).find((mod) => mod.file.endsWith("/first.ts"));
    const second = Array.from(index.byFile.values()).find((mod) => mod.file.endsWith("/second.ts"));
    if (!first || !second) throw new Error("missing seeded modules");

    const db = new DatabaseSync(moduleCacheDbPath(root));
    db.exec("DELETE FROM module_cache;");
    db.close();

    const originalRun = SqliteStatement.prototype.run;
    let cacheWrites = 0;
    const runSpy = vi.spyOn(SqliteStatement.prototype, "run").mockImplementation(function (
      this: SqliteStatement,
      ...params
    ) {
      if (params.length === 5 && (params[0] === "first.ts" || params[0] === "second.ts")) {
        cacheWrites++;
        if (cacheWrites === 2) throw new Error("simulated aborted cache batch");
      }
      return originalRun.call(this, ...params);
    });
    try {
      buildCache.writeModulesToCache(
        root,
        [
          { file: firstPath, sig: "first-signature", mod: first },
          { file: secondPath, sig: "second-signature", mod: second },
        ],
        { cache: "disk" },
      );
    } finally {
      runSpy.mockRestore();
    }

    expect(cacheWrites).toBe(2);
    expect(readRowCount(moduleCacheDbPath(root), "SELECT COUNT(*) AS count FROM module_cache")).toBe(0);
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
        normalizePathForSql(retainedPath, root),
      ),
    ).toBe(1);
    expect(
      readRowCount(
        moduleCacheDbPath(root),
        "SELECT COUNT(*) AS count FROM module_cache WHERE file = ?",
        normalizePathForSql(deletedPath, root),
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
        normalizePathForSql(deletedPath, root),
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
    expect(readSqliteMetadata(moduleCacheDbPath(root), "module_cache.schema_version")).toBe("2");
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

    expect(readSqliteMetadata(moduleCacheDbPath(root), "module_cache.schema_version")).toBe("2");
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
    expect(readSqliteMetadata(duplicateCacheDbPath(root), "duplicate_unit_cache.schema_version")).toBe("2");
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
    expect(readSqliteMetadata(duplicateCacheDbPath(root), "duplicate_unit_cache.schema_version")).toBe("2");
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
    ).run(normalizePathForSql(path.join(root, "src", "a.ts"), root), "expired", "old", 2, "[]", 0);
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
        normalizePathForSql(path.join(root, "src", "a.ts"), root),
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
      .get(normalizePathForSql(path.join(root, "src", "a.ts"), root)) as
      | { version: number; payload: Uint8Array }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.version).toBe(4);
    const decompressed = brotliDecompressSync(row!.payload).toString("utf8");
    const units = JSON.parse(decompressed) as Array<Record<string, unknown>>;
    expect(units.length).toBeGreaterThan(0);
    expect(units[0]).not.toHaveProperty("text");
    expect(units[0]).not.toHaveProperty("normalizedTokens");
    expect(() => JSON.parse(Buffer.from(row!.payload).toString("utf8"))).toThrow();
  });

  it("persists SQL duplicate identities relative to the project root", async () => {
    const root = await mkTmpDir("dg-disk-cache-portable-sql-duplicates-");
    await writeDuplicateSqlProject(root);
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const file = normalizePathForSql(path.join(root, "schema", "a.sql"));
    const source = await fsp.readFile(file, "utf8");
    const unit = buildInternalUnit(
      {
        file: "schema/a.sql",
        startLine: 1,
        endLine: 8,
        languageId: "sql",
        kind: "symbol",
        name: "invoice_entries",
      },
      file,
      source,
      3,
      2,
      index.nativeMode,
      { sqlHandle: formatDuplicateSqlHandle("schema/a.sql", "invoice_entries", 1) },
    );
    writeDuplicateUnitsToCache(index, file, "portable-sql", [unit], root);

    const db = new DatabaseSync(duplicateCacheDbPath(root));
    const row = db.prepare("SELECT payload FROM duplicate_unit_cache WHERE file = ?").get("schema/a.sql") as
      | { payload: Uint8Array }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    const units = JSON.parse(brotliDecompressSync(row!.payload).toString("utf8")) as Array<Record<string, unknown>>;
    expect(units[0]?.sqlHandle).toBe(formatDuplicateSqlHandle("schema/a.sql", "invoice_entries", 1));
    expect(JSON.stringify(units[0])).not.toContain(normalizePathForSql(root));

    const loaded = tryLoadDuplicateUnitsFromCache(index, file, "portable-sql", root);
    expect(loaded?.[0]?.absoluteFile).toBe(normalizePathForSql(file));
    expect(loaded?.[0]?.id?.startsWith(`${normalizePathForSql(file)}:`)).toBe(true);
    expect(loaded?.[0]?.sqlHandle).toBe(formatDuplicateSqlHandle("schema/a.sql", "invoice_entries", 1));
  });

  it("persists symbol duplicate identities relative to the project root, canonicalizing the file component distinct from SQL handles", async () => {
    const root = await mkTmpDir("dg-disk-cache-portable-symbol-duplicates-");
    await writeDuplicateProject(root);
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const file = normalizePathForSql(path.join(root, "src", "a.ts"));
    const source = await fsp.readFile(file, "utf8");
    const namedHandle = formatDuplicateSymbolHandle(file, "normalizeInvoiceRows", 1, 0);
    const persistedNamedHandle = formatDuplicateSymbolHandle("src/a.ts", "normalizeInvoiceRows", 1, 0);
    // A symbol handle is `symbol:<file>:<name>:<line>:<column>` (file at index 1), while a SQL
    // handle is `sql:<name>:<file>:<line>` (file at index 2). Reusing the SQL index for symbol
    // handles would rewrite the encoded *name* as if it were the file.
    const emptyNameHandle = formatDuplicateSymbolHandle(file, "", 1, 0);
    const persistedEmptyNameHandle = formatDuplicateSymbolHandle("src/a.ts", "", 1, 0);

    const namedUnit = buildInternalUnit(
      {
        file: "src/a.ts",
        startLine: 1,
        endLine: 8,
        languageId: "typescript",
        kind: "symbol",
        name: "normalizeInvoiceRows",
      },
      file,
      source,
      3,
      2,
      index.nativeMode,
      { symbolHandle: namedHandle },
    );
    const emptyNameUnit = buildInternalUnit(
      {
        file: "src/a.ts",
        startLine: 1,
        endLine: 8,
        languageId: "typescript",
        kind: "symbol",
        name: "",
      },
      file,
      source,
      3,
      2,
      index.nativeMode,
      { symbolHandle: emptyNameHandle },
    );
    writeDuplicateUnitsToCache(index, file, "portable-symbol", [namedUnit, emptyNameUnit], root);

    const db = new DatabaseSync(duplicateCacheDbPath(root));
    const row = db.prepare("SELECT payload FROM duplicate_unit_cache WHERE file = ?").get("src/a.ts") as
      | { payload: Uint8Array }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    const units = JSON.parse(brotliDecompressSync(row!.payload).toString("utf8")) as Array<Record<string, unknown>>;
    expect(units[0]?.symbolHandle).toBe(persistedNamedHandle);
    expect(units[1]?.symbolHandle).toBe(persistedEmptyNameHandle);
    expect(JSON.stringify(units)).not.toContain(normalizePathForSql(root));

    const loaded = tryLoadDuplicateUnitsFromCache(index, file, "portable-symbol", root);
    expect(loaded?.[0]?.absoluteFile).toBe(normalizePathForSql(file));
    expect(loaded?.[0]?.symbolHandle).toBe(persistedNamedHandle);
    expect(loaded?.[1]?.symbolHandle).toBe(persistedEmptyNameHandle);
  });

  it("honors a projectRoot override in the batched duplicate-unit cache writer", async () => {
    const root = await mkTmpDir("dg-disk-cache-batch-scoped-root-");
    await writeDuplicateProject(root);
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const file = normalizePathForSql(path.join(root, "src", "a.ts"));
    const source = await fsp.readFile(file, "utf8");
    const scopedRoot = path.join(root, "src");
    const unit = buildInternalUnit(
      {
        file: "src/a.ts",
        startLine: 1,
        endLine: 8,
        languageId: "typescript",
        kind: "symbol",
        name: "normalizeInvoiceRows",
      },
      file,
      source,
      3,
      2,
      index.nativeMode,
      { symbolHandle: formatDuplicateSymbolHandle(file, "normalizeInvoiceRows", 1, 0) },
    );

    writeDuplicateUnitsBatchToCache(index, [{ file, variant: "batch-scoped", units: [unit] }], scopedRoot);

    const loadedWithScopedRoot = tryLoadDuplicateUnitsFromCache(index, file, "batch-scoped", scopedRoot);
    expect(loadedWithScopedRoot?.[0]?.id).toBe(unit.id);

    const loadedWithIndexRoot = tryLoadDuplicateUnitsFromCache(index, file, "batch-scoped", index.projectRoot);
    expect(loadedWithIndexRoot).toBeNull();
  });

  it("rejects duplicate units whose persisted absolute file escapes the project", async () => {
    const root = await mkTmpDir("dg-disk-cache-duplicate-unit-confinement-");
    await writeDuplicateProject(root);
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const file = normalizePathForSql(path.join(root, "src", "a.ts"));
    const source = await fsp.readFile(file, "utf8");
    const unit = buildInternalUnit(
      {
        file: "src/a.ts",
        startLine: 1,
        endLine: 8,
        languageId: "typescript",
        kind: "symbol",
        name: "normalizeInvoiceRows",
      },
      file,
      source,
      3,
      2,
      index.nativeMode,
    );
    writeDuplicateUnitsToCache(index, file, "confinement", [unit], root);
    closeDuplicateUnitCacheDatabase(root);

    const db = new DatabaseSync(duplicateCacheDbPath(root));
    const row = db
      .prepare("SELECT payload FROM duplicate_unit_cache WHERE file = ? AND variant = ?")
      .get("src/a.ts", "confinement") as { payload: Uint8Array } | undefined;
    if (!row) throw new Error("expected duplicate cache row");
    const units = JSON.parse(brotliDecompressSync(row.payload).toString("utf8")) as Array<Record<string, unknown>>;
    units[0] = { ...units[0], absoluteFile: "../outside.ts" };
    db.prepare("UPDATE duplicate_unit_cache SET payload = ? WHERE file = ? AND variant = ?").run(
      brotliCompressSync(JSON.stringify(units)),
      "src/a.ts",
      "confinement",
    );
    db.close();

    const reopenedIndex = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    expect(tryLoadDuplicateUnitsFromCache(reopenedIndex, file, "confinement", root)).toBeNull();
  });

  it("rejects duplicate units with malformed or out-of-root encoded handle paths", async () => {
    const root = await mkTmpDir("dg-disk-cache-duplicate-handle-confinement-");
    await writeDuplicateProject(root);
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const file = normalizePathForSql(path.join(root, "src", "a.ts"));
    const source = await fsp.readFile(file, "utf8");
    const unit = buildInternalUnit(
      {
        file: "src/a.ts",
        startLine: 1,
        endLine: 8,
        languageId: "typescript",
        kind: "symbol",
        name: "normalizeInvoiceRows",
      },
      file,
      source,
      3,
      2,
      index.nativeMode,
      {
        sqlHandle: formatDuplicateSqlHandle("src/a.ts", "normalizeInvoiceRows", 1),
        symbolHandle: formatDuplicateSymbolHandle("src/a.ts", "normalizeInvoiceRows", 1, 0),
      },
    );
    writeDuplicateUnitsToCache(index, file, "handle-confinement", [unit], root);
    closeDuplicateUnitCacheDatabase(root);

    const fieldValues: Array<[string, string]> = [
      ["file", "../outside.ts"],
      ["handle", "sql:normalizeInvoiceRows:..%2Foutside.ts:1"],
      ["fileHandle", "file:%E0%A4%A"],
      ["chunkHandle", "chunk:..%2Foutside.ts:1"],
      ["symbolHandle", "symbol:..%2Foutside.ts:normalizeInvoiceRows:1:0"],
      ["sqlHandle", "sql:normalizeInvoiceRows:..%2Foutside.ts:1"],
    ];
    const reopenedIndex = await buildProjectIndex(root, { cache: "disk", threads: 1 });

    for (const [field, value] of fieldValues) {
      const db = new DatabaseSync(duplicateCacheDbPath(root));
      const row = db
        .prepare("SELECT payload FROM duplicate_unit_cache WHERE file = ? AND variant = ?")
        .get("src/a.ts", "handle-confinement") as { payload: Uint8Array } | undefined;
      if (!row) throw new Error("expected duplicate cache row");
      const units = JSON.parse(brotliDecompressSync(row.payload).toString("utf8")) as Array<Record<string, unknown>>;
      units[0] = { ...units[0], [field]: value };
      db.prepare("UPDATE duplicate_unit_cache SET payload = ? WHERE file = ? AND variant = ?").run(
        brotliCompressSync(JSON.stringify(units)),
        "src/a.ts",
        "handle-confinement",
      );
      db.close();

      expect(tryLoadDuplicateUnitsFromCache(reopenedIndex, file, "handle-confinement", root)).toBeNull();

      const reset = new DatabaseSync(duplicateCacheDbPath(root));
      reset
        .prepare("UPDATE duplicate_unit_cache SET payload = ? WHERE file = ? AND variant = ?")
        .run(row.payload, "src/a.ts", "handle-confinement");
      reset.close();
    }
  });

  it("ignores duplicate cache rows written by an older payload version", async () => {
    const root = await mkTmpDir("dg-disk-cache-stale-duplicates-");
    await writeDuplicateProject(root);
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    await findDuplicates(index, { minConfidence: "high", limit: 5 });
    closeDuplicateUnitCacheDatabase(root);

    const aFile = normalizePathForSql(path.join(root, "src", "a.ts"), root);
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
      | { version: number }
      | undefined;
    after.close();
    expect(row?.version).toBe(4);
  });
});
