import { collectLineStartOffsets } from "../util/lines.js";
import { normalizePath } from "../util/paths.js";
import { classifySqlFile } from "./classifySqlFile.js";
import {
  createSqlObjectNameRegExp,
  maskSqlStringsAndComments,
  normalizeSqlObjectName,
  SQL_OBJECT_NAME_PATTERN,
  splitTopLevelCommaSeparated,
  sqlParenDepthAt,
} from "./lex.js";
import { sqlObjectLookupKeys } from "./lookup.js";
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

function splitSqlStatements(source: string): SqlStatementSlice[] {
  const statements: SqlStatementSlice[] = [];
  const lineStarts = lineStartsFor(source);
  let start = 0;
  let lineStart = 0;
  let i = 0;
  let lookingForStatementStart = true;
  let blockDepth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let bracketQuoted = false;
  let lineComment = false;
  let blockComment = false;
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

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 2;
        if (lookingForStatementStart) {
          start = i;
        }
        continue;
      }
      i += 1;
      continue;
    }

    if (
      i === lineStart &&
      !blockDepth &&
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
        blockComment = true;
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
      if (char === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (char === "'") singleQuoted = false;
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
      blockComment = true;
      i += 2;
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
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
      if (word === "begin") blockDepth += 1;
      if (word === "end" && blockDepth) blockDepth -= 1;
      i = wordEnd;
      continue;
    }
    if (char === ";" && !blockDepth) {
      pushStatement(i);
    }
    i += 1;
  }

  const tail = statementSlice(source, lineStarts, start, source.length);
  if (tail) statements.push(tail);
  return statements;
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

function clauseEndIndex(text: string, start: number): number {
  const rest = text.slice(start);
  const boundary = rest.search(
    /\b(?:where|group\s+by|order\s+by|having|limit|offset|returning|union|intersect|except|inner\s+join|left\s+join|right\s+join|full\s+join|cross\s+join|join)\b/i,
  );
  return boundary < 0 ? text.length : start + boundary;
}

function collectCommaSeparatedObjectsAfterKeywords(text: string, keywords: readonly string[]): string[] {
  const names: string[] = [];
  const keywordPattern = keywords.map((keyword) => keyword.replace(/\s+/g, String.raw`\s+`)).join("|");
  const re = new RegExp(String.raw`\b(?:${keywordPattern})\s+`, "gi");
  for (const match of text.matchAll(re)) {
    if (sqlParenDepthAt(text, match.index ?? 0) > 0) continue;
    const start = (match.index ?? 0) + match[0].length;
    const clause = text.slice(start, clauseEndIndex(text, start));
    for (const part of splitTopLevelCommaSeparated(clause)) {
      const name = objectAt(part, 0);
      if (name && !SQL_KEYWORDS.has(name.toLowerCase())) names.push(name);
    }
  }
  return Array.from(new Set(names));
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

  const routineName = findObjectAfter(text, /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure|trigger)\s+/i);
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
  const fromObjects = collectCommaSeparatedObjectsAfterKeywords(text, ["from", "using"]).filter(
    (name) => !isCteName(name),
  );
  const joinObjects = collectObjectsAfterKeywords(
    text,
    ["join", "inner join", "left join", "right join", "full join", "cross join"],
    { topLevelOnly: true },
  ).filter((name) => !isCteName(name));
  const primaryRead = fromObjects[0] ?? null;
  const facts: SqlFactDraft[] = [...cteReads.facts];
  for (const fromName of fromObjects) {
    facts.push({ kind: "reads_from", objectName: fromName, relatedObjectName: null });
  }
  for (const joinName of joinObjects) {
    facts.push({ kind: "joins", objectName: joinName, relatedObjectName: primaryRead });
  }
  return facts;
}

function withoutSelfRead(readFacts: SqlFactDraft[], objectName: string | null): SqlFactDraft[] {
  if (!objectName) return readFacts;
  return readFacts.filter((fact) => fact.objectName !== objectName);
}

function extractStatementFactDrafts(statementText: string): SqlFactDraft[] {
  const text = maskSqlStringsAndComments(statementText);
  const definitionFact = createDefinitionFact(text);
  if (definitionFact) {
    const constraintFacts =
      definitionFact.kind === "defines_table" ? extractCreateTableConstraintFacts(text, definitionFact.objectName) : [];
    const readFacts =
      definitionFact.kind === "defines_view" || /\bas\s+select\b/i.test(text)
        ? withoutSelfRead(extractReadFacts(text), definitionFact.objectName)
        : [];
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
