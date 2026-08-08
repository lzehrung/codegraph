#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const LANGUAGES_DIR = "tests/languages";
const DEFAULT_SNAPSHOT_FILE = "docs/benchmarks/fixture-snapshot.example.json";
const DEFAULT_MATRIX_FILE = "docs/benchmarks/fixture-snapshot.md";
const DEFAULT_REPORT_FILE = ".vitest/fixture-matrix-report.json";

// Test-file stem (tests/languages/<stem>.test.ts) -> display language name.
// Names match docs/language-parity.md so the two documents stay comparable.
const LANGUAGE_NAMES = {
  adoc: "AsciiDoc",
  astro: "Astro",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  go: "Go",
  hbs: "Handlebars",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  kotlin: "Kotlin",
  less: "Less",
  markdown: "Markdown",
  mdx: "MDX",
  php: "PHP",
  python: "Python",
  "python-all": "Python",
  rst: "reStructuredText",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  sql: "SQL",
  svelte: "Svelte",
  swift: "Swift",
  tsx: "TSX",
  typescript: "TypeScript",
  vue: "Vue",
  zig: "Zig",
};

// Files under tests/languages that cover more than one language, or are not
// test files at all, and so cannot be attributed to a single matrix row.
const EXCLUDED_STEMS = new Set(["types", "runner", "parity", "chunkSFC"]);

function usage() {
  return [
    "Usage: node scripts/benchmarks/generate-fixture-matrix.mjs [options]",
    "",
    "Generates a per-language test matrix straight from tests/languages/*.test.ts",
    "results. There are no hand-authored goldens: every row is a real test file",
    "and every count is a real pass/fail result from the run that produced it.",
    "",
    "Options:",
    `  --report <path>    Reuse an existing Vitest JSON report instead of running tests`,
    `  --snapshot <path>  Snapshot JSON output path (default: ${DEFAULT_SNAPSHOT_FILE})`,
    `  --matrix <path>    Generated markdown matrix path (default: ${DEFAULT_MATRIX_FILE})`,
    "  --check            Verify the committed snapshot/matrix are current; do not write",
    "  --help, -h         Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    reportPath: undefined,
    snapshotPath: DEFAULT_SNAPSHOT_FILE,
    matrixPath: DEFAULT_MATRIX_FILE,
    check: false,
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--report") {
      options.reportPath = argv[index + 1];
      index += 2;
    } else if (arg === "--snapshot") {
      options.snapshotPath = argv[index + 1];
      index += 2;
    } else if (arg === "--matrix") {
      options.matrixPath = argv[index + 1];
      index += 2;
    } else if (arg === "--check") {
      options.check = true;
      index += 1;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return options;
}

function usesShell(command) {
  return process.platform === "win32" && command !== process.execPath;
}

function runVitest(reportPath) {
  const absoluteReportPath = path.join(rootDir, reportPath);
  fs.mkdirSync(path.dirname(absoluteReportPath), { recursive: true });
  const result = spawnSync("npx", ["vitest", "run", LANGUAGES_DIR, "--reporter=json", `--outputFile=${reportPath}`], {
    cwd: rootDir,
    stdio: "inherit",
    encoding: "utf8",
    shell: usesShell("npx"),
  });
  if (result.error) throw result.error;
  // Vitest exits non-zero when tests fail; the JSON report is still written and is what we score.
  if (!fs.existsSync(absoluteReportPath)) {
    throw new Error(
      `Vitest did not produce a JSON report at ${reportPath} (exit code ${result.status ?? "unknown"}).`,
    );
  }
  return absoluteReportPath;
}

function languageForFile(relativePath) {
  const stem = path.basename(relativePath, ".test.ts");
  if (EXCLUDED_STEMS.has(stem)) return null;
  const displayName = LANGUAGE_NAMES[stem];
  if (!displayName) {
    throw new Error(
      `Unmapped language test file: ${relativePath}. Add "${stem}" to LANGUAGE_NAMES or EXCLUDED_STEMS in generate-fixture-matrix.mjs.`,
    );
  }
  return displayName;
}

function buildSnapshot(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const byLanguage = new Map();

  for (const fileResult of report.testResults ?? []) {
    const relativePath = path.relative(rootDir, fileResult.name ?? "").replace(/\\/g, "/");
    if (!relativePath.startsWith(`${LANGUAGES_DIR}/`)) continue;
    const language = languageForFile(relativePath);
    if (!language) continue;

    const assertions = fileResult.assertionResults ?? [];
    const passed = assertions.filter((assertion) => assertion.status === "passed").length;
    const failed = assertions.filter((assertion) => assertion.status === "failed").length;
    const skipped = assertions.filter(
      (assertion) => assertion.status === "skipped" || assertion.status === "pending",
    ).length;

    const existing = byLanguage.get(language) ?? {
      language,
      files: [],
      tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    };
    existing.files.push(relativePath);
    existing.tests += assertions.length;
    existing.passed += passed;
    existing.failed += failed;
    existing.skipped += skipped;
    byLanguage.set(language, existing);
  }

  const languages = [...byLanguage.values()]
    .map((entry) => ({
      ...entry,
      files: entry.files.sort(),
      status: entry.failed > 0 ? "failing" : entry.tests > 0 ? "passing" : "no-tests",
    }))
    .sort((left, right) => left.language.localeCompare(right.language));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: "tests/languages/*.test.ts via vitest",
    nodeVersion: process.version,
    numTotalTests: report.numTotalTests ?? languages.reduce((sum, entry) => sum + entry.tests, 0),
    numFailedTests: report.numFailedTests ?? languages.reduce((sum, entry) => sum + entry.failed, 0),
    languages,
  };
}

