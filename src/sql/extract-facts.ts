import { collectLineStartOffsets } from "../util/lines.js";
import { normalizePath } from "../util/paths.js";
import { classifySqlFile } from "./classify-sql-file.js";
import {
  createSqlObjectNameRegExp,
  isBareSqlKeyword,
  maskSqlQuotedIdentifiers,
  maskSqlStringsAndComments,
  normalizeSqlObjectName,
  sqlObjectLookupKey,
  SQL_OBJECT_NAME_PATTERN,
  splitTopLevelCommaSeparated,
  sqlParenDepthAt,
  sqlQueryScopes,
  sqlSourceClauses,
  sqlTriviaBoundaries,
  type SqlTriviaBoundaries,
} from "./lex.js";
import { sqlObjectLookupKeys } from "./lookup.js";
import { SQL_ROUTINE_DEFINITION_RE } from "./routine-mentions.js";
import type { SqlFactKind, SqlFileRole, SqlStatementFact } from "./types.js";

export { maskSqlStringsAndComments, normalizeSqlObjectName, sqlObjectBaseName } from "./lex.js";

type SqlFactDraft = {
  kind: SqlFactKind;
  objectName: string | null;
  relatedObjectName: string | null;
};

type SqlStatementSlice = {
  text: string;
  startLine: number;
  startColumn: number;
  startIndex: number;
  endLine: number;
  endColumn: number;
  endIndex: number;
};

const OBJECT_NAME_RE = createSqlObjectNameRegExp("iy");
const SQL_KEYWORDS = new Set([
  "select",
  "from",
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "on",
  "group",
  "order",
  "limit",
  "offset",
  "values",
  "set",
  "returning",
]);

function lineStartsFor(source: string): number[] {
  return collectLineStartOffsets(source);
}

function positionAt(
  lineStarts: readonly number[],
  sourceLength: number,
  index: number,
): { line: number; column: number } {
  const boundedIndex = Math.max(0, Math.min(index, sourceLength));
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const lineStart = lineStarts[mid] ?? 0;
    if (lineStart <= boundedIndex) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const lineIndex = Math.max(0, high);
  return {
    line: lineIndex + 1,
    column: boundedIndex - (lineStarts[lineIndex] ?? 0) + 1,
  };
}

function statementSlice(
  source: string,
  lineStarts: readonly number[],
  start: number,
  end: number,
): SqlStatementSlice | null {
  let startIndex = start;
  while (startIndex < end && /\s/.test(source[startIndex] ?? "")) {
    startIndex += 1;
  }

  let endIndex = end;
  while (endIndex > startIndex && /\s/.test(source[endIndex - 1] ?? "")) {
    endIndex -= 1;
  }

  const text = source.slice(startIndex, endIndex);
  if (!text) return null;

  const startPosition = positionAt(lineStarts, source.length, startIndex);
  const endPosition = positionAt(lineStarts, source.length, endIndex);
  return {
    text,
    startLine: startPosition.line,
    startColumn: startPosition.column,
    startIndex,
    endLine: endPosition.line,
    endColumn: endPosition.column,
    endIndex,
  };
}

type SqlStatementScan = { statements: SqlStatementSlice[]; endsInBlockComment: boolean };

type SqlBlockFrame = "begin" | "case";

/** Words that can follow END in `END LOOP` or `END CASE`. Anything else is a plain END. */
const SQL_END_FOLLOWER = new Set(["case", "for", "if", "loop", "repeat", "while"]);

function readBareWord(text: string, index: number): { word: string; end: number } | null {
  if (!/[A-Za-z_]/.test(text[index] ?? "")) return null;
  let end = index + 1;
  while (/[A-Za-z0-9_$]/.test(text[end] ?? "")) end += 1;
  return { word: text.slice(index, end).toLowerCase(), end };
}

function nextSignificant(trivia: SqlTriviaBoundaries, index: number): number {
  const table = trivia.forward;
  if (index < 0) return table[0] ?? 0;
  if (index >= table.length) return table[table.length - 1] ?? index;
  return table[index] ?? index;
}

