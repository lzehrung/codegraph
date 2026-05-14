import fs from "node:fs/promises";
import path from "node:path";
import { findReferences } from "../indexer.js";
import type { Reference, SymbolDef } from "../indexer/types.js";
import { getDependencies, getHotspots, getReverseDependencies } from "../graphs.js";
import { defNodeId } from "../graphs/symbol-graph.js";
import type { SymbolNode } from "../graphs.js";
import { buildReviewReport } from "../review.js";
import { extractSqlFactsFromSource, sqlObjectBaseName } from "../sql/extractFacts.js";
import type { SqlStatementFact } from "../sql/types.js";
import type { Range } from "../types.js";
import { normalizePath, toProjectRelativePath } from "../util.js";
import { mapLimit } from "../util/resolution.js";
import {
  formatAgentFileHandle,
  formatAgentSqlHandle,
  formatAgentSymbolHandle,
  parseAgentChunkHandle,
  parseAgentFileHandle,
  parseAgentGraphHandle,
  parseAgentSqlHandle,
  parseAgentSymbolHandle,
} from "./handles.js";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "./session.js";

export type AgentExplainTarget = {
  root: string;
  target: string;
  includeChangedContext?: boolean;
  base?: string;
  head?: string;
  maxDependencies?: number;
  maxReferences?: number;
  maxRelatedSqlObjects?: number;
  maxSnippets?: number;
  maxSymbols?: number;
};

export type AgentExplanationTarget = {
  kind: "file" | "symbol" | "sql_object" | "not_found";
  label: string;
  file?: string;
  range?: Range;
  handle?: string;
};

export type AgentExplanationSymbol = {
  name: string;
  kind: string;
  range: Range;
  exported: boolean;
};

export type AgentExplanationDependency = {
  file: string;
  depth: number;
};

export type AgentExplanationReference = {
  file: string;
  range: Range;
};

export type AgentExplanationSnippet = {
  file: string;
  line: number;
  text: string;
};

export type AgentExplanationSqlObject = {
  name: string;
  kind: string;
  file: string;
  relation: string;
  range?: Range;
};

export type AgentExplanationChangedContext = {
  filesChanged: number;
  symbolsChanged: number;
  risk: string;
  changedFiles: string[];
  reviewTasks: Array<{ id: string; reason: string; summary: string; priority: string }>;
  candidateTests: Array<{ file: string; confidence: string; reason: string }>;
};

export type AgentExplanation = {
  schemaVersion: 1;
  root: string;
  target: AgentExplanationTarget;
  summary: string[];
  symbols: AgentExplanationSymbol[];
  dependencies: AgentExplanationDependency[];
  reverseDependencies: AgentExplanationDependency[];
  references: AgentExplanationReference[];
  relatedSqlObjects: AgentExplanationSqlObject[];
  snippets: AgentExplanationSnippet[];
  hotspots: Array<{ file: string; fanIn: number; fanOut: number; score: number }>;
  followUps: string[];
  limits: {
    symbols: number;
    dependencies: number;
    references: number;
    relatedSqlObjects: number;
    snippets: number;
  };
  omittedCounts: {
    symbols: number;
    dependencies: number;
    reverseDependencies: number;
    references: number;
    relatedSqlObjects: number;
    snippets: number;
  };
  changedContext?: AgentExplanationChangedContext;
};

type SymbolLookup = {
  defById: Map<string, SymbolDef>;
  exportedIds: Set<string>;
};

type BoundedList<T> = {
  items: T[];
  omitted: number;
};

type ReferenceContext = {
  references: BoundedList<AgentExplanationReference>;
  snippets: BoundedList<AgentExplanationSnippet>;
};

type ResolvedExplainTarget =
  | { kind: "file"; file: string }
  | { kind: "symbol"; def: SymbolDef; node?: SymbolNode }
  | { kind: "sql_object"; def: SymbolDef; node?: SymbolNode }
  | { kind: "not_found"; label: string };

const DEFAULT_MAX_DEPENDENCIES = 20;
const DEFAULT_MAX_SNIPPETS = 8;
const DEFAULT_MAX_SYMBOLS = 50;
const MAX_DEPENDENCIES = 100;
const MAX_SNIPPETS = 50;
const MAX_SYMBOLS = 200;
const SQL_FACT_READ_CONCURRENCY = 32;

export async function explainCodegraphTarget(request: AgentExplainTarget): Promise<AgentExplanation> {
  const session = createAgentSession({ root: request.root });
  return await explainCodegraphTargetWithSession(session, request);
}

