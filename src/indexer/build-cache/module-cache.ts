import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { supportForFile } from "../../languages.js";
import { logWithLevel } from "../../logging.js";
import { SqliteDatabase } from "../../sqlite-driver.js";
import { buildBloomFilterFromSource } from "../../util/bloomFilter.js";
import type { BuildOptions, BuildReport, ModuleIndex } from "../types.js";
import { initCacheReport } from "./reports.js";

const PARSED_CACHE_VERSION = 1;

type ModuleCacheEntry = {
  version: number;
  sig: string;
  mod: ModuleIndex;
};

const memoryCache = new Map<string, ModuleCacheEntry>();
const diskCacheDatabases = new Map<string, SqliteDatabase>();

export function cacheRoot(projectRoot: string, opts?: BuildOptions): string {
  return opts?.cacheDir || path.join(projectRoot, ".codegraph-cache", "index-v1");
}

function diskCacheDatabasePath(projectRoot: string, opts?: BuildOptions): string {
  return path.join(cacheRoot(projectRoot, opts), "index-cache.sqlite").replace(/\\/g, "/");
}

function getDiskCacheDatabase(projectRoot: string, opts?: BuildOptions): SqliteDatabase {
  const dbPath = diskCacheDatabasePath(projectRoot, opts);
  const existing = diskCacheDatabases.get(dbPath);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new SqliteDatabase(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_cache (
      file TEXT PRIMARY KEY,
      sig TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_module_cache_sig ON module_cache(sig);
  `);
  diskCacheDatabases.set(dbPath, db);
  return db;
}

export function closeDiskCacheDatabase(projectRoot: string, opts?: BuildOptions): void {
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

export async function cacheSignatureForFile(file: string, sigInfo: FileSignature): Promise<string> {
  if (sigInfo.gitSig) return sigInfo.gitSig;
  if (sigInfo.contentHash) return sigInfo.contentHash;
  const contentHash = await fileContentHash(file);
  sigInfo.contentHash = contentHash;
  return contentHash;
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
    const entry = memoryCache.get(file);
    if (entry && entry.sig === sig) {
      if (cacheEnabled && cacheReport) cacheReport.hits += 1;
      return entry.mod;
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
    memoryCache.set(file, { version: PARSED_CACHE_VERSION, sig, mod });
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