/** A bare or quoted identifier: the optional label in `END LOOP label` or `END CASE label`. */
function identifierEnd(text: string, index: number): number | null {
  const open = text[index] ?? "";
  if (open === '"' || open === "`" || open === "[") {
    const close = open === "[" ? "]" : open;
    let cursor = index + 1;
    while (cursor < text.length) {
      if ((text[cursor] ?? "") !== close) {
        cursor += 1;
        continue;
      }
      if ((text[cursor + 1] ?? "") === close) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    return null;
  }
  if (!/[A-Za-z_]/.test(open)) return null;
  let end = index + 1;
  while (/[A-Za-z0-9_$]/.test(text[end] ?? "")) end += 1;
  return end;
}

/** `;`, or no further significant token, completes `END LOOP [label]` and `END CASE [label]`. */
function finishesCompound(text: string, index: number, trivia: SqlTriviaBoundaries): boolean {
  const next = nextSignificant(trivia, index);
  return next >= text.length || (text[next] ?? "") === ";";
}

/** `GO` on its own line is a batch separator, not the label of an `END LOOP`. */
function isOwnLineGo(text: string, index: number): boolean {
  if (readBareWord(text, index)?.word !== "go") return false;
  let lineStart = index;
  while (lineStart > 0 && (text[lineStart - 1] ?? "") !== "\n") lineStart -= 1;
  return /^[\t ]*go(?:[\t ]*(?:--[^\r\n]*)?)?(?:\r?\n|$)/i.test(text.slice(lineStart));
}

/**
 * `END CASE` closes a CASE wherever it sits. `END IF|LOOP|WHILE|REPEAT|FOR` closes nothing
 * only when the innermost frame is BEGIN or the stack is empty. An open CASE makes the same
 * words the end of that expression: `END loop` is an alias, and `END FOR UPDATE` is a clause.
 */
function compoundEndAction(keyword: string, innermost: SqlBlockFrame | undefined): "noop" | "case" | "close" {
  if (keyword === "case") return "case";
  if (innermost === "case") return "close";
  return "noop";
}

/**
 * `END CASE [label]` then `;` or the end of the text closes the innermost CASE. The same shape of
 * `END IF|LOOP|WHILE|REPEAT|FOR [label]` closes nothing when the innermost frame is BEGIN or the
 * stack is empty, and closes the CASE when that is the innermost frame. Any other END, including
 * T-SQL `END IF @x` with no semicolon after IF, closes the innermost frame. The returned index
 * stops before the semicolon so the statement scan can still split on it.
 */
function classifyEnd(
  text: string,
  endWordEnd: number,
  trivia: SqlTriviaBoundaries,
  innermost: SqlBlockFrame | undefined,
): { action: "noop" | "case" | "close"; resume: number } {
  const close = { action: "close" as const, resume: endWordEnd };
  const keywordAt = nextSignificant(trivia, endWordEnd);
  if (isOwnLineGo(text, keywordAt)) return close;
  const keyword = readBareWord(text, keywordAt);
  if (!keyword || !SQL_END_FOLLOWER.has(keyword.word)) return close;
  if (!isBareSqlKeyword(text, keywordAt, keyword.end, trivia)) return close;
  const action = compoundEndAction(keyword.word, innermost);
  if (finishesCompound(text, keyword.end, trivia)) {
    return { action, resume: keyword.end };
  }
  const labelAt = nextSignificant(trivia, keyword.end);
  if (isOwnLineGo(text, labelAt)) return close;
  const labelEnd = identifierEnd(text, labelAt);
  if (labelEnd === null || !finishesCompound(text, labelEnd, trivia)) return close;
  return { action, resume: labelEnd };
}

function closeInnermostCase(stack: SqlBlockFrame[]): void {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index] !== "case") continue;
    stack.length = index;
    return;
  }
}

/**
 * Bare BEGIN and bare CASE open a frame. The bare-keyword check, using this scan's trivia
 * table, leaves `t.case`, `@case`, a quoted name, and `CASE .5` as ordinary tokens.
 */
function advanceSqlBlockWord(text: string, index: number, stack: SqlBlockFrame[], trivia: SqlTriviaBoundaries): number {
  const read = readBareWord(text, index);
  if (!read) return index + 1;
  if (!isBareSqlKeyword(text, index, read.end, trivia)) return read.end;
  if (read.word === "begin" || read.word === "case") {
    stack.push(read.word);
    return read.end;
  }
  if (read.word !== "end") return read.end;
  const classified = classifyEnd(text, read.end, trivia, stack[stack.length - 1]);
  if (classified.action === "case") closeInnermostCase(stack);
  else if (classified.action === "close") stack.pop();
  return classified.resume;
}