export async function explainCodegraphTargetWithSession(
  session: AgentSession,
  request: AgentExplainTarget,
): Promise<AgentExplanation> {
  const snapshot = await session.loadProject();
  const lookup = buildSymbolLookup(snapshot);
  const resolved = resolveTarget(snapshot, lookup, request.target);
  return await buildExplanation(snapshot, lookup, resolved, request);
}

export function formatAgentExplanation(explanation: AgentExplanation): string {
  const lines = [
    `${explanation.target.kind}: ${explanation.target.label}`,
    ...explanation.summary.map((entry) => `- ${entry}`),
  ];
  if (explanation.symbols.length > 0) {
    lines.push(
      `symbols: ${explanation.symbols
        .map((symbol) => symbol.name)
        .slice(0, 8)
        .join(", ")}`,
    );
  }
  if (explanation.dependencies.length > 0) {
    lines.push(`deps: ${explanation.dependencies.map((entry) => entry.file).join(", ")}`);
  }
  if (explanation.reverseDependencies.length > 0) {
    lines.push(`rdeps: ${explanation.reverseDependencies.map((entry) => entry.file).join(", ")}`);
  }
  if (explanation.followUps.length > 0) {
    lines.push("follow-ups:", ...explanation.followUps.slice(0, 8).map((command) => `  ${command}`));
  }
  return lines.join("\n");
}

function buildSymbolLookup(snapshot: AgentProjectSnapshot): SymbolLookup {
  const defById = new Map<string, SymbolDef>();
  const exportedIds = new Set<string>();

  for (const moduleIndex of snapshot.index.byFile.values()) {
    for (const local of moduleIndex.locals) {
      defById.set(defNodeId(local), local);
    }
    for (const exportEntry of moduleIndex.exports) {
      if (exportEntry.type === "local") exportedIds.add(defNodeId(exportEntry.target));
    }
  }

  return { defById, exportedIds };
}

function resolveTarget(snapshot: AgentProjectSnapshot, lookup: SymbolLookup, target: string): ResolvedExplainTarget {
  const fileHandle = parseAgentFileHandle(target);
  const chunkHandle = parseAgentChunkHandle(target);
  const graphHandle = parseAgentGraphHandle(target);
  const fileTarget = fileHandle?.file ?? chunkHandle?.file ?? graphHandle?.file ?? target;
  const file = resolveFileCandidate(snapshot, fileTarget);
  if (file) return { kind: "file", file };

  if (target.startsWith("symbol:")) {
    const resolvedSymbolHandle = resolveSymbolHandle(snapshot, lookup, target);
    if (resolvedSymbolHandle) return resolvedSymbolHandle;
  }

  if (target.startsWith("sql:")) {
    const resolvedSqlHandle = resolveSqlHandle(snapshot, lookup, target);
    if (resolvedSqlHandle) return resolvedSqlHandle;
  }

  const exactSymbol = findSymbolByName(snapshot, lookup, target);
  if (exactSymbol) return exactSymbol;

  const sqlObject = findSqlObjectByName(snapshot, lookup, target);
  if (sqlObject) return sqlObject;

  return { kind: "not_found", label: target };
}

function resolveSymbolHandle(
  snapshot: AgentProjectSnapshot,
  lookup: SymbolLookup,
  handle: string,
): Extract<ResolvedExplainTarget, { kind: "symbol" }> | null {
  const parsed = parseAgentSymbolHandle(handle);
  if (parsed) {
    const file = resolveFileCandidate(snapshot, parsed.file);
    if (!file) return null;
    for (const def of lookup.defById.values()) {
      if (isSqlFile(def.file)) continue;
      if (normalizePath(def.file) !== file) continue;
      if (def.localName !== parsed.name) continue;
      if (def.range.start.line !== parsed.line || def.range.start.column !== parsed.column) continue;
      return symbolTarget(def, snapshot.symbolGraph.nodes.get(defNodeId(def)));
    }
    for (const node of snapshot.symbolGraph.nodes.values()) {
      const def = lookup.defById.get(node.id);
      if (!def || isSqlObjectNode(node)) continue;
      if (normalizePath(node.file) !== file) continue;
      if (node.name !== parsed.name) continue;
      if (def.range.start.line !== parsed.line || def.range.start.column !== parsed.column) continue;
      return symbolTarget(def, node);
    }
    return null;
  }

  const id = handle.slice("symbol:".length);
  const def = lookup.defById.get(id);
  return def ? symbolTarget(def, snapshot.symbolGraph.nodes.get(id)) : null;
}

