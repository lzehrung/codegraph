import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  bumpVersion,
  computePublishPlan,
  computePublishExecutionSteps,
  detectChangedReleasePackages,
  getReleasePackage,
  isAllowedResumePath,
  isNativeTargetArtifactPath,
  parseGitStatusPaths,
  prepareNativePackageManifestForPublish,
  recoverNativePackageManifestForResume,
  recoverRootPackageManifestForResume,
  releasePackages,
  restoreCorePackageManifest,
  restoreRootPackageManifest,
  restoreNativePackageManifest,
  sanitizePublishedRootPackageManifest,
  selectLatestLegacyTag,
  selectLatestSemverTag,
  tagNamesForPackageVersion,
  validReleaseTypes,
} from "./release-lib.mjs";
import { assertCompleteNativeTargetArtifacts } from "./native-targets-lib.mjs";

const rootDir = process.cwd();
const rootPackagePath = path.join(rootDir, "package.json");
const nativeRootPath = path.join(rootDir, "packages", "codegraph-native");
const nativePackagePath = path.join(rootDir, "packages", "codegraph-native", "package.json");
const corePackagePath = path.join(rootDir, "packages", "codegraph-core", "package.json");
const currentRootPackage = readJson(rootPackagePath);
const currentNativePackage = readJson(nativePackagePath);
const currentCorePackage = readJson(corePackagePath);
const originalRootPackageJson = `${JSON.stringify(
  recoverRootPackageManifestForResume(currentRootPackage, readJsonFromString(readGitFile("package.json"))),
  null,
  2,
)}\n`;
const originalNativePackageJson = `${JSON.stringify(
  recoverNativePackageManifestForResume(
    currentNativePackage,
    readJsonFromString(readGitFile("packages/codegraph-native/package.json")),
  ),
  null,
  2,
)}\n`;
const originalCorePackageJson = `${JSON.stringify(
  {
    ...readJsonFromString(readGitFile("packages/codegraph-core/package.json")),
    version: currentCorePackage.version,
  },
  null,
  2,
)}\n`;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonFromString(contents) {
  return JSON.parse(contents);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readGitFile(relativePath) {
  const result = spawnSync("git", ["show", `HEAD:${relativePath}`], {
    cwd: rootDir,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? 1}`);
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
    throw new Error(`git ${args.join(" ")} failed with status ${result.status ?? 1}`);
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

function refreshDependencies() {
  run("npm", ["install"]);
  normalizeLockfile();
  verifyLockfileInstallable();
}

/**
 * `npm install` resolves against the node_modules already present on this host, so
 * optional dependencies that this platform does not install get pruned from the lock.
 * That produced a 2.2.1 lock missing `@emnapi/core` and `@emnapi/runtime`, which are
 * reachable only through the wasm-only `@napi-rs/wasm-runtime` and
 * `@rolldown/binding-wasm32-wasi` packages. `npm ci` then failed on Linux and Windows
 * while macOS still passed, because macOS resolves a different optional set.
 *
 * `--package-lock-only` re-resolves from the registry instead of from node_modules, so
 * the lock describes every optional variant regardless of the release host.
 */
function normalizeLockfile() {
  run("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
}

/**
 * A release must never publish a lock that `npm ci` rejects. This is the gate that
 * turns a post-release main breakage into a pre-release failure.
 */
function verifyLockfileInstallable() {
  const result = runOutput("npm", ["ci", "--ignore-scripts", "--dry-run"]);
  if (result.status === 0) {
    return;
  }
  // npm can exit non-zero without writing anything, for example on a spawn failure,
  // so always report the command and exit status rather than an empty line.
  const npmOutput = (result.stderr || result.stdout).trim();
  console.error(npmOutput || `npm ci --ignore-scripts --dry-run exited ${result.status} without output.`);
  throw new Error(
    "package-lock.json is not installable with `npm ci` after the version bump. " +
      "Run `npm install --package-lock-only --ignore-scripts` and commit the result before releasing.",
  );
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
  const result = spawnSync("git", ["status", "--short", "-z"], {
    cwd: rootDir,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return parseGitStatusPaths(result.stdout ?? "");
}

function ensureCleanWorktree({ allowNativeTargetArtifacts = false } = {}) {
  const dirtyPaths = getDirtyPaths();
  const unexpectedPaths = allowNativeTargetArtifacts
    ? dirtyPaths.filter((filePath) => !isNativeTargetArtifactPath(filePath))
    : dirtyPaths;
  if (unexpectedPaths.length) {
    console.error("Release scripts require a clean git worktree.");
    process.exit(1);
  }
}

function ensureResumableWorktree() {
  const dirtyPaths = getDirtyPaths();
  const unexpectedPaths = dirtyPaths.filter((filePath) => !isAllowedResumePath(filePath));
  if (unexpectedPaths.length) {
    console.error(`Release resume only supports dirty version files. Unexpected paths: ${unexpectedPaths.join(", ")}`);
    process.exit(1);
  }
}

function readCurrentPackageVersions() {
  return new Map(releasePackages.map((pkg) => [pkg.id, readJson(path.join(rootDir, pkg.manifestPath)).version]));
}

function normalizeManagedManifests(versionPlan) {
  let rootPackage = JSON.parse(originalRootPackageJson);
  const nativePackage = JSON.parse(originalNativePackageJson);
  let corePackage = JSON.parse(originalCorePackageJson);

  const rootVersion = versionPlan.get("root");
  const nativeVersion = versionPlan.get("native");
  const coreVersion = versionPlan.get("core") ?? rootVersion;

  if (rootVersion) {
    rootPackage.version = rootVersion;
  }
  if (nativeVersion) {
    nativePackage.version = nativeVersion;
  }
  if (coreVersion) {
    corePackage = restoreCorePackageManifest(corePackage, coreVersion, nativePackage.version);
  }
  if (rootVersion) {
    rootPackage = restoreRootPackageManifest(rootPackage, rootVersion, nativePackage.version);
  }
  if (!rootVersion && nativeVersion) {
    rootPackage = restoreRootPackageManifest(rootPackage, rootPackage.version, nativePackage.version);
  }

  writeJson(rootPackagePath, rootPackage);
  writeJson(nativePackagePath, nativePackage);
  writeJson(corePackagePath, corePackage);
}

function restoreNativePackage(versionPlan) {
  const intendedVersion = versionPlan.get("native");
  if (!intendedVersion) {
    fs.writeFileSync(nativePackagePath, originalNativePackageJson);
    return;
  }
  const sourceManifest = JSON.parse(originalNativePackageJson);
  writeJson(nativePackagePath, restoreNativePackageManifest(sourceManifest, intendedVersion));
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
      restoreRootPackageManifest(sourceManifest, intendedVersion, readJson(nativePackagePath).version),
    ),
  );
}

function writePublishReadyCorePackage(versionPlan) {
  const intendedVersion = versionPlan.get("core") ?? versionPlan.get("root");
  if (!intendedVersion) {
    return;
  }
  const sourceManifest = JSON.parse(originalCorePackageJson);
  writeJson(
    corePackagePath,
    restoreCorePackageManifest(sourceManifest, intendedVersion, readJson(nativePackagePath).version),
  );
}

function restoreCorePackage(versionPlan) {
  const sourceManifest = JSON.parse(originalCorePackageJson);
  const intendedVersion = versionPlan.get("core") ?? versionPlan.get("root") ?? sourceManifest.version;
  const nativeVersion = versionPlan.get("native") ?? readJson(nativePackagePath).version;
  writeJson(corePackagePath, restoreCorePackageManifest(sourceManifest, intendedVersion, nativeVersion));
}

function writePublishReadyNativePackage(versionPlan) {
  const intendedVersion = versionPlan.get("native");
  if (!intendedVersion) {
    return;
  }
  const sourceManifest = JSON.parse(originalNativePackageJson);
  const generatedManifest = readJson(nativePackagePath);
  writeJson(
    nativePackagePath,
    prepareNativePackageManifestForPublish(sourceManifest, intendedVersion, generatedManifest),
  );
}

function restoreRootPackage(versionPlan) {
  const sourceManifest = JSON.parse(originalRootPackageJson);
  const intendedVersion = versionPlan.get("root") ?? sourceManifest.version;
  const nativeVersion = versionPlan.get("native") ?? readJson(nativePackagePath).version;
  writeJson(rootPackagePath, restoreRootPackageManifest(sourceManifest, intendedVersion, nativeVersion));
}

function doesLocalTagExist(tagName) {
  return !!gitOutput(["tag", "--list", tagName]).length;
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
    "--registry=https://registry.npmjs.org",
  ]);
  return result.status === 0 && result.stdout === version;
}

function prepareNativeTargetArtifactsForPublish() {
  run("npm", ["run", "native:create-npm-dirs"]);
  run("node", ["./scripts/stage-native-package.mjs", "--if-missing"]);
  assertCompleteNativeTargetArtifacts(nativeRootPath, readJson(nativePackagePath));
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
  return detectChangedReleasePackages(getChangedPathsSinceRef(baselineTag)).includes(pkg.id);
}

function resolveRequestedPackages(packageSelectors) {
  if (!packageSelectors.length) {
    return [];
  }
  const selectedIds = new Set(packageSelectors.map((selector) => getReleasePackage(selector).id));
  return releasePackages.filter((pkg) => selectedIds.has(pkg.id));
}

function shouldAllowNativeTargetArtifactsForCleanCheck({ shouldPublish, packageSelectors }) {
  if (!shouldPublish) {
    return false;
  }
  return packageSelectors.some((selector) => getReleasePackage(selector).id === "native");
}

function determineReleasePackages({ shouldResume, requestedPackages }) {
  if (requestedPackages.length) {
    return requestedPackages;
  }
  if (shouldResume) {
    const dirtyPaths = getDirtyPaths();
    const resumedPackageIds = new Set(
      dirtyPaths
        .filter((filePath) => filePath !== "package-lock.json")
        .map((filePath) => releasePackages.find((pkg) => pkg.manifestPath === filePath)?.id ?? null)
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
    versionPlan.set(pkg.id, shouldResume ? currentVersion : bumpVersion(currentVersion, releaseType));
  }
  return versionPlan;
}

function commitAndTag(selectedPackages, versionPlan) {
  runGit([
    "add",
    "package.json",
    "package-lock.json",
    "packages/codegraph-core/package.json",
    "packages/codegraph-native/package.json",
  ]);
  const commitNeeded =
    spawnSync("git", ["diff", "--cached", "--quiet"], {
      cwd: rootDir,
      shell: false,
    }).status !== 0;
  if (commitNeeded) {
    const releaseLabels = selectedPackages.map((pkg) => `${pkg.name}@${versionPlan.get(pkg.id)}`);
    runGit(["commit", "-m", `release: ${releaseLabels.join(", ")}`]);
  }
  for (const pkg of selectedPackages) {
    const version = versionPlan.get(pkg.id);
    if (!version) {
      continue;
    }
    for (const tagName of tagNamesForPackageVersion(pkg.name, version)) {
      if (doesLocalTagExist(tagName)) {
        continue;
      }
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

const { releaseType, shouldPublish, packageSelectors } = parseArgs(process.argv.slice(2));
const shouldResume = releaseType === "resume";

if (!shouldResume && !validReleaseTypes.has(releaseType)) {
  console.error(
    "Usage: node ./scripts/release.mjs <patch|minor|major|resume> [--publish] [--package <root|native|package-name>]",
  );
  process.exit(1);
}

if (shouldResume) {
  ensureResumableWorktree();
} else {
  ensureCleanWorktree({
    allowNativeTargetArtifacts: shouldAllowNativeTargetArtifactsForCleanCheck({ shouldPublish, packageSelectors }),
  });
}

const requestedPackages = resolveRequestedPackages(packageSelectors);
const currentVersions = readCurrentPackageVersions();
const selectedPackages = determineReleasePackages({
  shouldResume,
  requestedPackages,
});

if (!selectedPackages.length) {
  console.log("No publishable package changes detected.");
  process.exit(0);
}

const versionPlan = planVersions(selectedPackages, currentVersions, {
  releaseType,
  shouldResume,
});
const publishPlan = shouldPublish
  ? computePublishPlan({
      shouldPublish,
      selectedPackageNames: selectedPackages.map((pkg) => pkg.name),
      publishedPackageNames: new Set(
        selectedPackages
          .filter((pkg) => packageExistsInRegistry(pkg.name, versionPlan.get(pkg.id)))
          .map((pkg) => pkg.name),
      ),
    })
  : null;

normalizeManagedManifests(versionPlan);
refreshDependencies();
normalizeManagedManifests(versionPlan);
run("node", ["./scripts/build-native-if-available.mjs", "--strict"]);
if (publishPlan?.publishNativeTargets) {
  prepareNativeTargetArtifactsForPublish();
}
run("npm", ["run", "test:ci"]);
run("npm", ["run", "build"]);

if (publishPlan) {
  try {
    normalizeManagedManifests(versionPlan);
    for (const step of computePublishExecutionSteps(publishPlan)) {
      if (step === "publishNativeTargets") {
        run("npm", ["run", "publish:native:targets"]);
        continue;
      }
      if (step === "prepareNativeMeta") {
        run("npm", ["run", "native:sync-meta"]);
        writePublishReadyNativePackage(versionPlan);
        continue;
      }
      if (step === "publishNativeMeta") {
        run("npm", ["run", "publish:native:meta"]);
        continue;
      }
      if (step === "prepareCoreManifest") {
        writePublishReadyCorePackage(versionPlan);
        continue;
      }
      if (step === "publishCore") {
        run("npm", [
          "publish",
          "--workspace=@lzehrung/codegraph-core",
          "--registry=https://registry.npmjs.org",
          "--access=public",
        ]);
        continue;
      }
      if (step === "prepareRootManifest") {
        writePublishReadyRootPackage(versionPlan);
        continue;
      }
      if (step === "publishRoot") {
        run("npm", ["publish", "--registry=https://registry.npmjs.org", "--access=public"]);
      }
    }
  } finally {
    restoreRootPackage(versionPlan);
    restoreCorePackage(versionPlan);
    restoreNativePackage(versionPlan);
  }
}

commitAndTag(selectedPackages, versionPlan);
runGit(["push"]);
runGit(["push", "--tags"]);
