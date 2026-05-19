import fs from "node:fs";
import path from "node:path";

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toPackageTargetSuffix(target) {
  if (target === "x86_64-pc-windows-msvc") return "win32-x64-msvc";
  if (target === "aarch64-pc-windows-msvc") return "win32-arm64-msvc";
  if (target === "x86_64-apple-darwin") return "darwin-x64";
  if (target === "aarch64-apple-darwin") return "darwin-arm64";
  if (target === "x86_64-unknown-linux-gnu") return "linux-x64-gnu";
  if (target === "aarch64-unknown-linux-gnu") return "linux-arm64-gnu";
  if (target === "x86_64-unknown-linux-musl") return "linux-x64-musl";
  if (target === "aarch64-unknown-linux-musl") return "linux-arm64-musl";
  throw new Error(`Unsupported native target in package manifest: ${target}`);
}

export function getSupportedNativeTargetSuffixes(nativePackage) {
  const targets = nativePackage.napi?.targets;
  if (!Array.isArray(targets) || !targets.every((target) => typeof target === "string")) {
    throw new Error("Native package manifest is missing napi.targets.");
  }
  return targets.map(toPackageTargetSuffix).sort((left, right) => left.localeCompare(right));
}

export function getSupportedNativeTargetPackageNames(nativePackage) {
  return getSupportedNativeTargetSuffixes(nativePackage).map((suffix) => `@lzehrung/codegraph-native-${suffix}`);
}

export function readNativeTargetPackage(nativeRoot, suffix) {
  const packagePath = path.join(nativeRoot, "npm", suffix, "package.json");
  if (!fs.existsSync(packagePath)) {
    return { suffix, packagePath, packageJson: null, mainFile: null };
  }
  const packageJson = readJsonFile(packagePath);
  const mainFile =
    typeof packageJson.main === "string" ? path.join(nativeRoot, "npm", suffix, packageJson.main) : null;
  return { suffix, packagePath, packageJson, mainFile };
}

export function collectNativeTargetPackages(nativeRoot, nativePackage) {
  return getSupportedNativeTargetSuffixes(nativePackage).map((suffix) => readNativeTargetPackage(nativeRoot, suffix));
}

export function assertCompleteNativeTargetArtifacts(nativeRoot, nativePackage) {
  const targetPackages = collectNativeTargetPackages(nativeRoot, nativePackage);
  const expectedPackageNames = new Map(
    getSupportedNativeTargetSuffixes(nativePackage).map((suffix) => [
      suffix,
      `@lzehrung/codegraph-native-${suffix}`,
    ]),
  );
  const missingTargets = targetPackages
    .filter((targetPackage) => !targetPackage.mainFile || !fs.existsSync(targetPackage.mainFile))
    .map((targetPackage) => targetPackage.suffix);
  const invalidPackageNames = targetPackages
    .filter(
      (targetPackage) =>
        targetPackage.packageJson &&
        targetPackage.packageJson.name !== expectedPackageNames.get(targetPackage.suffix),
    )
    .map((targetPackage) => targetPackage.suffix);
  const invalidPackageVersions = targetPackages
    .filter((targetPackage) => targetPackage.packageJson && targetPackage.packageJson.version !== nativePackage.version)
    .map((targetPackage) => targetPackage.suffix);

  if (missingTargets.length) {
    throw new Error(
      `Missing staged native artifacts for supported targets: ${missingTargets.join(
        ", ",
      )}. Build or collect every native target before publishing @lzehrung/codegraph-native. Use the release-native GitHub Actions workflow when publishing from a local shell cannot produce every platform artifact.`,
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
