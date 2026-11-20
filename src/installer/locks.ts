import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizePathForDisplay } from "../util/package-info.js";
import { isFileSystemErrorCode } from "../util/errors.js";
import { isPlainRecord } from "../util/guards.js";

type InstallerLockSettings = {
  homeDir: string;
  env: Record<string, string | undefined>;
};

type InstallerLeaseMetadata = {
  owner: string;
  pid: number;
  leaseExpiresAt: string;
  /** Older leases lack the environment identity required for early dead-holder recovery. */
  host?: string;
  platform?: string;
  pidNamespace?: string;
  bootId?: string;
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
const LOCAL_HOST = os.hostname();
const LOCAL_PID_NAMESPACE = readLocalPidNamespace();
const LOCAL_BOOT_ID = readLocalBootId();

function readLocalPidNamespace(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    // An unavailable namespace cannot prove that a PID belongs to this environment.
    return undefined;
  }
}

function readLocalBootId(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    // Namespace numbers repeat across kernels; an unavailable boot identity cannot prove locality.
    return undefined;
  }
}

export function opencodeConfigHome(settings: InstallerLockSettings): string {
  const configHome = settings.env.XDG_CONFIG_HOME?.trim();
  return configHome || path.join(settings.homeDir, ".config");
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
  options?: { reclaimDeadLocalOwner?: boolean },
): Promise<T> {
  const lock = await acquireInstallerLeaseLock(lockPath, resourceName, options?.reclaimDeadLocalOwner);
  try {
    return await operation();
  } finally {
    await releaseInstallerLeaseLock(lock);
  }
}

