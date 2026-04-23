import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  bumpVersion,
  computePublishPlan,
  detectChangedReleasePackages,
  getReleasePackage,
  isAllowedResumePath,
  releasePackages,
  restoreRootPackageManifest,
  restoreNativePackageManifest,
  sanitizePublishedRootPackageManifest,
  sanitizeJsFallbackPackageManifest,
  selectLatestLegacyTag,
  selectLatestSemverTag,
  tagNameForPackageVersion,
  validReleaseTypes,
} from "./release-lib.mjs";

const rootDir = process.cwd();
const rootPackagePath = path.join(rootDir, "package.json");
const originalRootPackageJson = fs.readFileSync(rootPackagePath, "utf8");
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
const originalNativePackageJson = fs.readFileSync(nativePackagePath, "utf8");

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

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: false,
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
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function getDirtyPaths() {
  const status = gitOutput(["status", "--short"]);
  if (!status) {
    return [];
  }
  return status
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).replace(/\\/g, "/"));
}

function ensureCleanWorktree() {
  const dirtyPaths = getDirtyPaths();
  if (dirtyPaths.length > 0) {
    console.error("Release scripts require a clean git worktree.");
    process.exit(1);
  }
}

function ensureResumableWorktree() {
  const dirtyPaths = getDirtyPaths();
  const unexpectedPaths = dirtyPaths.filter((filePath) => !isAllowedResumePath(filePath));
  if (unexpectedPaths.length > 0) {
    console.error(
      `Release resume only supports dirty version files. Unexpected paths: ${unexpectedPaths.join(", ")}`,
    );
    process.exit(1);
  }
}

function readCurrentPackageVersions() {
  return new Map(
    releasePackages.map((pkg) => [
      pkg.id,
      readJson(path.join(rootDir, pkg.manifestPath)).version,
    ]),
  );
}

function normalizeManagedManifests(versionPlan) {
  const rootPackage = readJson(rootPackagePath);
  const nativePackage = readJson(nativePackagePath);
  const jsFallbackPackage = sanitizeJsFallbackPackageManifest(
    readJson(jsFallbackPackagePath),
  );

  const rootVersion = versionPlan.get("root");
  const nativeVersion = versionPlan.get("native");
  const jsFallbackVersion = versionPlan.get("js-fallback");

  if (rootVersion) {
    rootPackage.version = rootVersion;
  }
  if (nativeVersion) {
    nativePackage.version = nativeVersion;
  }
  if (jsFallbackVersion) {
    jsFallbackPackage.version = jsFallbackVersion;
  }

  writeJson(rootPackagePath, rootPackage);
  writeJson(nativePackagePath, nativePackage);
  writeJson(jsFallbackPackagePath, jsFallbackPackage);
}

function restoreNativePackage(versionPlan) {
  const intendedVersion = versionPlan.get("native");
  if (!intendedVersion) {
    fs.writeFileSync(nativePackagePath, originalNativePackageJson);
    return;
  }
  const sourceManifest = JSON.parse(originalNativePackageJson);
  writeJson(
    nativePackagePath,
    restoreNativePackageManifest(sourceManifest, intendedVersion),
  );
}

function writePublishReadyRootPackage(versionPlan) {
  const intendedVersion = versionPlan.get("root");
  if (!intendedVersion) {
    return;
  }
  const sourceManifest = JSON.parse(originalRootPackageJson);
  writeJson(
    rootPackagePath,
    sanitizePublishedRootPackageManifest(
      restoreRootPackageManifest(sourceManifest, intendedVersion),
    ),
  );
}

function restoreRootPackage(versionPlan) {
  const intendedVersion = versionPlan.get("root");
  if (!intendedVersion) {
    fs.writeFileSync(rootPackagePath, originalRootPackageJson);
    return;
  }
  const sourceManifest = JSON.parse(originalRootPackageJson);
  writeJson(
    rootPackagePath,
    restoreRootPackageManifest(sourceManifest, intendedVersion),
  );
}

function doesLocalTagExist(tagName) {
  return gitOutput(["tag", "--list", tagName]).length > 0;
}

function listTags(pattern) {
  const output = gitOutput(["tag", "--list", pattern]);
  return output ? output.split("\n").filter(Boolean) : [];
}

function getLatestLegacyReleaseTag() {
  return selectLatestLegacyTag(listTags("v*"));
}

function getLatestPackageReleaseTag(packageName) {
  return selectLatestSemverTag(listTags(`${packageName}@*`));
}