function resolveFileCandidate(snapshot: AgentProjectSnapshot, candidate: string): string | null {
  const normalizedFiles = new Map(snapshot.files.map((file) => [normalizePath(file), normalizePath(file)]));
  const absoluteCandidate = path.isAbsolute(candidate)
    ? normalizePath(candidate)
    : normalizePath(path.resolve(snapshot.root, candidate));
  return normalizedFiles.get(absoluteCandidate) ?? null;
}

function resolveSqlHandle(
  snapshot: AgentProjectSnapshot,
  lookup: SymbolLookup,
  handle: string,
): Extract<ResolvedExplainTarget, { kind: "sql_object" }> | null {
  const parsed = parseAgentSqlHandle(handle);
  if (!parsed) return null;

  for (const node of snapshot.symbolGraph.nodes.values()) {
    const def = lookup.defById.get(node.id);
    if (!def || !isSqlObjectNode(node)) continue;
    if (
      node.name === parsed.name &&
      relativeFile(snapshot.root, node.file) === parsed.file &&
      def.range.start.line === parsed.line
    ) {
      return { kind: "sql_object", def, node };
    }
  }
  return null;
}

function findSymbolByName(
  snapshot: AgentProjectSnapshot,
  lookup: SymbolLookup,
  name: string,
): Extract<ResolvedExplainTarget, { kind: "symbol" }> | null {
  const matches = [...snapshot.symbolGraph.nodes.values()]
    .filter((node) => !isSqlObjectNode(node) && node.name === name)
    .sort(compareSymbolNodes);
  const node = matches[0];
  if (node) {
    const def = lookup.defById.get(node.id);
    if (def) return symbolTarget(def, node);
  }

  const defMatches = [...lookup.defById.values()]
    .filter((def) => !isSqlFile(def.file) && def.localName === name)
    .sort(compareSymbolDefs);
  const def = defMatches[0];
  return def ? symbolTarget(def, snapshot.symbolGraph.nodes.get(defNodeId(def))) : null;
}

function findSqlObjectByName(
  snapshot: AgentProjectSnapshot,
  lookup: SymbolLookup,
  name: string,
): Extract<ResolvedExplainTarget, { kind: "sql_object" }> | null {
  const matches = [...snapshot.symbolGraph.nodes.values()]
    .filter((node) => isSqlObjectNode(node) && (node.name === name || basename(node.name) === name))
    .sort(compareSymbolNodes);
  const node = matches[0];
  if (!node) return null;
  const def = lookup.defById.get(node.id);
  return def ? { kind: "sql_object", def, node } : null;
}

function symbolTarget(
  def: SymbolDef,
  node: SymbolNode | undefined,
): Extract<ResolvedExplainTarget, { kind: "symbol" }> {
  return {
    kind: "symbol",
    def,
    ...(node ? { node } : {}),
  };
}

function compareSymbolDefs(left: SymbolDef, right: SymbolDef): number {
  const fileDelta = left.file.localeCompare(right.file);
  if (fileDelta !== 0) return fileDelta;
  const lineDelta = left.range.start.line - right.range.start.line;
  if (lineDelta !== 0) return lineDelta;
  return left.localName.localeCompare(right.localName);
}

function compareSymbolNodes(left: SymbolNode, right: SymbolNode): number {
  const nameDelta = left.name.localeCompare(right.name);
  if (nameDelta !== 0) return nameDelta;
  return left.file.localeCompare(right.file);
}

function basename(name: string): string {
  const parts = name.split(".");
  return parts[parts.length - 1] ?? name;
}

