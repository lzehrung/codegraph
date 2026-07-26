import { astGrep, textGrep } from "../graphs/grep.js";
import { type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import type {
  CliJsonWriterContext,
  CliOptionContext,
  CliStderrExitContext,
  CliStdoutWriterContext,
} from "./context.js";
import { parseOptionalPositiveIntegerOption } from "./options.js";
import { writeCliOutput } from "./pretty.js";

export type GrepCommandContext = CliOptionContext &
  CliJsonWriterContext &
  CliStdoutWriterContext &
  CliStderrExitContext & {
    positionals: string[];
    projectRootFs: string;
    discoveryOptions: ProjectFileDiscoveryOptions;
    parsedOptions: ReadonlyMap<string, readonly string[]>;
  };

export async function handleGrepCommand(context: GrepCommandContext): Promise<void> {
  const querySource = context.getOpt("--query");
  const positionalPattern = context.positionals.join(" ").trim();
  const patternSource = context.getOpt("--pattern") ?? context.getOpt("--regex") ?? (positionalPattern || undefined);
  const globs = context.parsedOptions.get("--glob") ?? [];
  const patterns = globs.length ? [...globs] : undefined;

  if ((querySource ? 1 : 0) + (patternSource ? 1 : 0) !== 1) {
    context.writeStderrLine("Usage: grep <regex> [--root <dir>] OR grep --query '<tree-sitter query>' [--root <dir>]");
    context.exit(2);
  }

  if (querySource) {
    const hits = await astGrep(context.projectRootFs, querySource, patterns, context.discoveryOptions);
    writeCliOutput(context, hits);
    return;
  }

  const ignoreCase = context.hasFlag("--ignore-case") || context.hasFlag("-i");
  const maxHitsRaw = context.getOpt("--max-hits");
  const maxHits = parseOptionalPositiveIntegerOption(maxHitsRaw, "--max-hits");
  const hits = await textGrep(context.projectRootFs, patternSource!, patterns, {
    ignoreCase,
    ...(maxHits !== undefined ? { maxHits } : {}),
    ...context.discoveryOptions,
  });
  writeCliOutput(context, hits);
}
