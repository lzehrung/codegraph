import fsp from "node:fs/promises";
import path from "node:path";

import { createNavigationProvenance, okGoToResult } from "../indexer/navigation-provenance.js";
import type {
  FindReferencesResult,
  GoToRequest,
  GoToResult,
  ProjectIndex,
  Reference,
  SymbolDef,
} from "../indexer/types.js";
import type { Range } from "../types.js";
import { normalizePath } from "../util/paths.js";
import { extractSqlFactsFromSource } from "./extractFacts.js";
import { pushSqlLookupValue } from "./lookup.js";
import {
  maskSqlStringsAndComments,
  normalizeSqlObjectName,
  SQL_IDENTIFIER_PART_PATTERN,
  splitTopLevelCommaSeparated,
  sqlObjectBaseName,
  sqlParenDepthAt,
} from "./lex.js";
import type { SqlStatementFact } from "./types.js";

type SqlStatementNavigationSlice = {
  text: string;
  startLine: number;
  startColumn: number;
  endLine: number;
};

type SqlDefinitionLookup = {
  exact: Map<string, SymbolDef[]>;
  basename: Map<string, SymbolDef[]>;
};

function isSqlFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".sql";
}

function rangeForLine(line: number): Range {
  return {
    start: { line, column: 1 },
    end: { line, column: 1 },
  };
}

function rangeForToken(line: number, column: number): Range {
  return {
    start: { line, column },
    end: { line, column },
  };
}

function sqlFiles(index: ProjectIndex): string[] {
  return Array.from(index.byFile.keys())
    .filter(isSqlFile)
    .sort((left, right) => left.localeCompare(right));
}

function getSqlNavigationCache(index: ProjectIndex): NonNullable<ProjectIndex["sqlNavigation"]> {
  index.sqlNavigation ??= {
    sourceByFile: new Map(),
    factsByFile: new Map(),
  };
  return index.sqlNavigation;
}

function getSqlDefinitionLookup(index: ProjectIndex): SqlDefinitionLookup {
  const cache = getSqlNavigationCache(index);
  if (cache.definitionLookup) return cache.definitionLookup;
  const exact = new Map<string, SymbolDef[]>();
  const basename = new Map<string, SymbolDef[]>();
  for (const file of sqlFiles(index)) {
    const module = index.byFile.get(file);
    if (!module) continue;
    for (const local of module.locals) {
      pushSqlLookupValue(exact, local.localName.toLowerCase(), local);
      pushSqlLookupValue(basename, sqlObjectBaseName(local.localName).toLowerCase(), local);
    }
  }
  cache.definitionLookup = { exact, basename };
  return cache.definitionLookup;
}

function sqlDefinitionsFromLookup(lookup: SqlDefinitionLookup, objectName: string): SymbolDef[] {
  const normalizedName = objectName.toLowerCase();
  const basenameKey = sqlObjectBaseName(objectName).toLowerCase();
  const exactDefinitions = lookup.exact.get(normalizedName) ?? [];
  const basenameDefinitions = lookup.basename.get(basenameKey) ?? [];
  if (exactDefinitions.length) return exactDefinitions;
  return basenameDefinitions.length === 1 ? basenameDefinitions : [];
}

function preferredSqlDefinition(definitions: SymbolDef[], currentFile: string): SymbolDef | null {
  const currentFileDefinitions = definitions.filter((definition) => definition.file === currentFile);
  if (currentFileDefinitions.length === 1) return currentFileDefinitions[0] ?? null;
  if (currentFileDefinitions.length > 1) return null;
  if (definitions.length === 1) return definitions[0] ?? null;
  return null;
}

function sqlDefinitionMatches(
  lookup: SqlDefinitionLookup,
  objectName: string,
): { exact: SymbolDef[]; basename: SymbolDef[] } {
  const normalizedName = objectName.toLowerCase();
  const basenameKey = sqlObjectBaseName(objectName).toLowerCase();
  const exact = lookup.exact.get(normalizedName) ?? [];
  const basename = lookup.basename.get(basenameKey) ?? [];
  return { exact, basename };
}

