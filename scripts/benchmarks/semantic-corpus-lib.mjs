import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_CORPUS_FILE = "docs/benchmarks/semantic-corpus.json";
export const OPERATIONS = Object.freeze(["definition", "references", "dependency", "candidate-tests"]);
export const PACKAGE_MODES = Object.freeze(["checkout", "packed"]);
export const RUNTIME_MODES = Object.freeze(["native", "reduced"]);
export const TIERS = Object.freeze(["release", "representative"]);
export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCHEME_OR_DRIVE_PATH = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const LANGUAGE_PATTERN = /^[a-z][a-z0-9+#.-]*$/;
const FORBIDDEN_EXECUTABLE_KEYS = Object.freeze({
  argv: true,
  command: true,
  commands: true,
  env: true,
  environment: true,
  executable: true,
  shell: true,
});
const TIER_ORDER = Object.freeze({ release: 0, representative: 1 });
const MODE_ORDER = Object.freeze({ native: 0, reduced: 1 });
const SUMMARY_GROUP_ORDER = Object.freeze({ total: 0, operation: 1, language: 2, repository: 3 });

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
}

function assertKeys(value, requiredKeys, optionalKeys, label) {
  assertObject(value, label);
  const actual = Object.keys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const missing = requiredKeys.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !allowed.has(key));
  if (missing.length || extra.length) {
    const details = [
      missing.length ? `missing ${missing.join(", ")}` : "",
      extra.length ? `unexpected ${extra.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    fail(`${label} has invalid keys (${details}).`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string.`);
  if (value.includes("\0")) fail(`${label} must not contain a NUL byte.`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be a positive integer.`);
}

function assertNonNegativeNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a finite non-negative number.`);
  }
}

function assertNoEnvironmentExpansion(value, label) {
  if (/\$\{|\$[A-Za-z_]|%[A-Za-z_][A-Za-z\d_]*%|^~/u.test(value)) {
    fail(`${label} must not contain environment or home-directory expansion.`);
  }
}

export function normalizePortableRelativePath(value, label = "Path") {
  assertNonEmptyString(value, label);
  assertNoEnvironmentExpansion(value, label);
  if (value.includes("\\")) fail(`${label} must use forward slashes.`);
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) fail(`${label} must be relative.`);
  if (SCHEME_OR_DRIVE_PATH.test(value)) fail(`${label} must be a repository-relative path.`);
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail(`${label} must stay within its repository.`);
  }
  const canonical = normalized.replace(/^\.\//u, "");
  if (canonical !== value) fail(`${label} must be normalized as "${canonical}".`);
  return canonical;
}

function assertSafePattern(value, label) {
  assertNonEmptyString(value, label);
  assertNoEnvironmentExpansion(value, label);
  if (value.includes("\\")) fail(`${label} must use forward slashes.`);
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || SCHEME_OR_DRIVE_PATH.test(value)) {
    fail(`${label} must be repository-relative.`);
  }
  if (value.split("/").includes("..")) fail(`${label} must not traverse outside the repository.`);
  if (/[`;]|&&|\|\||\$\(/u.test(value)) fail(`${label} must not contain shell syntax.`);
}

function assertNoExecutableFields(value, label) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoExecutableFields(value[index], `${label}[${index}]`);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (Object.hasOwn(FORBIDDEN_EXECUTABLE_KEYS, key.toLowerCase())) {
      fail(`${label}.${key} is executable configuration; semantic corpus manifests are data only.`);
    }
    assertNoExecutableFields(entry, `${label}.${key}`);
  }
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function resolveConfinedPath(parent, relativePath, label) {
  const candidate = path.resolve(parent, ...relativePath.split("/"));
  if (!isPathInside(parent, candidate)) fail(`${label} escapes its repository.`);
  return candidate;
}

function realpathExisting(entryPath, label, fsImpl) {
  try {
    return fsImpl.realpathSync(entryPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${label} does not exist or cannot be resolved: ${detail}`);
  }
}

function assertExistingDirectory(entryPath, allowedRoot, label, fsImpl) {
  const real = realpathExisting(entryPath, label, fsImpl);
  if (!isPathInside(allowedRoot, real)) fail(`${label} escapes its allowed root through a symlink.`);
  if (!fsImpl.statSync(real).isDirectory()) fail(`${label} must name an existing directory.`);
  return real;
}

function assertExistingFile(entryPath, allowedRoot, label, fsImpl) {
  const real = realpathExisting(entryPath, label, fsImpl);
  if (!isPathInside(allowedRoot, real)) fail(`${label} escapes its allowed root through a symlink.`);
  if (!fsImpl.statSync(real).isFile()) fail(`${label} must name an existing file.`);
  return real;
}

function validatePosition(value, label) {
  assertKeys(value, ["line", "column"], [], label);
  assertPositiveInteger(value.line, `${label}.line`);
  assertPositiveInteger(value.column, `${label}.column`);
}

function validateRange(value, label) {
  assertKeys(value, ["start", "end"], [], label);
  validatePosition(value.start, `${label}.start`);
  validatePosition(value.end, `${label}.end`);
  const startsAfterEnd =
    value.start.line > value.end.line || (value.start.line === value.end.line && value.start.column > value.end.column);
  if (startsAfterEnd) fail(`${label}.end must not precede ${label}.start.`);
}

function validateLocation(value, label) {
  assertKeys(value, ["file", "range"], [], label);
  normalizePortableRelativePath(value.file, `${label}.file`);
  validateRange(value.range, `${label}.range`);
}

function validateDependency(value, label) {
  assertKeys(value, ["from", "to", "kind"], [], label);
  normalizePortableRelativePath(value.from, `${label}.from`);
  normalizePortableRelativePath(value.to, `${label}.to`);
  assertNonEmptyString(value.kind, `${label}.kind`);
  if (!ID_PATTERN.test(value.kind)) fail(`${label}.kind must be a lowercase semantic dependency kind.`);
}

function validateCandidateTest(value, label) {
  assertKeys(value, ["file"], [], label);
  normalizePortableRelativePath(value.file, `${label}.file`);
}

