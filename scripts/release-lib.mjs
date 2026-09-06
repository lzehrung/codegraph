import { getSupportedNativeTargetPackageNames } from "./native-targets-lib.mjs";

export const validReleaseTypes = new Set(["patch", "minor", "major"]);

export const releasePackages = [
  {
    id: "root",
    name: "@lzehrung/codegraph",
    manifestPath: "package.json",
    publishWorkspace: null,
    ownedFiles: new Set([
      "package.json",
      "CHANGELOG.md",
      ".github/workflows/release.yml",
      "README.md",
      "PUBLISHING.md",
      "docs/mcp.md",
      "scripts/check-native-artifacts.mjs",
      "scripts/native-targets-lib.mjs",
      "scripts/release-lib.mjs",
      "scripts/release.mjs",
      "scripts/prepare-release-changelog.mjs",
      "scripts/set-native-package-version.mjs",
      "scripts/stage-native-package.mjs",
      "scripts/publish-native-targets.mjs",
      "scripts/sync-native-meta.mjs",
      "tests/certification-assembly.test.ts",
      "tests/certification-package-contract.test.ts",
      "tests/certification-package-smoke.test.ts",
      "tests/certification-release-workflow.test.ts",
      "tests/certification-report.test.ts",
      "tests/release-script.test.ts",
    ]),
    ownedPrefixes: ["src/", "codegraph-skill/", "scripts/certification/"],
  },
  {
    id: "core",
    name: "@lzehrung/codegraph-core",
    manifestPath: "packages/codegraph-core/package.json",
    publishWorkspace: "@lzehrung/codegraph-core",
    ownedFiles: new Set(["scripts/stage-core-package.mjs", "scripts/stage-core-package-lib.mjs"]),
    ownedPrefixes: ["packages/codegraph-core/"],
  },
  {
    id: "native",
    name: "@lzehrung/codegraph-native",
    manifestPath: "packages/codegraph-native/package.json",
    publishWorkspace: "@lzehrung/codegraph-native",
    ownedFiles: new Set([]),
    ownedPrefixes: ["packages/codegraph-native/"],
  },
];

export const managedReleasePaths = new Set([
  "CHANGELOG.md",
  "package-lock.json",
  "scripts/check-native-artifacts.mjs",
  "scripts/native-targets-lib.mjs",
  "scripts/publish-native-targets.mjs",
  "scripts/release-lib.mjs",
  "scripts/release.mjs",
  "scripts/prepare-release-changelog.mjs",
  "scripts/set-native-package-version.mjs",
  "scripts/stage-native-package.mjs",
  "scripts/sync-native-meta.mjs",
  "tests/release-script.test.ts",
  "docs/mcp.md",
  ...releasePackages.map((pkg) => pkg.manifestPath),
]);

function compareSemverDescending(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart === rightPart) {
      continue;
    }
    return rightPart - leftPart;
  }
  return 0;
}

function normalizeFilePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function packageOwnsPath(pkg, filePath) {
  const normalizedPath = normalizeFilePath(filePath);
  if (pkg.ownedFiles.has(normalizedPath)) {
    return true;
  }
  return pkg.ownedPrefixes.some((prefix) => normalizedPath.startsWith(prefix));
}

function parsePackageTagVersion(tagName) {
  const versionSeparator = tagName.lastIndexOf("@");
  if (versionSeparator <= 0) {
    return null;
  }
  return tagName.slice(versionSeparator + 1);
}

function isSemverLike(version) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

