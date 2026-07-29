import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const STANDALONE_TARGETS = {
  "win32-x64": { platform: "win32", arch: "x64", nativeSuffix: "win32-x64-msvc", archive: "zip" },
  "win32-arm64": { platform: "win32", arch: "arm64", nativeSuffix: "win32-arm64-msvc", archive: "zip" },
  "linux-x64": { platform: "linux", arch: "x64", nativeSuffix: "linux-x64-gnu", archive: "tar.gz" },
  "linux-arm64": { platform: "linux", arch: "arm64", nativeSuffix: "linux-arm64-gnu", archive: "tar.gz" },
  "darwin-x64": { platform: "darwin", arch: "x64", nativeSuffix: "darwin-x64", archive: "tar.gz" },
  "darwin-arm64": { platform: "darwin", arch: "arm64", nativeSuffix: "darwin-arm64", archive: "tar.gz" },
};

export function resolveStandaloneTarget(platform = process.platform, arch = process.arch) {
  return Object.entries(STANDALONE_TARGETS).find(
    ([, target]) => target.platform === platform && target.arch === arch,
  )?.[0];
}

export function assertStandaloneTarget(target) {
  const definition = STANDALONE_TARGETS[target];
  if (definition) return definition;
  throw new Error(
    `Unsupported standalone target "${target}". Expected ${Object.keys(STANDALONE_TARGETS).join(", ")}. Use the package or source installation path on unsupported platforms.`,
  );
}

export function validateArchiveEntries(entries) {
  for (const entry of entries) {
    const normalized = String(entry.path ?? entry).replaceAll("\\", "/");
    if (!normalized || normalized.includes("\0")) throw new Error("Archive contains an invalid empty or NUL path.");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) {
      throw new Error(`Archive contains an absolute path: ${normalized}`);
    }
    if (normalized.split("/").includes("..")) throw new Error(`Archive contains path traversal: ${normalized}`);
    if (typeof entry === "object" && entry !== null) {
      const type = entry.type;
      if (type === "symlink" || type === "hardlink" || type === "device") {
        throw new Error(`Archive contains unsafe ${type}: ${normalized}`);
      }
    }
  }
}

