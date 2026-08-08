#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const VITEST_REPORT_PATH = path.join(rootDir, ".vitest", "slow-tests.json");

function usage() {
  return [
    "Usage: node scripts/certification/run-release-tests.mjs --revision <sha> --output <report.json>",
    "",
    "Runs the full automated test suite (`npm run test:all`) against the checked-out",
    "release candidate source and writes a pass/fail certification section. There is",
    "no separate golden corpus: certification is the real test suite passing.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--revision") {
      options.revision = argv[index + 1];
      index += 2;
    } else if (arg === "--output") {
      options.outputPath = argv[index + 1];
      index += 2;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  if (!options.revision) throw new Error("--revision is required.");
  if (!options.outputPath) throw new Error("--output is required.");
  return options;
}

function usesShell(command) {
  return process.platform === "win32" && command !== process.execPath;
}

function readRootPackage() {
  const raw = fs.readFileSync(path.join(rootDir, "package.json"), "utf8");
  const parsed = JSON.parse(raw);
  return { name: parsed.name, version: parsed.version };
}

function readJsTestCounts() {
  if (!fs.existsSync(VITEST_REPORT_PATH)) return null;
  const report = JSON.parse(fs.readFileSync(VITEST_REPORT_PATH, "utf8"));
  return {
    numTotalTests: report.numTotalTests ?? null,
    numPassedTests: report.numPassedTests ?? null,
    numFailedTests: report.numFailedTests ?? null,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.rmSync(VITEST_REPORT_PATH, { force: true });

  const result = spawnSync("npm", ["run", "test:all"], {
    cwd: rootDir,
    stdio: "inherit",
    encoding: "utf8",
    shell: usesShell("npm"),
  });
  if (result.error) throw result.error;

  const status = result.status === 0 ? "pass" : "fail";
  const report = {
    schemaVersion: 1,
    revision: options.revision,
    package: readRootPackage(),
    command: "npm run test:all",
    nodeVersion: process.version,
    jsTests: readJsTestCounts(),
    exitCode: result.status ?? null,
    status,
  };

  const outputPath = path.resolve(rootDir, options.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status, output: options.outputPath }));
  if (status !== "pass") process.exitCode = 1;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: "fail", code: "release-tests-failed", message }));
  process.exitCode = 1;
}