export function bumpVersion(version, releaseType) {
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

export function finalizeChangelogForRelease(changelog, version, date) {
  if (!isSemverLike(version)) {
    throw new Error(`Unsupported release version: ${version}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Unsupported release date: ${date}`);
  }
  const unreleasedHeading = "## [Unreleased]";
  const unreleasedStart = changelog.indexOf(`${unreleasedHeading}\n`);
  if (unreleasedStart < 0) {
    throw new Error("CHANGELOG.md is missing the Unreleased section.");
  }
  const contentStart = unreleasedStart + unreleasedHeading.length + 1;
  const nextReleaseStart = changelog.indexOf("\n## [", contentStart);
  if (nextReleaseStart < 0) {
    throw new Error("CHANGELOG.md is missing a released version section.");
  }
  const unreleasedContent = changelog.slice(contentStart, nextReleaseStart);
  if (!/^\s*-\s+\S/m.test(unreleasedContent)) {
    throw new Error("CHANGELOG.md has no Unreleased entries.");
  }
  if (new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m").test(changelog)) {
    throw new Error(`CHANGELOG.md already records version ${version}.`);
  }
  const referencePattern = /^\[Unreleased\]: (https:\/\/github\.com\/lzehrung\/codegraph\/compare\/v[^\s]+)$/m;
  const reference = referencePattern.exec(changelog);
  if (!reference || !reference[1].endsWith("...HEAD")) {
    throw new Error("CHANGELOG.md is missing the Unreleased comparison link.");
  }
  const releaseReference = `[${version}]: https://github.com/lzehrung/codegraph/releases/tag/v${version}`;
  if (changelog.includes(releaseReference)) {
    throw new Error(`CHANGELOG.md already has a release link for ${version}.`);
  }
  const releaseHeading = `## [${version}] - ${date}`;
  const withReleasedSection =
    `${changelog.slice(0, unreleasedStart)}${unreleasedHeading}\n\n${releaseHeading}\n` +
    `${unreleasedContent}${changelog.slice(nextReleaseStart)}`;
  return withReleasedSection.replace(
    reference[0],
    `[Unreleased]: https://github.com/lzehrung/codegraph/compare/v${version}...HEAD\n${releaseReference}`,
  );
}

export function assertChangelogPreparedForRelease(changelog, version) {
  if (!isSemverLike(version)) {
    throw new Error(`Unsupported release version: ${version}`);
  }
  const unreleasedHeading = "## [Unreleased]";
  const unreleasedStart = changelog.indexOf(`${unreleasedHeading}\n`);
  if (unreleasedStart < 0) {
    throw new Error("CHANGELOG.md is missing the Unreleased section.");
  }
  const contentStart = unreleasedStart + unreleasedHeading.length + 1;
  const nextReleaseStart = changelog.indexOf("\n## [", contentStart);
  if (nextReleaseStart < 0) {
    throw new Error("CHANGELOG.md is missing a released version section.");
  }
  const unreleasedContent = changelog.slice(contentStart, nextReleaseStart);
  if (/^\s*-\s+\S/m.test(unreleasedContent)) {
    throw new Error("CHANGELOG.md has Unreleased entries. Run npm run release:prepare-changelog -- <release-type>.");
  }
  const releaseHeading = `## [${version}] - `;
  if (!changelog.startsWith(releaseHeading, nextReleaseStart + 1)) {
    throw new Error(
      `CHANGELOG.md is not prepared for version ${version}. Run npm run release:prepare-changelog -- <release-type>.`,
    );
  }
  const releaseReference = `[${version}]: https://github.com/lzehrung/codegraph/releases/tag/v${version}`;
  if (
    !changelog.includes(`[Unreleased]: https://github.com/lzehrung/codegraph/compare/v${version}...HEAD`) ||
    !changelog.includes(releaseReference)
  ) {
    throw new Error(`CHANGELOG.md is missing release links for ${version}.`);
  }
}

export function isAllowedResumePath(filePath) {
  return managedReleasePaths.has(normalizeFilePath(filePath));
}

export function isNativeTargetArtifactPath(filePath) {
  return normalizeFilePath(filePath).startsWith("packages/codegraph-native/npm/");
}

export function parseGitStatusPaths(statusOutput) {
  if (!statusOutput) {
    return [];
  }
  const entries = statusOutput.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const statusCode = entry.slice(0, 2);
    const currentPath = normalizeFilePath(entry.slice(3));
    paths.push(currentPath);
    if (statusCode.includes("R") || statusCode.includes("C")) {
      index += 1;
    }
  }
  return paths;
}

