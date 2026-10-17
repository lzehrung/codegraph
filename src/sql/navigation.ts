import fsp from "node:fs/promises";
import path from "node:path";

import { createNavigationProvenance, okGoToResult } from "../indexer/navigation-provenance.js";
import { buildIndexedCandidateCoverage } from "../indexer/navigation-references.js";
import type {
  FindReferencesResult,
  GoToRequest,
  GoToResult,
  ProjectIndex,
  Reference,
  SymbolDef,
} from "../indexer/types.js";
import { SymbolKind } from "../indexer/types.js";
import type { Range } from "../types.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { extractSqlFactsFromSource } from "./extract-facts.js";
import {
  addSqlDefinition,
  createSqlDefinitionIndex,
  sqlRoutineNameCandidates,
  type SqlDefinitionIndex,
} from "./lookup.js";
import {
  maskSqlStringsAndComments,
  normalizeSqlObjectName,
  SQL_IDENTIFIER_PART_PATTERN,
  splitTopLevelCommaSeparated,
  sqlObjectBaseNameLookupKey,
  sqlObjectLookupKey,
  sqlParenDepthAt,
} from "./lex.js";
import {
  findSqlRoutineMentions,
  sqlRoutineDefinitionNamespace,
  sqlStatementDropsRoutine,
  type SqlRoutineMention,
  type SqlRoutineNamespace,
} from "./routine-mentions.js";
import type { SqlStatementFact } from "./types.js";

type SqlStatementNavigationSlice = {
  text: string;
  startLine: number;
  startColumn: number;
  endLine: number;
};

type SqlDefinitionLookup = SqlDefinitionIndex<SymbolDef>;

/** Function, procedure, and trigger definitions. Each has its own name space; none is a table or view. */
type SqlRoutineLookups = {
  callable: SqlDefinitionLookup;
  trigger: SqlDefinitionLookup;
  namespaceByDefinition: Map<SymbolDef, SqlRoutineNamespace>;
  definitionByStart: Map<string, SymbolDef>;
};

type SqlStatementMentions = {
  statement: SqlStatementNavigationSlice;
  mentions: readonly SqlRoutineMention[];
};

function isSqlFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".sql";
}

function rangeForToken(line: number, column: number, length: number): Range {
  return {
    start: { line, column },
    end: { line, column: column + length },
  };
}