const SQL_IDENTIFIER = SQL_IDENTIFIER_PART_PATTERN;
const SQL_DOTTED_TOKEN = String.raw`${SQL_IDENTIFIER}(?:\s*\.\s*${SQL_IDENTIFIER})*`;
const SQL_DOTTED_TOKEN_RE = new RegExp(SQL_DOTTED_TOKEN, "g");
const SQL_SOURCE_KEYWORDS = new Set([
  "as",
  "on",
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "returning",
]);
const SQL_SOURCE_MODIFIERS = new Set(["only", "lateral"]);
const SQL_SOURCE_BOUNDARY_RE =
  /\b(?:where|group\s+by|order\s+by|having|limit|offset|returning|union|intersect|except|on|inner\s+join|left\s+join|right\s+join|full\s+join|cross\s+join|join)\b/i;

function wordAtPosition(source: string, line: number, column: number): string | null {
  const lineText = maskSqlStringsAndComments(source).split(/\r?\n/)[line - 1];
  if (!lineText) return null;
  const zeroBasedColumn = Math.max(0, column - 1);
  for (const match of lineText.matchAll(SQL_DOTTED_TOKEN_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (zeroBasedColumn >= start && zeroBasedColumn < end) return normalizeSqlObjectName(match[0]);
  }
  return null;
}

function sqlObjectNameParts(name: string): string[] {
  return name
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function sqlStatementSlices(facts: readonly SqlStatementFact[]): SqlStatementNavigationSlice[] {
  const slices: SqlStatementNavigationSlice[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    const key = `${fact.startLine}:${fact.endLine}:${fact.statementText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slices.push({
      text: fact.statementText,
      startLine: fact.startLine,
      startColumn: fact.startColumn,
      endLine: fact.endLine,
    });
  }
  return slices.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
}

function sqlStatementAtLine(facts: readonly SqlStatementFact[], line: number): SqlStatementNavigationSlice | null {
  return (
    sqlStatementSlices(facts).find((statement) => line >= statement.startLine && line <= statement.endLine) ?? null
  );
}

function sourceClauseEndIndex(text: string, start: number): number {
  const boundary = text.slice(start).search(SQL_SOURCE_BOUNDARY_RE);
  return boundary < 0 ? text.length : start + boundary;
}

function cteNamesForStatement(text: string): Set<string> {
  const cteNames = new Set<string>();
  const cteRe = new RegExp(
    String.raw`(?:\bwith\s+(?:recursive\s+)?|,\s*)(${SQL_IDENTIFIER})(?:\s*\([^)]*\))?\s+as\s*\(`,
    "gi",
  );
  for (const match of text.matchAll(cteRe)) {
    if (sqlParenDepthAt(text, match.index ?? 0) > 0) continue;
    const name = normalizeSqlObjectName(match[1]);
    if (!name) continue;
    cteNames.add(name.toLowerCase());
    cteNames.add(sqlObjectBaseName(name).toLowerCase());
  }
  return cteNames;
}

function parseSqlSourceEntry(entry: string): { objectName: string; aliasName: string | null } | null {
  const trimmed = entry.trim();
  if (!trimmed || trimmed.startsWith("(")) return null;
  const tokenRe = new RegExp(SQL_DOTTED_TOKEN, "gy");
  let cursor = 0;
  let objectName: string | null = null;
  while (cursor < trimmed.length) {
    tokenRe.lastIndex = cursor;
    const match = tokenRe.exec(trimmed);
    if (!match) return null;
    const normalized = normalizeSqlObjectName(match[0]);
    if (!normalized) return null;
    cursor = match.index + match[0].length;
    if (!SQL_SOURCE_MODIFIERS.has(normalized.toLowerCase())) {
      objectName = normalized;
      break;
    }
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor] ?? "")) cursor += 1;
  }
  if (!objectName) return null;

  let rest = trimmed.slice(cursor).trimStart();
  if (rest.startsWith(".")) return null;
  if (/^as\b/i.test(rest)) rest = rest.replace(/^as\b/i, "").trimStart();
  const aliasMatch = new RegExp(String.raw`^(${SQL_IDENTIFIER})`, "i").exec(rest);
  const aliasName = normalizeSqlObjectName(aliasMatch?.[1]) ?? null;
  if (!aliasName || SQL_SOURCE_KEYWORDS.has(aliasName.toLowerCase())) {
    return { objectName, aliasName: null };
  }
  return { objectName, aliasName };
}

function sqlAliasMapForStatement(statementText: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const cteNames = cteNamesForStatement(statementText);
  const clauseRe = /\b(?:from|using|join|inner\s+join|left\s+join|right\s+join|full\s+join|cross\s+join)\s+/gi;
  for (const match of statementText.matchAll(clauseRe)) {
    if (sqlParenDepthAt(statementText, match.index ?? 0) > 0) continue;
    const start = (match.index ?? 0) + match[0].length;
    const clause = statementText.slice(start, sourceClauseEndIndex(statementText, start));
    for (const part of splitTopLevelCommaSeparated(clause)) {
      const parsed = parseSqlSourceEntry(part);
      if (!parsed?.aliasName) continue;
      const objectKey = parsed.objectName.toLowerCase();
      const objectBaseKey = sqlObjectBaseName(parsed.objectName).toLowerCase();
      if (cteNames.has(objectKey) || cteNames.has(objectBaseKey)) continue;
      aliases.set(parsed.aliasName.toLowerCase(), parsed.objectName);
    }
  }
  return aliases;
}

function unambiguousSqlPrefixDefinitionName(lookup: SqlDefinitionLookup, objectName: string): string | null {
  const matches = sqlDefinitionMatches(lookup, objectName);
  if (matches.exact.length === 1) return matches.exact[0]?.localName ?? null;
  if (matches.exact.length > 1) return null;
  if (matches.basename.length === 1) return matches.basename[0]?.localName ?? null;
  return null;
}

function resolveQualifiedSqlName(
  lookup: SqlDefinitionLookup,
  name: string,
  statementText: string | null,
): string | null {
  if (sqlDefinitionsFromLookup(lookup, name).length) return name;
  const parts = sqlObjectNameParts(name);
  if (parts.length < 2) return name;
  const firstPart = parts[0];
  if (!firstPart) return null;
  if (statementText) {
    const maskedStatementText = maskSqlStringsAndComments(statementText);
    if (cteNamesForStatement(maskedStatementText).has(firstPart.toLowerCase())) return null;
    const aliasTarget = sqlAliasMapForStatement(maskedStatementText).get(firstPart.toLowerCase());
    if (aliasTarget && sqlDefinitionsFromLookup(lookup, aliasTarget).length) return aliasTarget;
  }
  for (let partCount = parts.length - 1; partCount >= 1; partCount -= 1) {
    const candidate = parts.slice(0, partCount).join(".");
    const resolvedName = unambiguousSqlPrefixDefinitionName(lookup, candidate);
    if (resolvedName) return resolvedName;
  }
  return null;
}

function statementLineForOffset(statement: SqlStatementNavigationSlice, offset: number): number {
  const beforeToken = statement.text.slice(0, offset);
  const lineOffset = beforeToken.split(/\r?\n/).length - 1;
  return statement.startLine + lineOffset;
}

function statementColumnForOffset(statement: SqlStatementNavigationSlice, offset: number): number {
  const beforeToken = statement.text.slice(0, offset);
  const lastLineStart = Math.max(beforeToken.lastIndexOf("\n"), beforeToken.lastIndexOf("\r"));
  if (lastLineStart < 0) return statement.startColumn + offset;
  return offset - lastLineStart;
}

function matchesSqlDefinitionName(name: string, targetNames: ReadonlySet<string>): boolean {
  const normalized = name.toLowerCase();
  const baseName = sqlObjectBaseName(name).toLowerCase();
  return targetNames.has(normalized) || targetNames.has(baseName);
}

function prefixMatchesSqlDefinition(
  lookup: SqlDefinitionLookup,
  prefix: string,
  targetNames: ReadonlySet<string>,
): boolean {
  const matches = sqlDefinitionMatches(lookup, prefix);
  if (matches.exact.length) {
    return matches.exact.some((definition) => matchesSqlDefinitionName(definition.localName, targetNames));
  }
  if (matches.basename.length !== 1) return false;
  return matchesSqlDefinitionName(matches.basename[0]?.localName ?? "", targetNames);
}

function qualifiedReferenceRanges(
  lookup: SqlDefinitionLookup,
  statement: SqlStatementNavigationSlice,
  targetNames: ReadonlySet<string>,
): Range[] {
  const ranges: Range[] = [];
  const maskedStatementText = maskSqlStringsAndComments(statement.text);
  const aliases = sqlAliasMapForStatement(maskedStatementText);
  const cteNames = cteNamesForStatement(maskedStatementText);
  for (const match of maskedStatementText.matchAll(SQL_DOTTED_TOKEN_RE)) {
    const token = normalizeSqlObjectName(match[0]);
    if (!token) continue;
    const parts = sqlObjectNameParts(token);
    if (parts.length < 2) continue;
    const firstPart = parts[0];
    if (!firstPart) continue;
    if (cteNames.has(firstPart.toLowerCase())) continue;
    const aliasTarget = aliases.get(firstPart.toLowerCase());
    const matchesAlias = aliasTarget ? matchesSqlDefinitionName(aliasTarget, targetNames) : false;
    let matchesPrefix = false;
    for (let partCount = parts.length - 1; partCount >= 1 && !matchesPrefix; partCount -= 1) {
      const candidate = parts.slice(0, partCount).join(".");
      matchesPrefix = prefixMatchesSqlDefinition(lookup, candidate, targetNames);
    }
    if (!matchesAlias && !matchesPrefix) continue;
    const offset = match.index ?? 0;
    ranges.push(rangeForToken(statementLineForOffset(statement, offset), statementColumnForOffset(statement, offset)));
  }
  return ranges;
}

async function sourceForFile(filePath: string, index: ProjectIndex): Promise<string> {
  const cache = getSqlNavigationCache(index);
  const cached = cache.sourceByFile.get(filePath);
  if (cached !== undefined) return cached;
  const parsed = index.parsed?.get(filePath);
  const source = parsed ? parsed.source : await fsp.readFile(filePath, "utf8");
  cache.sourceByFile.set(filePath, source);
  return source;
}

async function sqlFactsForFile(index: ProjectIndex, filePath: string): Promise<SqlStatementFact[]> {
  const cache = getSqlNavigationCache(index);
  const cached = cache.factsByFile.get(filePath);
  if (cached) return cached;
  const facts = extractSqlFactsFromSource(filePath, await sourceForFile(filePath, index));
  cache.factsByFile.set(filePath, facts);
  return facts;
}

export async function goToSqlDefinition(index: ProjectIndex, req: GoToRequest): Promise<GoToResult | null> {
  if (!isSqlFile(req.file)) return null;
  const source = await sourceForFile(req.file, index);
  const name = wordAtPosition(source, req.line, req.column);
  if (!name) return { status: "not_found", reason: "No SQL object at position" };
  const lookup = getSqlDefinitionLookup(index);
  const facts = await sqlFactsForFile(index, req.file);
  const statement = sqlStatementAtLine(facts, req.line);
  const resolvedName = resolveQualifiedSqlName(lookup, name, statement?.text ?? null);
  if (!resolvedName) return { status: "not_found", reason: "No matching SQL object definition" };
  const definitions = sqlDefinitionsFromLookup(lookup, resolvedName);
  const preferred = preferredSqlDefinition(definitions, normalizePath(req.file));
  if (!preferred) return { status: "not_found", reason: "No matching SQL object definition" };
  return okGoToResult(index, preferred, {
    resolution: "exact",
    confidence: "high",
  });
}

export async function findSqlReferences(
  index: ProjectIndex,
  definition: SymbolDef,
): Promise<FindReferencesResult | null> {
  if (!isSqlFile(definition.file)) return null;
  const objectName = definition.localName;
  const targetNames = new Set([objectName.toLowerCase(), sqlObjectBaseName(objectName).toLowerCase()]);
  const references: Reference[] = [];
  const seen = new Set<string>();
  const lookup = getSqlDefinitionLookup(index);
  for (const file of sqlFiles(index)) {
    const facts = await sqlFactsForFile(index, file);
    for (const fact of facts) {
      const names = new Set<string>();
      for (const name of [fact.objectName, fact.relatedObjectName]) {
        if (!name) continue;
        names.add(name.toLowerCase());
        names.add(sqlObjectBaseName(name).toLowerCase());
      }
      const matchesDefinition = Array.from(names).some((name) => targetNames.has(name));
      if (!matchesDefinition) continue;
      const range = rangeForLine(fact.startLine);
      const key = `${file}:${range.start.line}:${range.start.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ file, range });
    }
    for (const statement of sqlStatementSlices(facts)) {
      for (const range of qualifiedReferenceRanges(lookup, statement, targetNames)) {
        const key = `${file}:${range.start.line}:${range.start.column}`;
        if (seen.has(key)) continue;
        seen.add(key);
        references.push({ file, range });
      }
    }
  }
  references.sort((left, right) => {
    const fileCompare = left.file.localeCompare(right.file);
    if (fileCompare !== 0) return fileCompare;
    return left.range.start.line - right.range.start.line;
  });
  return {
    status: "ok",
    definition,
    references,
    provenance: createNavigationProvenance(index, "exact", "high"),
  };
}
