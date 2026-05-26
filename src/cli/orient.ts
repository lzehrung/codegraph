import { orientCodegraph, type AgentOrientBudget, type AgentOrientResponse } from "../agent/orient.js";
import type { CliAgentCommandContext } from "./context.js";

export type OrientCommandContext = CliAgentCommandContext;

function parseAgentOrientBudget(rawValue: string | undefined): AgentOrientBudget {
  if (rawValue === undefined) return "small";
  if (rawValue === "small" || rawValue === "medium" || rawValue === "large") {
    return rawValue;
  }
  throw new Error(`Invalid --budget value "${rawValue}". Expected small, medium, or large.`);
}

export async function handleOrientCommand(context: OrientCommandContext): Promise<void> {
  const response = await orientCodegraph({
    root: context.root,
    includeRoots: context.positionals,
    budget: parseAgentOrientBudget(context.getOpt("--budget")),
  });

  if (context.hasFlag("--json") || !context.hasFlag("--pretty")) {
    context.writeJSONLine(response);
  } else {
    context.writeStdoutLine(formatAgentOrientation(response));
  }
}

export function formatAgentOrientation(response: AgentOrientResponse): string {
  const lines: string[] = ["Summary", ...response.summary.map((entry) => `- ${entry}`), "", "Tree"];
  if (response.tree.length) {
    lines.push(...response.tree.map(formatTreeEntry));
  } else {
    lines.push("- No files in scope.");
  }

  if (response.modules.length) {
    lines.push("", "Hotspots");
    for (const module of response.modules) {
      lines.push(`- ${module.file} fan-in ${module.fanIn}, fan-out ${module.fanOut}, score ${module.score}`);
    }
  }

  lines.push("", "Recommended next");
  for (const next of response.recommendedNext) {
    lines.push(`- ${next.command}`);
  }
  return lines.join("\n");
}

function formatTreeEntry(entry: AgentOrientResponse["tree"][number]): string {
  const indent = "  ".repeat(Math.max(0, entry.depth - 1));
  return `${indent}- ${entry.path}`;
}
