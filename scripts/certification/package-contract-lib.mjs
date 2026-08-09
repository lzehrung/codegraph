import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getNativeTargetMetadata, nativeTargetMetadata } from "../native-targets-lib.mjs";

export const RELEASE_CANDIDATE_MANIFEST_SCHEMA_VERSION = 1;
export const PACKAGE_SMOKE_REPORT_SCHEMA_VERSION = 1;
export const ROOT_PACKAGE_NAME = "@lzehrung/codegraph";
export const CORE_PACKAGE_NAME = "@lzehrung/codegraph-core";
export const NATIVE_META_PACKAGE_NAME = "@lzehrung/codegraph-native";
export const NATIVE_TARGET_PACKAGE_PREFIX = "@lzehrung/codegraph-native-";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class PackageCertificationError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "PackageCertificationError";
    this.code = code;
    this.context = context;
  }
}

function fail(code, message, context = {}) {
  throw new PackageCertificationError(code, message, context);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, code, message) {
  if (!isRecord(value)) fail(code, message);
  return value;
}

function requireString(value, field, code = "manifest-invalid") {
  if (typeof value !== "string" || !value.trim()) {
    fail(code, `${field} must be a non-empty string.`, { field });
  }
  return value;
}

function requireVersion(value, field) {
  const version = requireString(value, field);
  if (!VERSION_PATTERN.test(version)) {
    fail("manifest-invalid", `${field} must be a semantic version.`, { field, value: version });
  }
  return version;
}

function normalizeManifestFile(file) {
  const normalized = requireString(file, "files[].file").replaceAll("\\", "/");
  if (
    normalized !== file ||
    path.posix.isAbsolute(normalized) ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.normalize(normalized) !== normalized
  ) {
    fail("manifest-invalid", `Candidate file path must be a normalized relative path: ${file}`, { file });
  }
  return normalized;
}

function expectedPackageForTarget(target) {
  getNativeTargetMetadata(target);
  return `${NATIVE_TARGET_PACKAGE_PREFIX}${target}`;
}

function validateCandidateRecord(value, index) {
  const record = requireRecord(value, "manifest-invalid", `files[${index}] must be an object.`);
  const packageName = requireString(record.package, `files[${index}].package`);
  const file = normalizeManifestFile(record.file);
  if (!file.endsWith(".tgz")) {
    fail("manifest-invalid", `Release candidate file must be an npm tarball: ${file}`, { file });
  }
  const sha256 = requireString(record.sha256, `files[${index}].sha256`);
  if (!SHA256_PATTERN.test(sha256)) {
    fail("manifest-invalid", `files[${index}].sha256 must be a lowercase SHA-256 digest.`, { file });
  }
  if (!Number.isSafeInteger(record.size) || record.size <= 0) {
    fail("manifest-invalid", `files[${index}].size must be a positive safe integer.`, { file });
  }

  if (
    packageName === ROOT_PACKAGE_NAME ||
    packageName === CORE_PACKAGE_NAME ||
    packageName === NATIVE_META_PACKAGE_NAME
  ) {
    if (record.target !== undefined) {
      fail("target-mismatch", `${packageName} must not declare a native target.`, { package: packageName });
    }
    return { package: packageName, file, sha256, size: record.size };
  }

  const target = requireString(record.target, `files[${index}].target`, "target-mismatch");
  let expectedPackage;
  try {
    expectedPackage = expectedPackageForTarget(target);
  } catch {
    fail("target-mismatch", `Candidate declares unsupported native target ${target}.`, {
      package: packageName,
      target,
    });
  }
  if (packageName !== expectedPackage) {
    fail("target-mismatch", `Target ${target} requires package ${expectedPackage}, received ${packageName}.`, {
      package: packageName,
      target,
      expectedPackage,
    });
  }
  return { package: packageName, target, file, sha256, size: record.size };
}

