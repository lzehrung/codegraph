import fsp from "node:fs/promises";
import path from "node:path";
import { listProjectFiles } from "../util/projectFiles.js";
import { normalizePath } from "../util/paths.js";
import { extractSqlFactsFromSource } from "./extractFacts.js";
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

const SQL_LITERAL_HINT = /\b(select|with|insert\s+into|update|delete\s+from|from|join)\b/i;

function isSqlFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".sql";
}

function objectNamePattern(name: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(name)}([^A-Za-z0-9_]|$)`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function collectSqlFacts(projectRoot: string, changedFiles: readonly string[]): Promise<SqlStatementFact[]> {
  const discovered = await listProjectFiles(projectRoot);
  const allSqlFiles = new Set(discovered.filter(isSqlFile).map(normalizePath));
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

async function collectChangedSqlLiteralObjects(
  changedFiles: readonly string[],
  facts: readonly SqlStatementFact[],
): Promise<Set<string>> {
  const objectNames = new Set(facts.map((fact) => fact.objectName).filter((name): name is string => !!name));
  const matched = new Set<string>();
  for (const changedFile of changedFiles) {
    if (isSqlFile(changedFile)) continue;
    const source = await readExistingFile(changedFile);
    if (!source || !SQL_LITERAL_HINT.test(source)) continue;
    for (const objectName of objectNames) {
      if (objectNamePattern(objectName).test(source)) {
        matched.add(objectName.toLowerCase());
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
  const facts = await collectSqlFacts(projectRoot, changedFiles);
  if (facts.length === 0) return undefined;

  const literalObjects = await collectChangedSqlLiteralObjects(changedFiles, facts);
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
