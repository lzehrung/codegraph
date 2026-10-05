#!/usr/bin/env node
import path from "node:path";
import {
  PackageCertificationError,
  assertReleaseCandidateIdentity,
  computeFileSha256,
  readNativeTargetExceptions,
  readPackageSmokeReports,
  readReleaseCandidateManifest,
  validatePackageSmokeReportSet,
  writeJsonFile,
} from "./package-contract-lib.mjs";
import { currentNativeTargetSuffix, packageSmokeFailureReport, runPackageSmoke } from "./package-smoke-lib.mjs";
import { getNativeTargetMetadata, getSupportedNativeTargetSuffixes, readJsonFile } from "../native-targets-lib.mjs";

const rootDirectory = process.cwd();
const defaultManifestPath = path.join(rootDirectory, "temp", "release-candidates", "release-candidate-manifest.json");
const defaultExceptionsPath = path.join(rootDirectory, "scripts", "certification", "native-target-exceptions.json");

function parseArgs(argv) {
  const options = {};
  const valueOptions = {
    "--manifest": true,
    "--target": true,
    "--mode": true,
    "--output": true,
    "--install-dir": true,
    "--exceptions": true,
    "--verify-reports": true,
    "--expected-source-revision": true,
    "--expected-root-version": true,
    "--expected-native-version": true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!Object.hasOwn(valueOptions, argument)) throw new Error(`Unknown option ${argument}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value after ${argument}.`);
    if (argument === "--manifest") options.manifestPath = value;
    else if (argument === "--target") options.target = value;
    else if (argument === "--mode") options.mode = value;
    else if (argument === "--output") options.outputPath = value;
    else if (argument === "--install-dir") options.installDirectory = value;
    else if (argument === "--exceptions") options.exceptionsPath = value;
    else if (argument === "--verify-reports") options.verifyReports = value;
    else if (argument === "--expected-source-revision") options.expectedSourceRevision = value;
    else if (argument === "--expected-root-version") options.expectedRootVersion = value;
    else if (argument === "--expected-native-version") options.expectedNativeVersion = value;
    index += 1;
  }
  if (options.mode && options.mode !== "runtime" && options.mode !== "structural") {
    throw new PackageCertificationError("mode-invalid", `Unsupported package smoke mode ${options.mode}.`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node ./scripts/certification/run-package-smoke.mjs [--manifest <path>] [--target <suffix>]",
    "    [--mode runtime|structural] [--output <report.json>] [--install-dir <outside-checkout>]",
    "  node ./scripts/certification/run-package-smoke.mjs --verify-reports <dir>",
    "    [--expected-source-revision <sha>] [--expected-root-version <version>]",
    "    [--expected-native-version <version>] [--output <summary.json>]",
  ].join("\n");
}

function nativePackageAndTargets() {
  const nativePackage = readJsonFile(path.join(rootDirectory, "packages", "codegraph-native", "package.json"));
  return { nativePackage, expectedTargets: getSupportedNativeTargetSuffixes(nativePackage) };
}

async function verifyReportSet(options, expectedTargets, exceptions) {
  const manifestPath = path.resolve(options.manifestPath ?? defaultManifestPath);
  const manifest = await readReleaseCandidateManifest(manifestPath, { verifyFiles: true, expectedTargets });
  assertReleaseCandidateIdentity(manifest, {
    sourceRevision: options.expectedSourceRevision,
    rootVersion: options.expectedRootVersion,
    nativeVersion: options.expectedNativeVersion,
  });
  const manifestSha256 = await computeFileSha256(manifestPath);
  const reports = await readPackageSmokeReports(path.resolve(options.verifyReports));
  const summary = validatePackageSmokeReportSet({ manifest, manifestSha256, reports });
  summary.structuralExceptions = exceptions.exceptions;
  const outputPath = path.resolve(
    options.outputPath ?? path.join(rootDirectory, "temp", "certification", "package-smoke-summary.json"),
  );
  await writeJsonFile(outputPath, summary);
  process.stdout.write(
    `${JSON.stringify({ status: "pass", output: outputPath, rows: summary.requiredRows.length })}\n`,
  );
}

async function runSmoke(options, expectedTargets, exceptions) {
  const manifestPath = path.resolve(options.manifestPath ?? defaultManifestPath);
  const target = options.target ?? currentNativeTargetSuffix() ?? undefined;
  const mode = options.mode ?? (target ? getNativeTargetMetadata(target).certificationClass : undefined);
  if (!target) throw new PackageCertificationError("target-mismatch", "Package smoke requires a native target.");
  const outputName = `package-smoke-${target}.json`;
  const outputPath = path.resolve(options.outputPath ?? path.join(rootDirectory, "temp", "certification", outputName));
  const structuralException = exceptions.exceptions.find((entry) => entry.target === target);

  try {
    const report = await runPackageSmoke({
      manifestPath,
      target,
      mode,
      expectedTargets,
      structuralException,
      installDirectory: options.installDirectory ? path.resolve(options.installDirectory) : undefined,
      checkoutDirectory: rootDirectory,
    });
    await writeJsonFile(outputPath, report);
    process.stdout.write(`${JSON.stringify({ status: "pass", mode, target: target ?? null, output: outputPath })}\n`);
  } catch (error) {
    let manifest;
    let manifestSha256;
    try {
      manifest = await readReleaseCandidateManifest(manifestPath, { expectedTargets });
      manifestSha256 = await computeFileSha256(manifestPath);
    } catch {
      manifest = undefined;
      manifestSha256 = undefined;
    }
    const report = packageSmokeFailureReport({ error, manifest, manifestSha256, mode, target });
    await writeJsonFile(outputPath, report);
    throw error;
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const { expectedTargets } = nativePackageAndTargets();
  const exceptions = await readNativeTargetExceptions(path.resolve(options.exceptionsPath ?? defaultExceptionsPath));
  if (options.verifyReports) await verifyReportSet(options, expectedTargets, exceptions);
  else await runSmoke(options, expectedTargets, exceptions);
} catch (error) {
  const code = error instanceof PackageCertificationError ? error.code : "package-smoke-failed";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${usage()}\n${JSON.stringify({ status: "fail", code, message })}\n`);
  process.exitCode = 1;
}
