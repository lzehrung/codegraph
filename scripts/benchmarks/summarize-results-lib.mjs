import fs from "node:fs";
import path from "node:path";
import { calculateScenarioDigest } from "./benchmark-contract-lib.mjs";

export const README_START_MARKER = "<!-- benchmark-results:start -->";
export const README_END_MARKER = "<!-- benchmark-results:end -->";

const RESULT_KEYS = [
  "schemaVersion",
  "generatedAt",
  "command",
  "environment",
  "scenarioFile",
  "scenarioDigest",
  "scenarioIds",
  "runsPerVariant",
  "runs",
];
const ENVIRONMENT_KEYS = ["nodeVersion", "platform", "arch", "cpuModel", "logicalCpus", "totalMemoryBytes"];
const RUN_KEYS = ["scenarioId", "variant", "run", "metrics", "checks"];
const METRIC_KEYS = ["toolCalls", "fileReads", "wallTimeMs"];
const CHECK_KEYS = ["anchorsExpected", "anchorsFound", "missingAnchors", "completeness"];
const REVIEWED_CHECK_KEYS = [...CHECK_KEYS, "reviewedRelationships"];
const SCENARIO_DOCUMENT_KEYS = ["schemaVersion", "scenarios"];
const SCENARIO_KEYS = ["id", "repo", "task", "expectedAnchors", "metrics", "variants"];
const REVIEWED_SCENARIO_KEYS = [
  ...SCENARIO_KEYS,
  "requiredAnchorOrder",
  "expectedRecommendedFile",
  "requiredCandidateTests",
];
const REQUIRED_VARIANT_KEYS = ["baseline", "codegraph"];
const VARIANT_KEYS = [...REQUIRED_VARIANT_KEYS, "warm-cli", "warm-mcp"];
const VARIANT_ORDER = new Map(VARIANT_KEYS.map((variant, index) => [variant, index]));

