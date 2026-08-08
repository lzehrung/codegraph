#!/usr/bin/env node
import path from "node:path";
import { assembleCertificationReport } from "./certification-report-lib.mjs";
import { writeJsonFile } from "./package-contract-lib.mjs";
import { getSupportedNativeTargetSuffixes, readJsonFile } from "../native-targets-lib.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value after ${argument}.`);
    if (argument === "--manifest") options.manifestPath = value;
    else if (argument === "--package-reports") options.packageReportDirectory = value;
    else if (argument === "--security") options.securityPath = value;
    else if (argument === "--tests") options.testsPath = value;
    else if (argument === "--hermeticity") options.hermeticityPath = value;
    else if (argument === "--exceptions") options.exceptionsPath = value;
    else if (argument === "--repository") options.repository = value;
    else if (argument === "--revision") options.revision = value;
    else if (argument === "--rust-version") options.rustVersion = value;
    else if (argument === "--output") options.outputPath = value;
    else throw new Error(`Unknown option ${argument}.`);
    index += 1;
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || !value) throw new Error(`${name} is required.`);
  return path.resolve(value);
}

try {
  const options = parseArgs(process.argv.slice(2));
  const nativePackage = readJsonFile(path.join(process.cwd(), "packages", "codegraph-native", "package.json"));
  const outputPath = requireOption(options, "outputPath");
  const report = await assembleCertificationReport({
    manifestPath: requireOption(options, "manifestPath"),
    packageReportDirectory: requireOption(options, "packageReportDirectory"),
    securityPath: requireOption(options, "securityPath"),
    testsPath: requireOption(options, "testsPath"),
    hermeticityPath: requireOption(options, "hermeticityPath"),
    exceptionsPath: requireOption(options, "exceptionsPath"),
    repository: options.repository,
    revision: options.revision,
    rustVersion: options.rustVersion,
    expectedTargets: getSupportedNativeTargetSuffixes(nativePackage),
  });
  if (typeof report.source.repository !== "string" || !report.source.repository) {
    throw new Error("repository is required.");
  }
  if (typeof report.source.revision !== "string" || !report.source.revision) {
    throw new Error("revision is required.");
  }
  await writeJsonFile(outputPath, report);
  process.stdout.write(`${JSON.stringify({ status: report.summary.status, output: outputPath })}\n`);
  if (report.summary.status !== "pass") process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ status: "fail", code: "certification-report-failed", message })}\n`);
  process.exitCode = 1;
}
