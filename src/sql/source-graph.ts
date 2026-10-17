import crypto from "node:crypto";
import fsp from "node:fs/promises";

import { uniqueByKey } from "../util/collections.js";
import { edgeKey } from "../util/graph-edges.js";
import type { ModuleIndex, SymbolDef } from "../indexer/types.js";
import { SymbolKind } from "../indexer/types.js";
import type { Edge, Range } from "../types.js";
import { normalizePath } from "../util/paths.js";
import { mapLimit } from "../util/concurrency.js";
import { supportForFileWithoutHeaderSample, type LanguageExtensionMap } from "../languages.js";
import { extractSqlFactsFromSource, sqlObjectBaseName } from "./extract-facts.js";
import {
  addSqlDefinition,
  createSqlDefinitionIndex,
  pushSqlLookupValue,
  sqlObjectNamesMatchConservatively,
  sqlRoutineNameCandidates,
  type SqlDefinitionIndex,
} from "./lookup.js";
import { sqlRelationNameIsRoutineCall } from "./object-mentions.js";
import {
  findSqlRoutineMentions,
  sqlRoutineDefinitionNamespace,
  sqlStatementDropsRoutine,
  type SqlRoutineMention,
  type SqlRoutineMentionKind,
  type SqlRoutineNamespace,
} from "./routine-mentions.js";
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
  /** Table, view, and index definitions. Routines have their own name spaces below. */
  definitionsByExactName: Map<string, SqlStatementFact[]>;
  definitionsByBaseName: Map<string, SqlStatementFact[]>;
  /** Function and procedure definitions, which a call or a routine statement names. */
  callableDefinitions: SqlDefinitionIndex<SqlStatementFact>;
  /** Trigger definitions, which only a trigger statement names. */
  triggerDefinitions: SqlDefinitionIndex<SqlStatementFact>;
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
  return supportForFileWithoutHeaderSample(filePath, languageExtensions)?.id === "sql";
}

