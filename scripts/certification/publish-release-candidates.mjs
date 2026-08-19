#!/usr/bin/env node
import path from "node:path";
import { PackageCertificationError } from "./package-contract-lib.mjs";
import { preparePublicationOrder, publishReleaseCandidates } from "./publish-release-candidates-lib.mjs";

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
  const { manifest, publicationOrder, rootDirectory, registry } = await preparePublicationOrder({
    manifestPath: path.resolve(options.manifestPath),
    registry: options.registry,
    expectedIdentity: {
      sourceRevision: options.expectedSourceRevision,
      rootVersion: options.expectedRootVersion,
      nativeVersion: options.expectedNativeVersion,
    },
    exceptionsPath: options.exceptionsPath ? path.resolve(options.exceptionsPath) : undefined,
  });

  const { published, skipped } = publishReleaseCandidates({
    manifest,
    publicationOrder,
    registry,
    rootDirectory,
    log: (line) => {
      if (line) process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
    },
  });
  process.stdout.write(
    `${JSON.stringify({ status: "pass", published: published.length, skipped: skipped.length })}\n`,
  );
} catch (error) {
  const code = error instanceof PackageCertificationError ? error.code : "publish-failed";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ status: "fail", code, message })}\n`);
  process.exitCode = 1;
}
