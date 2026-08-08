import {
  DEFAULT_FILE_VIEW_BYTES,
  DEFAULT_FILE_VIEW_LINES,
  MAX_FILE_VIEW_BYTES,
  MAX_FILE_VIEW_LINES,
  formatAgentFileViewResponse,
  getCodegraphFileView,
} from "../agent/fileView.js";
import type { CliAgentCommandContext } from "./context.js";
import { errorMessage } from "../util/errors.js";
import { FILE_HELP_TEXT } from "./help.js";
import { parseSourceLocationInput } from "../util/sourceLocation.js";
import { parseBoundedIntegerOption, parsePositiveIntegerOption } from "./options.js";

export type FileCommandContext = CliAgentCommandContext;

export async function handleFileCommand(context: FileCommandContext): Promise<void> {
  const fileInput = context.positionals[0];
  if (fileInput === undefined) {
    context.writeStderrLine(FILE_HELP_TEXT.trimEnd());
    context.exit(2);
  }

  try {
    const location = parseSourceLocationInput(fileInput);
    const offset = context.getOpt("--offset");
    let resolvedOffset: number | undefined;
    if (offset !== undefined) {
      resolvedOffset = parsePositiveIntegerOption(offset, "--offset", 1);
    } else if (location.line !== undefined) {
      resolvedOffset = parsePositiveIntegerOption(String(location.line), "--offset", 1);
    }
    const response = await getCodegraphFileView({
      root: context.root,
      file: location.file,
      ...(resolvedOffset !== undefined ? { offset: resolvedOffset } : {}),
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

    if (context.hasFlag("--json")) {
      context.writeJSONLine(response);
    } else {
      context.writeStdoutLine(formatAgentFileViewResponse(response));
    }
  } catch (error: unknown) {
    const message = errorMessage(error);
    context.writeStderrLine(message);
    context.exit(1);
  }
}
