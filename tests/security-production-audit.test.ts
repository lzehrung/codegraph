import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createProductionAuditReport,
  parseNpmAuditOutput,
  parseProductionAuditAllowlist,
  runProductionAudit,
} from "../scripts/security/production-audit-lib.mjs";
import { formatProductionAuditSummary, runProductionAuditCli } from "../scripts/check-production-audit.mjs";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const EMPTY_ALLOWLIST = JSON.stringify({ schemaVersion: 1, exceptions: [] });
const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
type Severity = (typeof SEVERITIES)[number];
type ExceptionRow = {
  advisory: string;
  package: string;
  reason: string;
  owner: string;
  expires: string;
  trackingIssue: string;
};

function cleanAuditOutput(): string {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
      dependencies: {
        prod: 10,
        dev: 20,
        optional: 1,
        peer: 0,
        peerOptional: 0,
        total: 31,
      },
    },
  });
}

function vulnerableAuditOutput({
  advisory = "GHSA-2345-6789-ABCD",
  packageName = "vulnerable-package",
  severity = "high",
}: {
  advisory?: string;
  packageName?: string;
  severity?: Severity;
} = {}): string {
  const counts: Record<Severity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  counts[severity] = 1;
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      [packageName]: {
        name: packageName,
        severity,
        isDirect: true,
        via: [
          {
            source: 12345,
            name: packageName,
            dependency: packageName,
            title: "Synthetic production vulnerability",
            url: `https://github.com/advisories/${advisory}`,
            severity,
            range: "<2.0.0",
          },
        ],
        effects: [],
        range: "<2.0.0",
        nodes: [`node_modules/${packageName}`],
        fixAvailable: false,
      },
    },
    metadata: {
      vulnerabilities: { ...counts, total: 1 },
      dependencies: {
        prod: 1,
        dev: 0,
        optional: 0,
        peer: 0,
        peerOptional: 0,
        total: 1,
      },
    },
  });
}

function exceptionAllowlist(overrides: Partial<ExceptionRow> = {}): string {
  const exception: ExceptionRow = {
    advisory: "GHSA-2345-6789-ABCD",
    package: "vulnerable-package",
    reason: "The affected path is not reachable in production.",
    owner: "security-owner",
    expires: "2026-08-01",
    trackingIssue: "https://github.com/lzehrung/codegraph/issues/999",
    ...overrides,
  };
  return JSON.stringify({ schemaVersion: 1, exceptions: [exception] });
}

