import {
  astGrep,
  streamAstGrep,
  streamTextGrep,
  textGrepBounded,
  TEXT_GREP_MAX_HITS,
  type AstGrepHit,
  type GrepResultEnvelope,
  type TextGrepHit,
} from "../graphs/grep.js";
import { type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import type {
  CliJsonWriterContext,
  CliOptionContext,
  CliStderrExitContext,
  CliStdoutWriterContext,
} from "./context.js";
import { parseOptionalBoundedIntegerOption } from "./options.js";

export type GrepCommandContext = CliOptionContext &
  CliJsonWriterContext &
  CliStdoutWriterContext &
  CliStderrExitContext & {
    positionals: string[];
    projectRootFs: string;
    discoveryOptions: ProjectFileDiscoveryOptions;
    parsedOptions: ReadonlyMap<string, readonly string[]>;
  };

type GrepHit = AstGrepHit | TextGrepHit;

function formatGrepHit(hit: GrepHit): string {
  const label = "capture" in hit ? hit.capture : (hit.match ?? "");
  return `${hit.file}:${hit.line}:${hit.column}${label ? ` ${label}` : ""}\n  ${hit.snippet}`;
}

async function writeStreamedGrepHits(context: GrepCommandContext, hits: AsyncIterable<GrepHit>): Promise<void> {
  let wroteHit = false;
  for await (const hit of hits) {
    wroteHit = true;
    context.writeStdoutLine(formatGrepHit(hit));
  }
  if (!wroteHit) {
    context.writeStdoutLine("No matches.");
  }
}
export async function handleGrepCommand(context: GrepCommandContext): Promise<void> {
  const querySource = context.getOpt("--query");
  const positionalPattern = context.positionals.join(" ").trim();
  const patternSource = context.getOpt("--pattern") ?? context.getOpt("--regex") ?? (positionalPattern || undefined);
  const globs = context.parsedOptions.get("--glob") ?? [];
  const patterns = globs.length ? [...globs] : undefined;
  const maxHits = parseOptionalBoundedIntegerOption(
    context.getOpt("--max-hits"),
    "--max-hits",
    1,
    TEXT_GREP_MAX_HITS,
  );

  if ((querySource ? 1 : 0) + (patternSource ? 1 : 0) !== 1) {
    context.writeStderrLine("Usage: grep <regex> [--root <dir>] OR grep --query '<tree-sitter query>' [--root <dir>]");
    context.exit(2);
  }

  if (querySource && maxHits !== undefined) {
    context.writeStderrLine("--max-hits applies only to text grep patterns, not --query.");
    context.exit(2);
  }

  if (querySource) {
    if (context.hasFlag("--json")) {
      const items = await astGrep(context.projectRootFs, querySource, patterns, context.discoveryOptions);
      // astGrep has no result cap today: limit is null so it always means "the cap applied".
      const envelope: GrepResultEnvelope<AstGrepHit> = {
        items,
        limit: null,
        totalSeen: items.length,
        truncated: false,
        omitted: 0,
      };
      context.writeJSONLine(envelope);
    } else {
      await writeStreamedGrepHits(
        context,
        streamAstGrep(context.projectRootFs, querySource, patterns, context.discoveryOptions),
      );
    }
    return;
  }

  const ignoreCase = context.hasFlag("--ignore-case") || context.hasFlag("-i");
  const grepOptions = {
    ignoreCase,
    ...(maxHits !== undefined ? { maxHits } : {}),
    ...context.discoveryOptions,
  };
  if (context.hasFlag("--json")) {
    context.writeJSONLine(await textGrepBounded(context.projectRootFs, patternSource!, patterns, grepOptions));
  } else {
    await writeStreamedGrepHits(context, streamTextGrep(context.projectRootFs, patternSource!, patterns, grepOptions));
  }
}
