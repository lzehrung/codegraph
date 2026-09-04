import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const AUDIT_REPORT_VERSION = 2;
const REPORT_SCHEMA_VERSION = 1;
const ALLOWLIST_SCHEMA_VERSION = 1;
const DEFAULT_AUDIT_ATTEMPTS = 3;
const DEFAULT_AUDIT_RETRY_DELAY_MS = 2000;
const DEFAULT_AUDIT_TIMEOUT_MS = 120_000;
const RETRYABLE_AUDIT_ERROR_CODES = new Set([
  "MALFORMED_AUDIT_JSON",
  "NPM_AUDIT_COMMAND_FAILED",
  "NPM_AUDIT_EXECUTION_FAILED",
]);
const DEFAULT_ALLOWLIST_PATH = fileURLToPath(new URL("./production-audit-allowlist.json", import.meta.url));
const NPM_SEVERITIES = Object.freeze(["info", "low", "moderate", "high", "critical"]);
const SEVERITY_RANK = new Map(NPM_SEVERITIES.map((severity, index) => [severity, index]));
const REQUIRED_EXCEPTION_FIELDS = Object.freeze(["advisory", "package", "reason", "owner", "expires", "trackingIssue"]);
const WILDCARD_PATTERN = /[*?[\]]/;
const GHSA_PATTERN = /\bGHSA-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}\b/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class ProductionAuditInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProductionAuditInputError";
    this.code = code;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function npmAuditEndpointError(document) {
  if (!isRecord(document) || document.auditReportVersion === AUDIT_REPORT_VERSION) {
    return null;
  }

  if (isRecord(document.error)) {
    const code = firstNonEmptyString(document.error.code) ?? "NPM_AUDIT_ERROR";
    const summary =
      firstNonEmptyString(document.error.summary, document.error.message) ?? "npm audit returned an error object.";
    return `${code}: ${summary}`;
  }

  const hasEndpointShape = "statusCode" in document || "uri" in document || "method" in document;
  if (!hasEndpointShape || typeof document.message !== "string" || !document.message.trim()) {
    return null;
  }

  const status = Number.isInteger(document.statusCode) ? `HTTP ${document.statusCode}` : "audit endpoint error";
  return `${status}: ${document.message}`;
}

function parseJsonText(text, code, label) {
  if (typeof text !== "string") {
    throw new ProductionAuditInputError(code, `${label} must be UTF-8 text.`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProductionAuditInputError(code, `${label} is not valid JSON: ${stringifyError(error)}`);
  }
}

function requiredString(value, path, code) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProductionAuditInputError(code, `${path} must be a non-empty string.`);
  }
  return value;
}

function requireKnownSeverity(value, path) {
  const severity = requiredString(value, path, "INVALID_AUDIT_REPORT");
  if (!SEVERITY_RANK.has(severity)) {
    throw new ProductionAuditInputError(
      "INVALID_AUDIT_REPORT",
      `${path} has unsupported severity ${JSON.stringify(severity)}.`,
    );
  }
  return severity;
}

function parseSeverityMetadata(metadata) {
  if (!isRecord(metadata) || !isRecord(metadata.vulnerabilities)) {
    throw new ProductionAuditInputError(
      "INVALID_AUDIT_REPORT",
      "npm audit metadata.vulnerabilities must be an object.",
    );
  }

  const counts = {};
  let calculatedTotal = 0;
  for (const severity of NPM_SEVERITIES) {
    const count = metadata.vulnerabilities[severity];
    if (!Number.isInteger(count) || count < 0) {
      throw new ProductionAuditInputError(
        "INVALID_AUDIT_REPORT",
        `npm audit metadata.vulnerabilities.${severity} must be a non-negative integer.`,
      );
    }
    counts[severity] = count;
    calculatedTotal += count;
  }

  const total = metadata.vulnerabilities.total;
  if (!Number.isInteger(total) || total < 0) {
    throw new ProductionAuditInputError(
      "INVALID_AUDIT_REPORT",
      "npm audit metadata.vulnerabilities.total must be a non-negative integer.",
    );
  }
  if (total !== calculatedTotal) {
    throw new ProductionAuditInputError(
      "INVALID_AUDIT_REPORT",
      `npm audit vulnerability counts total ${total}, but severity counts total ${calculatedTotal}.`,
    );
  }

  return { ...counts, total };
}