describe("production audit parser", () => {
  it("parses npm audit v2 advisories into stable vulnerability identities", () => {
    const parsed = parseNpmAuditOutput(vulnerableAuditOutput());

    expect(parsed.auditReportVersion).toBe(2);
    expect(parsed.vulnerabilities).toEqual([
      {
        advisory: "GHSA-2345-6789-ABCD",
        package: "vulnerable-package",
        severity: "high",
        title: "Synthetic production vulnerability",
        url: "https://github.com/advisories/GHSA-2345-6789-ABCD",
        range: "<2.0.0",
        source: "12345",
        isDirect: true,
      },
    ]);
  });

  it.each(SEVERITIES)("rejects an unexcepted %s advisory", (severity) => {
    const report = createProductionAuditReport({
      auditOutput: vulnerableAuditOutput({ severity }),
      auditExitCode: 1,
      allowlistInput: EMPTY_ALLOWLIST,
      now: NOW,
    });

    expect(report.status).toBe("fail");
    expect(report.rejectedVulnerabilities).toHaveLength(1);
    expect(report.rejectedVulnerabilities[0]?.severity).toBe(severity);
    expect(report.summary.severities[severity]).toBe(1);
  });

  it("fails closed on malformed npm audit JSON", () => {
    const report = createProductionAuditReport({
      auditOutput: "{ definitely-not-json",
      auditExitCode: 1,
      allowlistInput: EMPTY_ALLOWLIST,
      now: NOW,
    });

    expect(report.status).toBe("fail");
    expect(report.errors).toEqual([expect.objectContaining({ code: "MALFORMED_AUDIT_JSON" })]);
    expect(report.acceptedExceptions).toEqual([]);
    expect(report.rejectedVulnerabilities).toEqual([]);
  });

  it("classifies npm audit endpoint error JSON as a command failure", () => {
    const report = createProductionAuditReport({
      auditOutput: JSON.stringify({
        message: "request to the audit endpoint failed, reason: timeout",
        method: "POST",
        uri: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
        headers: {},
        statusCode: 504,
        body: "",
      }),
      auditExitCode: 1,
      allowlistInput: EMPTY_ALLOWLIST,
      now: NOW,
    });

    expect(report.status).toBe("fail");
    expect(report.errors).toEqual([
      expect.objectContaining({
        code: "NPM_AUDIT_COMMAND_FAILED",
        message: "HTTP 504: request to the audit endpoint failed, reason: timeout",
      }),
    ]);
    expect(report.rejectedVulnerabilities).toEqual([]);
  });

  it("includes the received npm audit report version in schema errors", () => {
    const report = createProductionAuditReport({
      auditOutput: JSON.stringify({ auditReportVersion: 3, vulnerabilities: {}, metadata: {} }),
      auditExitCode: 0,
      allowlistInput: EMPTY_ALLOWLIST,
      now: NOW,
    });

    expect(report.status).toBe("fail");
    expect(report.errors).toEqual([
      expect.objectContaining({
        code: "INVALID_AUDIT_REPORT",
        message: expect.stringContaining("got 3"),
      }),
    ]);
  });

  it("normalizes npm exit 1 when every reported advisory has an active exception", () => {
    const report = createProductionAuditReport({
      auditOutput: vulnerableAuditOutput(),
      auditExitCode: 1,
      allowlistInput: exceptionAllowlist(),
      now: NOW,
    });

    expect(report.status).toBe("pass");
    expect(report.errors).toEqual([]);
    expect(report.acceptedExceptions).toEqual([
      expect.objectContaining({
        advisory: "GHSA-2345-6789-ABCD",
        package: "vulnerable-package",
        owner: "security-owner",
      }),
    ]);
    expect(report.rejectedVulnerabilities).toEqual([]);
  });

  it("rejects an expired exception", () => {
    const report = createProductionAuditReport({
      auditOutput: vulnerableAuditOutput(),
      auditExitCode: 1,
      allowlistInput: exceptionAllowlist({ expires: "2026-07-26" }),
      now: NOW,
    });

    expect(report.status).toBe("fail");
    expect(report.errors).toEqual([
      expect.objectContaining({ code: "INVALID_ALLOWLIST", message: expect.stringContaining("expired") }),
    ]);
    expect(report.acceptedExceptions).toEqual([]);
    expect(report.rejectedVulnerabilities).toHaveLength(1);
  });

  it("rejects incomplete and wildcard exception rows", () => {
    const incomplete = JSON.stringify({
      schemaVersion: 1,
      exceptions: [
        {
          advisory: "GHSA-2345-6789-abcd",
          package: "vulnerable-package",
          reason: "Temporary exception",
          expires: "2026-08-01",
          trackingIssue: "https://github.com/lzehrung/codegraph/issues/999",
        },
      ],
    });
    const incompleteReport = createProductionAuditReport({
      auditOutput: vulnerableAuditOutput(),
      auditExitCode: 1,
      allowlistInput: incomplete,
      now: NOW,
    });
    const wildcardReport = createProductionAuditReport({
      auditOutput: vulnerableAuditOutput(),
      auditExitCode: 1,
      allowlistInput: exceptionAllowlist({ advisory: "GHSA-*" }),
      now: NOW,
    });

    expect(incompleteReport.status).toBe("fail");
    expect(incompleteReport.errors[0]?.message).toContain("owner");
    expect(wildcardReport.status).toBe("fail");
    expect(wildcardReport.errors[0]?.message).toContain("wildcard");
  });

  it.each([
    ["advisory", { advisory: "GHSA-aaaa-bbbb-cccc" }],
    ["package", { package: "another-package" }],
  ])("requires an exact %s match", (_field, overrides) => {
    const report = createProductionAuditReport({
      auditOutput: vulnerableAuditOutput(),
      auditExitCode: 1,
      allowlistInput: exceptionAllowlist(overrides),
      now: NOW,
    });

    expect(report.status).toBe("fail");
    expect(report.acceptedExceptions).toEqual([]);
    expect(report.rejectedVulnerabilities).toHaveLength(1);
  });

  it("passes an empty production audit", () => {
    const report = createProductionAuditReport({
      auditOutput: cleanAuditOutput(),
      auditExitCode: 0,
      allowlistInput: EMPTY_ALLOWLIST,
      now: NOW,
    });

    expect(report).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        status: "pass",
        acceptedExceptions: [],
        rejectedVulnerabilities: [],
        errors: [],
      }),
    );
    expect(report.summary.totalVulnerabilities).toBe(0);
  });

  it("validates the checked-in empty allowlist", () => {
    const allowlistPath = path.resolve(import.meta.dirname, "../scripts/security/production-audit-allowlist.json");
    const allowlist = parseProductionAuditAllowlist(readFileSync(allowlistPath, "utf8"), {
      now: NOW,
    });

    expect(allowlist).toEqual({ schemaVersion: 1, exceptions: [] });
  });
});