async function buildExplanation(
  snapshot: AgentProjectSnapshot,
  lookup: SymbolLookup,
  resolved: ResolvedExplainTarget,
  request: AgentExplainTarget,
): Promise<AgentExplanation> {
  const maxDependencies = normalizeLimit(request.maxDependencies, DEFAULT_MAX_DEPENDENCIES);
  const maxReferences = normalizeLimit(request.maxReferences ?? request.maxDependencies, DEFAULT_MAX_DEPENDENCIES);
  const maxRelatedSqlObjects = normalizeLimit(
    request.maxRelatedSqlObjects ?? request.maxDependencies,
    DEFAULT_MAX_DEPENDENCIES,
  );
  const maxSnippets = normalizeLimit(request.maxSnippets, DEFAULT_MAX_SNIPPETS, MAX_SNIPPETS);
  const maxSymbols = normalizeLimit(request.maxSymbols, DEFAULT_MAX_SYMBOLS, MAX_SYMBOLS);

  if (resolved.kind === "not_found") {
    return emptyExplanation(snapshot, {
      kind: "not_found",
      label: resolved.label,
    });
  }

  const file = resolved.kind === "file" ? resolved.file : normalizePath(resolved.def.file);
  const relFile = relativeFile(snapshot.root, file);
  const allSymbols = collectFileSymbols(snapshot, lookup, file);
  const symbols = allSymbols.slice(0, maxSymbols);
  const dependencies = collectDependencies(snapshot, file, maxDependencies, "forward");
  const reverseDependencies = collectDependencies(snapshot, file, maxDependencies, "reverse");
  const hotspots = collectTargetHotspots(snapshot, file);
  const referenceContext =
    resolved.kind === "file"
      ? emptyReferenceContext()
      : await collectReferenceContext(snapshot, resolved.def, maxReferences, maxSnippets);
  const references = referenceContext.references;
  const snippets = referenceContext.snippets;
  const relatedSqlObjects = await collectRelatedSqlObjects(snapshot, lookup, resolved, file, maxRelatedSqlObjects);
  const followUps = collectFollowUps(snapshot, resolved, symbols, relFile);
  const changedContext = await collectChangedContext(request);

  return {
    schemaVersion: 1,
    root: snapshot.root,
    target: explainTarget(snapshot, resolved, relFile),
    summary: buildSummary(
      resolved,
      relFile,
      allSymbols.length,
      dependencies.items,
      reverseDependencies.items,
      references.items,
      relatedSqlObjects.items,
    ),
    symbols,
    dependencies: dependencies.items,
    reverseDependencies: reverseDependencies.items,
    references: references.items,
    relatedSqlObjects: relatedSqlObjects.items,
    snippets: snippets.items,
    hotspots,
    followUps,
    limits: {
      symbols: maxSymbols,
      dependencies: maxDependencies,
      references: maxReferences,
      relatedSqlObjects: maxRelatedSqlObjects,
      snippets: maxSnippets,
    },
    omittedCounts: {
      symbols: Math.max(0, allSymbols.length - symbols.length),
      dependencies: dependencies.omitted,
      reverseDependencies: reverseDependencies.omitted,
      references: references.omitted,
      relatedSqlObjects: relatedSqlObjects.omitted,
      snippets: snippets.omitted,
    },
    ...(changedContext ? { changedContext } : {}),
  };
}

function emptyExplanation(snapshot: AgentProjectSnapshot, target: AgentExplanationTarget): AgentExplanation {
  return {
    schemaVersion: 1,
    root: snapshot.root,
    target,
    summary: [`No indexed target resolved for ${target.label}.`],
    symbols: [],
    dependencies: [],
    reverseDependencies: [],
    references: [],
    relatedSqlObjects: [],
    snippets: [],
    hotspots: [],
    followUps: [`codegraph search ${quoteArg(target.label)} --json`],
    limits: {
      symbols: DEFAULT_MAX_SYMBOLS,
      dependencies: DEFAULT_MAX_DEPENDENCIES,
      references: DEFAULT_MAX_DEPENDENCIES,
      relatedSqlObjects: DEFAULT_MAX_DEPENDENCIES,
      snippets: DEFAULT_MAX_SNIPPETS,
    },
    omittedCounts: {
      symbols: 0,
      dependencies: 0,
      reverseDependencies: 0,
      references: 0,
      relatedSqlObjects: 0,
      snippets: 0,
    },
  };
}

function explainTarget(
  snapshot: AgentProjectSnapshot,
  resolved: Exclude<ResolvedExplainTarget, { kind: "not_found" }>,
  relFile: string,
): AgentExplanationTarget {
  if (resolved.kind === "file") {
    return {
      kind: "file",
      label: relFile,
      file: relFile,
      handle: formatAgentFileHandle({ file: relFile }),
    };
  }

  const nodeName = resolved.node?.name ?? resolved.def.localName;
  if (resolved.kind === "sql_object") {
    return {
      kind: "sql_object",
      label: nodeName,
      file: relFile,
      range: resolved.def.range,
      handle: formatAgentSqlHandle({ name: nodeName, file: relFile, line: resolved.def.range.start.line }),
    };
  }

  return {
    kind: "symbol",
    label: nodeName,
    file: relFile,
    range: resolved.def.range,
    handle: formatAgentSymbolHandle({
      file: relFile,
      name: nodeName,
      line: resolved.def.range.start.line,
      column: resolved.def.range.start.column,
    }),
  };
}

