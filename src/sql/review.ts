import fsp from "node:fs/promises";
import path from "node:path";
import { listProjectFiles } from "../util/projectFiles.js";
import { normalizePath } from "../util/paths.js";
import { extractSqlFactsFromSource, sqlObjectBaseName } from "./extractFacts.js";
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
};

const SQL_LITERAL_HINT =
  /\b(select|with\s+[A-Za-z_][A-Za-z0-9_$]*\s+as|insert\s+into|update\s+(?:only\s+)?[A-Za-z_"`[]|delete\s+from|create\s+(?:temporary\s+|temp\s+|unlogged\s+)*(?:table|view|index)|alter\s+table|drop\s+(?:table|view|index))\b/i;

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
): Promise<SqlStatementFact[]> {
  const allSqlFiles = new Set<string>();
  if (includeDiscoveredSqlFiles) {
    const discovered = await listProjectFiles(projectRoot);
    for (const file of discovered) {
      if (isSqlFile(file)) allSqlFiles.add(normalizePath(file));
    }
  }
  for (const changedFile of changedFiles) {
    const normalized = normalizePath(changedFile);
    if (isSqlFile(normalized)) allSqlFiles.add(normalized);
  }

  const factGroups = await Promise.all(
    Array.from(allSqlFiles).map(async (filePath) => {
      const source = await readExistingFile(filePath);
      return source === null ? [] : extractSqlFactsFromSource(filePath, source);
    }),
  );
  return factGroups.flat();
}

async function collectChangedSqlLiteralSources(changedFiles: readonly string[]): Promise<string[]> {
  const sources: string[] = [];
  for (const changedFile of changedFiles) {
    if (isSqlFile(changedFile)) continue;
    const source = await readExistingFile(changedFile);
    if (!source || !SQL_LITERAL_HINT.test(source)) continue;
    sources.push(source);
  }
  return sources;
}

function objectLookupKeys(name: string): string[] {
  const normalized = name.toLowerCase();
  const baseName = sqlObjectBaseName(name).toLowerCase();
  return normalized === baseName ? [normalized] : [normalized, baseName];
}

function changedSourceObjectMentions(source: string): Set<string> {
  const mentions = new Set<string>();
  const objectRe = /[A-Za-z_][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*)*/g;
  for (const match of source.matchAll(objectRe)) {
    const normalized = match[0].replace(/\s*\.\s*/g, ".").toLowerCase();
    mentions.add(normalized);
    mentions.add(sqlObjectBaseName(normalized).toLowerCase());
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
    const canonicalName = fact.objectName.toLowerCase();
    for (const key of objectLookupKeys(fact.objectName)) {
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
  if (changedFiles.length === 0) return undefined;

  const changedSqlFiles = new Set(changedFiles.filter(isSqlFile));
  const changedSqlLiteralSources = await collectChangedSqlLiteralSources(changedFiles);
  if (changedSqlFiles.size === 0 && changedSqlLiteralSources.length === 0) return undefined;

  const facts = await collectSqlFacts(projectRoot, changedFiles, changedSqlLiteralSources.length > 0);
  if (facts.length === 0) return undefined;

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
    const objectName = fact.objectName?.toLowerCase();
    if (objectName && literalObjects.has(objectName)) {
      addEntry({ reason: "changed_sql_literal", objectName: fact.objectName, fact });
    }
  }

  const sortedEntries = Array.from(entries.values()).sort(sortEntries);
  return sortedEntries.length > 0 ? { entries: sortedEntries } : undefined;
}
