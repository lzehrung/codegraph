import { maskPythonCommentsAndStrings } from "./comments.js";

const TYPE_CHECKING_HEADER = /^if[\t ]+(?:TYPE_CHECKING|typing\.TYPE_CHECKING)[\t ]*:[\t ]*$/;

/** Source-position context shared by Python's native captures and reduced text extractors. */
export function pythonTypeCheckingContext(source: string): (statementStart: number) => boolean {
  if (!source.includes("TYPE_CHECKING")) return () => false;
  const masked = maskPythonCommentsAndStrings(source);
  const lines: Array<{ start: number; guarded: boolean }> = [];
  const guards: Array<{ indent: number; guarded: boolean }> = [];
  let previousIndent = -1;
  let previousHeader = false;
  for (let start = 0; start <= masked.length; ) {
    const end = masked.indexOf("\n", start);
    const lineEnd = end < 0 ? masked.length : end;
    const line = masked.slice(start, lineEnd);
    const leading = /^[\t ]*/.exec(line)?.[0] ?? "";
    const content = line.slice(leading.length).trim();
    if (content) {
      let indent = 0;
      for (const char of leading) indent = char === "\t" ? indent + (8 - (indent % 8)) : indent + 1;
      while (guards.length && indent <= guards[guards.length - 1]!.indent) guards.pop();
      if (previousIndent >= 0 && indent > previousIndent) {
        guards.push({ indent: previousIndent, guarded: previousHeader });
      }
      lines.push({ start, guarded: guards.some((guard) => guard.guarded) });
      previousIndent = indent;
      previousHeader = TYPE_CHECKING_HEADER.test(content);
    }
    if (end < 0) break;
    start = end + 1;
  }
  return (statementStart) => {
    // A compact native capture or a reduced text match can start after a one-line suite header.
    const lineStart = masked.lastIndexOf("\n", statementStart - 1) + 1;
    if (TYPE_CHECKING_HEADER.test(masked.slice(lineStart, statementStart).trimStart())) return true;
    let left = 0;
    let right = lines.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (lines[middle]!.start <= statementStart) left = middle + 1;
      else right = middle;
    }
    return left > 0 && lines[left - 1]!.start === lineStart && lines[left - 1]!.guarded;
  };
}
