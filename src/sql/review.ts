import fsp from "node:fs/promises";
import path from "node:path";
import { listProjectFiles } from "../util/projectFiles.js";
import { normalizePath } from "../util/paths.js";
import { mapLimit } from "../util/concurrency.js";
import { extractSqlFactsFromSource } from "./extractFacts.js";
import { normalizeSqlObjectName, sqlObjectLookupKey } from "./lex.js";
import { sqlObjectLookupKeys } from "./lookup.js";
import type { SqlBridgeReason, SqlStatementFact } from "./types.js";

export type SqlReviewContextEntry = {
  reason: SqlBridgeReason;
  objectName: string | null;
  fact: SqlStatementFact;
};

export type SqlReviewContext = {
  entries: SqlReviewContextEntry[];
};

export type SqlReviewContextOptions = {
  changedFiles: readonly string[];
  projectFiles?: readonly string[];
};

const SQL_IDENTIFIER_HINT = '(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"\\r\\n]+"|`[^`\\r\\n]+`|\\[[^\\]\\r\\n]+\\])';
const SQL_OBJECT_NAME_HINT = `${SQL_IDENTIFIER_HINT}(?:\\s*\\.\\s*${SQL_IDENTIFIER_HINT})*`;
const SQL_OBJECT_TERMINATOR_HINT = "(?=\\s|\\(|\\)|,|;|['\"`]|$)";
const SQL_FACT_READ_CONCURRENCY = 32;
const SQL_LITERAL_HINT = new RegExp(
  [
    `\\bselect\\b[\\s\\S]{0,1000}?\\bfrom\\s+${SQL_OBJECT_NAME_HINT}${SQL_OBJECT_TERMINATOR_HINT}`,
    "\\bwith\\s+[A-Za-z_][A-Za-z0-9_$]*\\s+as\\b",
    `\\binsert\\s+into\\s+${SQL_OBJECT_NAME_HINT}${SQL_OBJECT_TERMINATOR_HINT}`,
    `\\bupdate\\s+(?:only\\s+)?${SQL_OBJECT_NAME_HINT}\\s+set\\b`,
    `\\bdelete\\s+from\\s+${SQL_OBJECT_NAME_HINT}${SQL_OBJECT_TERMINATOR_HINT}`,
    "\\bcreate\\s+(?:temporary\\s+|temp\\s+|unlogged\\s+)*(?:table|view|index)\\b",
    "\\balter\\s+table\\b",
    "\\bdrop\\s+(?:table|view|index)\\b",
  ].join("|"),
  "i",
);

const SQL_OBJECT_MENTION_RE = new RegExp(SQL_OBJECT_NAME_HINT, "g");

function isSqlFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".sql";
}

function entryKey(entry: SqlReviewContextEntry): string {
  return `${entry.reason}:${entry.fact.id}:${entry.objectName ?? ""}`;
}

function sortEntries(left: SqlReviewContextEntry, right: SqlReviewContextEntry): number {
  const leftKey = entryKey(left);
  const rightKey = entryKey(right);
  return leftKey.localeCompare(rightKey);
}