describe("production audit command", () => {
  it("runs npm audit with production dependencies only without a live registry in the test", () => {
    const spawnSyncImpl = vi.fn().mockReturnValue({
      status: 0,
      stdout: cleanAuditOutput(),
      stderr: "",
    });
    const readFileSyncImpl = vi.fn().mockReturnValue(EMPTY_ALLOWLIST);

    const report = runProductionAudit({
      cwd: "/synthetic/project",
      platform: "linux",
      spawnSyncImpl,
      readFileSyncImpl,
      now: NOW,
    });

    expect(report.status).toBe("pass");
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "npm",
      ["audit", "--omit=dev", "--json"],
      expect.objectContaining({
        cwd: "/synthetic/project",
        encoding: "utf8",
        shell: false,
      }),
    );
  });

  it("uses cmd.exe directly for npm audit on Windows", () => {
    const spawnSyncImpl = vi.fn().mockReturnValue({
      status: 0,
      stdout: cleanAuditOutput(),
      stderr: "",
    });

    const report = runProductionAudit({
      platform: "win32",
      spawnSyncImpl,
      readFileSyncImpl: vi.fn().mockReturnValue(EMPTY_ALLOWLIST),
      now: NOW,
    });

    expect(report.status).toBe("pass");
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", "npm audit --omit=dev --json"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("retries a transient npm audit endpoint error and then passes", () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stdout: JSON.stringify({
          message: "request to the audit endpoint failed, reason: timeout",
          method: "POST",
          uri: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
          statusCode: 504,
        }),
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: cleanAuditOutput(),
        stderr: "",
      });
    const sleepImpl = vi.fn();

    const report = runProductionAudit({
      platform: "linux",
      spawnSyncImpl,
      readFileSyncImpl: vi.fn().mockReturnValue(EMPTY_ALLOWLIST),
      sleepImpl,
      now: NOW,
    });

    expect(report.status).toBe("pass");
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unexcepted production advisory", () => {
    const spawnSyncImpl = vi.fn().mockReturnValue({
      status: 1,
      stdout: vulnerableAuditOutput(),
      stderr: "",
    });
    const sleepImpl = vi.fn();

    const report = runProductionAudit({
      platform: "linux",
      spawnSyncImpl,
      readFileSyncImpl: vi.fn().mockReturnValue(EMPTY_ALLOWLIST),
      sleepImpl,
      now: NOW,
    });

    expect(report.status).toBe("fail");
    expect(report.rejectedVulnerabilities).toHaveLength(1);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("prints machine-readable JSON and returns the report status", () => {
    const report = createProductionAuditReport({
      auditOutput: cleanAuditOutput(),
      auditExitCode: 0,
      allowlistInput: EMPTY_ALLOWLIST,
      now: NOW,
    });
    const output: string[] = [];

    const exitCode = runProductionAuditCli({
      argv: ["--json"],
      runProductionAuditImpl: () => report,
      writeStdout: (text: string) => output.push(text),
      writeStderr: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toEqual(report);
  });

  it("prints a concise failing summary and exits nonzero", () => {
    const report = createProductionAuditReport({
      auditOutput: vulnerableAuditOutput({ severity: "critical" }),
      auditExitCode: 1,
      allowlistInput: EMPTY_ALLOWLIST,
      now: NOW,
    });
    const output: string[] = [];

    const exitCode = runProductionAuditCli({
      argv: [],
      runProductionAuditImpl: () => report,
      writeStdout: (text: string) => output.push(text),
      writeStderr: vi.fn(),
    });

    expect(exitCode).toBe(1);
    expect(output.join("")).toContain("1 unexcepted advisory (critical: 1)");
    expect(formatProductionAuditSummary(report)).toContain("Production audit failed");
  });
});
