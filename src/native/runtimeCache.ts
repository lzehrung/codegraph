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

/**
 * How long an entry for another package version is kept before it is treated as abandoned.
 *
 * The cache root is per-user and shared by every project on the machine, so "not the version I
 * am installing" does not mean "nobody's". Deleting on that basis alone makes two projects
 * pinned to different native versions delete each other's entry on every run, each re-copying
 * 29 MB and never reaching the fast path - worse than the unbounded growth it set out to fix.
 *
 * An entry in use is re-verified at least every IDENTITY_REVERIFY_INTERVAL_MS of use, and that
 * refreshes its timestamp, so an entry older than this window is one no project has run in a
 * month. That is the signal, rather than which version happens to be installing right now.
 */
const ABANDONED_ENTRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
   * The runtime that proved this file loadable. The stat fields say the bytes are unchanged;
   * they say nothing about whether this Node can still load them. A major Node upgrade changes
   * the ABI, so the same bytes stop loading while every other check still matches, and the fast
   * path would report an addon as available that the build then falls back away from.
   */
  runtime: { abi: string; platform: string; arch: string };
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

function currentRuntimeStamp(): NativeCacheIdentityV1["runtime"] {
  return { abi: process.versions.modules, platform: process.platform, arch: process.arch };
}

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
  const runtime = candidate.runtime;
  if (!runtime || typeof runtime !== "object") return null;
  if (typeof runtime.abi !== "string" || typeof runtime.platform !== "string" || typeof runtime.arch !== "string") {
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

    const sourceRealPath = fs.realpathSync.native(request.sourcePath);
    const sourceStats = statOrNull(sourceRealPath);
    if (!sourceStats) return null;

    const runtime = currentRuntimeStamp();

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
      // Same version, same bytes, different install. The cache root is shared by every project
      // on the machine, and npm can produce byte-identical files with matching mtimes, so size
      // and mtime alone can match another project's record - whose sourcePath would then be
      // replayed into this build's binding origin and change its runtime fingerprint.
      if (identity.sourcePath !== sourceRealPath) continue;
      if (identity.sourceSize !== sourceStats.size || identity.sourceMtimeMs !== sourceStats.mtimeMs) continue;
      // Recorded by a runtime that could load the file. A different ABI cannot, and claiming
      // otherwise would report native as available for a build that falls back away from it.
      if (
        identity.runtime.abi !== runtime.abi ||
        identity.runtime.platform !== runtime.platform ||
        identity.runtime.arch !== runtime.arch
      ) {
        continue;
      }

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
  identity: Omit<
    NativeCacheIdentityV1,
    "version" | "sourceSize" | "sourceMtimeMs" | "cachedSize" | "cachedMtimeMs" | "runtime"
  >,
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
      runtime: currentRuntimeStamp(),
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

/**
 * When an entry was last known to be in use, and which version it holds.
 *
 * `identity.json` is refreshed whenever a process re-verifies the entry, so it is the freshest
 * signal; `manifest.json`'s `cachedAt` covers an entry that has never been loaded through the
 * fast path. An entry that yields neither is left alone rather than guessed about.
 */
function readEntrySummary(entryPath: string): { packageVersion: string; lastUsedMs: number } | null {
  let packageVersion: string | null = null;
  let cachedAtMs: number | null = null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(entryPath, "manifest.json"), "utf8"));
    if (parsed && typeof parsed === "object") {
      const manifest = parsed as Partial<NativeCacheManifestV1>;
      if (typeof manifest.packageVersion === "string" && manifest.packageVersion) {
        packageVersion = manifest.packageVersion;
      }
      const cachedAt = typeof manifest.cachedAt === "string" ? Date.parse(manifest.cachedAt) : Number.NaN;
      if (Number.isFinite(cachedAt)) cachedAtMs = cachedAt;
    }
  } catch {
    // Missing or malformed: indistinguishable from an entry another process is still writing.
    return null;
  }
  if (!packageVersion) return null;

  const identity = readCacheIdentity(entryPath);
  const verifiedAt = identity ? Date.parse(identity.verifiedAt) : Number.NaN;
  const lastUsedMs = Number.isFinite(verifiedAt) ? verifiedAt : cachedAtMs;
  if (lastUsedMs === null) return null;
  return { packageVersion, lastUsedMs };
}

/**
 * Delete entries that no project has used in a long time.
 *
 * The cache only ever grew: every upgrade left roughly 29 MB behind, and a machine that had
 * tracked a few releases carried well over a hundred megabytes of addons nothing would load
 * again. Keeping the directory small also keeps it warm, which is what the stat-only fast path
 * above depends on.
 *
 * Retention is by age rather than by version, because the cache root is per-user and shared by
 * every project on the machine. Removing "every version that is not the one installing" would
 * make two projects pinned to different native versions delete each other's entry on every run.
 *
 * Best effort throughout, and deliberately conservative:
 * - the entry just produced is never a candidate, nor is any entry for its version;
 * - an entry whose manifest is missing, unreadable, or undated is left alone, because that is
 *   what a concurrent population in progress looks like;
 * - Windows holds a lock on a loaded DLL, so removing an entry another process is running fails
 *   with EBUSY or EPERM. That is the mechanism the "never deletes an entry in use" guarantee
 *   rests on, so those failures are expected rather than exceptional and are simply skipped.
 */
function pruneAbandonedEntries(
  targetPath: string,
  cacheRoot: string,
  keepEntryPath: string,
  keepVersion: string,
  now: number,
): void {
  let entryNames: string[];
  try {
    entryNames = fs.readdirSync(targetPath);
  } catch {
    return;
  }

  for (const entryName of entryNames) {
    const entryPath = path.join(targetPath, entryName);
    if (entryPath === keepEntryPath) continue;
    if (!isWithinDirectory(entryPath, cacheRoot)) continue;
    try {
      if (!fs.lstatSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const summary = readEntrySummary(entryPath);
    if (!summary || summary.packageVersion === keepVersion) continue;
    if (now - summary.lastUsedMs < ABANDONED_ENTRY_RETENTION_MS) continue;
    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch {
      // In use, or not ours to remove. Either way the next install tries again.
    }
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

    // Only on the verified path. A fast-path hit means nothing new arrived, so there is nothing
    // to clean up, and the warm run stays free of extra directory work.
    pruneAbandonedEntries(targetPath, cacheRoot, entryPath, request.packageVersion, request.now ?? Date.now());

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