async function readExistingFile(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function collectSqlFacts(
  projectRoot: string,
  changedFiles: readonly string[],
  includeDiscoveredSqlFiles: boolean,
  projectFiles: readonly string[] | undefined,
): Promise<SqlStatementFact[]> {
  const allSqlFiles = new Set<string>();
  if (includeDiscoveredSqlFiles) {
    const discovered = projectFiles ?? (await listProjectFiles(projectRoot));
    for (const file of discovered) {
      if (isSqlFile(file)) allSqlFiles.add(normalizePath(file));
    }
  }
  for (const changedFile of changedFiles) {
    const normalized = normalizePath(changedFile);
    if (isSqlFile(normalized)) allSqlFiles.add(normalized);
  }

  const factGroups = await mapLimit(Array.from(allSqlFiles), SQL_FACT_READ_CONCURRENCY, async (filePath) => {
    const source = await readExistingFile(filePath);
    return source === null ? [] : extractSqlFactsFromSource(filePath, source);
  });
  return factGroups.flat();
}

function sqlLiteralsInSource(source: string): string[] {
  const literals: string[] = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index) || source[index] === "#") {
      const lineEnd = source.indexOf("\n", index + 1);
      index = lineEnd < 0 ? source.length : lineEnd + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const commentEnd = source.indexOf("*/", index + 2);
      index = commentEnd < 0 ? source.length : commentEnd + 2;
      continue;
    }
    if (source.startsWith("<!--", index)) {
      const commentEnd = source.indexOf("-->", index + 4);
      index = commentEnd < 0 ? source.length : commentEnd + 3;
      continue;
    }

    const quote = source[index];
    if (quote !== "'" && quote !== '"' && quote !== "`") {
      index += 1;
      continue;
    }

    const tripleQuoted = source.startsWith(quote.repeat(3), index);
    const contentStart = index + (tripleQuoted ? 3 : 1);
    index = contentStart;
    let closed = false;
    while (index < source.length) {
      if (tripleQuoted && source.startsWith(quote.repeat(3), index)) {
        closed = true;
        break;
      }
      const character = source[index];
      if (!tripleQuoted && character === "\\") {
        index += 2;
        continue;
      }
      if (!tripleQuoted && character === quote) {
        closed = true;
        break;
      }
      index += 1;
    }
    if (!closed) break;

    const content = source.slice(contentStart, index).replace(/\\([\\'"`])/g, "$1");
    if (SQL_LITERAL_HINT.test(content)) literals.push(content);
    index += tripleQuoted ? 3 : 1;
  }
  return literals;
}

async function collectChangedSqlLiteralSources(changedFiles: readonly string[]): Promise<string[]> {
  const sources: string[] = [];
  for (const changedFile of changedFiles) {
    if (isSqlFile(changedFile)) continue;
    const source = await readExistingFile(changedFile);
    if (!source) continue;
    sources.push(...sqlLiteralsInSource(source));
  }
  return sources;
}

function changedSourceObjectMentions(source: string): Set<string> {
  const mentions = new Set<string>();
  for (const match of source.matchAll(SQL_OBJECT_MENTION_RE)) {
    const normalized = normalizeSqlObjectName(match[0]);
    if (!normalized) continue;
    for (const key of sqlObjectLookupKeys(normalized)) mentions.add(key);
  }
  return mentions;
}

function collectChangedSqlLiteralObjects(
  changedSqlLiteralSources: readonly string[],
  facts: readonly SqlStatementFact[],
): Set<string> {
  const objectNamesByKey = new Map<string, Set<string>>();
  for (const fact of facts) {
    if (!fact.objectName) continue;
    const canonicalName = sqlObjectLookupKey(fact.objectName);
    for (const key of sqlObjectLookupKeys(fact.objectName)) {
      const existing = objectNamesByKey.get(key);
      if (existing) existing.add(canonicalName);
      else objectNamesByKey.set(key, new Set([canonicalName]));
    }
  }

  const matched = new Set<string>();
  for (const source of changedSqlLiteralSources) {
    for (const mention of changedSourceObjectMentions(source)) {
      for (const objectName of objectNamesByKey.get(mention) ?? []) {
        matched.add(objectName);
      }
    }
  }
  return matched;
}

export async function collectSqlReviewContext(
  projectRoot: string,
  options: SqlReviewContextOptions,
): Promise<SqlReviewContext | undefined> {
  const changedFiles = options.changedFiles.map(normalizePath);
  if (!changedFiles.length) return undefined;

  const changedSqlFiles = new Set(changedFiles.filter(isSqlFile));
  const changedSqlLiteralSources = await collectChangedSqlLiteralSources(changedFiles);
  if (changedSqlFiles.size === 0 && !changedSqlLiteralSources.length) return undefined;

  const facts = await collectSqlFacts(
    projectRoot,
    changedFiles,
    !!changedSqlLiteralSources.length,
    options.projectFiles,
  );
  if (!facts.length) return undefined;

  const literalObjects = collectChangedSqlLiteralObjects(changedSqlLiteralSources, facts);
  const entries = new Map<string, SqlReviewContextEntry>();
  const addEntry = (entry: SqlReviewContextEntry): void => {
    entries.set(entryKey(entry), entry);
  };

  for (const fact of facts) {
    if (changedSqlFiles.has(fact.filePath)) {
      addEntry({ reason: "changed_sql_file", objectName: fact.objectName, fact });
      continue;
    }
    const objectName = fact.objectName ? sqlObjectLookupKey(fact.objectName) : null;
    if (objectName && literalObjects.has(objectName)) {
      addEntry({ reason: "changed_sql_literal", objectName: fact.objectName, fact });
    }
  }

  const sortedEntries = Array.from(entries.values()).sort(sortEntries);
  return sortedEntries.length ? { entries: sortedEntries } : undefined;
}