export function validateObservation(operation, value, label = "Observation") {
  if (operation === "definition" || operation === "references") {
    validateLocation(value, label);
    return;
  }
  if (operation === "dependency") {
    validateDependency(value, label);
    return;
  }
  if (operation === "candidate-tests") {
    validateCandidateTest(value, label);
    return;
  }
  fail(`${label} has unsupported operation "${operation}".`);
}

function validateNavigationRequest(request, label) {
  assertKeys(request, ["file", "line", "column"], [], label);
  normalizePortableRelativePath(request.file, `${label}.file`);
  assertPositiveInteger(request.line, `${label}.line`);
  assertPositiveInteger(request.column, `${label}.column`);
}

function validateDependencyRequest(request, label) {
  assertKeys(request, ["from"], [], label);
  normalizePortableRelativePath(request.from, `${label}.from`);
}

function validateCandidateRequest(request, label) {
  assertKeys(request, ["changedFiles"], ["changedSymbols", "maxCandidates", "testPatterns"], label);
  if (!Array.isArray(request.changedFiles) || !request.changedFiles.length) {
    fail(`${label}.changedFiles must be a non-empty array.`);
  }
  const changedFiles = new Set();
  for (let index = 0; index < request.changedFiles.length; index += 1) {
    const changedFile = normalizePortableRelativePath(request.changedFiles[index], `${label}.changedFiles[${index}]`);
    if (changedFiles.has(changedFile)) fail(`${label}.changedFiles contains duplicate path "${changedFile}".`);
    changedFiles.add(changedFile);
  }
  if (request.changedSymbols !== undefined) {
    if (!Array.isArray(request.changedSymbols)) fail(`${label}.changedSymbols must be an array.`);
    for (let index = 0; index < request.changedSymbols.length; index += 1) {
      validateNavigationRequest(request.changedSymbols[index], `${label}.changedSymbols[${index}]`);
    }
  }
  if (request.maxCandidates !== undefined) assertPositiveInteger(request.maxCandidates, `${label}.maxCandidates`);
  if (request.testPatterns !== undefined) {
    if (!Array.isArray(request.testPatterns)) fail(`${label}.testPatterns must be an array.`);
    for (let index = 0; index < request.testPatterns.length; index += 1) {
      assertSafePattern(request.testPatterns[index], `${label}.testPatterns[${index}]`);
    }
  }
}

function validateRequest(operation, request, label) {
  assertNoExecutableFields(request, label);
  if (operation === "definition" || operation === "references") {
    validateNavigationRequest(request, label);
    return;
  }
  if (operation === "dependency") {
    validateDependencyRequest(request, label);
    return;
  }
  if (operation === "candidate-tests") {
    validateCandidateRequest(request, label);
    return;
  }
  fail(`${label} has unsupported operation "${operation}".`);
}

export function observationKey(operation, value) {
  validateObservation(operation, value);
  if (operation === "definition" || operation === "references") {
    const { start, end } = value.range;
    return `${value.file}:${start.line}:${start.column}-${end.line}:${end.column}`;
  }
  if (operation === "dependency") return `${value.from}\0${value.to}\0${value.kind}`;
  return value.file;
}

function validateExpected(operation, expected, label) {
  assertKeys(expected, ["required"], ["allowed", "forbidden", "unsupported"], label);
  const categories = ["required", "allowed", "forbidden"];
  const seen = new Map();
  for (const category of categories) {
    const observations = expected[category] ?? [];
    if (!Array.isArray(observations)) fail(`${label}.${category} must be an array.`);
    for (let index = 0; index < observations.length; index += 1) {
      const observation = observations[index];
      validateObservation(operation, observation, `${label}.${category}[${index}]`);
      const key = observationKey(operation, observation);
      const previous = seen.get(key);
      if (previous) fail(`${label}.${category}[${index}] duplicates ${previous}.`);
      seen.set(key, `${label}.${category}[${index}]`);
    }
  }
  if (expected.unsupported !== undefined) {
    assertNonEmptyString(expected.unsupported, `${label}.unsupported`);
    if (categories.some((category) => (expected[category] ?? []).length)) {
      fail(`${label} cannot combine unsupported with required, allowed, or forbidden observations.`);
    }
  }
}

function validateRepository(repository, index) {
  const label = `repositories[${index}]`;
  assertKeys(repository, ["id", "url", "revision", "license"], ["includeRoots", "config"], label);
  assertNonEmptyString(repository.id, `${label}.id`);
  if (!ID_PATTERN.test(repository.id)) fail(`${label}.id must be a confined lowercase identifier.`);
  assertNonEmptyString(repository.url, `${label}.url`);
  assertNonEmptyString(repository.revision, `${label}.revision`);
  assertNonEmptyString(repository.license, `${label}.license`);

  const remote = SCHEME_OR_DRIVE_PATH.test(repository.url);
  if (remote) {
    let parsed;
    try {
      parsed = new URL(repository.url);
    } catch {
      fail(`${label}.url must be a valid HTTPS URL or repository-relative fixture path.`);
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail(`${label}.url must be a credential-free pinned HTTPS repository URL.`);
    }
    if (!/^[a-f\d]{40}$/u.test(repository.revision)) {
      fail(`${label}.revision must be a full 40-character commit for a remote repository.`);
    }
  } else {
    normalizePortableRelativePath(repository.url, `${label}.url`);
    if (repository.revision !== "source-candidate") {
      fail(`${label}.revision must be "source-candidate" for checked-in release fixtures.`);
    }
  }

  if (repository.includeRoots !== undefined) {
    if (!Array.isArray(repository.includeRoots) || !repository.includeRoots.length) {
      fail(`${label}.includeRoots must be a non-empty array when present.`);
    }
    const roots = new Set();
    for (let rootIndex = 0; rootIndex < repository.includeRoots.length; rootIndex += 1) {
      const root = normalizePortableRelativePath(
        repository.includeRoots[rootIndex],
        `${label}.includeRoots[${rootIndex}]`,
      );
      if (roots.has(root)) fail(`${label}.includeRoots contains duplicate path "${root}".`);
      roots.add(root);
    }
  }
  if (repository.config !== undefined) normalizePortableRelativePath(repository.config, `${label}.config`);
  return remote;
}

