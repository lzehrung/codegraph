import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CACHE_SCHEMA_VERSION = 1;
const HASH_BUFFER_SIZE = 1024 * 1024;

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

export type PrepareNativeRuntimeCacheRequest = {
  sourcePath: string;
  packageName: string;
  packageVersion: string;
  target: string;
  cacheRoot?: string | undefined;
};

export type PrepareNativeRuntimeCacheResult =
  | {
      status: "cached" | "reused";
      sourcePath: string;
      loadedPath: string;
      cacheKey: string;
      sha256: string;
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

function resolveProductionCacheRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is unavailable; cannot prepare the Windows native runtime cache");
  }
  return path.join(localAppData, "codegraph", "native-cache", `v${CACHE_SCHEMA_VERSION}`);
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

export function prepareNativeRuntimeCache(request: PrepareNativeRuntimeCacheRequest): PrepareNativeRuntimeCacheResult {
  const sourcePath = path.resolve(request.sourcePath);
  try {
    assertSafeCacheSegment(request.target, "target");
    assertSafeCacheSegment(request.packageVersion, "package version");
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
    if (!verifyFile(finalPath, source)) {
      if (fs.existsSync(finalPath)) recoverCorruptFinal(finalPath);
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
    };
  } catch (error) {
    return { status: "unavailable", sourcePath, error: asError(error) };
  }
}
