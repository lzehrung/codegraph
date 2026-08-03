import crypto from "node:crypto";
import fsp from "node:fs/promises";

import { uniqueByKey } from "../util/collections.js";
import type { ModuleIndex, SymbolDef } from "../indexer/types.js";
import { SymbolKind } from "../indexer/types.js";
import type { Edge, Range } from "../types.js";
import { normalizePath } from "../util/paths.js";
import { mapLimit } from "../util/concurrency.js";
import { supportForFile, type LanguageExtensionMap } from "../languages.js";
import { extractSqlFactsFromSource, sqlObjectBaseName } from "./extractFacts.js";
import { pushSqlLookupValue } from "./lookup.js";
import type { SqlFactKind, SqlStatementFact } from "./types.js";

const SQL_FACT_READ_CONCURRENCY = 32;

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
  definitionsByExactName: Map<string, SqlStatementFact[]>;
  definitionsByBaseName: Map<string, SqlStatementFact[]>;
};

export type SqlFileSignature = {
  sig: string;
  gitSig?: string;
  cacheSig?: string;
};

type SqlDefinitionCandidateMatch = {
  candidates: SqlStatementFact[];
  resolved: "heuristic" | "precise";
  confidence: number;
};

function isSqlFile(filePath: string, languageExtensions?: LanguageExtensionMap): boolean {
  return supportForFile(filePath, languageExtensions)?.id === "sql";
}

export function sqlCorpusSignature(
  sqlFiles: readonly string[],
  fileSignatures: Map<string, SqlFileSignature> | undefined,
): string | undefined {
  if (!sqlFiles.length || !fileSignatures) return undefined;
  const hash = crypto.createHash("sha1");
  hash.update("sql-corpus-v1\0");
  for (const file of sqlFiles) {
    const signature = fileSignatures.get(file);
    if (!signature) return undefined;
    hash.update(file);
    hash.update("\0");
    hash.update(signature.cacheSig ?? signature.gitSig ?? signature.sig);
    hash.update("\0");
  }
  return hash.digest("hex");
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
  if (fact.kind !== "renames_object" && fact.kind !== "joins" && fact.relatedObjectName) {
    names.push(fact.relatedObjectName);
  }
  return Array.from(new Set(names));
}

function uniqueFacts(candidates: readonly SqlStatementFact[]): SqlStatementFact[] {
  return uniqueByKey(
    candidates,
    (candidate) => `${candidate.filePath}:${candidate.startLine}:${candidate.kind}:${candidate.objectName ?? ""}`,
  );
}

function sqlDefinitionCandidates(cache: SqlFactCache, objectName: string): SqlDefinitionCandidateMatch {
  const normalized = objectName.toLowerCase();
  const baseName = sqlObjectBaseName(objectName).toLowerCase();
  const exactCandidates = uniqueFacts(cache.definitionsByExactName.get(normalized) ?? []);
  if (exactCandidates.length) {
    return {
      candidates: exactCandidates,
      resolved: exactCandidates.length === 1 ? "precise" : "heuristic",
      confidence: exactCandidates.length === 1 ? 1 : 0.8,
    };
  }
  const basenameCandidates = uniqueFacts(cache.definitionsByBaseName.get(baseName) ?? []);
  if (basenameCandidates.length !== 1) return { candidates: [], resolved: "heuristic", confidence: 0.7 };
  return {
    candidates: basenameCandidates,
    resolved: "heuristic",
    confidence: 0.7,
  };
}

function definitionKeys(name: string): { exact: string; base: string } {
  const exact = name.toLowerCase();
  return { exact, base: sqlObjectBaseName(name).toLowerCase() };
}

function addDefinition(
  definitionsByExactName: Map<string, SqlStatementFact[]>,
  definitionsByBaseName: Map<string, SqlStatementFact[]>,
  fact: SqlStatementFact,
): void {
  if (!fact.objectName) return;
  const keys = definitionKeys(fact.objectName);
  pushSqlLookupValue(definitionsByExactName, keys.exact, fact);
  pushSqlLookupValue(definitionsByBaseName, keys.base, fact);
}

function sqlEdgesForCandidates(
  normalizedFile: string,
  fact: SqlStatementFact,
  objectName: string,
  match: SqlDefinitionCandidateMatch,
): Edge[] {
  const candidates: SqlStatementFact[] = [];
  for (const candidate of match.candidates) {
    if (candidate.filePath !== normalizedFile) candidates.push(candidate);
  }
  return candidates.map((candidate) => ({
    from: normalizedFile,
    to: { type: "file", path: candidate.filePath },
    raw: `sql:${fact.kind}:${objectName}`,
    resolved: match.resolved,
    confidence: match.confidence,
  }));
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

export async function buildSqlFactCache(
  allFiles: readonly string[],
  languageExtensions?: LanguageExtensionMap,
): Promise<SqlFactCache> {
  const sqlFiles = Array.from(
    new Set(allFiles.map(normalizePath).filter((file) => isSqlFile(file, languageExtensions))),
  ).sort((left, right) => left.localeCompare(right));
  const factGroups = await mapLimit(
    sqlFiles,
    SQL_FACT_READ_CONCURRENCY,
    async (file) => [file, await readSqlFacts(file)] as const,
  );
  const factsByFile = new Map<string, SqlStatementFact[]>();
  const definitionsByExactName = new Map<string, SqlStatementFact[]>();
  const definitionsByBaseName = new Map<string, SqlStatementFact[]>();

  for (const [file, facts] of factGroups) {
    factsByFile.set(file, facts);
    for (const fact of facts) {
      if (!isDefinitionFact(fact) || !fact.objectName) continue;
      addDefinition(definitionsByExactName, definitionsByBaseName, fact);
    }
  }
  return { factsByFile, definitionsByExactName, definitionsByBaseName };
}

export async function collectSqlEdgesForFile(
  filePath: string,
  allFiles: readonly string[],
  factCache?: SqlFactCache,
  languageExtensions?: LanguageExtensionMap,
): Promise<Edge[]> {
  const normalizedFile = normalizePath(filePath);
  if (!isSqlFile(normalizedFile, languageExtensions)) return [];
  const cache = factCache ?? (await buildSqlFactCache(allFiles, languageExtensions));
  const currentFacts = cache.factsByFile.get(normalizedFile) ?? [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const fact of currentFacts) {
    for (const objectName of referenceObjectNames(fact)) {
      const match = sqlDefinitionCandidates(cache, objectName);
      for (const edge of sqlEdgesForCandidates(normalizedFile, fact, objectName, match)) {
        const targetPath = edge.to.type === "file" ? edge.to.path : "";
        const key = `${edge.from}:${targetPath}:${edge.raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(edge);
      }
    }
  }
  return edges;
}
