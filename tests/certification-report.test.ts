import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleCertificationReport } from "../scripts/certification/certification-report-lib.mjs";

const temporaryDirectories: string[] = [];

interface CertificationFixture {
  assemblyOptions: {
    manifestPath: string;
    packageReportDirectory: string;
    securityPath: string;
    testsPath: string;
    hermeticityPath: string;
    exceptionsPath: string;
    repository: string;
    revision: string;
    expectedTargets: string[];
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function certificationFixture(
  options: { securityStatus?: "pass" | "fail"; omitReduced?: boolean } = {},
): Promise<CertificationFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-certification-report-"));
  temporaryDirectories.push(root);
  const candidateDirectory = path.join(root, "release-candidates");
  const packagesDirectory = path.join(candidateDirectory, "packages");
  fs.mkdirSync(packagesDirectory, { recursive: true });
  const target = "win32-x64-msvc";
  const candidates = [
    { package: "@lzehrung/codegraph", file: "packages/root.tgz", content: "root" },
    { package: "@lzehrung/codegraph-native", file: "packages/native.tgz", content: "native" },
    {
      package: `@lzehrung/codegraph-native-${target}`,
      target,
      file: `packages/native-${target}.tgz`,
      content: "target",
    },
  ];
  for (const candidate of candidates) {
    fs.writeFileSync(path.join(candidateDirectory, candidate.file), candidate.content, "utf8");
  }
  const manifestPath = path.join(candidateDirectory, "release-candidate-manifest.json");
  writeJson(manifestPath, {
    schemaVersion: 1,
    sourceRevision: "a".repeat(40),
    rootVersion: "2.0.0",
    nativeVersion: "3.0.0",
    files: candidates.map((candidate) => ({
      package: candidate.package,
      ...(candidate.target ? { target: candidate.target } : {}),
      file: candidate.file,
      sha256: sha256(path.join(candidateDirectory, candidate.file)),
      size: fs.statSync(path.join(candidateDirectory, candidate.file)).size,
    })),
  });
  const manifestSha256 = sha256(manifestPath);
  const reportsDirectory = path.join(root, "package-reports");
  const reportBase = {
    schemaVersion: 1,
    generatedAt: "2026-07-27T00:00:00.000Z",
    manifestSha256,
    sourceRevision: "a".repeat(40),
    rootVersion: "2.0.0",
    nativeVersion: "3.0.0",
    certificationClass: "runtime",
    status: "pass",
    checks: [],
    packageIdentities: [],
  };
  writeJson(path.join(reportsDirectory, `package-smoke-${target}.json`), {
    ...reportBase,
    target,
    mode: "runtime",
  });
  if (!options.omitReduced) {
    writeJson(path.join(reportsDirectory, "package-smoke-reduced.json"), {
      ...reportBase,
      target: null,
      mode: "reduced",
      certificationClass: "reduced",
    });
  }
  const securityPath = path.join(root, "security.json");
  writeJson(securityPath, {
    schemaVersion: 1,
    status: options.securityStatus ?? "pass",
    errors: options.securityStatus === "fail" ? [{ code: "audit-failed", message: "audit failed" }] : [],
    rejectedVulnerabilities: [],
  });
  const testsPath = path.join(root, "tests.json");
  writeJson(testsPath, {
    schemaVersion: 1,
    revision: "a".repeat(40),
    package: { name: "@lzehrung/codegraph", version: "2.0.0" },
    command: "npm run test:all",
    status: "pass",
  });
  const hermeticityPath = path.join(root, "hermeticity.json");
  writeJson(hermeticityPath, { schemaVersion: 1, status: "pass", fixtureRoots: [], violations: [] });
  const exceptionsPath = path.join(root, "exceptions.json");
  writeJson(exceptionsPath, {
    schemaVersion: 1,
    exceptions: [
      {
        target: "win32-arm64-msvc",
        certificationClass: "structural",
        owner: "@release-owner",
        expires: "2027-01-31",
        reason: "No matching runtime host is available.",
      },
    ],
  });
  return {
    assemblyOptions: {
      manifestPath,
      packageReportDirectory: reportsDirectory,
      securityPath,
      testsPath,
      hermeticityPath,
      exceptionsPath,
      repository: "https://github.com/lzehrung/codegraph",
      revision: "a".repeat(40),
      expectedTargets: [target],
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("CertificationReportV1 assembly", () => {
  it("merges all required passing sections into the plan envelope", async () => {
    const fixture = await certificationFixture();
    const report = await assembleCertificationReport(fixture.assemblyOptions);

    expect(Object.keys(report).sort()).toEqual(
      [
        "generatedAt",
        "hermeticity",
        "packages",
        "schemaVersion",
        "security",
        "tests",
        "source",
        "summary",
        "versions",
      ].sort(),
    );
    expect(report.summary).toEqual({ status: "pass", failures: [] });
    expect(report.source).toMatchObject({ revision: "a".repeat(40), dirty: false });
    expect(report.packages).toHaveLength(2);
    expect(report.versions).toMatchObject({ root: "2.0.0", native: "3.0.0" });
  });

  it("fails closed when a required package row was not executed", async () => {
    const fixture = await certificationFixture({ omitReduced: true });
    const report = await assembleCertificationReport(fixture.assemblyOptions);

    expect(report.summary.status).toBe("incomplete");
    expect(report.summary.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "report-incomplete" })]),
    );
  });

  it("preserves a failed security section and records stable failures", async () => {
    const fixture = await certificationFixture({ securityStatus: "fail" });
    const report = await assembleCertificationReport(fixture.assemblyOptions);

    expect(report.security).toMatchObject({ status: "fail" });
    expect(report.summary.status).toBe("fail");
    expect(report.summary.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "certification-section-failed" }),
        expect.objectContaining({ code: "security-audit-error" }),
      ]),
    );
  });
});
