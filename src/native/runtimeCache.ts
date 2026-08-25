import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { NativeBindingOrigin } from "./contracts.js";

const CACHE_SCHEMA_VERSION = 1;
const HASH_BUFFER_SIZE = 1024 * 1024;
const IDENTITY_FILE_NAME = "identity.json";
const IDENTITY_VERSION = 1;

/**
 * How long a stat-only match is trusted before the entry is hashed again.
 *
 * The fast path below skips two 29 MB SHA-256 passes when the source and cached binaries
 * both match the size and mtime recorded at the last full verification. That is weaker than
 * hashing: an attacker who can write the cache directory can also preserve both fields. The
 * TTL bounds how long such a substitution goes unnoticed, so verification still happens -
 * once a day per entry instead of twice per process.
 */
const IDENTITY_REVERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type NativeCacheManifestV1 = {
  schemaVersion: 1;
  packageName: string;
  packageVersion: string;
  target: string;
  sourceFileName: string;
  sourceSize: number;
  sourceSha256: string;
  cachedAt: string;
};

/**
 * Written beside `manifest.json` after a process has successfully loaded the cached binary.
 *
 * It is deliberately a separate file rather than extra manifest fields. `manifest.json` is
 * content-addressed and published once, immutably; this record is mutable (the TTL refreshes
 * it) and carries facts that are only known after the addon loads. Keeping them apart means
 * an entry written by an older version stays valid and simply misses the fast path.
 */
export type NativeCacheIdentityV1 = {
  version: 1;
  /** Size and mtime of the installed source binary at the last full verification. */
  sourceSize: number;
  sourceMtimeMs: number;
  /** Size and mtime of the cached copy that was verified and then loaded. */
  cachedSize: number;
  cachedMtimeMs: number;
  sha256: string;
  cacheKey: string;
  sourcePath: string;
  loadedPath: string;
  verifiedAt: string;
  /**
   * Recorded so a cache-hit command can answer "which languages does the addon support"
   * without loading it. Present only once a load has succeeded for this exact file.
   */
  supportedLanguageIds: string[];
  /**
   * The origin the loading process reported, stored whole rather than rebuilt field by field.
   * The runtime fingerprint embeds this object verbatim, so replaying it is what guarantees a
   * fast-path fingerprint is byte-identical to the one a full load produces.
   */
  origin: NativeBindingOrigin;
};

export type PrepareNativeRuntimeCacheRequest = {
  sourcePath: string;
  packageName: string;
  packageVersion: string;
  target: string;
  cacheRoot?: string | undefined;
  /** Injected in tests so the identity TTL branch is reachable without waiting a day. */
  now?: number | undefined;
};

export type PrepareNativeRuntimeCacheResult =
  | {
      status: "cached" | "reused";
      sourcePath: string;
      loadedPath: string;
      cacheKey: string;
      sha256: string;
      /**
       * True when this call hashed the files rather than trusting a recorded identity. Only a
       * verified result may refresh the identity record, otherwise each fast-path hit would
       * push the re-verification TTL out and the entry would never be hashed again.
       */
      verified: boolean;
    }
  | {
      status: "unavailable";
      sourcePath: string;
      error: Error;
    };