function advisoryIdFromVia(via, path) {
  if (typeof via.github_advisory_id === "string" && via.github_advisory_id.trim()) {
    return via.github_advisory_id.toUpperCase();
  }

  if (typeof via.url === "string") {
    const match = via.url.match(GHSA_PATTERN);
    if (match) {
      return match[0].toUpperCase();
    }
  }

  if (typeof via.source === "string" && via.source.trim()) {
    return via.source;
  }
  if (Number.isSafeInteger(via.source) && via.source > 0) {
    return String(via.source);
  }

  throw new ProductionAuditInputError("INVALID_AUDIT_REPORT", `${path} does not contain a stable advisory ID.`);
}

function compareText(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareVulnerabilities(left, right) {
  const rankDifference = SEVERITY_RANK.get(right.severity) - SEVERITY_RANK.get(left.severity);
  if (rankDifference) {
    return rankDifference;
  }
  const packageDifference = compareText(left.package, right.package);
  if (packageDifference) {
    return packageDifference;
  }
  return compareText(left.advisory, right.advisory);
}

function vulnerabilityKey(advisory, packageName) {
  return JSON.stringify([advisory, packageName]);
}

function parseAdvisoryVia(via, entry, entryPath, viaIndex) {
  const path = `${entryPath}.via[${viaIndex}]`;
  const packageName = requiredString(via.dependency, `${path}.dependency`, "INVALID_AUDIT_REPORT");
  const severity = requireKnownSeverity(via.severity, `${path}.severity`);
  const title = requiredString(via.title, `${path}.title`, "INVALID_AUDIT_REPORT");
  const url = requiredString(via.url, `${path}.url`, "INVALID_AUDIT_REPORT");
  const range = requiredString(via.range, `${path}.range`, "INVALID_AUDIT_REPORT");
  const advisory = advisoryIdFromVia(via, path);

  return {
    advisory,
    package: packageName,
    severity,
    title,
    url,
    range,
    source: String(via.source),
    isDirect: entry.isDirect,
  };
}

export function parseNpmAuditOutput(auditOutput) {
  const document = parseJsonText(auditOutput, "MALFORMED_AUDIT_JSON", "npm audit output");
  if (!isRecord(document)) {
    throw new ProductionAuditInputError("INVALID_AUDIT_REPORT", "npm audit output must be a JSON object.");
  }
  const endpointError = npmAuditEndpointError(document);
  if (endpointError) {
    throw new ProductionAuditInputError("NPM_AUDIT_COMMAND_FAILED", endpointError);
  }
  if (document.auditReportVersion !== AUDIT_REPORT_VERSION) {
    throw new ProductionAuditInputError(
      "INVALID_AUDIT_REPORT",
      `npm audit report version must be ${AUDIT_REPORT_VERSION}, got ${JSON.stringify(document.auditReportVersion)}.`,
    );
  }
  if (!isRecord(document.vulnerabilities)) {
    throw new ProductionAuditInputError("INVALID_AUDIT_REPORT", "npm audit vulnerabilities must be an object.");
  }

  const metadata = parseSeverityMetadata(document.metadata);
  const vulnerabilitiesByKey = new Map();
  for (const [packageKey, entry] of Object.entries(document.vulnerabilities)) {
    const entryPath = `vulnerabilities[${JSON.stringify(packageKey)}]`;
    if (!isRecord(entry)) {
      throw new ProductionAuditInputError("INVALID_AUDIT_REPORT", `${entryPath} must be an object.`);
    }
    const entryName = requiredString(entry.name, `${entryPath}.name`, "INVALID_AUDIT_REPORT");
    if (entryName !== packageKey) {
      throw new ProductionAuditInputError(
        "INVALID_AUDIT_REPORT",
        `${entryPath}.name must exactly match its package key.`,
      );
    }
    requireKnownSeverity(entry.severity, `${entryPath}.severity`);
    if (typeof entry.isDirect !== "boolean") {
      throw new ProductionAuditInputError("INVALID_AUDIT_REPORT", `${entryPath}.isDirect must be a boolean.`);
    }
    if (!Array.isArray(entry.via)) {
      throw new ProductionAuditInputError("INVALID_AUDIT_REPORT", `${entryPath}.via must be an array.`);
    }

    for (const [viaIndex, via] of entry.via.entries()) {
      if (typeof via === "string") {
        if (!via.trim()) {
          throw new ProductionAuditInputError(
            "INVALID_AUDIT_REPORT",
            `${entryPath}.via[${viaIndex}] must not be empty.`,
          );
        }
        continue;
      }
      if (!isRecord(via)) {
        throw new ProductionAuditInputError(
          "INVALID_AUDIT_REPORT",
          `${entryPath}.via[${viaIndex}] must be an advisory object or package name.`,
        );
      }

      const vulnerability = parseAdvisoryVia(via, entry, entryPath, viaIndex);
      const key = vulnerabilityKey(vulnerability.advisory, vulnerability.package);
      const existing = vulnerabilitiesByKey.get(key);
      if (!existing) {
        vulnerabilitiesByKey.set(key, vulnerability);
        continue;
      }
      if (SEVERITY_RANK.get(vulnerability.severity) > SEVERITY_RANK.get(existing.severity)) {
        vulnerabilitiesByKey.set(key, vulnerability);
      }
    }
  }

  const vulnerabilities = [...vulnerabilitiesByKey.values()].sort(compareVulnerabilities);
  if (metadata.total && !vulnerabilities.length) {
    throw new ProductionAuditInputError(
      "INVALID_AUDIT_REPORT",
      "npm audit reported vulnerabilities but did not provide any resolvable advisories.",
    );
  }
  if (!metadata.total && Object.keys(document.vulnerabilities).length) {
    throw new ProductionAuditInputError(
      "INVALID_AUDIT_REPORT",
      "npm audit listed vulnerable packages while reporting a zero vulnerability total.",
    );
  }

  return {
    auditReportVersion: AUDIT_REPORT_VERSION,
    metadata: { vulnerabilities: metadata },
    vulnerabilities,
  };
}

function utcDateString(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ProductionAuditInputError("INVALID_ALLOWLIST", "The allowlist validation time must be a valid Date.");
  }
  return now.toISOString().slice(0, 10);
}

function isCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseExceptionRow(row, index, today, issues) {
  const path = `exceptions[${index}]`;
  if (!isRecord(row)) {
    issues.push(`${path} must be an object.`);
    return null;
  }

  const values = {};
  const issueCountBeforeRow = issues.length;
  for (const field of REQUIRED_EXCEPTION_FIELDS) {
    const value = row[field];
    if (typeof value !== "string" || !value.trim()) {
      issues.push(`${path}.${field} must be a non-empty string.`);
      continue;
    }
    values[field] = value;
  }

  for (const field of ["advisory", "package"]) {
    const value = values[field];
    if (value && WILDCARD_PATTERN.test(value)) {
      issues.push(`${path}.${field} must not contain wildcard characters.`);
    }
  }

  if (values.expires) {
    if (!isCalendarDate(values.expires)) {
      issues.push(`${path}.expires must use a real YYYY-MM-DD date.`);
    } else if (values.expires < today) {
      issues.push(`${path} expired on ${values.expires}.`);
    }
  }

  if (issues.length !== issueCountBeforeRow) {
    return null;
  }
  return values;
}

export function parseProductionAuditAllowlist(allowlistInput, { now = new Date() } = {}) {
  let document = allowlistInput;
  if (typeof allowlistInput === "string") {
    document = parseJsonText(allowlistInput, "MALFORMED_ALLOWLIST_JSON", "production audit allowlist");
  }
  if (!isRecord(document)) {
    throw new ProductionAuditInputError("INVALID_ALLOWLIST", "Production audit allowlist must be a JSON object.");
  }

  const issues = [];
  if (document.schemaVersion !== ALLOWLIST_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${ALLOWLIST_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(document.exceptions)) {
    issues.push("exceptions must be an array.");
  }
  if (issues.length) {
    throw new ProductionAuditInputError("INVALID_ALLOWLIST", issues.join(" "));
  }

  const today = utcDateString(now);
  const exceptions = [];
  const seen = new Set();
  for (const [index, row] of document.exceptions.entries()) {
    const exception = parseExceptionRow(row, index, today, issues);
    if (!exception) {
      continue;
    }
    const key = vulnerabilityKey(exception.advisory, exception.package);
    if (seen.has(key)) {
      issues.push(`exceptions[${index}] duplicates advisory ${exception.advisory} for package ${exception.package}.`);
      continue;
    }
    seen.add(key);
    exceptions.push(exception);
  }

  if (issues.length) {
    throw new ProductionAuditInputError("INVALID_ALLOWLIST", issues.join(" "));
  }
  return { schemaVersion: ALLOWLIST_SCHEMA_VERSION, exceptions };
}

function reportError(error, fallbackCode) {
  if (error instanceof ProductionAuditInputError) {
    return { code: error.code, message: error.message };
  }
  return { code: fallbackCode, message: stringifyError(error) };
}

function createSeverityCounts(vulnerabilities) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const severity of NPM_SEVERITIES) {
    counts[severity] = 0;
  }
  for (const vulnerability of vulnerabilities) {
    counts[vulnerability.severity] += 1;
  }
  return counts;
}