/** MySQL allows one compound statement, with no BEGIN, as the body of a routine. */
const COMPOUND_BODY_WORDS = new Set(["case", "if", "loop", "repeat", "while"]);
/**
 * Words that can sit between the parameter list and that body: `RETURNS integer`,
 * `DETERMINISTIC`, `LANGUAGE SQL`, and the other MySQL characteristics.
 */
const ROUTINE_CHARACTERISTICS = new Set([
  "comment",
  "contains",
  "data",
  "definer",
  "deterministic",
  "invoker",
  "modifies",
  "no",
  "not",
  "null",
  "reads",
  "security",
  "sql",
]);
/** A nested compound of the same keyword starts after one of these, or after a semicolon. */
const COMPOUND_NEST_WORDS = new Set(["begin", "do", "else", "elseif", "loop", "repeat", "then"]);
/** Words that mean the body is not a bare compound statement. */
const ROUTINE_BODY_STOP = new Set([
  "as",
  "begin",
  "call",
  "declare",
  "delete",
  "insert",
  "perform",
  "return",
  "select",
  "update",
]);

type RoutineCompound = { keywordEnd: number; depth: number };
type RoutineHead =
  | "start"
  | "create"
  | "or"
  | "replace"
  | "name"
  | "after-name"
  | "params"
  | "chars"
  | "language"
  | "type"
  | "body";

/**
 * When a CREATE PROCEDURE or FUNCTION has a parameter list and the next bare token, after
 * characteristics, is IF, LOOP, REPEAT, WHILE, or CASE, `depth` counts that keyword only.
 * `END` plus the same keyword closes one level. Null when this routine has no such body.
 */
function scanRoutineCompound(
  code: string,
  trivia: SqlTriviaBoundaries,
  start: number,
  end: number,
): RoutineCompound | null {
  let phase: RoutineHead = "start";
  let paramDepth = 0;
  let typeDepth = 0;
  let keyword = "";
  let keywordEnd = -1;
  let depth = 0;
  let prevWord = "";
  let prevWasSemi = false;
  let index = start;

  while (index < end) {
    const char = code[index] ?? "";
    if (char === "(") {
      if (phase === "name" || phase === "after-name") {
        phase = "params";
        paramDepth = 1;
      } else if (phase === "params") paramDepth += 1;
      else if (phase === "type") typeDepth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      if (phase === "params" && paramDepth > 0) {
        paramDepth -= 1;
        if (paramDepth === 0) phase = "chars";
      } else if (phase === "type" && typeDepth > 0) typeDepth -= 1;
      index += 1;
      continue;
    }
    if (char === ";") {
      prevWasSemi = true;
      prevWord = "";
      index += 1;
      continue;
    }
    if (char === "." && phase === "after-name") {
      phase = "name";
      index += 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(char)) {
      index += 1;
      continue;
    }
    const read = readBareWord(code, index);
    if (!read) {
      index += 1;
      continue;
    }
    if (phase === "name") {
      phase = "after-name";
      index = read.end;
      continue;
    }
    if (!isBareSqlKeyword(code, index, read.end, trivia)) {
      index = read.end;
      continue;
    }
    const word = read.word;
    index = read.end;
    if (phase === "params") continue;
    if (phase === "language") {
      phase = "chars";
      prevWord = word;
      prevWasSemi = false;
      continue;
    }
    if (phase === "type" && typeDepth > 0) continue;
    if (phase === "chars" || phase === "type") {
      if (typeDepth === 0 && COMPOUND_BODY_WORDS.has(word)) {
        keyword = word;
        keywordEnd = index;
        depth = 1;
        phase = "body";
      } else if (word === "returns") phase = "type";
      else if (word === "language") phase = "language";
      else if (ROUTINE_CHARACTERISTICS.has(word)) phase = "chars";
      else if (phase === "type" && !ROUTINE_BODY_STOP.has(word)) {
        // A type word: integer, unsigned, varying, precision.
      } else return null;
      prevWord = word;
      prevWasSemi = false;
      continue;
    }
    if (phase === "body") {
      if (word === "end") {
        const followerAt = nextSignificant(trivia, index);
        const follower = followerAt < end ? readBareWord(code, followerAt) : null;
        if (
          follower &&
          follower.end <= end &&
          follower.word === keyword &&
          isBareSqlKeyword(code, followerAt, follower.end, trivia)
        ) {
          depth -= 1;
          index = follower.end;
          prevWord = follower.word;
          prevWasSemi = false;
          continue;
        }
      } else if (word === keyword && (prevWasSemi || COMPOUND_NEST_WORDS.has(prevWord))) {
        depth += 1;
      }
      prevWord = word;
      prevWasSemi = false;
      continue;
    }
    if (phase === "start") phase = word === "create" ? "create" : "start";
    else if (phase === "create") {
      if (word === "or") phase = "or";
      else if (word === "procedure" || word === "function") phase = "name";
      else return null;
    } else if (phase === "or") phase = word === "replace" ? "replace" : "start";
    else if (phase === "replace") phase = word === "procedure" || word === "function" ? "name" : "start";
    if (phase === "start" || phase === "after-name") return null;
    prevWord = word;
    prevWasSemi = false;
  }
  if (phase !== "body" || keywordEnd < 0) return null;
  return { keywordEnd, depth };
}

