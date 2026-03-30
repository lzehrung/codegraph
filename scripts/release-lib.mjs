export const validReleaseTypes = new Set(["patch", "minor", "major"]);

export const managedReleasePaths = new Set([
  "package.json",
  "package-lock.json",
  "packages/codegraph-native/package.json",
  "optional-packages/codegraph-js-fallback/package.json",
]);

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
  return managedReleasePaths.has(filePath);
}

export function computePublishPlan({
  shouldPublish,
  publishedRoot,
  publishedNativeMeta,
  publishedJsFallback,
}) {
  if (!shouldPublish) {
    return {
      publishNativeTargets: false,
      publishNativeMeta: false,
      publishJsFallback: false,
      publishRoot: false,
    };
  }

  const publishNativeMeta = !publishedNativeMeta;
  return {
    publishNativeTargets: publishNativeMeta,
    publishNativeMeta,
    publishJsFallback: !publishedJsFallback,
    publishRoot: !publishedRoot,
  };
}
