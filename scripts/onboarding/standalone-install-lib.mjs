import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { validateArchiveEntries } from "../standalone/standalone-lib.mjs";

const INSTALL_MANIFEST_NAME = "install-manifest.json";
const LAUNCHER_MARKER = "codegraph standalone installer";

export async function verifyStandaloneBundle(bundleRoot) {
  const root = path.resolve(bundleRoot);
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
  const versionRoot = confinedPath(installBase, manifest.version);
  const stagingRoot = confinedPath(installBase, `.installing-${manifest.version}-${randomUUID()}`);
  await fsp.mkdir(installBase, { recursive: true });
  await fsp.rm(stagingRoot, { recursive: true, force: true });
  try {
    await fsp.cp(bundleRoot, stagingRoot, { recursive: true, errorOnExist: true, force: false });
    await (options.smoke ?? smokeStandaloneRoot)(stagingRoot, manifest.target);
    if (!fs.existsSync(versionRoot)) {
      await fsp.rename(stagingRoot, versionRoot);
    } else {
      const installedManifest = await verifyStandaloneBundle(versionRoot);
      assertMatchingStandaloneProvenance(manifest, installedManifest);
      await fsp.rm(stagingRoot, { recursive: true, force: true });
    }
    const previous = await readInstallManifest(installBase);
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
    await fsp.rm(stagingRoot, { recursive: true, force: true });
    throw error;
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
  const versionRoot = confinedPath(installBase, manifest.currentVersion);
  await fsp.rm(versionRoot, { recursive: true, force: true });
  removed.push(versionRoot);
  await fsp.rm(path.join(installBase, INSTALL_MANIFEST_NAME), { force: true });
  return { uninstalled: true, removed };
}

async function smokeStandaloneRoot(root, target) {
  const windows = String(target).startsWith("win32-");
  const node = path.join(root, windows ? "node.exe" : "node");
  const cli = path.join(root, "dist", "cli.js");
  for (const args of [["version"], ["doctor", "--json"]]) {
    const result = spawnSync(node, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: "" } });
    if (result.status !== 0) {
      throw new Error(`Standalone ${args[0]} smoke failed (${result.status}): ${result.stderr || result.stdout}`);
    }
  }
}

async function writeInstalledLaunchers(binDir, versionRoot, target) {
  const windows = String(target).startsWith("win32-");
  if (windows) {
    const launcher = path.join(binDir, "codegraph.cmd");
    const content = `@echo off\r\nrem ${LAUNCHER_MARKER}\r\n"${path.join(versionRoot, "node.exe")}" "${path.join(versionRoot, "dist", "cli.js")}" %*\r\n`;
    await writeTextAtomic(launcher, content);
    return [launcher];
  }
  const launcher = path.join(binDir, "codegraph");
  const content = `#!/bin/sh\n# ${LAUNCHER_MARKER}\nexec "${path.join(versionRoot, "node")}" "${path.join(versionRoot, "dist", "cli.js")}" "$@"\n`;
  await writeTextAtomic(launcher, content);
  await fsp.chmod(launcher, 0o755);
  return [launcher];
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

async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fsp.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
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