/**
 * Splits SQL text into statements. PostgreSQL and SQL Server let a block comment hold block comments,
 * which `nestedComments` reads. Without it, a block comment ends at its first closing delimiter.
 */
function scanSqlStatements(source: string, nestedComments: boolean): SqlStatementScan {
  // Block keywords use trivia boundaries from this mask, so each look is one table read.
  // A dash-dash inside a quote is already blank and cannot be read as a line comment.
  const masked = maskSqlStringsAndComments(source, {
    nestedBlockComments: nestedComments,
    escapeStrings: true,
  });
  const code = maskSqlQuotedIdentifiers(masked);
  const trivia = sqlTriviaBoundaries(masked);
  const statements: SqlStatementSlice[] = [];
  const lineStarts = lineStartsFor(source);
  let start = 0;
  let lineStart = 0;
  let i = 0;
  let lookingForStatementStart = true;
  const openBlocks: SqlBlockFrame[] = [];
  let singleQuoted = false;
  let escapeString = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let bracketQuoted = false;
  let lineComment = false;
  let commentDepth = 0;
  let dollarQuote: string | null = null;

  const pushStatement = (end: number, nextStart = end + 1): void => {
    const statement = statementSlice(source, lineStarts, start, end);
    if (statement) statements.push(statement);
    start = nextStart;
    lookingForStatementStart = true;
  };

  while (i < source.length) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (char === "\n") {
      lineStart = i + 1;
      if (lineComment) lineComment = false;
      if (lookingForStatementStart) {
        start = i + 1;
      }
      i += 1;
      continue;
    }

    if (lineComment) {
      i += 1;
      continue;
    }

    if (commentDepth) {
      if (nestedComments && char === "/" && next === "*") {
        commentDepth += 1;
        i += 2;
        continue;
      }
      if (char === "*" && next === "/") {
        commentDepth -= 1;
        i += 2;
        if (!commentDepth && lookingForStatementStart) {
          start = i;
        }
        continue;
      }
      i += 1;
      continue;
    }

    if (i === lineStart && !singleQuoted && !doubleQuoted && !backtickQuoted && !bracketQuoted && !dollarQuote) {
      const batchSeparator = source.slice(i).match(/^[\t ]*GO(?:[\t ]*(?:--[^\r\n]*)?)?(?:\r?\n|$)/i);
      if (batchSeparator?.[0]) {
        const nextStart = i + batchSeparator[0].length;
        openBlocks.length = 0;
        pushStatement(i, nextStart);
        i = nextStart;
        lineStart = nextStart;
        continue;
      }
    }

    if (lookingForStatementStart) {
      if (/\s/.test(char)) {
        start = i + 1;
        i += 1;
        continue;
      }
      if (char === "-" && next === "-") {
        lineComment = true;
        i += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        commentDepth = 1;
        i += 2;
        continue;
      }
      start = i;
      lookingForStatementStart = false;
    }

    if (dollarQuote) {
      if (source.startsWith(dollarQuote, i)) {
        i += dollarQuote.length;
        dollarQuote = null;
        continue;
      }
      i += 1;
      continue;
    }

    if (singleQuoted) {
      if (escapeString && char === "\\" && next) {
        i += 2;
        continue;
      }
      if (char === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (char === "'") {
        singleQuoted = false;
        escapeString = false;
      }
      i += 1;
      continue;
    }

    if (doubleQuoted) {
      if (char === '"' && next === '"') {
        i += 2;
        continue;
      }
      if (char === '"') doubleQuoted = false;
      i += 1;
      continue;
    }

    if (backtickQuoted) {
      if (char === "`") backtickQuoted = false;
      i += 1;
      continue;
    }

    if (bracketQuoted) {
      if (char === "]") bracketQuoted = false;
      i += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      lineComment = true;
      i += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      commentDepth = 1;
      i += 2;
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
      // Only PostgreSQL E'...' strings give backslashes special meaning.
      escapeString = /[eE]/.test(source[i - 1] ?? "") && !/[\w$]/.test(source[i - 2] ?? "");
      i += 1;
      continue;
    }
    if (char === '"') {
      doubleQuoted = true;
      i += 1;
      continue;
    }
    if (char === "`") {
      backtickQuoted = true;
      i += 1;
      continue;
    }
    if (char === "[") {
      bracketQuoted = true;
      i += 1;
      continue;
    }
    if (char === "$") {
      const tagMatch = source.slice(i).match(/^\$[A-Za-z_][\w$]*\$|^\$\$/);
      if (tagMatch?.[0]) {
        dollarQuote = tagMatch[0];
        i += dollarQuote.length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(char)) {
      i = advanceSqlBlockWord(masked, i, openBlocks, trivia);
      continue;
    }
    // A compound routine body stays one statement until its own END keyword. BEGIN and CASE
    // frames are unchanged, and a qualified name such as t.if is not that keyword.
    if (char === ";" && openBlocks.length === 0) {
      const compound = scanRoutineCompound(code, trivia, start, i);
      if (!compound || compound.depth <= 0) pushStatement(i);
    }
    i += 1;
  }

  const tail = statementSlice(source, lineStarts, start, source.length);
  if (tail) statements.push(tail);
  return { statements, endsInBlockComment: commentDepth > 0 };
}

/**
 * PostgreSQL and SQL Server nest block comments; MySQL, SQLite, and Oracle end one at its first closing
 * delimiter, and the text does not say which it is. It reads as nested unless a comment then never
 * closes, which no PostgreSQL or SQL Server text does. Such text reads the way MySQL does.
 */
function splitSqlStatements(source: string): SqlStatementSlice[] {
  const nested = scanSqlStatements(source, true);
  return nested.endsInBlockComment ? scanSqlStatements(source, false).statements : nested.statements;
}

const SQL_OBJECT_MODIFIERS = new Set(["lateral", "only"]);

function skipWhitespace(text: string, index: number): number {
  let nextIndex = index;
  while (nextIndex < text.length && /\s/.test(text[nextIndex] ?? "")) {
    nextIndex += 1;
  }
  return nextIndex;
}

function objectAt(text: string, index: number, skipModifiers = SQL_OBJECT_MODIFIERS): string | null {
  let cursor = skipWhitespace(text, index);
  while (cursor < text.length) {
    OBJECT_NAME_RE.lastIndex = cursor;
    const match = OBJECT_NAME_RE.exec(text);
    if (!match) return null;
    const name = normalizeSqlObjectName(match[0]);
    if (!name) return null;
    if (!skipModifiers.has(name.toLowerCase())) return name;
    cursor = skipWhitespace(text, match.index + match[0].length);
  }
  return null;
}

function findObjectAfter(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  if (!match?.[0]) return null;
  return objectAt(text, match.index + match[0].length);
}

function collectObjectsAfterKeywords(
  text: string,
  keywords: readonly string[],
  opts?: { topLevelOnly?: boolean },
): string[] {
  const names: string[] = [];
  const keywordPattern = keywords.map((keyword) => keyword.replace(/\s+/g, String.raw`\s+`)).join("|");
  const re = new RegExp(String.raw`\b(?:${keywordPattern})\s+`, "gi");
  for (const match of text.matchAll(re)) {
    if (opts?.topLevelOnly && sqlParenDepthAt(text, match.index ?? 0) > 0) continue;
    const name = objectAt(text, (match.index ?? 0) + match[0].length);
    if (name && !SQL_KEYWORDS.has(name.toLowerCase())) names.push(name);
  }
  return Array.from(new Set(names));
}

function collectReadSources(text: string): {
  names: string[];
  joins: Array<{ name: string; scopeFromNames: readonly string[] }>;
} {
  const scan = maskSqlQuotedIdentifiers(text);
  const trivia = sqlTriviaBoundaries(scan);
  const scopes = sqlQueryScopes(scan, trivia);
  const names: string[] = [];
  const fromNamesByScope = new Map<number, string[]>();
  const joins: Array<{ name: string; scope: number }> = [];
  for (const clause of sqlSourceClauses(scan, trivia)) {
    const scope = scopes.at(clause.start);
    if (clause.kind === "from" || clause.kind === "using") {
      for (const part of splitTopLevelCommaSeparated(text.slice(clause.end, clause.clauseEnd))) {
        const name = objectAt(part, 0);
        if (!name || SQL_KEYWORDS.has(name.toLowerCase())) continue;
        names.push(name);
        const inScope = fromNamesByScope.get(scope);
        if (inScope) inScope.push(name);
        else fromNamesByScope.set(scope, [name]);
      }
    } else if (clause.kind === "join") {
      const name = objectAt(text, clause.end);
      if (name && !SQL_KEYWORDS.has(name.toLowerCase())) joins.push({ name, scope });
    }
  }
  return {
    names: Array.from(new Set(names)),
    joins: joins.map((join) => ({ name: join.name, scopeFromNames: fromNamesByScope.get(join.scope) ?? [] })),
  };
}

function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function collectCteReads(text: string): { names: Set<string>; facts: SqlFactDraft[] } {
  const names = new Set<string>();
  const facts: SqlFactDraft[] = [];
  const ctePattern = new RegExp(
    String.raw`(?:\bwith\s+(?:recursive\s+)?|,\s*)(${SQL_OBJECT_NAME_PATTERN})(?:\s*\([^)]*\))?\s+as\s*\(`,
    "gi",
  );

  const seenFacts = new Set<string>();

  for (const match of text.matchAll(ctePattern)) {
    const name = normalizeSqlObjectName(match[1]);
    if (!name) continue;
    for (const key of sqlObjectLookupKeys(name)) names.add(key);
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = findMatchingParen(text, bodyStart - 1);
    if (bodyEnd < 0) continue;
    for (const fact of extractReadFacts(text.slice(bodyStart, bodyEnd))) {
      const key = `${fact.kind}:${fact.objectName ?? ""}:${fact.relatedObjectName ?? ""}`;
      if (seenFacts.has(key)) continue;
      seenFacts.add(key);
      facts.push(fact);
    }
  }

  return { names, facts };
}

function createDefinitionFact(text: string): SqlFactDraft | null {
  const tableName = findObjectAfter(
    text,
    /\bcreate\s+(?:(?:temporary|temp|unlogged|global\s+temporary|local\s+temporary)\s+)*table\s+(?:if\s+not\s+exists\s+)?/i,
  );
  if (tableName) return { kind: "defines_table", objectName: tableName, relatedObjectName: null };

  const viewName = findObjectAfter(
    text,
    /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?/i,
  );
  if (viewName) return { kind: "defines_view", objectName: viewName, relatedObjectName: null };

  const indexName = findObjectAfter(
    text,
    /\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?/i,
  );
  if (indexName) {
    return {
      kind: "defines_index",
      objectName: indexName,
      relatedObjectName: findObjectAfter(text, /\bon\s+/i),
    };
  }

  const routineName = findObjectAfter(text, SQL_ROUTINE_DEFINITION_RE);
  if (routineName) return { kind: "defines_routine", objectName: routineName, relatedObjectName: null };

  return null;
}

function extractCreateTableConstraintFacts(text: string, tableName: string | null): SqlFactDraft[] {
  if (!tableName) return [];
  const references = collectObjectsAfterKeywords(text, ["references"]).filter((name) => name !== tableName);
  return references.map((relatedObjectName) => ({
    kind: "defines_constraint",
    objectName: tableName,
    relatedObjectName,
  }));
}

function extractReadFacts(text: string): SqlFactDraft[] {
  const cteReads = collectCteReads(text);
  const isCteName = (name: string): boolean => sqlObjectLookupKeys(name).some((key) => cteReads.names.has(key));
  const sources = collectReadSources(text);
  const fromObjects = sources.names.filter((name) => !isCteName(name));
  const facts: SqlFactDraft[] = [...cteReads.facts];
  const seenReads = new Set<string>();
  for (const fact of cteReads.facts) {
    if (fact.kind === "reads_from" && fact.objectName) seenReads.add(sqlObjectLookupKey(fact.objectName));
  }
  for (const fromName of fromObjects) {
    const key = sqlObjectLookupKey(fromName);
    if (seenReads.has(key)) continue;
    seenReads.add(key);
    facts.push({ kind: "reads_from", objectName: fromName, relatedObjectName: null });
  }
  const seenJoins = new Set<string>();
  const joinKey = (name: string, related: string | null): string => {
    const relatedKey = related === null ? "" : sqlObjectLookupKey(related);
    return sqlObjectLookupKey(name) + ":" + relatedKey;
  };
  for (const fact of cteReads.facts) {
    if (fact.kind === "joins" && fact.objectName) {
      seenJoins.add(joinKey(fact.objectName, fact.relatedObjectName));
    }
  }
  for (const join of sources.joins) {
    if (isCteName(join.name)) continue;
    const related = join.scopeFromNames.find((name) => !isCteName(name)) ?? null;
    const key = joinKey(join.name, related);
    if (seenJoins.has(key)) continue;
    seenJoins.add(key);
    facts.push({ kind: "joins", objectName: join.name, relatedObjectName: related });
  }
  return facts;
}

/**
 * The text between a routine body's BEGIN and its matching END. A BEGIN inside parentheses, as in
 * a parameter named begin, is not the body. Bare CASE opens a frame and `END CASE` closes the
 * innermost CASE. `END IF`, `END LOOP`, `END WHILE`, `END REPEAT`, and `END FOR` close nothing
 * when the innermost frame is BEGIN, and close a CASE when that is the innermost frame. Any other
 * END closes the innermost frame. A variable or qualified name such as `@case` or `t . case`
 * is not a block keyword. Null when the statement has no such body. A dollar-quoted body is already
 * blank, so only a BEGIN/END that the statement splitter kept as one statement is read.
 */
function beginEndBody(text: string): string | null {
  const scan = maskSqlQuotedIdentifiers(text);
  const trivia = sqlTriviaBoundaries(scan);
  const stack: SqlBlockFrame[] = [];
  let parenDepth = 0;
  let cursor = 0;
  let bodyStart = -1;
  while (cursor < scan.length && bodyStart < 0) {
    const code = scan.charCodeAt(cursor);
    if (code === 40) {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (code === 41) {
      parenDepth = Math.max(0, parenDepth - 1);
      cursor += 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(scan[cursor] ?? "")) {
      cursor += 1;
      continue;
    }
    const word = readBareWord(scan, cursor);
    if (parenDepth === 0 && word?.word === "begin" && isBareSqlKeyword(scan, cursor, word.end, trivia)) {
      bodyStart = word.end;
      stack.push("begin");
      cursor = word.end;
      break;
    }
    cursor = word?.end ?? cursor + 1;
  }
  if (bodyStart < 0) return null;
  while (cursor < scan.length) {
    if (/[A-Za-z_]/.test(scan[cursor] ?? "")) {
      const atWord = cursor;
      cursor = advanceSqlBlockWord(scan, cursor, stack, trivia);
      if (stack.length === 0) return text.slice(bodyStart, atWord);
      continue;
    }
    cursor += 1;
  }
  return null;
}
/** Read facts of statements split out of a routine body. */
function readsOfStatements(body: string): SqlFactDraft[] {
  const seen = new Set<string>();
  const facts: SqlFactDraft[] = [];
  for (const inner of splitSqlStatements(body)) {
    for (const fact of extractReadFacts(inner.text)) {
      const key = `${fact.kind}:${fact.objectName ?? ""}:${fact.relatedObjectName ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
    }
  }
  return facts;
}

/** Read facts of the statements inside a `BEGIN`/`END` body, split by the statement splitter. */
function readsInsideBeginEnd(masked: string): SqlFactDraft[] {
  const body = beginEndBody(masked);
  if (body === null) return [];
  return readsOfStatements(body);
}

/**
 * Read facts inside a compound routine body the same way as a BEGIN/END body.
 * Null when the routine body is not that single compound statement.
 */
function readsInsideCompoundRoutine(masked: string): SqlFactDraft[] | null {
  const code = maskSqlQuotedIdentifiers(masked);
  const found = scanRoutineCompound(code, sqlTriviaBoundaries(masked), 0, code.length);
  if (!found) return null;
  return readsOfStatements(masked.slice(found.keywordEnd));
}

function withoutSelfRead(readFacts: SqlFactDraft[], objectName: string | null): SqlFactDraft[] {
  if (!objectName) return readFacts;
  return readFacts.filter((fact) => fact.objectName !== objectName);
}

function extractStatementFactDrafts(statementText: string): SqlFactDraft[] {
  const text = maskSqlStringsAndComments(statementText, { escapeStrings: true });
  const definitionFact = createDefinitionFact(text);
  if (definitionFact) {
    const constraintFacts =
      definitionFact.kind === "defines_table" ? extractCreateTableConstraintFacts(text, definitionFact.objectName) : [];
    let readFacts: SqlFactDraft[] = [];
    if (definitionFact.kind === "defines_view" || /\bas\s+select\b/i.test(text)) {
      readFacts = withoutSelfRead(extractReadFacts(text), definitionFact.objectName);
    } else if (definitionFact.kind === "defines_routine") {
      readFacts = readsInsideCompoundRoutine(text) ?? readsInsideBeginEnd(text);
    }
    return [definitionFact, ...constraintFacts, ...readFacts];
  }

  const renameSourceName = findObjectAfter(text, /\balter\s+table\s+(?:if\s+exists\s+)?/i);
  const renameTargetName = findObjectAfter(text, /\brename\s+to\s+/i);
  if (renameSourceName && renameTargetName) {
    return [{ kind: "renames_object", objectName: renameSourceName, relatedObjectName: renameTargetName }];
  }

  const truncateName = findObjectAfter(text, /\btruncate\s+(?:table\s+)?(?:if\s+exists\s+)?/i);
  if (truncateName) return [{ kind: "writes_to", objectName: truncateName, relatedObjectName: null }];

  const mergeName = findObjectAfter(text, /\bmerge\s+into\s+/i);
  if (mergeName) {
    return [
      { kind: "writes_to", objectName: mergeName, relatedObjectName: null },
      ...withoutSelfRead(extractReadFacts(text), mergeName),
    ];
  }

  const alterName = findObjectAfter(text, /\balter\s+table\s+(?:if\s+exists\s+)?/i);
  if (alterName) {
    return [
      { kind: "alters_table", objectName: alterName, relatedObjectName: null },
      ...extractCreateTableConstraintFacts(text, alterName),
    ];
  }

  const dropName = findObjectAfter(
    text,
    /\bdrop\s+(?:(?:materialized\s+)?view|table|function|procedure|trigger)\s+(?:if\s+exists\s+)?|\bdrop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?/i,
  );
  if (dropName) return [{ kind: "drops_object", objectName: dropName, relatedObjectName: null }];

  const insertName = findObjectAfter(text, /\binsert\s+into\s+/i);
  if (insertName) {
    return [
      { kind: "writes_to", objectName: insertName, relatedObjectName: null },
      ...withoutSelfRead(extractReadFacts(text), insertName),
    ];
  }

  const updateName = findObjectAfter(text, /\bupdate\s+/i);
  if (updateName) {
    return [
      { kind: "writes_to", objectName: updateName, relatedObjectName: null },
      ...withoutSelfRead(extractReadFacts(text), updateName),
    ];
  }

  const deleteName = findObjectAfter(text, /\bdelete\s+from\s+/i);
  if (deleteName) {
    return [
      { kind: "writes_to", objectName: deleteName, relatedObjectName: null },
      ...withoutSelfRead(extractReadFacts(text), deleteName),
    ];
  }

  const readFacts = extractReadFacts(text);
  if (readFacts.length) return readFacts;

  return [];
}

function toFact(
  filePath: string,
  role: SqlFileRole,
  statement: SqlStatementSlice,
  draft: SqlFactDraft,
  index: number,
): SqlStatementFact {
  const normalizedFile = normalizePath(filePath);
  const objectPart = draft.objectName ?? "statement";
  return {
    id: `${normalizedFile}:${statement.startLine}:${draft.kind}:${objectPart}:${index}`,
    filePath: normalizedFile,
    startLine: statement.startLine,
    startColumn: statement.startColumn,
    startIndex: statement.startIndex,
    endLine: statement.endLine,
    endColumn: statement.endColumn,
    endIndex: statement.endIndex,
    role,
    kind: draft.kind,
    objectName: draft.objectName,
    relatedObjectName: draft.relatedObjectName,
    statementText: statement.text,
    truthTier: "sql_statement_fact",
  };
}

export function extractSqlFactsFromSource(filePath: string, source: string): SqlStatementFact[] {
  const role = classifySqlFile(filePath, source);
  const facts: SqlStatementFact[] = [];
  for (const statement of splitSqlStatements(source)) {
    const drafts = extractStatementFactDrafts(statement.text);
    const resolvedDrafts = drafts.length
      ? drafts
      : [{ kind: "unknown_statement", objectName: null, relatedObjectName: null } satisfies SqlFactDraft];
    for (const draft of resolvedDrafts) {
      facts.push(toFact(filePath, role, statement, draft, facts.length));
    }
  }
  return facts;
}