export function getReleasePackage(selector) {
  const normalizedSelector = selector.trim();
  const match = releasePackages.find((pkg) => pkg.id === normalizedSelector || pkg.name === normalizedSelector);
  if (!match) {
    const knownSelectors = releasePackages.flatMap((pkg) => [pkg.id, pkg.name]).join(", ");
    throw new Error(`Unknown release package selector: ${selector}. Use one of: ${knownSelectors}`);
  }
  return match;
}

export function detectChangedReleasePackages(changedPaths) {
  const matchedPackages = new Set();
  for (const changedPath of changedPaths) {
    const match = releasePackages.find((pkg) => packageOwnsPath(pkg, changedPath));
    if (match) {
      matchedPackages.add(match.id);
    }
  }
  if (matchedPackages.has("root")) {
    matchedPackages.add("core");
  }
  if (matchedPackages.has("core")) {
    matchedPackages.add("root");
  }
  return releasePackages.map((pkg) => pkg.id).filter((pkgId) => matchedPackages.has(pkgId));
}

export function selectLatestSemverTag(tagNames) {
  const semverTags = tagNames
    .map((tagName) => ({ tagName, version: parsePackageTagVersion(tagName) }))
    .filter((entry) => entry.version && isSemverLike(entry.version))
    .sort((left, right) => compareSemverDescending(left.version ?? "0.0.0", right.version ?? "0.0.0"));
  return semverTags[0]?.tagName ?? null;
}

export function selectLatestLegacyTag(tagNames) {
  const legacyTags = tagNames
    .map((tagName) => ({ tagName, version: tagName.startsWith("v") ? tagName.slice(1) : null }))
    .filter((entry) => entry.version && isSemverLike(entry.version))
    .sort((left, right) => compareSemverDescending(left.version ?? "0.0.0", right.version ?? "0.0.0"));
  return legacyTags[0]?.tagName ?? null;
}

export function tagNameForPackageVersion(packageName, version) {
  return `${packageName}@${version}`;
}

export function tagNamesForPackageVersion(packageName, version) {
  const packageScopedTag = tagNameForPackageVersion(packageName, version);
  if (packageName !== "@lzehrung/codegraph") {
    return [packageScopedTag];
  }
  return [`v${version}`, packageScopedTag];
}

export function hasTagForPackageVersion(packageName, version, tagNames) {
  const expectedTags = new Set(tagNamesForPackageVersion(packageName, version));
  return tagNames.some((tagName) => expectedTags.has(tagName));
}

export function computePublishPlan({ shouldPublish, selectedPackageNames, publishedPackageNames }) {
  const publishByPackage = Object.fromEntries(
    selectedPackageNames.map((packageName) => [packageName, shouldPublish && !publishedPackageNames.has(packageName)]),
  );
  return {
    publishByPackage,
    publishNativeTargets: publishByPackage["@lzehrung/codegraph-native"] ?? false,
  };
}

export function computePublishExecutionSteps(publishPlan) {
  const steps = [];
  if (publishPlan.publishByPackage["@lzehrung/codegraph-native"]) {
    steps.push("publishNativeTargets", "prepareNativeMeta", "publishNativeMeta");
  }
  if (publishPlan.publishByPackage["@lzehrung/codegraph-core"] || publishPlan.publishByPackage["@lzehrung/codegraph"]) {
    steps.push("prepareCoreManifest", "publishCore");
  }
  if (publishPlan.publishByPackage["@lzehrung/codegraph"]) {
    steps.push("prepareRootManifest", "publishRoot");
  }
  return steps;
}

export function sanitizePublishedRootPackageManifest(pkg) {
  const normalized = { ...pkg };
  delete normalized.devDependencies;
  delete normalized.scripts;
  delete normalized.workspaces;
  return normalized;
}

function normalizeNativeDependencyVersion(version) {
  return version.replace(/^[~^]/, "");
}

function syncRootNativeOptionalDependency(pkg, nativeVersion) {
  if (!nativeVersion) {
    return pkg;
  }
  const optionalDependencies =
    pkg.optionalDependencies && typeof pkg.optionalDependencies === "object" && !Array.isArray(pkg.optionalDependencies)
      ? { ...pkg.optionalDependencies }
      : null;
  if (!optionalDependencies || typeof optionalDependencies["@lzehrung/codegraph-native"] !== "string") {
    return pkg;
  }
  optionalDependencies["@lzehrung/codegraph-native"] = `^${normalizeNativeDependencyVersion(nativeVersion)}`;
  return {
    ...pkg,
    optionalDependencies,
  };
}

