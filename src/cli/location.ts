import { parseAgentSymbolHandle } from "../agent/handles.js";
import { parseSourceLocationInput, type SourceLocationInput } from "../util/sourceLocation.js";

export type CliSourceLocation = SourceLocationInput;

/** Accept a plain file, file:line[:column], or portable symbol handle. */
export function parseCliSourceLocation(value: string): CliSourceLocation {
  const symbol = parseAgentSymbolHandle(value);
  if (symbol) {
    return { file: symbol.file, line: symbol.line, column: symbol.column };
  }
  return parseSourceLocationInput(value);
}