function assertSinglePackageRecord(files, packageName) {
  const matches = files.filter((entry) => entry.package === packageName);
  if (matches.length !== 1) {
    fail("manifest-incomplete", `Manifest must contain exactly one ${packageName} tarball.`, {
      package: packageName,
      count: matches.length,
    });
  }
}

export function validateReleaseCandidateManifest(value, options = {}) {
  const manifest = requireRecord(value, "manifest-invalid", "Release candidate manifest must be an object.");
  if (manifest.schemaVersion !== RELEASE_CANDIDATE_MANIFEST_SCHEMA_VERSION) {
    fail(
      "manifest-invalid",
      `Unsupported release candidate manifest schemaVersion ${String(manifest.schemaVersion)}.`,
      {
        schemaVersion: manifest.schemaVersion,
      },
    );
  }
  const sourceRevision = requireString(manifest.sourceRevision, "sourceRevision");
  const rootVersion = requireVersion(manifest.rootVersion, "rootVersion");
  const nativeVersion = requireVersion(manifest.nativeVersion, "nativeVersion");
  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    fail("manifest-incomplete", "Release candidate manifest files must be a non-empty array.");
  }

  const files = manifest.files.map(validateCandidateRecord);
  const fileNames = new Set();
  const packageTargets = new Set();
  for (const entry of files) {
    if (fileNames.has(entry.file)) {
      fail("manifest-invalid", `Duplicate release candidate file ${entry.file}.`, { file: entry.file });
    }
    fileNames.add(entry.file);
    const identity = `${entry.package}\0${entry.target ?? ""}`;
    if (packageTargets.has(identity)) {
      fail("manifest-invalid", `Duplicate release candidate package record for ${entry.package}.`, {
        package: entry.package,
        target: entry.target,
      });
    }
    packageTargets.add(identity);
  }

  assertSinglePackageRecord(files, ROOT_PACKAGE_NAME);
  assertSinglePackageRecord(files, CORE_PACKAGE_NAME);
  assertSinglePackageRecord(files, NATIVE_META_PACKAGE_NAME);

  if (options.expectedTargets !== undefined) {
    const expectedTargets = [...new Set(options.expectedTargets)].sort((left, right) => left.localeCompare(right));
    const actualTargets = files
      .filter((entry) => entry.target !== undefined)
      .map((entry) => entry.target)
      .sort((left, right) => left.localeCompare(right));
    const missingTargets = expectedTargets.filter((target) => !actualTargets.includes(target));
    const unexpectedTargets = actualTargets.filter((target) => !expectedTargets.includes(target));
    if (missingTargets.length || unexpectedTargets.length) {
      fail("manifest-incomplete", "Release candidate manifest native target set is incomplete.", {
        missingTargets,
        unexpectedTargets,
      });
    }
  }

  return {
    schemaVersion: RELEASE_CANDIDATE_MANIFEST_SCHEMA_VERSION,
    sourceRevision,
    rootVersion,
    nativeVersion,
    files,
  };
}

function resolveCandidatePath(manifestDirectory, file) {
  const root = path.resolve(manifestDirectory);
  const candidatePath = path.resolve(root, file);
  const relative = path.relative(root, candidatePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("manifest-invalid", `Candidate file escapes manifest directory: ${file}`, { file });
  }
  return candidatePath;
}

export async function computeFileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function describeCandidateFile(filePath) {
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile()) {
    fail("candidate-missing", `Release candidate is not a regular file: ${filePath}`, { filePath });
  }
  return { sha256: await computeFileSha256(filePath), size: stats.size };
}