function validateCase(caseDefinition, index, repositories, remoteRepositories) {
  const label = `cases[${index}]`;
  assertKeys(
    caseDefinition,
    ["id", "tier", "repository", "language", "operation", "request", "expected", "rationale"],
    [],
    label,
  );
  assertNonEmptyString(caseDefinition.id, `${label}.id`);
  if (!ID_PATTERN.test(caseDefinition.id)) fail(`${label}.id must be a confined lowercase identifier.`);
  if (!TIERS.includes(caseDefinition.tier)) fail(`${label}.tier must be one of: ${TIERS.join(", ")}.`);
  assertNonEmptyString(caseDefinition.repository, `${label}.repository`);
  if (!ID_PATTERN.test(caseDefinition.repository)) fail(`${label}.repository must be a confined repository id.`);
  if (!repositories.has(caseDefinition.repository)) {
    fail(`${label}.repository references undeclared repository "${caseDefinition.repository}".`);
  }
  if (caseDefinition.tier === "release" && remoteRepositories.has(caseDefinition.repository)) {
    fail(`${label} release cases must use checked-in repositories.`);
  }
  assertNonEmptyString(caseDefinition.language, `${label}.language`);
  if (!LANGUAGE_PATTERN.test(caseDefinition.language)) fail(`${label}.language must be a lowercase language id.`);
  if (!OPERATIONS.includes(caseDefinition.operation)) {
    fail(`${label}.operation must be one of: ${OPERATIONS.join(", ")}.`);
  }
  validateRequest(caseDefinition.operation, caseDefinition.request, `${label}.request`);
  validateExpected(caseDefinition.operation, caseDefinition.expected, `${label}.expected`);
  assertNonEmptyString(caseDefinition.rationale, `${label}.rationale`);
  if (!/^(?:Source|Limitation) review:/u.test(caseDefinition.rationale)) {
    fail(`${label}.rationale must begin with "Source review:" or "Limitation review:".`);
  }
}

function casePaths(caseDefinition) {
  const paths = [];
  const { operation, request, expected } = caseDefinition;
  if (operation === "definition" || operation === "references") paths.push(request.file);
  if (operation === "dependency") paths.push(request.from);
  if (operation === "candidate-tests") {
    paths.push(...request.changedFiles);
    for (const symbol of request.changedSymbols ?? []) paths.push(symbol.file);
  }
  for (const category of ["required", "allowed", "forbidden"]) {
    for (const observation of expected[category] ?? []) {
      if (operation === "definition" || operation === "references" || operation === "candidate-tests") {
        paths.push(observation.file);
      } else {
        paths.push(observation.from, observation.to);
      }
    }
  }
  return Array.from(new Set(paths));
}

function validateCorpusFilesystem(document, rootDir, fsImpl, remoteRepositories) {
  const rootReal = realpathExisting(rootDir, "Repository root", fsImpl);
  const repositoryRoots = new Map();
  for (let index = 0; index < document.repositories.length; index += 1) {
    const repository = document.repositories[index];
    if (remoteRepositories.has(repository.id)) continue;
    const absolute = resolveConfinedPath(rootDir, repository.url, `repositories[${index}].url`);
    const real = assertExistingDirectory(absolute, rootReal, `repositories[${index}].url`, fsImpl);
    repositoryRoots.set(repository.id, real);
    for (let rootIndex = 0; rootIndex < (repository.includeRoots ?? []).length; rootIndex += 1) {
      const includeRoot = repository.includeRoots[rootIndex];
      assertExistingDirectory(
        resolveConfinedPath(real, includeRoot, `repositories[${index}].includeRoots[${rootIndex}]`),
        real,
        `repositories[${index}].includeRoots[${rootIndex}]`,
        fsImpl,
      );
    }
    if (repository.config !== undefined) {
      assertExistingFile(
        resolveConfinedPath(real, repository.config, `repositories[${index}].config`),
        real,
        `repositories[${index}].config`,
        fsImpl,
      );
    }
  }

  for (let index = 0; index < document.cases.length; index += 1) {
    const caseDefinition = document.cases[index];
    const repoReal = repositoryRoots.get(caseDefinition.repository);
    if (!repoReal) continue;
    for (const relativeFile of casePaths(caseDefinition)) {
      assertExistingFile(
        resolveConfinedPath(repoReal, relativeFile, `cases[${index}] path`),
        repoReal,
        `cases[${index}] path "${relativeFile}"`,
        fsImpl,
      );
    }
  }
}

export function validateSemanticCorpus(value, options = {}) {
  const { rootDir = repositoryRoot, fs: fsImpl = fs, checkFilesystem = true } = options;
  assertKeys(value, ["schemaVersion", "corpusRevision", "repositories", "cases"], [], "Semantic corpus");
  if (value.schemaVersion !== 1) fail("Semantic corpus schemaVersion must be 1.");
  assertNonEmptyString(value.corpusRevision, "Semantic corpus corpusRevision");
  if (!Array.isArray(value.repositories) || !value.repositories.length) {
    fail("Semantic corpus repositories must be a non-empty array.");
  }
  if (!Array.isArray(value.cases)) fail("Semantic corpus cases must be an array.");

  const repositoryIds = new Set();
  const remoteRepositories = new Set();
  for (let index = 0; index < value.repositories.length; index += 1) {
    const remote = validateRepository(value.repositories[index], index);
    const id = value.repositories[index].id;
    if (repositoryIds.has(id)) fail(`Repository id "${id}" is duplicated.`);
    repositoryIds.add(id);
    if (remote) remoteRepositories.add(id);
  }

  const caseIds = new Set();
  for (let index = 0; index < value.cases.length; index += 1) {
    validateCase(value.cases[index], index, repositoryIds, remoteRepositories);
    const id = value.cases[index].id;
    if (caseIds.has(id)) fail(`Semantic case id "${id}" is duplicated.`);
    caseIds.add(id);
  }

  if (checkFilesystem) validateCorpusFilesystem(value, path.resolve(rootDir), fsImpl, remoteRepositories);
  return value;
}