function createReport({ auditExitCode, auditMetadata, acceptedExceptions, rejectedVulnerabilities, errors }) {
  const vulnerabilities = [
    ...acceptedExceptions.map((exception) => ({ severity: exception.severity })),
    ...rejectedVulnerabilities,
  ];
  const status = errors.length || rejectedVulnerabilities.length ? "fail" : "pass";
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status,
    auditExitCode,
    auditMetadata,
    acceptedExceptions,
    rejectedVulnerabilities,
    errors,
    summary: {
      totalVulnerabilities: vulnerabilities.length,
      accepted: acceptedExceptions.length,
      rejected: rejectedVulnerabilities.length,
      severities: createSeverityCounts(vulnerabilities),
    },
  };
}

function failureReport(code, message, auditExitCode = null) {
  return createReport({
    auditExitCode,
    auditMetadata: null,
    acceptedExceptions: [],
    rejectedVulnerabilities: [],
    errors: [{ code, message }],
  });
}

export function createProductionAuditReport({ auditOutput, auditExitCode = 0, allowlistInput, now = new Date() }) {
  const errors = [];
  let audit = null;
  let allowlist = null;

  try {
    audit = parseNpmAuditOutput(auditOutput);
  } catch (error) {
    errors.push(reportError(error, "INVALID_AUDIT_REPORT"));
  }
  try {
    allowlist = parseProductionAuditAllowlist(allowlistInput, { now });
  } catch (error) {
    errors.push(reportError(error, "INVALID_ALLOWLIST"));
  }

  if (audit) {
    const expectedVulnerabilityExit = auditExitCode === 1 && audit.metadata.vulnerabilities.total;
    if (auditExitCode !== 0 && !expectedVulnerabilityExit) {
      errors.push({
        code: "NPM_AUDIT_COMMAND_FAILED",
        message: `npm audit exited with status ${auditExitCode ?? "unknown"}.`,
      });
    }
  }

  const acceptedExceptions = [];
  const rejectedVulnerabilities = [];
  if (audit) {
    const exceptionsByKey = new Map();
    if (allowlist) {
      for (const exception of allowlist.exceptions) {
        exceptionsByKey.set(vulnerabilityKey(exception.advisory, exception.package), exception);
      }
    }

    for (const vulnerability of audit.vulnerabilities) {
      const exception = exceptionsByKey.get(vulnerabilityKey(vulnerability.advisory, vulnerability.package));
      if (!exception) {
        rejectedVulnerabilities.push(vulnerability);
        continue;
      }
      acceptedExceptions.push({ ...vulnerability, ...exception });
    }
  }

  return createReport({
    auditExitCode,
    auditMetadata: audit?.metadata.vulnerabilities ?? null,
    acceptedExceptions,
    rejectedVulnerabilities,
    errors,
  });
}