export async function verifyReleaseCandidateFiles(manifest, manifestDirectory) {
  const verified = [];
  for (const entry of manifest.files) {
    const candidatePath = resolveCandidatePath(manifestDirectory, entry.file);
    let stats;
    try {
      stats = await fs.promises.stat(candidatePath);
    } catch (error) {
      fail("candidate-missing", `Release candidate file is missing: ${entry.file}`, {
        file: entry.file,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!stats.isFile()) {
      fail("candidate-missing", `Release candidate is not a regular file: ${entry.file}`, { file: entry.file });
    }
    if (stats.size !== entry.size) {
      fail("size-mismatch", `Release candidate size mismatch for ${entry.file}.`, {
        file: entry.file,
        expected: entry.size,
        actual: stats.size,
      });
    }
    const actualSha256 = await computeFileSha256(candidatePath);
    if (actualSha256 !== entry.sha256) {
      fail("checksum-mismatch", `Release candidate checksum mismatch for ${entry.file}.`, {
        file: entry.file,
        expected: entry.sha256,
        actual: actualSha256,
      });
    }
    verified.push({ ...entry, absolutePath: candidatePath });
  }
  return verified;
}

export async function readReleaseCandidateManifest(manifestPath, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
  } catch (error) {
    fail("manifest-invalid", `Could not read release candidate manifest ${manifestPath}.`, {
      manifestPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const manifest = validateReleaseCandidateManifest(parsed, options);
  if (options.verifyFiles) {
    await verifyReleaseCandidateFiles(manifest, path.dirname(manifestPath));
  }
  return manifest;
}

export function selectReleaseCandidatePackages(manifest, target) {
  const expectedTargetPackage = expectedPackageForTarget(target);
  const root = manifest.files.find((entry) => entry.package === ROOT_PACKAGE_NAME);
  const core = manifest.files.find((entry) => entry.package === CORE_PACKAGE_NAME);
  const native = manifest.files.find((entry) => entry.package === NATIVE_META_PACKAGE_NAME);
  const nativeTarget = manifest.files.find((entry) => entry.target === target);
  if (!root || !core || !native || !nativeTarget) {
    fail("target-mismatch", `Release candidate manifest has no complete package set for ${target}.`, { target });
  }
  if (nativeTarget.package !== expectedTargetPackage) {
    fail("target-mismatch", `Release candidate target package does not match ${target}.`, {
      target,
      package: nativeTarget.package,
      expectedPackage: expectedTargetPackage,
    });
  }
  return { root, core, native, nativeTarget };
}

export function selectReducedReleaseCandidatePackage(manifest) {
  const root = manifest.files.find((entry) => entry.package === ROOT_PACKAGE_NAME);
  const core = manifest.files.find((entry) => entry.package === CORE_PACKAGE_NAME);
  if (!root) fail("manifest-incomplete", `Release candidate manifest has no ${ROOT_PACKAGE_NAME} tarball.`);
  if (!core) fail("manifest-incomplete", `Release candidate manifest has no ${CORE_PACKAGE_NAME} tarball.`);
  return { root, core };
}

export function releaseCandidatePublicationOrder(manifest) {
  const targets = manifest.files
    .filter((entry) => entry.target !== undefined)
    .sort((left, right) => left.target.localeCompare(right.target));
  const native = manifest.files.find((entry) => entry.package === NATIVE_META_PACKAGE_NAME);
  const core = manifest.files.find((entry) => entry.package === CORE_PACKAGE_NAME);
  const root = manifest.files.find((entry) => entry.package === ROOT_PACKAGE_NAME);
  if (!native || !core || !root)
    fail("manifest-incomplete", "Release candidate manifest is missing publishable packages.");
  return [...targets, native, core, root];
}

export function assertReleaseCandidateIdentity(manifest, expected) {
  const mismatches = {};
  if (expected.sourceRevision !== undefined && manifest.sourceRevision !== expected.sourceRevision) {
    mismatches.sourceRevision = { expected: expected.sourceRevision, actual: manifest.sourceRevision };
  }
  if (expected.rootVersion !== undefined && manifest.rootVersion !== expected.rootVersion) {
    mismatches.rootVersion = { expected: expected.rootVersion, actual: manifest.rootVersion };
  }
  if (expected.nativeVersion !== undefined && manifest.nativeVersion !== expected.nativeVersion) {
    mismatches.nativeVersion = { expected: expected.nativeVersion, actual: manifest.nativeVersion };
  }
  if (Object.keys(mismatches).length) {
    fail("candidate-identity-mismatch", "Release candidate identity does not match the planned release.", mismatches);
  }
}

export function validateNativeTargetExceptions(value, options = {}) {
  const document = requireRecord(value, "exception-invalid", "Native target exception document must be an object.");
  if (document.schemaVersion !== 1 || !Array.isArray(document.exceptions)) {
    fail("exception-invalid", "Native target exception document must use schemaVersion 1 and an exceptions array.");
  }
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const exceptions = [];
  const targets = new Set();
  for (const [index, valueEntry] of document.exceptions.entries()) {
    const entry = requireRecord(valueEntry, "exception-invalid", `exceptions[${index}] must be an object.`);
    const target = requireString(entry.target, `exceptions[${index}].target`, "exception-invalid");
    const certificationClass = requireString(
      entry.certificationClass,
      `exceptions[${index}].certificationClass`,
      "exception-invalid",
    );
    const owner = requireString(entry.owner, `exceptions[${index}].owner`, "exception-invalid");
    const expires = requireString(entry.expires, `exceptions[${index}].expires`, "exception-invalid");
    const reason = requireString(entry.reason, `exceptions[${index}].reason`, "exception-invalid");
    let metadata;
    try {
      metadata = getNativeTargetMetadata(target);
    } catch {
      fail("exception-invalid", `Exception declares unsupported native target ${target}.`, { target });
    }
    if (metadata.certificationClass !== "structural" || certificationClass !== "structural") {
      fail("exception-invalid", `Only structural native targets may have certification exceptions: ${target}.`, {
        target,
      });
    }
    const expiryTime = Date.parse(`${expires}T00:00:00Z`);
    const canonicalExpiry =
      DATE_PATTERN.test(expires) &&
      Number.isFinite(expiryTime) &&
      new Date(expiryTime).toISOString().slice(0, 10) === expires;
    if (!canonicalExpiry) {
      fail("exception-invalid", `Exception expiry must use YYYY-MM-DD: ${expires}.`, { target, expires });
    }
    if (expires < today) {
      fail("structural-exception-expired", `Structural certification exception expired for ${target}.`, {
        target,
        expires,
        today,
      });
    }
    if (targets.has(target)) {
      fail("exception-invalid", `Duplicate structural certification exception for ${target}.`, { target });
    }
    targets.add(target);
    exceptions.push({ target, certificationClass, owner, expires, reason });
  }

  const missingTargets = nativeTargetMetadata
    .filter((target) => target.certificationClass === "structural")
    .map((target) => target.suffix)
    .filter((target) => !targets.has(target));
  if (missingTargets.length) {
    fail("exception-incomplete", "Structural native targets require active certification exceptions.", {
      missingTargets,
    });
  }
  return { schemaVersion: 1, exceptions };
}

export async function readNativeTargetExceptions(filePath, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch (error) {
    fail("exception-invalid", `Could not read native target exceptions ${filePath}.`, {
      filePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return validateNativeTargetExceptions(parsed, options);
}

export function validatePackageSmokeReport(value) {
  const report = requireRecord(value, "report-invalid", "Package smoke report must be an object.");
  if (report.schemaVersion !== PACKAGE_SMOKE_REPORT_SCHEMA_VERSION) {
    fail("report-invalid", `Unsupported package smoke report schemaVersion ${String(report.schemaVersion)}.`);
  }
  const mode = requireString(report.mode, "mode", "report-invalid");
  if (!["runtime", "structural", "reduced"].includes(mode)) {
    fail("report-invalid", `Unsupported package smoke mode ${mode}.`, { mode });
  }
  const target =
    report.target === null || report.target === undefined
      ? null
      : requireString(report.target, "target", "report-invalid");
  if (mode === "reduced" && target !== null) {
    fail("report-invalid", "Reduced package smoke reports must not declare a target.");
  }
  if (mode !== "reduced" && target === null) {
    fail("report-invalid", `${mode} package smoke reports must declare a target.`);
  }
  const status = requireString(report.status, "status", "report-invalid");
  if (status !== "pass" && status !== "fail") {
    fail("report-invalid", `Package smoke status must be pass or fail, received ${status}.`);
  }
  return {
    ...report,
    mode,
    target,
    status,
    manifestSha256: requireString(report.manifestSha256, "manifestSha256", "report-invalid"),
    sourceRevision: requireString(report.sourceRevision, "sourceRevision", "report-invalid"),
    rootVersion: requireVersion(report.rootVersion, "rootVersion"),
    nativeVersion: requireVersion(report.nativeVersion, "nativeVersion"),
  };
}

export async function readPackageSmokeReports(reportDirectory) {
  const entries = await fs.promises.readdir(reportDirectory, { withFileTypes: true });
  const reportFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(reportDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const reports = [];
  for (const reportFile of reportFiles) {
    let parsed;
    try {
      parsed = JSON.parse(await fs.promises.readFile(reportFile, "utf8"));
    } catch (error) {
      fail("report-invalid", `Could not read package smoke report ${reportFile}.`, {
        reportFile,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    reports.push({ file: reportFile, report: validatePackageSmokeReport(parsed) });
  }
  return reports;
}

export function validatePackageSmokeReportSet({ manifest, manifestSha256, reports, requireReduced = false }) {
  const expectedRows = manifest.files
    .filter((entry) => entry.target !== undefined)
    .map((entry) => {
      const metadata = getNativeTargetMetadata(entry.target);
      return { target: entry.target, mode: metadata.certificationClass };
    });
  if (requireReduced) expectedRows.push({ target: null, mode: "reduced" });

  const actualRows = new Map();
  for (const reportEntry of reports) {
    const report = reportEntry.report ?? reportEntry;
    const rowKey = `${report.target ?? "reduced"}\0${report.mode}`;
    if (actualRows.has(rowKey)) {
      fail("report-incomplete", `Duplicate package smoke report for ${report.target ?? "reduced"}/${report.mode}.`);
    }
    if (
      report.manifestSha256 !== manifestSha256 ||
      report.sourceRevision !== manifest.sourceRevision ||
      report.rootVersion !== manifest.rootVersion ||
      report.nativeVersion !== manifest.nativeVersion
    ) {
      fail("report-candidate-mismatch", `Package smoke report does not describe the certified release candidate.`, {
        target: report.target,
        mode: report.mode,
      });
    }
    actualRows.set(rowKey, report);
  }

  const missingRows = [];
  const failedRows = [];
  for (const expected of expectedRows) {
    const rowKey = `${expected.target ?? "reduced"}\0${expected.mode}`;
    const report = actualRows.get(rowKey);
    if (!report) {
      missingRows.push(expected);
      continue;
    }
    if (report.status !== "pass") failedRows.push({ target: expected.target, mode: expected.mode });
  }
  const expectedKeys = new Set(expectedRows.map((entry) => `${entry.target ?? "reduced"}\0${entry.mode}`));
  const unexpectedRows = [...actualRows.values()]
    .filter((report) => !expectedKeys.has(`${report.target ?? "reduced"}\0${report.mode}`))
    .map((report) => ({ target: report.target, mode: report.mode }));
  if (missingRows.length || failedRows.length || unexpectedRows.length) {
    fail("report-incomplete", "Required package smoke report rows are incomplete.", {
      missingRows,
      failedRows,
      unexpectedRows,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    manifestSha256,
    sourceRevision: manifest.sourceRevision,
    rootVersion: manifest.rootVersion,
    nativeVersion: manifest.nativeVersion,
    status: "pass",
    requiredRows: expectedRows,
  };
}

export async function writeSha256Sums(manifest, outputPath) {
  const lines = [...manifest.files]
    .sort((left, right) => left.file.localeCompare(right.file))
    .map((entry) => `${entry.sha256}  ${entry.file}`);
  await fs.promises.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export async function writeJsonFile(outputPath, value) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
