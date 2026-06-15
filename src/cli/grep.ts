import { astGrep, textGrep } from "../graphs/grep.js";
import { type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import type { CliJsonWriterContext, CliOptionContext, CliStderrExitContext } from "./context.js";
import { parseOptionalPositiveIntegerOption } from "./options.js";

export type GrepCommandContext = CliOptionContext &
  CliJsonWriterContext &
  CliStderrExitContext & {
    projectRootFs: string;
    discoveryOptions: ProjectFileDiscoveryOptions;
    parsedOptions: ReadonlyMap<string, readonly string[]>;
  };

export async function handleGrepCommand(context: GrepCommandContext): Promise<void> {
  const querySource = context.getOpt("--query");
  const patternSource = context.getOpt("--pattern") ?? context.getOpt("--regex");
  const globs = context.parsedOptions.get("--glob") ?? [];
  const patterns = globs.length ? [...globs] : undefined;

  if ((querySource ? 1 : 0) + (patternSource ? 1 : 0) !== 1) {
    context.writeStderrLine(
      "Usage: grep [--root <dir>] (--query '<treesitter query>' | --pattern '<regex>') [--glob '<glob>'] [--ignore-case] [--max-hits N]",
    );
    context.exit(2);
  }

  if (querySource) {
    const hits = await astGrep(context.projectRootFs, querySource, patterns, context.discoveryOptions);
    context.writeJSONLine(hits);
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
  context.writeJSONLine(hits);
}
