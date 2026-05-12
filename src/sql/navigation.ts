import fsp from "node:fs/promises";
import path from "node:path";

import { createNavigationProvenance, okGoToResult } from "../indexer/navigation-provenance.js";
import type { FindReferencesResult, GoToRequest, GoToResult, ProjectIndex, Reference, SymbolDef } from "../indexer/types.js";
import type { Range } from "../types.js";
import { normalizePath } from "../util/paths.js";
import { extractSqlFactsFromSource } from "./extractFacts.js";

function isSqlFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".sql";
}

function rangeForLine(line: number): Range {
  return {
    start: { line, column: 1 },
    end: { line, column: 1 },
  };
}

function sqlFiles(index: ProjectIndex): string[] {
  return Array.from(index.byFile.keys()).filter(isSqlFile).sort((left, right) => left.localeCompare(right));
}

function sqlDefinitions(index: ProjectIndex, objectName: string): SymbolDef[] {
  const normalizedName = objectName.toLowerCase();
  const definitions: SymbolDef[] = [];
  for (const file of sqlFiles(index)) {
    const module = index.byFile.get(file);
    if (!module) continue;
    for (const local of module.locals) {
      if (local.localName.toLowerCase() === normalizedName) definitions.push(local);
    }
  }
  return definitions;
}

function wordAtPosition(source: string, line: number, column: number): string | null {
  const lineText = source.split(/\r?\n/)[line - 1];
  if (!lineText) return null;
  const zeroBasedColumn = Math.max(0, column - 1);
  const tokenRe = /[A-Za-z_][A-Za-z0-9_$]*/g;
  for (const match of lineText.matchAll(tokenRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (zeroBasedColumn >= start && zeroBasedColumn <= end) return match[0];
  }
  return null;
}

async function sourceForFile(filePath: string, index: ProjectIndex): Promise<string> {
  const parsed = index.parsed?.get(filePath);
  if (parsed) return parsed.source;
  return await fsp.readFile(filePath, "utf8");
}

export async function goToSqlDefinition(index: ProjectIndex, req: GoToRequest): Promise<GoToResult | null> {
  if (!isSqlFile(req.file)) return null;
  const source = await sourceForFile(req.file, index);
  const name = wordAtPosition(source, req.line, req.column);
  if (!name) return { status: "not_found", reason: "No SQL object at position" };
  const definitions = sqlDefinitions(index, name);
  const preferred = definitions.find((definition) => definition.file === normalizePath(req.file)) ?? definitions[0];
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
  const normalizedName = objectName.toLowerCase();
  const references: Reference[] = [];
  const seen = new Set<string>();
  for (const file of sqlFiles(index)) {
    const source = await sourceForFile(file, index);
    const facts = extractSqlFactsFromSource(file, source);
    for (const fact of facts) {
      const names = [fact.objectName, fact.relatedObjectName]
        .filter((name): name is string => !!name)
        .map((name) => name.toLowerCase());
      if (!names.includes(normalizedName)) continue;
      const range = rangeForLine(fact.startLine);
      const key = `${file}:${range.start.line}:${range.start.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ file, range });
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
