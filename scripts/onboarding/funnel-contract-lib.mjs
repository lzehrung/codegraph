export const FUNNEL_RESULT_SCHEMA_VERSION = 1;

export const FUNNEL_CHANNELS = Object.freeze(["source", "package", "standalone"]);
export const FUNNEL_TARGETS = Object.freeze([
  "win32-x64",
  "win32-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
]);

const SCENARIOS_BY_CHANNEL = Object.freeze({
  source: "clean-home-source",
  package: "exact-package-candidate",
  standalone: "extracted-standalone",
});

const CHECK_STATUSES = new Set(["pass", "fail", "skipped"]);
const RESULT_STATUSES = new Set(["pass", "fail"]);

export class FunnelContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "FunnelContractError";
  }
}

export function currentFunnelTarget(platform = process.platform, architecture = process.arch) {
  const target = `${platform}-${architecture}`;
  if (FUNNEL_TARGETS.includes(target)) return target;
  throw new FunnelContractError(`Unsupported funnel target: ${target}.`);
}

export function scenarioForFunnelChannel(channel) {
  const scenario = SCENARIOS_BY_CHANNEL[channel];
  if (scenario) return scenario;
  throw new FunnelContractError(`Unsupported funnel channel: ${String(channel)}.`);
}

export function createFunnelResultV1({ channel, target, scenario = scenarioForFunnelChannel(channel) }) {
  assertChannel(channel);
  assertTarget(target);
  if (scenario !== scenarioForFunnelChannel(channel)) {
    throw new FunnelContractError(`Scenario ${scenario} does not match channel ${channel}.`);
  }
  return {
    schemaVersion: FUNNEL_RESULT_SCHEMA_VERSION,
    scenario,
    channel,
    target,
    status: "pass",
    version: null,
    timings: {
      totalMs: 0,
      steps: [],
    },
    checks: [],
    diagnostics: [],
  };
}

export function addFunnelTiming(result, name, durationMs) {
  result.timings.steps.push({ name, durationMs: normalizeDuration(durationMs) });
}

export function addFunnelCheck(result, check) {
  const normalized = {
    name: requireString(check.name, "Check name"),
    status: normalizeCheckStatus(check.status),
    durationMs: normalizeDuration(check.durationMs),
  };
  if (check.exitCode !== undefined) normalized.exitCode = normalizeExitCode(check.exitCode);
  result.checks.push(normalized);
  return normalized;
}

export function addFunnelDiagnostic(result, diagnostic) {
  const normalized = {
    code: requireString(diagnostic.code, "Diagnostic code"),
    message: requireString(diagnostic.message, "Diagnostic message"),
  };
  if (diagnostic.step !== undefined) normalized.step = requireString(diagnostic.step, "Diagnostic step");
  if (diagnostic.command !== undefined) normalized.command = requireString(diagnostic.command, "Diagnostic command");
  if (diagnostic.exitCode !== undefined) normalized.exitCode = normalizeExitCode(diagnostic.exitCode);
  if (diagnostic.stdout !== undefined) normalized.stdout = String(diagnostic.stdout);
  if (diagnostic.stderr !== undefined) normalized.stderr = String(diagnostic.stderr);
  result.diagnostics.push(normalized);
  return normalized;
}

export function finalizeFunnelResultV1(result, totalDurationMs) {
  result.timings.totalMs = normalizeDuration(totalDurationMs);
  result.status = result.checks.some((check) => check.status === "fail") ? "fail" : "pass";
  return assertFunnelResultV1(result);
}

export function isFunnelResultV1(value) {
  try {
    assertFunnelResultV1(value);
    return true;
  } catch {
    return false;
  }
}