function syncRootCoreDependency(pkg, version) {
  if (!version) {
    return pkg;
  }
  const dependencies =
    pkg.dependencies && typeof pkg.dependencies === "object" && !Array.isArray(pkg.dependencies)
      ? { ...pkg.dependencies }
      : null;
  if (!dependencies || typeof dependencies["@lzehrung/codegraph-core"] !== "string") {
    return pkg;
  }
  dependencies["@lzehrung/codegraph-core"] = version;
  return {
    ...pkg,
    dependencies,
  };
}

export function restoreCorePackageManifest(pkg, version, nativeVersion) {
  return syncRootNativeOptionalDependency(
    {
      ...pkg,
      version,
    },
    nativeVersion,
  );
}

export function restoreRootPackageManifest(pkg, version, nativeVersion) {
  return syncRootNativeOptionalDependency(
    syncRootCoreDependency(
      {
        ...pkg,
        version,
      },
      version,
    ),
    nativeVersion,
  );
}

export function recoverRootPackageManifestForResume(currentPkg, sourcePkg) {
  const hasSourceOnlyFields = "scripts" in currentPkg && "workspaces" in currentPkg && "devDependencies" in currentPkg;
  if (hasSourceOnlyFields) {
    return currentPkg;
  }
  const nativeDependencyVersion =
    currentPkg.optionalDependencies &&
    typeof currentPkg.optionalDependencies === "object" &&
    !Array.isArray(currentPkg.optionalDependencies) &&
    typeof currentPkg.optionalDependencies["@lzehrung/codegraph-native"] === "string"
      ? currentPkg.optionalDependencies["@lzehrung/codegraph-native"]
      : undefined;
  return restoreRootPackageManifest(sourcePkg, currentPkg.version, nativeDependencyVersion);
}

export function recoverNativePackageManifestForResume(currentPkg, sourcePkg) {
  return restoreNativePackageManifest(sourcePkg, currentPkg.version);
}

export function prepareNativePackageManifestForPublish(sourcePkg, version, generatedPkg) {
  const generatedOptionalDependencies =
    generatedPkg.optionalDependencies &&
    typeof generatedPkg.optionalDependencies === "object" &&
    !Array.isArray(generatedPkg.optionalDependencies)
      ? Object.fromEntries(
          Object.entries(generatedPkg.optionalDependencies).sort(([left], [right]) => left.localeCompare(right)),
        )
      : null;
  if (!Object.keys(generatedOptionalDependencies ?? {}).length) {
    throw new Error("Missing generated native platform optionalDependencies for native meta publish.");
  }
  const expectedPackageNames = getSupportedNativeTargetPackageNames(sourcePkg);
  const generatedPackageNames = Object.keys(generatedOptionalDependencies ?? {});
  const missingPackageNames = expectedPackageNames.filter(
    (packageName) => !generatedPackageNames.includes(packageName),
  );
  const unexpectedPackageNames = generatedPackageNames.filter(
    (packageName) => !expectedPackageNames.includes(packageName),
  );
  const mismatchedVersionPackageNames = generatedPackageNames.filter(
    (packageName) => generatedOptionalDependencies?.[packageName] !== version,
  );
  if (missingPackageNames.length || unexpectedPackageNames.length || mismatchedVersionPackageNames.length) {
    const details = [
      missingPackageNames.length ? `missing: ${missingPackageNames.join(", ")}` : "",
      unexpectedPackageNames.length ? `unexpected: ${unexpectedPackageNames.join(", ")}` : "",
      mismatchedVersionPackageNames.length ? `wrong version: ${mismatchedVersionPackageNames.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(`Incomplete generated native platform optionalDependencies for native meta publish (${details}).`);
  }
  return {
    ...sourcePkg,
    version,
    optionalDependencies: generatedOptionalDependencies,
  };
}

export function restoreNativePackageManifest(pkg, version) {
  return {
    ...pkg,
    version,
  };
}
