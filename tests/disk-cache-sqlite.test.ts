import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { buildProjectIndex, findDuplicates, type BuildReport } from "../src/index.js";
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

function readRowCount(dbPath: string, sql: string, param: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(sql).get(param) as { count?: unknown } | undefined;
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

  it("reuses disk cache entries across builds when languageExtensions is configured", async () => {
    const root = await mkTmpDir("dg-disk-cache-language-extensions-");
    await fsp.writeFile(path.join(root, "template.tpl"), "<?php function cached_template() { return 1; }\n", "utf8");

    const report1: BuildReport = {};
    await buildProjectIndex(root, {
      cache: "disk",
      keepParsed: false,
      languageExtensions: { ".tpl": "php" },
      report: report1,
      threads: 1,
    });

    const report2: BuildReport = {};
    await buildProjectIndex(root, {
      cache: "disk",
      keepParsed: false,
      languageExtensions: { ".tpl": "php" },
      report: report2,
      threads: 1,
    });

    expect((report2.cache?.hits ?? 0) > 0).toBe(true);
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
});
