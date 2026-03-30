import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  bumpVersion,
  computePublishPlan,
  isAllowedResumePath,
  validReleaseTypes,
} from "./release-lib.mjs";

const rootDir = process.cwd();
const rootPackagePath = path.join(rootDir, "package.json");
const nativePackagePath = path.join(
  rootDir,
  "packages",
  "codegraph-native",
  "package.json",
);
const jsFallbackPackagePath = path.join(
  rootDir,
  "optional-packages",
  "codegraph-js-fallback",
  "package.json",
);

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

function runOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
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

function ensureCleanWorktree() {
  const status = gitOutput(["status", "--short"]);
  if (status) {
    console.error("Release scripts require a clean git worktree.");
    process.exit(1);
  }
}

function ensureResumableWorktree() {
  const status = gitOutput(["status", "--short"]);
  if (!status) {
    return;
  }
  const unexpectedPaths = status
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((filePath) => !isAllowedResumePath(filePath));
  if (unexpectedPaths.length > 0) {
    console.error(
      `Release resume only supports dirty version files. Unexpected paths: ${unexpectedPaths.join(", ")}`,
    );
    process.exit(1);
  }
}

function updateVersions(nextVersion) {
  const rootPackage = readJson(rootPackagePath);
  const nativePackage = readJson(nativePackagePath);
  const jsFallbackPackage = readJson(jsFallbackPackagePath);

  rootPackage.version = nextVersion;
  if (rootPackage.dependencies) {
    delete rootPackage.dependencies["@lzehrung/codegraph-native"];
  }
  if (!rootPackage.optionalDependencies) {
    rootPackage.optionalDependencies = {};
  }
  rootPackage.optionalDependencies["@lzehrung/codegraph-native"] =
    `^${nextVersion}`;
  nativePackage.version = nextVersion;
  jsFallbackPackage.version = nextVersion;

  writeJson(rootPackagePath, rootPackage);
  writeJson(nativePackagePath, nativePackage);
  writeJson(jsFallbackPackagePath, jsFallbackPackage);
}

function restoreNativePackage(version) {
  const nativePackage = readJson(nativePackagePath);
  nativePackage.version = version;
  delete nativePackage.optionalDependencies;
  writeJson(nativePackagePath, nativePackage);
}

function doesLocalTagExist(version) {
  return gitOutput(["tag", "--list", `v${version}`]).length > 0;
}

function packageExistsInRegistry(packageName, version) {
  const result = runOutput("npm", [
    "view",
    `${packageName}@${version}`,
    "version",
    "--registry=https://npm.pkg.github.com",
  ]);
  return result.status === 0 && result.stdout === version;
}

function commitAndTag(version) {
  run("git", [
    "add",
    "package.json",
    "package-lock.json",
    "packages/codegraph-native/package.json",
    "optional-packages/codegraph-js-fallback/package.json",
  ]);
  const commitNeeded = runOutput("git", ["diff", "--cached", "--quiet"]).status !== 0;
  if (commitNeeded) {
    run("git", ["commit", "-m", `v${version}`]);
  }
  if (!doesLocalTagExist(version)) {
    run("git", ["tag", "-a", `v${version}`, "-m", `v${version}`]);
  }
}

const releaseType = process.argv[2];
const shouldPublish = process.argv.includes("--publish");
const shouldResume = releaseType === "resume";

if (!shouldResume && !validReleaseTypes.has(releaseType)) {
  console.error(
    "Usage: node ./scripts/release.mjs <patch|minor|major|resume> [--publish]",
  );
  process.exit(1);
}

if (shouldResume) {
  ensureResumableWorktree();
} else {
  ensureCleanWorktree();
}

const currentVersion = readJson(rootPackagePath).version;
const nextVersion = shouldResume
  ? currentVersion
  : bumpVersion(currentVersion, releaseType);

if (!shouldResume) {
  updateVersions(nextVersion);
}
run("npm", ["install"]);
run("npm", ["run", "test:ci"]);
run("npm", ["run", "build"]);

if (shouldPublish) {
  const publishPlan = computePublishPlan({
    shouldPublish,
    publishedRoot: packageExistsInRegistry("@lzehrung/codegraph", nextVersion),
    publishedNativeMeta: packageExistsInRegistry(
      "@lzehrung/codegraph-native",
      nextVersion,
    ),
    publishedJsFallback: packageExistsInRegistry(
      "@lzehrung/codegraph-js-fallback",
      nextVersion,
    ),
  });
  if (
    publishPlan.publishNativeTargets ||
    publishPlan.publishNativeMeta
  ) {
    run("npm", ["run", "native:create-npm-dirs"]);
    run("npm", ["run", "native:stage-local"]);
    run("npm", ["run", "native:sync-meta"]);
  }
  try {
    if (publishPlan.publishNativeTargets) {
      run("npm", ["run", "publish:native:targets"]);
    }
    if (publishPlan.publishNativeMeta) {
      run("npm", ["run", "publish:native:meta"]);
    }
    if (publishPlan.publishJsFallback) {
      run("npm", ["publish"], {
        cwd: path.join(rootDir, "optional-packages", "codegraph-js-fallback"),
      });
    }
    if (publishPlan.publishRoot) {
      run("npm", ["publish"]);
    }
  } finally {
    restoreNativePackage(nextVersion);
  }
}

commitAndTag(nextVersion);
run("git", ["push"]);
run("git", ["push", "--tags"]);
