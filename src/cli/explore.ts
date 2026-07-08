import { exploreCodegraph, formatAgentExploreResponse } from "../agent/explore.js";
import type { CliAgentCommandContext } from "./context.js";
import { EXPLORE_HELP_TEXT } from "./help.js";
import { parseNonNegativeIntegerOption } from "./options.js";

export type ExploreCommandContext = CliAgentCommandContext;

export async function handleExploreCommand(context: ExploreCommandContext): Promise<void> {
  const query = context.positionals.join(" ").trim();
  if (!query) {
    context.writeStderrLine(EXPLORE_HELP_TEXT.trimEnd());
    context.exit(2);
  }

  const response = await exploreCodegraph({
    root: context.root,
    query,
    ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
    limit: parseNonNegativeIntegerOption(context.getOpt("--limit"), "--limit", 5),
    maxPackets: parseNonNegativeIntegerOption(context.getOpt("--max-packets"), "--max-packets", 3),
    maxPaths: parseNonNegativeIntegerOption(context.getOpt("--max-paths"), "--max-paths", 3),
    includeSource: !context.hasFlag("--no-source"),
  });

  if (context.hasFlag("--json") || !context.hasFlag("--pretty")) {
    context.writeJSONLine(response);
  } else {
    context.writeStdoutLine(formatAgentExploreResponse(response));
  }
}