function sqlFiles(index: ProjectIndex): string[] {
  return Array.from(index.byFile.values())
    .map((module) => normalizePath(module.file))
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

/** Table, view, and index definitions. Routines resolve through `getSqlRoutineLookups`. */
function getSqlDefinitionLookup(index: ProjectIndex): SqlDefinitionLookup {
  const cache = getSqlNavigationCache(index);
  if (cache.definitionLookup) return cache.definitionLookup;
  const lookup = createSqlDefinitionIndex<SymbolDef>();
  for (const file of sqlFiles(index)) {
    const module = index.byFile.get(fileIdentityKey(file));
    if (!module) continue;
    for (const local of module.locals) {
      if (local.kind !== SymbolKind.Routine) addSqlDefinition(lookup, local.localName, local);
    }
  }
  cache.definitionLookup = lookup;
  return lookup;
}

function sqlDefinitionsFromLookup(lookup: SqlDefinitionLookup, objectName: string): SymbolDef[] {
  const normalizedName = sqlObjectLookupKey(objectName);
  const basenameKey = sqlObjectBaseNameLookupKey(objectName);
  const exactDefinitions = lookup.exact.get(normalizedName) ?? [];
  const basenameDefinitions = lookup.basename.get(basenameKey) ?? [];
  if (exactDefinitions.length) return exactDefinitions;
  return basenameDefinitions.length === 1 ? basenameDefinitions : [];
}

function preferredSqlDefinition(definitions: SymbolDef[], currentFile: string): SymbolDef | null {
  const currentFileDefinitions = definitions.filter(
    (definition) => fileIdentityKey(definition.file) === fileIdentityKey(currentFile),
  );
  if (currentFileDefinitions.length === 1) return currentFileDefinitions[0] ?? null;
  if (currentFileDefinitions.length > 1) return null;
  if (definitions.length === 1) return definitions[0] ?? null;
  return null;
}

function sqlDefinitionMatches(
  lookup: SqlDefinitionLookup,
  objectName: string,
): { exact: SymbolDef[]; basename: SymbolDef[] } {
  const normalizedName = sqlObjectLookupKey(objectName);
  const basenameKey = sqlObjectBaseNameLookupKey(objectName);
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
    const name = normalizeSqlObjectName(match[1]);
    if (!name) continue;
    cteNames.add(sqlObjectLookupKey(name));
    cteNames.add(sqlObjectBaseNameLookupKey(name));
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
      const objectKey = sqlObjectLookupKey(parsed.objectName);
      const objectBaseKey = sqlObjectBaseNameLookupKey(parsed.objectName);
      if (cteNames.has(objectKey) || cteNames.has(objectBaseKey)) continue;
      aliases.set(sqlObjectLookupKey(parsed.aliasName), parsed.objectName);
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
    if (cteNamesForStatement(maskedStatementText).has(sqlObjectLookupKey(firstPart))) return null;
    const aliasTarget = sqlAliasMapForStatement(maskedStatementText).get(sqlObjectLookupKey(firstPart));
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

function sqlNameResolvesToDefinition(lookup: SqlDefinitionLookup, name: string, definition: SymbolDef): boolean {
  const matches = sqlDefinitionMatches(lookup, name);
  if (matches.exact.length) return matches.exact.includes(definition);
  return matches.basename.length === 1 && matches.basename[0] === definition;
}

function factReferenceRanges(fact: SqlStatementFact, objectName: string, claimedStarts?: ReadonlySet<number>): Range[] {
  const statement: SqlStatementNavigationSlice = {
    text: fact.statementText,
    startLine: fact.startLine,
    startColumn: fact.startColumn,
    endLine: fact.endLine,
  };
  const objectKey = sqlObjectLookupKey(objectName);
  const ranges: Range[] = [];
  const maskedStatementText = maskSqlStringsAndComments(statement.text);
  for (const match of maskedStatementText.matchAll(SQL_DOTTED_TOKEN_RE)) {
    const token = normalizeSqlObjectName(match[0]);
    if (!token || sqlObjectLookupKey(token) !== objectKey) continue;
    const offset = match.index ?? 0;
    if (claimedStarts?.has(offset)) continue;
    ranges.push(
      rangeForToken(
        statementLineForOffset(statement, offset),
        statementColumnForOffset(statement, offset),
        match[0].length,
      ),
    );
  }
  return ranges;
}

function qualifiedReferenceRanges(
  lookup: SqlDefinitionLookup,
  statement: SqlStatementNavigationSlice,
  definition: SymbolDef,
  claimedStarts?: ReadonlySet<number>,
): Range[] {
  const ranges: Range[] = [];
  const maskedStatementText = maskSqlStringsAndComments(statement.text);
  const aliases = sqlAliasMapForStatement(maskedStatementText);
  const cteNames = cteNamesForStatement(maskedStatementText);
  for (const match of maskedStatementText.matchAll(SQL_DOTTED_TOKEN_RE)) {
    const offset = match.index ?? 0;
    if (claimedStarts?.has(offset)) continue;
    const token = normalizeSqlObjectName(match[0]);
    if (!token) continue;
    const parts = sqlObjectNameParts(token);
    if (parts.length < 2) continue;
    const firstPart = parts[0];
    if (!firstPart) continue;
    if (cteNames.has(sqlObjectLookupKey(firstPart))) continue;
    const aliasTarget = aliases.get(sqlObjectLookupKey(firstPart));
    const matchesAlias = aliasTarget ? sqlNameResolvesToDefinition(lookup, aliasTarget, definition) : false;
    let matchesPrefix = false;
    for (let partCount = parts.length - 1; partCount >= 1 && !matchesPrefix; partCount -= 1) {
      const candidate = parts.slice(0, partCount).join(".");
      matchesPrefix = sqlNameResolvesToDefinition(lookup, candidate, definition);
    }
    if (!matchesAlias && !matchesPrefix) continue;
    ranges.push(
      rangeForToken(
        statementLineForOffset(statement, offset),
        statementColumnForOffset(statement, offset),
        match[0].length,
      ),
    );
  }
  return ranges;
}

async function sourceForFile(filePath: string, index: ProjectIndex): Promise<string> {
  const cache = getSqlNavigationCache(index);
  const key = fileIdentityKey(filePath);
  const cached = cache.sourceByFile.get(key);
  if (cached !== undefined) return cached;
  const parsed = index.parsed?.get(key);
  const source = parsed ? parsed.source : await fsp.readFile(filePath, "utf8");
  cache.sourceByFile.set(key, source);
  return source;
}

async function sqlFactsForFile(index: ProjectIndex, filePath: string): Promise<SqlStatementFact[]> {
  const cache = getSqlNavigationCache(index);
  const key = fileIdentityKey(filePath);
  const cached = cache.factsByFile.get(key);
  if (cached) return cached;
  const facts = extractSqlFactsFromSource(filePath, await sourceForFile(filePath, index));
  cache.factsByFile.set(key, facts);
  return facts;
}

const routineLookupsByIndex = new WeakMap<ProjectIndex, Promise<SqlRoutineLookups>>();
const mentionsByFacts = new WeakMap<readonly SqlStatementFact[], readonly SqlStatementMentions[]>();

function siteKey(file: string, line: number, column: number): string {
  return `${fileIdentityKey(file)}:${line}:${column}`;
}

/** The name space of each routine one file defines, by the position where its statement starts. */
async function routineNamespacesByStart(index: ProjectIndex, file: string): Promise<Map<string, SqlRoutineNamespace>> {
  const namespaces = new Map<string, SqlRoutineNamespace>();
  for (const fact of await sqlFactsForFile(index, file)) {
    if (fact.kind !== "defines_routine") continue;
    namespaces.set(`${fact.startLine}:${fact.startColumn}`, sqlRoutineDefinitionNamespace(fact.statementText));
  }
  return namespaces;
}

async function buildSqlRoutineLookups(index: ProjectIndex): Promise<SqlRoutineLookups> {
  const lookups: SqlRoutineLookups = {
    callable: createSqlDefinitionIndex<SymbolDef>(),
    trigger: createSqlDefinitionIndex<SymbolDef>(),
    namespaceByDefinition: new Map(),
    definitionByStart: new Map(),
  };
  for (const file of sqlFiles(index)) {
    const locals = index.byFile.get(fileIdentityKey(file))?.locals ?? [];
    const routines = locals.filter((local) => local.kind === SymbolKind.Routine);
    if (!routines.length) continue;
    const namespaces = await routineNamespacesByStart(index, file);
    for (const routine of routines) {
      const { line, column } = routine.range.start;
      const namespace = namespaces.get(`${line}:${column}`) ?? "callable";
      addSqlDefinition(lookups[namespace], routine.localName, routine);
      lookups.namespaceByDefinition.set(routine, namespace);
      lookups.definitionByStart.set(siteKey(file, line, column), routine);
    }
  }
  return lookups;
}

function getSqlRoutineLookups(index: ProjectIndex): Promise<SqlRoutineLookups> {
  const cached = routineLookupsByIndex.get(index);
  if (cached) return cached;
  const lookups = buildSqlRoutineLookups(index);
  routineLookupsByIndex.set(index, lookups);
  // A failed build must not stay cached; the next lookup tries again.
  lookups.catch(() => routineLookupsByIndex.delete(index));
  return lookups;
}

/**
 * The mentions in each statement that name a routine. A keyword mention always does. A bare `name(`
 * does only when an indexed routine has that name, because `INSERT INTO users (id)` has the same shape.
 */
function statementMentions(
  lookups: SqlRoutineLookups,
  facts: readonly SqlStatementFact[],
): readonly SqlStatementMentions[] {
  const cached = mentionsByFacts.get(facts);
  if (cached) return cached;
  const statements: SqlStatementMentions[] = [];
  for (const statement of sqlStatementSlices(facts)) {
    const mentions = findSqlRoutineMentions(statement.text).filter(
      (mention) => !mention.speculative || routineCandidates(lookups, mention).length,
    );
    if (mentions.length) statements.push({ statement, mentions });
  }
  mentionsByFacts.set(facts, statements);
  return statements;
}

function routineCandidates(lookups: SqlRoutineLookups, mention: SqlRoutineMention): readonly SymbolDef[] {
  return sqlRoutineNameCandidates(lookups[mention.namespace], mention.name, (definition) => definition.localName)
    .candidates;
}

/**
 * Start offsets of the tokens in each statement that name a routine, by statement start. A table or
 * view reference skips these tokens: a name in a routine position is not a relation.
 */
function claimedMentionStarts(
  lookups: SqlRoutineLookups,
  facts: readonly SqlStatementFact[],
): Map<string, ReadonlySet<number>> {
  const claimed = new Map<string, ReadonlySet<number>>();
  for (const { statement, mentions } of statementMentions(lookups, facts)) {
    claimed.set(`${statement.startLine}:${statement.startColumn}`, new Set(mentions.map((mention) => mention.start)));
  }
  return claimed;
}

function mentionRange(statement: SqlStatementNavigationSlice, mention: SqlRoutineMention): Range {
  return {
    start: {
      line: statementLineForOffset(statement, mention.start),
      column: statementColumnForOffset(statement, mention.start),
    },
    end: {
      line: statementLineForOffset(statement, mention.end),
      column: statementColumnForOffset(statement, mention.end),
    },
  };
}

function statementOffsetAtPosition(
  statement: SqlStatementNavigationSlice,
  line: number,
  column: number,
): number | undefined {
  if (line < statement.startLine || line > statement.endLine) return undefined;
  let lineStart = 0;
  for (let current = statement.startLine; current < line; current += 1) {
    const newline = statement.text.indexOf("\n", lineStart);
    if (newline < 0) return undefined;
    lineStart = newline + 1;
  }
  return lineStart + column - (line === statement.startLine ? statement.startColumn : 1);
}

function goToRoutineMention(
  index: ProjectIndex,
  lookups: SqlRoutineLookups,
  file: string,
  facts: readonly SqlStatementFact[],
  position: { line: number; column: number },
): GoToResult | null {
  for (const statement of sqlStatementSlices(facts)) {
    const offset = statementOffsetAtPosition(statement, position.line, position.column);
    // Several statements can share one line, so only the statement that holds the position counts.
    if (offset === undefined || offset < 0 || offset >= statement.text.length) continue;
    const mention = findSqlRoutineMentions(statement.text).find((entry) => offset >= entry.start && offset < entry.end);
    if (!mention) return null;
    if (mention.kind === "definition") {
      const definition = lookups.definitionByStart.get(siteKey(file, statement.startLine, statement.startColumn));
      return definition ? okGoToResult(index, definition, { resolution: "exact", confidence: "high" }) : null;
    }
    const candidates = routineCandidates(lookups, mention);
    const [only] = candidates;
    if (only && candidates.length === 1) return okGoToResult(index, only, { resolution: "exact", confidence: "high" });
    if (candidates.length) return { status: "not_found", reason: "Several SQL routines share this name" };
    // A bare `name(` can name a table or an index; a keyword such as `CALL` or `DROP FUNCTION` names a routine.
    return mention.speculative ? null : { status: "not_found", reason: "No matching SQL routine definition" };
  }
  return null;
}

export async function goToSqlDefinition(index: ProjectIndex, req: GoToRequest): Promise<GoToResult | null> {
  if (!isSqlFile(req.file)) return null;
  const source = await sourceForFile(req.file, index);
  const lookup = getSqlDefinitionLookup(index);
  const routineLookups = await getSqlRoutineLookups(index);
  const facts = await sqlFactsForFile(index, req.file);
  if (routineLookups.namespaceByDefinition.size) {
    const routineResult = goToRoutineMention(index, routineLookups, req.file, facts, req);
    if (routineResult) return routineResult;
  }
  const statement = sqlStatementAtLine(facts, req.line);
  const name = wordAtPosition(source, req.line, req.column);
  if (!name) return { status: "not_found", reason: "No SQL object at position" };
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

type FindSqlReferencesOptions = {
  includeDefinition?: boolean;
  maxReferences?: number;
};

export async function findSqlReferences(
  index: ProjectIndex,
  definition: SymbolDef,
  options?: FindSqlReferencesOptions,
): Promise<FindReferencesResult | null> {
  if (!isSqlFile(definition.file)) return null;
  const references: Reference[] = [];
  const seen = new Set<string>();
  const lookup = getSqlDefinitionLookup(index);
  const routineLookups = await getSqlRoutineLookups(index);
  const routineNamespace = routineLookups.namespaceByDefinition.get(definition);
  const hasRoutines = !!routineLookups.namespaceByDefinition.size;
  const candidateFiles = sqlFiles(index);
  const scannedFiles: string[] = [];
  // Files with a mention that several routine definitions could own, so no one definition owns it.
  const ambiguousFiles: string[] = [];
  const includeDefinition = options?.includeDefinition ?? true;
  const maxReferences =
    typeof options?.maxReferences === "number" && options.maxReferences > 0 ? options.maxReferences : undefined;
  const collectionLimit = maxReferences === undefined ? undefined : maxReferences + 1;
  const definitionKey = siteKey(definition.file, definition.range.start.line, definition.range.start.column);
  const hasReachedCollectionLimit = (): boolean =>
    collectionLimit !== undefined && references.length >= collectionLimit;
  const addReference = (file: string, range: Range): void => {
    if (hasReachedCollectionLimit()) return;
    const key = siteKey(file, range.start.line, range.start.column);
    if (!includeDefinition && key === definitionKey) return;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ file, range });
  };

  for (const file of candidateFiles) {
    if (hasReachedCollectionLimit()) break;
    scannedFiles.push(file);
    const facts = await sqlFactsForFile(index, file);
    if (routineNamespace) {
      for (const { statement, mentions } of statementMentions(routineLookups, facts)) {
        for (const mention of mentions) {
          if (hasReachedCollectionLimit()) break;
          if (mention.namespace !== routineNamespace) continue;
          if (mention.kind === "definition") {
            // A definition always names itself, even when several definitions share the name.
            if (siteKey(file, statement.startLine, statement.startColumn) === definitionKey) {
              addReference(file, mentionRange(statement, mention));
            }
            continue;
          }
          const candidates = routineCandidates(routineLookups, mention);
          if (!candidates.includes(definition)) continue;
          if (candidates.length === 1) addReference(file, mentionRange(statement, mention));
          else if (!ambiguousFiles.includes(file)) ambiguousFiles.push(file);
        }
      }
      continue;
    }
    const claimedStarts = hasRoutines ? claimedMentionStarts(routineLookups, facts) : undefined;
    for (const fact of facts) {
      if (hasReachedCollectionLimit()) break;
      // The name in `DROP FUNCTION name` is a routine mention, never a table of the same name.
      if (fact.kind === "drops_object" && sqlStatementDropsRoutine(fact.statementText)) continue;
      const claimed = claimedStarts?.get(`${fact.startLine}:${fact.startColumn}`);
      for (const name of [fact.objectName, fact.relatedObjectName]) {
        if (!name || !sqlNameResolvesToDefinition(lookup, name, definition)) continue;
        for (const range of factReferenceRanges(fact, name, claimed)) {
          addReference(file, range);
        }
      }
    }
    if (hasReachedCollectionLimit()) break;
    for (const statement of sqlStatementSlices(facts)) {
      if (hasReachedCollectionLimit()) break;
      if (sqlStatementDropsRoutine(statement.text)) continue;
      const claimed = claimedStarts?.get(`${statement.startLine}:${statement.startColumn}`);
      for (const range of qualifiedReferenceRanges(lookup, statement, definition, claimed)) {
        addReference(file, range);
      }
    }
  }
  references.sort((left, right) => {
    const fileCompare = left.file.localeCompare(right.file);
    if (fileCompare !== 0) return fileCompare;
    return left.range.start.line - right.range.start.line || left.range.start.column - right.range.start.column;
  });
  const truncated = maxReferences !== undefined && references.length > maxReferences;
  if (truncated) references.length = maxReferences;
  return {
    status: "ok",
    definition,
    references,
    provenance: createNavigationProvenance("exact", "high"),
    referenceCoverage: buildIndexedCandidateCoverage({
      index,
      def: definition,
      languageId: "sql",
      exportedNames: [],
      candidateFiles,
      scannedFiles,
      truncated,
      strategyUnavailableFiles: ambiguousFiles,
    }),
  };
}
