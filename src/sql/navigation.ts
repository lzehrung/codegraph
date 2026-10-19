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
  maskSqlQuotedIdentifiers,
  maskSqlStringsAndComments,
  normalizeSqlObjectName,
  SQL_IDENTIFIER_PART_PATTERN,
  splitTopLevelCommaSeparated,
  sqlObjectBaseNameLookupKey,
  sqlObjectLookupKey,
  sqlQueryScopes,
  sqlSourceClauses,
} from "./lex.js";
import { sqlDefinedNameSpan, sqlObjectMentionCovers, sqlRelationReadSpans } from "./object-mentions.js";
import {
  findSqlRoutineMentions,
  findSqlRoutineSources,
  sqlRoutineDefinitionNamespace,
  sqlStatementDropsRoutine,
  type SqlRoutineMention,
  type SqlRoutineNamespace,
} from "./routine-mentions.js";
import type { SqlChangedObject } from "./source-graph.js";
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
const SQL_IDENTIFIER_PART_RE = new RegExp(SQL_IDENTIFIER, "g");
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

function wordAtPosition(source: string, line: number, column: number): string | null {
  const lineText = maskSqlStringsAndComments(source, { escapeStrings: true }).split(/\r?\n/)[line - 1];
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

const slicesByFacts = new WeakMap<readonly SqlStatementFact[], readonly SqlStatementNavigationSlice[]>();

/** The statements of one file's facts in source order. A file's facts are fixed, so the result is cached. */
function sqlStatementSlices(facts: readonly SqlStatementFact[]): readonly SqlStatementNavigationSlice[] {
  const cached = slicesByFacts.get(facts);
  if (cached) return cached;
  const slices: SqlStatementNavigationSlice[] = [];
  const seen = new Set<number>();
  for (const fact of facts) {
    // One statement yields several facts. Its start offset tells it apart from an identical statement
    // on the same line, which its lines and text cannot.
    if (seen.has(fact.startIndex)) continue;
    seen.add(fact.startIndex);
    slices.push({
      text: fact.statementText,
      startLine: fact.startLine,
      startColumn: fact.startColumn,
      endLine: fact.endLine,
    });
  }
  slices.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  slicesByFacts.set(facts, slices);
  return slices;
}

function sqlStatementAtLine(facts: readonly SqlStatementFact[], line: number): SqlStatementNavigationSlice | null {
  return (
    sqlStatementSlices(facts).find((statement) => line >= statement.startLine && line <= statement.endLine) ?? null
  );
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

function parseSqlSourceEntry(
  entry: string,
): { objectName: string; aliasName: string | null; objectOffset: number } | null {
  const leading = entry.length - entry.trimStart().length;
  const trimmed = entry.trim();
  if (!trimmed || trimmed.startsWith("(")) return null;
  const tokenRe = new RegExp(SQL_DOTTED_TOKEN, "gy");
  let cursor = 0;
  let objectName: string | null = null;
  let objectOffset = -1;
  while (cursor < trimmed.length) {
    tokenRe.lastIndex = cursor;
    const match = tokenRe.exec(trimmed);
    if (!match) return null;
    const normalized = normalizeSqlObjectName(match[0]);
    if (!normalized) return null;
    cursor = match.index + match[0].length;
    if (!SQL_SOURCE_MODIFIERS.has(normalized.toLowerCase())) {
      objectName = normalized;
      objectOffset = leading + match.index;
      break;
    }
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor] ?? "")) cursor += 1;
  }
  if (!objectName || objectOffset < 0) return null;

  let rest = trimmed.slice(cursor).trimStart();
  if (rest.startsWith(".")) return null;
  if (/^as\b/i.test(rest)) rest = rest.replace(/^as\b/i, "").trimStart();
  const aliasMatch = new RegExp(String.raw`^(${SQL_IDENTIFIER})`, "i").exec(rest);
  const aliasName = normalizeSqlObjectName(aliasMatch?.[1]) ?? null;
  if (!aliasName || SQL_SOURCE_KEYWORDS.has(aliasName.toLowerCase())) {
    return { objectName, aliasName: null, objectOffset };
  }
  return { objectName, aliasName, objectOffset };
}

type SqlSourceBinding = { kind: "relation"; objectName: string } | { kind: "routine" } | { kind: "ambiguous" };

function unambiguousSqlPrefixDefinitionName(lookup: SqlDefinitionLookup, objectName: string): string | null {
  const matches = sqlDefinitionMatches(lookup, objectName);
  if (matches.exact.length === 1) return matches.exact[0]?.localName ?? null;
  if (matches.exact.length > 1) return null;
  if (matches.basename.length === 1) return matches.basename[0]?.localName ?? null;
  return null;
}

