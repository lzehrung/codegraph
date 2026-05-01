export const validReleaseTypes = new Set(["patch", "minor", "major"]);

export const releasePackages = [
  {
    id: "root",
    name: "@lzehrung/codegraph",
    manifestPath: "package.json",
    publishWorkspace: null,
    ownedFiles: new Set([
      "package.json",
      "README.md",
      "scripts/release-lib.mjs",
      "scripts/release.mjs",
      "tests/release-script.test.ts",
    ]),
    ownedPrefixes: ["src/", "codegraph-skill/"],
  },
  {
    id: "native",
    name: "@lzehrung/codegraph-native",
    manifestPath: "packages/codegraph-native/package.json",
    publishWorkspace: "@lzehrung/codegraph-native",
    ownedFiles: new Set([]),
    ownedPrefixes: ["packages/codegraph-native/"],
  },
  {
    id: "js-fallback",
    name: "@lzehrung/codegraph-js-fallback",
    manifestPath: "packages/codegraph-js-fallback/package.json",
    publishWorkspace: "@lzehrung/codegraph-js-fallback",
    ownedFiles: new Set([]),
    ownedPrefixes: ["packages/codegraph-js-fallback/"],
  },
];

export const managedReleasePaths = new Set([
  "package-lock.json",
  "scripts/release-lib.mjs",
  "scripts/release.mjs",
  "tests/release-script.test.ts",
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

export function isAllowedResumePath(filePath) {
  return managedReleasePaths.has(normalizeFilePath(filePath));
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
    steps.push("publishNativeTargets", "publishNativeMeta");
  }
  if (publishPlan.publishByPackage["@lzehrung/codegraph-js-fallback"]) {
    steps.push("publishJsFallback");
  }
  if (publishPlan.publishByPackage["@lzehrung/codegraph"]) {
    steps.push("prepareRootManifest", "publishRoot");
  }
  return steps;
}

export function sanitizeJsFallbackPackageManifest(pkg) {
  const normalized = { ...pkg };
  if (
    normalized.dependencies &&
    typeof normalized.dependencies === "object" &&
    !Array.isArray(normalized.dependencies)
  ) {
    const dependencies = { ...normalized.dependencies };
    delete dependencies["@lzehrung/codegraph"];
    normalized.dependencies = dependencies;
  }
  return normalized;
}

export function sanitizePublishedRootPackageManifest(pkg) {
  const normalized = { ...pkg };
  delete normalized.devDependencies;
  delete normalized.scripts;
  delete normalized.workspaces;
  return normalized;
}

export function restoreRootPackageManifest(pkg, version) {
  return {
    ...pkg,
    version,
  };
}

export function recoverRootPackageManifestForResume(currentPkg, sourcePkg) {
  const hasSourceOnlyFields = "scripts" in currentPkg && "workspaces" in currentPkg && "devDependencies" in currentPkg;
  if (hasSourceOnlyFields) {
    return currentPkg;
  }
  return restoreRootPackageManifest(sourcePkg, currentPkg.version);
}

export function recoverNativePackageManifestForResume(currentPkg, sourcePkg) {
  return restoreNativePackageManifest(sourcePkg, currentPkg.version);
}

export function restoreNativePackageManifest(pkg, version) {
  return {
    ...pkg,
    version,
  };
}
