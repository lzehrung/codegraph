import { maskPythonCommentsAndStrings } from "./comments.js";

const TYPE_CHECKING_HEADER = /^if[\t ]+(?:TYPE_CHECKING|typing\.TYPE_CHECKING)[\t ]*:/;

/** One simple statement: `[start, end)` with surrounding whitespace excluded. */
export type PythonStatement = { start: number; end: number; guarded: boolean };

/** One logical line: physical lines joined by open brackets or a trailing backslash. */
type LogicalLine = { start: number; end: number };

function isLineBreak(unit: number): boolean {
  return unit === 10 || unit === 13;
}

/** End of the physical line starting at `index`, and the start of the next one (LF, CRLF, or CR). */
function physicalLineEnd(source: string, index: number): { end: number; next: number } {
  let end = index;
  while (end < source.length && !isLineBreak(source.charCodeAt(end))) end += 1;
  if (end >= source.length) return { end, next: -1 };
  const next = source.charCodeAt(end) === 13 && source.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
  return { end, next };
}

/** Logical lines of masked source. Bracket depth and backslash continuation join physical lines. */
function logicalLines(masked: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let depth = 0;
  let logicalStart = 0;
  for (let start = 0; start !== -1; ) {
    const { end, next } = physicalLineEnd(masked, start);
    for (let index = start; index < end; index += 1) {
      const char = masked[index];
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if ((char === ")" || char === "]" || char === "}") && depth) depth -= 1;
    }
    const continued = depth > 0 || masked.slice(start, end).trimEnd().endsWith("\\");
    if (!continued || next === -1) {
      lines.push({ start: logicalStart, end });
      logicalStart = next;
    }
    start = next;
  }
  return lines;
}

/** The `;`-separated statements in `[start, end)`, trimmed of surrounding whitespace. */
function statementSpans(masked: string, start: number, end: number): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let segment = start;
  const push = (from: number, to: number): void => {
    let first = from;
    let last = to;
    while (first < last && /\s/.test(masked[first]!)) first += 1;
    while (last > first && /\s/.test(masked[last - 1]!)) last -= 1;
    if (first < last) spans.push({ start: first, end: last });
  };
  for (let index = start; index < end; index += 1) {
    const char = masked[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if ((char === ")" || char === "]" || char === "}") && depth) depth -= 1;
    else if (char === ";" && !depth) {
      push(segment, index);
      segment = index + 1;
    }
  }
  push(segment, end);
  return spans;
}

/** Keywords that open a compound statement, whose header ends at a top-level `:`. */
const COMPOUND_HEADER = /^(?:async[\t ]+)?(?:if|elif|else|while|for|with|try|except|finally|def|class)\b/;

/** Index of the `:` ending a compound header in `[start, end)`, ignoring brackets and `:=`; -1 if none. */
function compoundHeaderColon(masked: string, start: number, end: number): number {
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const char = masked[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if ((char === ")" || char === "]" || char === "}") && depth) depth -= 1;
    else if (char === ":" && !depth && masked[index + 1] !== "=") return index;
  }
  return -1;
}

function indentWidth(leading: string): number {
  let indent = 0;
  for (const char of leading) indent = char === "\t" ? indent + (8 - (indent % 8)) : indent + 1;
  return indent;
}

/**
 * Simple statements of comment- and string-masked Python source, in order, each marked when it
 * sits in an `if TYPE_CHECKING:` (or `typing.TYPE_CHECKING`) suite. Indentation is read from
 * logical lines only, so a continuation line never opens or closes a suite, and `a; b` and the
 * statements after a one-line suite header are separate statements.
 */
export function pythonStatements(masked: string): PythonStatement[] {
  const statements: PythonStatement[] = [];
  const guards: Array<{ indent: number; guarded: boolean }> = [];
  let previousIndent = -1;
  let previousOpensGuard = false;
  for (const line of logicalLines(masked)) {
    const text = masked.slice(line.start, line.end);
    const leading = /^[\t ]*/.exec(text)?.[0] ?? "";
    const content = text.slice(leading.length);
    if (!content.trim()) continue;
    const indent = indentWidth(leading);
    while (guards.length && indent <= guards[guards.length - 1]!.indent) guards.pop();
    if (previousIndent >= 0 && indent > previousIndent)
      guards.push({ indent: previousIndent, guarded: previousOpensGuard });
    const enclosingGuarded = guards.some((guard) => guard.guarded);
    const contentStart = line.start + leading.length;
    const headerEnd = COMPOUND_HEADER.test(content) ? compoundHeaderColon(masked, contentStart, line.end) : -1;
    if (headerEnd >= 0) {
      // `if c: a; b` puts every statement after the colon in that suite; a TYPE_CHECKING header guards it.
      const guardsSuite = enclosingGuarded || TYPE_CHECKING_HEADER.test(content);
      statements.push({ start: contentStart, end: headerEnd, guarded: enclosingGuarded });
      for (const span of statementSpans(masked, headerEnd + 1, line.end))
        statements.push({ ...span, guarded: guardsSuite });
      previousOpensGuard = TYPE_CHECKING_HEADER.test(content) && !masked.slice(headerEnd + 1, line.end).trim();
    } else {
      for (const span of statementSpans(masked, contentStart, line.end)) {
        statements.push({ ...span, guarded: enclosingGuarded });
      }
      previousOpensGuard = false;
    }
    previousIndent = indent;
  }
  return statements;
}

/** Source-position context shared by Python's native captures and reduced text extractors. */
export function pythonTypeCheckingContext(source: string): (statementStart: number) => boolean {
  if (!source.includes("TYPE_CHECKING")) return () => false;
  const statements = pythonStatements(maskPythonCommentsAndStrings(source));
  return (statementStart) => {
    let left = 0;
    let right = statements.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (statements[middle]!.start <= statementStart) left = middle + 1;
      else right = middle;
    }
    return left > 0 && statements[left - 1]!.guarded;
  };
}