export function sqlCorpusSignature(
  sqlFiles: readonly string[],
  fileSignatures: Map<string, SqlFileSignature> | undefined,
): string | undefined {
  if (!sqlFiles.length || !fileSignatures) return undefined;
  const hash = crypto.createHash("sha1");
  hash.update("sql-corpus-v3\0");
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

// Two statements can share a line, so the start offset tells definitions apart, not the start line.
function uniqueFacts(candidates: readonly SqlStatementFact[]): SqlStatementFact[] {
  return uniqueByKey(
    candidates,
    (candidate) => `${candidate.filePath}:${candidate.startIndex}:${candidate.kind}:${candidate.objectName ?? ""}`,
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

function sqlRoutineDefinitionCandidates(
  definitions: SqlDefinitionIndex<SqlStatementFact>,
  name: string,
): SqlDefinitionCandidateMatch {
  const { candidates, exact } = sqlRoutineNameCandidates(definitions, name, (fact) => fact.objectName ?? "");
  // Two files can define `refresh`. Count before uniqueFacts: collapsing rows would hide that more
  // than one candidate exists and still emit an edge to every surviving row.
  if (candidates.length !== 1) return { candidates: [], resolved: "heuristic", confidence: exact ? 0.8 : 0.7 };
  return {
    candidates: uniqueFacts(candidates),
    resolved: exact ? "precise" : "heuristic",
    confidence: exact ? 1 : 0.7,
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

export type SqlTargetNamespace = "relation" | SqlRoutineNamespace;

function sqlEdgeRaw(kind: SqlFactKind, namespace: SqlTargetNamespace, objectName: string): string {
  if (namespace === "relation") return `sql:${kind}:${objectName}`;
  return `sql:${kind}:${namespace}:${objectName}`;
}

function sqlEdgesForCandidates(
  normalizedFile: string,
  kind: SqlFactKind,
  objectName: string,
  match: SqlDefinitionCandidateMatch,
  namespace: SqlTargetNamespace,
): Edge[] {
  const candidates: SqlStatementFact[] = [];
  for (const candidate of match.candidates) {
    if (candidate.filePath !== normalizedFile) candidates.push(candidate);
  }
  const raw = sqlEdgeRaw(kind, namespace, objectName);
  return candidates.map((candidate) => ({
    from: normalizedFile,
    to: { type: "file", path: candidate.filePath },
    raw,
    resolved: match.resolved,
    confidence: match.confidence,
  }));
}

// A routine call is a read of the routine, so a changed routine reaches the files that call it.
const ROUTINE_MENTION_EDGE_KINDS: Record<Exclude<SqlRoutineMentionKind, "definition">, SqlFactKind> = {
  call: "reads_from",
  drop: "drops_object",
  reference: "references_object",
};

function sqlRoutineMentionEdges(
  normalizedFile: string,
  facts: readonly SqlStatementFact[],
  cache: SqlFactCache,
): Edge[] {
  const edges: Edge[] = [];
  const scannedStatements = new Set<number>();
  for (const fact of facts) {
    if (scannedStatements.has(fact.startIndex)) continue;
    scannedStatements.add(fact.startIndex);
    for (const mention of findSqlRoutineMentions(fact.statementText)) {
      if (mention.kind === "definition") continue;
      const definitions = mention.namespace === "trigger" ? cache.triggerDefinitions : cache.callableDefinitions;
      const match = sqlRoutineDefinitionCandidates(definitions, mention.name);
      edges.push(
        ...sqlEdgesForCandidates(
          normalizedFile,
          ROUTINE_MENTION_EDGE_KINDS[mention.kind],
          mention.name,
          match,
          mention.namespace,
        ),
      );
    }
  }
  return edges;
}

export type SqlChangedObject = { name: string; namespace?: SqlTargetNamespace };

const ROUTINE_EDGE_NAMESPACES = new Set<SqlTargetNamespace>(["callable", "trigger"]);

export function sqlEdgeTargetFromRaw(raw: string | undefined): { namespace: SqlTargetNamespace; name: string } | null {
  if (!raw?.startsWith("sql:")) return null;
  const kindSeparator = raw.indexOf(":", 4);
  if (kindSeparator < 0) return null;
  const rest = raw.slice(kindSeparator + 1);
  if (!rest) return null;
  const namespaceSeparator = rest.indexOf(":");
  if (namespaceSeparator > 0) {
    const namespace = rest.slice(0, namespaceSeparator);
    const name = rest.slice(namespaceSeparator + 1);
    if (ROUTINE_EDGE_NAMESPACES.has(namespace as SqlTargetNamespace)) {
      return name ? { namespace: namespace as SqlTargetNamespace, name } : null;
    }
  }
  return { namespace: "relation", name: rest };
}

export function sqlObjectNameFromEdgeRaw(raw: string | undefined): string | null {
  return sqlEdgeTargetFromRaw(raw)?.name ?? null;
}

export function sqlEdgeMatchesChangedObjects(raw: string | undefined, objects: readonly SqlChangedObject[]): boolean {
  const target = sqlEdgeTargetFromRaw(raw);
  if (!target || !objects.length) return false;
  for (const object of objects) {
    if (object.namespace !== undefined && object.namespace !== target.namespace) continue;
    if (sqlObjectNamesMatchConservatively(target.name, object.name)) return true;
  }
  return false;
}

export function buildSqlModuleIndex(filePath: string, source: string): ModuleIndex {
  const normalizedFile = normalizePath(filePath);
  const facts = extractSqlFactsFromSource(normalizedFile, source);
  const locals: SymbolDef[] = [];
  const exports: ModuleIndex["exports"] = [];
  const seen = new Set<string>();

  for (const fact of facts) {
    if (!isDefinitionFact(fact) || !fact.objectName) continue;
    const key = `${fact.objectName}:${fact.startIndex}:${fact.kind}`;
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
  const callableDefinitions = createSqlDefinitionIndex<SqlStatementFact>();
  const triggerDefinitions = createSqlDefinitionIndex<SqlStatementFact>();

  for (const [file, facts] of factGroups) {
    factsByFile.set(file, facts);
    for (const fact of facts) {
      if (!isDefinitionFact(fact) || !fact.objectName) continue;
      if (fact.kind !== "defines_routine") {
        addDefinition(definitionsByExactName, definitionsByBaseName, fact);
        continue;
      }
      const isTrigger = sqlRoutineDefinitionNamespace(fact.statementText) === "trigger";
      addSqlDefinition(isTrigger ? triggerDefinitions : callableDefinitions, fact.objectName, fact);
    }
  }
  return { factsByFile, definitionsByExactName, definitionsByBaseName, callableDefinitions, triggerDefinitions };
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
  const addEdge = (edge: Edge): void => {
    const key = edgeKey(edge);
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };
  // A call in a `FROM` list reads a routine, not a table of that name. Only a name that an indexed
  // routine carries is one: `FROM users (NOLOCK)` reads a table, and so does a call to a function
  // that the indexed files do not define. Navigation applies the same rule.
  const hasCallables = !!cache.callableDefinitions.exact.size;
  const namesIndexedRoutine = (mention: SqlRoutineMention): boolean =>
    !!sqlRoutineNameCandidates(cache.callableDefinitions, mention.name, (fact) => fact.objectName ?? "").candidates
      .length;
  for (const fact of currentFacts) {
    // The name in `DROP FUNCTION name` is a routine mention below, never a table of the same name.
    if (fact.kind === "drops_object" && sqlStatementDropsRoutine(fact.statementText)) continue;
    const readsRelation = fact.kind === "reads_from" || fact.kind === "joins";
    for (const objectName of referenceObjectNames(fact)) {
      // A write target such as `INSERT INTO get_users` is still the table.
      const isCall =
        hasCallables &&
        readsRelation &&
        sqlRelationNameIsRoutineCall(fact.statementText, objectName, namesIndexedRoutine);
      if (isCall) continue;
      const match = sqlDefinitionCandidates(cache, objectName);
      for (const edge of sqlEdgesForCandidates(normalizedFile, fact.kind, objectName, match, "relation")) addEdge(edge);
    }
  }
  const hasRoutineDefinitions = cache.callableDefinitions.exact.size || cache.triggerDefinitions.exact.size;
  if (hasRoutineDefinitions) {
    for (const edge of sqlRoutineMentionEdges(normalizedFile, currentFacts, cache)) addEdge(edge);
  }
  return edges;
}
