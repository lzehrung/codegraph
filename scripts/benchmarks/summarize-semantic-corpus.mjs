#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CORPUS_FILE,
  compareSemanticBaseline,
  loadSemanticCorpus,
  repositoryRoot,
  serializeSemanticResults,
  validateSemanticResults,
} from "./semantic-corpus-lib.mjs";

export const DEFAULT_RESULTS_FILE = "docs/benchmarks/semantic-results.example.json";

const HELP = `Usage: node scripts/benchmarks/summarize-semantic-corpus.mjs [options]

Options:
  --input <path>       Semantic results (default: ${DEFAULT_RESULTS_FILE})
  --corpus <path>      Corpus manifest (default: ${DEFAULT_CORPUS_FILE})
  --baseline <path>    Optional prior result for informational comparison
  --output <path>      Write canonical validated results to another path
  --write              Rewrite --input in canonical JSON form
  --check              Fail if --input is not canonical JSON
  --json               Print summaries and baseline comparison as JSON
  --help               Show this help
`;

function fail(message) {
  throw new Error(message);
}

function consumeValue(argv, index, option) {
  const argument = argv[index];
  const prefix = `${option}=`;
  if (argument.startsWith(prefix)) {
    const value = argument.slice(prefix.length);
    if (!value) fail(`${option} requires a value.`);
    return { value, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${option} requires a value.`);
  return { value, nextIndex: index + 1 };
}

export function parseSummaryArguments(argv) {
  const parsed = {
    input: DEFAULT_RESULTS_FILE,
    corpusFile: DEFAULT_CORPUS_FILE,
    baseline: null,
    output: null,
    write: false,
    check: false,
    json: false,
    help: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf("=");
    const option = equals >= 0 ? argument.slice(0, equals) : argument;
    if (["--write", "--check", "--json", "--help"].includes(option)) {
      if (argument !== option) fail(`${option} does not accept a value.`);
      if (seen.has(option)) fail(`${option} may be supplied only once.`);
      seen.add(option);
      if (option === "--write") parsed.write = true;
      if (option === "--check") parsed.check = true;
      if (option === "--json") parsed.json = true;
      if (option === "--help") parsed.help = true;
      continue;
    }
    if (["--input", "--corpus", "--baseline", "--output"].includes(option)) {
      if (seen.has(option)) fail(`${option} may be supplied only once.`);
      seen.add(option);
      const consumed = consumeValue(argv, index, option);
      index = consumed.nextIndex;
      if (option === "--input") parsed.input = consumed.value;
      if (option === "--corpus") parsed.corpusFile = consumed.value;
      if (option === "--baseline") parsed.baseline = consumed.value;
      if (option === "--output") parsed.output = consumed.value;
      continue;
    }
    fail(`Unknown option "${argument}".`);
  }
  if (parsed.write && parsed.check) fail("--write and --check are mutually exclusive.");
  if (parsed.output && (parsed.write || parsed.check)) {
    fail("--output cannot be combined with --write or --check.");
  }
  return parsed;
}

function readJson(filePath, label, fsImpl) {
  let source;
  try {
    source = fsImpl.readFileSync(filePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to read ${label} "${filePath}": ${detail}`);
  }
  try {
    return { source, value: JSON.parse(source) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${label} "${filePath}" is not valid JSON: ${detail}`);
  }
}

function formatRatio(value) {
  if (value === null) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function formatMetric(value) {
  if (value === null) return "-";
  return String(value);
}

export function renderSemanticSummary(summaries) {
  const lines = [
    "| Runtime | Scope | Cases | Support | Precision | Recall | F1 | Candidate MRR | p50 ms | p95 ms | Max ms |",
    "| ------- | ----- | ----: | ------: | --------: | -----: | -: | ------------: | -----: | -----: | -----: |",
  ];
  for (const summary of summaries) {
    const scope = summary.groupBy === "total" ? "total" : `${summary.groupBy}:${summary.value}`;
    lines.push(
      `| ${summary.runtimeMode} | ${scope} | ${summary.cases} | ${formatRatio(summary.support)} | ${formatRatio(summary.precision)} | ${formatRatio(summary.recall)} | ${formatRatio(summary.f1)} | ${formatMetric(summary.meanReciprocalRank)} | ${formatMetric(summary.latency.p50Ms)} | ${formatMetric(summary.latency.p95Ms)} | ${formatMetric(summary.latency.maxMs)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeCanonical(filePath, result, fsImpl) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, serializeSemanticResults(result), "utf8");
}

export function summarizeSemanticResult(result, options = {}) {
  const baselineComparison = compareSemanticBaseline(result, options.baseline ?? null);
  if (options.baselineFile) baselineComparison.file = options.baselineFile;
  return { informational: true, baseline: baselineComparison, summaries: result.summaries };
}

export function runCli(argv, io = {}) {
  const rootDir = path.resolve(io.rootDir ?? repositoryRoot);
  const fsImpl = io.fs ?? fs;
  const stdout = io.stdout ?? ((chunk) => process.stdout.write(chunk));
  const parsed = parseSummaryArguments(argv);
  if (parsed.help) {
    stdout(HELP);
    return { result: null, summary: null };
  }

  const corpus = loadSemanticCorpus(parsed.corpusFile, { rootDir, fs: fsImpl });
  const inputPath = path.resolve(rootDir, parsed.input);
  const input = readJson(inputPath, "semantic results", fsImpl);
  const result = validateSemanticResults(input.value, { corpus });
  const canonical = serializeSemanticResults(result);
  if (parsed.check && input.source !== canonical) {
    fail(`Semantic results "${inputPath}" are not in canonical form; run with --write.`);
  }
  if (parsed.write) writeCanonical(inputPath, result, fsImpl);
  if (parsed.output) writeCanonical(path.resolve(rootDir, parsed.output), result, fsImpl);

  let baseline = null;
  if (parsed.baseline) {
    const baselinePath = path.resolve(rootDir, parsed.baseline);
    baseline = validateSemanticResults(readJson(baselinePath, "semantic baseline", fsImpl).value, { corpus });
  }
  const summary = summarizeSemanticResult(result, {
    baseline,
    baselineFile: parsed.baseline,
  });
  if (parsed.json) stdout(`${JSON.stringify(summary, null, 2)}\n`);
  else stdout(renderSemanticSummary(summary.summaries));
  return { result, summary };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
