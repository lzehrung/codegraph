import fs from "node:fs";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import type { BuildOptions, ProjectIndex } from "../indexer/types.js";
import {
  getNativeDuplicateTokens,
  getNativeTreeSitterSupportedLanguageIds,
  isNativeDuplicateTokenizationAvailable,
  isNativeTreeSitterDisabledByEnv,
} from "../native/treeSitterNative.js";
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
import { lruMapGet } from "../util/lruMap.js";
import { assertFilePathWithinRoot, fileIdentityKey, normalizePath } from "../util/paths.js";
import { cacheAbsolutePath, cacheRelativePath } from "../indexer/build-cache/module-cache.js";

// v4: project-relative file fields and handles.
export const DUPLICATE_UNIT_CACHE_VERSION = 4;
export const DUPLICATE_UNIT_CACHE_SCHEMA_VERSION = 2;
export const DUPLICATE_UNIT_CACHE_TABLE = "duplicate_unit_cache";
export const DUPLICATE_UNIT_CACHE_SCHEMA_VERSION_KEY = "duplicate_unit_cache.schema_version";
export const DUPLICATE_TOKENIZER_REVISION = 4;
export const DUPLICATE_UNIT_CACHE_MAX_ROWS = 5_000;
export const DUPLICATE_UNIT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const DUPLICATE_UNIT_MEMORY_CACHE_MAX_ENTRIES = 2_048;
export const DUPLICATE_UNIT_MEMORY_CACHE_MAX_BYTES = 64 * 1024 * 1024;
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

let duplicateUnitMemoryCacheBytes = 0;

function estimateDuplicateUnitCacheEntryBytes(entry: DuplicateUnitCacheEntry): number {
  let bytes = entry.sig.length * 2 + 64;
  for (const unit of entry.units) {
    bytes += unit.id.length * 2 + unit.file.length * 2 + unit.absoluteFile.length * 2 + 128;
    bytes += unit.tokenSet.size * 24 + unit.signatures.size * 24;
    bytes += unit.tokenCount * 4;
  }
  return bytes;
}

export function clearDuplicateUnitMemoryCache(): void {
  duplicateUnitMemoryCache.clear();
  duplicateUnitMemoryCacheBytes = 0;
}

export function clearDuplicateUnitMemoryCacheForRoot(projectRoot: string): void {
  const rootPrefix = normalizePath(projectRoot).replace(/\/$/, "");
  const rootKey = fileIdentityKey(rootPrefix);
  for (const key of [...duplicateUnitMemoryCache.keys()]) {
    const file = key.split("\u0000")[0] ?? "";
    const normalizedFile = normalizePath(file);
    if (
      fileIdentityKey(normalizedFile) === rootKey ||
      normalizedFile === rootPrefix ||
      normalizedFile.startsWith(`${rootPrefix}/`)
    ) {
      const entry = duplicateUnitMemoryCache.get(key);
      if (entry)
        duplicateUnitMemoryCacheBytes = Math.max(
          0,
          duplicateUnitMemoryCacheBytes - estimateDuplicateUnitCacheEntryBytes(entry),
        );
      duplicateUnitMemoryCache.delete(key);
    }
  }
}

function readDuplicateUnitMemoryCache(key: string): DuplicateUnitCacheEntry | undefined {
  return lruMapGet(duplicateUnitMemoryCache, key);
}

function writeDuplicateUnitMemoryCache(key: string, entry: DuplicateUnitCacheEntry): void {
  const existing = duplicateUnitMemoryCache.get(key);
  if (existing) {
    duplicateUnitMemoryCacheBytes = Math.max(
      0,
      duplicateUnitMemoryCacheBytes - estimateDuplicateUnitCacheEntryBytes(existing),
    );
    duplicateUnitMemoryCache.delete(key);
  }
  const entryBytes = estimateDuplicateUnitCacheEntryBytes(entry);
  while (
    duplicateUnitMemoryCache.size > 0 &&
    (duplicateUnitMemoryCache.size >= DUPLICATE_UNIT_MEMORY_CACHE_MAX_ENTRIES ||
      duplicateUnitMemoryCacheBytes + entryBytes > DUPLICATE_UNIT_MEMORY_CACHE_MAX_BYTES)
  ) {
    const oldestKey = duplicateUnitMemoryCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = duplicateUnitMemoryCache.get(oldestKey);
    duplicateUnitMemoryCache.delete(oldestKey);
    if (oldest) {
      duplicateUnitMemoryCacheBytes = Math.max(
        0,
        duplicateUnitMemoryCacheBytes - estimateDuplicateUnitCacheEntryBytes(oldest),
      );
    }
  }
  duplicateUnitMemoryCache.set(key, entry);
  duplicateUnitMemoryCacheBytes += entryBytes;
}

