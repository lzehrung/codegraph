import { assertFilePathWithinRoot } from "../util/paths.js";

export type CliProjectFileInput =
  | { status: "ok"; file: string }
  | { status: "error"; reason: "outside_project_root"; error: string };

export type CliProjectFileErrorOutput = "json" | "text";

export type CliProjectFileErrorContext = {
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
};

export function resolveCliProjectFile(projectRoot: string, fileArg: string, label: string): CliProjectFileInput {
  try {
    return {
      status: "ok",
      file: assertFilePathWithinRoot(projectRoot, fileArg, label),
    };
  } catch (error) {
    return {
      status: "error",
      reason: "outside_project_root",
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
