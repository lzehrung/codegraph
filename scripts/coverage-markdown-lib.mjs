import fs from "node:fs";
import path from "node:path";

const reportConfigs = {
  js: {
    title: "JavaScript/TypeScript",
    lcovPath: path.join("coverage", "js", "lcov.info"),
    markdownPath: path.join("docs", "coverage", "js.md"),
  },
  native: {
    title: "Rust Native",
    lcovPath: path.join("coverage", "native", "lcov.info"),
    markdownPath: path.join("docs", "coverage", "native.md"),
  },
};

const validModes = new Set(["js", "native", "all"]);

function createMetric() {
  return { found: 0, hit: 0 };
}

function createMetrics() {
  return {
    lines: createMetric(),
    functions: createMetric(),
    branches: createMetric(),
  };
}

function addMetric(target, source) {
  target.found += source.found;
  target.hit += source.hit;
}

function normalizePathForMarkdown(filePath) {
  return filePath.split(path.sep).join("/");
}

function toDisplayPath(filePath, rootDir) {
  if (path.isAbsolute(filePath)) {
    const relativePath = path.relative(rootDir, filePath);
    return normalizePathForMarkdown(relativePath);
  }

  return normalizePathForMarkdown(filePath);
}

function metricFromSummary(found, hit, fallback) {
  if (found !== null && hit !== null) {
    return { found, hit };
  }

  return fallback;
}

function parseNumericValue(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return 0;
}

function parseBranchHit(value) {
  if (value === "-") {
    return 0;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed) {
    return 1;
  }

  return 0;
}

function finalizeRecord(record, rootDir) {
  const metrics = {
    lines: metricFromSummary(record.lineFound, record.lineHit, record.lineDetails),
    functions: metricFromSummary(record.functionFound, record.functionHit, record.functionDetails),
    branches: metricFromSummary(record.branchFound, record.branchHit, record.branchDetails),
  };

  return {
    file: toDisplayPath(record.file, rootDir),
    metrics,
  };
}

function createRecord() {
  return {
    file: "",
    lineFound: null,
    lineHit: null,
    functionFound: null,
    functionHit: null,
    branchFound: null,
    branchHit: null,
    lineDetails: createMetric(),
    functionDetails: createMetric(),
    branchDetails: createMetric(),
  };
}

function parseRecordLine(record, line) {
  if (line.startsWith("SF:")) {
    record.file = line.slice(3);
    return;
  }

  if (line.startsWith("DA:")) {
    const fields = line.slice(3).split(",");
    record.lineDetails.found += 1;
    if (parseNumericValue(fields[1])) {
      record.lineDetails.hit += 1;
    }
    return;
  }

  if (line.startsWith("FNDA:")) {
    const fields = line.slice(5).split(",");
    record.functionDetails.found += 1;
    if (parseNumericValue(fields[0])) {
      record.functionDetails.hit += 1;
    }
    return;
  }

  if (line.startsWith("BRDA:")) {
    const fields = line.slice(5).split(",");
    record.branchDetails.found += 1;
    record.branchDetails.hit += parseBranchHit(fields[3] ?? "0");
    return;
  }

  if (line.startsWith("LF:")) {
    record.lineFound = parseNumericValue(line.slice(3));
    return;
  }

  if (line.startsWith("LH:")) {
    record.lineHit = parseNumericValue(line.slice(3));
    return;
  }

  if (line.startsWith("FNF:")) {
    record.functionFound = parseNumericValue(line.slice(4));
    return;
  }

  if (line.startsWith("FNH:")) {
    record.functionHit = parseNumericValue(line.slice(4));
    return;
  }

  if (line.startsWith("BRF:")) {
    record.branchFound = parseNumericValue(line.slice(4));
    return;
  }

  if (line.startsWith("BRH:")) {
    record.branchHit = parseNumericValue(line.slice(4));
  }
}

export function parseLcov(text, rootDir = process.cwd()) {
  const files = [];
  const totals = createMetrics();
  let record = createRecord();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line === "end_of_record") {
      if (record.file) {
        const file = finalizeRecord(record, rootDir);
        files.push(file);
        addMetric(totals.lines, file.metrics.lines);
        addMetric(totals.functions, file.metrics.functions);
        addMetric(totals.branches, file.metrics.branches);
      }
      record = createRecord();
      continue;
    }

    parseRecordLine(record, line);
  }

  if (record.file) {
    const file = finalizeRecord(record, rootDir);
    files.push(file);
    addMetric(totals.lines, file.metrics.lines);
    addMetric(totals.functions, file.metrics.functions);
    addMetric(totals.branches, file.metrics.branches);
  }

  return { files, totals };
}

function formatPercent(metric) {
  if (!metric.found) {
    return "n/a";
  }

  return `${((metric.hit / metric.found) * 100).toFixed(2)}%`;
}

function metricRankValue(metric) {
  if (!metric.found) {
    return Number.POSITIVE_INFINITY;
  }

  return metric.hit / metric.found;
}

function compareFilesByLineCoverage(left, right) {
  const leftRank = metricRankValue(left.metrics.lines);
  const rightRank = metricRankValue(right.metrics.lines);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  if (left.metrics.lines.found !== right.metrics.lines.found) {
    return right.metrics.lines.found - left.metrics.lines.found;
  }

  return left.file.localeCompare(right.file);
}

