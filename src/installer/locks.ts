import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { debuglog } from "node:util";
import { assertNativeRequiredAvailable, loadBinding } from "../native/runtime.js";
import type { NativeExclusiveLock } from "../native/contracts.js";
import { resolveCodegraphUserStateRoot } from "../cli/compile-cache.js";
import { normalizePathForDisplay } from "../util/package-info.js";
import { errorMessage, isFileSystemErrorCode } from "../util/errors.js";
import { isPlainRecord } from "../util/guards.js";

type InstallerLockSettings = {
  homeDir: string;
  env: Record<string, string | undefined>;
};

type InstallerLeaseMetadata = {
  owner: string;
  pid: number;
  leaseExpiresAt: string;
  kernelLock?: boolean;
  kernelId?: string;
  host?: string;
  platform?: string;
  pidNamespace?: string;
  bootId?: string;
};

type InstallerLeaseLock = {
  file: FileHandle;
  kernelPath: string;
  kernelLock: NativeExclusiveLock | undefined;
  lockPath: string;
  owner: string;
  renewalTimer: NodeJS.Timeout;
  waitForRenewal: () => Promise<void>;
};

type InstallerLeaseConflict = "absent" | "reclaimed" | "live" | "blocked";

const INSTALLER_LOCK_RETRIES = 100;
const INSTALLER_LOCK_RETRY_MS = 20;
const INSTALLER_LOCK_LEASE_MS = 30_000;
const INSTALLER_LOCK_ABANDONED_MS = INSTALLER_LOCK_LEASE_MS * 2;
const INSTALLER_LOCK_RENEWAL_MS = 10_000;
const debug = debuglog("codegraph");
let lastReleasedLock: { path: string; at: number } | undefined;
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
    .map((scope) => {
      const lockPath = installerTransactionLockPath(scope);
      return { scope, lockPath, kernelPath: installerKernelLockPath(settings, scope) };
    })
    .sort((left, right) => left.kernelPath.localeCompare(right.kernelPath));
  try {
    for (const scopedLock of scopedLocks) {
      locks.push(
        await acquireInstallerLeaseLock(
          scopedLock.lockPath,
          `installer transaction for ${normalizePathForDisplay(scopedLock.scope)}`,
          scopedLock.kernelPath,
        ),
      );
    }
    return await operation();
  } finally {
    await releaseInstallerTransactionLocks(locks);
  }
}