function collectFileSymbols(
  snapshot: AgentProjectSnapshot,
  lookup: SymbolLookup,
  file: string,
): AgentExplanationSymbol[] {
  const moduleIndex = snapshot.index.byFile.get(file);
  if (!moduleIndex) return [];
  return moduleIndex.locals
    .map((local) => ({
      name: local.localName,
      kind: local.kind,
      range: local.range,
      exported: lookup.exportedIds.has(defNodeId(local)),
    }))
    .sort((left, right) => {
      const lineDelta = left.range.start.line - right.range.start.line;
      if (lineDelta !== 0) return lineDelta;
      return left.name.localeCompare(right.name);
    });
}

function collectDependencies(
  snapshot: AgentProjectSnapshot,
  file: string,
  limit: number,
  direction: "forward" | "reverse",
): BoundedList<AgentExplanationDependency> {
  const startFile = normalizePath(file);
  const dependencies =
    direction === "forward"
      ? getDependencies(snapshot.fileGraph, startFile, { depth: 1 })
      : getReverseDependencies(snapshot.fileGraph, startFile, { depth: 1 });
  const items = dependencies
    .map((dependency) => ({
      file: relativeFile(snapshot.root, dependency.file),
      depth: dependency.depth,
    }))
    .sort(compareDependencies)
    .slice(0, limit);
  return {
    items,
    omitted: Math.max(0, dependencies.length - items.length),
  };
}

function compareDependencies(left: AgentExplanationDependency, right: AgentExplanationDependency): number {
  const depthDelta = left.depth - right.depth;
  if (depthDelta !== 0) return depthDelta;
  return left.file.localeCompare(right.file);
}

function collectTargetHotspots(
  snapshot: AgentProjectSnapshot,
  file: string,
): Array<{ file: string; fanIn: number; fanOut: number; score: number }> {
  const normalizedFile = normalizePath(file);
  return getHotspots(snapshot.fileGraph, { limit: snapshot.files.length })
    .filter((hotspot) => normalizePath(hotspot.file) === normalizedFile)
    .map((hotspot) => ({
      file: relativeFile(snapshot.root, hotspot.file),
      fanIn: hotspot.fanIn,
      fanOut: hotspot.fanOut,
      score: hotspot.score,
    }));
}

async function collectReferenceContext(
  snapshot: AgentProjectSnapshot,
  def: SymbolDef,
  referenceLimit: number,
  snippetLimit: number,
): Promise<ReferenceContext> {
  const result = await findReferences(snapshot.index, { def }, { context: "line" });
  if (result.status !== "ok") return emptyReferenceContext();

  const references = result.references
    .map((reference) => ({
      file: relativeFile(snapshot.root, reference.file),
      range: reference.range,
    }))
    .sort((left, right) => {
      const fileDelta = left.file.localeCompare(right.file);
      if (fileDelta !== 0) return fileDelta;
      return left.range.start.line - right.range.start.line;
    });
  const referenceItems = references.slice(0, referenceLimit);

  const referencesWithContext = result.references.filter((reference) => reference.context !== undefined);
  const snippets = referencesWithContext
    .map((reference) => snippetFromReference(snapshot, reference))
    .sort((left, right) => {
      const fileDelta = left.file.localeCompare(right.file);
      if (fileDelta !== 0) return fileDelta;
      return left.line - right.line;
    });
  const snippetItems = snippets.slice(0, snippetLimit);

  return {
    references: {
      items: referenceItems,
      omitted: Math.max(0, references.length - referenceItems.length),
    },
    snippets: {
      items: snippetItems,
      omitted: Math.max(0, snippets.length - snippetItems.length),
    },
  };
}

function snippetFromReference(snapshot: AgentProjectSnapshot, reference: Reference): AgentExplanationSnippet {
  return {
    file: relativeFile(snapshot.root, reference.file),
    line: reference.range.start.line,
    text: reference.context ?? "",
  };
}

