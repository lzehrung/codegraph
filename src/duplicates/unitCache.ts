import fs from "node:fs";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import type { BuildOptions, ProjectIndex } from "../indexer/types.js";
import { getNativeDuplicateTokens, getNativeTreeSitterSupportedLanguageIds, isNativeDuplicateTokenizationAvailable, isNativeTreeSitterDisabledByEnv } from "../native/treeSitterNative.js";
import { SqliteDatabase, type SqliteStatement } from "../sqlite-driver.js";
import { logWithLevel } from "../logging.js";
import { cacheDatabasePath } from "../indexer/build-cache/module-cache.js";
import {
  createSqliteTableIfMissing,
  ensureSqliteVersionedTableSchema,
  recreateSqliteTable,
  sqliteTableColumns,
  type SqliteTableColumn,
} from "../util/sqliteSchema.js";
import type {
  DuplicateDetectionResult,
  DuplicateInternalUnit,
  DuplicateUnitCacheEntry,
  DuplicateSerializedUnit,
  DuplicateUnitDiskDatabaseEntry,
  DuplicateUnitDiskStatements,
} from "./types.js";

// v3: drop dead `text`/`normalizedTokens` fields (never read after construction) and
// brotli-compress the payload; both cut on-disk cache size by roughly 8x.
export const DUPLICATE_UNIT_CACHE_VERSION = 3;
export const DUPLICATE_UNIT_CACHE_SCHEMA_VERSION = 1;
export const DUPLICATE_UNIT_CACHE_TABLE = "duplicate_unit_cache";
export const DUPLICATE_UNIT_CACHE_SCHEMA_VERSION_KEY = "duplicate_unit_cache.schema_version";
export const DUPLICATE_TOKENIZER_REVISION = 2;
export const DUPLICATE_UNIT_CACHE_MAX_ROWS = 5_000;
export const DUPLICATE_UNIT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const DUPLICATE_UNIT_CACHE_COLUMNS: readonly SqliteTableColumn[] = [
  { name: "file", definition: "TEXT NOT NULL" },
  { name: "variant", definition: "TEXT NOT NULL" },
  { name: "sig", definition: "TEXT NOT NULL" },
  { name: "version", definition: "INTEGER NOT NULL" },
  { name: "payload", definition: "BLOB NOT NULL" },
  { name: "updated_at", definition: "INTEGER NOT NULL" },
];

export const duplicateUnitMemoryCache = new Map<string, DuplicateUnitCacheEntry>();
export const duplicateUnitDiskDatabases = new Map<string, DuplicateUnitDiskDatabaseEntry>();

export function duplicateUnitCacheVariant(
  index: ProjectIndex,
  minTokens: number,
  maxTokens: number,
  shingleSize: number,
  windowSize: number,
): string {
  const nativeMode = normalizedDuplicateUnitCacheNativeMode(index.nativeMode);
  return JSON.stringify({
    version: DUPLICATE_UNIT_CACHE_VERSION,
    tokenizerRevision: DUPLICATE_TOKENIZER_REVISION,
    nativeMode,
    nativeDuplicateTokens: isNativeDuplicateTokenizationAvailable(index.nativeMode),
    nativeSyntaxLanguages: getNativeTreeSitterSupportedLanguageIds(index.nativeMode),
    nativeEnvDisabled: nativeMode === undefined ? isNativeTreeSitterDisabledByEnv() : undefined,
    minTokens,
    maxTokens,
    shingleSize,
    windowSize,
  });
}

export function normalizedDuplicateUnitCacheNativeMode(
  nativeMode: ProjectIndex["nativeMode"] | undefined,
): ProjectIndex["nativeMode"] | undefined {
  if (nativeMode === undefined || nativeMode === "auto") return undefined;
  return nativeMode;
}

export function duplicateUnitCacheSignature(index: ProjectIndex, file: string): string | undefined {
  const entry = index.manifestEntries?.get(file);
  return entry?.gitSig ?? entry?.sig;
}

export function duplicateUnitCacheKey(file: string, variant: string): string {
  return `${file}\u0000${variant}`;
}

export function duplicateUnitCacheDatabasePath(projectRoot: string, opts?: BuildOptions): string {
  return cacheDatabasePath(projectRoot, opts, "duplicate-unit-cache.sqlite");
}

export function createDuplicateUnitCacheTable(db: SqliteDatabase): void {
  createSqliteTableIfMissing(db, DUPLICATE_UNIT_CACHE_TABLE, DUPLICATE_UNIT_CACHE_COLUMNS, [
    "PRIMARY KEY (file, variant)",
  ]);
}

export function recreateDuplicateUnitCacheTable(db: SqliteDatabase): void {
  recreateSqliteTable(db, DUPLICATE_UNIT_CACHE_TABLE, createDuplicateUnitCacheTable);
}

