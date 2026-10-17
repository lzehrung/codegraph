import {
  createSqlObjectNameRegExp,
  maskSqlStringsAndComments,
  normalizeSqlObjectName,
  SQL_OBJECT_NAME_PATTERN,
} from "./lex.js";

/**
 * SQL keeps routines in name spaces of their own. A call names a function or a procedure
 * (`callable`). A trigger has a separate name space: a call never names a trigger, and one
 * function often shares its name with several per-table triggers.
 */
export type SqlRoutineNamespace = "callable" | "trigger";

/**
 * - `definition`: `CREATE FUNCTION name`, `CREATE PROCEDURE name`, or `CREATE TRIGGER name`.
 * - `drop`: `DROP FUNCTION name`, `DROP PROCEDURE name`, or `DROP TRIGGER name`.
 * - `reference`: another statement about an existing routine, such as `ALTER FUNCTION name`,
 *   `COMMENT ON FUNCTION name`, `GRANT ... ON FUNCTION name`, or `ENABLE TRIGGER name`.
 * - `call`: `name(`, `CALL name`, `EXEC name`, or `EXECUTE FUNCTION name()`.
 */
export type SqlRoutineMentionKind = "definition" | "drop" | "reference" | "call";

export type SqlRoutineMention = {
  /** The routine name as written, normalized like an object name, for example `app.normalize_email`. */
  name: string;
  /** Offset of the first character of the name in the statement text. */
  start: number;
  /** Offset after the last character of the name in the statement text. */
  end: number;
  kind: SqlRoutineMentionKind;
  namespace: SqlRoutineNamespace;
  /**
   * True when only the shape `name(` marks a call. A table, index, or type name can have the same
   * shape, so such a mention names a routine only when an indexed routine has that name.
   */
  speculative: boolean;
};

/** The statement head that defines a routine. Fact extraction and mention scanning share it. */
export const SQL_ROUTINE_DEFINITION_RE = /\bcreate\s+(?:or\s+replace\s+)?(function|procedure|trigger)\s+/i;

const CODE_STATEMENT_RE = /^\s*(?:create\s+(?:or\s+replace\s+)?(?:function|procedure)|do)\b/i;
const LANGUAGE_NAME_RE = /^\s+(?:'([A-Za-z_]\w*)'|([A-Za-z_]\w*))/;
const ROUTINE_KEYWORD_RE = /\b(function|procedure|routine|trigger)\b/gi;
const IF_EXISTS_RE = /if\s+exists\s+/iy;
const NAME_RE = createSqlObjectNameRegExp("y");
// A name must not continue a longer word, a dotted name, a variable, or a `::` cast.
const NAME_BOUNDARY = String.raw`(?<![\w$@#:.])`;
const CALL_KEYWORD_RE = new RegExp(
  String.raw`${NAME_BOUNDARY}(call|exec(?:ute)?)\s+(?:@[A-Za-z_]\w*\s*=\s*)?(${SQL_OBJECT_NAME_PATTERN})`,
  "gi",
);
const CALL_SHAPE_RE = new RegExp(String.raw`${NAME_BOUNDARY}(${SQL_OBJECT_NAME_PATTERN})\s*\(`, "g");

type WordTable = Readonly<Record<string, true>>;