export function loadSemanticCorpus(corpusFile = DEFAULT_CORPUS_FILE, options = {}) {
  const { rootDir = repositoryRoot, fs: fsImpl = fs } = options;
  const relativeFile = normalizePortableRelativePath(corpusFile, "Semantic corpus file");
  const absoluteRoot = path.resolve(rootDir);
  const rootReal = realpathExisting(absoluteRoot, "Repository root", fsImpl);
  const absoluteFile = resolveConfinedPath(absoluteRoot, relativeFile, "Semantic corpus file");
  assertExistingFile(absoluteFile, rootReal, "Semantic corpus file", fsImpl);
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(absoluteFile, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Semantic corpus file "${relativeFile}" is not valid JSON: ${detail}`);
  }
  return validateSemanticCorpus(parsed, { rootDir: absoluteRoot, fs: fsImpl, checkFilesystem: true });
}

function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJsonValue(value[key])]),
    );
  }
  return value;
}

export function calculateSemanticCorpusDigest(document) {
  const canonical = JSON.stringify(canonicalizeJsonValue(document));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function roundMetric(value) {
  if (value === null) return null;
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return roundMetric(numerator / denominator);
}

function f1Score(precision, recall) {
  if (precision === null || recall === null) return null;
  if (!precision && !recall) return 0;
  return roundMetric((2 * precision * recall) / (precision + recall));
}

function uniqueReturned(operation, returned) {
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const observation of returned) {
    validateObservation(operation, observation, "Returned observation");
    const key = observationKey(operation, observation);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(observation);
  }
  return { unique, duplicates };
}

export function reciprocalRank(required, returned, operation = "candidate-tests") {
  if (!required.length) return null;
  const requiredKeys = new Set(required.map((entry) => observationKey(operation, entry)));
  const { unique } = uniqueReturned(operation, returned);
  const rank = unique.findIndex((entry) => requiredKeys.has(observationKey(operation, entry)));
  if (rank < 0) return 0;
  return roundMetric(1 / (rank + 1));
}

export function scoreSemanticCase(caseDefinition, returned, options = {}) {
  const { supported = true } = options;
  if (!Array.isArray(returned)) fail("Returned observations must be an array.");
  const operation = caseDefinition.operation;
  const expected = caseDefinition.expected;
  if (!supported) {
    return {
      truePositives: 0,
      falseNegatives: 0,
      falsePositives: 0,
      allowed: 0,
      unexpected: 0,
      duplicates: 0,
      precision: null,
      recall: null,
      f1: null,
      support: 0,
      unsupported: 1,
      reciprocalRank: null,
    };
  }

  const { unique, duplicates } = uniqueReturned(operation, returned);
  const returnedKeys = new Set(unique.map((entry) => observationKey(operation, entry)));
  const requiredKeys = new Set((expected.required ?? []).map((entry) => observationKey(operation, entry)));
  const allowedKeys = new Set((expected.allowed ?? []).map((entry) => observationKey(operation, entry)));
  const forbiddenKeys = new Set((expected.forbidden ?? []).map((entry) => observationKey(operation, entry)));
  let truePositives = 0;
  let falseNegatives = 0;
  let falsePositives = 0;
  let allowed = 0;
  let unexpected = 0;

  for (const key of requiredKeys) {
    if (returnedKeys.has(key)) truePositives += 1;
    else falseNegatives += 1;
  }
  for (const key of returnedKeys) {
    if (requiredKeys.has(key)) continue;
    if (allowedKeys.has(key)) {
      allowed += 1;
      continue;
    }
    if (forbiddenKeys.has(key)) {
      falsePositives += 1;
      continue;
    }
    unexpected += 1;
  }

  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);
  return {
    truePositives,
    falseNegatives,
    falsePositives,
    allowed,
    unexpected,
    duplicates,
    precision,
    recall,
    f1: f1Score(precision, recall),
    support: 1,
    unsupported: 0,
    reciprocalRank:
      operation === "candidate-tests" ? reciprocalRank(expected.required ?? [], returned, operation) : null,
  };
}

export function latencySummary(values) {
  if (!Array.isArray(values)) fail("Latency samples must be an array.");
  for (let index = 0; index < values.length; index += 1) {
    assertNonNegativeNumber(values[index], `Latency samples[${index}]`);
  }
  if (!values.length) return { samples: 0, p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = [...values].sort((left, right) => left - right);
  const nearestRank = (percentile) => sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
  return {
    samples: sorted.length,
    p50Ms: roundMetric(nearestRank(0.5)),
    p95Ms: roundMetric(nearestRank(0.95)),
    maxMs: roundMetric(sorted[sorted.length - 1]),
  };
}

function aggregateCases(runtimeMode, groupBy, value, cases) {
  const supportedCases = cases.filter((entry) => entry.status === "supported");
  const truePositives = supportedCases.reduce((sum, entry) => sum + entry.score.truePositives, 0);
  const falseNegatives = supportedCases.reduce((sum, entry) => sum + entry.score.falseNegatives, 0);
  const falsePositives = supportedCases.reduce((sum, entry) => sum + entry.score.falsePositives, 0);
  const candidateScores = supportedCases
    .filter((entry) => entry.operation === "candidate-tests" && entry.score.reciprocalRank !== null)
    .map((entry) => entry.score.reciprocalRank);
  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);
  return {
    runtimeMode,
    groupBy,
    value,
    cases: cases.length,
    supported: supportedCases.length,
    unsupported: cases.length - supportedCases.length,
    truePositives,
    falseNegatives,
    falsePositives,
    allowed: supportedCases.reduce((sum, entry) => sum + entry.score.allowed, 0),
    unexpected: supportedCases.reduce((sum, entry) => sum + entry.score.unexpected, 0),
    duplicates: supportedCases.reduce((sum, entry) => sum + entry.score.duplicates, 0),
    precision,
    recall,
    f1: f1Score(precision, recall),
    support: ratio(supportedCases.length, cases.length),
    candidateTestCases: candidateScores.length,
    meanReciprocalRank: candidateScores.length
      ? roundMetric(candidateScores.reduce((sum, score) => sum + score, 0) / candidateScores.length)
      : null,
    latency: latencySummary(supportedCases.map((entry) => entry.durationMs)),
  };
}

function compareSummaries(left, right) {
  const mode = (MODE_ORDER[left.runtimeMode] ?? 99) - (MODE_ORDER[right.runtimeMode] ?? 99);
  if (mode) return mode;
  const group = (SUMMARY_GROUP_ORDER[left.groupBy] ?? 99) - (SUMMARY_GROUP_ORDER[right.groupBy] ?? 99);
  if (group) return group;
  return left.value.localeCompare(right.value);
}

export function summarizeSemanticCases(cases) {
  if (!Array.isArray(cases)) fail("Semantic case results must be an array.");
  const summaries = [];
  for (const runtimeMode of RUNTIME_MODES) {
    const modeCases = cases.filter((entry) => entry.runtimeMode === runtimeMode);
    if (!modeCases.length) continue;
    summaries.push(aggregateCases(runtimeMode, "total", "all", modeCases));
    for (const groupBy of ["operation", "language", "repository"]) {
      const values = Array.from(new Set(modeCases.map((entry) => entry[groupBy]))).sort();
      for (const value of values) {
        summaries.push(
          aggregateCases(
            runtimeMode,
            groupBy,
            value,
            modeCases.filter((entry) => entry[groupBy] === value),
          ),
        );
      }
    }
  }
  return summaries.sort(compareSummaries);
}

function uniqueSelection(values, allowed, label, defaults) {
  const selected = values?.length ? values : defaults;
  const unique = [];
  const seen = new Set();
  for (const value of selected) {
    if (!allowed.includes(value)) fail(`${label} must be one of: ${allowed.join(", ")}.`);
    if (seen.has(value)) fail(`${label} "${value}" was supplied more than once.`);
    seen.add(value);
    unique.push(value);
  }
  return unique.sort((left, right) => allowed.indexOf(left) - allowed.indexOf(right));
}

export function buildSemanticRunPlan(corpus, options = {}) {
  validateSemanticCorpus(corpus, { checkFilesystem: false });
  const tiers = uniqueSelection(options.tiers, TIERS, "Tier", ["release"]);
  const modes = uniqueSelection(options.modes, RUNTIME_MODES, "Runtime mode", RUNTIME_MODES);
  const requestedCaseIds = options.caseIds ?? [];
  const duplicateCaseIds = requestedCaseIds.filter((id, index) => requestedCaseIds.indexOf(id) !== index);
  if (duplicateCaseIds.length) fail(`Semantic case "${duplicateCaseIds[0]}" was supplied more than once.`);
  const knownCases = new Map(corpus.cases.map((entry) => [entry.id, entry]));
  for (const caseId of requestedCaseIds) {
    if (!knownCases.has(caseId)) fail(`Unknown semantic case "${caseId}".`);
  }
  const requested = new Set(requestedCaseIds);
  const selectedCases = corpus.cases
    .filter((entry) => tiers.includes(entry.tier) && (!requested.size || requested.has(entry.id)))
    .sort((left, right) => {
      const tier = (TIER_ORDER[left.tier] ?? 99) - (TIER_ORDER[right.tier] ?? 99);
      return tier || left.id.localeCompare(right.id);
    });
  return {
    tiers,
    modes,
    caseIds: selectedCases.map((entry) => entry.id),
    entries: selectedCases.flatMap((caseDefinition) => modes.map((runtimeMode) => ({ caseDefinition, runtimeMode }))),
  };
}

function normalizeAbsoluteFile(root, relativeFile) {
  return path.join(root, ...relativeFile.split("/")).replace(/\\/gu, "/");
}

function normalizeLocation(root, value) {
  const relative = path.relative(root, value.file).replace(/\\/gu, "/");
  return {
    file: relative,
    range: {
      start: { line: value.range.start.line, column: value.range.start.column },
      end: { line: value.range.end.line, column: value.range.end.column },
    },
  };
}

function normalizeDependencyEdge(root, edge) {
  if (edge.to.type !== "file") return null;
  const from = path.relative(root, edge.from).replace(/\\/gu, "/");
  const to = path.relative(root, edge.to.path).replace(/\\/gu, "/");
  if (from === ".." || from.startsWith("../") || to === ".." || to.startsWith("../")) return null;
  return { from, to, kind: edge.typeOnly ? "type-only" : "dependency" };
}

function compareObservations(operation, left, right) {
  return observationKey(operation, left).localeCompare(observationKey(operation, right));
}

export async function executeSemanticCase(api, index, repositoryPath, caseDefinition) {
  const { operation, request } = caseDefinition;
  if (operation === "definition") {
    const result = await api.goToDefinition(index, {
      file: normalizeAbsoluteFile(repositoryPath, request.file),
      line: request.line,
      column: request.column,
    });
    if (result.status !== "ok") return { supported: false, reason: result.reason ?? result.status, returned: [] };
    return { supported: true, returned: [normalizeLocation(repositoryPath, result.definition)] };
  }
  if (operation === "references") {
    const result = await api.findReferences(index, {
      file: normalizeAbsoluteFile(repositoryPath, request.file),
      line: request.line,
      column: request.column,
    });
    if (result.status !== "ok") return { supported: false, reason: result.reason ?? result.status, returned: [] };
    const returned = result.references.map((entry) => normalizeLocation(repositoryPath, entry));
    returned.sort((left, right) => compareObservations(operation, left, right));
    return { supported: true, returned };
  }
  if (operation === "dependency") {
    const requestedFrom = request.from;
    const returned = index.graph.edges
      .map((edge) => normalizeDependencyEdge(repositoryPath, edge))
      .filter((entry) => entry !== null && entry.from === requestedFrom);
    returned.sort((left, right) => compareObservations(operation, left, right));
    return { supported: true, returned };
  }
  if (operation === "candidate-tests") {
    const changedSymbolIds = [];
    for (const target of request.changedSymbols ?? []) {
      const result = await api.goToDefinition(index, {
        file: normalizeAbsoluteFile(repositoryPath, target.file),
        line: target.line,
        column: target.column,
      });
      if (result.status !== "ok") {
        return { supported: false, reason: result.reason ?? result.status, returned: [] };
      }
      changedSymbolIds.push(api.symbolId(result.definition));
    }
    const candidates = api.listCandidateTestFiles(
      index,
      request.changedFiles.map((file) => normalizeAbsoluteFile(repositoryPath, file)),
      changedSymbolIds,
      {
        projectRoot: repositoryPath,
        ...(request.maxCandidates !== undefined ? { maxCandidates: request.maxCandidates } : {}),
        ...(request.testPatterns !== undefined ? { testPatterns: request.testPatterns } : {}),
      },
    );
    return {
      supported: true,
      returned: candidates.map((candidate) => ({
        file: path.relative(repositoryPath, candidate.file).replace(/\\/gu, "/"),
      })),
    };
  }
  fail(`Unsupported semantic operation "${operation}".`);
}

export function createEnvironmentMetadata(options = {}) {
  const osImpl = options.os ?? os;
  const cpus = osImpl.cpus();
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? "unknown",
    logicalCpus: cpus.length,
    totalMemoryBytes: osImpl.totalmem(),
  };
}

async function loadPackageApi(packageRoot, fsImpl) {
  const packageJsonPath = path.join(packageRoot, "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(fsImpl.readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to read package metadata at "${packageJsonPath}": ${detail}`);
  }
  if (packageJson.name !== "@lzehrung/codegraph") {
    fail(`Package root must contain @lzehrung/codegraph, found "${String(packageJson.name)}".`);
  }
  assertNonEmptyString(packageJson.version, "Codegraph package version");
  const entry = path.join(packageRoot, "dist", "index.js");
  assertExistingFile(entry, realpathExisting(packageRoot, "Package root", fsImpl), "Codegraph library entry", fsImpl);
  return {
    api: await import(pathToFileURL(entry).href),
    packageInfo: { name: packageJson.name, version: packageJson.version },
  };
}