function getBaselineTagForPackage(packageName) {
  return getLatestPackageReleaseTag(packageName) ?? getLatestLegacyReleaseTag();
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

function getChangedPathsSinceRef(refName) {
  if (!refName) {
    return [];
  }
  const output = gitOutput(["diff", "--name-only", `${refName}..HEAD`]);
  return output ? output.split("\n").filter(Boolean) : [];
}

function packageHasOwnedChanges(pkg) {
  const baselineTag = getBaselineTagForPackage(pkg.name);
  if (!baselineTag) {
    return true;
  }
  return detectChangedReleasePackages(getChangedPathsSinceRef(baselineTag)).includes(
    pkg.id,
  );
}

function resolveRequestedPackages(packageSelectors) {
  if (packageSelectors.length === 0) {
    return [];
  }
  const selectedIds = new Set(packageSelectors.map((selector) => getReleasePackage(selector).id));
  return releasePackages.filter((pkg) => selectedIds.has(pkg.id));
}

function determineReleasePackages({ shouldResume, requestedPackages }) {
  if (requestedPackages.length > 0) {
    return requestedPackages;
  }
  if (shouldResume) {
    const dirtyPaths = getDirtyPaths();
    const resumedPackageIds = new Set(
      dirtyPaths
        .filter((filePath) => filePath !== "package-lock.json")
        .map((filePath) =>
          releasePackages.find((pkg) => pkg.manifestPath === filePath)?.id ?? null,
        )
        .filter((pkgId) => pkgId),
    );
    if (resumedPackageIds.size > 0) {
      return releasePackages.filter((pkg) => resumedPackageIds.has(pkg.id));
    }
    return releasePackages;
  }
  return releasePackages.filter((pkg) => packageHasOwnedChanges(pkg));
}

function planVersions(selectedPackages, currentVersions, { releaseType, shouldResume }) {
  const versionPlan = new Map();
  for (const pkg of selectedPackages) {
    const currentVersion = currentVersions.get(pkg.id);
    if (!currentVersion) {
      throw new Error(`Missing current version for ${pkg.name}`);
    }
    versionPlan.set(
      pkg.id,
      shouldResume ? currentVersion : bumpVersion(currentVersion, releaseType),
    );
  }
  return versionPlan;
}

function commitAndTag(selectedPackages, versionPlan) {
  runGit([
    "add",
    "package.json",
    "package-lock.json",
    "packages/codegraph-native/package.json",
    "optional-packages/codegraph-js-fallback/package.json",
  ]);
  const commitNeeded = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: rootDir,
    shell: false,
  }).status !== 0;
  if (commitNeeded) {
    const releaseLabels = selectedPackages.map(
      (pkg) => `${pkg.name}@${versionPlan.get(pkg.id)}`,
    );
    runGit(["commit", "-m", `release: ${releaseLabels.join(", ")}`]);
  }
  for (const pkg of selectedPackages) {
    const version = versionPlan.get(pkg.id);
    if (!version) {
      continue;
    }
    const tagName = tagNameForPackageVersion(pkg.name, version);
    if (!doesLocalTagExist(tagName)) {
      runGit(["tag", "-a", tagName, "-m", tagName]);
    }
  }
}

function parseArgs(argv) {
  const [releaseType, ...rawArgs] = argv;
  const shouldPublish = rawArgs.includes("--publish");
  const packageSelectors = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg !== "--package") {
      continue;
    }
    const selector = rawArgs[index + 1];
    if (!selector) {
      console.error("Missing package selector after --package");
      process.exit(1);
    }
    packageSelectors.push(selector);
    index += 1;
  }

  return { releaseType, shouldPublish, packageSelectors };
}

const { releaseType, shouldPublish, packageSelectors } = parseArgs(
  process.argv.slice(2),
);
const shouldResume = releaseType === "resume";

if (!shouldResume && !validReleaseTypes.has(releaseType)) {
  console.error(
    "Usage: node ./scripts/release.mjs <patch|minor|major|resume> [--publish] [--package <root|native|js-fallback|package-name>]",
  );
  process.exit(1);
}

if (shouldResume) {
  ensureResumableWorktree();
} else {
  ensureCleanWorktree();
}

const requestedPackages = resolveRequestedPackages(packageSelectors);
const currentVersions = readCurrentPackageVersions();
const selectedPackages = determineReleasePackages({
  shouldResume,
  requestedPackages,
});

if (selectedPackages.length === 0) {
  console.log("No publishable package changes detected.");
  process.exit(0);
}

const versionPlan = planVersions(selectedPackages, currentVersions, {
  releaseType,
  shouldResume,
});

normalizeManagedManifests(versionPlan);
run("npm", ["install", "--legacy-peer-deps"]);
normalizeManagedManifests(versionPlan);
run("npm", ["run", "test:ci"]);
run("npm", ["run", "build"]);

if (shouldPublish) {
  const publishedPackageNames = new Set(
    selectedPackages
      .filter((pkg) =>
        packageExistsInRegistry(pkg.name, versionPlan.get(pkg.id)),
      )
      .map((pkg) => pkg.name),
  );
  const publishPlan = computePublishPlan({
    shouldPublish,
    selectedPackageNames: selectedPackages.map((pkg) => pkg.name),
    publishedPackageNames,
  });
  if (publishPlan.publishNativeTargets) {
    run("npm", ["run", "native:create-npm-dirs"]);
    run("npm", ["run", "native:stage-local"]);
    run("npm", ["run", "native:sync-meta"]);
  }
  try {
    normalizeManagedManifests(versionPlan);
    writePublishReadyRootPackage(versionPlan);
    if (publishPlan.publishByPackage["@lzehrung/codegraph-native"]) {
      run("npm", ["run", "publish:native:targets"]);
      run("npm", ["run", "publish:native:meta"]);
    }
    if (publishPlan.publishByPackage["@lzehrung/codegraph-js-fallback"]) {
      run("npm", ["publish", "--workspace=@lzehrung/codegraph-js-fallback"]);
    }
    if (publishPlan.publishByPackage["@lzehrung/codegraph"]) {
      run("npm", ["publish"]);
    }
  } finally {
    restoreRootPackage(versionPlan);
    restoreNativePackage(versionPlan);
  }
}

commitAndTag(selectedPackages, versionPlan);
runGit(["push"]);
runGit(["push", "--tags"]);
