#!/usr/bin/env node
import path from "node:path";
import { assembleReleaseCandidates } from "./assemble-release-candidates-lib.mjs";
import { PackageCertificationError } from "./package-contract-lib.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument ${argument}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value after ${argument}.`);
    }
    if (argument === "--root") options.rootDirectory = value;
    else if (argument === "--output") options.outputDirectory = value;
    else if (argument === "--source-revision") options.sourceRevision = value;
    else if (argument === "--root-version") options.rootVersion = value;
    else if (argument === "--native-version") options.nativeVersion = value;
    else throw new Error(`Unknown option ${argument}.`);
    index += 1;
  }
  return options;
}

function usage() {
  return [
    "Usage: node ./scripts/certification/assemble-release-candidates.mjs",
    "  --source-revision <git-sha> --root-version <version> --native-version <version>",
    "  [--root <checkout>] [--output <release-candidates-dir>]",
  ].join("\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  options.rootDirectory = path.resolve(options.rootDirectory ?? process.cwd());
  options.sourceRevision = options.sourceRevision ?? process.env.GITHUB_SHA;
  const result = await assembleReleaseCandidates(options);
  process.stdout.write(
    `${JSON.stringify({
      status: "pass",
      manifest: result.manifestPath,
      checksums: result.checksumsPath,
      candidates: result.manifest.files.length,
    })}\n`,
  );
} catch (error) {
  const code = error instanceof PackageCertificationError ? error.code : "assembly-failed";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${usage()}\n${JSON.stringify({ status: "fail", code, message })}\n`);
  process.exitCode = 1;
}
