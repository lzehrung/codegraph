import { pathToFileURL } from "node:url";
import { runProductionAudit } from "./security/production-audit-lib.mjs";

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function formatSeverityCounts(severities) {
  const labels = [];
  for (const severity of ["critical", "high", "moderate", "low", "info"]) {
    const count = severities[severity];
    if (count) {
      labels.push(`${severity}: ${count}`);
    }
  }
  return labels.join(", ");
}

export function formatProductionAuditSummary(report) {
  const { accepted, rejected, totalVulnerabilities, severities } = report.summary;
  const severitySummary = formatSeverityCounts(severities);
  if (report.status === "pass") {
    if (!totalVulnerabilities) {
      return "Production audit passed: no production vulnerabilities found.";
    }
    return (
      `Production audit passed: ${accepted} ${plural(accepted, "advisory", "advisories")} ` +
      `covered by active exceptions (${severitySummary}).`
    );
  }

  const details = [];
  if (rejected) {
    let rejectedSummary = `${rejected} unexcepted ${plural(rejected, "advisory", "advisories")}`;
    if (severitySummary) {
      rejectedSummary += ` (${severitySummary})`;
    }
    details.push(rejectedSummary);
  }
  for (const error of report.errors) {
    details.push(`${error.code}: ${error.message}`);
  }
  if (!details.length) {
    details.push("the production audit did not pass");
  }
  return `Production audit failed: ${details.join("; ")}.`;
}

function usage() {
  return "Usage: node ./scripts/check-production-audit.mjs [--json]";
}

export function runProductionAuditCli({
  argv = process.argv.slice(2),
  runProductionAuditImpl = runProductionAudit,
  writeStdout = (text) => process.stdout.write(text),
  writeStderr = (text) => process.stderr.write(text),
} = {}) {
  const unknownArguments = argv.filter((argument) => argument !== "--json");
  if (unknownArguments.length) {
    writeStderr(`${usage()}\nUnknown argument: ${unknownArguments[0]}\n`);
    return 2;
  }

  const report = runProductionAuditImpl();
  if (argv.includes("--json")) {
    writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    writeStdout(`${formatProductionAuditSummary(report)}\n`);
  }
  return report.status === "pass" ? 0 : 1;
}

const entryPath = process.argv[1];
if (entryPath && pathToFileURL(entryPath).href === import.meta.url) {
  process.exitCode = runProductionAuditCli();
}
