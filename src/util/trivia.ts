import {
  triviaRowFor,
  type TriviaBlockComment,
  type TriviaHeredocForm,
  type TriviaRow,
  type TriviaStringForm,
} from "./trivia-tables.js";

export type TriviaMaskOptions = {
  /** Mask string literals in addition to comments; defaults to true. */
  maskStrings?: boolean;
  /** Leave interpolation expression content unmarked (JS template holes for literal masks). */
  holes?: boolean;
};

/**
 * Builds a UTF-16-unit mask over `source` marking comments and (when `maskStrings`) string
 * literals for `languageId`'s trivia row. With `holes`, only the literal shell of an
 * interpolation is marked and the expression inside stays visible; without it, the entire
 * literal is marked. Masked content is replaced one-for-one by callers, so astral characters
 * occupy two marked units and every later offset is preserved.
 */
export function buildTriviaMask(source: string, languageId: string, options?: TriviaMaskOptions): Uint8Array {
  return buildMarkedMask(source, languageId, {
    maskStrings: options?.maskStrings ?? true,
    mode: options?.holes ? "holes" : "full",
  });
}

/** Blanks comments and string-literal bodies in place: every masked unit becomes a space, `\r`
 * and `\n` are preserved, and the output length always equals the input length. String
 * delimiters (quotes, prefixes, hash runs, heredoc introducers and terminators, Zig `\\`
 * line prefixes) stay visible so consumers can match `from "..."`-shaped regexes over the
 * masked text; only the literal body is blanked. */
export function maskTrivia(source: string, languageId: string, options?: TriviaMaskOptions): string {
  const mask = buildMarkedMask(source, languageId, {
    maskStrings: options?.maskStrings ?? true,
    mode: "render",
  });
  const chars = source.split("");
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (mask[i] && ch !== "\n" && ch !== "\r") chars[i] = " ";
  }
  return chars.join("");
}

/** Deletes comments and string literals outright (delimiters included); the output is NOT
 * offset-preserving. */
