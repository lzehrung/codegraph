import fs from "node:fs";
import {
  PackageCertificationError,
  computeFileSha256,
  readNativeTargetExceptions,
  readPackageSmokeReports,
  readReleaseCandidateManifest,
  validatePackageSmokeReportSet,
} from "./package-contract-lib.mjs";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonSection(filePath, sectionName) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch (error) {
    throw new PackageCertificationError("certification-section-invalid", `Could not read ${sectionName} report.`, {
      section: sectionName,
      filePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function sectionStatus(section) {
  if (!isRecord(section)) return null;
  if (typeof section.status === "string") return section.status;
  if (isRecord(section.summary) && typeof section.summary.status === "string") return section.summary.status;
  return null;
}

function requireSectionSchema(section, sectionName) {
  if (!isRecord(section) || section.schemaVersion !== 1) {
    throw new PackageCertificationError(
      "certification-section-invalid",
      `${sectionName} report must be an object with schemaVersion 1.`,
      { section: sectionName },
    );
  }
  return section;
}

function requirePassingSection(section, sectionName) {
  const report = requireSectionSchema(section, sectionName);
  const status = sectionStatus(report);
  if (status !== "pass") {
    throw new PackageCertificationError(
      status === "fail" ? "certification-section-failed" : "certification-section-incomplete",
      `${sectionName} certification status is ${status ?? "unexecuted"}.`,
      { section: sectionName, status },
    );
  }
  return report;
}

function requireCompleteTests(section) {
  const report = requireSectionSchema(section, "tests");
  if (!isRecord(report.package) || report.package.name !== "@lzehrung/codegraph") {
    throw new PackageCertificationError(
      "certification-section-invalid",
      "Release test certification must record the root package identity.",
      { section: "tests" },
    );
  }
  if (typeof report.revision !== "string" || !report.revision) {
    throw new PackageCertificationError(
      "certification-section-invalid",
      "Release test certification must record the source revision under test.",
      { section: "tests" },
    );
  }
  if (typeof report.command !== "string" || !report.command) {
    throw new PackageCertificationError(
      "certification-section-invalid",
      "Release test certification must record the command that was executed.",
      { section: "tests" },
    );
  }
  const status = sectionStatus(report);
  if (status !== "pass") {
    throw new PackageCertificationError("certification-section-invalid", `Release test suite status is ${status}.`, {
      section: "tests",
      status,
    });
  }
  return report;
}

function failureFromError(error, fallbackCode, section) {
  if (error instanceof PackageCertificationError) {
    return { code: error.code, message: error.message, context: { section, ...error.context } };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    context: { section },
  };
}

async function captureSection({ name, filePath, validate, failures }) {
  let section;
  try {
    section = await readJsonSection(filePath, name);
  } catch (error) {
    failures.push(failureFromError(error, "certification-section-invalid", name));
    return { schemaVersion: 1, status: "incomplete" };
  }
  try {
    return validate(section);
  } catch (error) {
    failures.push(failureFromError(error, "certification-section-invalid", name));
    return section;
  }
}

export async function assembleCertificationReport(options) {
  const failures = [];
  let manifest;
  let manifestSha256 = "unavailable";
  try {
    manifest = await readReleaseCandidateManifest(options.manifestPath, {
      verifyFiles: true,
      expectedTargets: options.expectedTargets,
    });
    manifestSha256 = await computeFileSha256(options.manifestPath);
    if (manifest.sourceRevision !== options.revision) {
      throw new PackageCertificationError(
        "candidate-identity-mismatch",
        "Certification source revision does not match the release candidate manifest.",
        { expected: options.revision, actual: manifest.sourceRevision },
      );
    }
  } catch (error) {
    failures.push(failureFromError(error, "manifest-invalid", "releaseCandidate"));
  }

  try {
    await readNativeTargetExceptions(options.exceptionsPath);
  } catch (error) {
    failures.push(failureFromError(error, "exception-invalid", "packages"));
  }

  const security = await captureSection({
    name: "security",
    filePath: options.securityPath,
    validate: (section) => requirePassingSection(section, "security"),
    failures,
  });
  const tests = await captureSection({
    name: "tests",
    filePath: options.testsPath,
    validate: requireCompleteTests,
    failures,
  });
  const hermeticity = await captureSection({
    name: "hermeticity",
    filePath: options.hermeticityPath,
    validate: (section) => requirePassingSection(section, "hermeticity"),
    failures,
  });
  if (
    manifest &&
    (!isRecord(tests.package) ||
      tests.package.name !== "@lzehrung/codegraph" ||
      tests.package.version !== manifest.rootVersion ||
      tests.revision !== manifest.sourceRevision)
  ) {
    failures.push({
      code: "report-candidate-mismatch",
      message: "Test certification does not describe the release candidate revision.",
      context: { section: "tests" },
    });
  }
  if (isRecord(security) && security.status === "fail") {
    const errors = Array.isArray(security.errors) ? security.errors : [];
    const rejected = Array.isArray(security.rejectedVulnerabilities) ? security.rejectedVulnerabilities : [];
    for (const error of errors) {
      failures.push({
        code: "security-audit-error",
        message: isRecord(error) && typeof error.message === "string" ? error.message : "Production audit failed.",
        context: { section: "security", error },
      });
    }
    for (const vulnerability of rejected) {
      failures.push({
        code: "security-vulnerability-rejected",
        message: "Production vulnerability is not covered by an active exception.",
        context: { section: "security", vulnerability },
      });
    }
  }
  if (isRecord(hermeticity) && hermeticity.status === "fail") {
    const violations = Array.isArray(hermeticity.violations) ? hermeticity.violations : [];
    for (const violation of violations) {
      failures.push({
        code: "hermeticity-violation",
        message:
          isRecord(violation) && typeof violation.message === "string"
            ? violation.message
            : "Fixture hermeticity check failed.",
        context: { section: "hermeticity", violation },
      });
    }
  }

  let packages = [];
  if (manifest) {
    try {
      const reportEntries = await readPackageSmokeReports(options.packageReportDirectory);
      validatePackageSmokeReportSet({
        manifest,
        manifestSha256,
        reports: reportEntries,
        requireReduced: true,
      });
      packages = reportEntries.map((entry) => entry.report);
    } catch (error) {
      failures.push(failureFromError(error, "report-incomplete", "packages"));
    }
  } else {
    failures.push({
      code: "certification-section-incomplete",
      message: "Package certification cannot be validated without a release candidate manifest.",
      context: { section: "packages" },
    });
  }

  const hasIncompleteFailure = failures.some((failure) =>
    [
      "certification-section-incomplete",
      "certification-section-invalid",
      "manifest-invalid",
      "manifest-incomplete",
      "report-incomplete",
      "exception-incomplete",
    ].includes(failure.code),
  );
  let summaryStatus = "pass";
  if (failures.length) {
    summaryStatus = hasIncompleteFailure ? "incomplete" : "fail";
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      repository: options.repository,
      revision: options.revision,
      dirty: false,
    },
    versions: {
      root: manifest?.rootVersion ?? "0.0.0",
      native: manifest?.nativeVersion ?? "0.0.0",
      node: process.version,
      ...(options.rustVersion ? { rust: options.rustVersion } : {}),
    },
    security,
    packages,
    tests,
    hermeticity,
    summary: {
      status: summaryStatus,
      failures,
    },
  };
  return report;
}
