#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CORPUS_FILE,
  PACKAGE_MODES,
  RUNTIME_MODES,
  TIERS,
  buildSemanticRunPlan,
  calculateSemanticCorpusDigest,
  loadSemanticCorpus,
  repositoryRoot,
  runSemanticCorpus,
  serializeSemanticResults,
} from "./semantic-corpus-lib.mjs";

const HELP = `Usage: node scripts/benchmarks/run-semantic-corpus.mjs [options]

Options:
  --corpus <path>         Corpus manifest (default: ${DEFAULT_CORPUS_FILE})
  --tier <tier>           release or representative; repeat to select both
  --mode <mode>           native or reduced; repeat to select both
  --case <id>             Run one case id; repeat for more cases
  --package-mode <mode>   checkout or packed (default: checkout)
  --package-root <path>   Package root containing dist/index.js
  --output <path>         Write JSON to this path instead of stdout
  --dry-run               Validate and print the deterministic run plan only
  --help                  Show this help
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

export function parseSemanticArguments(argv) {
  const parsed = {
    corpusFile: DEFAULT_CORPUS_FILE,
    tiers: [],
    modes: [],
    caseIds: [],
    packageMode: "checkout",
    packageRoot: null,
    output: null,
    dryRun: false,
    help: false,
  };
  const singleUse = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let option = argument;
    const equals = argument.indexOf("=");
    if (equals >= 0) option = argument.slice(0, equals);
    if (option === "--help") {
      if (argument !== option) fail("--help does not accept a value.");
      if (singleUse.has(option)) fail("--help may be supplied only once.");
      singleUse.add(option);
      parsed.help = true;
      continue;
    }
    if (option === "--dry-run") {
      if (argument !== option) fail("--dry-run does not accept a value.");
      if (singleUse.has(option)) fail("--dry-run may be supplied only once.");
      singleUse.add(option);
      parsed.dryRun = true;
      continue;
    }
    if (["--corpus", "--package-mode", "--package-root", "--output"].includes(option)) {
      if (singleUse.has(option)) fail(`${option} may be supplied only once.`);
      singleUse.add(option);
      const consumed = consumeValue(argv, index, option);
      index = consumed.nextIndex;
      if (option === "--corpus") parsed.corpusFile = consumed.value;
      if (option === "--package-mode") parsed.packageMode = consumed.value;
      if (option === "--package-root") parsed.packageRoot = consumed.value;
      if (option === "--output") parsed.output = consumed.value;
      continue;
    }
    if (["--tier", "--mode", "--case"].includes(option)) {
      const consumed = consumeValue(argv, index, option);
      index = consumed.nextIndex;
      if (option === "--tier") parsed.tiers.push(consumed.value);
      if (option === "--mode") parsed.modes.push(consumed.value);
      if (option === "--case") parsed.caseIds.push(consumed.value);
      continue;
    }
    fail(`Unknown option "${argument}".`);
  }

  if (!PACKAGE_MODES.includes(parsed.packageMode)) {
    fail(`--package-mode must be one of: ${PACKAGE_MODES.join(", ")}.`);
  }
  for (const tier of parsed.tiers) {
    if (!TIERS.includes(tier)) fail(`--tier must be one of: ${TIERS.join(", ")}.`);
  }
  for (const mode of parsed.modes) {
    if (!RUNTIME_MODES.includes(mode)) fail(`--mode must be one of: ${RUNTIME_MODES.join(", ")}.`);
  }
  if (parsed.packageMode === "packed" && !parsed.packageRoot) {
    fail("--package-root is required when --package-mode is packed.");
  }
  return parsed;
}

export function buildDryRunDocument(corpus, options) {
  const plan = buildSemanticRunPlan(corpus, options);
  return {
    schemaVersion: 1,
    corpusRevision: corpus.corpusRevision,
    corpusDigest: calculateSemanticCorpusDigest(corpus),
    packageMode: options.packageMode,
    tiers: plan.tiers,
    modes: plan.modes,
    cases: plan.entries.map((entry) => ({
      caseId: entry.caseDefinition.id,
      tier: entry.caseDefinition.tier,
      repository: entry.caseDefinition.repository,
      language: entry.caseDefinition.language,
      operation: entry.caseDefinition.operation,
      runtimeMode: entry.runtimeMode,
    })),
  };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeOutput(output, content, rootDir, fsImpl) {
  if (!output) return false;
  const absolute = path.resolve(rootDir, output);
  fsImpl.mkdirSync(path.dirname(absolute), { recursive: true });
  fsImpl.writeFileSync(absolute, content, "utf8");
  return true;
}

export async function runCli(argv, io = {}) {
  const rootDir = path.resolve(io.rootDir ?? repositoryRoot);
  const fsImpl = io.fs ?? fs;
  const stdout = io.stdout ?? ((chunk) => process.stdout.write(chunk));
  const stderr = io.stderr ?? ((chunk) => process.stderr.write(chunk));
  const parsed = parseSemanticArguments(argv);
  if (parsed.help) {
    stdout(HELP);
    return { exitCode: 0, result: null };
  }

  const corpus = loadSemanticCorpus(parsed.corpusFile, { rootDir, fs: fsImpl });
  const selection = {
    tiers: parsed.tiers,
    modes: parsed.modes,
    caseIds: parsed.caseIds,
    packageMode: parsed.packageMode,
  };
  if (parsed.dryRun) {
    const dryRun = buildDryRunDocument(corpus, selection);
    const content = serialize(dryRun);
    if (!writeOutput(parsed.output, content, rootDir, fsImpl)) stdout(content);
    return { exitCode: 0, result: dryRun };
  }

  const result = await runSemanticCorpus(
    {
      rootDir,
      corpusFile: parsed.corpusFile,
      corpusDocument: corpus,
      tiers: parsed.tiers,
      modes: parsed.modes,
      caseIds: parsed.caseIds,
      packageMode: parsed.packageMode,
      packageRoot: parsed.packageRoot ? path.resolve(rootDir, parsed.packageRoot) : rootDir,
    },
    io.dependencies,
  );
  const content = serializeSemanticResults(result);
  if (writeOutput(parsed.output, content, rootDir, fsImpl)) {
    stdout(`Wrote semantic corpus results to ${path.resolve(rootDir, parsed.output)}\n`);
  } else {
    stdout(content);
  }
  const errors = result.cases.filter((entry) => entry.status === "error");
  if (errors.length) {
    stderr(`Semantic corpus completed with ${errors.length} execution error(s).\n`);
    return { exitCode: 1, result };
  }
  return { exitCode: 0, result };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runCli(process.argv.slice(2))
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