export async function assembleStandaloneArchive(options) {
  const target = assertStandaloneTarget(options.target);
  if ((target.platform !== process.platform || target.arch !== process.arch) && !options.allowCrossTarget) {
    throw new Error(
      `Standalone archive ${options.target} must be assembled on matching ${target.platform}/${target.arch}; current host is ${process.platform}/${process.arch}. Pass allowCrossTarget only for a structural-only target.`,
    );
  }
  const packageRoot = path.resolve(options.packageRoot);
  const outputDir = path.resolve(options.outputDir);
  const nodeExecutable = path.resolve(options.nodeExecutable ?? process.execPath);
  const packageJson = JSON.parse(await fsp.readFile(path.join(packageRoot, "package.json"), "utf8"));
  const version = options.version ?? packageJson.version;
  if (typeof version !== "string" || !version) throw new Error("Standalone archive requires a package version.");
  await requireDirectory(path.join(packageRoot, "dist"), "built dist directory");
  await requireFile(nodeExecutable, "Node executable");

  const bundleName = `codegraph-${options.target}`;
  const stagingRoot = path.join(outputDir, ".staging", `${bundleName}-${process.pid}`);
  const bundleRoot = path.join(stagingRoot, bundleName);
  await fsp.rm(stagingRoot, { recursive: true, force: true });
  await fsp.mkdir(path.join(bundleRoot, "bin"), { recursive: true });
  await fsp.cp(path.join(packageRoot, "dist"), path.join(bundleRoot, "dist"), { recursive: true });
  await fsp.cp(path.join(packageRoot, "codegraph-skill"), path.join(bundleRoot, "codegraph-skill"), {
    recursive: true,
  });
  await copyProductionNodeModules(packageRoot, bundleRoot, target);
  await copyRequiredFile(path.join(packageRoot, "LICENSE"), path.join(bundleRoot, "LICENSE"));
  const noticesPath = options.noticesPath ?? path.join(options.sourceRoot ?? packageRoot, "THIRD_PARTY_NOTICES");
  await copyRequiredFile(noticesPath, path.join(bundleRoot, "THIRD_PARTY_NOTICES"));
  const nodeName = target.platform === "win32" ? "node.exe" : "node";
  await fsp.copyFile(nodeExecutable, path.join(bundleRoot, nodeName));
  if (target.platform !== "win32") await fsp.chmod(path.join(bundleRoot, nodeName), 0o755);
  await copyNodeLicense(nodeExecutable, bundleRoot);
  await writeStandalonePackageJson(packageJson, version, bundleRoot);
  await writeLaunchers(bundleRoot, target.platform);
  await ensureMatchingNativeRuntime(bundleRoot, target);

  const files = await collectFileRecords(bundleRoot);
  const manifest = {
    schemaVersion: 1,
    channel: "standalone-preview",
    version,
    target: options.target,
    nativeSuffix: target.nativeSuffix,
    nodeVersion: process.version,
    sourceRevision: options.sourceRevision ?? null,
    generatedAt: new Date().toISOString(),
    files,
  };
  await fsp.writeFile(path.join(bundleRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await fsp.mkdir(outputDir, { recursive: true });
  const archiveName = `${bundleName}.${target.archive}`;
  const archivePath = path.join(outputDir, archiveName);
  await fsp.rm(archivePath, { force: true });
  createArchive(stagingRoot, bundleName, archivePath, target.archive);
  const archiveSha256 = await sha256File(archivePath);
  await fsp.writeFile(path.join(outputDir, "SHA256SUMS"), `${archiveSha256}  ${archiveName}\n`, "utf8");
  await fsp.rm(stagingRoot, { recursive: true, force: true });
  return { archivePath, archiveName, archiveSha256, manifest, target: options.target };
}

async function copyProductionNodeModules(packageRoot, bundleRoot, target) {
  const installRoot = findInstallRoot(packageRoot);
  const destinationRoot = path.join(bundleRoot, "node_modules");
  const npmCli =
    process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const dependencyRoots = await collectProductionDependencyRoots(packageRoot, target);
  for (const dependencyRoot of dependencyRoots) {
    const realDependencyRoot = await fsp.realpath(dependencyRoot);
    const relative = path.relative(path.join(installRoot, "node_modules"), realDependencyRoot);
    const isInstalledPackage = !relative.startsWith("..") && !path.isAbsolute(relative);
    let destination;
    if (isInstalledPackage) {
      destination = path.join(destinationRoot, relative);
    } else {
      const dependencyPackage = JSON.parse(await fsp.readFile(path.join(realDependencyRoot, "package.json"), "utf8"));
      if (typeof dependencyPackage.name !== "string" || !dependencyPackage.name) {
        throw new Error(`Production dependency has no package name: ${realDependencyRoot}`);
      }
      destination = path.join(destinationRoot, ...dependencyPackage.name.split("/"));
    }
    if (path.resolve(realDependencyRoot) === path.resolve(packageRoot)) continue;
    if (!fs.existsSync(destination)) {
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      if (isInstalledPackage) await fsp.cp(realDependencyRoot, destination, { recursive: true, dereference: true });
      else await copyPublishedPackageFiles(realDependencyRoot, destination, npmCli);
    }
  }
  await fsp.rm(path.join(destinationRoot, "@lzehrung", "codegraph"), { recursive: true, force: true });
}

async function collectProductionDependencyRoots(packageRoot, target) {
  const pending = [packageRoot];
  const visited = new Set();
  const dependencies = [];
  while (pending.length) {
    const currentRoot = pending.pop();
    const realRoot = await fsp.realpath(currentRoot);
    if (visited.has(realRoot)) continue;
    visited.add(realRoot);
    const manifest = JSON.parse(await fsp.readFile(path.join(realRoot, "package.json"), "utf8"));
    const requiredNames = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(
        (name) => !manifest.peerDependenciesMeta?.[name]?.optional,
      ),
    ]);
    const optionalNames = new Set([
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter((name) => manifest.peerDependenciesMeta?.[name]?.optional),
    ]);
    for (const name of [...requiredNames, ...optionalNames].sort()) {
      if (!matchesStandaloneNativeTarget(name, target)) continue;
      const dependencyRoot = resolveInstalledPackageRoot(realRoot, name);
      if (!dependencyRoot) {
        if (optionalNames.has(name)) continue;
        throw new Error(`Production dependency is not installed: ${name} (required by ${manifest.name ?? realRoot})`);
      }
      dependencies.push(dependencyRoot);
      pending.push(dependencyRoot);
    }
  }
  return dependencies;
}

function matchesStandaloneNativeTarget(packageName, target) {
  const prefix = "@lzehrung/codegraph-native-";
  return !packageName.startsWith(prefix) || packageName === `${prefix}${target.nativeSuffix}`;
}

