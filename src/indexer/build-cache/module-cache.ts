import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { supportForFile } from "../../languages.js";
import { getNativeRuntimeFingerprint } from "../../native/treeSitterNative.js";
import { logWithLevel } from "../../logging.js";
import { SqliteDatabase } from "../../sqlite-driver.js";
import { buildBloomFilterFromSource } from "../../util/bloomFilter.js";
import {
  createSqliteTableIfMissing,
  ensureSqliteVersionedTableSchema,
  recreateSqliteTable,
  sqliteTableColumns,
  type SqliteTableColumn,
} from "../../util/sqliteSchema.js";
import type { BuildOptions, BuildReport, ModuleIndex } from "../types.js";
import { normalizePath } from "../../util/paths.js";
import { lruMapGet, lruMapSet } from "../../util/lruMap.js";
import { initCacheReport } from "./reports.js";

const PARSED_CACHE_VERSION = 1;
const MODULE_CACHE_SCHEMA_VERSION = 1;
const MODULE_CACHE_TABLE = "module_cache";
const MODULE_CACHE_SCHEMA_VERSION_KEY = "module_cache.schema_version";
const MODULE_CACHE_COLUMNS: readonly SqliteTableColumn[] = [
  { name: "file", definition: "TEXT PRIMARY KEY" },
  { name: "sig", definition: "TEXT NOT NULL" },
  { name: "version", definition: "INTEGER NOT NULL" },
  { name: "payload", definition: "TEXT NOT NULL" },
  { name: "updated_at", definition: "INTEGER NOT NULL" },
];

type ModuleCacheEntry = {
  version: number;
  sig: string;
  mod: ModuleIndex;
};

const MAX_MEMORY_CACHE_ENTRIES = 5000;
const memoryCache = new Map<string, ModuleCacheEntry>();
let cachedRuntimeFingerprint: string | undefined;
let cachedRuntimeHash: string | undefined;

function memoryCacheKey(projectRoot: string, file: string): string {
  return `${normalizePath(projectRoot)}::${file}`;
}

export function clearMemoryCache(): void {
  memoryCache.clear();
}

function clearMemoryCacheForProject(projectRoot: string): void {
  const prefix = `${normalizePath(projectRoot)}::`;
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) {
      memoryCache.delete(key);
    }
  }
}
const diskCacheDatabases = new Map<string, SqliteDatabase>();

export function cacheRoot(projectRoot: string, opts?: BuildOptions): string {
  return opts?.cacheDir || path.join(projectRoot, ".codegraph-cache", "index-v1");
}

export function cacheDatabasePath(projectRoot: string, opts: BuildOptions | undefined, filename: string): string {
  return path.join(cacheRoot(projectRoot, opts), filename).replace(/\\/g, "/");
}

function diskCacheDatabasePath(projectRoot: string, opts?: BuildOptions): string {
  return cacheDatabasePath(projectRoot, opts, "index-cache.sqlite");
}

function createModuleCacheTable(db: SqliteDatabase): void {
  createSqliteTableIfMissing(db, MODULE_CACHE_TABLE, MODULE_CACHE_COLUMNS);
}

function recreateModuleCacheTable(db: SqliteDatabase): void {
  recreateSqliteTable(db, MODULE_CACHE_TABLE, createModuleCacheTable);
}

function migrateModuleCacheTable(db: SqliteDatabase): void {
  const columns = sqliteTableColumns(db, MODULE_CACHE_TABLE);
  if (!columns.size) {
    createModuleCacheTable(db);
    return;
  }
  if (!columns.has("file")) {
    recreateModuleCacheTable(db);
    return;
  }
  if (!columns.has("sig")) db.exec("ALTER TABLE module_cache ADD COLUMN sig TEXT NOT NULL DEFAULT '';");
  if (!columns.has("version")) db.exec("ALTER TABLE module_cache ADD COLUMN version INTEGER NOT NULL DEFAULT 0;");
  if (!columns.has("payload")) db.exec("ALTER TABLE module_cache ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';");
  if (!columns.has("updated_at")) db.exec("ALTER TABLE module_cache ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;");
}

function ensureModuleCacheSchema(db: SqliteDatabase): void {
  ensureSqliteVersionedTableSchema({
    db,
    tableName: MODULE_CACHE_TABLE,
    schemaVersionKey: MODULE_CACHE_SCHEMA_VERSION_KEY,
    schemaVersion: MODULE_CACHE_SCHEMA_VERSION,
    createTable: createModuleCacheTable,
    migrateTable: migrateModuleCacheTable,
  });
  db.exec("CREATE INDEX IF NOT EXISTS idx_module_cache_sig ON module_cache(sig);");
}

function getDiskCacheDatabase(projectRoot: string, opts?: BuildOptions): SqliteDatabase {
  const dbPath = diskCacheDatabasePath(projectRoot, opts);
  const existing = diskCacheDatabases.get(dbPath);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new SqliteDatabase(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  ensureModuleCacheSchema(db);
  diskCacheDatabases.set(dbPath, db);
  return db;
}

export function closeDiskCacheDatabase(projectRoot: string, opts?: BuildOptions): void {
  clearMemoryCacheForProject(projectRoot);
  const dbPath = diskCacheDatabasePath(projectRoot, opts);
  const db = diskCacheDatabases.get(dbPath);
  if (!db) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // checkpoint best-effort
  }
  try {
    db.close();
    diskCacheDatabases.delete(dbPath);
  } catch {
    // Keep handle for later retry if close fails.
  }
}

async function fileContentHash(file: string): Promise<string> {
  const buffer = await fsp.readFile(file);
  const hash = crypto.createHash("sha1");
  hash.update(buffer);
  return hash.digest("hex");
}