/** Resolve a qualifier against the nearest query's relation aliases and indexed routine sources. */
function sqlSourceBindings(
  lookups: SqlRoutineLookups,
  statementText: string,
): {
  at: (offset: number, parts: readonly string[]) => SqlSourceBinding | null;
} {
  const masked = maskSqlStringsAndComments(statementText, { escapeStrings: true });
  const scan = maskSqlQuotedIdentifiers(masked);
  const scopes = sqlQueryScopes(scan);
  const bindings = new Map<number, Map<string, SqlSourceBinding>>();
  const addBinding = (offset: number, key: string, binding: SqlSourceBinding): void => {
    const scope = scopes.at(offset);
    let inScope = bindings.get(scope);
    if (!inScope) {
      inScope = new Map();
      bindings.set(scope, inScope);
    }
    const previous = inScope.get(key);
    if (!previous) {
      inScope.set(key, binding);
    } else if (
      previous.kind !== binding.kind ||
      (previous.kind === "relation" && binding.kind === "relation" && previous.objectName !== binding.objectName)
    ) {
      inScope.set(key, { kind: "ambiguous" });
    }
  };

  const cteNames = cteNamesForStatement(masked);
  const routineSources = lookups.namespaceByDefinition.size
    ? findSqlRoutineSources(statementText).filter(({ mention }) => routineCandidates(lookups, mention).length > 0)
    : [];
  for (const source of sqlSourceClauses(scan)) {
    const clause = masked.slice(source.end, source.clauseEnd);
    let nextPartStart = source.end;
    for (const part of splitTopLevelCommaSeparated(clause)) {
      const partStart = masked.indexOf(part, nextPartStart);
      if (partStart < 0) continue;
      const partEnd = partStart + part.length;
      nextPartStart = partEnd + 1;
      const parsed = parseSqlSourceEntry(part);
      if (!parsed) continue;
      // A routine source owns only its own source item. A later call that merely falls inside this
      // slice, such as the next statement of a procedure body, must not drop the relation binding.
      if (routineSources.some(({ mention }) => mention.start === partStart + parsed.objectOffset)) continue;
      const objectKey = sqlObjectLookupKey(parsed.objectName);
      const objectBaseKey = sqlObjectBaseNameLookupKey(parsed.objectName);
      if (cteNames.has(objectKey) || cteNames.has(objectBaseKey)) continue;
      const relation: SqlSourceBinding = { kind: "relation", objectName: parsed.objectName };
      if (parsed.aliasName) {
        addBinding(source.start, sqlObjectLookupKey(parsed.aliasName), relation);
      } else {
        addBinding(source.start, objectKey, relation);
        if (objectBaseKey !== objectKey) addBinding(source.start, objectBaseKey, relation);
      }
    }
  }
  for (const { mention, alias } of routineSources) {
    if (alias) {
      addBinding(mention.start, sqlObjectLookupKey(alias), { kind: "routine" });
    } else {
      addBinding(mention.start, sqlObjectLookupKey(mention.name), { kind: "routine" });
      addBinding(mention.start, sqlObjectBaseNameLookupKey(mention.name), { kind: "routine" });
    }
  }
  return {
    at(offset, parts) {
      for (let scope = scopes.at(offset); ; scope = scopes.parent.get(scope) ?? 0) {
        const inScope = bindings.get(scope);
        let binding = inScope?.get(sqlObjectLookupKey(parts[0] ?? ""));
        for (let count = 2; count < parts.length; count += 1) {
          const candidate = inScope?.get(sqlObjectLookupKey(parts.slice(0, count).join(".")));
          if (candidate && binding && candidate !== binding) return { kind: "ambiguous" };
          binding ??= candidate;
        }
        if (binding) return binding;
        if (!scope) break;
      }
      return null;
    },
  };
}