function resolveInstalledPackageRoot(packageRoot, packageName) {
  const require = createRequire(path.join(packageRoot, "package.json"));
  let resolved;
  try {
    resolved = require.resolve(`${packageName}/package.json`);
  } catch {
    try {
      resolved = require.resolve(packageName);
    } catch {
      return null;
    }
  }
  let current = path.dirname(resolved);
  while (true) {
    const manifestPath = path.join(current, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.name === packageName) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function copyPublishedPackageFiles(packageRoot, destinationRoot, npmCli) {
  const output = execFileSync(
    process.execPath,
    [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts", packageRoot],
    {
      cwd: packageRoot,
      encoding: "utf8",
    },
  );
  const report = JSON.parse(output);
  const files = report[0]?.files;
  if (!Array.isArray(files) || !files.length)
    throw new Error(`npm pack reported no published files for ${packageRoot}`);
  validateArchiveEntries(files);
  for (const file of files) {
    if (typeof file.path !== "string") throw new Error(`npm pack reported an invalid file for ${packageRoot}`);
    const source = path.resolve(packageRoot, file.path);
    const relative = path.relative(packageRoot, source);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`npm pack reported a file outside ${packageRoot}: ${file.path}`);
    }
    const destination = path.join(destinationRoot, relative);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(source, destination);
  }
  const packageJson = JSON.parse(await fsp.readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (packageJson.name === "@lzehrung/codegraph-native") {
    const nativeArtifacts = (await fsp.readdir(packageRoot)).filter((entry) => /^index\..+\.node$/u.test(entry));
    for (const artifact of nativeArtifacts) {
      await fsp.copyFile(path.join(packageRoot, artifact), path.join(destinationRoot, artifact));
    }
  }
}

function findInstallRoot(packageRoot) {
  const marker = `${path.sep}node_modules${path.sep}@lzehrung${path.sep}codegraph`;
  const index = packageRoot.lastIndexOf(marker);
  if (index >= 0) return packageRoot.slice(0, index);
  return packageRoot;
}

async function ensureMatchingNativeRuntime(bundleRoot, target) {
  const suffix = target.nativeSuffix;
  const scopeRoot = path.join(bundleRoot, "node_modules", "@lzehrung");
  const metaRoot = path.join(scopeRoot, "codegraph-native");
  await requireDirectory(metaRoot, "Codegraph native meta package");
  const binaryName = `index.${suffix}.node`;
  const localBinary = path.join(metaRoot, binaryName);
  const targetRoot = path.join(scopeRoot, `codegraph-native-${suffix}`);
  if (fs.existsSync(targetRoot)) return;
  if (!fs.existsSync(localBinary)) throw new Error(`Standalone archive is missing matching native runtime ${suffix}.`);
  await fsp.mkdir(targetRoot, { recursive: true });
  await fsp.copyFile(localBinary, path.join(targetRoot, binaryName));
  await fsp.writeFile(
    path.join(targetRoot, "package.json"),
    `${JSON.stringify(
      {
        name: `@lzehrung/codegraph-native-${suffix}`,
        version: JSON.parse(await fsp.readFile(path.join(metaRoot, "package.json"), "utf8")).version,
        main: binaryName,
        os: [target.platform],
        cpu: [target.arch],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeStandalonePackageJson(source, version, bundleRoot) {
  const output = {
    name: source.name,
    version,
    type: "module",
    private: true,
    channel: "standalone-preview",
  };
  await fsp.writeFile(path.join(bundleRoot, "package.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

async function writeLaunchers(bundleRoot, platform) {
  const shellLauncher = `#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$ROOT/node" "$ROOT/dist/cli.js" "$@"\n`;
  const windowsLauncher = `@echo off\r\nsetlocal\r\n"%~dp0..\\node.exe" "%~dp0..\\dist\\cli.js" %*\r\n`;
  await fsp.writeFile(path.join(bundleRoot, "bin", "codegraph"), shellLauncher, "utf8");
  await fsp.chmod(path.join(bundleRoot, "bin", "codegraph"), 0o755);
  await fsp.writeFile(path.join(bundleRoot, "bin", "codegraph.cmd"), windowsLauncher, "utf8");
  if (platform === "win32") return;
}

async function copyNodeLicense(nodeExecutable, bundleRoot) {
  const candidates = ["LICENSE", "LICENSE.txt", "LICENSES.txt"].map((name) =>
    path.join(path.dirname(nodeExecutable), name),
  );
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  if (!source) throw new Error(`Unable to locate the Node.js license beside ${nodeExecutable}.`);
  await copyRequiredFile(source, path.join(bundleRoot, "licenses", "node", "LICENSE"));
}

async function collectFileRecords(root) {
  const files = [];
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Standalone bundle contains a symlink: ${absolute}`);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Standalone bundle contains unsupported file type: ${absolute}`);
      const stat = await fsp.stat(absolute);
      files.push({
        path: path.relative(root, absolute).replaceAll("\\", "/"),
        size: stat.size,
        sha256: await sha256File(absolute),
      });
    }
  }
  await visit(root);
  validateArchiveEntries(files);
  return files;
}

function createArchive(parentDir, bundleName, archivePath, archiveType) {
  if (archiveType === "zip") {
    if (process.platform !== "win32") throw new Error("Windows standalone ZIP archives must be assembled on Windows.");
    const windowsDirectory = process.env.WINDIR ?? "C:\\Windows";
    execFileSync(path.join(windowsDirectory, "System32", "tar.exe"), ["-a", "-cf", archivePath, bundleName], {
      cwd: parentDir,
      stdio: "inherit",
    });
    return;
  }
  execFileSync("tar", ["-czf", archivePath, bundleName], { cwd: parentDir, stdio: "inherit" });
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

async function copyRequiredFile(source, destination) {
  await requireFile(source, path.basename(source));
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(source, destination);
}

async function requireFile(filePath, label) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Missing ${label}: ${filePath}`);
}

async function requireDirectory(directory, label) {
  const stat = await fsp.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Missing ${label}: ${directory}`);
}
