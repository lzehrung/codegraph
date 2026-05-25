import { resolveFilePathWithinRoot, type FilePathWithinRootResult } from "../util/paths.js";

export type CliProjectFileInput = FilePathWithinRootResult;

export type CliProjectFileErrorOutput = "json" | "text";

export type CliProjectFileErrorContext = {
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
};

export function resolveCliProjectFile(projectRoot: string, fileArg: string, label: string): CliProjectFileInput {
  return resolveFilePathWithinRoot(projectRoot, fileArg, label);
}

export function writeCliProjectFileError(
  context: CliProjectFileErrorContext,
  result: Extract<CliProjectFileInput, { status: "error" }>,
  output: CliProjectFileErrorOutput = "json",
): void {
  if (output === "json") {
    context.writeJSONLine(result);
    return;
  }
  context.writeStdoutLine(`error: ${result.reason}: ${result.error}`);
}
