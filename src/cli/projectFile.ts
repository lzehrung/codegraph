import { resolveFilePathWithinRoot, type FilePathWithinRootResult } from "../util/paths.js";
import { parseSourceLocationInput } from "../util/sourceLocation.js";

export type CliProjectFileInput = FilePathWithinRootResult;

export type CliProjectFileErrorOutput = "json" | "text";

export type CliProjectFileErrorContext = {
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  exit: (code: number) => never;
};

export function resolveCliProjectFile(projectRoot: string, fileArg: string, label: string): CliProjectFileInput {
  const direct = resolveFilePathWithinRoot(projectRoot, fileArg, label);
  if (direct.status === "ok") return direct;
  const location = parseSourceLocationInput(fileArg);
  if (location.file === fileArg) return direct;
  return resolveFilePathWithinRoot(projectRoot, location.file, label);
}

export function writeCliProjectFileError(
  context: CliProjectFileErrorContext,
  result: Extract<CliProjectFileInput, { status: "error" }>,
  output: CliProjectFileErrorOutput = "json",
): never {
  if (output === "json") {
    context.writeJSONLine(result);
  } else {
    context.writeStdoutLine(`error: ${result.reason}: ${result.error}`);
  }
  return context.exit(1);
}