async function collectRelatedSqlObjects(
  snapshot: AgentProjectSnapshot,
  lookup: SymbolLookup,
  resolved: Exclude<ResolvedExplainTarget, { kind: "not_found" }>,
  file: string,
  limit: number,
): Promise<BoundedList<AgentExplanationSqlObject>> {
  if (resolved.kind !== "sql_object" && !isSqlFile(file)) return emptyBoundedList();

  const sqlObjects = collectSqlObjectNodes(snapshot, lookup);
  const targetName = resolved.kind === "sql_object" ? (resolved.node?.name ?? resolved.def.localName) : undefined;
  const related = new Map<string, AgentExplanationSqlObject>();
  const addRelated = (object: SqlObjectNodeInfo, relation: string): void => {
    const entry: AgentExplanationSqlObject = {
      name: object.name,
      kind: object.kind,
      file: relativeFile(snapshot.root, object.file),
      relation,
      ...(object.def ? { range: object.def.range } : {}),
    };
    related.set(`${entry.relation}:${entry.file}:${entry.name}`, entry);
  };

  const normalizedFile = normalizePath(file);
  if (!targetName) {
    for (const object of sqlObjects) {
      if (normalizePath(object.file) === normalizedFile) addRelated(object, "same_file");
    }
  } else {
    for (const object of sqlObjects) {
      if (normalizePath(object.file) === normalizedFile && !sqlObjectNamesEquivalent(object.name, targetName)) {
        addRelated(object, "same_file");
      }
    }
    addRelatedSqlObjectsFromFileEdges(snapshot, sqlObjects, normalizedFile, targetName, addRelated);
    await addRelatedSqlObjectsFromFacts(snapshot, sqlObjects, targetName, addRelated);
  }

  const matches = [...related.values()].sort((left, right) => {
    const relationDelta = sqlRelationRank(left.relation) - sqlRelationRank(right.relation);
    if (relationDelta !== 0) return relationDelta;
    const fileDelta = left.file.localeCompare(right.file);
    if (fileDelta !== 0) return fileDelta;
    return left.name.localeCompare(right.name);
  });
  const items = matches.slice(0, limit);
  return {
    items,
    omitted: Math.max(0, matches.length - items.length),
  };
}

type SqlObjectNodeInfo = {
  id: string;
  name: string;
  kind: string;
  file: string;
  def?: SymbolDef;
};

function collectSqlObjectNodes(snapshot: AgentProjectSnapshot, lookup: SymbolLookup): SqlObjectNodeInfo[] {
  return [...snapshot.symbolGraph.nodes.values()]
    .filter((node) => isSqlObjectNode(node))
    .map((node) => {
      const base = {
        id: node.id,
        name: node.name,
        kind: node.kind,
        file: normalizePath(node.file),
      };
      const def = lookup.defById.get(node.id);
      return def ? { ...base, def } : base;
    });
}

function sqlObjectNamesEquivalent(candidate: string, target: string): boolean {
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedTarget = target.toLowerCase();
  if (normalizedCandidate === normalizedTarget) return true;
  if (candidate.includes(".") && target.includes(".")) return false;
  return sqlObjectBaseName(candidate).toLowerCase() === sqlObjectBaseName(target).toLowerCase();
}

function findSqlObjectsByReferenceName(
  sqlObjects: readonly SqlObjectNodeInfo[],
  objectName: string,
): SqlObjectNodeInfo[] {
  const normalizedName = objectName.toLowerCase();
  const exact = sqlObjects.filter((candidate) => candidate.name.toLowerCase() === normalizedName);
  if (exact.length > 0) return exact;
  const baseName = sqlObjectBaseName(objectName).toLowerCase();
  const basenameMatches = sqlObjects.filter(
    (candidate) => sqlObjectBaseName(candidate.name).toLowerCase() === baseName,
  );
  return basenameMatches.length === 1 ? basenameMatches : [];
}

function referenceTargetsSqlName(
  sqlObjects: readonly SqlObjectNodeInfo[],
  referenceName: string,
  targetName: string,
): boolean {
  return findSqlObjectsByReferenceName(sqlObjects, referenceName).some((candidate) =>
    sqlObjectNamesEquivalent(candidate.name, targetName),
  );
}

