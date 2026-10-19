import { collectLineStartOffsets } from "../util/lines.js";
import { normalizePath } from "../util/paths.js";
import { classifySqlFile } from "./classify-sql-file.js";
import {
  createSqlObjectNameRegExp,
  maskSqlQuotedIdentifiers,
  maskSqlStringsAndComments,
  normalizeSqlObjectName,
  sqlObjectLookupKey,
  SQL_OBJECT_NAME_PATTERN,
  splitTopLevelCommaSeparated,
  sqlParenDepthAt,
  sqlQueryScopes,
  sqlSourceClauses,
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

/** Followers that close IF, LOOP, WHILE, or REPEAT, not a BEGIN block or a CASE expression. */
const SQL_COMPOUND_END = new Set(["if", "loop", "while", "repeat"]);

/** The next word at `index`, skipping whitespace only. */
function sqlWordAt(text: string, index: number): { word: string; end: number } | null {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
  if (!/[A-Za-z_]/.test(text[cursor] ?? "")) return null;
  let end = cursor + 1;
  while (/[A-Za-z0-9_$]/.test(text[end] ?? "")) end += 1;
  return { word: text.slice(cursor, end).toLowerCase(), end };
}

/**
 * Opens a BEGIN block or a CASE expression. `END IF`, `END LOOP`, `END WHILE`, and `END REPEAT`
 * close those statements. `END CASE` closes a CASE statement. A plain `END` closes the innermost
 * CASE before it closes a BEGIN, so a CASE expression cannot end a routine body.
 */
function noteSqlBlockWord(stack: SqlBlockFrame[], word: string, follower: string | null): void {
  if (word === "begin") {
    stack.push("begin");
    return;
  }
  if (word === "case") {
    stack.push("case");
    return;
  }
  if (word !== "end") return;
  if (follower !== null && SQL_COMPOUND_END.has(follower)) return;
  if (follower === "case") {
    if (stack.at(-1) === "case") stack.pop();
    return;
  }
  stack.pop();
}

/**
 * Splits SQL text into statements. PostgreSQL and SQL Server let a block comment hold block comments,
 * which `nestedComments` reads. Without it, a block comment ends at its first closing delimiter.
 */
function scanSqlStatements(source: string, nestedComments: boolean): SqlStatementScan {
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

    if (
      i === lineStart &&
      openBlocks.length === 0 &&
      !singleQuoted &&
      !doubleQuoted &&
      !backtickQuoted &&
      !bracketQuoted &&
      !dollarQuote
    ) {
      const batchSeparator = source.slice(i).match(/^[\t ]*GO(?:[\t ]*(?:--[^\r\n]*)?)?(?:\r?\n|$)/i);
      if (batchSeparator?.[0]) {
        const nextStart = i + batchSeparator[0].length;
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
      let wordEnd = i + 1;
      while (/[A-Za-z0-9_$]/.test(source[wordEnd] ?? "")) {
        wordEnd += 1;
      }
      const word = source.slice(i, wordEnd).toLowerCase();
      const follower = word === "end" ? sqlWordAt(source, wordEnd) : null;
      noteSqlBlockWord(openBlocks, word, follower?.word ?? null);
      const closesWithFollower = follower !== null && (follower.word === "case" || SQL_COMPOUND_END.has(follower.word));
      i = word === "end" && follower !== null && closesWithFollower ? follower.end : wordEnd;
      continue;
    }
    if (char === ";" && openBlocks.length === 0) {
      pushStatement(i);
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
  const scopes = sqlQueryScopes(scan);
  const names: string[] = [];
  const fromNamesByScope = new Map<number, string[]>();
  const joins: Array<{ name: string; scope: number }> = [];
  for (const clause of sqlSourceClauses(scan)) {
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
  for (const join of sources.joins) {
    if (isCteName(join.name)) continue;
    const related = join.scopeFromNames.find((name) => !isCteName(name)) ?? null;
    const key = `${sqlObjectLookupKey(join.name)}:${related === null ? "" : sqlObjectLookupKey(related)}`;
    if (seenJoins.has(key)) continue;
    seenJoins.add(key);
    facts.push({ kind: "joins", objectName: join.name, relatedObjectName: related });
  }
  return facts;
}

/**
 * The text between a routine body's `BEGIN` and its matching `END`. A `BEGIN` inside parentheses, as in
 * a parameter named `begin`, is not the body. A CASE expression and `END IF` or `END LOOP` do not close
 * it. Null when the statement has no such body. A `$$` body is already blank, so only a `BEGIN`/`END`
 * that the statement splitter kept as one statement is read.
 */
function beginEndBody(text: string): string | null {
  const scan = maskSqlQuotedIdentifiers(text);
  const stack: SqlBlockFrame[] = [];
  let parenDepth = 0;
  let bodyStart = -1;
  let cursor = 0;
  while (cursor < scan.length) {
    const char = scan[cursor] ?? "";
    if (char === "(") {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      cursor += 1;
      continue;
    }
    const previous = scan[cursor - 1] ?? "";
    if (parenDepth !== 0 || !/[A-Za-z_]/.test(char) || /[\w@#.]/.test(previous)) {
      cursor += 1;
      continue;
    }
    let wordEnd = cursor + 1;
    while (/[A-Za-z0-9_$]/.test(scan[wordEnd] ?? "")) wordEnd += 1;
    const word = scan.slice(cursor, wordEnd).toLowerCase();
    if (bodyStart < 0) {
      if (word === "begin") {
        bodyStart = wordEnd;
        stack.push("begin");
      }
      cursor = wordEnd;
      continue;
    }
    const follower = word === "end" ? sqlWordAt(scan, wordEnd) : null;
    noteSqlBlockWord(stack, word, follower?.word ?? null);
    if (stack.length === 0) return text.slice(bodyStart, cursor);
    const closesWithFollower =
      word === "end" && follower !== null && (follower.word === "case" || SQL_COMPOUND_END.has(follower.word));
    cursor = follower !== null && closesWithFollower ? follower.end : wordEnd;
  }
  return null;
}

/** Read facts of the statements inside a `BEGIN`/`END` body, split by the statement splitter. */
function readsInsideBeginEnd(masked: string): SqlFactDraft[] {
  const body = beginEndBody(masked);
  if (body === null) return [];
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
      readFacts = readsInsideBeginEnd(text);
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
