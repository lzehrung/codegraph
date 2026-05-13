import fsp from "node:fs/promises";
import path from "node:path";

import type { ModuleIndex, SymbolDef } from "../indexer/types.js";
import { SymbolKind } from "../indexer/types.js";
import type { Edge, Range } from "../types.js";
import { normalizePath } from "../util/paths.js";
import { extractSqlFactsFromSource, sqlObjectBaseName } from "./extractFacts.js";
import type { SqlFactKind, SqlStatementFact } from "./types.js";

const SQL_DEFINITION_KINDS = new Set<SqlFactKind>([
  "defines_table",
  "defines_view",
  "defines_index",
  "defines_routine",
]);

const SQL_REFERENCE_KINDS = new Set<SqlFactKind>([
  "alters_table",
  "drops_object",
  "reads_from",
  "writes_to",
  "joins",
  "references_object",
  "renames_object",
]);

export type SqlFactCache = {
  factsByFile: Map<string, SqlStatementFact[]>;
  definitionsByName: Map<string, SqlStatementFact[]>;
};

function isSqlFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".sql";
}

function rangeForFact(fact: SqlStatementFact): Range {
  return {
    start: { line: fact.startLine, column: fact.startColumn, index: fact.startIndex },
    end: { line: fact.endLine, column: fact.endColumn, index: fact.endIndex },
  };
}

function symbolKindForFact(fact: SqlStatementFact): SymbolKind {
  if (fact.kind === "defines_table") return SymbolKind.Table;
  if (fact.kind === "defines_view") return SymbolKind.View;
  if (fact.kind === "defines_index") return SymbolKind.Index;
  if (fact.kind === "defines_constraint") return SymbolKind.Constraint;
  if (fact.kind === "defines_routine") return SymbolKind.Routine;
  return SymbolKind.Variable;
}

function isDefinitionFact(fact: SqlStatementFact): boolean {
  return SQL_DEFINITION_KINDS.has(fact.kind) && !!fact.objectName;
}

function referenceObjectNames(fact: SqlStatementFact): string[] {
  const names: string[] = [];
  if (SQL_REFERENCE_KINDS.has(fact.kind) && fact.objectName) {
    names.push(fact.objectName);
  }
  if (fact.relatedObjectName) {
    names.push(fact.relatedObjectName);
  }
  return Array.from(new Set(names));
}

function definitionKeys(name: string): string[] {
  const normalized = name.toLowerCase();
  const baseName = sqlObjectBaseName(name).toLowerCase();
  return normalized === baseName ? [normalized] : [normalized, baseName];
}

function sqlDefinitionCandidates(cache: SqlFactCache, objectName: string): SqlStatementFact[] {
  const [exactKey, ...fallbackKeys] = definitionKeys(objectName);
  if (!exactKey) return [];
  const exactCandidates = cache.definitionsByName.get(exactKey) ?? [];
  if (exactCandidates.length > 0) return exactCandidates;
  const candidates: SqlStatementFact[] = [];
  const seen = new Set<string>();
  for (const key of fallbackKeys) {
    for (const candidate of cache.definitionsByName.get(key) ?? []) {
      const seenKey = `${candidate.filePath}:${candidate.startLine}:${candidate.kind}:${candidate.objectName ?? ""}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function buildSqlModuleIndex(filePath: string, source: string): ModuleIndex {
  const normalizedFile = normalizePath(filePath);
  const facts = extractSqlFactsFromSource(normalizedFile, source);
  const locals: SymbolDef[] = [];
  const exports: ModuleIndex["exports"] = [];
  const seen = new Set<string>();

  for (const fact of facts) {
    if (!isDefinitionFact(fact) || !fact.objectName) continue;
    const key = `${fact.objectName}:${fact.startLine}:${fact.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const symbol: SymbolDef = {
      file: normalizedFile,
      localName: fact.objectName,
      kind: symbolKindForFact(fact),
      range: rangeForFact(fact),
      lineSpan: Math.max(1, fact.endLine - fact.startLine + 1),
    };
    locals.push(symbol);
    exports.push({ type: "local", exportedAs: fact.objectName, target: symbol });
  }

  return {
    file: normalizedFile,
    exports,
    imports: [],
    locals,
  };
}

async function readSqlFacts(filePath: string): Promise<SqlStatementFact[]> {
  return extractSqlFactsFromSource(filePath, await fsp.readFile(filePath, "utf8"));
}

export async function buildSqlFactCache(allFiles: readonly string[]): Promise<SqlFactCache> {
  const sqlFiles = Array.from(new Set(allFiles.map(normalizePath).filter(isSqlFile))).sort((left, right) =>
    left.localeCompare(right),
  );
  const factGroups = await Promise.all(sqlFiles.map(async (file) => [file, await readSqlFacts(file)] as const));
  const factsByFile = new Map<string, SqlStatementFact[]>();
  const definitions = new Map<string, SqlStatementFact[]>();

  for (const [file, facts] of factGroups) {
    factsByFile.set(file, facts);
    for (const fact of facts) {
      if (!isDefinitionFact(fact) || !fact.objectName) continue;
      for (const key of definitionKeys(fact.objectName)) {
        const existing = definitions.get(key);
        if (existing) existing.push(fact);
        else definitions.set(key, [fact]);
      }
    }
  }
  return { factsByFile, definitionsByName: definitions };
}

export async function collectSqlEdgesForFile(
  filePath: string,
  allFiles: readonly string[],
  factCache?: SqlFactCache,
): Promise<Edge[]> {
  const normalizedFile = normalizePath(filePath);
  if (!isSqlFile(normalizedFile)) return [];
  const cache = factCache ?? (await buildSqlFactCache(allFiles));
  const currentFacts = cache.factsByFile.get(normalizedFile) ?? [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const fact of currentFacts) {
    for (const objectName of referenceObjectNames(fact)) {
      const candidates = sqlDefinitionCandidates(cache, objectName);
      for (const candidate of candidates) {
        if (candidate.filePath === normalizedFile) continue;
        const targetPath = candidate.filePath;
        const edge: Edge = {
          from: normalizedFile,
          to: { type: "file", path: targetPath },
          raw: `sql:${fact.kind}:${objectName}`,
          resolved: "precise",
          confidence: 1,
        };
        const key = `${edge.from}:${targetPath}:${edge.raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(edge);
      }
    }
  }
  return edges;
}
