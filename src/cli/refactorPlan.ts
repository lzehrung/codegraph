import { buildRefactorPlan, type RefactorPlanResponse } from "../agent/refactorPlan.js";
import type { SemanticOmittedCounts, SemanticSymbol } from "../agent/semantic.js";
import type { CliAgentCommandContext } from "./context.js";
import { REFACTOR_PLAN_HELP_TEXT } from "./help.js";
import { parseOptionalBoundedIntegerOption } from "./options.js";

export type RefactorPlanCommandContext = CliAgentCommandContext;

const MAX_REFACTOR_PLAN_LIMIT = 500;

export async function handleRefactorPlanCommand(context: RefactorPlanCommandContext): Promise<void> {
  const handle = context.positionals[0]?.trim();
  if (!handle) {
    context.writeStderrLine(REFACTOR_PLAN_HELP_TEXT.trimEnd());
    context.exit(2);
  }

  try {
    const maxReferences = parseOptionalBoundedIntegerOption(
      context.getOpt("--max-references"),
      "--max-references",
      0,
      MAX_REFACTOR_PLAN_LIMIT,
    );
    const maxCallers = parseOptionalBoundedIntegerOption(
      context.getOpt("--max-callers"),
      "--max-callers",
      0,
      MAX_REFACTOR_PLAN_LIMIT,
    );
    const maxHierarchy = parseOptionalBoundedIntegerOption(
      context.getOpt("--max-hierarchy"),
      "--max-hierarchy",
      0,
      MAX_REFACTOR_PLAN_LIMIT,
    );
    const renameTo = context.getOpt("--rename")?.trim();
    const response = await buildRefactorPlan({
      root: context.root,
      handle,
      ...(renameTo ? { renameTo } : {}),
      ...(maxReferences !== undefined ? { maxReferences } : {}),
      ...(maxCallers !== undefined ? { maxCallers } : {}),
      ...(maxHierarchy !== undefined ? { maxHierarchy } : {}),
      includeSource: context.hasFlag("--include-source"),
      ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
    });
    if (context.hasFlag("--json") || !context.hasFlag("--pretty")) {
      context.writeJSONLine(response);
      return;
    }
    context.writeStdoutLine(formatRefactorPlanResponse(response));
  } catch (error: unknown) {
    context.writeStderrLine(error instanceof Error ? error.message : String(error));
    context.exit(1);
  }
}

export function formatRefactorPlanResponse(response: RefactorPlanResponse): string {
  const lines = [`Target: ${formatSymbol(response.target)}`, `Counts: ${formatCounts(response)}`];
  if (response.rename) {
    lines.push(`Rename: ${response.target.name} -> ${response.rename.newName}`);
    lines.push(`Rename safe: ${response.rename.safe ? "yes" : "no"}`);
    lines.push(`Rename edits: ${response.rename.edits.length}`);
    lines.push(`Rename conflicts: ${response.rename.conflicts.length}`);
    lines.push(`Rename unsafe sites: ${response.rename.unsafeSites.length}`);
  }
  appendOmissions(lines, response.omittedCounts);
  if (response.sectionIssues.length) {
    lines.push("Section issues:");
    for (const issue of response.sectionIssues) {
      lines.push(`  ${issue.section} [${issue.status}]: ${issue.reason}`);
    }
  }
  if (response.followUps.length) {
    lines.push("Follow-ups:");
    for (const command of response.followUps) lines.push(`  ${command}`);
  }
  return lines.join("\n");
}

function formatSymbol(symbol: SemanticSymbol): string {
  const { file, range } = symbol.location;
  return `${symbol.name} [${symbol.kind}] ${file}:${range.start.line}:${range.start.column}`;
}

function formatCounts(response: RefactorPlanResponse): string {
  return [
    `references ${response.references.length}`,
    `callers ${response.callers.length}`,
    `callees ${response.callees.length}`,
    `supertypes ${response.supertypes.length}`,
    `subtypes ${response.subtypes.length}`,
    `implementations ${response.implementations.length}`,
    `candidate tests ${response.candidateTests.length}`,
  ].join(", ");
}

function appendOmissions(lines: string[], omittedCounts: SemanticOmittedCounts): void {
  const omitted = Object.entries(omittedCounts).filter((entry) => entry[1] > 0);
  if (!omitted.length) {
    lines.push("Omissions: none");
    return;
  }
  lines.push(`Omissions: ${omitted.map(([section, count]) => `${section} ${count}`).join(", ")}`);
}
