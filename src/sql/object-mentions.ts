import {
  createSqlObjectNameRegExp,
  maskSqlQuotedIdentifiers,
  maskSqlStringsAndComments,
  normalizeSqlObjectName,
  SQL_OBJECT_NAME_PATTERN,
  sqlObjectLookupKey,
  sqlParenDepthAt,
  sqlMatchingParen as matchingParen,
  sqlSourceClauses,
} from "./lex.js";
import { sqlObjectLookupKeys } from "./lookup.js";
import { findSqlRoutineMentions, type SqlRoutineMention } from "./routine-mentions.js";
import { skipWhitespace } from "../util/text-scanning.js";

export type SqlNameSpan = { name: string; start: number; end: number };

const NAME_RE = createSqlObjectNameRegExp("y");
const OBJECT_MODIFIERS = new Set(["only", "lateral"]);
const NOT_OBJECT_NAMES = new Set([
  "and",
  "as",
  "begin",
  "by",
  "case",
  "cross",
  "delete",
  "each",
  "else",
  "end",
  "except",
  "for",
  "from",
  "full",
  "function",
  "group",
  "having",
  "in",
  "index",
  "inner",
  "insert",
  "intersect",
  "into",
  "is",
  "join",
  "left",
  "limit",
  "not",
  "null",
  "offset",
  "on",
  "or",
  "order",
  "procedure",
  "returning",
  "right",
  "row",
  "select",
  "set",
  "table",
  "then",
  "trigger",
  "union",
  "update",
  "using",
  "values",
  "view",
  "when",
  "where",
]);
const DEFINITION_PREFIXES = [
  /\bcreate\s+(?:(?:temporary|temp|unlogged|global\s+temporary|local\s+temporary)\s+)*table\s+(?:if\s+not\s+exists\s+)?/gi,
  /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?/gi,
  /\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?/gi,
  /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure|trigger)\s+/gi,
];
const TARGET_PREFIXES = [
  /\binsert\s+into\s+/gi,
  /\bupdate\s+/gi,
  /\bdelete\s+from\s+/gi,
  /\bmerge\s+into\s+/gi,
  /\btruncate\s+(?:table\s+)?(?:if\s+exists\s+)?/gi,
  /\balter\s+table\s+(?:if\s+exists\s+)?/gi,
  /\bdrop\s+(?:(?:materialized\s+)?view|table|function|procedure|trigger)\s+(?:if\s+exists\s+)?|\bdrop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?/gi,
  /\brename\s+to\s+/gi,
  /\breferences\s+/gi,
];
const CTE_SOURCE = String.raw`(?:\bwith\s+(?:recursive\s+)?|,\s*)(${SQL_OBJECT_NAME_PATTERN})(?:\s*\([^)]*\))?\s+as\s*\(`;

function ctePattern(): RegExp {
  return new RegExp(CTE_SOURCE, "gi");
}
const ON_RE = /\bon\s+/gi;

function readName(text: string, index: number): SqlNameSpan | null {
  let cursor = skipWhitespace(text, index);
  while (cursor < text.length) {
    NAME_RE.lastIndex = cursor;
    const match = NAME_RE.exec(text);
    if (!match || match.index !== cursor) return null;
    const name = normalizeSqlObjectName(match[0]);
    if (!name) return null;
    const end = cursor + match[0].length;
    if (!OBJECT_MODIFIERS.has(name.toLowerCase())) {
      if (NOT_OBJECT_NAMES.has(name.toLowerCase())) return null;
      return { name, start: cursor, end };
    }
    cursor = skipWhitespace(text, end);
  }
  return null;
}

function addName(spans: SqlNameSpan[], named: SqlNameSpan | null): void {
  if (named) spans.push(named);
}

function namesAfterPrefixes(text: string, prefixes: readonly RegExp[], spans: SqlNameSpan[]): void {
  for (const prefix of prefixes) {
    prefix.lastIndex = 0;
    for (const match of text.matchAll(prefix)) {
      addName(spans, readName(text, (match.index ?? 0) + match[0].length));
    }
  }
}

function isCteName(cteNames: ReadonlySet<string>, name: string): boolean {
  return sqlObjectLookupKeys(name).some((key) => cteNames.has(key));
}

function rememberCteName(cteNames: Set<string>, name: string | null): void {
  if (!name) return;
  for (const key of sqlObjectLookupKeys(name)) cteNames.add(key);
}

function collectCteNames(text: string, cteNames: Set<string>): void {
  for (const match of text.matchAll(ctePattern())) {
    rememberCteName(cteNames, normalizeSqlObjectName(match[1]));
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingParen(text, open);
    if (close < 0) continue;
    collectCteNames(text.slice(open + 1, close), cteNames);
  }
}

