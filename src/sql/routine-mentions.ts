import {
  createSqlObjectNameRegExp,
  maskSqlQuotedIdentifiers,
  maskSqlStringsAndComments,
  normalizeSqlObjectName,
  SQL_OBJECT_NAME_PATTERN,
  splitTopLevelCommaSeparated,
  sqlParenDepthAt,
  sqlSourceClauses,
  type SqlMaskOptions,
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
const DROP_ROUTINE_RE = /^\s*drop\s+(?:function|procedure|trigger)\b/i;

const CODE_STATEMENT_RE = /^\s*(?:create\s+(?:or\s+replace\s+)?(?:function|procedure)|do)\b/i;
const DO_STATEMENT_RE = /^\s*do\b/i;
const LANGUAGE_KEYWORD_RE = /\blanguage\b/gi;
// The name a `LANGUAGE` clause gives: a bare word, a double-quoted identifier, or a string.
const LANGUAGE_NAME_RE = /^(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/;
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
// `AS (`, `AS MATERIALIZED (`, and `AS NOT MATERIALIZED (` open the body of a common table expression.
const CTE_BODY_RE = /^\s*as(?:\s+(?:not\s+)?materialized)?\s*\(/i;
const WORD_RE = /[A-Za-z_][\w$]*/y;
const WITH_ORDINALITY_RE = /with\s+ordinality\b/iy;
// A table hint is a word with an optional argument: `NOLOCK`, `INDEX (ix_users)`, `INDEX = 0`.
const TABLE_HINT_RE = /^(\w+)\s*(?:[(=][\s\S]*)?$/;
// `INSERT` and its MySQL sibling `REPLACE`, which can put modifiers before the table.
const INSERT_RE = /\b(?:insert|replace)\b/gi;
// The scanner reads PostgreSQL and SQL Server text: arrays, escape strings, and nested block comments.
const MASK_OPTIONS: SqlMaskOptions = { arrayBrackets: true, nestedBlockComments: true, escapeStrings: true };

type WordTable = Readonly<Record<string, true>>;

// The body language of a function, procedure, or `DO` block that Codegraph reads as SQL.
const BODY_LANGUAGES: WordTable = { sql: true, plpgsql: true };
// Words before a name that is followed by `(` but is a table, index, type, or routine definition,
// not a call: `INSERT INTO users (id)`, `INSERT users (id)`, `COPY users (id)`, `REFERENCES users (id)`.
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
  insert: true,
  copy: true,
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
// A PL/pgSQL `EXECUTE` runs the command string that an expression gives, so its operand is no routine.
const EXECUTE_WORDS: WordTable = { exec: true, execute: true };
// MySQL modifiers between `INSERT` and the table: `INSERT IGNORE users (id)`. T-SQL adds `TOP (n)`.
const INSERT_MODIFIERS: WordTable = { ignore: true, low_priority: true, delayed: true, high_priority: true };
// Words that follow a source in a `FROM` list without naming its alias.
const NON_ALIAS_WORDS: WordTable = {
  on: true,
  using: true,
  where: true,
  group: true,
  order: true,
  having: true,
  limit: true,
  offset: true,
  fetch: true,
  for: true,
  returning: true,
  union: true,
  intersect: true,
  except: true,
  window: true,
  with: true,
  join: true,
  inner: true,
  left: true,
  right: true,
  full: true,
  cross: true,
  natural: true,
  outer: true,
  apply: true,
  lateral: true,
  tablesample: true,
  into: true,
  option: true,
  set: true,
  values: true,
  select: true,
  from: true,
};
// T-SQL table hints, which `FROM users (NOLOCK)` puts in parentheses without `WITH`.
const TABLE_HINTS: WordTable = {
  forcescan: true,
  forceseek: true,
  holdlock: true,
  index: true,
  nolock: true,
  noexpand: true,
  nowait: true,
  paglock: true,
  readcommitted: true,
  readcommittedlock: true,
  readpast: true,
  readuncommitted: true,
  repeatableread: true,
  rowlock: true,
  serializable: true,
  snapshot: true,
  spatial_window_max_cells: true,
  tablock: true,
  tablockx: true,
  updlock: true,
  xlock: true,
};
const SOURCE_MODIFIERS: WordTable = { lateral: true, only: true };

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

/** Where the block comment that opens at `start` ends. A block comment can hold block comments. */
function blockCommentEnd(text: string, start: number): number {
  let depth = 0;
  let cursor = start;
  while (cursor < text.length) {
    if (text.startsWith("/*", cursor)) {
      depth += 1;
      cursor += 2;
    } else if (text.startsWith("*/", cursor)) {
      depth -= 1;
      cursor += 2;
      if (!depth) return cursor;
    } else {
      cursor += 1;
    }
  }
  return text.length;
}

/**
 * Skips whitespace and comments, which can sit between two tokens: between `LANGUAGE` and the language
 * name, or between `SELECT` and a column.
 */
function skipTrivia(text: string, index: number): number {
  let cursor = skipWhitespace(text, index);
  while (text.startsWith("--", cursor) || text.startsWith("/*", cursor)) {
    if (text.startsWith("--", cursor)) {
      const lineEnd = text.indexOf("\n", cursor);
      cursor = lineEnd < 0 ? text.length : lineEnd;
    } else {
      cursor = blockCommentEnd(text, cursor);
    }
    cursor = skipWhitespace(text, cursor);
  }
  return cursor;
}

/**
 * True unless the statement declares a body language that Codegraph cannot read as SQL. The last
 * `LANGUAGE` clause outside the parentheses wins: an earlier `language` can be a parameter name, as in
 * `f(language text)`. A clause whose name cannot be read counts as another language, so its body
 * stays masked.
 */
function bodyLanguageIsReadable(statementText: string, scan: string): boolean {
  const clauses = [...scan.matchAll(LANGUAGE_KEYWORD_RE)].filter((match) => !sqlParenDepthAt(scan, match.index ?? 0));
  const clause = clauses.at(-1);
  if (!clause) return true;
  const nameStart = skipTrivia(statementText, (clause.index ?? 0) + clause[0].length);
  const named = LANGUAGE_NAME_RE.exec(statementText.slice(nameStart));
  const language = named?.[1] ?? named?.[2] ?? named?.[3];
  return !!language && hasWord(BODY_LANGUAGES, language.toLowerCase());
}

/** Decides which dollar-quoted block holds the routine body: the one after `AS`, or the first of a `DO` statement. */
function routineBodyBlock(scan: string): (before: string) => boolean {
  if (DO_STATEMENT_RE.test(scan)) {
    let seen = false;
    return () => {
      const first = !seen;
      seen = true;
      return first;
    };
  }
  return (before) => {
    const code = maskSqlQuotedIdentifiers(before);
    return previousWord(code, code.length) === "as" && !sqlParenDepthAt(code, code.length);
  };
}

/**
 * Masks strings and comments. The `$$` body of a function, procedure, or `DO` block stays visible
 * when its language is SQL or PL/pgSQL. Any other `$$` string stays masked: a parameter default, a
 * setting, or the body of a language Codegraph cannot read. `inBody` is true when a body stays visible.
 */
function maskStatementCode(statementText: string): { masked: string; inBody: boolean } {
  const masked = maskSqlStringsAndComments(statementText, MASK_OPTIONS);
  if (!statementText.includes("$") || !CODE_STATEMENT_RE.test(masked)) return { masked, inBody: false };
  const scan = maskSqlQuotedIdentifiers(masked);
  if (!bodyLanguageIsReadable(statementText, scan)) return { masked, inBody: false };
  const withBody = maskSqlStringsAndComments(statementText, {
    ...MASK_OPTIONS,
    keepDollarQuotedBody: routineBodyBlock(scan),
  });
  return { masked: withBody, inBody: withBody !== masked };
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

/**
 * A `DROP` or `GRANT ... ON` statement can name several routines, as in `DROP FUNCTION f(integer), g`.
 * Each name after a comma is a mention of the same kind and name space. A parenthesized signature
 * between two names is skipped, and the list ends at the first token that is no comma.
 */
function collectTargetList(
  masked: string,
  scan: string,
  firstEnd: number,
  target: Pick<SqlRoutineMention, "kind" | "namespace">,
  mentions: Map<number, SqlRoutineMention>,
): void {
  let cursor = skipWhitespace(scan, firstEnd);
  for (;;) {
    if (scan[cursor] === "(") {
      const close = matchingParen(scan, cursor);
      if (close < 0) return;
      cursor = skipWhitespace(scan, close + 1);
    }
    if (scan[cursor] !== ",") return;
    const named = nameAt(masked, cursor + 1);
    if (!named) return;
    mentions.set(named.start, { ...named, ...target, speculative: false });
    cursor = skipWhitespace(scan, named.end);
  }
}

function collectKeywordMentions(masked: string, scan: string, mentions: Map<number, SqlRoutineMention>): void {
  const definition = SQL_ROUTINE_DEFINITION_RE.exec(scan);
  const definitionKeyword = definition?.[1];
  const definitionKeywordStart =
    definition && definitionKeyword ? definition.index + definition[0].lastIndexOf(definitionKeyword) : -1;
  for (const match of scan.matchAll(ROUTINE_KEYWORD_RE)) {
    const keywordStart = match.index ?? 0;
    const keyword = (match[1] ?? "").toLowerCase();
    const previous = previousWord(scan, keywordStart);
    const kind = keywordMentionKind(keyword, previous, keywordStart === definitionKeywordStart);
    if (!kind) continue;
    let nameFrom = keywordStart + match[0].length;
    if (kind === "drop" || kind === "reference") {
      IF_EXISTS_RE.lastIndex = skipWhitespace(scan, nameFrom);
      if (IF_EXISTS_RE.exec(scan)) nameFrom = IF_EXISTS_RE.lastIndex;
    }
    const named = nameAt(masked, nameFrom);
    if (!named) continue;
    const namespace = keyword === "trigger" ? "trigger" : "callable";
    mentions.set(named.start, { ...named, kind, namespace, speculative: false });
    // `ALTER` and `ENABLE` take one name, and a comma after it separates actions, as in
    // `DISABLE TRIGGER a, ENABLE TRIGGER b`. `DROP` and `GRANT ... ON` take a list.
    if (kind === "drop" || previous === "on") collectTargetList(masked, scan, named.end, { kind, namespace }, mentions);
  }
}

/**
 * Comments are blank in `masked`, so a comment between `CALL`/`EXEC` and the name fails a literal
 * compare. Accept that gap when every changed character is a comment. A string is blank too, but it
 * is not a comment, so `CALL 'note' norm` stays rejected.
 */
function callKeywordMatchAllowsComments(statement: string, maskedMatch: string, start: number): boolean {
  if (statement.startsWith(maskedMatch, start)) return true;
  if (start < 0 || start + maskedMatch.length > statement.length) return false;
  let depth = 0;
  let line = false;
  let index = 0;
  while (index < maskedMatch.length) {
    const original = statement[start + index] ?? "";
    const masked = maskedMatch[index] ?? "";
    const nextOriginal = statement[start + index + 1] ?? "";
    if (!depth && !line && original === "-" && nextOriginal === "-") line = true;
    // A block comment can hold block comments.
    if (!line && original === "/" && nextOriginal === "*") depth += 1;
    const inComment = depth > 0 || line;
    if (original !== masked && (!inComment || (masked !== " " && masked !== "\n"))) return false;
    if (line && original === "\n") line = false;
    if (depth && original === "*" && nextOriginal === "/") {
      const maskedSlash = maskedMatch[index + 1] ?? "";
      if (maskedSlash !== " " && maskedSlash !== "\n" && maskedSlash !== "/") return false;
      depth -= 1;
      index += 2;
      continue;
    }
    index += 1;
  }
  return true;
}

function matchingParen(text: string, openIndex: number): number {
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

function wordAt(text: string, index: number): string {
  WORD_RE.lastIndex = index;
  return WORD_RE.exec(text)?.[0].toLowerCase() ?? "";
}

/** True when a parenthesized list holds nothing but T-SQL table hints, so it is no argument list. */
function isTableHintList(content: string): boolean {
  return splitTopLevelCommaSeparated(content).every((part) => {
    const hint = TABLE_HINT_RE.exec(part.trim())?.[1];
    return !!hint && hasWord(TABLE_HINTS, hint.toLowerCase());
  });
}

/** A table hint can take an argument: `INDEX (ix_orders)` is a hint, not a call of `INDEX`. */
function excludeHintCallShapes(scan: string, open: number, close: number, excluded: Set<number>): void {
  for (const match of scan.slice(open + 1, close).matchAll(CALL_SHAPE_RE)) {
    excluded.add(open + 1 + (match.index ?? 0));
  }
}

/** A routine that a source calls: where its name is in the scanned text, and where its alias starts. */
type SourceCall = { start: number; end: number; aliasStart: number | null };

/**
 * Reads one source of a `FROM` list, `JOIN`, or `APPLY`: a name, a function call, or a parenthesized
 * query, then an optional alias with a column list. A parenthesis after the alias opens its column
 * list, and one after a name that holds only table hints opens those hints. Neither is a call; the
 * source's own arguments are. Any other parenthesis after the name makes the source a call of that
 * routine, which `calls` collects. Returns where the source ends, or -1 when no source starts at `from`.
 */
function excludeSourceItem(scan: string, from: number, excluded: Set<number>, calls?: SourceCall[]): number {
  let cursor = skipWhitespace(scan, from);
  for (let word = wordAt(scan, cursor); hasWord(SOURCE_MODIFIERS, word); word = wordAt(scan, cursor)) {
    cursor = skipWhitespace(scan, cursor + word.length);
  }
  let called: { start: number; end: number } | null = null;
  if (scan[cursor] === "(") {
    const close = matchingParen(scan, cursor);
    if (close < 0) return -1;
    cursor = close + 1;
  } else {
    const source = nameAt(scan, cursor);
    if (!source) return -1;
    cursor = skipWhitespace(scan, source.end);
    if (scan[cursor] === "(") {
      const close = matchingParen(scan, cursor);
      if (close < 0) return -1;
      if (isTableHintList(scan.slice(cursor + 1, close))) {
        excluded.add(source.start);
        excludeHintCallShapes(scan, cursor, close, excluded);
      } else {
        called = source;
      }
      cursor = close + 1;
    }
  }
  cursor = skipWhitespace(scan, cursor);
  WITH_ORDINALITY_RE.lastIndex = cursor;
  if (WITH_ORDINALITY_RE.test(scan)) cursor = skipWhitespace(scan, WITH_ORDINALITY_RE.lastIndex);
  if (wordAt(scan, cursor) === "as") cursor = skipWhitespace(scan, cursor + 2);
  const named = nameAt(scan, cursor);
  const alias = named && !hasWord(NON_ALIAS_WORDS, named.name.toLowerCase()) ? named : null;
  if (called) calls?.push({ start: called.start, end: called.end, aliasStart: alias?.start ?? null });
  if (alias) {
    cursor = skipWhitespace(scan, alias.end);
    if (scan[cursor] === "(") {
      // `FROM generate_series(1, 3) g(i)`: the parenthesis opens the alias's column list.
      excluded.add(alias.start);
      const close = matchingParen(scan, cursor);
      if (close < 0) return -1;
      cursor = skipWhitespace(scan, close + 1);
    }
  }
  // `FROM users u WITH (NOLOCK)` puts table hints after `WITH`.
  const hintsOpen = skipWhitespace(scan, cursor + 4);
  if (wordAt(scan, cursor) === "with" && scan[hintsOpen] === "(") {
    excluded.add(cursor);
    const close = matchingParen(scan, hintsOpen);
    if (close < 0) return -1;
    if (isTableHintList(scan.slice(hintsOpen + 1, close))) excludeHintCallShapes(scan, hintsOpen, close, excluded);
    return close + 1;
  }
  return cursor;
}
const JOIN_INTRO_WORDS: WordTable = {
  inner: true,
  left: true,
  right: true,
  full: true,
  cross: true,
  natural: true,
  outer: true,
};
// Words that end a join predicate and the surrounding FROM list: `ON a.id = b.id WHERE ...`.
const ON_END_WORDS: WordTable = {
  where: true,
  group: true,
  order: true,
  having: true,
  limit: true,
  offset: true,
  fetch: true,
  returning: true,
  union: true,
  intersect: true,
  except: true,
  window: true,
};

function joinIntroCanPrecede(word: string, ahead: string): boolean {
  if (ahead === "join" || ahead === "apply") return true;
  if (ahead === "outer") return word === "left" || word === "right" || word === "full" || word === "natural";
  if (word !== "natural") return false;
  return ahead === "left" || ahead === "right" || ahead === "full" || ahead === "inner" || ahead === "cross";
}

/** The `JOIN` or `APPLY` keyword at `index`, including `LEFT OUTER JOIN` and `CROSS APPLY`. */
function joinKeywordAt(scan: string, index: number): { at: number; end: number } | null {
  let cursor = skipWhitespace(scan, index);
  for (;;) {
    const word = wordAt(scan, cursor);
    if (word === "join" || word === "apply") return { at: cursor, end: cursor + word.length };
    const ahead = wordAt(scan, skipWhitespace(scan, cursor + word.length));
    if (!hasWord(JOIN_INTRO_WORDS, word) || !joinIntroCanPrecede(word, ahead)) return null;
    cursor = skipWhitespace(scan, cursor + word.length);
  }
}

/** Where the `ON` expression ends: a comma, a semicolon, a `)`, or the next clause or join. */
function skipOnExpression(scan: string, index: number): number {
  let depth = 0;
  let cursor = index;
  while (cursor < scan.length) {
    const char = scan[cursor] ?? "";
    if (char === "(") {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) return cursor;
      depth -= 1;
      cursor += 1;
      continue;
    }
    if (depth === 0 && (char === "," || char === ";")) return cursor;
    if (depth !== 0 || !/[A-Za-z_]/.test(char)) {
      cursor += 1;
      continue;
    }
    const word = wordAt(scan, cursor);
    if (!word) {
      cursor += 1;
      continue;
    }
    if (hasWord(ON_END_WORDS, word) || joinKeywordAt(scan, cursor)) return cursor;
    cursor += word.length;
  }
  return cursor;
}

function skipJoinPredicate(scan: string, index: number): number {
  const cursor = skipWhitespace(scan, index);
  const word = wordAt(scan, cursor);
  if (word === "on") return skipOnExpression(scan, cursor + word.length);
  if (word !== "using") return cursor;
  const open = skipWhitespace(scan, cursor + word.length);
  if (scan[open] !== "(") return cursor;
  const close = matchingParen(scan, open);
  return close < 0 ? scan.length : close + 1;
}

/**
 * Consumes `[type] JOIN source [ON expr | USING (...)]` chains that follow one source. Each join
 * keyword is recorded so its own source clause is not read again. Returns where the chain ends,
 * which is a comma when another source follows the predicate.
 */
function consumeJoinChain(
  scan: string,
  index: number,
  excluded: Set<number>,
  calls: SourceCall[] | undefined,
  consumedJoins: Set<number>,
): number {
  let cursor = index;
  for (;;) {
    const keyword = joinKeywordAt(scan, cursor);
    if (!keyword) return cursor;
    const next = excludeSourceItem(scan, keyword.end, excluded, calls);
    if (next < 0 || next <= keyword.end) return cursor;
    consumedJoins.add(keyword.at);
    cursor = skipJoinPredicate(scan, next);
  }
}

function collectSourceItemExclusions(scan: string, excluded: Set<number>, calls?: SourceCall[]): void {
  const consumedJoins = new Set<number>();
  for (const source of sqlSourceClauses(scan)) {
    if (consumedJoins.has(source.start)) continue;
    let cursor = source.end;
    const takesList = source.kind === "from" || source.kind === "using";
    for (;;) {
      if (!takesList && cursor >= source.clauseEnd) break;
      const next = excludeSourceItem(scan, cursor, excluded, calls);
      if (next < 0 || next <= cursor) break;
      cursor = consumeJoinChain(scan, next, excluded, calls, consumedJoins);
      if (!takesList) break;
      // `FROM a JOIN b ON a.id = b.id, generate_series(1, 3) norm(i)`: the comma is past the join
      // keyword that ended the recorded FROM slice, and `norm(i)` is the next source's column list.
      const after = skipWhitespace(scan, cursor);
      if (after >= scan.length || scan[after] !== ",") break;
      cursor = after + 1;
    }
  }
}

/**
 * Skips the modifiers after `INSERT`: `IGNORE` and `LOW_PRIORITY` in MySQL, `TOP (n) [PERCENT]` in
 * T-SQL. `TOP (n)` is no call, so it is excluded here. Returns -1 when its parenthesis is unbalanced.
 */
function skipInsertModifiers(scan: string, from: number, excluded: Set<number>): number {
  let cursor = skipWhitespace(scan, from);
  for (;;) {
    const word = wordAt(scan, cursor);
    const next = skipWhitespace(scan, cursor + word.length);
    if (hasWord(INSERT_MODIFIERS, word)) {
      cursor = next;
    } else if (word === "top" && scan[next] === "(") {
      const close = matchingParen(scan, next);
      if (close < 0) return -1;
      excluded.add(cursor);
      cursor = skipWhitespace(scan, close + 1);
      if (wordAt(scan, cursor) === "percent") cursor = skipWhitespace(scan, cursor + "percent".length);
    } else {
      return cursor;
    }
  }
}

/** `INSERT IGNORE users (id)` and `INSERT TOP (1) dbo.users (id)` name a table, not a routine. */
function excludeInsertTargets(scan: string, excluded: Set<number>): void {
  for (const keyword of scan.matchAll(INSERT_RE)) {
    let cursor = skipInsertModifiers(scan, (keyword.index ?? 0) + keyword[0].length, excluded);
    if (cursor < 0) continue;
    if (wordAt(scan, cursor) === "into") cursor = skipWhitespace(scan, cursor + "into".length);
    const target = nameAt(scan, cursor);
    if (target && scan[skipWhitespace(scan, target.end)] === "(") excluded.add(target.start);
  }
}

/**
 * Call shapes that are no calls. `CREATE INDEX ... ON table (columns)` and `WITH name(columns) AS (`
 * put a parenthesis after a name that is not a call, and so does a source in a `FROM` list with an
 * alias column list or table hints, or the table of an `INSERT` after a modifier. Those false calls
 * hide the index's table and invent a routine reference. Calls in an index expression, a join
 * predicate, a CTE body, a source's arguments, or the query of an `INSERT` are later names and stay.
 */
function excludedCallShapeStarts(scan: string): Set<number> {
  const excluded = new Set<number>();
  if (/^\s*create\s+(?:unique\s+)?index\b/i.test(scan)) {
    const onRe = /\bon\s+/gi;
    for (const match of scan.matchAll(onRe)) {
      const keywordAt = match.index ?? 0;
      if (sqlParenDepthAt(scan, keywordAt) > 0) continue;
      let cursor = keywordAt + match[0].length;
      let named = nameAt(scan, cursor);
      while (named && (named.name.toLowerCase() === "only" || named.name.toLowerCase() === "lateral")) {
        cursor = named.end;
        named = nameAt(scan, cursor);
      }
      if (!named || scan[skipWhitespace(scan, named.end)] !== "(") continue;
      excluded.add(named.start);
      break;
    }
  }
  const cteRe = new RegExp(String.raw`(?:\bwith\s+(?:recursive\s+)?|,\s*)(${SQL_OBJECT_NAME_PATTERN})\s*\(`, "gi");
  for (const match of scan.matchAll(cteRe)) {
    const rawName = match[1] ?? "";
    if (!rawName) continue;
    const matchStart = match.index ?? 0;
    const parenIndex = matchStart + match[0].length - 1;
    let nameEnd = parenIndex;
    while (nameEnd > matchStart && /\s/.test(scan[nameEnd - 1] ?? "")) nameEnd -= 1;
    const nameStart = nameEnd - rawName.length;
    if (scan.slice(nameStart, nameEnd) !== rawName) continue;
    const close = matchingParen(scan, parenIndex);
    if (close < 0 || !CTE_BODY_RE.test(scan.slice(close + 1))) continue;
    excluded.add(nameStart);
  }
  collectSourceItemExclusions(scan, excluded);
  excludeInsertTargets(scan, excluded);
  return excluded;
}

/**
 * `SELECT call audit_user FROM contacts` selects a column named `call` and aliases it. No statement
 * starts right after `SELECT`, a comma, or an opening parenthesis, so a keyword there is a column, and
 * a comment in between changes nothing. A string does: `masked` blanks strings as well as comments, but
 * `SELECT 'x'` followed by `EXEC p` in a T-SQL script without semicolons does start a statement. Only
 * whitespace and comments may sit between the keyword and the token before it.
 */
function followsExpressionStart(statementText: string, masked: string, keywordStart: number): boolean {
  let cursor = keywordStart;
  while (cursor > 0 && /\s/.test(masked[cursor - 1] ?? "")) cursor -= 1;
  if (skipTrivia(statementText, cursor) !== keywordStart) return false;
  const before = masked[cursor - 1];
  if (before === "," || before === "(") return true;
  const word = previousWord(masked, cursor);
  return word === "select" || word === "distinct";
}

function collectCallKeywordMentions(
  statementText: string,
  masked: string,
  scan: string,
  mentions: Map<number, SqlRoutineMention>,
  inBody: boolean,
): void {
  for (const match of scan.matchAll(CALL_KEYWORD_RE)) {
    // `EXECUTE cmd` in a PL/pgSQL body names a variable that holds a command, not a routine.
    if (inBody && hasWord(EXECUTE_WORDS, (match[1] ?? "").toLowerCase())) continue;
    const matchStart = match.index ?? 0;
    if (followsExpressionStart(statementText, masked, matchStart)) continue;
    const end = matchStart + match[0].length;
    if (!callKeywordMatchAllowsComments(statementText, masked.slice(matchStart, end), matchStart)) continue;
    const start = end - (match[2] ?? "").length;
    const name = normalizeSqlObjectName(masked.slice(start, end));
    if (!name || (!name.includes(".") && hasWord(NON_ROUTINE_NAME_WORDS, name.toLowerCase()))) continue;
    if (mentions.has(start)) continue;
    mentions.set(start, { name, start, end, kind: "call", namespace: "callable", speculative: false });
  }
}

/** `FILTER (WHERE ...)` filters an aggregate. It is not a call of a routine named filter. */
function isAggregateFilterClause(scan: string, nameEnd: number): boolean {
  const open = skipWhitespace(scan, nameEnd);
  if (scan.charCodeAt(open) !== 40) return false;
  return wordAt(scan, skipWhitespace(scan, open + 1)) === "where";
}

function collectCallShapeMentions(
  masked: string,
  scan: string,
  mentions: Map<number, SqlRoutineMention>,
  inBody: boolean,
): void {
  const excluded = excludedCallShapeStarts(scan);
  for (const match of scan.matchAll(CALL_SHAPE_RE)) {
    const start = match.index ?? 0;
    if (mentions.has(start) || excluded.has(start)) continue;
    const previous = previousWord(scan, start);
    // In a PL/pgSQL body `EXECUTE f(x)` calls `f` to build the command.
    const buildsCommand = inBody && !!previous && hasWord(EXECUTE_WORDS, previous);
    if (previous && hasWord(NON_CALL_PRECEDING_WORDS, previous) && !buildsCommand) continue;
    const end = start + (match[1] ?? "").length;
    const name = normalizeSqlObjectName(masked.slice(start, end));
    if (!name || (!name.includes(".") && hasWord(CALL_KEYWORDS, name.toLowerCase()))) continue;
    if (!name.includes(".") && name.toLowerCase() === "filter" && isAggregateFilterClause(scan, end)) continue;
    mentions.set(start, { name, start, end, kind: "call", namespace: "callable", speculative: true });
  }
}

/**
 * Finds every place one statement names a routine. A call inside a `$$` body or a `BEGIN ... END` body
 * counts. A name inside a string literal, a comment, or a quoted identifier does not, and neither does
 * the operand of a PL/pgSQL `EXECUTE`, which holds a command.
 */
export function findSqlRoutineMentions(statementText: string): SqlRoutineMention[] {
  const { masked, inBody } = maskStatementCode(statementText);
  // Names are read from `masked`. Keywords, calls, and parentheses are read from `scan`, where a
  // quoted identifier is one bare word and nothing inside it can read as syntax.
  const scan = maskSqlQuotedIdentifiers(masked);
  const mentions = new Map<number, SqlRoutineMention>();
  collectKeywordMentions(masked, scan, mentions);
  collectCallKeywordMentions(statementText, masked, scan, mentions, inBody);
  collectCallShapeMentions(masked, scan, mentions, inBody);
  return [...mentions.values()].sort((left, right) => left.start - right.start);
}

/**
 * A routine that a `FROM` list, `JOIN`, or `APPLY` reads as a source, as `get_users()` does in
 * `FROM get_users() AS u`. The mention has the shape `name(`, so it names a routine only when an
 * indexed routine has that name. `alias` is the name that follows the source, if any.
 */
export type SqlRoutineSource = { mention: SqlRoutineMention; alias: string | null };

/**
 * The routines one statement calls as sources. A column qualified with a source's alias, or with its
 * own name when it has none, as in `SELECT get_users.id FROM get_users()`, belongs to the routine's
 * result and not to a table of that name.
 */
export function findSqlRoutineSources(statementText: string): SqlRoutineSource[] {
  const { masked } = maskStatementCode(statementText);
  const calls: SourceCall[] = [];
  collectSourceItemExclusions(maskSqlQuotedIdentifiers(masked), new Set(), calls);
  const sources: SqlRoutineSource[] = [];
  for (const call of calls) {
    const named = nameAt(masked, call.start);
    if (!named) continue;
    const alias = call.aliasStart === null ? null : (nameAt(masked, call.aliasStart)?.name ?? null);
    sources.push({ mention: { ...named, kind: "call", namespace: "callable", speculative: true }, alias });
  }
  return sources;
}

/** The name space of the routine that a `CREATE FUNCTION`, `CREATE PROCEDURE`, or `CREATE TRIGGER` statement defines. */
export function sqlRoutineDefinitionNamespace(statementText: string): SqlRoutineNamespace {
  const keyword = SQL_ROUTINE_DEFINITION_RE.exec(maskSqlStringsAndComments(statementText))?.[1];
  return keyword?.toLowerCase() === "trigger" ? "trigger" : "callable";
}

/**
 * True for `DROP FUNCTION`, `DROP PROCEDURE`, and `DROP TRIGGER`. Fact extraction records the dropped
 * name as a `drops_object` fact, which says nothing about the kind of the object. A table of the same
 * name is not dropped. A comment can sit between the words, so the check reads the masked text.
 */
export function sqlStatementDropsRoutine(statementText: string): boolean {
  return /\bdrop\b/i.test(statementText) && DROP_ROUTINE_RE.test(maskSqlStringsAndComments(statementText));
}
