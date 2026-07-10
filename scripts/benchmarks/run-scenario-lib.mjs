import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { calculateScenarioDigest } from "./benchmark-contract-lib.mjs";

export const DEFAULT_SCENARIO_FILE = "docs/benchmarks/scenarios.json";
export const DEFAULT_RUNS = 3;
export const METRICS = Object.freeze(["toolCalls", "fileReads", "wallTimeMs"]);
export const VARIANTS = Object.freeze(["baseline", "codegraph"]);
export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCHEME_OR_DRIVE_PATH = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length || extra.length) {
    const details = [
      missing.length ? `missing ${missing.join(", ")}` : "",
      extra.length ? `unexpected ${extra.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    fail(`${label} must have exactly these keys: ${expectedKeys.join(", ")} (${details}).`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string.`);
  if (value.includes("\0")) fail(`${label} must not contain a NUL byte.`);
}

function normalizePortableRelativePath(value, label) {
  assertNonEmptyString(value, label);
  if (value.startsWith("~")) fail(`${label} must be relative to the repository, not a home-directory path.`);
  if (value.includes("\\")) fail(`${label} must use forward slashes.`);
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    fail(`${label} must be a relative path.`);
  }
  if (SCHEME_OR_DRIVE_PATH.test(value)) fail(`${label} must be a local path, not a URL or drive-relative path.`);
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail(`${label} must stay within the repository.`);
  }
  return normalized.replace(/^\.\//, "");
}

