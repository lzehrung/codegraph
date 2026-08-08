import { findCallees, findCallers, type CallHierarchyResponse } from "../agent/callHierarchy.js";
import type { SemanticLocation, SemanticSymbol } from "../agent/semantic.js";
import { exitWithError, type CliAgentCommandContext } from "./context.js";
import { CALLEES_HELP_TEXT, CALLERS_HELP_TEXT } from "./help.js";
import { parseBoundedIntegerOption } from "./options.js";

export type CallHierarchyCommandContext = CliAgentCommandContext;

const DEFAULT_CALL_HIERARCHY_DEPTH = 1;
const MAX_CALL_HIERARCHY_DEPTH = 5;
const DEFAULT_CALL_HIERARCHY_LIMIT = 100;
const MAX_CALL_HIERARCHY_LIMIT = 500;

type CallHierarchyCommand = "callers" | "callees";

export async function handleCallHierarchyCommand(
  command: CallHierarchyCommand,
  context: CallHierarchyCommandContext,
): Promise<void> {
  const handle = context.positionals[0]?.trim();
  if (!handle) {
    context.writeStderrLine(helpText(command).trimEnd());
    context.exit(2);
  }

  try {
    const depth = parseBoundedIntegerOption(
      context.getOpt("--depth"),
      "--depth",
      DEFAULT_CALL_HIERARCHY_DEPTH,
      1,
      MAX_CALL_HIERARCHY_DEPTH,
    );
    const limit = parseBoundedIntegerOption(
      context.getOpt("--limit"),
      "--limit",
      DEFAULT_CALL_HIERARCHY_LIMIT,
      0,
      MAX_CALL_HIERARCHY_LIMIT,
    );
    const request = {
      root: context.root,
      handle,
      ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
      depth,
      limit,
      includeHeuristic: context.hasFlag("--include-heuristic"),
    };
    const response = command === "callers" ? await findCallers(request) : await findCallees(request);
    if (context.hasFlag("--json")) {
      context.writeJSONLine(response);
      return;
    }
    context.writeStdoutLine(formatCallHierarchyResponse(response));
  } catch (error: unknown) {
    exitWithError(context, error, 1);
  }
}

function formatCallHierarchyResponse(response: CallHierarchyResponse): string {
  const label = response.direction === "incoming" ? "Callers" : "Callees";
  const lines = [`Target: ${formatSymbol(response.target)}`, `${label}: ${response.entries.length}`];
  for (const entry of response.entries) {
    lines.push(`${entry.depth}. ${formatSymbol(entry.symbol)}`);
    for (const callsite of entry.callsites) lines.push(`   ${formatCallsite(callsite)}`);
  }
  appendOmitted(lines, "symbols", response.omittedCounts.symbols);
  appendOmitted(lines, "callsites", response.omittedCounts.callsites);
  appendOmitted(lines, "unresolved sites", response.omittedCounts.unresolvedSites);
  return lines.join("\n");
}

function formatSymbol(symbol: SemanticSymbol): string {
  const { file, range } = symbol.location;
  return `${symbol.name} [${symbol.kind}] ${file}:${range.start.line}:${range.start.column}`;
}

function formatCallsite(callsite: SemanticLocation): string {
  const { file, range } = callsite;
  return `${file}:${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`;
}

function appendOmitted(lines: string[], label: string, omitted: number | undefined): void {
  if (omitted) lines.push(`Omitted ${label}: ${omitted}`);
}

function helpText(command: CallHierarchyCommand): string {
  return command === "callers" ? CALLERS_HELP_TEXT : CALLEES_HELP_TEXT;
}
