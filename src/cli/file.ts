import {
  DEFAULT_FILE_VIEW_BYTES,
  DEFAULT_FILE_VIEW_LINES,
  MAX_FILE_VIEW_BYTES,
  MAX_FILE_VIEW_LINES,
  formatAgentFileViewResponse,
  getCodegraphFileView,
} from "../agent/fileView.js";
import type { CliAgentCommandContext } from "./context.js";
import { FILE_HELP_TEXT } from "./help.js";
import { parseBoundedIntegerOption, parsePositiveIntegerOption } from "./options.js";

export type FileCommandContext = CliAgentCommandContext;

export async function handleFileCommand(context: FileCommandContext): Promise<void> {
  const file = context.positionals[0];
  if (file === undefined) {
    context.writeStderrLine(FILE_HELP_TEXT.trimEnd());
    context.exit(2);
  }

  try {
    const response = await getCodegraphFileView({
      root: context.root,
      file,
      ...(context.getOpt("--offset") !== undefined
        ? { offset: parsePositiveIntegerOption(context.getOpt("--offset"), "--offset", 1) }
        : {}),
      ...(context.getOpt("--limit") !== undefined
        ? {
            limit: parseBoundedIntegerOption(
              context.getOpt("--limit"),
              "--limit",
              DEFAULT_FILE_VIEW_LINES,
              1,
              MAX_FILE_VIEW_LINES,
            ),
          }
        : {}),
      ...(context.getOpt("--max-bytes") !== undefined
        ? {
            maxBytes: parseBoundedIntegerOption(
              context.getOpt("--max-bytes"),
              "--max-bytes",
              DEFAULT_FILE_VIEW_BYTES,
              1,
              MAX_FILE_VIEW_BYTES,
            ),
          }
        : {}),
      includeGraphContext: context.hasFlag("--include-graph-context"),
      allowSensitive: context.hasFlag("--allow-sensitive"),
      ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
    });

    if (context.hasFlag("--json") || !context.hasFlag("--pretty")) {
      context.writeJSONLine(response);
    } else {
      context.writeStdoutLine(formatAgentFileViewResponse(response));
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.writeStderrLine(message);
    context.exit(1);
  }
}
