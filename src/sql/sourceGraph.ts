import fsp from "node:fs/promises";
import path from "node:path";

import type { ModuleIndex, SymbolDef } from "../indexer/types.js";
import { SymbolKind } from "../indexer/types.js";
import type { Edge, Range } from "../types.js";
import { normalizePath } from "../util/paths.js";
import { extractSqlFactsFromSource } from "./extractFacts.js";
import type { SqlFactKind, SqlStatementFact } from "./types.js";

const SQL_DEFINITION_KINDS = new Set<SqlFactKind>([
  "defines_table",
  "defines_view",
  "defines_index",
  "defines_constraint",
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

function isSqlFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".sql";
}

function rangeForFact(fact: SqlStatementFact): Range {
  return {
    start: { line: fact.startLine, column: 1 },
    end: { line: fact.endLine, column: 1 },
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

function definitionKey(name: string): string {
  return name.toLowerCase();
}

export async function collectSqlEdgesForFile(filePath: string, allFiles: readonly string[]): Promise<Edge[]> {
  const normalizedFile = normalizePath(filePath);
  if (!isSqlFile(normalizedFile)) return [];
  const sqlFiles = Array.from(new Set(allFiles.map(normalizePath).filter(isSqlFile)));
  const factGroups = await Promise.all(sqlFiles.map(async (file) => [file, await readSqlFacts(file)] as const));
  const definitions = new Map<string, SqlStatementFact[]>();

  for (const [, facts] of factGroups) {
    for (const fact of facts) {
      if (!isDefinitionFact(fact) || !fact.objectName) continue;
      const key = definitionKey(fact.objectName);
      const existing = definitions.get(key);
      if (existing) existing.push(fact);
      else definitions.set(key, [fact]);
    }
  }

  const currentFacts = factGroups.find(([file]) => file === normalizedFile)?.[1] ?? [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const fact of currentFacts) {
    for (const objectName of referenceObjectNames(fact)) {
      const candidates = definitions.get(definitionKey(objectName)) ?? [];
      for (const candidate of candidates) {
        if (candidate.filePath === normalizedFile && candidate.startLine === fact.startLine) continue;
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