function resultCorpusFileLabel(corpusFile, rootDir) {
  const absolute = path.resolve(rootDir, corpusFile);
  const relative = path.relative(rootDir, absolute).replace(/\\/gu, "/");
  if (relative && relative !== ".." && !relative.startsWith("../")) return relative;
  return path.basename(absolute);
}

export async function runSemanticCorpus(options = {}, dependencies = {}) {
  const rootDir = path.resolve(options.rootDir ?? repositoryRoot);
  const fsImpl = dependencies.fs ?? fs;
  const corpusFile = options.corpusFile ?? DEFAULT_CORPUS_FILE;
  const corpus = options.corpusDocument ?? loadSemanticCorpus(corpusFile, { rootDir, fs: fsImpl });
  validateSemanticCorpus(corpus, { rootDir, fs: fsImpl, checkFilesystem: true });
  const plan = buildSemanticRunPlan(corpus, options);
  const packageMode = options.packageMode ?? "checkout";
  if (!PACKAGE_MODES.includes(packageMode)) fail(`Package mode must be one of: ${PACKAGE_MODES.join(", ")}.`);
  const packageRoot = path.resolve(options.packageRoot ?? rootDir);
  const loaded = dependencies.api
    ? {
        api: dependencies.api,
        packageInfo: options.packageInfo ?? { name: "@lzehrung/codegraph", version: "test" },
      }
    : await loadPackageApi(packageRoot, fsImpl);
  const repositoryById = new Map(corpus.repositories.map((entry) => [entry.id, entry]));
  const indexPromises = new Map();
  const clock = dependencies.clock ?? (() => performance.now());
  const caseResults = [];

  const getIndex = (caseDefinition, runtimeMode) => {
    const key = `${caseDefinition.repository}\0${runtimeMode}`;
    let promise = indexPromises.get(key);
    if (promise) return promise;
    const repository = repositoryById.get(caseDefinition.repository);
    if (SCHEME_OR_DRIVE_PATH.test(repository.url)) {
      promise = Promise.reject(
        new Error(`Representative repository "${repository.id}" must be materialized before running its cases.`),
      );
    } else {
      const repositoryPath = resolveConfinedPath(rootDir, repository.url, `Repository "${repository.id}"`);
      const native = runtimeMode === "native" ? "on" : "off";
      promise = loaded.api
        .listProjectFiles(repositoryPath)
        .then((files) =>
          loaded.api.buildProjectIndexFromFiles(repositoryPath, files, {
            native,
            cache: "off",
            keepParsed: true,
            logLevel: "silent",
          }),
        )
        .then((index) => ({ index, repositoryPath }));
    }
    indexPromises.set(key, promise);
    return promise;
  };

  for (const entry of plan.entries) {
    const started = clock();
    let execution;
    let errorMessage = null;
    try {
      const indexed = await getIndex(entry.caseDefinition, entry.runtimeMode);
      const operationStarted = clock();
      execution = await executeSemanticCase(loaded.api, indexed.index, indexed.repositoryPath, entry.caseDefinition);
      const durationMs = roundMetric(Math.max(0, clock() - operationStarted));
      const status = execution.supported ? "supported" : "unsupported";
      caseResults.push({
        caseId: entry.caseDefinition.id,
        tier: entry.caseDefinition.tier,
        repository: entry.caseDefinition.repository,
        language: entry.caseDefinition.language,
        operation: entry.caseDefinition.operation,
        runtimeMode: entry.runtimeMode,
        status,
        durationMs,
        returned: execution.returned,
        score: scoreSemanticCase(entry.caseDefinition, execution.returned, { supported: execution.supported }),
        expectedUnsupported: entry.caseDefinition.expected.unsupported ?? null,
        unsupportedReason: execution.supported ? null : (execution.reason ?? "Operation is unsupported."),
        error: null,
      });
      continue;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    caseResults.push({
      caseId: entry.caseDefinition.id,
      tier: entry.caseDefinition.tier,
      repository: entry.caseDefinition.repository,
      language: entry.caseDefinition.language,
      operation: entry.caseDefinition.operation,
      runtimeMode: entry.runtimeMode,
      status: "error",
      durationMs: roundMetric(Math.max(0, clock() - started)),
      returned: [],
      score: scoreSemanticCase(entry.caseDefinition, [], { supported: false }),
      expectedUnsupported: entry.caseDefinition.expected.unsupported ?? null,
      unsupportedReason: null,
      error: errorMessage,
    });
  }

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const result = {
    schemaVersion: 1,
    generatedAt,
    informational: true,
    corpus: {
      file: resultCorpusFileLabel(corpusFile, rootDir),
      revision: corpus.corpusRevision,
      digest: calculateSemanticCorpusDigest(corpus),
      tiers: plan.tiers,
      caseIds: plan.caseIds,
    },
    packageMode,
    package: {
      name: loaded.packageInfo.name,
      version: loaded.packageInfo.version,
    },
    environment: dependencies.environment ?? createEnvironmentMetadata(),
    modes: plan.modes,
    cases: caseResults,
    summaries: summarizeSemanticCases(caseResults),
    baseline: { status: "not-configured", file: null, changes: [] },
  };
  validateSemanticResults(result, { corpus });
  return result;
}

function assertNullableRatio(value, label) {
  if (value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be null or a number from 0 through 1.`);
  }
}

function validateScore(score, label) {
  assertKeys(
    score,
    [
      "truePositives",
      "falseNegatives",
      "falsePositives",
      "allowed",
      "unexpected",
      "duplicates",
      "precision",
      "recall",
      "f1",
      "support",
      "unsupported",
      "reciprocalRank",
    ],
    [],
    label,
  );
  for (const key of ["truePositives", "falseNegatives", "falsePositives", "allowed", "unexpected", "duplicates"]) {
    if (!Number.isInteger(score[key]) || score[key] < 0) fail(`${label}.${key} must be a non-negative integer.`);
  }
  for (const key of ["precision", "recall", "f1", "reciprocalRank"]) {
    assertNullableRatio(score[key], `${label}.${key}`);
  }
  for (const key of ["support", "unsupported"]) {
    if (score[key] !== 0 && score[key] !== 1) fail(`${label}.${key} must be 0 or 1.`);
  }
  if (score.support + score.unsupported !== 1) fail(`${label}.support and ${label}.unsupported must sum to 1.`);
}

function compareCaseResults(left, right) {
  const tier = (TIER_ORDER[left.tier] ?? 99) - (TIER_ORDER[right.tier] ?? 99);
  if (tier) return tier;
  const caseId = left.caseId.localeCompare(right.caseId);
  if (caseId) return caseId;
  return (MODE_ORDER[left.runtimeMode] ?? 99) - (MODE_ORDER[right.runtimeMode] ?? 99);
}

function assertCanonicalCaseOrder(cases) {
  const sorted = [...cases].sort(compareCaseResults);
  for (let index = 0; index < cases.length; index += 1) {
    if (cases[index] !== sorted[index])
      fail("Semantic result cases must use deterministic tier, case, and mode order.");
  }
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${label} does not match the canonical computed value.`);
}

function validateEnvironment(value) {
  assertKeys(
    value,
    ["nodeVersion", "platform", "arch", "cpuModel", "logicalCpus", "totalMemoryBytes"],
    [],
    "Semantic results environment",
  );
  for (const key of ["nodeVersion", "platform", "arch", "cpuModel"]) {
    assertNonEmptyString(value[key], `Semantic results environment.${key}`);
  }
  assertPositiveInteger(value.logicalCpus, "Semantic results environment.logicalCpus");
  assertPositiveInteger(value.totalMemoryBytes, "Semantic results environment.totalMemoryBytes");
}

export function validateSemanticResults(value, options = {}) {
  const corpus = validateSemanticCorpus(options.corpus, { checkFilesystem: false });
  assertKeys(
    value,
    [
      "schemaVersion",
      "generatedAt",
      "informational",
      "corpus",
      "package",
      "packageMode",
      "environment",
      "modes",
      "cases",
      "summaries",
      "baseline",
    ],
    [],
    "Semantic results",
  );
  if (value.schemaVersion !== 1) fail("Semantic results schemaVersion must be 1.");
  assertNonEmptyString(value.generatedAt, "Semantic results generatedAt");
  if (Number.isNaN(Date.parse(value.generatedAt)) || new Date(value.generatedAt).toISOString() !== value.generatedAt) {
    fail("Semantic results generatedAt must be an ISO-8601 instant.");
  }
  if (typeof value.informational !== "boolean" || !value.informational) {
    fail("Semantic results must remain informational until a reviewed baseline exists.");
  }
  assertKeys(value.corpus, ["file", "revision", "digest", "tiers", "caseIds"], [], "Semantic results corpus");
  assertNonEmptyString(value.corpus.file, "Semantic results corpus.file");
  if (value.corpus.revision !== corpus.corpusRevision)
    fail("Semantic results corpus revision does not match the manifest.");
  if (value.corpus.digest !== calculateSemanticCorpusDigest(corpus)) {
    fail("Semantic results corpus digest does not match the manifest.");
  }
  const tiers = uniqueSelection(value.corpus.tiers, TIERS, "Semantic results tier", []);
  if (JSON.stringify(tiers) !== JSON.stringify(value.corpus.tiers)) fail("Semantic results tiers must be canonical.");
  if (!Array.isArray(value.corpus.caseIds)) fail("Semantic results corpus.caseIds must be an array.");
  const caseIdSet = new Set();
  for (const caseId of value.corpus.caseIds) {
    assertNonEmptyString(caseId, "Semantic results corpus case id");
    if (caseIdSet.has(caseId)) fail(`Semantic results corpus contains duplicate case id "${caseId}".`);
    caseIdSet.add(caseId);
  }
  const canonicalCaseIds = buildSemanticRunPlan(corpus, {
    tiers,
    modes: ["native"],
    caseIds: value.corpus.caseIds,
  }).caseIds;
  if (JSON.stringify(canonicalCaseIds) !== JSON.stringify(value.corpus.caseIds)) {
    fail("Semantic results corpus.caseIds must use deterministic tier and case order.");
  }

  if (!PACKAGE_MODES.includes(value.packageMode)) {
    fail(`Semantic results packageMode must be one of: ${PACKAGE_MODES.join(", ")}.`);
  }
  assertKeys(value.package, ["name", "version"], [], "Semantic results package");
  if (value.package.name !== "@lzehrung/codegraph") fail("Semantic results package.name must be @lzehrung/codegraph.");
  assertNonEmptyString(value.package.version, "Semantic results package.version");
  validateEnvironment(value.environment);
  const modes = uniqueSelection(value.modes, RUNTIME_MODES, "Semantic results runtime mode", []);
  if (!modes.length) fail("Semantic results modes must be non-empty.");
  if (JSON.stringify(modes) !== JSON.stringify(value.modes)) fail("Semantic results modes must be canonical.");
  if (!Array.isArray(value.cases)) fail("Semantic results cases must be an array.");

  const caseDefinitions = new Map(corpus.cases.map((entry) => [entry.id, entry]));
  const resultKeys = new Set();
  for (let index = 0; index < value.cases.length; index += 1) {
    const result = value.cases[index];
    const label = `Semantic results cases[${index}]`;
    assertKeys(
      result,
      [
        "caseId",
        "tier",
        "repository",
        "language",
        "operation",
        "runtimeMode",
        "status",
        "durationMs",
        "returned",
        "score",
        "expectedUnsupported",
        "unsupportedReason",
        "error",
      ],
      [],
      label,
    );
    const caseDefinition = caseDefinitions.get(result.caseId);
    if (!caseDefinition || !caseIdSet.has(result.caseId)) fail(`${label}.caseId is not selected by this result.`);
    for (const key of ["tier", "repository", "language", "operation"]) {
      if (result[key] !== caseDefinition[key]) fail(`${label}.${key} does not match its corpus case.`);
    }
    if (!modes.includes(result.runtimeMode)) fail(`${label}.runtimeMode is not selected by this result.`);
    if (!["supported", "unsupported", "error"].includes(result.status)) fail(`${label}.status is invalid.`);
    assertNonNegativeNumber(result.durationMs, `${label}.durationMs`);
    if (!Array.isArray(result.returned)) fail(`${label}.returned must be an array.`);
    for (let observationIndex = 0; observationIndex < result.returned.length; observationIndex += 1) {
      validateObservation(
        result.operation,
        result.returned[observationIndex],
        `${label}.returned[${observationIndex}]`,
      );
    }
    validateScore(result.score, `${label}.score`);
    const supported = result.status === "supported";
    assertJsonEqual(result.score, scoreSemanticCase(caseDefinition, result.returned, { supported }), `${label}.score`);
    const expectedUnsupported = caseDefinition.expected.unsupported ?? null;
    if (result.expectedUnsupported !== expectedUnsupported)
      fail(`${label}.expectedUnsupported does not match its corpus case.`);
    if (result.status === "unsupported") {
      assertNonEmptyString(result.unsupportedReason, `${label}.unsupportedReason`);
      if (result.error !== null) fail(`${label}.error must be null for unsupported results.`);
    } else if (result.status === "error") {
      assertNonEmptyString(result.error, `${label}.error`);
      if (result.unsupportedReason !== null) fail(`${label}.unsupportedReason must be null for errors.`);
    } else if (result.unsupportedReason !== null || result.error !== null) {
      fail(`${label} supported results must not carry unsupportedReason or error.`);
    }
    const resultKey = `${result.caseId}\0${result.runtimeMode}`;
    if (resultKeys.has(resultKey))
      fail(`${label} duplicates case/mode result "${result.caseId}/${result.runtimeMode}".`);
    resultKeys.add(resultKey);
  }
  assertCanonicalCaseOrder(value.cases);

  const expectedKeys = [];
  for (const caseId of value.corpus.caseIds) {
    const caseDefinition = caseDefinitions.get(caseId);
    if (!caseDefinition) fail(`Semantic results selected unknown case "${caseId}".`);
    if (!tiers.includes(caseDefinition.tier)) fail(`Semantic results selected case "${caseId}" outside its tiers.`);
    for (const mode of modes) expectedKeys.push(`${caseId}\0${mode}`);
  }
  for (const key of expectedKeys) {
    if (!resultKeys.has(key)) fail(`Semantic results are incomplete for "${key.replace("\0", "/")}".`);
  }
  if (resultKeys.size !== expectedKeys.length) fail("Semantic results contain unselected case/mode rows.");
  if (!Array.isArray(value.summaries)) fail("Semantic results summaries must be an array.");
  assertJsonEqual(value.summaries, summarizeSemanticCases(value.cases), "Semantic results summaries");
  assertKeys(value.baseline, ["status", "file", "changes"], [], "Semantic results baseline");
  if (value.baseline.status !== "not-configured") {
    fail("Checked semantic results must not claim a baseline gate before one is reviewed.");
  }
  if (value.baseline.file !== null || !Array.isArray(value.baseline.changes) || value.baseline.changes.length) {
    fail("An unconfigured semantic baseline must have null file and no changes.");
  }
  return value;
}

export function compareSemanticBaseline(current, baseline) {
  if (!baseline) return { status: "not-configured", file: null, changes: [] };
  const baselineRows = new Map(
    baseline.summaries.map((entry) => [`${entry.runtimeMode}\0${entry.groupBy}\0${entry.value}`, entry]),
  );
  const changes = [];
  for (const currentRow of current.summaries) {
    const key = `${currentRow.runtimeMode}\0${currentRow.groupBy}\0${currentRow.value}`;
    const previous = baselineRows.get(key);
    if (!previous) continue;
    for (const metric of ["support", "precision", "recall", "f1", "meanReciprocalRank"]) {
      if (currentRow[metric] === previous[metric]) continue;
      changes.push({
        runtimeMode: currentRow.runtimeMode,
        groupBy: currentRow.groupBy,
        value: currentRow.value,
        metric,
        baseline: previous[metric],
        current: currentRow[metric],
      });
    }
  }
  return { status: "compared", file: null, changes };
}

export function serializeSemanticResults(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