function fail(location, message) {
  throw new Error(`${location}: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value, location) {
  if (!isPlainObject(value)) {
    fail(location, "expected an object");
  }
  return value;
}

function requireExactKeys(value, expectedKeys, location) {
  requireObject(value, location);
  const expected = new Set(expectedKeys);
  const actualKeys = Object.keys(value);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(value, key));
  const unknown = actualKeys.filter((key) => !expected.has(key));
  if (missing.length || unknown.length) {
    const details = [];
    if (missing.length) details.push(`missing ${missing.join(", ")}`);
    if (unknown.length) details.push(`unknown ${unknown.join(", ")}`);
    fail(location, details.join("; "));
  }
}

function requireNonEmptyString(value, location) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(location, "expected a non-empty string");
  }
  if (value.includes("\0")) {
    fail(location, "must not contain a NUL byte");
  }
  return value;
}

function requireArray(value, location, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    fail(location, "expected an array");
  }
  if (nonEmpty && value.length === 0) {
    fail(location, "must not be empty");
  }
  return value;
}

function requireNonNegativeNumber(value, location, { integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(location, "expected a finite number");
  }
  if (value < 0) {
    fail(location, "must not be negative");
  }
  if (integer && !Number.isSafeInteger(value)) {
    fail(location, "expected a safe integer count");
  }
  return value;
}

function requirePositiveInteger(value, location) {
  requireNonNegativeNumber(value, location, { integer: true });
  if (value < 1) {
    fail(location, "expected an integer greater than zero");
  }
  return value;
}

function looksLikeNetworkOrAbsolutePath(value) {
  return (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.startsWith("~") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)
  );
}

function requireRepoRelativePath(value, location) {
  requireNonEmptyString(value, location);
  if (value.includes("\\")) {
    fail(location, "must use forward slashes");
  }
  if (looksLikeNetworkOrAbsolutePath(value)) {
    fail(location, "must be a local repo-relative path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(location, "must be normalized and confined to the repository");
  }
  return value;
}

function requireSafeCommandArgument(value, location) {
  requireNonEmptyString(value, location);
  const optionValue = value.startsWith("--") && value.includes("=") ? value.slice(value.indexOf("=") + 1) : value;
  if (looksLikeNetworkOrAbsolutePath(optionValue)) {
    fail(location, "must not contain an absolute path or network URL");
  }
  return value;
}

function requireUniqueStrings(value, location, { paths = false, nonEmpty = false } = {}) {
  requireArray(value, location, { nonEmpty });
  const seen = new Set();
  value.forEach((item, index) => {
    const itemLocation = `${location}[${index}]`;
    if (paths) requireRepoRelativePath(item, itemLocation);
    else requireNonEmptyString(item, itemLocation);
    if (seen.has(item)) {
      fail(itemLocation, `duplicate value ${JSON.stringify(item)}`);
    }
    seen.add(item);
  });
  return value;
}

function hasReviewedRelationships(value) {
  return Object.hasOwn(value, "requiredAnchorOrder");
}

function validateAnchorSelector(selector, location) {
  requireExactKeys(selector, ["file", "label"], location);
  requireRepoRelativePath(selector.file, `${location}.file`);
  requireNonEmptyString(selector.label, `${location}.label`);
}

function validateReviewedScenario(scenario, location) {
  if (!hasReviewedRelationships(scenario)) return;
  requireArray(scenario.requiredAnchorOrder, `${location}.requiredAnchorOrder`, { nonEmpty: true });
  const pairs = new Set();
  scenario.requiredAnchorOrder.forEach((pair, index) => {
    const pairLocation = `${location}.requiredAnchorOrder[${index}]`;
    requireExactKeys(pair, ["before", "after"], pairLocation);
    validateAnchorSelector(pair.before, `${pairLocation}.before`);
    validateAnchorSelector(pair.after, `${pairLocation}.after`);
    const key = `${pair.before.file}\0${pair.before.label}\0${pair.after.file}\0${pair.after.label}`;
    if (pairs.has(key)) fail(pairLocation, "duplicate anchor-order pair");
    pairs.add(key);
  });
  requireRepoRelativePath(scenario.expectedRecommendedFile, `${location}.expectedRecommendedFile`);
  requireUniqueStrings(scenario.requiredCandidateTests, `${location}.requiredCandidateTests`, {
    paths: true,
    nonEmpty: true,
  });
}

function validateBaselineStep(step, location) {
  requireExactKeys(step, ["type", "path"], location);
  if (step.type !== "read") {
    fail(`${location}.type`, 'expected "read"');
  }
  requireRepoRelativePath(step.path, `${location}.path`);
}

function validateCodegraphStep(step, location) {
  requireExactKeys(step, ["type", "command", "query"], location);
  if (step.type !== "codegraph") {
    fail(`${location}.type`, 'expected "codegraph"');
  }
  if (step.command !== "explore") {
    fail(`${location}.command`, 'expected "explore"');
  }
  requireNonEmptyString(step.query, `${location}.query`);
}

export function validateScenarioFile(value) {
  requireExactKeys(value, SCENARIO_DOCUMENT_KEYS, "scenario file");
  if (value.schemaVersion !== 1) {
    fail("scenario file.schemaVersion", "expected 1");
  }
  requireArray(value.scenarios, "scenario file.scenarios", { nonEmpty: true });

  const ids = new Set();
  value.scenarios.forEach((scenario, index) => {
    const location = `scenario file.scenarios[${index}]`;
    requireExactKeys(scenario, hasReviewedRelationships(scenario) ? REVIEWED_SCENARIO_KEYS : SCENARIO_KEYS, location);
    requireNonEmptyString(scenario.id, `${location}.id`);
    if (ids.has(scenario.id)) {
      fail(`${location}.id`, `duplicate scenario id ${JSON.stringify(scenario.id)}`);
    }
    ids.add(scenario.id);
    requireRepoRelativePath(scenario.repo, `${location}.repo`);
    requireNonEmptyString(scenario.task, `${location}.task`);
    requireUniqueStrings(scenario.expectedAnchors, `${location}.expectedAnchors`, {
      paths: true,
      nonEmpty: true,
    });
    requireArray(scenario.metrics, `${location}.metrics`);
    if (
      scenario.metrics.length !== METRIC_KEYS.length ||
      scenario.metrics.some((metric, metricIndex) => metric !== METRIC_KEYS[metricIndex])
    ) {
      fail(`${location}.metrics`, `expected exactly ${METRIC_KEYS.join(", ")} in that order`);
    }

    requireObject(scenario.variants, `${location}.variants`);
    const variantNames = Object.keys(scenario.variants);
    const missingVariants = REQUIRED_VARIANT_KEYS.filter((variant) => !Object.hasOwn(scenario.variants, variant));
    const unknownVariants = variantNames.filter((variant) => !VARIANT_ORDER.has(variant));
    if (missingVariants.length || unknownVariants.length) {
      const details = [];
      if (missingVariants.length) details.push(`missing ${missingVariants.join(", ")}`);
      if (unknownVariants.length) details.push(`unknown ${unknownVariants.join(", ")}`);
      fail(`${location}.variants`, details.join("; "));
    }
    for (const variant of VARIANT_KEYS) {
      if (!Object.hasOwn(scenario.variants, variant)) continue;
      const steps = scenario.variants[variant];
      requireArray(steps, `${location}.variants.${variant}`, { nonEmpty: true });
      steps.forEach((step, stepIndex) => {
        if (variant === "baseline") validateBaselineStep(step, `${location}.variants.${variant}[${stepIndex}]`);
        else validateCodegraphStep(step, `${location}.variants.${variant}[${stepIndex}]`);
      });
    }
    for (const variant of ["warm-cli", "warm-mcp"]) {
      if (!Object.hasOwn(scenario.variants, variant)) continue;
      const warmSteps = scenario.variants[variant];
      const coldSteps = scenario.variants.codegraph;
      const matchesColdSteps =
        warmSteps.length === coldSteps.length &&
        warmSteps.every((step, stepIndex) => {
          const coldStep = coldSteps[stepIndex];
          return coldStep !== undefined && step.command === coldStep.command && step.query === coldStep.query;
        });
      if (!matchesColdSteps) {
        fail(`${location}.variants.${variant}`, `must exactly match ${location}.variants.codegraph`);
      }
    }
    validateReviewedScenario(scenario, location);
  });

  return value;
}

function scenarioLookupFromOptions(options) {
  const scenarioFile = options?.scenarioFile ?? options?.scenarios ?? null;
  if (scenarioFile === null || scenarioFile === undefined) {
    return null;
  }
  validateScenarioFile(scenarioFile);
  return new Map(
    scenarioFile.scenarios.map((scenario, index) => [
      scenario.id,
      {
        expectedAnchorCount: scenario.expectedAnchors.length,
        expectedAnchors: new Set(scenario.expectedAnchors),
        variantStepCounts: Object.fromEntries(
          VARIANT_KEYS.filter((variant) => Object.hasOwn(scenario.variants, variant)).map((variant) => [
            variant,
            scenario.variants[variant].length,
          ]),
        ),
        baselineReadCount: scenario.variants.baseline.filter((step) => step.type === "read").length,
        scenario,
        index,
      },
    ]),
  );
}

function requireNullableRank(value, location) {
  if (value === null) return null;
  return requirePositiveInteger(value, location);
}

function requireReciprocalRank(value, rank, location) {
  if (rank === null) {
    if (value !== null) fail(location, "must be null when rank is null");
    return;
  }
  requireNonNegativeNumber(value, location);
  const expected = 1 / rank;
  if (value !== expected) fail(location, `expected reciprocal rank ${expected}, received ${value}`);
}

function validateReviewedRelationships(value, location) {
  requireExactKeys(value, ["anchorOrder", "recommendedFile", "candidateTests"], location);
  requireArray(value.anchorOrder, `${location}.anchorOrder`, { nonEmpty: true });
  value.anchorOrder.forEach((pair, index) => {
    const pairLocation = `${location}.anchorOrder[${index}]`;
    requireExactKeys(
      pair,
      ["before", "after", "beforeRank", "afterRank", "beforeReciprocalRank", "afterReciprocalRank"],
      pairLocation,
    );
    validateAnchorSelector(pair.before, `${pairLocation}.before`);
    validateAnchorSelector(pair.after, `${pairLocation}.after`);
    const beforeRank = requireNullableRank(pair.beforeRank, `${pairLocation}.beforeRank`);
    const afterRank = requireNullableRank(pair.afterRank, `${pairLocation}.afterRank`);
    requireReciprocalRank(pair.beforeReciprocalRank, beforeRank, `${pairLocation}.beforeReciprocalRank`);
    requireReciprocalRank(pair.afterReciprocalRank, afterRank, `${pairLocation}.afterReciprocalRank`);
  });
  requireExactKeys(
    value.recommendedFile,
    ["expected", "actual", "rank", "reciprocalRank"],
    `${location}.recommendedFile`,
  );
  requireRepoRelativePath(value.recommendedFile.expected, `${location}.recommendedFile.expected`);
  if (value.recommendedFile.actual !== null) {
    requireRepoRelativePath(value.recommendedFile.actual, `${location}.recommendedFile.actual`);
  }
  const recommendedRank = requireNullableRank(value.recommendedFile.rank, `${location}.recommendedFile.rank`);
  requireReciprocalRank(
    value.recommendedFile.reciprocalRank,
    recommendedRank,
    `${location}.recommendedFile.reciprocalRank`,
  );
  requireArray(value.candidateTests, `${location}.candidateTests`, { nonEmpty: true });
  value.candidateTests.forEach((candidate, index) => {
    const candidateLocation = `${location}.candidateTests[${index}]`;
    requireExactKeys(candidate, ["file", "rank", "reciprocalRank"], candidateLocation);
    requireRepoRelativePath(candidate.file, `${candidateLocation}.file`);
    const rank = requireNullableRank(candidate.rank, `${candidateLocation}.rank`);
    requireReciprocalRank(candidate.reciprocalRank, rank, `${candidateLocation}.reciprocalRank`);
  });
}

function validateRun(run, index) {
  const location = `results.runs[${index}]`;
  requireExactKeys(run, RUN_KEYS, location);
  requireNonEmptyString(run.scenarioId, `${location}.scenarioId`);
  if (!VARIANT_ORDER.has(run.variant)) {
    fail(`${location}.variant`, `expected one of ${VARIANT_KEYS.map((variant) => JSON.stringify(variant)).join(", ")}`);
  }
  requirePositiveInteger(run.run, `${location}.run`);

  requireExactKeys(run.metrics, METRIC_KEYS, `${location}.metrics`);
  requireNonNegativeNumber(run.metrics.toolCalls, `${location}.metrics.toolCalls`, { integer: true });
  requireNonNegativeNumber(run.metrics.fileReads, `${location}.metrics.fileReads`, { integer: true });
  requireNonNegativeNumber(run.metrics.wallTimeMs, `${location}.metrics.wallTimeMs`);

  const checkKeys = Object.hasOwn(run.checks, "reviewedRelationships") ? REVIEWED_CHECK_KEYS : CHECK_KEYS;
  requireExactKeys(run.checks, checkKeys, `${location}.checks`);
  requirePositiveInteger(run.checks.anchorsExpected, `${location}.checks.anchorsExpected`);
  requireNonNegativeNumber(run.checks.anchorsFound, `${location}.checks.anchorsFound`, {
    integer: true,
  });
  if (run.checks.anchorsFound > run.checks.anchorsExpected) {
    fail(`${location}.checks.anchorsFound`, "must not exceed anchorsExpected");
  }
  requireUniqueStrings(run.checks.missingAnchors, `${location}.checks.missingAnchors`, {
    paths: true,
  });
  const expectedMissing = run.checks.anchorsExpected - run.checks.anchorsFound;
  if (run.checks.missingAnchors.length !== expectedMissing) {
    fail(
      `${location}.checks`,
      `anchorsFound (${run.checks.anchorsFound}) plus missingAnchors (${run.checks.missingAnchors.length}) must equal anchorsExpected (${run.checks.anchorsExpected})`,
    );
  }
  requireNonNegativeNumber(run.checks.completeness, `${location}.checks.completeness`);
  if (run.checks.completeness > 1) {
    fail(`${location}.checks.completeness`, "must be between 0 and 1");
  }
  const expectedCompleteness = run.checks.anchorsFound / run.checks.anchorsExpected;
  if (run.checks.completeness !== expectedCompleteness) {
    fail(
      `${location}.checks.completeness`,
      `expected ${expectedCompleteness} from anchorsFound / anchorsExpected, received ${run.checks.completeness}`,
    );
  }
  if (Object.hasOwn(run.checks, "reviewedRelationships")) {
    validateReviewedRelationships(run.checks.reviewedRelationships, `${location}.checks.reviewedRelationships`);
  }
}

export function validateResults(value, options = {}) {
  requireExactKeys(value, RESULT_KEYS, "results");
  if (value.schemaVersion !== 1) {
    fail("results.schemaVersion", "expected 1");
  }
  requireNonEmptyString(value.generatedAt, "results.generatedAt");
  const generatedDate = new Date(value.generatedAt);
  if (Number.isNaN(generatedDate.getTime()) || generatedDate.toISOString() !== value.generatedAt) {
    fail("results.generatedAt", "expected an ISO 8601 UTC timestamp");
  }

  requireArray(value.command, "results.command", { nonEmpty: true });
  value.command.forEach((argument, index) => requireSafeCommandArgument(argument, `results.command[${index}]`));
  requireExactKeys(value.environment, ENVIRONMENT_KEYS, "results.environment");
  for (const key of ["nodeVersion", "platform", "arch", "cpuModel"]) {
    requireNonEmptyString(value.environment[key], `results.environment.${key}`);
  }
  requirePositiveInteger(value.environment.logicalCpus, "results.environment.logicalCpus");
  requirePositiveInteger(value.environment.totalMemoryBytes, "results.environment.totalMemoryBytes");
  requireRepoRelativePath(value.scenarioFile, "results.scenarioFile");
  requireNonEmptyString(value.scenarioDigest, "results.scenarioDigest");
  if (!/^sha256:[0-9a-f]{64}$/u.test(value.scenarioDigest)) {
    fail("results.scenarioDigest", 'expected "sha256:" followed by 64 lowercase hexadecimal characters');
  }
  requireUniqueStrings(value.scenarioIds, "results.scenarioIds", { nonEmpty: true });
  requirePositiveInteger(value.runsPerVariant, "results.runsPerVariant");
  requireArray(value.runs, "results.runs", { nonEmpty: true });

  const scenarioLookup = scenarioLookupFromOptions(options);
  if (scenarioLookup) {
    value.scenarioIds.forEach((scenarioId, index) => {
      if (!scenarioLookup.has(scenarioId)) {
        fail(`results.scenarioIds[${index}]`, `unknown scenario id ${JSON.stringify(scenarioId)}`);
      }
    });
    const selectedIds = new Set(value.scenarioIds);
    const selectedScenarios = [...scenarioLookup.values()]
      .sort((left, right) => left.index - right.index)
      .filter(({ scenario }) => selectedIds.has(scenario.id))
      .map(({ scenario }) => scenario);
    const declaredOrder = selectedScenarios.map((scenario) => scenario.id);
    const outOfOrderIndex = value.scenarioIds.findIndex((scenarioId, index) => scenarioId !== declaredOrder[index]);
    if (outOfOrderIndex !== -1) {
      fail(
        `results.scenarioIds[${outOfOrderIndex}]`,
        `must follow scenario-file order; expected ${JSON.stringify(declaredOrder[outOfOrderIndex])}, received ${JSON.stringify(value.scenarioIds[outOfOrderIndex])}`,
      );
    }
    const scenarioFile = options?.scenarioFile ?? options?.scenarios;
    const expectedDigest = calculateScenarioDigest(scenarioFile.schemaVersion, selectedScenarios);
    if (value.scenarioDigest !== expectedDigest) {
      fail(
        "results.scenarioDigest",
        `does not match the selected scenario definitions; expected ${expectedDigest}, received ${value.scenarioDigest}`,
      );
    }
  }

  const selectedIds = new Set(value.scenarioIds);
  const runKeys = new Set();
  const runNumbersByScenarioVariant = new Map();
  const expectedByScenario = new Map();

  value.runs.forEach((run, index) => {
    validateRun(run, index);
    const location = `results.runs[${index}]`;
    if (!selectedIds.has(run.scenarioId)) {
      fail(`${location}.scenarioId`, `is not listed in results.scenarioIds`);
    }
    if (run.run > value.runsPerVariant) {
      fail(
        `${location}.run`,
        `must be between 1 and results.runsPerVariant (${value.runsPerVariant}); received ${run.run}`,
      );
    }
    const runKey = `${run.scenarioId}\0${run.variant}\0${run.run}`;
    if (runKeys.has(runKey)) {
      fail(location, `duplicate scenario+variant+run key ${run.scenarioId}/${run.variant}/${run.run}`);
    }
    runKeys.add(runKey);
    const scenarioVariantKey = `${run.scenarioId}\0${run.variant}`;
    const runNumbers = runNumbersByScenarioVariant.get(scenarioVariantKey) ?? [];
    runNumbers.push(run.run);
    runNumbersByScenarioVariant.set(scenarioVariantKey, runNumbers);

    const priorExpected = expectedByScenario.get(run.scenarioId);
    if (priorExpected !== undefined && priorExpected !== run.checks.anchorsExpected) {
      fail(
        `${location}.checks.anchorsExpected`,
        `inconsistent total for scenario ${JSON.stringify(run.scenarioId)}; expected ${priorExpected}, received ${run.checks.anchorsExpected}`,
      );
    }
    expectedByScenario.set(run.scenarioId, run.checks.anchorsExpected);

    if (scenarioLookup) {
      const scenario = scenarioLookup.get(run.scenarioId);
      if (scenario.expectedAnchorCount !== run.checks.anchorsExpected) {
        fail(
          `${location}.checks.anchorsExpected`,
          `expected ${scenario.expectedAnchorCount} from the scenario file, received ${run.checks.anchorsExpected}`,
        );
      }
      const expectedToolCalls = scenario.variantStepCounts[run.variant];
      if (expectedToolCalls === undefined) {
        fail(`${location}.variant`, `is not declared for scenario ${JSON.stringify(run.scenarioId)}`);
      }
      if (run.metrics.toolCalls !== expectedToolCalls) {
        fail(
          `${location}.metrics.toolCalls`,
          `expected ${expectedToolCalls} from scenario ${JSON.stringify(run.scenarioId)} variant ${JSON.stringify(run.variant)}, received ${run.metrics.toolCalls}`,
        );
      }
      if (run.variant === "baseline" && run.metrics.fileReads !== scenario.baselineReadCount) {
        fail(
          `${location}.metrics.fileReads`,
          `expected ${scenario.baselineReadCount} from the declared baseline read steps, received ${run.metrics.fileReads}`,
        );
      }
      run.checks.missingAnchors.forEach((anchor, anchorIndex) => {
        if (!scenario.expectedAnchors.has(anchor)) {
          fail(
            `${location}.checks.missingAnchors[${anchorIndex}]`,
            `anchor ${JSON.stringify(anchor)} is not an expected anchor for scenario ${JSON.stringify(run.scenarioId)}`,
          );
        }
      });
      const expectsReviewed = run.variant !== "baseline" && hasReviewedRelationships(scenario.scenario);
      const hasReviewed = Object.hasOwn(run.checks, "reviewedRelationships");
      if (expectsReviewed !== hasReviewed) {
        fail(
          `${location}.checks`,
          expectsReviewed
            ? "missing reviewedRelationships for the declared codegraph relationship contract"
            : "reviewedRelationships is not declared for this scenario variant",
        );
      }
      if (expectsReviewed) {
        const reviewed = run.checks.reviewedRelationships;
        const declared = scenario.scenario;
        if (reviewed.anchorOrder.length !== declared.requiredAnchorOrder.length) {
          fail(`${location}.checks.reviewedRelationships.anchorOrder`, "does not match the declared pair count");
        }
        reviewed.anchorOrder.forEach((pair, pairIndex) => {
          const expectedPair = declared.requiredAnchorOrder[pairIndex];
          if (
            pair.before.file !== expectedPair.before.file ||
            pair.before.label !== expectedPair.before.label ||
            pair.after.file !== expectedPair.after.file ||
            pair.after.label !== expectedPair.after.label
          ) {
            fail(
              `${location}.checks.reviewedRelationships.anchorOrder[${pairIndex}]`,
              "does not match the declared anchor-order pair",
            );
          }
        });
        if (reviewed.recommendedFile.expected !== declared.expectedRecommendedFile) {
          fail(
            `${location}.checks.reviewedRelationships.recommendedFile.expected`,
            "does not match the declared expectedRecommendedFile",
          );
        }
        const actualTests = reviewed.candidateTests.map((candidate) => candidate.file);
        if (
          actualTests.length !== declared.requiredCandidateTests.length ||
          actualTests.some((file, testIndex) => file !== declared.requiredCandidateTests[testIndex])
        ) {
          fail(
            `${location}.checks.reviewedRelationships.candidateTests`,
            "does not match the declared requiredCandidateTests",
          );
        }
      }
    }
  });

  for (const scenarioId of value.scenarioIds) {
    const expectedVariants = scenarioLookup
      ? Object.keys(scenarioLookup.get(scenarioId).variantStepCounts)
      : VARIANT_KEYS.filter(
          (variant) =>
            REQUIRED_VARIANT_KEYS.includes(variant) || runNumbersByScenarioVariant.has(`${scenarioId}\0${variant}`),
        );
    for (const variant of expectedVariants) {
      const scenarioVariantKey = `${scenarioId}\0${variant}`;
      const runNumbers = (runNumbersByScenarioVariant.get(scenarioVariantKey) ?? []).sort(
        (left, right) => left - right,
      );
      if (runNumbers.length === value.runsPerVariant) continue;
      let missingRunNumber = 1;
      for (const runNumber of runNumbers) {
        if (runNumber !== missingRunNumber) break;
        missingRunNumber += 1;
      }
      fail(
        "results.runs",
        `missing required run tuple ${scenarioId}/${variant}/${missingRunNumber} for results.runsPerVariant=${value.runsPerVariant}`,
      );
    }
  }

  return value;
}

export function median(values) {
  requireArray(values, "median values", { nonEmpty: true });
  const sorted = values
    .map((value, index) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(`median values[${index}]`, "expected a finite number");
      }
      if (value < 0) {
        fail(`median values[${index}]`, "must not be negative");
      }
      return value;
    })
    .sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return sorted[middle - 1] / 2 + sorted[middle] / 2;
}

function requireScenarioOrder(value, selectedScenarioIds) {
  if (value === undefined || value === null) return selectedScenarioIds;
  const order = requireUniqueStrings(value, "scenarioOrder", { nonEmpty: true });
  const selected = new Set(selectedScenarioIds);
  order.forEach((scenarioId, index) => {
    if (!selected.has(scenarioId)) {
      fail(`scenarioOrder[${index}]`, `is not listed in results.scenarioIds`);
    }
  });
  const ordered = new Set(order);
  const missing = selectedScenarioIds.filter((scenarioId) => !ordered.has(scenarioId));
  if (missing.length) {
    fail("scenarioOrder", `missing selected scenario id${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`);
  }
  return order;
}

function summaryOrder(results, options, hasScenarioFile) {
  if (hasScenarioFile) return results.scenarioIds;
  return requireScenarioOrder(options.scenarioOrder, results.scenarioIds);
}

function formatRank(rank, reciprocal) {
  if (rank === null) return "missing";
  return `rank ${rank}, reciprocal rank ${formatNumber(reciprocal)}`;
}

export function describeReviewedRelationships(reviewed) {
  if (!reviewed) return [];
  const descriptions = reviewed.anchorOrder.map(
    (pair) =>
      `${pair.before.file}#${pair.before.label} (${formatRank(pair.beforeRank, pair.beforeReciprocalRank)}) before ${pair.after.file}#${pair.after.label} (${formatRank(pair.afterRank, pair.afterReciprocalRank)})`,
  );
  descriptions.push(
    `recommended ${reviewed.recommendedFile.expected} (${formatRank(reviewed.recommendedFile.rank, reviewed.recommendedFile.reciprocalRank)}; actual ${String(reviewed.recommendedFile.actual)})`,
  );
  for (const candidate of reviewed.candidateTests) {
    descriptions.push(`${candidate.file} (${formatRank(candidate.rank, candidate.reciprocalRank)})`);
  }
  return descriptions;
}

export function summarizeResults(results, options = {}) {
  validateResults(results, options);
  const hasScenarioFile = (options?.scenarioFile ?? options?.scenarios ?? null) !== null;
  const requestedOrder = summaryOrder(results, options, hasScenarioFile);
  const orderIndex = new Map(requestedOrder.map((scenarioId, index) => [scenarioId, index]));
  const groups = new Map();

  for (const run of results.runs) {
    const key = `${run.scenarioId}\0${run.variant}`;
    const group = groups.get(key) ?? {
      scenarioId: run.scenarioId,
      variant: run.variant,
      runs: [],
    };
    group.runs.push(run);
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((left, right) => {
      const leftIndex = orderIndex.get(left.scenarioId);
      const rightIndex = orderIndex.get(right.scenarioId);
      if (leftIndex !== undefined || rightIndex !== undefined) {
        if (leftIndex === undefined) return 1;
        if (rightIndex === undefined) return -1;
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      }
      if (left.scenarioId < right.scenarioId) return -1;
      if (left.scenarioId > right.scenarioId) return 1;
      return VARIANT_ORDER.get(left.variant) - VARIANT_ORDER.get(right.variant);
    })
    .map((group) => {
      const summary = {
        scenarioId: group.scenarioId,
        variant: group.variant,
        sampleCount: group.runs.length,
        medians: {
          toolCalls: median(group.runs.map((run) => run.metrics.toolCalls)),
          fileReads: median(group.runs.map((run) => run.metrics.fileReads)),
          wallTimeMs: median(group.runs.map((run) => run.metrics.wallTimeMs)),
        },
        completeRunCount: group.runs.filter((run) => run.checks.completeness === 1).length,
        minimumCompleteness: group.runs.reduce((minimum, run) => Math.min(minimum, run.checks.completeness), 1),
      };
      const descriptions = [
        ...new Set(group.runs.flatMap((run) => describeReviewedRelationships(run.checks.reviewedRelationships))),
      ];
      if (descriptions.length) summary.reviewedRelationships = descriptions;
      return summary;
    });
}

export function escapeMarkdown(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/([`*_[\]{}<>])/gu, "\\$1")
    .replace(/\r\n|\r|\n/gu, "<br>");
}

function formatNumber(value) {
  if (Object.is(value, -0)) return "0";
  return String(value);
}

export function renderMarkdownTable(summaries) {
  requireArray(summaries, "summaries", { nonEmpty: true });
  const includeReviewedRelationships = summaries.some((summary) => Object.hasOwn(summary, "reviewedRelationships"));
  const headers = [
    "Scenario",
    "Variant",
    "Samples",
    "Median tool calls",
    "Median file reads",
    "Median wall time (ms)",
    "Complete runs",
    "Minimum completeness",
  ];
  if (includeReviewedRelationships) headers.push("Reviewed relationships");
  const rows = summaries.map((summary, index) => {
    const location = `summaries[${index}]`;
    const summaryKeys = ["scenarioId", "variant", "sampleCount", "medians", "completeRunCount", "minimumCompleteness"];
    if (Object.hasOwn(summary, "reviewedRelationships")) summaryKeys.push("reviewedRelationships");
    requireExactKeys(summary, summaryKeys, location);
    requireNonEmptyString(summary.scenarioId, `${location}.scenarioId`);
    if (!VARIANT_ORDER.has(summary.variant)) {
      fail(
        `${location}.variant`,
        `expected one of ${VARIANT_KEYS.map((variant) => JSON.stringify(variant)).join(", ")}`,
      );
    }
    requirePositiveInteger(summary.sampleCount, `${location}.sampleCount`);
    requireExactKeys(summary.medians, METRIC_KEYS, `${location}.medians`);
    for (const key of METRIC_KEYS) {
      requireNonNegativeNumber(summary.medians[key], `${location}.medians.${key}`);
    }
    requireNonNegativeNumber(summary.completeRunCount, `${location}.completeRunCount`, { integer: true });
    if (summary.completeRunCount > summary.sampleCount) {
      fail(`${location}.completeRunCount`, "must not exceed sampleCount");
    }
    requireNonNegativeNumber(summary.minimumCompleteness, `${location}.minimumCompleteness`);
    if (summary.minimumCompleteness > 1) {
      fail(`${location}.minimumCompleteness`, "must be between 0 and 1");
    }
    if (Object.hasOwn(summary, "reviewedRelationships")) {
      requireUniqueStrings(summary.reviewedRelationships, `${location}.reviewedRelationships`, {
        nonEmpty: true,
      });
    }

    const row = [
      escapeMarkdown(summary.scenarioId),
      escapeMarkdown(summary.variant),
      String(summary.sampleCount),
      formatNumber(summary.medians.toolCalls),
      formatNumber(summary.medians.fileReads),
      formatNumber(summary.medians.wallTimeMs),
      String(summary.completeRunCount),
      `${formatNumber(summary.minimumCompleteness * 100)}%`,
    ];
    if (includeReviewedRelationships) {
      let description = "-";
      if (summary.reviewedRelationships) {
        description = `${summary.reviewedRelationships.length} exact observations; ranks in results.example.json`;
      }
      row.push(escapeMarkdown(description));
    }
    return row;
  });
  const widths = headers.map((header, column) =>
    rows.reduce((width, row) => Math.max(width, row[column].length), header.length),
  );
  const numericColumns = new Set([2, 3, 4, 5, 6, 7]);
  const formatRow = (cells) =>
    `| ${cells
      .map((cell, column) => (numericColumns.has(column) ? cell.padStart(widths[column]) : cell.padEnd(widths[column])))
      .join(" | ")} |`;
  const separator = widths.map((width, column) => {
    if (numericColumns.has(column)) return `${"-".repeat(width - 1)}:`;
    return "-".repeat(width);
  });
  return `${[formatRow(headers), formatRow(separator), ...rows.map(formatRow)].join("\n")}\n`;
}

function generatedBlockBounds(markdown) {
  if (typeof markdown !== "string") {
    fail("README", "expected Markdown text");
  }
  const start = markdown.indexOf(README_START_MARKER);
  const end = markdown.indexOf(README_END_MARKER);
  if (start === -1 || end === -1) {
    fail("README", `expected exactly one ${README_START_MARKER} and one ${README_END_MARKER}`);
  }
  if (start !== markdown.lastIndexOf(README_START_MARKER) || end !== markdown.lastIndexOf(README_END_MARKER)) {
    fail("README", "generated benchmark markers must each appear exactly once");
  }
  const contentStart = start + README_START_MARKER.length;
  if (end < contentStart) {
    fail("README", "benchmark-results:end marker appears before benchmark-results:start");
  }
  return { contentStart, end };
}

export function replaceGeneratedBlock(markdown, generatedContent) {
  const { contentStart, end } = generatedBlockBounds(markdown);
  if (typeof generatedContent !== "string" || generatedContent.trim().length === 0) {
    fail("generated content", "expected non-empty text");
  }
  if (generatedContent.includes(README_START_MARKER) || generatedContent.includes(README_END_MARKER)) {
    fail("generated content", "must not contain benchmark result markers");
  }
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const normalizedContent = generatedContent.trim().replace(/\r\n|\r|\n/gu, newline);
  return `${markdown.slice(0, contentStart)}${newline}${newline}${normalizedContent}${newline}${newline}${markdown.slice(end)}`;
}

export function checkGeneratedBlock(markdown, generatedContent) {
  return markdown === replaceGeneratedBlock(markdown, generatedContent);
}

function consumeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(flag, "expected a value");
  }
  return value;
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    fail("CLI arguments", "expected an array");
  }
  const options = {
    input: null,
    scenarioFile: null,
    json: false,
    readme: null,
    write: false,
    check: false,
  };
  const seen = new Set();
  const valueFlags = new Map([
    ["--input", "input"],
    ["--scenario-file", "scenarioFile"],
    ["--readme", "readme"],
  ]);
  const booleanFlags = new Map([
    ["--json", "json"],
    ["--write", "write"],
    ["--check", "check"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    requireNonEmptyString(argument, `CLI arguments[${index}]`);
    const equalsIndex = argument.indexOf("=");
    const flag = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    if (valueFlags.has(flag)) {
      if (seen.has(flag)) fail(flag, "specified more than once");
      seen.add(flag);
      const value = equalsIndex === -1 ? consumeValue(argv, index, flag) : argument.slice(equalsIndex + 1);
      requireNonEmptyString(value, flag);
      options[valueFlags.get(flag)] = value;
      if (equalsIndex === -1) index += 1;
      continue;
    }
    if (booleanFlags.has(flag)) {
      if (equalsIndex !== -1) fail(flag, "does not take a value");
      if (seen.has(flag)) fail(flag, "specified more than once");
      seen.add(flag);
      options[booleanFlags.get(flag)] = true;
      continue;
    }
    fail("CLI arguments", `unknown argument ${JSON.stringify(argument)}`);
  }

  if (options.input === null) fail("--input", "is required");
  if (options.write && options.check) fail("CLI arguments", "--write and --check are mutually exclusive");
  if ((options.write || options.check) && options.readme === null) {
    fail("CLI arguments", "--write and --check require --readme");
  }
  if (options.readme !== null && !options.write && !options.check) {
    fail("CLI arguments", "--readme requires either --write or --check");
  }

  return options;
}

function parseJsonFile(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(label, `cannot read ${JSON.stringify(filePath)}: ${message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(label, `invalid JSON in ${JSON.stringify(filePath)}: ${message}`);
  }
}

export function runCli(argv, io = {}) {
  const options = parseArgs(argv);
  const scenarioFile = options.scenarioFile
    ? validateScenarioFile(parseJsonFile(options.scenarioFile, "--scenario-file"))
    : null;
  const results = parseJsonFile(options.input, "--input");
  const summaries = summarizeResults(results, scenarioFile ? { scenarioFile } : {});
  const table = renderMarkdownTable(summaries);

  if (options.readme) {
    let readme;
    try {
      readme = fs.readFileSync(options.readme, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail("--readme", `cannot read ${JSON.stringify(options.readme)}: ${message}`);
    }
    if (options.check) {
      if (!checkGeneratedBlock(readme, table)) {
        fail(
          "--check",
          `generated benchmark block in ${JSON.stringify(options.readme)} is out of date; rerun with --write`,
        );
      }
    } else {
      const updated = replaceGeneratedBlock(readme, table);
      try {
        fs.writeFileSync(options.readme, updated, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail("--write", `cannot write ${JSON.stringify(options.readme)}: ${message}`);
      }
    }
  }

  const output = options.json ? `${JSON.stringify(summaries, null, 2)}\n` : table;
  const stdout = io.stdout ?? process.stdout;
  if (typeof stdout === "function") stdout(output);
  else if (stdout && typeof stdout.write === "function") stdout.write(output);
  else fail("CLI output", "stdout must be a function or writable stream");
  return { summaries, table };
}