export function migrateDuplicateUnitCacheTable(db: SqliteDatabase): void {
  const columns = sqliteTableColumns(db, DUPLICATE_UNIT_CACHE_TABLE);
  if (!columns.size) {
    createDuplicateUnitCacheTable(db);
    return;
  }
  if (!columns.has("file") || !columns.has("variant")) {
    recreateDuplicateUnitCacheTable(db);
    return;
  }
  if (!columns.has("sig")) db.exec("ALTER TABLE duplicate_unit_cache ADD COLUMN sig TEXT NOT NULL DEFAULT '';");
  if (!columns.has("version"))
    db.exec("ALTER TABLE duplicate_unit_cache ADD COLUMN version INTEGER NOT NULL DEFAULT 0;");
  if (!columns.has("payload"))
    db.exec("ALTER TABLE duplicate_unit_cache ADD COLUMN payload TEXT NOT NULL DEFAULT '[]';");
  if (!columns.has("updated_at")) {
    db.exec("ALTER TABLE duplicate_unit_cache ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;");
  }
}

export function ensureDuplicateUnitCacheSchema(db: SqliteDatabase): void {
  ensureSqliteVersionedTableSchema({
    db,
    tableName: DUPLICATE_UNIT_CACHE_TABLE,
    schemaVersionKey: DUPLICATE_UNIT_CACHE_SCHEMA_VERSION_KEY,
    schemaVersion: DUPLICATE_UNIT_CACHE_SCHEMA_VERSION,
    createTable: createDuplicateUnitCacheTable,
    migrateTable: migrateDuplicateUnitCacheTable,
  });
}

