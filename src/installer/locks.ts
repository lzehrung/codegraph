import { createHash, randomUUID } from "node:crypto";
import fsp, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizePathForDisplay } from "../util/packageInfo.js";

type InstallerLockSettings = {
  homeDir: string;
  env: Record<string, string | undefined>;
};

type InstallerLeaseMetadata = {
  owner: string;
  pid: number;
  leaseExpiresAt: string;
};

type InstallerLeaseLock = {
  file: FileHandle;
  lockPath: string;
  metadataPath: string;
  owner: string;
  renewalTimer: NodeJS.Timeout;
};

type InstallerLeaseConflict = "absent" | "reclaimed" | "live" | "blocked";

type InstallerLeaseObservation = {
  content: string;
  mtimeMs: number;
};

const INSTALLER_LOCK_RETRIES = 100;
const INSTALLER_LOCK_RETRY_MS = 20;
const INSTALLER_LOCK_LEASE_MS = 30_000;
const INSTALLER_LOCK_ABANDONED_MS = INSTALLER_LOCK_LEASE_MS * 2;

function opencodeConfigHome(settings: InstallerLockSettings): string {
  const configHome = settings.env.XDG_CONFIG_HOME?.trim();
  return configHome || path.join(settings.homeDir, ".config");
}

function isFileSystemErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && String(error.code) === code;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function withInstallerTransactionLocks<T>(
  settings: InstallerLockSettings,
  operation: () => Promise<T>,
): Promise<T> {
  const locks: InstallerLeaseLock[] = [];
  const scopedLocks = installerTransactionLockScopes(settings)
    .map((scope) => ({
      scope,
      lockPath: installerTransactionLockPath(scope),
    }))
    .sort((left, right) => left.lockPath.localeCompare(right.lockPath));
  try {
    for (const scopedLock of scopedLocks) {
      locks.push(
        await acquireInstallerLeaseLock(
          scopedLock.lockPath,
          `installer transaction for ${normalizePathForDisplay(scopedLock.scope)}`,
        ),
      );
    }
    return await operation();
  } finally {
    for (const lock of locks.reverse()) {
      await releaseInstallerLeaseLock(lock);
    }
  }
}

export function installerTransactionLockScopes(settings: InstallerLockSettings): string[] {
  const scopes = [path.resolve(settings.homeDir), path.resolve(opencodeConfigHome(settings))];
  const codexHome = settings.env.CODEX_HOME?.trim();
  if (codexHome) scopes.push(path.resolve(codexHome));
  scopes.sort();
  return scopes.filter((scope, index) => index === 0 || scope !== scopes[index - 1]);
}

function installerTransactionLockPath(scope: string): string {
  const digest = createHash("sha256").update(scope).digest("hex");
  return path.join(os.tmpdir(), `codegraph-installer-${digest}.lock`);
}

export async function withInstallerLeaseLock<T>(
  lockPath: string,
  resourceName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireInstallerLeaseLock(lockPath, resourceName);
  try {
    return await operation();
  } finally {
    await releaseInstallerLeaseLock(lock);
  }
}

async function acquireInstallerLeaseLock(lockPath: string, resourceName: string): Promise<InstallerLeaseLock> {
  let lastConflict: InstallerLeaseConflict = "live";
  for (let attempt = 0; attempt < INSTALLER_LOCK_RETRIES; attempt += 1) {
    const acquisitionPath = `${lockPath}.acquire-${randomUUID()}`;
    let published = false;
    let file: FileHandle | undefined;
    try {
      const owner = randomUUID();
      file = await fsp.open(acquisitionPath, "wx", 0o600);
      await writeInstallerLeaseMetadata(file, owner);
      await file.close();
      file = undefined;
      await fsp.link(acquisitionPath, lockPath);
      published = true;
      await fsp.rm(acquisitionPath, { force: true });
      file = await fsp.open(lockPath, "r+");
      const lockFile = file;
      const renewalTimer = setInterval(
        () => {
          void writeInstallerLeaseMetadata(lockFile, owner).catch(() => undefined);
        },
        Math.floor(INSTALLER_LOCK_LEASE_MS / 2),
      );
      renewalTimer.unref();
      return { file: lockFile, lockPath, metadataPath: lockPath, owner, renewalTimer };
    } catch (error) {
      await file?.close().catch(() => undefined);
      await fsp.rm(acquisitionPath, { force: true }).catch(() => undefined);
      if (published) await fsp.rm(lockPath, { force: true }).catch(() => undefined);
      if (!isInstallerLockPublishConflict(error, lockPath)) throw error;
      const conflict = await resolveInstallerLeaseConflict(lockPath);
      if (conflict === "absent" || conflict === "reclaimed") continue;
      lastConflict = conflict;
      await waitForInstallerLockRetry();
    }
  }
  if (lastConflict === "live") {
    throw new Error(`Another Codegraph installer is still updating ${resourceName}.`);
  }
  throw new Error(
    `Codegraph installer found an existing lock at ${normalizePathForDisplay(lockPath)} while updating ${resourceName}, ` +
      "but the lock could not be safely reclaimed because its metadata is corrupt, unreadable, or still potentially live. " +
      "The lock was left untouched. If no other Codegraph installer is running, delete that lock file and retry.",
  );
}

