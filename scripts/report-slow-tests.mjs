#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_REVIEW_MS = 2000;
const DEFAULT_INTEGRATION_MS = 10000;

function usage() {
  return [
    "Usage: node ./scripts/report-slow-tests.mjs <vitest-json-report> [--review-ms <n>] [--integration-ms <n>] [--fail-on-review]",
    "",
    "Flags tests over review-ms as review-required.",
    "Flags tests over integration-ms as integration-tier candidates.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const reportPath = args.shift();
  const options = {
    reportPath,
    reviewMs: DEFAULT_REVIEW_MS,
    integrationMs: DEFAULT_INTEGRATION_MS,
    failOnReview: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--fail-on-review") {
      options.failOnReview = true;
      continue;
    }
    if (arg === "--review-ms" || arg === "--integration-ms") {
      const rawValue = args[index + 1];
      const value = Number(rawValue);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid ${arg} value "${String(rawValue)}". Expected a non-negative integer.`);
      }
      if (arg === "--review-ms") {
        options.reviewMs = value;
      } else {
        options.integrationMs = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.reportPath) {
    throw new Error("Missing Vitest JSON report path.");
  }
  return options;
}

function formatMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function readReport(reportPath) {
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
}

function collectSlowTests(report, reviewMs, integrationMs) {
  const files = [];
  const tests = [];
  for (const fileResult of report.testResults ?? []) {
    const filePath = path.relative(process.cwd(), fileResult.name ?? "").replace(/\\/g, "/");
    const fileDuration = Math.max(0, Number(fileResult.endTime ?? 0) - Number(fileResult.startTime ?? 0));
    files.push({
      file: filePath || String(fileResult.name ?? "<unknown>"),
      duration: fileDuration,
      status: fileResult.status ?? "unknown",
    });
    for (const assertion of fileResult.assertionResults ?? []) {
      const duration = Number(assertion.duration ?? 0);
      if (duration < reviewMs) continue;
      tests.push({
        file: filePath || String(fileResult.name ?? "<unknown>"),
        name: assertion.fullName ?? assertion.title ?? "<unknown>",
        duration,
        status: assertion.status ?? "unknown",
        tier: duration >= integrationMs ? "integration-candidate" : "review-required",
      });
    }
  }
  files.sort((left, right) => right.duration - left.duration);
  tests.sort((left, right) => right.duration - left.duration);
  return { files, tests };
}

function markdownTable(rows, columns) {
  if (!rows.length) return "_None._";
  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => column.value(row)).join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function buildSummary(report, slow, options) {
  const slowRows = slow.tests.map((test) => ({
    ...test,
    name: test.name.replace(/\|/g, "\\|"),
  }));
  const fileRows = slow.files.slice(0, 20).map((file) => ({
    ...file,
    file: file.file.replace(/\|/g, "\\|"),
  }));

  return [
    "# Slow Test Report",
    "",
    `Total tests: ${report.numTotalTests ?? "unknown"}`,
    `Review threshold: ${formatMs(options.reviewMs)}`,
    `Integration threshold: ${formatMs(options.integrationMs)}`,
    "",
    "## Slow Tests",
    "",
    markdownTable(slowRows, [
      { label: "Duration", value: (row) => formatMs(row.duration) },
      { label: "Tier", value: (row) => row.tier },
      { label: "File", value: (row) => row.file },
      { label: "Test", value: (row) => row.name },
    ]),
    "",
    "## Slowest Files",
    "",
    markdownTable(fileRows, [
      { label: "Duration", value: (row) => formatMs(row.duration) },
      { label: "Status", value: (row) => row.status },
      { label: "File", value: (row) => row.file },
    ]),
  ].join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = readReport(options.reportPath);
  const slow = collectSlowTests(report, options.reviewMs, options.integrationMs);
  const summary = buildSummary(report, slow, options);
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }

  if (options.failOnReview && slow.tests.length) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 1;
}
