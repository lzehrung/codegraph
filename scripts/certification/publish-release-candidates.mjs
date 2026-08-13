#!/usr/bin/env node
import path from "node:path";
import {
  PackageCertificationError,
  assertReleaseCandidateIdentity,
  readNativeTargetExceptions,
  readReleaseCandidateManifest,
  releaseCandidatePublicationOrder,
} from "./package-contract-lib.mjs";
import { runPackageCommand } from "./package-smoke-lib.mjs";
import { getSupportedNativeTargetSuffixes, readJsonFile } from "../native-targets-lib.mjs";

function parseArgs(argv) {
  const options = { registry: "https://registry.npmjs.org" };
  const supported = {
    "--manifest": true,
    "--registry": true,
    "--expected-source-revision": true,
    "--expected-root-version": true,
    "--expected-native-version": true,
    "--exceptions": true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!Object.hasOwn(supported, argument)) throw new Error(`Unknown option ${argument}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value after ${argument}.`);
    if (argument === "--manifest") options.manifestPath = value;
    else if (argument === "--registry") options.registry = value;
    else if (argument === "--expected-source-revision") options.expectedSourceRevision = value;
    else if (argument === "--expected-root-version") options.expectedRootVersion = value;
    else if (argument === "--expected-native-version") options.expectedNativeVersion = value;
    else if (argument === "--exceptions") options.exceptionsPath = value;
    index += 1;
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (!options.manifestPath) throw new Error("--manifest is required.");
  const manifestPath = path.resolve(options.manifestPath);
  const rootDirectory = process.cwd();
  const nativePackage = readJsonFile(path.join(rootDirectory, "packages", "codegraph-native", "package.json"));
  const expectedTargets = getSupportedNativeTargetSuffixes(nativePackage);
  await readNativeTargetExceptions(
    path.resolve(
      options.exceptionsPath ?? path.join(rootDirectory, "scripts", "certification", "native-target-exceptions.json"),
    ),
  );

  // Complete every read-only preflight before the first registry write.
  const manifest = await readReleaseCandidateManifest(manifestPath, { verifyFiles: true, expectedTargets });
  assertReleaseCandidateIdentity(manifest, {
    sourceRevision: options.expectedSourceRevision,
    rootVersion: options.expectedRootVersion,
    nativeVersion: options.expectedNativeVersion,
  });
  const publicationOrder = releaseCandidatePublicationOrder(manifest).map((entry) => ({
    ...entry,
    absolutePath: path.resolve(path.dirname(manifestPath), entry.file),
  }));

  for (const entry of publicationOrder) {
    const result = runPackageCommand(
      "npm",
      ["publish", entry.absolutePath, "--ignore-scripts", "--access=public", `--registry=${options.registry}`],
      { cwd: rootDirectory, timeoutMs: 300_000 },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.exitCode !== 0 || result.error) {
      throw new PackageCertificationError(
        "publish-failed",
        `Publishing certified tarball failed for ${entry.package}.`,
        {
          package: entry.package,
          file: entry.file,
          exitCode: result.exitCode,
          error: result.error,
        },
      );
    }
  }
  process.stdout.write(`${JSON.stringify({ status: "pass", published: publicationOrder.length })}\n`);
} catch (error) {
  const code = error instanceof PackageCertificationError ? error.code : "publish-failed";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ status: "fail", code, message })}\n`);
  process.exitCode = 1;
}
