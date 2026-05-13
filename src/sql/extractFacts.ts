import { normalizePath } from "../util/paths.js";
import { classifySqlFile } from "./classifySqlFile.js";
import type { SqlFactKind, SqlFileRole, SqlStatementFact } from "./types.js";

type SqlFactDraft = {
  kind: SqlFactKind;
  objectName: string | null;
  relatedObjectName: string | null;
};

type SqlStatementSlice = {
  text: string;
  startLine: number;
  endLine: number;
};

const IDENTIFIER_PART = String.raw`(?:"(?:""|[^"])+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const OBJECT_NAME = String.raw`${IDENTIFIER_PART}(?:\s*\.\s*${IDENTIFIER_PART}){0,2}`;
const OBJECT_NAME_RE = new RegExp(OBJECT_NAME, "iy");
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

function splitSqlStatements(source: string): SqlStatementSlice[] {
  const statements: SqlStatementSlice[] = [];
  let start = 0;
  let startLine = 1;
  let line = 1;
  let i = 0;
  let lookingForStatementStart = true;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let bracketQuoted = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuote: string | null = null;

  const pushStatement = (end: number, endLine: number): void => {
    const text = source.slice(start, end).trim();
    if (text) {
      statements.push({ text, startLine, endLine });
    }
    start = end + 1;
    startLine = line;
    lookingForStatementStart = true;
  };

  while (i < source.length) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (char === "\n") {
      line += 1;
      if (lineComment) lineComment = false;
      if (lookingForStatementStart) {
        start = i + 1;
        startLine = line;
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
          startLine = line;
        }
        continue;
      }
      i += 1;
      continue;
    }

    if (lookingForStatementStart) {
      if (/\s/.test(char)) {
        start = i + 1;
        startLine = line;
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
      startLine = line;
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
    if (char === ";") {
      pushStatement(i, line);
    }
    i += 1;
  }

  const tail = source.slice(start).trim();
  if (tail) statements.push({ text: tail, startLine, endLine: line });
  return statements;
}

export function maskSqlStringsAndComments(statement: string): string {
  let out = "";
  let i = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let bracketQuoted = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuote: string | null = null;

  while (i < statement.length) {
    const char = statement[i] ?? "";
    const next = statement[i + 1] ?? "";

    if (char === "\n") {
      lineComment = false;
      out += "\n";
      i += 1;
      continue;
    }

    if (lineComment || blockComment || dollarQuote || singleQuoted) {
      if (blockComment && char === "*" && next === "/") {
        blockComment = false;
        out += "  ";
        i += 2;
        continue;
      }
      if (dollarQuote && statement.startsWith(dollarQuote, i)) {
        out += " ".repeat(dollarQuote.length);
        i += dollarQuote.length;
        dollarQuote = null;
        continue;
      }
      if (singleQuoted && char === "'" && next === "'") {
        out += "  ";
        i += 2;
        continue;
      }
      if (singleQuoted && char === "'") {
        singleQuoted = false;
      }
      out += char === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }

    if (doubleQuoted || backtickQuoted || bracketQuoted) {
      out += char;
      if (doubleQuoted && char === '"' && next === '"') {
        out += next;
        i += 2;
        continue;
      }
      if (doubleQuoted && char === '"') doubleQuoted = false;
      if (backtickQuoted && char === "`") backtickQuoted = false;
      if (bracketQuoted && char === "]") bracketQuoted = false;
      i += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      lineComment = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
      out += " ";
      i += 1;
      continue;
    }
    if (char === '"') doubleQuoted = true;
    if (char === "`") backtickQuoted = true;
    if (char === "[") bracketQuoted = true;
    if (char === "$") {
      const tagMatch = statement.slice(i).match(/^\$[A-Za-z_][\w$]*\$|^\$\$/);
      if (tagMatch?.[0]) {
        dollarQuote = tagMatch[0];
        out += " ".repeat(dollarQuote.length);
        i += dollarQuote.length;
        continue;
      }
    }
    out += char;
    i += 1;
  }
  return out;
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

function normalizeSqlIdentifierPart(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function normalizeSqlObjectName(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parts = trimmed.match(new RegExp(IDENTIFIER_PART, "g")) ?? [];
  const normalizedParts = parts.map(normalizeSqlIdentifierPart).filter(Boolean);
  if (normalizedParts.length === 0) return null;
  return normalizedParts.join(".");
}

export function sqlObjectBaseName(name: string): string {
  const parts = name.split(".").filter(Boolean);
  return parts.at(-1) ?? name;
}

function parenDepthAt(text: string, index: number): number {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const char = text[cursor];
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
  }
  return depth;
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
    if (opts?.topLevelOnly && parenDepthAt(text, match.index ?? 0) > 0) continue;
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

function splitTopLevelCommaSeparated(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function collectCommaSeparatedObjectsAfterKeywords(text: string, keywords: readonly string[]): string[] {
  const names: string[] = [];
  const keywordPattern = keywords.map((keyword) => keyword.replace(/\s+/g, String.raw`\s+`)).join("|");
  const re = new RegExp(String.raw`\b(?:${keywordPattern})\s+`, "gi");
  for (const match of text.matchAll(re)) {
    if (parenDepthAt(text, match.index ?? 0) > 0) continue;
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

function cteNameKeys(name: string): string[] {
  const normalized = name.toLowerCase();
  const baseName = sqlObjectBaseName(name).toLowerCase();
  return normalized === baseName ? [normalized] : [normalized, baseName];
}

function collectCteReads(text: string): { names: Set<string>; facts: SqlFactDraft[] } {
  const names = new Set<string>();
  const facts: SqlFactDraft[] = [];
  const ctePattern = new RegExp(
    String.raw`(?:\bwith\s+(?:recursive\s+)?|,\s*)(${OBJECT_NAME})(?:\s*\([^)]*\))?\s+as\s*\(`,
    "gi",
  );

  for (const match of text.matchAll(ctePattern)) {
    if (parenDepthAt(text, match.index ?? 0) > 0) continue;
    const name = normalizeSqlObjectName(match[1]);
    if (!name) continue;
    for (const key of cteNameKeys(name)) names.add(key);
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = findMatchingParen(text, bodyStart - 1);
    if (bodyEnd < 0) continue;
    facts.push(...extractReadFacts(text.slice(bodyStart, bodyEnd)));
  }

  return { names, facts };
}

function createDefinitionFact(text: string): SqlFactDraft | null {
  const tableName = findObjectAfter(text, /\bcreate\s+(?:(?:temporary|temp|unlogged|global\s+temporary|local\s+temporary)\s+)*table\s+(?:if\s+not\s+exists\s+)?/i);
  if (tableName) return { kind: "defines_table", objectName: tableName, relatedObjectName: null };

  const viewName = findObjectAfter(text, /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?/i);
  if (viewName) return { kind: "defines_view", objectName: viewName, relatedObjectName: null };

  const indexName = findObjectAfter(text, /\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?/i);
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
  const isCteName = (name: string): boolean => cteNameKeys(name).some((key) => cteReads.names.has(key));
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
  if (readFacts.length > 0) return readFacts;

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
    endLine: statement.endLine,
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
    const resolvedDrafts =
      drafts.length > 0
        ? drafts
        : [{ kind: "unknown_statement", objectName: null, relatedObjectName: null } satisfies SqlFactDraft];
    for (const draft of resolvedDrafts) {
      facts.push(toFact(filePath, role, statement, draft, facts.length));
    }
  }
  return facts;
}
