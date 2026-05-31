import type { ArchitectureDriftFinding, ArchitectureDriftReport, ArchitectureDriftSeverity } from "./types.js";

export interface ArchitectureDriftRenderOptions {
  limit?: number;
}

function severityHeading(severity: ArchitectureDriftSeverity): string {
  if (severity === "error") return "Errors";
  if (severity === "warning") return "Warnings";
  return "Info";
}

function findingSubject(finding: ArchitectureDriftFinding): string {
  if (finding.kind === "new-cycle" || finding.kind === "resolved-cycle") {
    return (finding.files ?? []).join(" -> ");
  }
  if (finding.kind === "hotspot-jump" || finding.kind === "hotspot-drop") {
    return `${finding.file ?? finding.key} score ${finding.before ?? 0} -> ${finding.after ?? 0}`;
  }
  if (finding.kind === "public-api-addition" || finding.kind === "public-api-removal") {
    const symbol = finding.symbol;
    return symbol ? `${symbol.file}#${symbol.name}` : finding.key;
  }
  if (finding.kind === "unresolved-import" || finding.kind === "resolved-unresolved-import") {
    return `${finding.file ?? finding.key} imports ${finding.specifier ?? ""}`.trimEnd();
  }
  if (finding.kind === "duplicate-increase" || finding.kind === "duplicate-decrease") {
    return `groups ${finding.before ?? 0} -> ${finding.after ?? 0}`;
  }
  if (finding.edge) {
    return `${finding.edge.from} -> ${finding.edge.to}`;
  }
  return finding.key;
}

function pushSeveritySection(lines: string[], heading: string, findings: readonly ArchitectureDriftFinding[]): void {
  if (!findings.length) return;
  if (lines.length > 2) lines.push("");
  lines.push(heading);
  for (const finding of findings) {
    lines.push(`- ${finding.kind}: ${findingSubject(finding)}`);
  }
}

export function renderArchitectureDriftReport(
  report: ArchitectureDriftReport,
  options: ArchitectureDriftRenderOptions = {},
): string {
  const limit = options.limit ?? report.findings.length;
  const findings = report.findings.slice(0, limit);
  const lines = ["Architecture drift", ""];
  if (!findings.length) {
    lines.push("No architecture drift findings.");
  } else {
    for (const severity of ["error", "warning", "info"] as const) {
      pushSeveritySection(
        lines,
        severityHeading(severity),
        findings.filter((finding) => finding.severity === severity),
      );
    }
  }
  const omitted = report.omittedCounts.findings + Math.max(0, report.findings.length - findings.length);
  if (omitted) {
    lines.push("", `Omitted ${omitted} finding(s).`);
  }
  if (report.policy.failed) {
    lines.push("", `Policy failed: ${report.policy.failedKinds.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
