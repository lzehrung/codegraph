import { formatWorkspaceSymbolsResponse, workspaceSymbols } from "../agent/workspaceSymbols.js";
import { SymbolKind } from "../indexer/types.js";
import { exitWithError, type CliAgentCommandContext } from "./context.js";
import { SYMBOLS_HELP_TEXT } from "./help.js";
import { parseBoundedIntegerOption } from "./options.js";

export type SymbolsCommandContext = CliAgentCommandContext;

const WORKSPACE_SYMBOL_KIND_VALUES: SymbolKind[] = Object.values(SymbolKind);
const WORKSPACE_SYMBOL_KIND_VALUE_SET: ReadonlySet<string> = new Set(WORKSPACE_SYMBOL_KIND_VALUES);

function isWorkspaceSymbolKind(value: string): value is SymbolKind {
  return WORKSPACE_SYMBOL_KIND_VALUE_SET.has(value);
}

function parseWorkspaceSymbolKinds(rawValue: string | undefined): SymbolKind[] | undefined {
  if (rawValue === undefined) return undefined;
  const values = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.length || values.some((value) => !isWorkspaceSymbolKind(value))) {
    throw new Error(
      `Invalid --kind value "${rawValue}". Expected a comma-separated list of: ${WORKSPACE_SYMBOL_KIND_VALUES.join(
        ", ",
      )}.`,
    );
  }
  return values.filter(isWorkspaceSymbolKind);
}

export async function handleSymbolsCommand(context: SymbolsCommandContext): Promise<void> {
  const query = context.positionals.join(" ").trim();
  let kinds: SymbolKind[] | undefined;
  let limit: number;
  try {
    kinds = parseWorkspaceSymbolKinds(context.getOpt("--kind"));
    limit = parseBoundedIntegerOption(context.getOpt("--limit"), "--limit", 50, 0, 500);
  } catch (error: unknown) {
    exitWithError(context, error, 2);
  }
  const fileGlob = context.getOpt("--file-glob");
  if (!query && !kinds?.length && !fileGlob) {
    context.writeStderrLine(SYMBOLS_HELP_TEXT.trimEnd());
    context.exit(2);
  }

  try {
    const response = await workspaceSymbols({
      root: context.root,
      query,
      ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
      ...(kinds ? { kinds } : {}),
      ...(context.hasFlag("--exported") ? { exportedOnly: true } : {}),
      ...(context.hasFlag("--include-imports") ? { includeImports: true } : {}),
      ...(fileGlob !== undefined ? { fileGlob } : {}),
      limit,
    });

    if (context.hasFlag("--json")) {
      context.writeJSONLine(response);
    } else {
      context.writeStdoutLine(formatWorkspaceSymbolsResponse(response));
    }
  } catch (error: unknown) {
    exitWithError(context, error, 1);
  }
}