export function createDuplicateUnitDiskStatements(db: SqliteDatabase): DuplicateUnitDiskStatements {
  return {
    load: db.prepare("SELECT sig, version, payload FROM duplicate_unit_cache WHERE file = ? AND variant = ?"),
    write: db.prepare(
      `INSERT INTO duplicate_unit_cache (file, variant, sig, version, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(file, variant) DO UPDATE SET
         sig = excluded.sig,
         version = excluded.version,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
    ),
    pruneExpired: db.prepare("DELETE FROM duplicate_unit_cache WHERE updated_at < ?"),
    pruneOverflow: db.prepare(
      "DELETE FROM duplicate_unit_cache WHERE rowid IN (SELECT rowid FROM duplicate_unit_cache ORDER BY updated_at DESC LIMIT -1 OFFSET ?)",
    ),
  };
}

export function maintainDuplicateUnitDiskCache(index: ProjectIndex): void {
  if (index.cacheMode !== "disk" || !index.cacheRootDir) return;
  const dbPath = duplicateUnitCacheDatabasePath(index.projectRoot ?? "", { cacheDir: index.cacheRootDir });
  const entry = duplicateUnitDiskDatabases.get(dbPath);
  if (!entry?.db || !entry.statements) return;
  const { db, statements } = entry;
  try {
    db.transaction(() => {
      statements.pruneExpired.run(Date.now() - DUPLICATE_UNIT_CACHE_MAX_AGE_MS);
      statements.pruneOverflow.run(DUPLICATE_UNIT_CACHE_MAX_ROWS);
    })();
  } catch (error) {
    logWithLevel(undefined, "warn", `Warning: Failed to prune duplicate cache ${dbPath}:`, error);
  }
}

export function duplicateUnitDiskCache(index: ProjectIndex): DuplicateUnitDiskDatabaseEntry | null {
  if (index.cacheMode !== "disk" || !index.cacheRootDir) return null;
  const dbPath = duplicateUnitCacheDatabasePath(index.projectRoot ?? "", { cacheDir: index.cacheRootDir });
  let entry = duplicateUnitDiskDatabases.get(dbPath);
  if (!entry) {
    entry = { leases: 0, closeRequested: false };
    duplicateUnitDiskDatabases.set(dbPath, entry);
  }
  if (!entry.db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new SqliteDatabase(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    ensureDuplicateUnitCacheSchema(db);
    entry.db = db;
    entry.statements = createDuplicateUnitDiskStatements(db);
  }
  return entry;
}

export function closeDuplicateUnitDiskDatabaseEntry(dbPath: string, entry: DuplicateUnitDiskDatabaseEntry): void {
  if (entry.leases > 0) {
    entry.closeRequested = true;
    return;
  }
  if (!entry.db) {
    duplicateUnitDiskDatabases.delete(dbPath);
    return;
  }
  try {
    entry.db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // checkpoint best-effort
  }
  try {
    entry.db.close();
    duplicateUnitDiskDatabases.delete(dbPath);
  } catch {
    // Keep handle for later retry if close fails.
  }
}

export function closeDuplicateUnitCacheDatabase(projectRoot: string, opts?: BuildOptions): void {
  const dbPath = duplicateUnitCacheDatabasePath(projectRoot, opts);
  const entry = duplicateUnitDiskDatabases.get(dbPath);
  if (!entry) return;
  closeDuplicateUnitDiskDatabaseEntry(dbPath, entry);
}

export function leaseDuplicateUnitCacheForIndex(index: ProjectIndex): () => void {
  if (index.cacheMode !== "disk" || !index.cacheRootDir) return () => {};
  const dbPath = duplicateUnitCacheDatabasePath(index.projectRoot ?? "", { cacheDir: index.cacheRootDir });
  let entry = duplicateUnitDiskDatabases.get(dbPath);
  if (!entry) {
    entry = { leases: 0, closeRequested: false };
    duplicateUnitDiskDatabases.set(dbPath, entry);
  }
  entry.leases++;
  return () => {
    entry.leases = Math.max(0, entry.leases - 1);
    if (entry.closeRequested) {
      closeDuplicateUnitDiskDatabaseEntry(dbPath, entry);
    }
  };
}

export function closeDuplicateUnitCacheForIndex(index: ProjectIndex): void {
  if (index.cacheMode !== "disk" || !index.cacheRootDir) return;
  closeDuplicateUnitCacheDatabase(index.projectRoot ?? "", { cacheDir: index.cacheRootDir });
}

export function tryLoadDuplicateUnitsFromCache(
  index: ProjectIndex,
  file: string,
  variant: string,
): DuplicateInternalUnit[] | null {
  const sig = duplicateUnitCacheSignature(index, file);
  if (!sig) return null;
  const key = duplicateUnitCacheKey(file, variant);
  if (index.cacheMode === "memory") {
    const entry = duplicateUnitMemoryCache.get(key);
    if (entry && entry.sig === sig) return entry.units;
    return null;
  }
  if (index.cacheMode === "disk") {
    try {
      const entry = duplicateUnitDiskCache(index);
      const row = entry?.statements?.load.get(file, variant) as
        | { sig: string; version: number; payload: Uint8Array }
        | undefined;
      if (!row || row.sig !== sig || row.version !== DUPLICATE_UNIT_CACHE_VERSION) return null;
      const parsed = JSON.parse(brotliDecompressSync(row.payload).toString("utf8")) as unknown;
      return deserializeDuplicateUnits(parsed);
    } catch {
      return null;
    }
  }
  return null;
}

export function writeDuplicateUnitsToCache(
  index: ProjectIndex,
  file: string,
  variant: string,
  units: DuplicateInternalUnit[],
): void {
  const sig = duplicateUnitCacheSignature(index, file);
  if (!sig) return;
  const key = duplicateUnitCacheKey(file, variant);
  if (index.cacheMode === "memory") {
    duplicateUnitMemoryCache.set(key, { sig, units });
    return;
  }
  if (index.cacheMode === "disk") {
    try {
      const entry = duplicateUnitDiskCache(index);
      const payload = brotliCompressSync(JSON.stringify(serializeDuplicateUnits(units)), {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
      });
      entry?.statements?.write.run(file, variant, sig, DUPLICATE_UNIT_CACHE_VERSION, payload, Date.now());
    } catch {
      // best-effort cache
    }
  }
}

export function deserializeDuplicateUnits(value: unknown): DuplicateInternalUnit[] | null {
  if (!Array.isArray(value) || !value.every(isDuplicateSerializedUnit)) return null;
  return value.map((unit) => ({
    ...unit,
    tokenSet: new Set(unit.tokenSet),
    signatures: new Set(unit.signatures),
  }));
}

export function serializeDuplicateUnits(units: DuplicateInternalUnit[]): DuplicateSerializedUnit[] {
  return units.map((unit) => ({
    ...unit,
    tokenSet: [...unit.tokenSet],
    signatures: [...unit.signatures],
  }));
}

export function isDuplicateSerializedUnit(value: unknown): value is DuplicateSerializedUnit {
  if (!value || typeof value !== "object") return false;
  const unit = value as Partial<DuplicateSerializedUnit>;
  return (
    typeof unit.id === "string" &&
    typeof unit.file === "string" &&
    typeof unit.absoluteFile === "string" &&
    typeof unit.rawHash === "string" &&
    typeof unit.normalizedHash === "string" &&
    Array.isArray(unit.tokenSet) &&
    Array.isArray(unit.signatures) &&
    typeof unit.startLine === "number" &&
    typeof unit.endLine === "number" &&
    typeof unit.languageId === "string" &&
    (unit.kind === "symbol" || unit.kind === "chunk") &&
    typeof unit.tokenCount === "number" &&
    typeof unit.handle === "string" &&
    typeof unit.fileHandle === "string" &&
    typeof unit.chunkHandle === "string"
  );
}