function addRelatedSqlObjectsFromFileEdges(
  snapshot: AgentProjectSnapshot,
  sqlObjects: SqlObjectNodeInfo[],
  targetFile: string,
  targetName: string,
  addRelated: (object: SqlObjectNodeInfo, relation: string) => void,
): void {
  for (const edge of snapshot.fileGraph.edges) {
    const relation = parseSqlEdgeRelation(edge.raw);
    if (!relation) continue;
    if (normalizePath(edge.from) === targetFile) {
      for (const object of findSqlObjectsByReferenceName(sqlObjects, relation.objectName)) {
        addRelated(object, `outgoing:${relation.kind}`);
      }
    }
    if (
      edge.to.type !== "file" ||
      normalizePath(edge.to.path) !== targetFile ||
      !referenceTargetsSqlName(sqlObjects, relation.objectName, targetName)
    ) {
      continue;
    }
    for (const object of sqlObjects.filter((candidate) => normalizePath(candidate.file) === normalizePath(edge.from))) {
      addRelated(object, `incoming:${relation.kind}`);
    }
  }
}

async function addRelatedSqlObjectsFromFacts(
  snapshot: AgentProjectSnapshot,
  sqlObjects: SqlObjectNodeInfo[],
  targetName: string,
  addRelated: (object: SqlObjectNodeInfo, relation: string) => void,
): Promise<void> {
  const factsByFile = await collectSqlFacts(snapshot);
  for (const facts of factsByFile.values()) {
    for (const statementFacts of sqlStatementFactGroups(facts)) {
      const definitions = statementFacts.filter(isSqlDefinitionFact);
      const references = statementFacts.filter(isSqlReferenceFact);
      const statementDefinesTarget = definitions.some(
        (fact) => fact.objectName !== null && sqlObjectNamesEquivalent(fact.objectName, targetName),
      );
      const referencesToTarget = references.filter(
        (fact) => fact.objectName !== null && referenceTargetsSqlName(sqlObjects, fact.objectName, targetName),
      );

      if (statementDefinesTarget) {
        for (const reference of references) {
          if (!reference.objectName) continue;
          for (const object of findSqlObjectsByReferenceName(sqlObjects, reference.objectName)) {
            addRelated(object, `outgoing:${reference.kind}`);
          }
        }
      }

      for (const reference of referencesToTarget) {
        for (const definition of definitions) {
          if (!definition.objectName) continue;
          for (const object of findSqlObjectsByReferenceName(sqlObjects, definition.objectName)) {
            addRelated(object, `incoming:${reference.kind}`);
          }
        }
      }
    }
  }
}

function parseSqlEdgeRelation(raw: string): { kind: string; objectName: string } | null {
  if (!raw.startsWith("sql:")) return null;
  const parts = raw.split(":");
  if (parts.length < 3) return null;
  const kind = parts[1];
  const objectName = parts.slice(2).join(":");
  if (!kind || !objectName) return null;
  return {
    kind,
    objectName,
  };
}

async function collectSqlFacts(snapshot: AgentProjectSnapshot): Promise<Map<string, SqlStatementFact[]>> {
  const sqlFiles = snapshot.files.filter(isSqlFile).sort((left, right) => left.localeCompare(right));
  const entries = await mapLimit(sqlFiles, SQL_FACT_READ_CONCURRENCY, async (file) => {
    const facts = extractSqlFactsFromSource(file, await fs.readFile(file, "utf8"));
    return [file, facts] as const;
  });
  return new Map(entries);
}

function sqlStatementFactGroups(facts: readonly SqlStatementFact[]): SqlStatementFact[][] {
  const groups = new Map<string, SqlStatementFact[]>();
  for (const fact of facts) {
    const key = `${fact.filePath}:${fact.startLine}:${fact.endLine}:${fact.statementText}`;
    const group = groups.get(key);
    if (group) group.push(fact);
    else groups.set(key, [fact]);
  }
  return [...groups.values()];
}

function isSqlDefinitionFact(fact: SqlStatementFact): boolean {
  return (
    fact.kind === "defines_table" ||
    fact.kind === "defines_view" ||
    fact.kind === "defines_index" ||
    fact.kind === "defines_routine"
  );
}

function isSqlReferenceFact(fact: SqlStatementFact): boolean {
  return (
    fact.kind === "alters_table" ||
    fact.kind === "drops_object" ||
    fact.kind === "reads_from" ||
    fact.kind === "writes_to" ||
    fact.kind === "joins" ||
    fact.kind === "references_object" ||
    fact.kind === "renames_object"
  );
}

function sqlRelationRank(relation: string): number {
  if (relation.startsWith("incoming:")) return 0;
  if (relation.startsWith("outgoing:")) return 1;
  if (relation === "same_file") return 2;
  return 3;
}

function emptyBoundedList<T>(): BoundedList<T> {
  return {
    items: [],
    omitted: 0,
  };
}