async function acquireInstallerLeaseLock(
  lockPath: string,
  resourceName: string,
  reclaimDeadLocalOwner = false,
): Promise<InstallerLeaseLock> {
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
      const conflict = await resolveInstallerLeaseConflict(lockPath, reclaimDeadLocalOwner);
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

async function resolveInstallerLeaseConflict(
  lockPath: string,
  reclaimDeadLocalOwner: boolean,
): Promise<InstallerLeaseConflict> {
  // A blocking claim gets one fresh, expiry-only observation. Never reuse the early-reclaim observation.
  for (let allowEarlyReclaim = reclaimDeadLocalOwner; ; allowEarlyReclaim = false) {
    let observed: InstallerLeaseObservation;
    try {
      const stats = await fsp.lstat(lockPath);
      // Legacy directory locks and other non-files cannot be verified, so they are never removed.
      if (!stats.isFile()) return "blocked";
      observed = {
        content: await fsp.readFile(lockPath, "utf8"),
        mtimeMs: stats.mtimeMs,
      };
    } catch (error) {
      if (isFileSystemErrorCode(error, "ENOENT")) return "absent";
      return "blocked";
    }
    const metadata = parseInstallerLeaseMetadata(observed.content);
    if (metadata) {
      const leaseExpiresAt = Date.parse(metadata.leaseExpiresAt);
      if (Number.isNaN(leaseExpiresAt)) return "blocked";
      if (leaseExpiresAt <= Date.now()) {
        return await reclaimAbandonedInstallerLease(lockPath, observed, reclaimDeadLocalOwner);
      }
      if (allowEarlyReclaim && isProvablyDeadLocalOwner(metadata)) {
        const outcome = await reclaimDeadLocalLease(lockPath, observed);
        if (outcome === "live") continue;
        return outcome;
      }
      return "live";
    }
    // Corrupt metadata alone cannot authorize removal. A live holder renews every half lease.
    if (Date.now() - observed.mtimeMs < INSTALLER_LOCK_ABANDONED_MS) return "blocked";
    return await reclaimAbandonedInstallerLease(lockPath, observed, reclaimDeadLocalOwner);
  }
}

async function reclaimAbandonedInstallerLease(
  lockPath: string,
  observed: InstallerLeaseObservation,
  removeDeadClaim: boolean,
): Promise<InstallerLeaseConflict> {
  // Reuse the existing expiry detach/verify/restore procedure for early recovery as well.
  // It validates the detached file, not atomic acquisition: a late stale observer can still briefly
  // detach a replacement between observation and verification, as in the pre-existing expiry path.
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
    // Verify the observed bytes and mtime; reported inode identity may change across rename.
    verified =
      stats.isFile() &&
      stats.mtimeMs === observed.mtimeMs &&
      (await fsp.readFile(reclaimPath, "utf8")) === observed.content;
  } catch {
    verified = false;
  }
  if (verified) {
    await fsp.rm(reclaimPath, { force: true });
    if (removeDeadClaim) await fsp.rm(deadLocalLeaseClaimPath(lockPath, observed), { force: true });
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

function isProvablyDeadLocalOwner(metadata: InstallerLeaseMetadata): boolean {
  if (!metadata.host || metadata.host !== LOCAL_HOST || metadata.pid <= 0) return false;
  if (metadata.platform !== process.platform || metadata.pidNamespace !== LOCAL_PID_NAMESPACE) return false;
  if (metadata.bootId !== LOCAL_BOOT_ID) return false;
  if (process.platform === "linux" && (!LOCAL_PID_NAMESPACE || !LOCAL_BOOT_ID)) return false;
  try {
    process.kill(metadata.pid, 0);
    return false;
  } catch (error) {
    return isFileSystemErrorCode(error, "ESRCH");
  }
}

function deadLocalLeaseClaimPath(lockPath: string, observed: InstallerLeaseObservation): string {
  const claimKey = createHash("sha256").update(observed.content).digest("hex");
  return `${lockPath}.reclaim-dead-${claimKey}`;
}

/**
 * Gate early reclaimers of one observed dead lease with a shared claim name.
 * Expiry ignores claims after a fresh observation and retains the existing detach/verify window.
 */
async function reclaimDeadLocalLease(
  lockPath: string,
  observed: InstallerLeaseObservation,
): Promise<InstallerLeaseConflict> {
  const claimPath = deadLocalLeaseClaimPath(lockPath, observed);
  let claimed = false;
  try {
    await fsp.link(lockPath, claimPath);
    claimed = true;
    const claim = await fsp.lstat(claimPath);
    const published = await fsp.lstat(lockPath);
    if (!claim.isFile() || !published.isFile()) return "blocked";
    const hasFileIdentity = claim.ino !== 0 && published.ino !== 0;
    const sameIdentity = !hasFileIdentity || (claim.dev === published.dev && claim.ino === published.ino);
    const sameObservation = claim.mtimeMs === observed.mtimeMs && claim.size === published.size;
    if (!sameIdentity || !sameObservation || published.mtimeMs !== observed.mtimeMs) return "blocked";
    if ((await fsp.readFile(claimPath, "utf8")) !== observed.content) return "blocked";
    return await reclaimAbandonedInstallerLease(lockPath, observed, false);
  } catch (error) {
    if (isFileSystemErrorCode(error, "ENOENT")) return "absent";
    if (isInstallerLockPublishConflict(error, claimPath)) return "live";
    return "blocked";
  } finally {
    if (claimed) await fsp.rm(claimPath, { force: true });
  }
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
    host: LOCAL_HOST,
    platform: process.platform,
    ...(LOCAL_PID_NAMESPACE ? { pidNamespace: LOCAL_PID_NAMESPACE } : {}),
    ...(LOCAL_BOOT_ID ? { bootId: LOCAL_BOOT_ID } : {}),
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
      isPlainRecord(parsed) &&
      typeof parsed.owner === "string" &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.leaseExpiresAt === "string"
    ) {
      return {
        owner: parsed.owner,
        pid: parsed.pid,
        leaseExpiresAt: parsed.leaseExpiresAt,
        ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
        ...(typeof parsed.platform === "string" ? { platform: parsed.platform } : {}),
        ...(typeof parsed.pidNamespace === "string" ? { pidNamespace: parsed.pidNamespace } : {}),
        ...(typeof parsed.bootId === "string" ? { bootId: parsed.bootId } : {}),
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
  return import("../util/concurrency.js").then(({ delay }) => delay(INSTALLER_LOCK_RETRY_MS));
}