async function resolveInstallerLeaseConflict(lockPath: string): Promise<InstallerLeaseConflict> {
  let observed: InstallerLeaseObservation;
  try {
    const stats = await fsp.lstat(lockPath);
    // Legacy directory locks and other non-files cannot be verified, so they are never removed.
    if (!stats.isFile()) return "blocked";
    observed = { content: await fsp.readFile(lockPath, "utf8"), mtimeMs: stats.mtimeMs };
  } catch (error) {
    if (isFileSystemErrorCode(error, "ENOENT")) return "absent";
    return "blocked";
  }
  const metadata = parseInstallerLeaseMetadata(observed.content);
  if (metadata) {
    const leaseExpiresAt = Date.parse(metadata.leaseExpiresAt);
    if (Number.isNaN(leaseExpiresAt)) return "blocked";
    if (leaseExpiresAt > Date.now()) return "live";
    return await reclaimAbandonedInstallerLease(lockPath, observed);
  }
  // Corrupt metadata never authorizes removal on its own. A live owner renews the lock every
  // half lease, so only a lock untouched for two full lease intervals provably has no live
  // renewer and is safe to reclaim.
  if (Date.now() - observed.mtimeMs < INSTALLER_LOCK_ABANDONED_MS) return "blocked";
  return await reclaimAbandonedInstallerLease(lockPath, observed);
}

async function reclaimAbandonedInstallerLease(
  lockPath: string,
  observed: InstallerLeaseObservation,
): Promise<InstallerLeaseConflict> {
  // Detach the lock from its published name first. A fresh acquirer can only publish at
  // lockPath after this rename, so whatever sits at reclaimPath afterwards is exactly the
  // lease that was moved, and compare-before-delete below stays race-free for it.
  const reclaimPath = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    await fsp.rename(lockPath, reclaimPath);
  } catch (error) {
    if (isFileSystemErrorCode(error, "ENOENT")) return "absent";
    return "blocked";
  }
  let verified = false;
  try {
    const stats = await fsp.lstat(reclaimPath);
    verified =
      stats.isFile() &&
      stats.mtimeMs === observed.mtimeMs &&
      (await fsp.readFile(reclaimPath, "utf8")) === observed.content;
  } catch {
    verified = false;
  }
  if (verified) {
    await fsp.rm(reclaimPath, { force: true });
    return "reclaimed";
  }
  // The moved lock is not the abandoned lease that was vetted: another installer owns it.
  // Restore it without ever overwriting a lock published at lockPath in the meantime.
  try {
    await fsp.link(reclaimPath, lockPath);
  } catch {
    // Another installer already published a fresh lock at lockPath; never replace it.
  }
  await fsp.rm(reclaimPath, { force: true });
  return "blocked";
}

function isInstallerLockPublishConflict(error: unknown, lockPath: string): boolean {
  if (isFileSystemErrorCode(error, "EEXIST")) return true;
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "EPERM" &&
    "syscall" in error &&
    error.syscall === "link" &&
    "dest" in error &&
    typeof error.dest === "string" &&
    path.resolve(error.dest) === path.resolve(lockPath)
  );
}

async function writeInstallerLeaseMetadata(file: FileHandle, owner: string): Promise<void> {
  const metadata: InstallerLeaseMetadata = {
    owner,
    pid: process.pid,
    leaseExpiresAt: new Date(Date.now() + INSTALLER_LOCK_LEASE_MS).toISOString(),
  };
  const content = `${JSON.stringify(metadata)}\n`;
  await file.write(content, 0, "utf8");
  await file.truncate(Buffer.byteLength(content));
}

function parseInstallerLeaseMetadata(content: string): InstallerLeaseMetadata | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      isJsonRecord(parsed) &&
      typeof parsed.owner === "string" &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.leaseExpiresAt === "string"
    ) {
      return {
        owner: parsed.owner,
        pid: parsed.pid,
        leaseExpiresAt: parsed.leaseExpiresAt,
      };
    }
  } catch {
    // Malformed metadata cannot authorize lock removal.
  }
  return null;
}

async function releaseInstallerLeaseLock(lock: InstallerLeaseLock): Promise<void> {
  clearInterval(lock.renewalTimer);
  await lock.file.close().catch(() => undefined);
  try {
    const metadata = parseInstallerLeaseMetadata(await fsp.readFile(lock.metadataPath, "utf8"));
    if (metadata?.owner === lock.owner) await fsp.rm(lock.lockPath, { force: true });
  } catch (error) {
    if (!isFileSystemErrorCode(error, "ENOENT")) throw error;
  }
}

export function waitForInstallerLockRetry(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, INSTALLER_LOCK_RETRY_MS);
  return promise;
}