function assertCanonicalScenarioPath(value, label) {
  const normalized = normalizePortableRelativePath(value, label);
  if (normalized !== value) fail(`${label} must be normalized as "${normalized}".`);
  return normalized;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function resolveConfinedPath(rootDir, relativePath, label) {
  const absolute = path.resolve(rootDir, ...relativePath.split("/"));
  if (!isPathInside(rootDir, absolute)) fail(`${label} escapes the repository.`);
  return absolute;
}

function realpathExisting(entryPath, label, fsImpl = fs) {
  try {
    return fsImpl.realpathSync(entryPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${label} does not exist or cannot be resolved: ${detail}`);
  }
}

function assertNoSymlinkEscape(parentRealpath, entryPath, label, fsImpl = fs) {
  const entryRealpath = realpathExisting(entryPath, label, fsImpl);
  if (!isPathInside(parentRealpath, entryRealpath)) fail(`${label} escapes its allowed root through a symlink.`);
  return entryRealpath;
}

function validateMetrics(metrics, label) {
  if (!Array.isArray(metrics) || metrics.length !== METRICS.length) {
    fail(`${label} must be exactly [${METRICS.join(", ")}].`);
  }
  for (let index = 0; index < METRICS.length; index += 1) {
    if (metrics[index] !== METRICS[index]) fail(`${label} must be exactly [${METRICS.join(", ")}].`);
  }
}

function validateAnchors(anchors, label) {
  if (!Array.isArray(anchors) || anchors.length === 0) fail(`${label} must be a non-empty array.`);
  const seen = new Set();
  for (let index = 0; index < anchors.length; index += 1) {
    const anchorLabel = `${label}[${index}]`;
    assertCanonicalScenarioPath(anchors[index], anchorLabel);
    if (seen.has(anchors[index])) fail(`${label} contains duplicate anchor "${anchors[index]}".`);
    seen.add(anchors[index]);
  }
}

function validateStep(step, variant, label) {
  if (variant === "baseline") {
    assertExactKeys(step, ["type", "path"], label);
    if (step.type !== "read") fail(`${label}.type must be "read".`);
    assertCanonicalScenarioPath(step.path, `${label}.path`);
    return;
  }

  assertExactKeys(step, ["type", "command", "query"], label);
  if (step.type !== "codegraph") fail(`${label}.type must be "codegraph".`);
  if (step.command !== "explore") fail(`${label}.command must be "explore".`);
  assertNonEmptyString(step.query, `${label}.query`);
}

function validateVariants(variants, label) {
  assertExactKeys(variants, VARIANTS, label);
  for (const variant of VARIANTS) {
    const steps = variants[variant];
    if (!Array.isArray(steps) || steps.length === 0) fail(`${label}.${variant} must be a non-empty array.`);
    for (let index = 0; index < steps.length; index += 1) {
      validateStep(steps[index], variant, `${label}.${variant}[${index}]`);
    }
  }
}

function validateRepoFile(repoAbsolute, repoRealpath, relativePath, label, fsImpl) {
  const fileAbsolute = resolveConfinedPath(repoAbsolute, relativePath, label);
  const fileRealpath = assertNoSymlinkEscape(repoRealpath, fileAbsolute, label, fsImpl);
  let fileStat;
  try {
    fileStat = fsImpl.statSync(fileRealpath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${label} cannot be inspected: ${detail}`);
  }
  if (!fileStat.isFile()) fail(`${label} must name an existing file.`);
}

function validateFilesystemEntries(document, rootDir, fsImpl = fs) {
  const rootRealpath = realpathExisting(rootDir, "Repository root", fsImpl);
  for (let scenarioIndex = 0; scenarioIndex < document.scenarios.length; scenarioIndex += 1) {
    const scenario = document.scenarios[scenarioIndex];
    const label = `scenarios[${scenarioIndex}]`;
    const repoAbsolute = resolveConfinedPath(rootDir, scenario.repo, `${label}.repo`);
    const repoRealpath = assertNoSymlinkEscape(rootRealpath, repoAbsolute, `${label}.repo`, fsImpl);
    let repoStat;
    try {
      repoStat = fsImpl.statSync(repoRealpath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`${label}.repo cannot be inspected: ${detail}`);
    }
    if (!repoStat.isDirectory()) fail(`${label}.repo must name an existing directory.`);

    for (let anchorIndex = 0; anchorIndex < scenario.expectedAnchors.length; anchorIndex += 1) {
      validateRepoFile(
        repoAbsolute,
        repoRealpath,
        scenario.expectedAnchors[anchorIndex],
        `${label}.expectedAnchors[${anchorIndex}]`,
        fsImpl,
      );
    }

    for (let stepIndex = 0; stepIndex < scenario.variants.baseline.length; stepIndex += 1) {
      const step = scenario.variants.baseline[stepIndex];
      validateRepoFile(repoAbsolute, repoRealpath, step.path, `${label}.variants.baseline[${stepIndex}].path`, fsImpl);
    }
  }
}

export function validateScenarioDocument(value, options = {}) {
  const { rootDir = repositoryRoot, fs: fsImpl = fs, checkFilesystem = true } = options;
  assertExactKeys(value, ["schemaVersion", "scenarios"], "Scenario document");
  if (value.schemaVersion !== 1) fail("Scenario document schemaVersion must be 1.");
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    fail("Scenario document scenarios must be a non-empty array.");
  }

  const ids = new Set();
  for (let index = 0; index < value.scenarios.length; index += 1) {
    const scenario = value.scenarios[index];
    const label = `scenarios[${index}]`;
    assertExactKeys(scenario, ["id", "repo", "task", "expectedAnchors", "metrics", "variants"], label);
    assertNonEmptyString(scenario.id, `${label}.id`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scenario.id)) {
      fail(`${label}.id may contain only letters, digits, dots, underscores, and hyphens.`);
    }
    if (ids.has(scenario.id)) fail(`Scenario id "${scenario.id}" is duplicated.`);
    ids.add(scenario.id);
    assertCanonicalScenarioPath(scenario.repo, `${label}.repo`);
    assertNonEmptyString(scenario.task, `${label}.task`);
    validateAnchors(scenario.expectedAnchors, `${label}.expectedAnchors`);
    validateMetrics(scenario.metrics, `${label}.metrics`);
    validateVariants(scenario.variants, `${label}.variants`);
  }

  if (checkFilesystem) validateFilesystemEntries(value, path.resolve(rootDir), fsImpl);
  return value;
}