type FileHash = {
  sha256: string;
  size: number;
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isWithinDirectory(filePath: string, directoryPath: string): boolean {
  const relative = path.relative(directoryPath, filePath);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSafeCacheSegment(value: string, label: string): void {
  if (!value || value === "." || value === ".." || path.basename(value) !== value) {
    throw new Error(`invalid native cache ${label}: ${value}`);
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(value)) {
    throw new Error(`invalid native cache ${label}: ${value}`);
  }
}

function assertSafePathComponent(componentPath: string): void {
  const stats = fs.lstatSync(componentPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`unsafe native cache path component: ${componentPath}`);
  }
}

function prepareSafeDirectory(directoryPath: string): string {
  const absolute = path.resolve(directoryPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  assertSafePathComponent(current);

  const relativeParts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of relativeParts) {
    current = path.join(current, part);
    try {
      assertSafePathComponent(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      try {
        fs.mkdirSync(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      assertSafePathComponent(current);
    }
  }

  return fs.realpathSync.native(absolute);
}

function findProductionCacheRoot(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  return path.join(localAppData, "codegraph", "native-cache", `v${CACHE_SCHEMA_VERSION}`);
}

function resolveProductionCacheRoot(): string {
  const cacheRoot = findProductionCacheRoot();
  if (!cacheRoot) {
    throw new Error("LOCALAPPDATA is unavailable; cannot prepare the Windows native runtime cache");
  }
  return cacheRoot;
}

export function hashFileStreaming(filePath: string, onChunk?: (bytesRead: number) => void): FileHash {
  const before = fs.statSync(filePath);
  if (!before.isFile() || before.size <= 0) {
    throw new Error(`native binary is not a non-empty regular file: ${filePath}`);
  }

  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE);
  const descriptor = fs.openSync(filePath, "r");
  let size = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
      onChunk?.(bytesRead);
    }
  } finally {
    fs.closeSync(descriptor);
  }

  if (size !== before.size) {
    throw new Error(`native binary changed while hashing: ${filePath}`);
  }
  return { sha256: hash.digest("hex"), size };
}

function randomSuffix(): string {
  return `${process.pid}.${randomBytes(8).toString("hex")}`;
}

function copyFileExclusive(sourcePath: string, destinationPath: string): void {
  const source = fs.openSync(sourcePath, "r");
  let destination: number | undefined;
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE);
  try {
    destination = fs.openSync(destinationPath, "wx");
    while (true) {
      const bytesRead = fs.readSync(source, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(destination, buffer, written, bytesRead - written);
      }
    }
    fs.fsyncSync(destination);
  } finally {
    if (destination !== undefined) fs.closeSync(destination);
    fs.closeSync(source);
  }
}

function removeRegularTemporaryFile(filePath: string): void {
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isFile() && !stats.isSymbolicLink()) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup. A later bounded cleanup may remove abandoned temporary files.
  }
}

function verifyFile(filePath: string, expected: FileHash): boolean {
  try {
    const actual = hashFileStreaming(filePath);
    return actual.size === expected.size && actual.sha256 === expected.sha256;
  } catch {
    return false;
  }
}