function formatMetricRow(label, metric) {
  return `| ${label} | ${metric.hit} | ${metric.found} | ${formatPercent(metric)} |`;
}

function formatFileRow(file) {
  return `| \`${file.file}\` | ${formatPercent(file.metrics.lines)} | ${formatPercent(
    file.metrics.functions,
  )} | ${formatPercent(file.metrics.branches)} |`;
}

function hasRuntimeCoverageRecords(file) {
  return file.metrics.functions.found || file.metrics.branches.found;
}

function appendFileCoverageTable(lines, files) {
  lines.push("| File | Lines | Functions | Branches |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const file of files) {
    lines.push(formatFileRow(file));
  }
}

function markdownForReport(config, parsed, rootDir) {
  const lcovDisplayPath = normalizePathForMarkdown(config.lcovPath);
  const sortedFiles = parsed.files.filter((file) => file.metrics.lines.found).sort(compareFilesByLineCoverage);
  const runtimeFiles = sortedFiles.filter(hasRuntimeCoverageRecords);
  const nonRuntimeFiles = sortedFiles.filter((file) => !hasRuntimeCoverageRecords(file));
  const limitedRuntimeFiles = runtimeFiles.slice(0, 20);
  const limitedNonRuntimeFiles = nonRuntimeFiles.slice(0, 10);
  const lines = [
    `# ${config.title} Coverage`,
    "",
    `Source: \`${lcovDisplayPath}\``,
    "",
    "## Summary",
    "",
    "| Metric | Hit | Found | Coverage |",
    "| --- | ---: | ---: | ---: |",
    formatMetricRow("Lines", parsed.totals.lines),
    formatMetricRow("Functions", parsed.totals.functions),
    formatMetricRow("Branches", parsed.totals.branches),
    "",
    "## Least-covered Files",
    "",
  ];

  if (limitedRuntimeFiles.length) {
    appendFileCoverageTable(lines, limitedRuntimeFiles);
  } else {
    lines.push("No file coverage records found.");
  }

  if (limitedNonRuntimeFiles.length) {
    lines.push("");
    lines.push("## Type-Only Or Re-Export Files");
    lines.push("");
    lines.push(
      "These files have line records but no function or branch records, so they are tracked outside the runtime ranking.",
    );
    lines.push("");
    appendFileCoverageTable(lines, limitedNonRuntimeFiles);
  }

  lines.push("");
  lines.push("Generated from LCOV by `node ./scripts/coverage-markdown.mjs`.");
  lines.push("");

  return lines.join("\n");
}

function reportsForMode(mode) {
  if (mode === "all") {
    return [reportConfigs.js, reportConfigs.native];
  }

  return [reportConfigs[mode]];
}

function writeCoverageIndex(rootDir) {
  const docsDir = path.join(rootDir, "docs", "coverage");
  const availableReports = [];
  for (const config of Object.values(reportConfigs)) {
    const markdownPath = path.join(rootDir, config.markdownPath);
    if (fs.existsSync(markdownPath)) {
      availableReports.push({ ...config, markdownPath });
    }
  }

  const lines = [
    "# Coverage Reports",
    "",
    "These reports are compact Markdown summaries generated from local LCOV output.",
    "",
    "## Reports",
    "",
  ];

  if (availableReports.length) {
    for (const report of availableReports) {
      const relativeMarkdownPath = normalizePathForMarkdown(path.relative(docsDir, report.markdownPath));
      lines.push(`- [${report.title}](./${relativeMarkdownPath})`);
    }
  } else {
    lines.push("- No coverage summaries have been generated yet.");
  }

  lines.push("");
  lines.push("## Commands");
  lines.push("");
  lines.push("- `npm run test:coverage`: run JavaScript/TypeScript coverage and update `docs/coverage/js.md`.");
  lines.push("- `npm run test:coverage:native`: run Rust native coverage and update `docs/coverage/native.md`.");
  lines.push("- `npm run test:coverage:all`: run both coverage reports and update this directory.");
  lines.push("- `npm run coverage:markdown`: refresh Markdown summaries from existing LCOV files.");
  lines.push("");
  lines.push("Rust native coverage requires `cargo llvm-cov`; install it with `npm run coverage:setup:native`.");
  lines.push("");

  const indexPath = path.join(docsDir, "README.md");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(indexPath, lines.join("\n"), "utf8");
  return indexPath;
}

export function writeCoverageMarkdownReports(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const mode = options.mode ?? "all";
  if (!validModes.has(mode)) {
    throw new Error("Coverage Markdown mode must be one of: js, native, all");
  }

  const writtenPaths = [];
  for (const config of reportsForMode(mode)) {
    const lcovPath = path.join(rootDir, config.lcovPath);
    if (!fs.existsSync(lcovPath)) {
      continue;
    }

    const text = fs.readFileSync(lcovPath, "utf8");
    const parsed = parseLcov(text, rootDir);
    const markdown = markdownForReport(config, parsed, rootDir);
    const markdownPath = path.join(rootDir, config.markdownPath);
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, markdown, "utf8");
    writtenPaths.push(markdownPath);
  }

  writtenPaths.push(writeCoverageIndex(rootDir));
  return writtenPaths;
}
