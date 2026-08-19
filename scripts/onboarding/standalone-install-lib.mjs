import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { validateArchiveEntries } from "../standalone/standalone-lib.mjs";

const INSTALL_MANIFEST_NAME = "install-manifest.json";
const LAUNCHER_MARKER = "codegraph standalone installer";
const INSTALL_LOCK_NAME = ".install-lock";
const INSTALL_LOCK_OWNER_NAME = "owner.json";
const WINDOWS_LAUNCHER_SCRIPT_NAME = "codegraph-launcher.ps1";
const INSTALL_LOCK_TIMEOUT_MS = 30_000;
const INSTALL_LOCK_INITIAL_RETRY_MS = 50;
const INSTALL_LOCK_MAX_RETRY_MS = 500;
const INSTALL_LOCK_UNOWNED_STALE_MS = 120_000;
const LOCAL_HOSTNAME = hostname();

export async function verifyStandaloneBundle(bundleRoot) {
  const root = path.resolve(bundleRoot);
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Standalone bundle root must be a real directory.");
  }
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.channel !== "standalone-preview") {
    throw new Error("Unsupported standalone bundle manifest.");
  }
  if (
    typeof manifest.version !== "string" ||
    !manifest.version ||
    typeof manifest.target !== "string" ||
    !manifest.target ||
    typeof manifest.nativeSuffix !== "string" ||
    !manifest.nativeSuffix ||
    typeof manifest.nodeVersion !== "string" ||
    !manifest.nodeVersion ||
    (manifest.sourceRevision !== null && typeof manifest.sourceRevision !== "string") ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Standalone bundle manifest is incomplete.");
  }
  validateArchiveEntries(manifest.files);
  const expected = new Map();
  for (const entry of manifest.files) {
    if (
      typeof entry?.path !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      expected.has(entry.path)
    ) {
      throw new Error("Standalone bundle manifest has an invalid file record.");
    }
    expected.set(entry.path, entry);
  }
  const actual = await collectBundleFiles(root);
  const files = actual.filter((file) => file !== "manifest.json");
  await forEachConcurrent(files, 16, async (file) => {
    const record = expected.get(file);
    if (!record) throw new Error(`Standalone bundle contains an unmanifested file: ${file}`);
    const absolute = confinedPath(root, file);
    const stat = await fsp.stat(absolute);
    if (record.size !== stat.size || record.sha256 !== (await sha256File(absolute))) {
      throw new Error(`Standalone bundle integrity check failed: ${file}`);
    }
    expected.delete(file);
  });
  if (expected.size) throw new Error(`Standalone bundle is missing manifest file: ${expected.keys().next().value}`);
  return manifest;
}

function assertMatchingStandaloneProvenance(incoming, installed) {
  for (const field of ["version", "target", "nativeSuffix", "sourceRevision", "nodeVersion"]) {
    if (incoming[field] !== installed[field]) {
      throw new Error(`Existing standalone installation provenance mismatch: ${field}.`);
    }
  }
  if (incoming.files.length !== installed.files.length) {
    throw new Error("Existing standalone installation provenance mismatch: files.");
  }
  const installedFiles = new Map(installed.files.map((entry) => [entry.path, entry]));
  for (const incomingFile of incoming.files) {
    const installedFile = installedFiles.get(incomingFile.path);
    if (!installedFile || incomingFile.size !== installedFile.size || incomingFile.sha256 !== installedFile.sha256) {
      throw new Error(`Existing standalone installation provenance mismatch: ${incomingFile.path}.`);
    }
  }
}
async function forEachConcurrent(items, concurrency, operation) {
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await operation(items[index]);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => await worker()));
}