function childOutputText(output) {
  if (typeof output === "string") {
    return output;
  }
  if (Buffer.isBuffer(output)) {
    return output.toString("utf8");
  }
  return "";
}

function isRetryableAuditReport(report) {
  if (report.status === "pass") {
    return false;
  }
  if (report.rejectedVulnerabilities.length || !report.errors.length) {
    return false;
  }
  return report.errors.every((error) => RETRYABLE_AUDIT_ERROR_CODES.has(error.code));
}

function collectAuditOutput(result) {
  const stdout = childOutputText(result.stdout);
  if (stdout.trim()) {
    return stdout;
  }
  return childOutputText(result.stderr);
}

export function runProductionAudit({
  cwd = process.cwd(),
  allowlistPath = DEFAULT_ALLOWLIST_PATH,
  now = new Date(),
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  readFileSyncImpl = readFileSync,
  sleepImpl = defaultSleep,
  maxAttempts = DEFAULT_AUDIT_ATTEMPTS,
  retryDelayMs = DEFAULT_AUDIT_RETRY_DELAY_MS,
  timeoutMs = DEFAULT_AUDIT_TIMEOUT_MS,
} = {}) {
  let allowlistInput;
  try {
    allowlistInput = readFileSyncImpl(allowlistPath, "utf8");
  } catch (error) {
    return failureReport(
      "ALLOWLIST_READ_FAILED",
      `Could not read production audit allowlist at ${allowlistPath}: ${stringifyError(error)}`,
    );
  }

  let command = "npm";
  let commandArguments = ["audit", "--omit=dev", "--json"];
  if (platform === "win32") {
    command = process.env.ComSpec || "cmd.exe";
    commandArguments = ["/d", "/s", "/c", "npm audit --omit=dev --json"];
  }

  const spawnOptions = {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: timeoutMs,
    env: {
      ...process.env,
      npm_config_fetch_retries: "5",
      npm_config_fetch_retry_mintimeout: "10000",
      npm_config_fetch_retry_maxtimeout: "60000",
    },
  };

  let lastReport = failureReport("NPM_AUDIT_EXECUTION_FAILED", "npm audit did not produce a report.");
  let attempts = DEFAULT_AUDIT_ATTEMPTS;
  if (Number.isInteger(maxAttempts) && maxAttempts > 0) {
    attempts = maxAttempts;
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let result;
    try {
      result = spawnSyncImpl(command, commandArguments, spawnOptions);
    } catch (error) {
      lastReport = failureReport("NPM_AUDIT_EXECUTION_FAILED", `Could not execute npm audit: ${stringifyError(error)}`);
    }

    if (result) {
      if (result.error) {
        lastReport = failureReport(
          "NPM_AUDIT_EXECUTION_FAILED",
          `Could not execute npm audit: ${stringifyError(result.error)}`,
          result.status,
        );
      } else {
        lastReport = createProductionAuditReport({
          auditOutput: collectAuditOutput(result),
          auditExitCode: result.status,
          allowlistInput,
          now,
        });
      }
    }

    if (!isRetryableAuditReport(lastReport) || attempt === attempts) {
      break;
    }
    sleepImpl(retryDelayMs * attempt);
  }

  return lastReport;
}
