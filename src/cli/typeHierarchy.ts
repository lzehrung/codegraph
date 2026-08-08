import {
  findImplementations,
  findSubtypes,
  findSupertypes,
  type ImplementationsResponse,
  type TypeHierarchyResponse,
} from "../agent/typeHierarchy.js";
import type { SemanticSymbol } from "../agent/semantic.js";
import { exitWithError, type CliAgentCommandContext } from "./context.js";
import { IMPLEMENTATIONS_HELP_TEXT, SUBTYPES_HELP_TEXT, SUPERTYPES_HELP_TEXT } from "./help.js";
import { parseBoundedIntegerOption } from "./options.js";

export type TypeHierarchyCommandContext = CliAgentCommandContext;

const DEFAULT_HIERARCHY_DEPTH = 1;
const MAX_HIERARCHY_DEPTH = 10;
const DEFAULT_HIERARCHY_LIMIT = 100;
const MAX_HIERARCHY_LIMIT = 500;

type HierarchyCommand = "supertypes" | "subtypes" | "implementations";

export async function handleTypeHierarchyCommand(
  command: HierarchyCommand,
  context: TypeHierarchyCommandContext,
): Promise<void> {
  const handle = context.positionals[0]?.trim();
  if (!handle) {
    context.writeStderrLine(helpText(command).trimEnd());
    context.exit(2);
  }

  try {
    const limit = parseBoundedIntegerOption(
      context.getOpt("--limit"),
      "--limit",
      DEFAULT_HIERARCHY_LIMIT,
      0,
      MAX_HIERARCHY_LIMIT,
    );
    if (command === "implementations") {
      const response = await findImplementations({
        root: context.root,
        handle,
        ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
        limit,
      });
      writeResponse(context, response, formatImplementationsResponse);
      return;
    }

    const depth = parseBoundedIntegerOption(
      context.getOpt("--depth"),
      "--depth",
      DEFAULT_HIERARCHY_DEPTH,
      1,
      MAX_HIERARCHY_DEPTH,
    );
    const request = {
      root: context.root,
      handle,
      ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
      depth,
      limit,
    };
    const response = command === "supertypes" ? await findSupertypes(request) : await findSubtypes(request);
    writeResponse(context, response, formatTypeHierarchyResponse);
  } catch (error: unknown) {
    exitWithError(context, error, 1);
  }
}

function writeResponse<T>(context: TypeHierarchyCommandContext, response: T, format: (value: T) => string): void {
  if (context.hasFlag("--json")) {
    context.writeJSONLine(response);
    return;
  }
  context.writeStdoutLine(format(response));
}

function formatTypeHierarchyResponse(response: TypeHierarchyResponse): string {
  const label = response.direction === "super" ? "Supertypes" : "Subtypes";
  const lines = [`Target: ${formatSymbol(response.target)}`, `${label}: ${response.relations.length}`];
  for (const entry of response.relations) {
    lines.push(`${entry.depth}. ${formatSymbol(entry.type)} [${entry.relation}]`);
  }
  appendOmitted(lines, response.omittedCounts.relations);
  return lines.join("\n");
}

function formatImplementationsResponse(response: ImplementationsResponse): string {
  const lines = [`Target: ${formatSymbol(response.target)}`, `Implementations: ${response.implementations.length}`];
  for (const entry of response.implementations) {
    lines.push(formatSymbol(entry.symbol));
  }
  appendOmitted(lines, response.omittedCounts.relations);
  return lines.join("\n");
}

function formatSymbol(symbol: SemanticSymbol): string {
  const { file, range } = symbol.location;
  return `${symbol.name} [${symbol.kind}] ${file}:${range.start.line}:${range.start.column}`;
}

function appendOmitted(lines: string[], omitted: number | undefined): void {
  if (omitted) lines.push(`Omitted: ${omitted}`);
}

function helpText(command: HierarchyCommand): string {
  if (command === "supertypes") return SUPERTYPES_HELP_TEXT;
  if (command === "subtypes") return SUBTYPES_HELP_TEXT;
  return IMPLEMENTATIONS_HELP_TEXT;
}