export async function installStandaloneBundle(options) {
  const bundleRoot = path.resolve(options.bundleRoot);
  const installBase = path.resolve(options.installBase);
  const binDir = path.resolve(options.binDir);
  const manifest = await verifyStandaloneBundle(bundleRoot);
  const versionRoot = standaloneVersionRoot(installBase, manifest.version);
  const stagingRoot = confinedPath(installBase, `.installing-${manifest.version}-${randomUUID()}`);
  await fsp.mkdir(installBase, { recursive: true });
  await fsp.rm(stagingRoot, { recursive: true, force: true });
  try {
    await fsp.cp(bundleRoot, stagingRoot, { recursive: true, errorOnExist: true, force: false });
    const stagedManifest = await verifyStandaloneBundle(stagingRoot);
    assertMatchingStandaloneProvenance(manifest, stagedManifest);
    await (options.smoke ?? smokeStandaloneRoot)(stagingRoot, manifest.target, manifest);
    return await withInstallLock(installBase, async () => {
      const launcherPaths = installedLauncherPaths(binDir, manifest.target);
      const installerState = await snapshotInstallerState(
        [...launcherPaths, path.join(installBase, INSTALL_MANIFEST_NAME)],
        binDir,
      );
      const previous = await readInstallManifest(installBase);
      let createdVersionRoot = false;
      try {
        const versionRootExists = await isRealDirectory(versionRoot, "Standalone version root");
        if (versionRootExists) {
          const installedManifest = await verifyStandaloneBundle(versionRoot);
          assertMatchingStandaloneProvenance(manifest, installedManifest);
        } else {
          await fsp.rename(stagingRoot, versionRoot);
          createdVersionRoot = true;
        }
        await fsp.mkdir(binDir, { recursive: true });
        const launchers = await writeInstalledLaunchers(binDir, versionRoot, manifest.target);
        const installManifest = {
          schemaVersion: 1,
          channel: "standalone-preview",
          currentVersion: manifest.version,
          previousVersion: previous?.currentVersion ?? null,
          target: manifest.target,
          versionRoot,
          launchers,
          releaseUrl: options.releaseUrl ?? null,
          archiveSha256: options.archiveSha256 ?? null,
          verification: options.verification ?? "bundle-manifest-sha256",
          installedAt: new Date().toISOString(),
        };
        await writeJsonAtomic(path.join(installBase, INSTALL_MANIFEST_NAME), installManifest);
        return installManifest;
      } catch (error) {
        const failures = [];
        if (createdVersionRoot) {
          try {
            await fsp.rm(versionRoot, { recursive: true, force: true });
          } catch (rollbackError) {
            failures.push(rollbackError);
          }
        }
        try {
          await restoreInstallerState(installerState);
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
        if (failures.length) {
          const detail = failures
            .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
            .join("; ");
          throw new Error(`Standalone installation failed and state rollback failed: ${detail}`, { cause: error });
        }
        throw error;
      }
    });
  } finally {
    await fsp.rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function uninstallStandaloneBundle(options) {
  const installBase = path.resolve(options.installBase);
  const manifest = await readInstallManifest(installBase);
  if (!manifest || manifest.channel !== "standalone-preview") {
    return { uninstalled: false, reason: "not-installed", removed: [] };
  }
  const removed = [];
  for (const launcher of manifest.launchers ?? []) {
    const absolute = path.resolve(launcher);
    const content = await fsp.readFile(absolute, "utf8").catch(() => null);
    if (content?.includes(LAUNCHER_MARKER)) {
      await fsp.rm(absolute, { force: true });
      removed.push(absolute);
    }
  }
  const versionRoot = standaloneVersionRoot(installBase, manifest.currentVersion);
  await fsp.rm(versionRoot, { recursive: true, force: true });
  removed.push(versionRoot);
  await fsp.rm(path.join(installBase, INSTALL_MANIFEST_NAME), { force: true });
  return { uninstalled: true, removed };
}

async function smokeStandaloneRoot(root, target, manifest) {
  const windows = String(target).startsWith("win32-");
  const node = path.join(root, windows ? "node.exe" : "node");
  const cli = path.join(root, "dist", "cli.js");
  const versionReport = parseSmokeJson(runStandaloneSmokeCommand(node, cli, ["version", "--json"], root), "version");
  assertSmokePackageIdentity(versionReport, manifest, root, "version");
  const doctorReport = parseSmokeJson(runStandaloneSmokeCommand(node, cli, ["doctor", "--json"], root), "doctor");
  const doctorPackage = recordValue(doctorReport.package);
  if (!doctorPackage) throw new Error("Standalone doctor smoke did not report its package identity.");
  assertSmokePackageIdentity(doctorPackage, manifest, root, "doctor");
  const native = recordValue(doctorReport.native);
  if (!native || typeof native.available !== "boolean" || !native.available) {
    throw new Error("Standalone doctor smoke did not report an available native runtime.");
  }
  const origin = recordValue(native.origin);
  if (!origin || origin.target !== manifest.nativeSuffix) {
    throw new Error("Standalone doctor smoke native origin target does not match the bundle manifest.");
  }
  const expectedTargetPackage = `@lzehrung/codegraph-native-${manifest.nativeSuffix}`;
  const nativePackagePath = path.join(
    root,
    "node_modules",
    "@lzehrung",
    `codegraph-native-${manifest.nativeSuffix}`,
    "package.json",
  );
  let nativePackage;
  try {
    nativePackage = JSON.parse(fs.readFileSync(nativePackagePath, "utf8"));
  } catch {
    throw new Error("Standalone doctor smoke could not read target native package metadata.");
  }
  if (nativePackage.name !== expectedTargetPackage || typeof nativePackage.version !== "string") {
    throw new Error("Standalone doctor smoke found invalid target native package metadata.");
  }
  if (origin.packageName !== expectedTargetPackage || origin.packageVersion !== nativePackage.version) {
    throw new Error("Standalone doctor smoke native origin package does not match bundled target metadata.");
  }
}

function runStandaloneSmokeCommand(node, cli, args, root) {
  const result = spawnSync(node, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
  if (result.error || result.status !== 0) {
    const details = result.stderr || result.stdout || result.error?.message || "no output";
    throw new Error(`Standalone ${args[0]} smoke failed (${result.status ?? "unknown"}): ${details}`);
  }
  return result.stdout ?? "";
}

function parseSmokeJson(output, command) {
  try {
    const parsed = JSON.parse(output);
    const report = recordValue(parsed);
    if (!report) throw new Error("not an object");
    return report;
  } catch {
    throw new Error(`Standalone ${command} smoke returned invalid JSON.`);
  }
}

function assertSmokePackageIdentity(report, manifest, root, command) {
  const packageRootMatches = typeof report.packageRoot === "string" && sameFilesystemPath(report.packageRoot, root);
  if (report.name !== "@lzehrung/codegraph" || report.version !== manifest.version || !packageRootMatches) {
    throw new Error(`Standalone ${command} smoke package identity does not match the bundle manifest.`);
  }
}

function sameFilesystemPath(left, right) {
  let normalizedLeft = fs.realpathSync.native(path.resolve(left));
  let normalizedRight = fs.realpathSync.native(path.resolve(right));
  if (process.platform === "win32") {
    normalizedLeft = normalizedLeft.toLowerCase();
    normalizedRight = normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function recordValue(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function installedLauncherPaths(binDir, target) {
  if (String(target).startsWith("win32-")) {
    return [path.join(binDir, "codegraph.cmd"), path.join(binDir, WINDOWS_LAUNCHER_SCRIPT_NAME)];
  }
  return [path.join(binDir, "codegraph")];
}

async function writeInstalledLaunchers(binDir, versionRoot, target) {
  const windows = String(target).startsWith("win32-");
  const launchers = installedLauncherPaths(binDir, target);
  const [launcher] = launchers;
  if (!launcher) throw new Error("Standalone launcher path is missing.");
  if (windows) {
    const script = launchers[1];
    if (!script) throw new Error("Standalone Windows launcher script path is missing.");
    const commandContent = `@echo off\r\nrem ${LAUNCHER_MARKER}\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0${WINDOWS_LAUNCHER_SCRIPT_NAME}" %*\r\n`;
    const scriptContent = [
      `# ${LAUNCHER_MARKER}`,
      '$ErrorActionPreference = "Stop"',
      `& ${quotePowerShell(path.join(versionRoot, "node.exe"))} ${quotePowerShell(path.join(versionRoot, "dist", "cli.js"))} @args`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n");
    await writeTextAtomic(launcher, commandContent);
    await writeBinaryAtomic(
      script,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(scriptContent, "utf8")]),
    );
    return launchers;
  }
  const content = `#!/bin/sh\n# ${LAUNCHER_MARKER}\nexec ${quotePosixShell(path.join(versionRoot, "node"))} ${quotePosixShell(path.join(versionRoot, "dist", "cli.js"))} "$@"\n`;
  await writeTextAtomic(launcher, content);
  await fsp.chmod(launcher, 0o755);
  return launchers;
}

function quotePosixShell(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function snapshotInstallerState(filePaths, binDir) {
  return {
    files: await Promise.all(filePaths.map(async (filePath) => await snapshotFile(filePath))),
    binDir,
    binDirExisted: await isRealDirectory(binDir, "Standalone launcher directory"),
  };
}

async function snapshotFile(filePath) {
  try {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Standalone installer state contains an unsafe path: ${filePath}`);
    }
    return {
      filePath,
      exists: true,
      contents: await fsp.readFile(filePath),
      mode: stat.mode & 0o7777,
    };
  } catch (error) {
    if (isCode(error, "ENOENT")) return { filePath, exists: false };
    throw error;
  }
}

async function restoreInstallerState(snapshot) {
  const failures = [];
  for (const file of snapshot.files) {
    try {
      await restoreFileSnapshot(file);
    } catch (error) {
      failures.push(error);
    }
  }
  if (!snapshot.binDirExisted) {
    try {
      await fsp.rmdir(snapshot.binDir);
    } catch (error) {
      if (!isCode(error, "ENOENT") && !isCode(error, "ENOTEMPTY")) failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Unable to restore standalone installer state.");
}

async function restoreFileSnapshot(snapshot) {
  if (!snapshot.exists) {
    await fsp.rm(snapshot.filePath, { force: true });
    return;
  }
  await writeBinaryAtomic(snapshot.filePath, snapshot.contents);
  await fsp.chmod(snapshot.filePath, snapshot.mode);
}

async function isRealDirectory(directory, label) {
  try {
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} must be a real directory: ${directory}`);
    }
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function withInstallLock(installBase, operation) {
  const lock = await acquireInstallLock(installBase);
  try {
    return await operation();
  } finally {
    await releaseInstallLock(lock);
  }
}

async function acquireInstallLock(installBase) {
  const lockPath = confinedPath(installBase, INSTALL_LOCK_NAME);
  const startedAt = performance.now();
  let retryMs = INSTALL_LOCK_INITIAL_RETRY_MS;
  for (;;) {
    try {
      await fsp.mkdir(lockPath);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      if (await reclaimStaleInstallLock(lockPath)) continue;
      if (performance.now() - startedAt >= INSTALL_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for standalone installation lock: ${lockPath}`);
      }
      await waitForInstallLock(retryMs);
      retryMs = Math.min(INSTALL_LOCK_MAX_RETRY_MS, retryMs * 2);
      continue;
    }
    const token = randomUUID();
    try {
      await fsp.writeFile(
        path.join(lockPath, INSTALL_LOCK_OWNER_NAME),
        `${JSON.stringify({
          schemaVersion: 1,
          token,
          pid: process.pid,
          host: LOCAL_HOSTNAME,
          createdAt: new Date().toISOString(),
        })}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { lockPath, token };
  }
}

function waitForInstallLock(milliseconds) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function reclaimStaleInstallLock(lockPath) {
  let lockStat;
  try {
    lockStat = await fsp.lstat(lockPath);
  } catch (error) {
    if (isCode(error, "ENOENT")) return true;
    throw error;
  }
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    throw new Error(`Standalone install lock is unsafe: ${lockPath}`);
  }
  const owner = await readInstallLockOwner(lockPath);
  if (owner && owner.host === LOCAL_HOSTNAME && !isProcessRunning(owner.pid)) {
    return await removeStaleInstallLock(lockPath);
  }
  if (!owner && Date.now() - lockStat.mtimeMs >= INSTALL_LOCK_UNOWNED_STALE_MS) {
    return await removeStaleInstallLock(lockPath);
  }
  return false;
}

async function readInstallLockOwner(lockPath) {
  const ownerPath = path.join(lockPath, INSTALL_LOCK_OWNER_NAME);
  let ownerStat;
  try {
    ownerStat = await fsp.lstat(ownerPath);
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
    throw new Error(`Standalone install lock owner is unsafe: ${ownerPath}`);
  }
  let raw;
  try {
    raw = await fsp.readFile(ownerPath, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const parsed = recordValue(JSON.parse(raw));
    if (
      !parsed ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.token !== "string" ||
      !parsed.token ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.host !== "string" ||
      !parsed.host ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isCode(error, "ESRCH");
  }
}

async function removeStaleInstallLock(lockPath) {
  const stalePath = confinedPath(path.dirname(lockPath), `${path.basename(lockPath)}.stale-${randomUUID()}`);
  try {
    await fsp.rename(lockPath, stalePath);
  } catch (error) {
    if (isCode(error, "ENOENT")) return true;
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
  await fsp.rm(stalePath, { recursive: true, force: true });
  return true;
}

async function releaseInstallLock(lock) {
  const owner = await readInstallLockOwner(lock.lockPath);
  if (!owner || owner.token !== lock.token) {
    throw new Error(`Standalone installation lock ownership was lost: ${lock.lockPath}`);
  }
  await fsp.rm(lock.lockPath, { recursive: true, force: true });
}

async function readInstallManifest(installBase) {
  try {
    return JSON.parse(await fsp.readFile(path.join(installBase, INSTALL_MANIFEST_NAME), "utf8"));
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function collectBundleFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) throw new Error(`Standalone bundle contains an unsafe symlink: ${relative}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Standalone bundle contains an unsafe device: ${relative}`);
    }
  }
  await visit(root);
  return files.sort();
}

function confinedPath(root, relative) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error(`Install path escaped its root: ${relative}`);
  return resolved;
}

function standaloneVersionRoot(installBase, version) {
  if (
    typeof version !== "string" ||
    !version ||
    version === "." ||
    version === ".." ||
    version.includes("/") ||
    version.includes("\\") ||
    version === INSTALL_MANIFEST_NAME ||
    version.startsWith(".installing-") ||
    version.startsWith(".install-lock")
  ) {
    throw new Error(`Standalone version is not a safe install path: ${String(version)}`);
  }
  return confinedPath(installBase, version);
}

async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filePath, content) {
  await writeAtomic(filePath, content);
}

async function writeBinaryAtomic(filePath, content) {
  await writeAtomic(filePath, content);
}

async function writeAtomic(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fsp.writeFile(temporary, content, { flag: "wx" });
  try {
    await fsp.rename(temporary, filePath);
  } catch (error) {
    if (process.platform !== "win32" || (!isCode(error, "EEXIST") && !isCode(error, "EPERM"))) throw error;
    const backup = `${filePath}.backup-${randomUUID()}`;
    let moved = false;
    try {
      if (fs.existsSync(filePath)) {
        await fsp.rename(filePath, backup);
        moved = true;
      }
      await fsp.rename(temporary, filePath);
      if (moved) await fsp.rm(backup, { force: true });
    } catch (replaceError) {
      if (moved) await fsp.rename(backup, filePath).catch(() => undefined);
      throw replaceError;
    }
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function isCode(error, code) {
  return error instanceof Error && "code" in error && String(error.code) === code;
}