function markdownTable(rows, columns) {
  if (!rows.length) return "_None._";
  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => column.value(row)).join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function buildMatrixMarkdown(snapshot) {
  const rows = snapshot.languages.map((entry) => ({
    ...entry,
    filesText: entry.files.map((file) => `\`${file}\``).join(", "),
  }));

  return [
    "# Fixture test matrix",
    "",
    "This table is generated directly from running `tests/languages/*.test.ts` with Vitest. There is no hand-curated corpus behind it: every row is a real test file, and every count is a real pass/fail result from the run that produced this file.",
    "",
    "Regenerate with `npm run bench:fixtures`. Verify it is current with `npm run bench:fixtures:check`.",
    "",
    `Generated: ${snapshot.generatedAt} (Node ${snapshot.nodeVersion})`,
    "",
    `Total: ${snapshot.numTotalTests} tests, ${snapshot.numFailedTests} failed.`,
    "",
    markdownTable(rows, [
      { label: "Language", value: (row) => row.language },
      { label: "Status", value: (row) => row.status },
      { label: "Tests", value: (row) => row.tests },
      { label: "Passed", value: (row) => row.passed },
      { label: "Failed", value: (row) => row.failed },
      { label: "Skipped", value: (row) => row.skipped },
      { label: "Test file(s)", value: (row) => row.filesText },
    ]),
    "",
    "This is fixture pass/fail, not a claimed-capability matrix. For claimed capability support per language, see [Language coverage parity matrix](../language-parity.md). For the fixture behind each named scenario, see [Scenario catalog](../scenario-catalog.md).",
    "",
  ].join("\n");
}

function normalizeForComparison(snapshot) {
  const { generatedAt: _generatedAt, ...rest } = snapshot;
  return rest;
}

function stripTimestamp(markdown) {
  return markdown.replace(/^Generated: .*$/m, "Generated: <generated>");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const absoluteReportPath = options.reportPath
    ? path.resolve(rootDir, options.reportPath)
    : runVitest(DEFAULT_REPORT_FILE);

  const snapshot = buildSnapshot(absoluteReportPath);
  const matrixMarkdown = buildMatrixMarkdown(snapshot);

  const snapshotAbsolutePath = path.join(rootDir, options.snapshotPath);
  const matrixAbsolutePath = path.join(rootDir, options.matrixPath);

  if (options.check) {
    if (!fs.existsSync(snapshotAbsolutePath) || !fs.existsSync(matrixAbsolutePath)) {
      throw new Error("Fixture matrix snapshot or markdown file is missing. Run `npm run bench:fixtures` first.");
    }
    const committedSnapshot = JSON.parse(fs.readFileSync(snapshotAbsolutePath, "utf8"));
    const committedMatrix = fs.readFileSync(matrixAbsolutePath, "utf8");
    const snapshotMatches =
      JSON.stringify(normalizeForComparison(committedSnapshot)) === JSON.stringify(normalizeForComparison(snapshot));
    const matrixMatches = stripTimestamp(committedMatrix) === stripTimestamp(matrixMarkdown);
    if (!snapshotMatches || !matrixMatches) {
      throw new Error("Fixture matrix is stale. Run `npm run bench:fixtures` and commit the result.");
    }
    console.log("Fixture matrix is up to date.");
    return;
  }

  fs.mkdirSync(path.dirname(snapshotAbsolutePath), { recursive: true });
  fs.writeFileSync(snapshotAbsolutePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(matrixAbsolutePath), { recursive: true });
  fs.writeFileSync(matrixAbsolutePath, matrixMarkdown, "utf8");
  console.log(`Wrote ${options.snapshotPath}`);
  console.log(`Wrote ${options.matrixPath}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