function resolveQualifiedSqlName(
  lookup: SqlDefinitionLookup,
  routineLookups: SqlRoutineLookups,
  name: string,
  statementText: string | null,
  offset?: number,
): string | null {
  const parts = sqlObjectNameParts(name);
  if (parts.length < 2) return name;
  const firstPart = parts[0];
  if (!firstPart) return null;
  if (statementText && offset !== undefined) {
    const maskedStatementText = maskSqlStringsAndComments(statementText, { escapeStrings: true });
    if (cteNamesForStatement(maskedStatementText).has(sqlObjectLookupKey(firstPart))) return null;
    if (sqlObjectMentionCovers(statementText, offset)) {
      const direct = sqlDefinitionMatches(lookup, name);
      return direct.exact.length || direct.basename.length === 1 ? name : null;
    }
    const binding = sqlSourceBindings(routineLookups, statementText).at(offset, parts);
    if (binding) {
      if (binding.kind !== "relation") return null;
      return sqlDefinitionsFromLookup(lookup, binding.objectName).length ? binding.objectName : null;
    }
  }
  if (sqlDefinitionsFromLookup(lookup, name).length) return name;
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

/**
 * Where the last `partCount` parts of a dotted name begin. Rename edits the definition's own name and
 * keeps the qualifier in front of it: a rename of `f` edits the `f` in `public.f`.
 */
function trailingPartsOffset(dottedName: string, partCount: number): number {
  const parts = [...dottedName.matchAll(SQL_IDENTIFIER_PART_RE)];
  return parts[parts.length - partCount]?.index ?? 0;
}

function factReferenceRanges(
  fact: SqlStatementFact,
  objectName: string,
  claimedStarts?: ReadonlySet<number>,
  keepParts = 0,
): Range[] {
  const statement: SqlStatementNavigationSlice = {
    text: fact.statementText,
    startLine: fact.startLine,
    startColumn: fact.startColumn,
    endLine: fact.endLine,
  };
  const objectKey = sqlObjectLookupKey(objectName);
  const ranges: Range[] = [];
  const sourceSpans = fact.kind === "reads_from" || fact.kind === "joins" ? sqlRelationReadSpans(statement.text) : null;
  const maskedStatementText = maskSqlStringsAndComments(statement.text, { escapeStrings: true });
  for (const match of maskedStatementText.matchAll(SQL_DOTTED_TOKEN_RE)) {
    const token = normalizeSqlObjectName(match[0]);
    if (!token || sqlObjectLookupKey(token) !== objectKey) continue;
    const offset = match.index ?? 0;
    if (claimedStarts?.has(offset)) continue;
    if (
      sourceSpans &&
      !sourceSpans.some((span) => span.start === offset && sqlObjectLookupKey(span.name) === objectKey)
    )
      continue;
    const nameOffset = keepParts ? trailingPartsOffset(match[0], keepParts) : 0;
    ranges.push(
      rangeForToken(
        statementLineForOffset(statement, offset + nameOffset),
        statementColumnForOffset(statement, offset + nameOffset),
        match[0].length - nameOffset,
      ),
    );
  }
  return ranges;
}

function qualifiedReferenceRanges(
  lookup: SqlDefinitionLookup,
  routineLookups: SqlRoutineLookups,
  statement: SqlStatementNavigationSlice,
  definition: SymbolDef,
  claimedStarts?: ReadonlySet<number>,
  keepParts = 0,
): { ranges: Range[]; ambiguous: boolean } {
  const ranges: Range[] = [];
  let ambiguous = false;
  const maskedStatementText = maskSqlStringsAndComments(statement.text, { escapeStrings: true });
  const bindings = sqlSourceBindings(routineLookups, statement.text);
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
    if (sqlObjectMentionCovers(statement.text, offset)) {
      const direct = sqlDefinitionMatches(lookup, token);
      if (!direct.exact.length && direct.basename.length > 1 && direct.basename.includes(definition)) ambiguous = true;
      if (sqlNameResolvesToDefinition(lookup, token, definition)) {
        const nameOffset = keepParts ? trailingPartsOffset(match[0], keepParts) : 0;
        ranges.push(
          rangeForToken(
            statementLineForOffset(statement, offset + nameOffset),
            statementColumnForOffset(statement, offset + nameOffset),
            match[0].length - nameOffset,
          ),
        );
      }
      continue;
    }
    const binding = bindings.at(offset, parts);
    if (binding?.kind === "ambiguous") {
      ambiguous = true;
      continue;
    }
    if (binding?.kind === "routine") continue;
    let matches = false;
    if (binding) {
      matches = sqlNameResolvesToDefinition(lookup, binding.objectName, definition);
    } else {
      for (let partCount = parts.length - 1; partCount >= 1 && !matches; partCount -= 1) {
        const candidate = parts.slice(0, partCount).join(".");
        matches = sqlNameResolvesToDefinition(lookup, candidate, definition);
      }
    }
    if (!matches) continue;
    ranges.push(
      rangeForToken(
        statementLineForOffset(statement, offset),
        statementColumnForOffset(statement, offset),
        match[0].length,
      ),
    );
  }
  return { ranges, ambiguous };
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

function mentionRange(statement: SqlStatementNavigationSlice, mention: SqlRoutineMention, keepParts = 0): Range {
  const start =
    mention.start + (keepParts ? trailingPartsOffset(statement.text.slice(mention.start, mention.end), keepParts) : 0);
  return {
    start: {
      line: statementLineForOffset(statement, start),
      column: statementColumnForOffset(statement, start),
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

function routineMentionIsProven(lookups: SqlRoutineLookups, statementText: string, offset: number): boolean {
  const mention = findSqlRoutineMentions(statementText).find((entry) => offset >= entry.start && offset < entry.end);
  if (!mention) return false;
  // A bare `name(` is a routine only when an indexed routine has that name. Otherwise it may be a table.
  if (!mention.speculative) return true;
  return routineCandidates(lookups, mention).length > 0;
}

/**
 * True when the position names an object or a routine by SQL syntax: a `FROM`/`JOIN`/`CALL`/`ON`
 * target, not a column that happens to share a table's name. The name that a `CREATE` statement
 * defines is no mention: it names the definition itself.
 */
export async function sqlPositionIsProvenObjectOrRoutineMention(
  index: ProjectIndex,
  req: GoToRequest,
): Promise<boolean> {
  if (!isSqlFile(req.file)) return false;
  const facts = await sqlFactsForFile(index, req.file);
  const routineLookups = await getSqlRoutineLookups(index);
  for (const statement of sqlStatementSlices(facts)) {
    const offset = statementOffsetAtPosition(statement, req.line, req.column);
    if (offset === undefined || offset < 0 || offset >= statement.text.length) continue;
    const defined = sqlDefinedNameSpan(statement.text);
    if (defined && offset >= defined.start && offset < defined.end) return false;
    if (routineMentionIsProven(routineLookups, statement.text, offset)) return true;
    return sqlObjectMentionCovers(statement.text, offset);
  }
  return false;
}

export async function goToSqlDefinition(index: ProjectIndex, req: GoToRequest): Promise<GoToResult | null> {
  if (!isSqlFile(req.file)) return null;
  const source = await sourceForFile(req.file, index);
  const lookup = getSqlDefinitionLookup(index);
  const routineLookups = await getSqlRoutineLookups(index);
  const facts = await sqlFactsForFile(index, req.file);
  // `DROP FUNCTION f`, `CALL f`, and the like name a routine even when the project defines none, so they
  // never fall through to a table of the same name.
  const routineResult = goToRoutineMention(index, routineLookups, req.file, facts, req);
  if (routineResult) return routineResult;
  const statement = sqlStatementAtLine(facts, req.line);
  const name = wordAtPosition(source, req.line, req.column);
  if (!name) return { status: "not_found", reason: "No SQL object at position" };
  const offset = statement ? statementOffsetAtPosition(statement, req.line, req.column) : undefined;
  const resolvedName = resolveQualifiedSqlName(lookup, routineLookups, name, statement?.text ?? null, offset);
  if (!resolvedName) return { status: "not_found", reason: "No matching SQL object definition" };
  const definitions = sqlDefinitionsFromLookup(lookup, resolvedName);
  const preferred = preferredSqlDefinition(definitions, normalizePath(req.file));
  if (!preferred) return { status: "not_found", reason: "No matching SQL object definition" };
  return okGoToResult(index, preferred, {
    resolution: "exact",
    confidence: "high",
  });
}

/**
 * The site of the name `definition` declares, as in `users` in `CREATE TABLE users`. A definition spans
 * its whole statement, so its range does not say where its name is.
 */
async function declarationSiteKey(index: ProjectIndex, definition: SymbolDef): Promise<string | null> {
  const { line, column } = definition.range.start;
  const facts = await sqlFactsForFile(index, definition.file);
  const statement = sqlStatementSlices(facts).find((slice) => slice.startLine === line && slice.startColumn === column);
  const name = statement ? sqlDefinedNameSpan(statement.text) : null;
  if (!statement || !name) return null;
  const nameLine = statementLineForOffset(statement, name.start);
  return siteKey(definition.file, nameLine, statementColumnForOffset(statement, name.start));
}

/**
 * The indexed definition declared at the site `definition` names. Impact analysis passes a copy of a
 * definition, and a lookup by object identity cannot match a copy.
 */
function indexedSqlDefinition(index: ProjectIndex, definition: SymbolDef): SymbolDef | null {
  const { line, column } = definition.range.start;
  const locals = index.byFile.get(fileIdentityKey(definition.file))?.locals ?? [];
  return (
    locals.find(
      (local) =>
        local.range.start.line === line &&
        local.range.start.column === column &&
        local.kind === definition.kind &&
        local.localName === definition.localName,
    ) ?? null
  );
}

type FindSqlReferencesOptions = {
  includeDefinition?: boolean;
  maxReferences?: number;
  /** Report only the definition's own name in a qualified reference, and keep the qualifier out of the range. */
  renameRanges?: boolean;
};

export async function findSqlReferences(
  index: ProjectIndex,
  requested: SymbolDef,
  options?: FindSqlReferencesOptions,
): Promise<FindReferencesResult | null> {
  if (!isSqlFile(requested.file)) return null;
  const definition = indexedSqlDefinition(index, requested);
  // Without the indexed definition no lookup can match, and an empty list would claim a complete scan.
  if (!definition) return { status: "not_found", reason: "SQL definition is not in the index" };
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
  const keepParts = options?.renameRanges ? sqlObjectNameParts(definition.localName).length : 0;
  const maxReferences =
    typeof options?.maxReferences === "number" && options.maxReferences > 0 ? options.maxReferences : undefined;
  const collectionLimit = maxReferences === undefined ? undefined : maxReferences + 1;
  const definitionKey = siteKey(definition.file, definition.range.start.line, definition.range.start.column);
  // A usage lookup leaves out the declaration. A routine's declaration is a mention, skipped below.
  // A relation's is not, so find the site of its name here.
  let declarationKey: string | null = null;
  if (!includeDefinition && !routineNamespace) declarationKey = await declarationSiteKey(index, definition);
  const hasReachedCollectionLimit = (): boolean =>
    collectionLimit !== undefined && references.length >= collectionLimit;
  const addReference = (file: string, range: Range): void => {
    if (hasReachedCollectionLimit()) return;
    const key = siteKey(file, range.start.line, range.start.column);
    if (key === declarationKey) return;
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
            // A definition always names itself, even when several definitions share the name. Only a
            // lookup that includes the declaration reports it.
            const namesDefinition = siteKey(file, statement.startLine, statement.startColumn) === definitionKey;
            if (includeDefinition && namesDefinition) addReference(file, mentionRange(statement, mention, keepParts));
            continue;
          }
          const candidates = routineCandidates(routineLookups, mention);
          if (!candidates.includes(definition)) continue;
          if (candidates.length === 1) addReference(file, mentionRange(statement, mention, keepParts));
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
        for (const range of factReferenceRanges(fact, name, claimed, keepParts)) {
          addReference(file, range);
        }
      }
    }
    if (hasReachedCollectionLimit()) break;
    for (const statement of sqlStatementSlices(facts)) {
      if (hasReachedCollectionLimit()) break;
      if (sqlStatementDropsRoutine(statement.text)) continue;
      const claimed = claimedStarts?.get(`${statement.startLine}:${statement.startColumn}`);
      const { ranges, ambiguous } = qualifiedReferenceRanges(
        lookup,
        routineLookups,
        statement,
        definition,
        claimed,
        keepParts,
      );
      for (const range of ranges) addReference(file, range);
      if (ambiguous && !ambiguousFiles.includes(file)) ambiguousFiles.push(file);
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

type SqlChangedSymbol = {
  file: string;
  name: string;
  kind: SymbolKind;
  range: { start: { line: number; column: number } };
};

/**
 * What each changed SQL symbol is called in graph edges: a table, view, or index by its name, a
 * routine by its name and name space. The index stores no name space, and an index restored from a
 * cache never read the statement, so the name space comes from the facts of the changed file.
 */
export async function sqlChangedSymbolTargets<T extends SqlChangedSymbol>(
  index: ProjectIndex,
  symbols: readonly T[],
): Promise<Map<T, SqlChangedObject>> {
  const targets = new Map<T, SqlChangedObject>();
  const namespacesByFile = new Map<string, Map<string, SqlRoutineNamespace>>();
  for (const symbol of symbols) {
    if (symbol.kind === SymbolKind.Table || symbol.kind === SymbolKind.View || symbol.kind === SymbolKind.Index) {
      targets.set(symbol, { name: symbol.name, namespace: "relation" });
      continue;
    }
    if (symbol.kind !== SymbolKind.Routine) continue;
    const fileKey = fileIdentityKey(symbol.file);
    let namespaces = namespacesByFile.get(fileKey);
    if (!namespaces) {
      namespaces = await routineNamespacesByStart(index, symbol.file);
      namespacesByFile.set(fileKey, namespaces);
    }
    const { line, column } = symbol.range.start;
    targets.set(symbol, { name: symbol.name, namespace: namespaces.get(`${line}:${column}`) ?? "callable" });
  }
  return targets;
}