export function duplicateUnitCacheVariant(
  index: ProjectIndex,
  minTokens: number,
  maxTokens: number,
  shingleSize: number,
  windowSize: number,
  projectRoot?: string,
): string {
  const normalizedProjectRoot = normalizePath(projectRoot ?? index.projectRoot ?? "");
  const nativeMode = normalizedDuplicateUnitCacheNativeMode(index.nativeMode);
  return JSON.stringify({
    version: DUPLICATE_UNIT_CACHE_VERSION,
    tokenizerRevision: DUPLICATE_TOKENIZER_REVISION,
    projectRoot: normalizedProjectRoot,
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

export function duplicateUnitCacheSignature(
  index: ProjectIndex,
  file: string,
  projectRoot?: string,
): string | undefined {
  const root = projectRoot ?? index.projectRoot;
  const entry =
    index.manifestEntries?.get(file) ?? (root ? index.manifestEntries?.get(cacheRelativePath(root, file)) : undefined);
  // `cacheSig` is git- or content-hash-derived and distinguishes a same-size edit whose mtime
  // got restored; falling back straight to `sig` would let a non-Git project reuse stale
  // duplicate units for a file whose content actually changed.
  return entry?.cacheSig ?? entry?.gitSig ?? entry?.sig;
}

export function duplicateUnitCacheKey(file: string, variant: string): string {
  return `${file}\u0000${variant}`;
}

export function duplicateUnitCacheDatabasePath(projectRoot: string, opts?: BuildOptions): string {
  return cacheDatabasePath(projectRoot, opts, "duplicate-unit-cache.sqlite");
}

function duplicateUnitCacheDatabasePathForRoot(cacheRootDir: string): string {
  return path.join(cacheRootDir, "duplicate-unit-cache.sqlite").replace(/\\/g, "/");
}

export function createDuplicateUnitCacheTable(db: SqliteDatabase): void {
  createSqliteTableIfMissing(db, DUPLICATE_UNIT_CACHE_TABLE, DUPLICATE_UNIT_CACHE_COLUMNS, [
    "PRIMARY KEY (file, variant)",
  ]);
}

export function recreateDuplicateUnitCacheTable(db: SqliteDatabase): void {
  recreateSqliteTable(db, DUPLICATE_UNIT_CACHE_TABLE, createDuplicateUnitCacheTable);
}

export function migrateDuplicateUnitCacheTable(db: SqliteDatabase, projectRoot: string): void {
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
    db.exec("ALTER TABLE duplicate_unit_cache ADD COLUMN payload BLOB NOT NULL DEFAULT (x'');");
  if (!columns.has("updated_at")) {
    db.exec("ALTER TABLE duplicate_unit_cache ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;");
  }
  const rows = db.prepare("SELECT file FROM duplicate_unit_cache").all() as Array<{ file: string }>;
  const update = db.prepare("UPDATE duplicate_unit_cache SET file = ? WHERE file = ?");
  for (const row of rows) {
    const relative = cacheRelativePath(projectRoot, row.file);
    if (relative !== row.file) update.run(relative, row.file);
  }
}

export function ensureDuplicateUnitCacheSchema(db: SqliteDatabase, projectRoot: string): void {
  ensureSqliteVersionedTableSchema({
    db,
    tableName: DUPLICATE_UNIT_CACHE_TABLE,
    schemaVersionKey: DUPLICATE_UNIT_CACHE_SCHEMA_VERSION_KEY,
    schemaVersion: DUPLICATE_UNIT_CACHE_SCHEMA_VERSION,
    createTable: createDuplicateUnitCacheTable,
    migrateTable: (database) => migrateDuplicateUnitCacheTable(database, projectRoot),
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
  const dbPath = duplicateUnitCacheDatabasePathForRoot(index.cacheRootDir);
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
  const dbPath = duplicateUnitCacheDatabasePathForRoot(index.cacheRootDir);
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
    ensureDuplicateUnitCacheSchema(db, index.projectRoot ?? path.dirname(index.cacheRootDir));
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
  clearDuplicateUnitMemoryCacheForRoot(projectRoot);
  const dbPath = duplicateUnitCacheDatabasePath(projectRoot, opts);
  const entry = duplicateUnitDiskDatabases.get(dbPath);
  if (!entry) {
    return;
  }
  closeDuplicateUnitDiskDatabaseEntry(dbPath, entry);
}

export function leaseDuplicateUnitCacheForIndex(index: ProjectIndex): () => void {
  if (index.cacheMode !== "disk" || !index.cacheRootDir) return () => {};
  const dbPath = duplicateUnitCacheDatabasePathForRoot(index.cacheRootDir);
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
  const dbPath = duplicateUnitCacheDatabasePathForRoot(index.cacheRootDir);
  const entry = duplicateUnitDiskDatabases.get(dbPath);
  if (!entry) return;
  closeDuplicateUnitDiskDatabaseEntry(dbPath, entry);
}

export function tryLoadDuplicateUnitsFromCache(
  index: ProjectIndex,
  file: string,
  variant: string,
  projectRoot?: string,
): DuplicateInternalUnit[] | null {
  const sig = duplicateUnitCacheSignature(index, file, projectRoot);
  if (!sig) return null;
  const key = duplicateUnitCacheKey(file, variant);
  if (index.cacheMode === "memory") {
    const entry = readDuplicateUnitMemoryCache(key);
    return entry && entry.sig === sig ? entry.units : null;
  }
  if (index.cacheMode !== "disk") return null;
  try {
    const entry = duplicateUnitDiskCache(index);
    const root = projectRoot ?? index.projectRoot ?? "";
    const relativeFile = root ? cacheRelativePath(root, file) : file;
    const row = entry?.statements?.load.get(relativeFile, variant) as
      | { sig: string; version: number; payload: Uint8Array }
      | undefined;
    if (!row || row.sig !== sig || row.version !== DUPLICATE_UNIT_CACHE_VERSION) return null;
    const parsed = JSON.parse(brotliDecompressSync(row.payload).toString("utf8")) as unknown;
    if (!Array.isArray(parsed)) return null;
    if (root && !validatePersistedDuplicateUnits(root, parsed)) return null;
    return deserializeDuplicateUnits(root ? transformDuplicateUnits(root, parsed, false) : parsed);
  } catch {
    return null;
  }
}

export type PendingDuplicateUnitCacheWrite = {
  file: string;
  variant: string;
  units: DuplicateInternalUnit[];
};

export function writeDuplicateUnitsBatchToCache(
  index: ProjectIndex,
  writes: readonly PendingDuplicateUnitCacheWrite[],
  projectRoot?: string,
): void {
  if (!writes.length) return;
  const root = projectRoot ?? index.projectRoot ?? "";
  if (index.cacheMode === "memory") {
    for (const write of writes) {
      const sig = duplicateUnitCacheSignature(index, write.file, projectRoot);
      if (!sig) continue;
      writeDuplicateUnitMemoryCache(duplicateUnitCacheKey(write.file, write.variant), {
        sig,
        units: write.units,
      });
    }
    return;
  }
  if (index.cacheMode !== "disk") return;
  try {
    const entry = duplicateUnitDiskCache(index);
    const preparedWrites: Array<{
      file: string;
      variant: string;
      sig: string;
      payload: Buffer;
    }> = [];
    for (const write of writes) {
      const sig = duplicateUnitCacheSignature(index, write.file, projectRoot);
      if (!sig) continue;
      const payload = brotliCompressSync(
        JSON.stringify(transformDuplicateUnits(root, serializeDuplicateUnits(write.units), true)),
        { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } },
      );
      preparedWrites.push({
        file: cacheRelativePath(root, write.file),
        variant: write.variant,
        sig,
        payload,
      });
    }
    if (!preparedWrites.length || !entry?.db || !entry.statements) return;
    const now = Date.now();
    entry.db.transaction(() => {
      for (const write of preparedWrites) {
        entry.statements?.write.run(
          write.file,
          write.variant,
          write.sig,
          DUPLICATE_UNIT_CACHE_VERSION,
          write.payload,
          now,
        );
      }
    })();
  } catch {
    // best-effort cache
  }
}

export function writeDuplicateUnitsToCache(
  index: ProjectIndex,
  file: string,
  variant: string,
  units: DuplicateInternalUnit[],
  projectRoot?: string,
): void {
  const sig = duplicateUnitCacheSignature(index, file, projectRoot);
  if (!sig) return;
  const key = duplicateUnitCacheKey(file, variant);
  if (index.cacheMode === "memory") {
    writeDuplicateUnitMemoryCache(key, { sig, units });
    return;
  }
  if (index.cacheMode === "disk") {
    try {
      const root = projectRoot ?? index.projectRoot ?? "";
      const entry = duplicateUnitDiskCache(index);
      const serialized = serializeDuplicateUnits(units);
      const payload = brotliCompressSync(
        JSON.stringify(root ? transformDuplicateUnits(root, serialized, true) : serialized),
        {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
        },
      );
      entry?.statements?.write.run(
        root ? cacheRelativePath(root, file) : file,
        variant,
        sig,
        DUPLICATE_UNIT_CACHE_VERSION,
        payload,
        Date.now(),
      );
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
function transformDuplicateHandle(root: string, value: string): string {
  const parts = value.split(":");
  let filePartIndex = -1;
  if (parts[0] === "file" || parts[0] === "chunk" || parts[0] === "symbol") {
    filePartIndex = 1;
  } else if (parts[0] === "sql") {
    filePartIndex = 2;
  }
  if (filePartIndex < 0 || parts.length <= filePartIndex) return value;
  const encodedFile = parts[filePartIndex];
  if (encodedFile === undefined) return value;
  try {
    parts[filePartIndex] = encodeURIComponent(cacheRelativePath(root, decodeURIComponent(encodedFile)));
    return parts.join(":");
  } catch {
    return value;
  }
}

function duplicateHandleFilePartIndex(value: string): number | null {
  const parts = value.split(":");
  if (parts[0] === "file" && parts.length === 2) return 1;
  if (parts[0] === "chunk" && parts.length === 3) return 1;
  if (parts[0] === "symbol" && parts.length === 5) return 1;
  if (parts[0] === "sql" && parts.length === 4) return 2;
  return null;
}

function hasPersistedDuplicateHandlePathWithinRoot(root: string, value: string): boolean {
  const filePartIndex = duplicateHandleFilePartIndex(value);
  const handlePrefix = value.split(":")[0];
  if (filePartIndex === null) {
    return handlePrefix !== "file" && handlePrefix !== "chunk" && handlePrefix !== "symbol" && handlePrefix !== "sql";
  }
  const encodedFile = value.split(":")[filePartIndex];
  if (!encodedFile) return false;
  try {
    assertFilePathWithinRoot(
      root,
      cacheAbsolutePath(root, decodeURIComponent(encodedFile)),
      "Persisted duplicate handle path",
    );
    return true;
  } catch {
    return false;
  }
}

function validatePersistedDuplicateUnits(root: string, value: unknown[]): value is DuplicateSerializedUnit[] {
  return value.every((unit) => {
    if (!isDuplicateSerializedUnit(unit)) return false;
    try {
      assertFilePathWithinRoot(root, cacheAbsolutePath(root, unit.file), "Persisted duplicate unit file");
      assertFilePathWithinRoot(root, cacheAbsolutePath(root, unit.absoluteFile), "Persisted duplicate unit path");
    } catch {
      return false;
    }
    const handles = [unit.handle, unit.fileHandle, unit.chunkHandle, unit.symbolHandle, unit.sqlHandle];
    return handles.every((handle) => handle === undefined || hasPersistedDuplicateHandlePathWithinRoot(root, handle));
  });
}

function duplicateUnitId(unit: DuplicateSerializedUnit, absoluteFile: string): string {
  return `${normalizePath(absoluteFile)}:${unit.startLine}:${unit.endLine}:${unit.kind}:${unit.name ?? ""}`;
}

function transformDuplicateUnits(
  root: string,
  units: DuplicateSerializedUnit[],
  toRelative: boolean,
): DuplicateSerializedUnit[] {
  return units.map((unit) => {
    const absoluteFile = toRelative
      ? cacheRelativePath(root, unit.absoluteFile)
      : assertFilePathWithinRoot(root, cacheAbsolutePath(root, unit.absoluteFile), "Persisted duplicate unit path");
    return {
      ...unit,
      file: cacheRelativePath(root, unit.file),
      absoluteFile,
      id: duplicateUnitId(unit, absoluteFile),
      handle: transformDuplicateHandle(root, unit.handle),
      fileHandle: transformDuplicateHandle(root, unit.fileHandle),
      ...(unit.sqlHandle ? { sqlHandle: transformDuplicateHandle(root, unit.sqlHandle) } : {}),
      chunkHandle: transformDuplicateHandle(root, unit.chunkHandle),
      ...(unit.symbolHandle ? { symbolHandle: transformDuplicateHandle(root, unit.symbolHandle) } : {}),
    };
  });
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