export function stripTrivia(source: string, languageId: string, options?: TriviaMaskOptions): string {
  const mask = buildMarkedMask(source, languageId, {
    maskStrings: options?.maskStrings ?? true,
    mode: "full",
  });
  let out = "";
  let index = 0;
  while (index < source.length) {
    if (mask[index]) {
      while (index < source.length && mask[index]) index += 1;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

type TriviaMarkMode = "render" | "full" | "holes";

function buildMarkedMask(
  source: string,
  languageId: string,
  options: { maskStrings: boolean; mode: TriviaMarkMode },
): Uint8Array {
  const row = triviaRowFor(languageId);
  const mask = new Uint8Array(source.length);
  const starters = rowStarters(row);
  let index = 0;
  while (index < source.length) {
    if (!starters.has(source[index] ?? "")) {
      index += 1;
      continue;
    }
    const commentEnd = commentSpanEnd(source, row, index);
    if (commentEnd !== null) {
      for (let i = index; i < commentEnd; i += 1) mask[i] = 1;
      index = commentEnd;
      continue;
    }
    // When strings stay visible (comment-only stripping), string literals are still located so
    // a quote or `//` inside a literal cannot be mistaken for code or a comment opener.
    if (!options.maskStrings) {
      const stringEnd = stringSpanEnd(source, row, index);
      if (stringEnd !== null) {
        index = stringEnd;
        continue;
      }
      index += 1;
      continue;
    }
    const construct = nextTriviaConstruct(source, row, index);
    if (!construct) {
      index += 1;
      continue;
    }
    for (const [start, end] of constructSpans(construct, options.mode)) {
      for (let i = start; i < end; i += 1) mask[i] = 1;
    }
    index = construct.end;
  }
  return mask;
}

function constructSpans(construct: TriviaConstruct, mode: TriviaMarkMode): TriviaSpan[] {
  if (construct.delimitersAreTrivia || mode === "full") return [[construct.start, construct.end]];
  if (mode === "render") return construct.renderSpans;
  return construct.maskSpans;
}

type TriviaSpan = [start: number, end: number];

const starterCache = new WeakMap<TriviaRow, Set<string>>();
const prefixRegexCache = new WeakMap<TriviaStringForm, RegExp>();
const openerRegexCache = new WeakMap<TriviaHeredocForm, RegExp>();

/** Characters that can begin a trivia span for `row`; a cheap per-position rejection filter. */
function rowStarters(row: TriviaRow): Set<string> {
  const cached = starterCache.get(row);
  if (cached) return cached;
  const starters = new Set<string>();
  for (const prefix of row.lineComments) starters.add(prefix[0] ?? "");
  for (const comment of row.blockComments) starters.add(comment.open[0] ?? "");
  for (const form of row.strings) {
    if (form.prefix) {
      for (const ch of literalCharsInRegexSource(form.prefix)) starters.add(ch);
    }
    if (form.hashes) starters.add("#");
    starters.add(form.open[0] ?? "");
  }
  if (row.heredocs) {
    for (const heredoc of row.heredocs) starters.add(heredoc.opener[0] ?? "");
  }
  if (row.percentLiterals) starters.add("%");
  if (row.zigMultiline) starters.add("\\");
  starterCache.set(row, starters);
  return starters;
}

/** Literal characters a sticky prefix regex can begin with, ignoring regex structure characters. */
function literalCharsInRegexSource(prefixSource: string): string[] {
  const bare = prefixSource.replace(/[()|[\]?]/g, "");
  return Array.from(bare.match(/[A-Za-z0-9@$'"`#\\%<>&*=~,^!;:-]/g) ?? []);
}

function prefixRegexFor(form: TriviaStringForm): RegExp {
  let regex = prefixRegexCache.get(form);
  if (!regex) {
    regex = new RegExp(form.prefix ?? "", "y");
    prefixRegexCache.set(form, regex);
  }
  return regex;
}

function openerRegexFor(heredoc: TriviaHeredocForm): RegExp {
  let regex = openerRegexCache.get(heredoc);
  if (!regex) {
    regex = new RegExp(heredoc.opener, "y");
    openerRegexCache.set(heredoc, regex);
  }
  return regex;
}

/** A trivia construct's full range plus the subspans each mask mode marks:
 * - `renderSpans`: the literal body only — delimiters stay visible in masked output.
 * - `maskSpans`: delimiters plus body, with excluded interpolation expressions visible.
 * Comments are trivia in their entirety, so both span sets cover the full range. */
type TriviaConstruct = {
  start: number;
  end: number;
  renderSpans: TriviaSpan[];
  maskSpans: TriviaSpan[];
  delimitersAreTrivia: boolean;
};

function fullRangeConstruct(start: number, end: number, delimitersAreTrivia: boolean): TriviaConstruct {
  return {
    start,
    end,
    renderSpans: [[start, end]],
    maskSpans: [[start, end]],
    delimitersAreTrivia,
  };
}

/** Finds the trivia construct starting at `index`, or null when `index` starts plain code. */
function nextTriviaConstruct(source: string, row: TriviaRow, index: number): TriviaConstruct | null {
  const commentEnd = commentSpanEnd(source, row, index);
  if (commentEnd !== null) return fullRangeConstruct(index, commentEnd, true);
  const heredocConstruct = heredocConstructAt(source, row, index);
  if (heredocConstruct !== null) return heredocConstruct;
  const stringConstruct = stringConstructAt(source, row, index);
  if (stringConstruct !== null) return stringConstruct;
  if (row.percentLiterals) {
    const percentConstruct = percentLiteralConstructAt(source, index);
    if (percentConstruct !== null) return percentConstruct;
  }
  if (row.zigMultiline && source.startsWith("\\\\", index)) {
    return zigMultilineConstruct(source, index);
  }
  return null;
}

function commentSpanEnd(source: string, row: TriviaRow, index: number): number | null {
  for (const prefix of row.lineComments) {
    if (source.startsWith(prefix, index)) return lineCommentEnd(source, index + prefix.length);
  }
  for (const comment of row.blockComments) {
    if (comment.lineStartOnly) {
      const atLineStart = index === 0 || source[index - 1] === "\n";
      if (!atLineStart || !source.startsWith(comment.open, index)) continue;
      return lineStartOnlyBlockCommentEnd(source, index + comment.open.length, comment.close);
    }
    if (!source.startsWith(comment.open, index)) continue;
    return blockCommentEnd(source, index + comment.open.length, comment, 1);
  }
  return null;
}

function lineCommentEnd(source: string, index: number): number {
  let end = index;
  while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end += 1;
  return end;
}

function blockCommentEnd(source: string, index: number, comment: TriviaBlockComment, depth: number): number {
  let cursor = index;
  let remaining = depth;
  while (cursor < source.length && remaining > 0) {
    if (comment.nested && source.startsWith(comment.open, cursor)) {
      remaining += 1;
      cursor += comment.open.length;
      continue;
    }
    if (source.startsWith(comment.close, cursor)) {
      remaining -= 1;
      cursor += comment.close.length;
      continue;
    }
    cursor += 1;
  }
  return remaining > 0 ? source.length : cursor;
}

function lineStartOnlyBlockCommentEnd(source: string, index: number, close: string): number {
  let lineStart = index;
  while (lineStart < source.length) {
    if (source.startsWith(close, lineStart)) return lineStart + close.length;
    const newline = source.indexOf("\n", lineStart);
    if (newline < 0) return source.length;
    lineStart = newline + 1;
  }
  return source.length;
}

/** Identifiers immediately before a prefixed opener mean the "prefix" belongs to a name, not to
 * a literal (`buff"..."` is not an f-string; `a <<b` is a left shift). */
function precededByIdentifier(source: string, index: number): boolean {
  if (index <= 0) return false;
  return /[\p{ID_Continue}$_]/u.test(source[index - 1] ?? "");
}

function stringSpanEnd(source: string, row: TriviaRow, index: number): number | null {
  return stringConstructAt(source, row, index)?.end ?? null;
}

function stringConstructAt(source: string, row: TriviaRow, index: number): TriviaConstruct | null {
  for (const form of row.strings) {
    const construct = quotedStringConstruct(source, row, form, index);
    if (construct !== null) return construct;
  }
  return null;
}

function quotedStringConstruct(
  source: string,
  row: TriviaRow,
  form: TriviaStringForm,
  index: number,
): TriviaConstruct | null {
  let cursor = index;
  if (form.prefix) {
    const prefixRe = prefixRegexFor(form);
    prefixRe.lastIndex = cursor;
    if (!prefixRe.exec(source)) return null;
    cursor = prefixRe.lastIndex;
    if (precededByIdentifier(source, index)) return null;
  }
  let hashCount = 0;
  if (form.hashes) {
    while (source[cursor] === "#") {
      hashCount += 1;
      cursor += 1;
    }
    if (precededByIdentifier(source, index)) return null;
    if (!source.startsWith(form.open, cursor)) return null;
  } else if (form.charLike) {
    const charEnd = charLiteralEnd(source, cursor, form);
    if (charEnd === null) return null;
    // The quotes are delimiters; only the character between them is masked.
    const body: TriviaSpan = [cursor + 1, charEnd - 1];
    return {
      start: index,
      end: charEnd,
      renderSpans: body[0] < body[1] ? [body] : [],
      maskSpans: [[index, charEnd]],
      delimitersAreTrivia: false,
    };
  } else if (form.quoteRun) {
    let run = 0;
    while (source[cursor + run] === form.open[0]) run += 1;
    if (run < form.open.length) return null;
    const scanned = quoteRunStringEnd(source, cursor + run, form.open[0] ?? '"', run);
    const bodyStart = cursor + run;
    const body: TriviaSpan = [bodyStart, scanned.closeStart];
    return {
      start: index,
      end: scanned.end,
      renderSpans: body[0] < body[1] ? [body] : [],
      maskSpans: [[index, scanned.end]],
      delimitersAreTrivia: false,
    };
  } else {
    if (!source.startsWith(form.open, cursor)) return null;
  }
  const bodyStart = cursor + form.open.length;
  const body = collectQuotedBody(source, row, form, bodyStart, form.close, hashCount);
  return {
    start: index,
    end: body.end,
    renderSpans: bodyStart < body.closeStart ? [[bodyStart, body.closeStart]] : [],
    maskSpans: [[index, bodyStart], ...body.segments, [body.closeStart, body.end]],
    delimitersAreTrivia: false,
  };
}

/** Walks a literal body and returns the index just past the close delimiter plus the body
 * segments a span mask marks. Excluded interpolation expressions stay unmasked; the close
 * delimiter itself is never part of the segments. */
function collectQuotedBody(
  source: string,
  row: TriviaRow,
  form: TriviaStringForm,
  start: number,
  close: string,
  hashCount: number,
): { end: number; closeStart: number; segments: TriviaSpan[] } {
  const segments: TriviaSpan[] = [];
  let cursor = start;
  let segmentStart = start;
  const pushSegment = (upTo: number): void => {
    if (segmentStart < upTo) segments.push([segmentStart, upTo]);
  };
  while (cursor < source.length) {
    const ch = source[cursor];
    // Interpolation is checked before escapes: Swift's `\(` starts interpolation, not an escape.
    if (form.interpolation) {
      const interpolation = form.interpolation;
      const doubled =
        interpolation.doubled &&
        source.startsWith(interpolation.start, cursor) &&
        source.startsWith(interpolation.start, cursor + interpolation.start.length);
      if (doubled) {
        cursor += interpolation.start.length * 2;
        continue;
      }
      if (source.startsWith(interpolation.start, cursor)) {
        if (interpolation.excludeFromMask) {
          pushSegment(cursor);
          const inner = collectInterpolationSpans(source, row, cursor, interpolation);
          cursor = inner.end;
          segmentStart = cursor;
          continue;
        }
        cursor = interpolationEnd(source, row, cursor, interpolation);
        continue;
      }
    }
    if (form.escape && ch === form.escape) {
      cursor += 2;
      continue;
    }
    if (form.doubled && source.startsWith(close, cursor) && source.startsWith(close, cursor + close.length)) {
      cursor += close.length * 2;
      continue;
    }
    if (source.startsWith(close, cursor)) {
      let closeEnd = cursor + close.length;
      if (hashCount > 0) {
        let hashes = 0;
        while (source[closeEnd + hashes] === "#") hashes += 1;
        if (hashes < hashCount) {
          cursor += 1;
          continue;
        }
        closeEnd += hashCount;
      }
      if (form.closeAloneOnLine && !closeAloneOnItsLine(source, cursor)) {
        cursor += 1;
        continue;
      }
      pushSegment(cursor);
      return { end: closeEnd, closeStart: cursor, segments };
    }
    cursor += 1;
  }
  pushSegment(source.length);
  return { end: source.length, closeStart: source.length, segments };
}

/** Rust character literals only: a lifetime like `'a` is not a literal and stays visible. */
function charLiteralEnd(source: string, quoteIndex: number, form: TriviaStringForm): number | null {
  let cursor = quoteIndex + 1;
  if (cursor >= source.length) return null;
  if (source[cursor] === form.escape) {
    while (cursor < source.length && source[cursor] !== "'") {
      cursor += source[cursor] === "\\" ? 2 : 1;
    }
    return cursor < source.length ? cursor + 1 : cursor;
  }
  if (source[cursor + 1] === "'") return cursor + 2;
  return null;
}

function quoteRunStringEnd(
  source: string,
  index: number,
  quote: string,
  runLength: number,
): { end: number; closeStart: number } {
  let cursor = index;
  while (cursor < source.length) {
    if (source[cursor] !== quote) {
      cursor += 1;
      continue;
    }
    let run = 0;
    while (source[cursor + run] === quote) run += 1;
    if (run >= runLength) return { end: cursor + run, closeStart: cursor };
    cursor += run;
  }
  return { end: source.length, closeStart: source.length };
}

function closeAloneOnItsLine(source: string, closeIndex: number): boolean {
  const lineStart = source.lastIndexOf("\n", closeIndex - 1) + 1;
  for (let i = lineStart; i < closeIndex; i += 1) {
    const ch = source[i];
    if (ch !== " " && ch !== "\t" && ch !== "\r") return false;
  }
  return true;
}

/** Scans an interpolation region recursively so a nested same-quote literal (or comment) cannot
 * close the surrounding string. Returns the index just past the interpolation end delimiter. */
function interpolationEnd(
  source: string,
  row: TriviaRow,
  start: number,
  interpolation: NonNullable<TriviaStringForm["interpolation"]>,
): number {
  return collectInterpolationSpans(source, row, start, interpolation).end;
}

/** Same walk as {@link interpolationEnd}, but collects the masked subspans (nested literals and
 * comments) so an excluded interpolation can leave its bare expression visible. */
function collectInterpolationSpans(
  source: string,
  row: TriviaRow,
  start: number,
  interpolation: NonNullable<TriviaStringForm["interpolation"]>,
): { end: number; spans: TriviaSpan[] } {
  const nestOpen = interpolation.start[interpolation.start.length - 1] ?? "";
  const spans: TriviaSpan[] = [];
  let depth = 1;
  let cursor = start + interpolation.start.length;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (source.startsWith(interpolation.end, cursor)) {
      depth -= 1;
      if (!depth) return { end: cursor + interpolation.end.length, spans };
      cursor += interpolation.end.length;
      continue;
    }
    if (ch === nestOpen) {
      depth += 1;
      cursor += 1;
      continue;
    }
    const commentEnd = commentSpanEnd(source, row, cursor);
    if (commentEnd !== null) {
      spans.push([cursor, commentEnd]);
      cursor = commentEnd;
      continue;
    }
    const nested = stringConstructAt(source, row, cursor);
    if (nested !== null) {
      spans.push(...nested.maskSpans);
      cursor = nested.end;
      continue;
    }
    cursor += 1;
  }
  return { end: source.length, spans };
}

function heredocConstructAt(source: string, row: TriviaRow, index: number): TriviaConstruct | null {
  if (!row.heredocs) return null;
  for (const heredoc of row.heredocs) {
    const openerRe = openerRegexFor(heredoc);
    openerRe.lastIndex = index;
    const match = openerRe.exec(source);
    if (!match) continue;
    if (precededByIdentifier(source, index)) continue;
    const terminatorId = match.slice(1).find((id) => id !== undefined) ?? "";
    if (!terminatorId) continue;
    const indentedTerminator = heredoc.indentedTerminator ?? false;
    const scanned = heredocBodyEnd(source, match.index + match[0].length, terminatorId, indentedTerminator);
    // The `<<<ID` / `<<ID` introducer and the terminator id stay visible; only the body is masked.
    const bodyStart = match.index + match[0].length;
    return {
      start: index,
      end: scanned.end,
      renderSpans: bodyStart < scanned.terminatorStart ? [[bodyStart, scanned.terminatorStart]] : [],
      maskSpans: [[index, scanned.end]],
      delimitersAreTrivia: false,
    };
  }
  return null;
}

function heredocBodyEnd(
  source: string,
  afterOpener: number,
  terminatorId: string,
  indentedTerminator: boolean,
): { end: number; terminatorStart: number } {
  let lineStart = source.indexOf("\n", afterOpener);
  if (lineStart < 0) return { end: source.length, terminatorStart: source.length };
  lineStart += 1;
  while (lineStart < source.length) {
    let cursor = lineStart;
    if (indentedTerminator) {
      while (source[cursor] === " " || source[cursor] === "\t" || source[cursor] === "\r") cursor += 1;
    }
    if (source.startsWith(terminatorId, cursor)) {
      const afterId = cursor + terminatorId.length;
      const next = source[afterId];
      if (next === undefined || !/[\p{ID_Continue}$_]/u.test(next)) {
        return { end: afterId, terminatorStart: cursor };
      }
    }
    const newline = source.indexOf("\n", lineStart);
    if (newline < 0) return { end: source.length, terminatorStart: source.length };
    lineStart = newline + 1;
  }
  return { end: source.length, terminatorStart: source.length };
}

const PERCENT_LITERAL_TYPES = "qQwWrsxiI";
const PERCENT_BRACKET_PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

function percentLiteralConstructAt(source: string, index: number): TriviaConstruct | null {
  if (source[index] !== "%") return null;
  const typeChar = source[index + 1];
  if (!typeChar || !PERCENT_LITERAL_TYPES.includes(typeChar)) return null;
  const openChar = source[index + 2];
  if (!openChar) return null;
  if (/[A-Za-z0-9 \t]/.test(openChar)) return null;
  if (precededByIdentifier(source, index)) return null;
  const closeChar = PERCENT_BRACKET_PAIRS[openChar];
  const bodyStart = index + 3;
  let cursor = bodyStart;
  let depth = 1;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "\\") {
      cursor += 2;
      continue;
    }
    if (closeChar !== undefined) {
      if (ch === openChar) {
        depth += 1;
      } else if (ch === closeChar) {
        depth -= 1;
        if (!depth) {
          return {
            start: index,
            end: cursor + 1,
            renderSpans: bodyStart < cursor ? [[bodyStart, cursor]] : [],
            maskSpans: [[index, cursor + 1]],
            delimitersAreTrivia: false,
          };
        }
      }
    } else if (ch === openChar) {
      return {
        start: index,
        end: cursor + 1,
        renderSpans: bodyStart < cursor ? [[bodyStart, cursor]] : [],
        maskSpans: [[index, cursor + 1]],
        delimitersAreTrivia: false,
      };
    }
    cursor += 1;
  }
  return {
    start: index,
    end: source.length,
    renderSpans: bodyStart < source.length ? [[bodyStart, source.length]] : [],
    maskSpans: [[index, source.length]],
    delimitersAreTrivia: false,
  };
}

function zigMultilineConstruct(source: string, start: number): TriviaConstruct {
  const renderSpans: TriviaSpan[] = [];
  let cursor = start;
  let end = source.length;
  while (cursor < source.length) {
    let lineEnd = cursor;
    while (lineEnd < source.length && source[lineEnd] !== "\n") lineEnd += 1;
    // The `\\` line prefix is a delimiter and stays visible; the rest of the line is body.
    if (cursor + 2 < lineEnd) renderSpans.push([cursor + 2, lineEnd]);
    if (lineEnd >= source.length) {
      end = source.length;
      break;
    }
    let probe = lineEnd + 1;
    while (probe < source.length && (source[probe] === " " || source[probe] === "\t" || source[probe] === "\r")) {
      probe += 1;
    }
    if (source[probe] === "\\" && source[probe + 1] === "\\") {
      cursor = probe;
      continue;
    }
    end = lineEnd;
    break;
  }
  return {
    start,
    end,
    renderSpans,
    maskSpans: [[start, end]],
    delimitersAreTrivia: false,
  };
}