async function releaseInstallerTransactionLocks(locks: InstallerLeaseLock[]): Promise<void> {
  let failure: { error: unknown } | undefined;
  for (const lock of locks.reverse()) {
    try {
      await releaseInstallerLeaseLock(lock);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

export function installerTransactionLockScopes(settings: InstallerLockSettings): string[] {
  const scopes = [path.resolve(settings.homeDir), path.resolve(opencodeConfigHome(settings))];
  const codexHome = settings.env.CODEX_HOME?.trim();
  if (codexHome) scopes.push(path.resolve(codexHome));
  if (process.platform === "win32") scopes.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
  else scopes.sort();
  return scopes.filter((scope, index) => {
    if (!index) return true;
    const previous = scopes[index - 1];
    if (previous === undefined) return true;
    if (process.platform === "win32") return scope.toLowerCase() !== previous.toLowerCase();
    return scope !== previous;
  });
}

function installerTransactionLockPath(scope: string): string {
  const digest = createHash("sha256").update(scope).digest("hex");
  return path.join(os.tmpdir(), `codegraph-installer-${digest}.lock`);
}

export function installerKernelLockPath(settings: InstallerLockSettings, resourcePath: string): string {
  const resolved = path.resolve(resourcePath);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(resolveCodegraphUserStateRoot(settings.env, settings.homeDir), "installer-locks", `${digest}.lock`);
}

export async function lifecycleKernelLockPath(root: string): Promise<string> {
  const realRoot = await fsp.realpath(path.resolve(root));
  const key = process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(resolveCodegraphUserStateRoot(), "server-locks", `${digest}.lock`);
}

async function defaultKernelLockPath(lockPath: string): Promise<string> {
  if (path.basename(lockPath) === ".codegraph-server.lock") {
    return await lifecycleKernelLockPath(path.dirname(lockPath));
  }
  return installerKernelLockPath({ homeDir: os.homedir(), env: process.env }, lockPath);
}

export async function withInstallerLeaseLock<T>(
  lockPath: string,
  resourceName: string,
  operation: () => Promise<T>,
  options?: { kernelPath?: string },
): Promise<T> {
  const kernelPath = options?.kernelPath ?? (await defaultKernelLockPath(lockPath));
  const lock = await acquireInstallerLeaseLock(lockPath, resourceName, kernelPath);
  try {
    return await operation();
  } finally {
    await releaseInstallerLeaseLock(lock);
  }
}

async function acquireInstallerLeaseLock(
  lockPath: string,
  resourceName: string,
  kernelPath: string,
): Promise<InstallerLeaseLock> {
  const state = loadBinding({ lockOnly: true });
  assertNativeRequiredAvailable(state);
  const tryLockExclusive = state.binding.tryLockExclusive;
  if (!tryLockExclusive) {
    throw new Error("The native addon does not support kernel locks. Update or rebuild @lzehrung/codegraph-native.");
  }
  try {
    await fsp.mkdir(path.dirname(kernelPath), { recursive: true });
  } catch {
    // An existing anchor may still be openable on a read-only filesystem.
  }
  if (lastReleasedLock?.path === kernelPath) {
    const remaining = INSTALLER_LOCK_RETRY_MS - (performance.now() - lastReleasedLock.at);
    if (remaining > 0) await waitForInstallerLockRetry(remaining);
  }

  let kernelUnavailable = false;
  let lastConflict: InstallerLeaseConflict = "live";
  for (let attempt = 0; attempt < INSTALLER_LOCK_RETRIES; attempt += 1) {
    let kernelLock: NativeExclusiveLock | undefined;
    if (!kernelUnavailable) {
      try {
        kernelLock = tryLockExclusive(kernelPath) ?? undefined;
      } catch (error) {
        if (!isFileSystemErrorCode(error, "CODEGRAPH_LOCK_OPEN_FAILED")) throw error;
        kernelUnavailable = true;
        debug("Kernel lock unavailable at %s; using renewable lease only: %s", kernelPath, errorMessage(error));
      }
      if (!kernelLock && !kernelUnavailable) {
        lastConflict = "live";
        await waitForInstallerLockRetry();
        continue;
      }
    }
    const acquisitionPath = `${lockPath}.acquire-${randomUUID()}`;
    let published = false;
    let held = false;
    let file: FileHandle | undefined;
    let kernelId: string | undefined;
    try {
      if (kernelLock) {
        const canonicalKernelPath = await fsp.realpath(kernelPath);
        const kernelKey = process.platform === "win32" ? canonicalKernelPath.toLowerCase() : canonicalKernelPath;
        kernelId = createHash("sha256").update(kernelKey).digest("hex");
      }
      const acquiredKernelId = kernelId;
      const owner = randomUUID();
      file = await fsp.open(acquisitionPath, "wx", 0o600);
      await writeInstallerLeaseMetadata(file, owner, acquiredKernelId);
      await file.close();
      file = undefined;
      await fsp.link(acquisitionPath, lockPath);
      published = true;
      await fsp.rm(acquisitionPath, { force: true });
      file = await fsp.open(lockPath, "r+");
      const lockFile = file;
      let renewal = Promise.resolve();
      let renewing = false;
      const renewalTimer = setInterval(() => {
        if (renewing) return;
        renewing = true;
        renewal = writeInstallerLeaseMetadata(lockFile, owner, acquiredKernelId)
          .catch(() => undefined)
          .finally(() => {
            renewing = false;
          });
      }, INSTALLER_LOCK_RENEWAL_MS);
      renewalTimer.unref();
      held = true;
      return {
        file: lockFile,
        kernelPath,
        kernelLock,
        lockPath,
        owner,
        renewalTimer,
        waitForRenewal: () => renewal,
      };
    } catch (error) {
      await file?.close().catch(() => undefined);
      await fsp.rm(acquisitionPath, { force: true }).catch(() => undefined);
      if (published) await fsp.rm(lockPath, { force: true }).catch(() => undefined);
      if (!isInstallerLockPublishConflict(error, lockPath)) throw error;
      const conflict = await resolveInstallerLeaseConflict(lockPath, kernelId);
      if (conflict === "absent" || conflict === "reclaimed") continue;
      lastConflict = conflict;
    } finally {
      if (!held) kernelLock?.unlock();
    }
    await waitForInstallerLockRetry();
  }
  if (lastConflict === "live") {
    throw new Error(`Another Codegraph installer is still updating ${resourceName}.`);
  }
  throw new Error(
    `Codegraph installer found an existing lock at ${normalizePathForDisplay(lockPath)} while updating ${resourceName}, ` +
      "but the lock could not be safely reclaimed because its metadata is corrupt, unreadable, or still potentially live. " +
      "The lock was left untouched. If no other Codegraph installer is running in any environment, delete that lock file and retry.",
  );
}

async function resolveInstallerLeaseConflict(
  lockPath: string,
  kernelId: string | undefined,
): Promise<InstallerLeaseConflict> {
  let observed: { content: string; mtimeMs: number };
  try {
    const stats = await fsp.lstat(lockPath);
    if (!stats.isFile()) return "blocked";
    observed = { content: await fsp.readFile(lockPath, "utf8"), mtimeMs: stats.mtimeMs };
  } catch (error) {
    if (isFileSystemErrorCode(error, "ENOENT")) return "absent";
    return "blocked";
  }
  const metadata = parseInstallerLeaseMetadata(observed.content);
  if (!metadata) {
    if (Date.now() - observed.mtimeMs < INSTALLER_LOCK_ABANDONED_MS) return "blocked";
    return await reclaimInstallerLease(lockPath, observed);
  }
  const leaseExpiresAt = Date.parse(metadata.leaseExpiresAt);
  if (Number.isNaN(leaseExpiresAt)) return "blocked";
  if (kernelId && metadata.kernelLock && metadata.kernelId === kernelId && isLocalLease(metadata)) {
    return await reclaimInstallerLease(lockPath, observed);
  }
  if (leaseExpiresAt > Date.now()) return "live";
  return await reclaimInstallerLease(lockPath, observed);
}

async function reclaimInstallerLease(
  lockPath: string,
  observed: { content: string; mtimeMs: number },
): Promise<InstallerLeaseConflict> {
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
    if (path.basename(lockPath) === ".codegraph-server.lock") {
      const claimKey = createHash("sha256").update(observed.content).digest("hex");
      await fsp.rm(`${lockPath}.reclaim-dead-${claimKey}`, { force: true });
    }
    return "reclaimed";
  }
  try {
    await fsp.link(reclaimPath, lockPath);
  } catch {
    // Never overwrite a lease published while the detached file was checked.
  }
  await fsp.rm(reclaimPath, { force: true });
  return "blocked";
}

function isLocalLease(metadata: InstallerLeaseMetadata): boolean {
  if (!metadata.host || metadata.host !== LOCAL_HOST || metadata.pid <= 0) return false;
  if (metadata.platform !== process.platform || metadata.pidNamespace !== LOCAL_PID_NAMESPACE) return false;
  if (metadata.bootId !== LOCAL_BOOT_ID) return false;
  return process.platform !== "linux" || !!(LOCAL_PID_NAMESPACE && LOCAL_BOOT_ID);
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

async function writeInstallerLeaseMetadata(
  file: FileHandle,
  owner: string,
  kernelId: string | undefined,
): Promise<void> {
  const metadata: InstallerLeaseMetadata = {
    owner,
    pid: process.pid,
    ...(kernelId ? { kernelLock: true, kernelId } : {}),
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
        ...(typeof parsed.kernelLock === "boolean" && parsed.kernelLock ? { kernelLock: true } : {}),
        ...(typeof parsed.kernelId === "string" ? { kernelId: parsed.kernelId } : {}),
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

export async function describeInstallerLease(lockPath: string): Promise<string> {
  try {
    const metadata = parseInstallerLeaseMetadata(await fsp.readFile(lockPath, "utf8"));
    if (metadata) {
      return (
        `Holder: PID ${metadata.pid}, host ${JSON.stringify(metadata.host ?? "unknown")}, ` +
        `platform ${JSON.stringify(metadata.platform ?? "unknown")}, lease expires ${JSON.stringify(metadata.leaseExpiresAt)}.`
      );
    }
  } catch {
    // Missing or unreadable metadata does not prove the holder is absent.
  }
  return "Holder identity is unavailable.";
}

async function releaseInstallerLeaseLock(lock: InstallerLeaseLock): Promise<void> {
  clearInterval(lock.renewalTimer);
  try {
    await lock.waitForRenewal();
    await lock.file.close();
    const metadata = parseInstallerLeaseMetadata(await fsp.readFile(lock.lockPath, "utf8"));
    if (metadata?.owner === lock.owner) await fsp.rm(lock.lockPath, { force: true });
  } catch (error) {
    if (!isFileSystemErrorCode(error, "ENOENT")) throw error;
  } finally {
    lock.kernelLock?.unlock();
    lastReleasedLock = { path: lock.kernelPath, at: performance.now() };
  }
}

export function waitForInstallerLockRetry(ms = INSTALLER_LOCK_RETRY_MS): Promise<void> {
  return import("../util/concurrency.js").then(({ delay }) => delay(ms));
}