// The body language of a function, procedure, or `DO` block that Codegraph reads as SQL.
const BODY_LANGUAGES: WordTable = { sql: true, plpgsql: true };
// Words before a name that is followed by `(` but is a table, index, type, or routine definition,
// not a call: `INSERT INTO users (id)`, `REFERENCES users (id)`, `CAST(x AS numeric(10, 2))`.
const NON_CALL_PRECEDING_WORDS: WordTable = {
  table: true,
  view: true,
  into: true,
  references: true,
  index: true,
  type: true,
  sequence: true,
  schema: true,
  only: true,
  as: true,
  exists: true,
  function: true,
  procedure: true,
  routine: true,
  trigger: true,
  call: true,
  exec: true,
  execute: true,
};
// Words after `EXEC`, `EXECUTE`, or `CALL` that do not name a routine: `EXECUTE AS`, `GRANT EXECUTE ON`.
const NON_ROUTINE_NAME_WORDS: WordTable = {
  as: true,
  on: true,
  to: true,
  with: true,
  from: true,
  where: true,
  into: true,
  set: true,
  order: true,
  group: true,
  limit: true,
  using: true,
  select: true,
  values: true,
  function: true,
  procedure: true,
};
// Words before `FUNCTION`, `PROCEDURE`, `ROUTINE`, or `TRIGGER` in a statement about an existing routine.
const REFERENCE_PRECEDING_WORDS: WordTable = { alter: true, on: true, enable: true, disable: true };
// A bare `CALL (`, `EXEC (`, or `EXECUTE (` is the keyword, not a routine of that name.
const CALL_KEYWORDS: WordTable = { call: true, exec: true, execute: true };

function hasWord(table: WordTable, word: string): boolean {
  return Object.hasOwn(table, word);
}

function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function previousWord(text: string, index: number): string | undefined {
  let end = index;
  while (end > 0 && /\s/.test(text[end - 1] ?? "")) end -= 1;
  let start = end;
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1] ?? "")) start -= 1;
  return start < end ? text.slice(start, end).toLowerCase() : undefined;
}

function nameAt(text: string, index: number): { name: string; start: number; end: number } | null {
  const start = skipWhitespace(text, index);
  NAME_RE.lastIndex = start;
  const match = NAME_RE.exec(text);
  if (!match) return null;
  const name = normalizeSqlObjectName(match[0]);
  return name ? { name, start, end: start + match[0].length } : null;
}

// The last LANGUAGE clause wins: an earlier `language` can be a parameter name, as in `f(language text)`.
function declaredBodyLanguage(statementText: string, masked: string): string | undefined {
  for (const match of [...masked.matchAll(/\blanguage\b/gi)].reverse()) {
    const named = LANGUAGE_NAME_RE.exec(statementText.slice((match.index ?? 0) + match[0].length));
    const language = named?.[1] ?? named?.[2];
    if (language) return language.toLowerCase();
  }
  return undefined;
}

/**
 * Masks strings and comments. The `$$` body of a function, procedure, or `DO` block stays visible
 * when its language is SQL or PL/pgSQL. The body of any other language is code Codegraph cannot read.
 */
function maskStatementCode(statementText: string): string {
  const masked = maskSqlStringsAndComments(statementText);
  if (!statementText.includes("$") || !CODE_STATEMENT_RE.test(masked)) return masked;
  const language = declaredBodyLanguage(statementText, masked);
  if (language && !hasWord(BODY_LANGUAGES, language)) return masked;
  return maskSqlStringsAndComments(statementText, { dollarQuotedCode: true });
}

function keywordMentionKind(
  keyword: string,
  previous: string | undefined,
  isDefinition: boolean,
): SqlRoutineMentionKind | null {
  if (isDefinition) return "definition";
  if (previous === "exec" || previous === "execute")
    return keyword === "function" || keyword === "procedure" ? "call" : null;
  if (previous === "drop") return "drop";
  return previous && hasWord(REFERENCE_PRECEDING_WORDS, previous) ? "reference" : null;
}