export function loadScenarioFile(scenarioFile = DEFAULT_SCENARIO_FILE, options = {}) {
  const { rootDir = repositoryRoot, fs: fsImpl = fs } = options;
  const normalizedFile = normalizePortableRelativePath(scenarioFile, "Scenario file");
  const absoluteRoot = path.resolve(rootDir);
  const scenarioAbsolute = resolveConfinedPath(absoluteRoot, normalizedFile, "Scenario file");
  const rootRealpath = realpathExisting(absoluteRoot, "Repository root", fsImpl);
  assertNoSymlinkEscape(rootRealpath, scenarioAbsolute, "Scenario file", fsImpl);
  let source;
  try {
    source = fsImpl.readFileSync(scenarioAbsolute, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to read scenario file "${normalizedFile}": ${detail}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Scenario file "${normalizedFile}" is not valid JSON: ${detail}`);
  }
  return validateScenarioDocument(parsed, { rootDir: absoluteRoot, fs: fsImpl, checkFilesystem: true });
}

function readOptionValue(argv, index, option) {
  const argument = argv[index];
  const prefix = `${option}=`;
  if (argument.startsWith(prefix)) {
    const value = argument.slice(prefix.length);
    if (!value) fail(`${option} requires a value.`);
    return { value, nextIndex: index };
  }
  if (argument === option) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${option} requires a value.`);
    return { value, nextIndex: index + 1 };
  }
  return undefined;
}

function parsePositiveInteger(value, option) {
  if (!/^[1-9]\d*$/.test(value)) fail(`${option} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${option} must be a safe positive integer.`);
  return parsed;
}

export function parseArguments(argv) {
  if (!Array.isArray(argv)) fail("Arguments must be an array.");
  const options = {
    scenarioIds: [],
    runs: DEFAULT_RUNS,
    scenarioFile: DEFAULT_SCENARIO_FILE,
    output: undefined,
    requireComplete: false,
    json: false,
  };
  const seenOptions = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string") fail(`Argument at index ${index} must be a string.`);

    const scenario = readOptionValue(argv, index, "--scenario");
    if (scenario) {
      const ids = scenario.value.split(",").map((id) => id.trim());
      if (ids.some((id) => id === "")) fail("--scenario must contain non-empty comma-separated ids.");
      for (const id of ids) {
        if (options.scenarioIds.includes(id)) fail(`--scenario selects "${id}" more than once.`);
        options.scenarioIds.push(id);
      }
      index = scenario.nextIndex;
      continue;
    }

    const runs = readOptionValue(argv, index, "--runs");
    if (runs) {
      if (seenOptions.has("--runs")) fail("--runs may be specified only once.");
      seenOptions.add("--runs");
      options.runs = parsePositiveInteger(runs.value, "--runs");
      index = runs.nextIndex;
      continue;
    }

    const output = readOptionValue(argv, index, "--output");
    if (output) {
      if (seenOptions.has("--output")) fail("--output may be specified only once.");
      seenOptions.add("--output");
      options.output = normalizePortableRelativePath(output.value, "--output");
      index = output.nextIndex;
      continue;
    }

    const scenarioFile = readOptionValue(argv, index, "--scenario-file");
    if (scenarioFile) {
      if (seenOptions.has("--scenario-file")) fail("--scenario-file may be specified only once.");
      seenOptions.add("--scenario-file");
      options.scenarioFile = normalizePortableRelativePath(scenarioFile.value, "--scenario-file");
      index = scenarioFile.nextIndex;
      continue;
    }

    if (argument === "--require-complete") {
      if (seenOptions.has("--require-complete")) fail("--require-complete may be specified only once.");
      seenOptions.add("--require-complete");
      options.requireComplete = true;
      continue;
    }
    if (argument === "--json") {
      if (seenOptions.has("--json")) fail("--json may be specified only once.");
      seenOptions.add("--json");
      options.json = true;
      continue;
    }
    if (argument.startsWith("--require-complete=") || argument.startsWith("--json=")) {
      fail(`${argument.split("=", 1)[0]} does not take a value.`);
    }
    fail(`Unknown argument "${argument}".`);
  }

  return options;
}

export const parseArgs = parseArguments;