function addFromAndJoin(text: string, cteNames: ReadonlySet<string>, spans: SqlNameSpan[]): void {
  for (const source of sqlSourceClauses(maskSqlQuotedIdentifiers(text))) {
    if (source.kind === "join" || source.kind === "apply") {
      const named = readName(text, source.end);
      if (named && !isCteName(cteNames, named.name)) spans.push(named);
      continue;
    }
    const clause = text.slice(source.end, source.clauseEnd);
    let partStart = 0;
    let depth = 0;
    const visit = (end: number): void => {
      const named = readName(clause, partStart);
      if (named && !isCteName(cteNames, named.name)) {
        spans.push({ name: named.name, start: source.end + named.start, end: source.end + named.end });
      }
      partStart = end + 1;
    };
    for (let index = 0; index < clause.length; index += 1) {
      const char = clause[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth = Math.max(0, depth - 1);
      else if (char === "," && depth === 0) visit(index);
    }
    visit(clause.length);
  }
}

/** Every FROM/USING/JOIN source in the statement's query scopes, never CTE aliases. */
export function sqlRelationReadSpans(statement: string): SqlNameSpan[] {
  const masked = maskSqlStringsAndComments(statement, { escapeStrings: true });
  const cteNames = new Set<string>();
  collectCteNames(masked, cteNames);
  const spans: SqlNameSpan[] = [];
  addFromAndJoin(masked, cteNames, spans);
  return spans;
}

function syntacticObjectSpans(statement: string): SqlNameSpan[] {
  const masked = maskSqlStringsAndComments(statement);
  const cteNames = new Set<string>();
  collectCteNames(masked, cteNames);
  const spans: SqlNameSpan[] = [];
  addFromAndJoin(masked, cteNames, spans);
  namesAfterPrefixes(masked, DEFINITION_PREFIXES, spans);
  namesAfterPrefixes(masked, TARGET_PREFIXES, spans);
  if (/^\s*create\s+(?:or\s+replace\s+)?trigger\b/i.test(masked)) {
    ON_RE.lastIndex = 0;
    for (const match of masked.matchAll(ON_RE)) {
      if (sqlParenDepthAt(masked, match.index ?? 0) > 0) continue;
      addName(spans, readName(masked, (match.index ?? 0) + match[0].length));
      break;
    }
  }
  if (/^\s*create\s+(?:unique\s+)?index\b/i.test(masked)) {
    ON_RE.lastIndex = 0;
    for (const match of masked.matchAll(ON_RE)) {
      if (sqlParenDepthAt(masked, match.index ?? 0) > 0) continue;
      addName(spans, readName(masked, (match.index ?? 0) + match[0].length));
    }
  }
  return spans;
}

/** Object-name spans in `statement`. Callers that test many offsets scan the statement once. */
export function sqlSyntacticObjectSpans(statement: string): SqlNameSpan[] {
  return syntacticObjectSpans(statement);
}

/** True when `offset` lies in one of `spans`. */
export function sqlSpanCovers(spans: readonly SqlNameSpan[], offset: number): boolean {
  return spans.some((span) => offset >= span.start && offset < span.end);
}

/** True when `offset` is inside a name SQL syntax uses as an object, not a column. */
export function sqlObjectMentionCovers(statement: string, offset: number): boolean {
  return sqlSpanCovers(sqlSyntacticObjectSpans(statement), offset);
}

/** The name a `CREATE` statement defines: `users` in `CREATE TABLE users`, `f` in `CREATE FUNCTION f`. */
export function sqlDefinedNameSpan(statement: string): SqlNameSpan | null {
  const spans: SqlNameSpan[] = [];
  namesAfterPrefixes(maskSqlStringsAndComments(statement), DEFINITION_PREFIXES, spans);
  return spans.reduce<SqlNameSpan | null>((first, span) => (!first || span.start < first.start ? span : first), null);
}

/**
 * True when every fact-level relation read of `objectName` is a routine call (`FROM get_users()`). A
 * real table read of that name in the same statement keeps the relation edge. A bare `name(` is a
 * call only when `namesIndexedRoutine` says an indexed routine carries that name: a table can have
 * the same shape, as in `FROM users (NOLOCK)`.
 */
export function sqlRelationNameIsRoutineCall(
  statement: string,
  objectName: string,
  namesIndexedRoutine: (mention: SqlRoutineMention) => boolean,
): boolean {
  const key = sqlObjectLookupKey(objectName);
  const reads = sqlRelationReadSpans(statement).filter((span) => sqlObjectLookupKey(span.name) === key);
  if (!reads.length) return false;
  const callStarts = new Set(
    findSqlRoutineMentions(statement)
      .filter(
        (mention) =>
          mention.kind === "call" &&
          sqlObjectLookupKey(mention.name) === key &&
          (!mention.speculative || namesIndexedRoutine(mention)),
      )
      .map((mention) => mention.start),
  );
  return reads.every((span) => callStarts.has(span.start));
}