function emptyReferenceContext(): ReferenceContext {
  return {
    references: emptyBoundedList(),
    snippets: emptyBoundedList(),
  };
}

function collectFollowUps(
  snapshot: AgentProjectSnapshot,
  resolved: Exclude<ResolvedExplainTarget, { kind: "not_found" }>,
  symbols: AgentExplanationSymbol[],
  relFile: string,
): string[] {
  const followUps = new Set<string>([
    `codegraph deps ${quoteArg(relFile)} --json`,
    `codegraph rdeps ${quoteArg(relFile)} --json`,
    `codegraph chunk ${quoteArg(relFile)}`,
  ]);

  if (resolved.kind === "file") {
    for (const symbol of symbols.slice(0, 5)) {
      followUps.add(
        `codegraph refs --file ${quoteArg(relFile)} --line ${symbol.range.start.line} --col ${symbol.range.start.column} --pretty`,
      );
    }
  } else {
    followUps.add(
      `codegraph goto ${quoteArg(relFile)} ${resolved.def.range.start.line} ${resolved.def.range.start.column}`,
    );
    followUps.add(
      `codegraph refs --file ${quoteArg(relFile)} --line ${resolved.def.range.start.line} --col ${resolved.def.range.start.column} --pretty`,
    );
    followUps.add(
      `codegraph search ${quoteArg(resolved.node?.name ?? resolved.def.localName)} --from ${quoteArg(relFile)} --json`,
    );
  }

  if (isSqlFile(path.resolve(snapshot.root, relFile))) {
    followUps.add(`codegraph search ${quoteArg(relFile)} --mode sql --json`);
  }

  return [...followUps].sort();
}

function buildSummary(
  resolved: Exclude<ResolvedExplainTarget, { kind: "not_found" }>,
  relFile: string,
  symbolCount: number,
  dependencies: AgentExplanationDependency[],
  reverseDependencies: AgentExplanationDependency[],
  references: AgentExplanationReference[],
  relatedSqlObjects: AgentExplanationSqlObject[],
): string[] {
  if (resolved.kind === "sql_object") {
    return [
      `${resolved.node?.name ?? resolved.def.localName} is a SQL object defined in ${relFile}.`,
      `Codegraph reports extracted SQL relation facts from indexed .sql files only.`,
      `${relatedSqlObjects.length} related SQL object(s), ${references.length} reference(s).`,
    ];
  }

  if (resolved.kind === "symbol") {
    return [
      `${resolved.node?.name ?? resolved.def.localName} is defined in ${relFile}.`,
      `${references.length} reference(s), ${dependencies.length} direct dependency file(s), ${reverseDependencies.length} direct dependent file(s).`,
    ];
  }

  return [
    `${relFile} contains ${symbolCount} indexed symbol(s).`,
    `${dependencies.length} direct dependency file(s), ${reverseDependencies.length} direct dependent file(s).`,
  ];
}

async function collectChangedContext(request: AgentExplainTarget): Promise<AgentExplanationChangedContext | undefined> {
  if (!request.includeChangedContext || request.base === undefined || request.head === undefined) {
    return undefined;
  }
  const report = await buildReviewReport(request.root, {
    gitBase: request.base,
    gitHead: request.head,
    reviewDepth: "minimal",
    maxCandidates: 5,
  });
  return {
    filesChanged: report.summary.filesChanged,
    symbolsChanged: report.summary.symbolsChanged,
    risk: report.riskSummary.level,
    changedFiles: report.changedFiles.map((entry) => entry.file).slice(0, 20),
    reviewTasks: report.reviewTasks.slice(0, 5).map((task) => ({
      id: task.id,
      reason: task.reason,
      summary: task.description,
      priority: task.priority,
    })),
    candidateTests: report.candidateTests.slice(0, 10).map((candidate) => ({
      file: candidate.file,
      confidence: candidate.confidence,
      reason: candidate.reason,
    })),
  };
}

function normalizeLimit(limit: number | undefined, fallback: number, max = MAX_DEPENDENCIES): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(limit)));
}

function isSqlObjectNode(node: SymbolNode): boolean {
  return node.kind === "table" || node.kind === "view" || node.kind === "index" || node.kind === "routine";
}

function isSqlFile(file: string): boolean {
  return file.toLowerCase().endsWith(".sql");
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function relativeFile(root: string, file: string): string {
  return toProjectRelativePath(root, file) ?? normalizePath(path.resolve(file));
}
