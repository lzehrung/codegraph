import fs from "node:fs";
import path from "node:path";
import {
  prepareNativePackageManifestForPublish,
  restoreRootPackageManifest,
  sanitizePublishedRootPackageManifest,
} from "../release-lib.mjs";
import { assertCompleteNativeTargetArtifacts, getSupportedNativeTargetSuffixes } from "../native-targets-lib.mjs";
import {
  PackageCertificationError,
  describeCandidateFile,
  validateReleaseCandidateManifest,
  verifyReleaseCandidateFiles,
  writeJsonFile,
  writeSha256Sums,
} from "./package-contract-lib.mjs";
import { runPackageCommand } from "./package-smoke-lib.mjs";

function parsePackResult(result, packageDirectory) {
  if (result.error) {
    throw new PackageCertificationError("pack-failed", `Could not start npm pack for ${packageDirectory}.`, {
      packageDirectory,
      cause: result.error,
    });
  }
  if (result.exitCode !== 0) {
    throw new PackageCertificationError("pack-failed", `npm pack failed for ${packageDirectory}.`, {
      packageDirectory,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(result.rawStdout);
  } catch (error) {
    throw new PackageCertificationError("pack-failed", `npm pack returned malformed JSON for ${packageDirectory}.`, {
      packageDirectory,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const pack = Array.isArray(parsed) ? parsed[0] : null;
  if (!pack || typeof pack.name !== "string" || typeof pack.version !== "string" || typeof pack.filename !== "string") {
    throw new PackageCertificationError("pack-failed", `npm pack omitted package identity for ${packageDirectory}.`, {
      packageDirectory,
    });
  }
  return pack;
}

export function packNpmPackage(packageDirectory, outputDirectory) {
  const result = runPackageCommand(
    "npm",
    ["pack", ".", "--json", "--ignore-scripts", "--pack-destination", outputDirectory],
    { cwd: packageDirectory },
  );
  return parsePackResult(result, packageDirectory);
}

function ensureEmptyOutputDirectory(outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const existing = fs.readdirSync(outputDirectory);
  if (existing.length) {
    throw new PackageCertificationError(
      "candidate-output-not-empty",
      `Release candidate output directory must be empty: ${outputDirectory}`,
      { outputDirectory, existing },
    );
  }
}

function writeJsonSync(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function candidateRecord(pack, packagesDirectory, outputDirectory, target) {
  const absolutePath = path.join(packagesDirectory, pack.filename);
  const details = await describeCandidateFile(absolutePath);
  const file = path.relative(outputDirectory, absolutePath).replaceAll(path.sep, "/");
  return {
    package: pack.name,
    ...(target ? { target } : {}),
    file,
    sha256: details.sha256,
    size: details.size,
  };
}

function assertPackedIdentity(pack, expectedName, expectedVersion, target) {
  if (pack.name !== expectedName || pack.version !== expectedVersion) {
    throw new PackageCertificationError(
      "candidate-identity-mismatch",
      `Packed package identity does not match release plan.`,
      {
        target,
        expectedName,
        actualName: pack.name,
        expectedVersion,
        actualVersion: pack.version,
      },
    );
  }
}

export async function assembleReleaseCandidates(options) {
  const rootDirectory = path.resolve(options.rootDirectory ?? process.cwd());
  const outputDirectory = path.resolve(
    options.outputDirectory ?? path.join(rootDirectory, "temp", "release-candidates"),
  );
  const rootPackagePath = path.join(rootDirectory, "package.json");
  const nativeRoot = path.join(rootDirectory, "packages", "codegraph-native");
  const nativePackagePath = path.join(nativeRoot, "package.json");
  const originalRootPackageJson = fs.readFileSync(rootPackagePath, "utf8");
  const originalNativePackageJson = fs.readFileSync(nativePackagePath, "utf8");
  const rootPackage = JSON.parse(originalRootPackageJson);
  const nativePackage = JSON.parse(originalNativePackageJson);
  const sourceRevision = options.sourceRevision;
  const rootVersion = options.rootVersion;
  const nativeVersion = options.nativeVersion;
  const packPackage = options.packPackage ?? packNpmPackage;

  if (typeof sourceRevision !== "string" || !sourceRevision.trim()) {
    throw new PackageCertificationError("candidate-identity-mismatch", "sourceRevision is required.");
  }
  if (typeof rootVersion !== "string" || typeof nativeVersion !== "string") {
    throw new PackageCertificationError("candidate-identity-mismatch", "rootVersion and nativeVersion are required.");
  }
  if (rootPackage.name !== "@lzehrung/codegraph" || nativePackage.name !== "@lzehrung/codegraph-native") {
    throw new PackageCertificationError("candidate-identity-mismatch", "Release package names do not match Codegraph.");
  }

  ensureEmptyOutputDirectory(outputDirectory);
  const packagesDirectory = path.join(outputDirectory, "packages");
  fs.mkdirSync(packagesDirectory);

  const releaseNativePackage = { ...nativePackage, version: nativeVersion };
  const targetPackages = assertCompleteNativeTargetArtifacts(nativeRoot, releaseNativePackage);
  const expectedTargets = getSupportedNativeTargetSuffixes(releaseNativePackage);
  const optionalDependencies = Object.fromEntries(
    targetPackages.map((targetPackage) => [targetPackage.packageJson.name, nativeVersion]),
  );
  const publishNativePackage = prepareNativePackageManifestForPublish(nativePackage, nativeVersion, {
    ...releaseNativePackage,
    optionalDependencies,
  });
  const publishRootPackage = sanitizePublishedRootPackageManifest(
    restoreRootPackageManifest(rootPackage, rootVersion, nativeVersion),
  );

  const files = [];
  try {
    for (const targetPackage of targetPackages) {
      const packageDirectory = path.dirname(targetPackage.packagePath);
      const pack = await packPackage(packageDirectory, packagesDirectory);
      assertPackedIdentity(pack, targetPackage.packageJson.name, nativeVersion, targetPackage.suffix);
      files.push(await candidateRecord(pack, packagesDirectory, outputDirectory, targetPackage.suffix));
    }

    writeJsonSync(nativePackagePath, publishNativePackage);
    const nativePack = await packPackage(nativeRoot, packagesDirectory);
    assertPackedIdentity(nativePack, nativePackage.name, nativeVersion);
    files.push(await candidateRecord(nativePack, packagesDirectory, outputDirectory));

    writeJsonSync(rootPackagePath, publishRootPackage);
    const rootPack = await packPackage(rootDirectory, packagesDirectory);
    assertPackedIdentity(rootPack, rootPackage.name, rootVersion);
    files.push(await candidateRecord(rootPack, packagesDirectory, outputDirectory));
  } finally {
    fs.writeFileSync(rootPackagePath, originalRootPackageJson, "utf8");
    fs.writeFileSync(nativePackagePath, originalNativePackageJson, "utf8");
  }

  const manifest = validateReleaseCandidateManifest(
    {
      schemaVersion: 1,
      sourceRevision,
      rootVersion,
      nativeVersion,
      files,
    },
    { expectedTargets },
  );
  const manifestPath = path.join(outputDirectory, "release-candidate-manifest.json");
  const checksumsPath = path.join(outputDirectory, "SHA256SUMS");
  await writeJsonFile(manifestPath, manifest);
  await writeSha256Sums(manifest, checksumsPath);
  await verifyReleaseCandidateFiles(manifest, outputDirectory);
  return { manifest, manifestPath, checksumsPath, outputDirectory };
}
