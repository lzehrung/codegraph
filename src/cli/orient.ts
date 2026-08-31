import {
  orientCodegraph,
  type AgentOrientBudget,
  type AgentOrientHealthMode,
  type AgentOrientResponse,
} from "../agent/orient.js";

import type { BuildOptions } from "../indexer/types.js";
import type { CliAgentCommandContext } from "./context.js";

export type OrientCommandContext = CliAgentCommandContext;

function parseAgentOrientBudget(rawValue: string | undefined): AgentOrientBudget {
  if (rawValue === undefined) return "small";
  if (rawValue === "small" || rawValue === "medium" || rawValue === "large") {
    return rawValue;
  }
  throw new Error(`Invalid --budget value "${rawValue}". Expected small, medium, or large.`);
}

function parseAgentOrientHealthMode(rawValue: string | undefined): AgentOrientHealthMode | undefined {
  if (rawValue === undefined) return undefined;
  if (rawValue === "skip" || rawValue === "summary" || rawValue === "full") {
    return rawValue;
  }
  throw new Error(`Invalid --health value "${rawValue}". Expected skip, summary, or full.`);
}

export async function handleOrientCommand(context: OrientCommandContext): Promise<void> {
  const healthMode = parseAgentOrientHealthMode(context.getOpt("--health"));
  const writesJson = context.hasFlag("--json");
  const buildOptions: BuildOptions = { ...(context.buildOptions ?? {}), logLevel: "silent" };
  const response = await orientCodegraph({
    root: context.root,
    includeRoots: context.positionals,
    budget: parseAgentOrientBudget(context.getOpt("--budget")),
    ...(healthMode !== undefined ? { health: healthMode } : {}),
    buildOptions,
  });

  if (writesJson) {
    context.writeJSONLine(response);
  } else {
    context.writeStdoutLine(formatAgentOrientation(response));
  }
}

export function formatAgentOrientation(response: AgentOrientResponse): string {
  const lines: string[] = ["Summary", ...response.summary.map((entry) => `- ${entry}`)];

  if (response.focus.length) {
    lines.push("", "Start here");
    for (const focus of response.focus) {
      lines.push(`- ${focus.file ?? focus.label}: ${focus.why}`);
    }
    if (response.focus.some((focus) => focus.file)) {
      lines.push("Inspect a listed path: codegraph packet get <path>");
    }
  }

  if (response.recommendedNext.length) {
    lines.push("", "Recommended next");
    for (const next of response.recommendedNext) {
      lines.push(`- ${next.command}`);
    }
  }

  lines.push("", "Tree");
  if (response.tree.length) {
    lines.push(...response.tree.map(formatTreeEntry));
  } else {
    lines.push("- No files in scope.");
  }

  if (response.omittedCounts.treeEntries || response.omittedCounts.focusTargets) {
    lines.push(
      "",
      `Omitted: ${response.omittedCounts.treeEntries} tree entries, ${response.omittedCounts.focusTargets} focus targets.`,
    );
  }
  return lines.join("\n");
}

function formatTreeEntry(entry: AgentOrientResponse["tree"][number]): string {
  const indent = "  ".repeat(Math.max(0, entry.depth - 1));
  return `${indent}- ${entry.path}`;
}
