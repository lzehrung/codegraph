import fs from "node:fs";
import path from "node:path";

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export const nativeTargetMetadata = Object.freeze(
  [
    ["x86_64-pc-windows-msvc", "win32-x64-msvc", "runtime"],
    ["aarch64-pc-windows-msvc", "win32-arm64-msvc", "structural"],
    ["x86_64-apple-darwin", "darwin-x64", "runtime"],
    ["aarch64-apple-darwin", "darwin-arm64", "runtime"],
    ["x86_64-unknown-linux-gnu", "linux-x64-gnu", "runtime"],
    ["aarch64-unknown-linux-gnu", "linux-arm64-gnu", "runtime"],
    ["x86_64-unknown-linux-musl", "linux-x64-musl", "runtime"],
    ["aarch64-unknown-linux-musl", "linux-arm64-musl", "runtime"],
  ].map(([rustTarget, suffix, certificationClass]) => Object.freeze({ rustTarget, suffix, certificationClass })),
);

const nativeTargetByRustTarget = new Map(nativeTargetMetadata.map((target) => [target.rustTarget, target]));
const nativeTargetBySuffix = new Map(nativeTargetMetadata.map((target) => [target.suffix, target]));

function toPackageTargetSuffix(target) {
  const metadata = nativeTargetByRustTarget.get(target);
  if (!metadata) {
    throw new Error(`Unsupported native target in package manifest: ${target}`);
  }
  return metadata.suffix;
}

export function getNativeTargetMetadata(suffix) {
  const metadata = nativeTargetBySuffix.get(suffix);
  if (!metadata) {
    throw new Error(`Unsupported native target suffix: ${suffix}`);
  }
  return metadata;
}

export function getSupportedNativeTargetSuffixes(nativePackage) {
  const targets = nativePackage.napi?.targets;
  if (!Array.isArray(targets) || !targets.every((target) => typeof target === "string")) {
    throw new Error("Native package manifest is missing napi.targets.");
  }
  return targets.map(toPackageTargetSuffix).sort((left, right) => left.localeCompare(right));
}

export function getSupportedNativeTargetMetadata(nativePackage) {
  return getSupportedNativeTargetSuffixes(nativePackage).map((suffix) => getNativeTargetMetadata(suffix));
}

export function getSupportedNativeTargetPackageNames(nativePackage) {
  return getSupportedNativeTargetSuffixes(nativePackage).map((suffix) => `@lzehrung/codegraph-native-${suffix}`);
}

export function readNativeTargetPackage(nativeRoot, suffix) {
  const { certificationClass } = getNativeTargetMetadata(suffix);
  const packagePath = path.join(nativeRoot, "npm", suffix, "package.json");
  if (!fs.existsSync(packagePath)) {
    return { suffix, certificationClass, packagePath, packageJson: null, mainFile: null };
  }
  const packageJson = readJsonFile(packagePath);
  const mainFile = typeof packageJson.main === "string" ? path.join(nativeRoot, "npm", suffix, packageJson.main) : null;
  return { suffix, certificationClass, packagePath, packageJson, mainFile };
}

export function collectNativeTargetPackages(nativeRoot, nativePackage) {
  return getSupportedNativeTargetSuffixes(nativePackage).map((suffix) => readNativeTargetPackage(nativeRoot, suffix));
}

export function assertCompleteNativeTargetArtifacts(nativeRoot, nativePackage) {
  const targetPackages = collectNativeTargetPackages(nativeRoot, nativePackage);
  const expectedPackageNames = new Map(
    getSupportedNativeTargetSuffixes(nativePackage).map((suffix) => [suffix, `@lzehrung/codegraph-native-${suffix}`]),
  );
  const missingTargets = targetPackages
    .filter((targetPackage) => !targetPackage.mainFile || !fs.existsSync(targetPackage.mainFile))
    .map((targetPackage) => targetPackage.suffix);
  const invalidPackageNames = targetPackages
    .filter(
      (targetPackage) =>
        targetPackage.packageJson && targetPackage.packageJson.name !== expectedPackageNames.get(targetPackage.suffix),
    )
    .map((targetPackage) => targetPackage.suffix);
  const invalidPackageVersions = targetPackages
    .filter((targetPackage) => targetPackage.packageJson && targetPackage.packageJson.version !== nativePackage.version)
    .map((targetPackage) => targetPackage.suffix);

  if (missingTargets.length) {
    throw new Error(
      `Missing staged native artifacts for supported targets: ${missingTargets.join(
        ", ",
      )}. Build or collect every native target before publishing @lzehrung/codegraph-native. Use the release GitHub Actions workflow when publishing from a local shell cannot produce every platform artifact.`,
    );
  }
  if (invalidPackageNames.length) {
    throw new Error(`Invalid native target package metadata for supported targets: ${invalidPackageNames.join(", ")}.`);
  }
  if (invalidPackageVersions.length) {
    throw new Error(
      `Native target package versions do not match ${nativePackage.version}: ${invalidPackageVersions.join(", ")}.`,
    );
  }

  return targetPackages;
}