async function fileStatSignature(
  file: string,
  strict?: boolean,
  opts?: { includeContentHash?: boolean },
): Promise<{ sig: string; contentHash?: string }> {
  try {
    const stat = await fsp.stat(file);
    const useStrict = strict ?? true;
    const shouldHash = useStrict || !!opts?.includeContentHash;
    const contentHash = shouldHash ? await fileContentHash(file) : undefined;
    if (!useStrict) {
      return contentHash
        ? { sig: `${stat.mtimeMs}:${stat.size}`, contentHash }
        : { sig: `${stat.mtimeMs}:${stat.size}` };
    }
    if (contentHash) {
      return {
        sig: `${stat.mtimeMs}:${stat.size}:${contentHash}`,
        contentHash,
      };
    }
    return { sig: `${stat.mtimeMs}:${stat.size}` };
  } catch {
    return { sig: "0:0" };
  }
}

export type FileSignature = {
  sig: string;
  gitSig?: string;
  cacheSig: string;
  contentHash?: string;
};

export async function fileSignature(
  file: string,
  strict?: boolean,
  gitSig?: string,
  opts?: { forceContentHash?: boolean },
): Promise<FileSignature> {
  const includeContentHash = !!opts?.forceContentHash;
  const statOpts = includeContentHash ? { includeContentHash: true } : undefined;
  const { sig, contentHash } = await fileStatSignature(file, strict, statOpts);
  const cacheSig = gitSig ?? contentHash ?? sig;
  if (gitSig) {
    return {
      sig,
      gitSig,
      cacheSig,
      ...(contentHash ? { contentHash } : {}),
    };
  }
  return { sig, cacheSig, ...(contentHash ? { contentHash } : {}) };
}

export async function cacheSignatureForFile(
  file: string,
  sigInfo: FileSignature,
  opts?: BuildOptions,
): Promise<string> {
  let contentSignature = sigInfo.gitSig ?? sigInfo.contentHash;
  if (!contentSignature) {
    contentSignature = await fileContentHash(file);
    sigInfo.contentHash = contentSignature;
  }
  const runtimeFingerprint = getNativeRuntimeFingerprint(opts?.native);
  if (runtimeFingerprint !== cachedRuntimeFingerprint || !cachedRuntimeHash) {
    cachedRuntimeFingerprint = runtimeFingerprint;
    cachedRuntimeHash = crypto.createHash("sha256").update(runtimeFingerprint).digest("hex");
  }
  const runtimeHash = cachedRuntimeHash;
  return `${contentSignature}:${runtimeHash}`;
}

export async function buildBloomFilterForFile(
  file: string,
): Promise<import("../../util/bloomFilter.js").BloomFilter | null> {
  try {
    const source = await fsp.readFile(file, "utf8");
    const support = supportForFile(file);
    if (!support) return null;
    return buildBloomFilterFromSource(source, support.id);
  } catch {
    return null;
  }
}

function isModuleIndex(value: unknown): value is ModuleIndex {
  if (!value || typeof value !== "object") return false;
  const mod = value as {
    file?: unknown;
    exports?: unknown;
    imports?: unknown;
    locals?: unknown;
  };
  return (
    typeof mod.file === "string" &&
    Array.isArray(mod.exports) &&
    Array.isArray(mod.imports) &&
    Array.isArray(mod.locals)
  );
}

export function tryLoadFromCache(
  projectRoot: string,
  file: string,
  sig: string,
  opts?: BuildOptions,
  report?: BuildReport,
): ModuleIndex | null {
  const mode = opts?.cache ?? "off";
  const cacheReport = initCacheReport(report, mode);
  const cacheEnabled = mode !== "off";
  if (mode === "memory") {
    const key = memoryCacheKey(projectRoot, file);
    const entry = memoryCache.get(key);
    if (entry) {
      if (entry.sig === sig) {
        lruMapGet(memoryCache, key);
        if (cacheEnabled && cacheReport) cacheReport.hits += 1;
        return entry.mod;
      }
      memoryCache.delete(key);
    }
    if (cacheEnabled && cacheReport) cacheReport.misses += 1;
    return null;
  }
  if (mode === "disk") {
    try {
      const db = getDiskCacheDatabase(projectRoot, opts);
      const row = db.prepare("SELECT sig, version, payload FROM module_cache WHERE file = ?").get(file) as
        | { sig: string; version: number; payload: string }
        | undefined;
      if (row && row.sig === sig && row.version === PARSED_CACHE_VERSION) {
        const parsed: unknown = JSON.parse(row.payload);
        if (isModuleIndex(parsed)) {
          if (cacheEnabled && cacheReport) cacheReport.hits += 1;
          return parsed;
        }
      }
    } catch {
      // cache read failed
    }
    if (cacheEnabled && cacheReport) cacheReport.misses += 1;
  }
  return null;
}

export function writeToCache(
  projectRoot: string,
  file: string,
  sig: string,
  mod: ModuleIndex,
  opts?: BuildOptions,
): void {
  const mode = opts?.cache ?? "off";
  if (mode === "memory") {
    lruMapSet(
      memoryCache,
      memoryCacheKey(projectRoot, file),
      { version: PARSED_CACHE_VERSION, sig, mod },
      MAX_MEMORY_CACHE_ENTRIES,
    );
  } else if (mode === "disk") {
    try {
      const db = getDiskCacheDatabase(projectRoot, opts);
      db.prepare(
        `INSERT INTO module_cache (file, sig, version, payload, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(file) DO UPDATE SET
           sig = excluded.sig,
           version = excluded.version,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
      ).run(file, sig, PARSED_CACHE_VERSION, JSON.stringify(mod), Date.now());
    } catch (error) {
      logWithLevel(opts?.logLevel, "warn", "Warning: Failed to write to cache:", error);
    }
  }
}