function publishExclusive(temporaryPath: string, finalPath: string): boolean {
  try {
    fs.linkSync(temporaryPath, finalPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    removeRegularTemporaryFile(temporaryPath);
  }
}

function populateBinary(sourcePath: string, finalPath: string, expected: FileHash): boolean {
  const temporaryPath = `${finalPath}.${randomSuffix()}.tmp`;
  try {
    copyFileExclusive(sourcePath, temporaryPath);
    if (!verifyFile(temporaryPath, expected)) {
      throw new Error("native cache temporary file failed integrity verification");
    }
    return publishExclusive(temporaryPath, finalPath);
  } catch (error) {
    removeRegularTemporaryFile(temporaryPath);
    throw error;
  }
}

function recoverCorruptFinal(finalPath: string): void {
  const recoveryPath = `${finalPath}.corrupt.${randomSuffix()}`;
  fs.renameSync(finalPath, recoveryPath);
}

function writeManifest(entryPath: string, manifest: NativeCacheManifestV1): void {
  const finalPath = path.join(entryPath, "manifest.json");
  if (fs.existsSync(finalPath)) return;

  const temporaryPath = `${finalPath}.${randomSuffix()}.tmp`;
  try {
    const descriptor = fs.openSync(temporaryPath, "wx");
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    publishExclusive(temporaryPath, finalPath);
  } catch (error) {
    removeRegularTemporaryFile(temporaryPath);
    throw error;
  }
}

export type NativeCacheLookupRequest = {
  sourcePath: string;
  packageVersion: string;
  target: string;
  cacheRoot?: string | undefined;
  /** Injected in tests so the TTL branch is reachable without waiting a day. */
  now?: number | undefined;
};

export type NativeCacheLookupHit = {
  entryPath: string;
  identity: NativeCacheIdentityV1;
};

function identityFilePath(entryPath: string): string {
  return path.join(entryPath, IDENTITY_FILE_NAME);
}

function readCacheIdentity(entryPath: string): NativeCacheIdentityV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(identityFilePath(entryPath), "utf8"));
  } catch {
    // Absent (an entry written before this file existed), unreadable, or malformed. All three
    // mean the same thing to the caller: no fast path, fall back to hashing.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<NativeCacheIdentityV1>;
  if (candidate.version !== IDENTITY_VERSION) return null;
  const numbers = [candidate.sourceSize, candidate.sourceMtimeMs, candidate.cachedSize, candidate.cachedMtimeMs];
  if (numbers.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
  const strings = [
    candidate.sha256,
    candidate.cacheKey,
    candidate.sourcePath,
    candidate.loadedPath,
    candidate.verifiedAt,
  ];
  if (strings.some((value) => typeof value !== "string" || !value)) return null;
  if (!Array.isArray(candidate.supportedLanguageIds)) return null;
  if (candidate.supportedLanguageIds.some((value) => typeof value !== "string")) return null;
  const origin = candidate.origin;
  if (!origin || typeof origin !== "object" || origin.mode !== "cache" || typeof origin.packageName !== "string") {
    return null;
  }
  return candidate as NativeCacheIdentityV1;
}

function statOrNull(filePath: string): fs.Stats | null {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

/**
 * Find a cache entry for this (package version, target) whose recorded identity still matches
 * the files on disk, without hashing either of them.
 *
 * The entry directory is named `<packageVersion>-<sha256>`, so locating it the normal way means
 * hashing the source first. Scanning the target directory for the version prefix and comparing
 * the stat fields recorded at the last full verification reaches the same entry for the cost of
 * a readdir plus two stats. A miss - no entry, no identity file, a stat mismatch, or an expired
 * TTL - returns null, and every caller then does the full hash-and-verify pass.
 */
export function lookupNativeRuntimeCacheEntry(request: NativeCacheLookupRequest): NativeCacheLookupHit | null {
  try {
    assertSafeCacheSegment(request.target, "target");
    assertSafeCacheSegment(request.packageVersion, "package version");
    const cacheRoot = request.cacheRoot ?? findProductionCacheRoot();
    if (!cacheRoot) return null;

    const sourceStats = statOrNull(fs.realpathSync.native(request.sourcePath));
    if (!sourceStats) return null;

    const targetPath = path.join(path.resolve(cacheRoot), request.target);
    const prefix = `${request.packageVersion}-`;
    let entryNames: string[];
    try {
      entryNames = fs.readdirSync(targetPath);
    } catch {
      return null;
    }

    const now = request.now ?? Date.now();
    for (const entryName of entryNames) {
      if (!entryName.startsWith(prefix)) continue;
      const entryPath = path.join(targetPath, entryName);
      const identity = readCacheIdentity(entryPath);
      if (!identity) continue;
      if (identity.sourceSize !== sourceStats.size || identity.sourceMtimeMs !== sourceStats.mtimeMs) continue;

      const cachedStats = statOrNull(identity.loadedPath);
      if (!cachedStats) continue;
      if (identity.cachedSize !== cachedStats.size || identity.cachedMtimeMs !== cachedStats.mtimeMs) continue;

      const verifiedAt = Date.parse(identity.verifiedAt);
      if (!Number.isFinite(verifiedAt) || now - verifiedAt >= IDENTITY_REVERIFY_INTERVAL_MS) continue;
      if (!isWithinDirectory(identity.loadedPath, path.resolve(cacheRoot))) continue;

      return { entryPath, identity };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Record what a successful load proved about this entry, so the next process can skip both
 * SHA-256 passes and the addon load itself. Called only after the binary at `loadedPath` has
 * been fully verified and then loaded, so every field describes a state known to work.
 *
 * Replaces any previous record atomically: the TTL refresh rewrites it, unlike the immutable
 * `manifest.json` beside it.
 */
export function recordNativeRuntimeCacheIdentity(
  identity: Omit<NativeCacheIdentityV1, "version" | "sourceSize" | "sourceMtimeMs" | "cachedSize" | "cachedMtimeMs">,
): void {
  try {
    const sourceStats = statOrNull(identity.sourcePath);
    const cachedStats = statOrNull(identity.loadedPath);
    if (!sourceStats || !cachedStats) return;

    const entryPath = path.dirname(identity.loadedPath);
    const record: NativeCacheIdentityV1 = {
      version: IDENTITY_VERSION,
      sourceSize: sourceStats.size,
      sourceMtimeMs: sourceStats.mtimeMs,
      cachedSize: cachedStats.size,
      cachedMtimeMs: cachedStats.mtimeMs,
      ...identity,
    };

    const finalPath = identityFilePath(entryPath);
    const temporaryPath = `${finalPath}.${randomSuffix()}.tmp`;
    try {
      const descriptor = fs.openSync(temporaryPath, "wx");
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporaryPath, finalPath);
    } catch {
      removeRegularTemporaryFile(temporaryPath);
    }
  } catch {
    // Best effort. Failing to record identity costs the next process the slow path, nothing more.
  }
}

export function prepareNativeRuntimeCache(request: PrepareNativeRuntimeCacheRequest): PrepareNativeRuntimeCacheResult {
  const sourcePath = path.resolve(request.sourcePath);
  try {
    assertSafeCacheSegment(request.target, "target");
    assertSafeCacheSegment(request.packageVersion, "package version");

    // Cheap-identity fast path: a previous process verified this exact pair of files and
    // recorded their stat fields, so nothing here needs to be hashed. Population and every
    // mismatch still take the full path below.
    const hit = lookupNativeRuntimeCacheEntry({
      sourcePath,
      packageVersion: request.packageVersion,
      target: request.target,
      ...(request.cacheRoot !== undefined ? { cacheRoot: request.cacheRoot } : {}),
      ...(request.now !== undefined ? { now: request.now } : {}),
    });
    if (hit) {
      return {
        status: "reused",
        sourcePath: hit.identity.sourcePath,
        loadedPath: hit.identity.loadedPath,
        cacheKey: hit.identity.cacheKey,
        sha256: hit.identity.sha256,
        verified: false,
      };
    }

    const sourceRealPath = fs.realpathSync.native(sourcePath);
    const source = hashFileStreaming(sourceRealPath);
    const cacheRoot = prepareSafeDirectory(request.cacheRoot ?? resolveProductionCacheRoot());
    const targetPath = prepareSafeDirectory(path.join(cacheRoot, request.target));
    if (!isWithinDirectory(targetPath, cacheRoot)) {
      throw new Error("native cache target escaped the cache root");
    }

    const cacheKey = `${request.packageName}@${request.packageVersion}:${request.target}:${source.sha256}`;
    const entryPath = prepareSafeDirectory(path.join(targetPath, `${request.packageVersion}-${source.sha256}`));
    if (!isWithinDirectory(entryPath, cacheRoot)) {
      throw new Error("native cache entry escaped the cache root");
    }

    const sourceFileName = path.basename(sourceRealPath);
    const finalPath = path.join(entryPath, sourceFileName);
    let status: "cached" | "reused" = "reused";
    const finalExists = fs.existsSync(finalPath);
    if (!finalExists || !verifyFile(finalPath, source)) {
      if (finalExists) recoverCorruptFinal(finalPath);
      status = populateBinary(sourceRealPath, finalPath, source) ? "cached" : "reused";
      if (!verifyFile(finalPath, source)) {
        throw new Error("native cache winner failed integrity verification");
      }
    }

    writeManifest(entryPath, {
      schemaVersion: CACHE_SCHEMA_VERSION,
      packageName: request.packageName,
      packageVersion: request.packageVersion,
      target: request.target,
      sourceFileName,
      sourceSize: source.size,
      sourceSha256: source.sha256,
      cachedAt: new Date().toISOString(),
    });

    return {
      status,
      sourcePath: sourceRealPath,
      loadedPath: finalPath,
      cacheKey,
      sha256: source.sha256,
      verified: true,
    };
  } catch (error) {
    return { status: "unavailable", sourcePath, error: asError(error) };
  }
}