function stringifyCapturedOutput(output) {
  if (typeof output === "string") return output;
  if (Buffer.isBuffer(output)) return output.toString("utf8");
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export function calculateCompleteness(expectedAnchors, capturedStepOutputs) {
  if (!Array.isArray(expectedAnchors) || !Array.isArray(capturedStepOutputs)) {
    fail("Completeness requires expected anchor and captured output arrays.");
  }
  const captured = capturedStepOutputs.map(stringifyCapturedOutput).join("\n");
  const found = expectedAnchors.filter((anchor) => captured.includes(anchor));
  const missingAnchors = expectedAnchors.filter((anchor) => !captured.includes(anchor));
  return {
    anchorsExpected: expectedAnchors.length,
    anchorsFound: found.length,
    missingAnchors,
    completeness: expectedAnchors.length === 0 ? 1 : found.length / expectedAnchors.length,
  };
}

function normalizeReturnedFile(value) {
  if (typeof value !== "string" || value === "" || value.includes("\0") || value.includes("\\")) return undefined;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || SCHEME_OR_DRIVE_PATH.test(value))
    return undefined;
  const normalized = path.posix.normalize(value).replace(/^\.\//, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

export function collectSourceFiles(exploreOutputs) {
  const outputs = Array.isArray(exploreOutputs) ? exploreOutputs : [exploreOutputs];
  const files = new Set();
  for (const output of outputs) {
    if (!isPlainObject(output)) continue;
    if (isPlainObject(output.fileView)) {
      const file = normalizeReturnedFile(output.fileView.file);
      if (file) files.add(file);
    }
    if (!Array.isArray(output.packets)) continue;
    for (const packet of output.packets) {
      if (!isPlainObject(packet)) continue;
      const resolvedFile =
        isPlainObject(packet.packet) && isPlainObject(packet.packet.target)
          ? normalizeReturnedFile(packet.packet.target.file)
          : undefined;
      const directFile = normalizeReturnedFile(packet.target);
      const file = resolvedFile ?? directFile;
      if (file) files.add(file);
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

export function countSourceFiles(exploreOutputs) {
  return collectSourceFiles(exploreOutputs).length;
}

export function spawnCaptured(executable, argv, options = {}) {
  const { cwd, spawn = spawnChild } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export async function executeCodegraphExplore(options) {
  const {
    rootDir = repositoryRoot,
    repo,
    query,
    distCliPath = path.join(rootDir, "dist", "cli.js"),
    spawn = spawnChild,
  } = options;
  if (!fs.existsSync(distCliPath)) {
    fail("Built CLI not found at dist/cli.js. Run node scripts/ensure-dist-for-tests.mjs first.");
  }
  const absoluteRoot = path.resolve(rootDir);
  const rootRealpath = realpathExisting(absoluteRoot, "Repository root");
  const repoAbsolute = resolveConfinedPath(absoluteRoot, repo, "Scenario repo");
  const repoRealpath = assertNoSymlinkEscape(rootRealpath, repoAbsolute, "Scenario repo");
  if (!fs.statSync(repoRealpath).isDirectory()) fail("Scenario repo must name an existing directory.");
  const argv = [distCliPath, "explore", query, "--root", repoRealpath, "--cache", "off", "--json"];
  let result;
  try {
    result = await spawnCaptured(process.execPath, argv, { cwd: rootDir, spawn });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to start Codegraph explore: ${detail}`);
  }
  if (result.code !== 0) {
    const status = result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
    const detail = result.stderr.trim() || result.stdout.trim() || "no diagnostic output";
    fail(`Codegraph explore failed (${status}): ${detail}`);
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stderr = result.stderr.trim();
    fail(`Codegraph explore returned invalid JSON: ${detail}${stderr ? `; stderr: ${stderr}` : ""}`);
  }
  if (!isPlainObject(data)) fail("Codegraph explore returned JSON that is not an object.");
  return { data, stdout: result.stdout, stderr: result.stderr };
}

function normalizeExploreExecution(result) {
  if (isPlainObject(result) && Object.hasOwn(result, "data")) {
    return {
      data: result.data,
      stdout: typeof result.stdout === "string" ? result.stdout : JSON.stringify(result.data),
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  }
  return { data: result, stdout: JSON.stringify(result), stderr: "" };
}
export function captureCodegraphEvidence(response) {
  if (!isPlainObject(response)) fail("Codegraph explore returned JSON that is not an object.");
  return JSON.stringify({
    anchors: response.anchors,
    packets: response.packets,
    fileView: response.fileView,
    paths: response.paths,
    blastRadius: response.blastRadius,
    candidateTests: response.candidateTests,
  });
}

async function runVariant(scenario, variant, runNumber, options) {
  const { rootDir, readFile, executeCodegraph, now } = options;
  const capturedOutputs = [];
  const exploreOutputs = [];
  const startedAt = now();
  const steps = scenario.variants[variant];

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const step = steps[stepIndex];
    try {
      if (variant === "baseline") {
        const rootRealpath = realpathExisting(rootDir, "Repository root");
        const repoAbsolute = resolveConfinedPath(rootDir, scenario.repo, "Scenario repo");
        const repoRealpath = assertNoSymlinkEscape(rootRealpath, repoAbsolute, "Scenario repo");
        const fileAbsolute = resolveConfinedPath(repoAbsolute, step.path, "Baseline read path");
        const fileRealpath = assertNoSymlinkEscape(repoRealpath, fileAbsolute, "Baseline read path");
        if (!fs.statSync(fileRealpath).isFile()) fail("Baseline read path must name an existing file.");
        const content = await readFile(fileRealpath, "utf8");
        capturedOutputs.push(JSON.stringify({ path: step.path, content: String(content) }));
      } else {
        const execution = normalizeExploreExecution(
          await executeCodegraph({ rootDir, repo: scenario.repo, query: step.query, command: step.command }),
        );
        if (!isPlainObject(execution.data)) fail("Codegraph explore returned JSON that is not an object.");
        exploreOutputs.push(execution.data);
        capturedOutputs.push(captureCodegraphEvidence(execution.data));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`Scenario "${scenario.id}" ${variant} run ${runNumber}, step ${stepIndex + 1} failed: ${detail}`);
    }
  }

  const elapsed = Math.max(0, now() - startedAt);
  return {
    scenarioId: scenario.id,
    variant,
    run: runNumber,
    metrics: {
      toolCalls: steps.length,
      fileReads: variant === "baseline" ? steps.length : countSourceFiles(exploreOutputs),
      wallTimeMs: Number(elapsed.toFixed(3)),
    },
    checks: calculateCompleteness(scenario.expectedAnchors, capturedOutputs),
  };
}

export async function runScenario(scenario, options = {}) {
  const rootDir = path.resolve(options.rootDir ?? repositoryRoot);
  const runs = options.runs ?? DEFAULT_RUNS;
  if (!Number.isSafeInteger(runs) || runs < 1) fail("runs must be a positive safe integer.");
  const dependencies = {
    rootDir,
    runs,
    readFile: options.readFile ?? fs.promises.readFile,
    executeCodegraph: options.executeCodegraph ?? executeCodegraphExplore,
    now: options.now ?? performance.now.bind(performance),
  };
  const results = [];
  for (const variant of VARIANTS) {
    for (let runNumber = 1; runNumber <= runs; runNumber += 1) {
      results.push(await runVariant(scenario, variant, runNumber, dependencies));
    }
  }
  return results;
}

export const runOneScenario = runScenario;

export async function runScenarios(scenarios, options = {}) {
  if (!Array.isArray(scenarios)) fail("scenarios must be an array.");
  const runs = [];
  for (const scenario of scenarios) runs.push(...(await runScenario(scenario, options)));
  return runs;
}

export function createEnvironmentMetadata(options = {}) {
  const osModule = options.os ?? os;
  const processObject = options.process ?? process;
  const cpus = osModule.cpus();
  const cpuModel = cpus[0]?.model?.replace(/\s+/g, " ").trim() || "unknown";
  return {
    nodeVersion: processObject.version,
    platform: processObject.platform,
    arch: processObject.arch,
    cpuModel,
    logicalCpus: cpus.length,
    totalMemoryBytes: osModule.totalmem(),
  };
}

export function buildCommand(options) {
  const command = [
    "node",
    "scripts/benchmarks/run-scenario.mjs",
    "--scenario-file",
    options.scenarioFile,
    "--runs",
    String(options.runs),
  ];
  for (const id of options.scenarioIds) command.push("--scenario", id);
  if (options.output) command.push("--output", options.output);
  if (options.requireComplete) command.push("--require-complete");
  if (options.json) command.push("--json");
  return command;
}

function selectScenarios(scenarios, ids) {
  if (!ids.length) return scenarios;
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const selectedIds = new Set(ids);
  const missing = [...selectedIds].filter((id) => !byId.has(id));
  if (missing.length) {
    fail(
      `Unknown scenario id${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Available: ${[...byId.keys()].join(", ")}.`,
    );
  }
  return scenarios.filter((scenario) => selectedIds.has(scenario.id));
}

export async function runBenchmark(options = {}, dependencies = {}) {
  const rootDir = path.resolve(dependencies.rootDir ?? repositoryRoot);
  const normalizedOptions = {
    scenarioIds: options.scenarioIds ?? [],
    runs: options.runs ?? DEFAULT_RUNS,
    scenarioFile: normalizePortableRelativePath(options.scenarioFile ?? DEFAULT_SCENARIO_FILE, "Scenario file"),
    output: options.output === undefined ? undefined : normalizePortableRelativePath(options.output, "--output"),
    requireComplete: options.requireComplete ?? false,
    json: options.json ?? false,
  };
  const document = dependencies.scenarioDocument
    ? validateScenarioDocument(dependencies.scenarioDocument, {
        rootDir,
        fs: dependencies.fs ?? fs,
        checkFilesystem: dependencies.checkFilesystem ?? true,
      })
    : loadScenarioFile(normalizedOptions.scenarioFile, { rootDir, fs: dependencies.fs ?? fs });
  const selected = selectScenarios(document.scenarios, normalizedOptions.scenarioIds);
  const scenarioDigest = calculateScenarioDigest(document.schemaVersion, selected);
  const scenarioIds = selected.map((scenario) => scenario.id);
  const benchmarkRuns = await runScenarios(selected, {
    rootDir,
    runs: normalizedOptions.runs,
    readFile: dependencies.readFile,
    executeCodegraph: dependencies.executeCodegraph,
    now: dependencies.now,
  });
  const date = dependencies.date ?? (() => new Date());
  return {
    schemaVersion: 1,
    generatedAt: date().toISOString(),
    command: buildCommand(normalizedOptions),
    environment: dependencies.environment ?? createEnvironmentMetadata(),
    scenarioFile: normalizedOptions.scenarioFile,
    scenarioDigest,
    scenarioIds,
    runsPerVariant: normalizedOptions.runs,
    runs: benchmarkRuns,
  };
}

export function assertComplete(result) {
  const incomplete = result.runs.filter((run) => run.checks.completeness < 1);
  if (!incomplete.length) return;
  const details = incomplete
    .map((run) => `${run.scenarioId}/${run.variant}/run-${run.run}: ${run.checks.missingAnchors.join(", ")}`)
    .join("; ");
  fail(`Benchmark completeness requirement failed: ${details}.`);
}

function nearestExistingAncestor(entryPath, fsImpl = fs) {
  let current = entryPath;
  while (!fsImpl.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) fail(`No existing ancestor for output path "${entryPath}".`);
    current = parent;
  }
  return current;
}

export function writeBenchmarkResult(relativeOutput, result, options = {}) {
  const { rootDir = repositoryRoot, fs: fsImpl = fs } = options;
  const normalizedOutput = normalizePortableRelativePath(relativeOutput, "--output");
  const absoluteRoot = path.resolve(rootDir);
  const outputAbsolute = resolveConfinedPath(absoluteRoot, normalizedOutput, "--output");
  const rootRealpath = realpathExisting(absoluteRoot, "Repository root", fsImpl);
  const ancestor = nearestExistingAncestor(path.dirname(outputAbsolute), fsImpl);
  assertNoSymlinkEscape(rootRealpath, ancestor, "--output parent", fsImpl);
  fsImpl.mkdirSync(path.dirname(outputAbsolute), { recursive: true });
  assertNoSymlinkEscape(rootRealpath, path.dirname(outputAbsolute), "--output parent", fsImpl);
  let outputStat;
  try {
    outputStat = fsImpl.lstatSync(outputAbsolute);
  } catch (error) {
    if (!isPlainObject(error) || error.code !== "ENOENT") {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`--output cannot be inspected: ${detail}`);
    }
  }
  if (outputStat?.isSymbolicLink()) fail("--output must not be a symbolic link.");
  if (outputStat) assertNoSymlinkEscape(rootRealpath, outputAbsolute, "--output", fsImpl);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(
      outputAbsolute,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow,
      0o666,
    );
    fsImpl.writeFileSync(descriptor, serialized, "utf8");
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
  return serialized;
}

export function serializeBenchmarkResult(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}
