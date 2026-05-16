import { formatAgentSearchResponse, searchCodegraph, type AgentSearchMode } from "../agent/search.js";
import { parsePositiveIntegerOption } from "./options.js";

export type SearchCommandContext = {
  positionals: string[];
  root: string;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

function parseAgentSearchMode(rawValue: string | undefined): AgentSearchMode {
  if (rawValue === undefined) return "hybrid";
  if (
    rawValue === "hybrid" ||
    rawValue === "symbol" ||
    rawValue === "path" ||
    rawValue === "text" ||
    rawValue === "graph" ||
    rawValue === "sql"
  ) {
    return rawValue;
  }
  throw new Error(`Invalid --mode value "${rawValue}". Expected hybrid, symbol, path, text, graph, or sql.`);
}

export async function handleSearchCommand(context: SearchCommandContext): Promise<void> {
  const query = context.positionals.join(" ").trim();
  if (!query) {
    context.writeStderrLine(
      'Usage: search "<query>" [--root <path>] [--mode hybrid|symbol|path|text|graph|sql] [--limit <n>] [--json]',
    );
    context.exit(2);
  }

  const from = context.getOpt("--from");
  const depthRaw = context.getOpt("--depth");
  const response = await searchCodegraph({
    root: context.root,
    query,
    mode: parseAgentSearchMode(context.getOpt("--mode")),
    limit: parsePositiveIntegerOption(context.getOpt("--limit"), "--limit", 20),
    includeSnippets: !context.hasFlag("--no-snippets"),
    ...(from !== undefined ? { from } : {}),
    ...(depthRaw !== undefined ? { depth: parsePositiveIntegerOption(depthRaw, "--depth", 1) } : {}),
  });

  if (context.hasFlag("--json")) {
    context.writeJSONLine(response);
  } else {
    context.writeStdoutLine(formatAgentSearchResponse(response));
  }
}