function collectKeywordMentions(masked: string, mentions: Map<number, SqlRoutineMention>): void {
  const definition = SQL_ROUTINE_DEFINITION_RE.exec(masked);
  const definitionKeyword = definition?.[1];
  const definitionKeywordStart =
    definition && definitionKeyword ? definition.index + definition[0].lastIndexOf(definitionKeyword) : -1;
  for (const match of masked.matchAll(ROUTINE_KEYWORD_RE)) {
    const keywordStart = match.index ?? 0;
    const keyword = (match[1] ?? "").toLowerCase();
    const previous = previousWord(masked, keywordStart);
    const kind = keywordMentionKind(keyword, previous, keywordStart === definitionKeywordStart);
    if (!kind) continue;
    let nameFrom = keywordStart + match[0].length;
    if (kind === "drop" || kind === "reference") {
      IF_EXISTS_RE.lastIndex = skipWhitespace(masked, nameFrom);
      if (IF_EXISTS_RE.exec(masked)) nameFrom = IF_EXISTS_RE.lastIndex;
    }
    const named = nameAt(masked, nameFrom);
    if (!named) continue;
    const namespace = keyword === "trigger" ? "trigger" : "callable";
    mentions.set(named.start, { ...named, kind, namespace, speculative: false });
  }
}

function collectCallKeywordMentions(
  statementText: string,
  masked: string,
  mentions: Map<number, SqlRoutineMention>,
): void {
  for (const match of masked.matchAll(CALL_KEYWORD_RE)) {
    const matchStart = match.index ?? 0;
    // A string or comment between the keyword and the name is blank in `masked`, so the name is not next to the keyword.
    if (!statementText.startsWith(match[0], matchStart)) continue;
    const rawName = match[2] ?? "";
    const name = normalizeSqlObjectName(rawName);
    if (!name || (!name.includes(".") && hasWord(NON_ROUTINE_NAME_WORDS, name.toLowerCase()))) continue;
    const start = matchStart + match[0].length - rawName.length;
    if (mentions.has(start)) continue;
    const end = start + rawName.length;
    mentions.set(start, { name, start, end, kind: "call", namespace: "callable", speculative: false });
  }
}

function collectCallShapeMentions(masked: string, mentions: Map<number, SqlRoutineMention>): void {
  for (const match of masked.matchAll(CALL_SHAPE_RE)) {
    const start = match.index ?? 0;
    if (mentions.has(start)) continue;
    const previous = previousWord(masked, start);
    if (previous && hasWord(NON_CALL_PRECEDING_WORDS, previous)) continue;
    const rawName = match[1] ?? "";
    const name = normalizeSqlObjectName(rawName);
    if (!name || (!name.includes(".") && hasWord(CALL_KEYWORDS, name.toLowerCase()))) continue;
    const end = start + rawName.length;
    mentions.set(start, { name, start, end, kind: "call", namespace: "callable", speculative: true });
  }
}

/**
 * Finds every place one statement names a routine. A call inside a `$$` body or a `BEGIN ... END` body
 * counts. A name inside a string literal or a comment does not.
 */
export function findSqlRoutineMentions(statementText: string): SqlRoutineMention[] {
  const masked = maskStatementCode(statementText);
  const mentions = new Map<number, SqlRoutineMention>();
  collectKeywordMentions(masked, mentions);
  collectCallKeywordMentions(statementText, masked, mentions);
  collectCallShapeMentions(masked, mentions);
  return [...mentions.values()].sort((left, right) => left.start - right.start);
}

/** The name space of the routine that a `CREATE FUNCTION`, `CREATE PROCEDURE`, or `CREATE TRIGGER` statement defines. */
export function sqlRoutineDefinitionNamespace(statementText: string): SqlRoutineNamespace {
  const keyword = SQL_ROUTINE_DEFINITION_RE.exec(maskSqlStringsAndComments(statementText))?.[1];
  return keyword?.toLowerCase() === "trigger" ? "trigger" : "callable";
}

/**
 * True for `DROP FUNCTION`, `DROP PROCEDURE`, and `DROP TRIGGER`. Fact extraction records the dropped
 * name as a `drops_object` fact, which says nothing about the kind of the object. A table of the same
 * name is not dropped.
 */
export function sqlStatementDropsRoutine(statementText: string): boolean {
  return /^drop\s+(?:function|procedure|trigger)\b/i.test(statementText);
}
