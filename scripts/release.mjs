import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = process.cwd();
const rootPackagePath = path.join(rootDir, "package.json");
const nativePackagePath = path.join(
  rootDir,
  "packages",
  "codegraph-native",
  "package.json",
);

const validReleaseTypes = new Set(["patch", "minor", "major"]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function bumpVersion(version, releaseType) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (releaseType === "patch") return `${major}.${minor}.${patch + 1}`;
  if (releaseType === "minor") return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

function ensureCleanWorktree() {
  const status = gitOutput(["status", "--short"]);
  if (status) {
    console.error("Release scripts require a clean git worktree.");
    process.exit(1);
  }
}

function updateVersions(nextVersion) {
  const rootPackage = readJson(rootPackagePath);
  const nativePackage = readJson(nativePackagePath);

  rootPackage.version = nextVersion;
  if (!rootPackage.optionalDependencies) {
    rootPackage.optionalDependencies = {};
  }
  rootPackage.optionalDependencies["@lzehrung/codegraph-native"] =
    `^${nextVersion}`;
  nativePackage.version = nextVersion;

  writeJson(rootPackagePath, rootPackage);
  writeJson(nativePackagePath, nativePackage);
}

function restoreNativePackage(version) {
  const nativePackage = readJson(nativePackagePath);
  nativePackage.version = version;
  delete nativePackage.optionalDependencies;
  writeJson(nativePackagePath, nativePackage);
}

function commitAndTag(version) {
  run("git", [
    "add",
    "package.json",
    "package-lock.json",
    "packages/codegraph-native/package.json",
  ]);
  run("git", ["commit", "-m", `v${version}`]);
  run("git", ["tag", "-a", `v${version}`, "-m", `v${version}`]);
}

const releaseType = process.argv[2];
const shouldPublish = process.argv.includes("--publish");

if (!validReleaseTypes.has(releaseType)) {
  console.error("Usage: node ./scripts/release.mjs <patch|minor|major> [--publish]");
  process.exit(1);
}

ensureCleanWorktree();

const currentVersion = readJson(rootPackagePath).version;
const nextVersion = bumpVersion(currentVersion, releaseType);

updateVersions(nextVersion);
run("npm", ["install"]);
run("npm", ["run", "test:ci"]);
run("npm", ["run", "build"]);
run("npm", ["run", "build:native"]);

if (shouldPublish) {
  run("npm", ["run", "native:create-npm-dirs"]);
  run("npm", ["run", "native:stage-local"]);
  run("npm", ["run", "native:sync-meta"]);
  try {
    run("npm", ["run", "publish:native:targets"]);
    run("npm", ["run", "publish:native:meta"]);
    run("npm", ["publish"]);
  } finally {
    restoreNativePackage(nextVersion);
  }
}

commitAndTag(nextVersion);
run("git", ["push"]);
run("git", ["push", "--tags"]);