export function assertFunnelResultV1(value) {
  if (!isRecord(value)) throw new FunnelContractError("Funnel result must be an object.");
  if (value.schemaVersion !== FUNNEL_RESULT_SCHEMA_VERSION) {
    throw new FunnelContractError(`Unsupported funnel result schema: ${String(value.schemaVersion)}.`);
  }
  assertChannel(value.channel);
  assertTarget(value.target);
  const expectedScenario = scenarioForFunnelChannel(value.channel);
  if (value.scenario !== expectedScenario) {
    throw new FunnelContractError(`Scenario ${String(value.scenario)} does not match channel ${value.channel}.`);
  }
  if (!RESULT_STATUSES.has(value.status)) {
    throw new FunnelContractError(`Invalid funnel result status: ${String(value.status)}.`);
  }
  if (typeof value.version !== "string" && value.version !== null) {
    throw new FunnelContractError("Funnel result version must be a string or null.");
  }
  assertTimings(value.timings);
  assertChecks(value.checks);
  assertDiagnostics(value.diagnostics);
  const failed = value.checks.some((check) => check.status === "fail");
  if ((value.status === "fail") !== failed) {
    throw new FunnelContractError("Funnel result status must match failed checks.");
  }
  return value;
}

function assertChannel(channel) {
  if (!FUNNEL_CHANNELS.includes(channel)) {
    throw new FunnelContractError(`Unsupported funnel channel: ${String(channel)}.`);
  }
}

function assertTarget(target) {
  if (!FUNNEL_TARGETS.includes(target)) {
    throw new FunnelContractError(`Unsupported funnel target: ${String(target)}.`);
  }
}

function assertTimings(timings) {
  if (!isRecord(timings)) throw new FunnelContractError("Funnel result timings must be an object.");
  normalizeDuration(timings.totalMs);
  if (!Array.isArray(timings.steps)) throw new FunnelContractError("Funnel result timings.steps must be an array.");
  for (const step of timings.steps) {
    if (!isRecord(step)) throw new FunnelContractError("Funnel timing step must be an object.");
    requireString(step.name, "Funnel timing step name");
    normalizeDuration(step.durationMs);
  }
}

function assertChecks(checks) {
  if (!Array.isArray(checks)) throw new FunnelContractError("Funnel result checks must be an array.");
  for (const check of checks) {
    if (!isRecord(check)) throw new FunnelContractError("Funnel check must be an object.");
    requireString(check.name, "Funnel check name");
    normalizeCheckStatus(check.status);
    normalizeDuration(check.durationMs);
    if (check.exitCode !== undefined) normalizeExitCode(check.exitCode);
  }
}

function assertDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) throw new FunnelContractError("Funnel result diagnostics must be an array.");
  for (const diagnostic of diagnostics) {
    if (!isRecord(diagnostic)) throw new FunnelContractError("Funnel diagnostic must be an object.");
    requireString(diagnostic.code, "Funnel diagnostic code");
    requireString(diagnostic.message, "Funnel diagnostic message");
    if (diagnostic.step !== undefined) requireString(diagnostic.step, "Funnel diagnostic step");
    if (diagnostic.command !== undefined) requireString(diagnostic.command, "Funnel diagnostic command");
    if (diagnostic.exitCode !== undefined) normalizeExitCode(diagnostic.exitCode);
    if (diagnostic.stdout !== undefined && typeof diagnostic.stdout !== "string") {
      throw new FunnelContractError("Funnel diagnostic stdout must be a string.");
    }
    if (diagnostic.stderr !== undefined && typeof diagnostic.stderr !== "string") {
      throw new FunnelContractError("Funnel diagnostic stderr must be a string.");
    }
  }
}

function normalizeCheckStatus(status) {
  if (!CHECK_STATUSES.has(status)) {
    throw new FunnelContractError(`Invalid funnel check status: ${String(status)}.`);
  }
  return status;
}

function normalizeDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new FunnelContractError(`Duration must be a non-negative finite number: ${String(value)}.`);
  }
  return Math.round(value);
}

function normalizeExitCode(value) {
  if (value === null) return null;
  if (!Number.isInteger(value)) {
    throw new FunnelContractError(`Exit code must be an integer or null: ${String(value)}.`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value) throw new FunnelContractError(`${label} must be a non-empty string.`);
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
