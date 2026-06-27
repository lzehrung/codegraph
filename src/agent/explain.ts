import fs from "node:fs/promises";
import type { AnalysisSummary } from "../analysisSummary.js";
import {
  findDuplicateContext,
  type DuplicateGroup,
  type DuplicateSuggestion,
  type DuplicateTarget,
} from "../duplicates.js";
import { findReferences } from "../indexer/navigation.js";
import type { BuildOptions, Reference, SymbolDef } from "../indexer/types.js";
import { getDependencies, getReverseDependencies } from "../graphs/queries.js";
import { getHotspots } from "../graphs/hotspots.js";
import { defNodeId } from "../graphs/symbol-graph.js";
import { type SymbolNode } from "../graphs/symbol-graph.js";
import {
  AGENT_EXPLAIN_CANDIDATE_TEST_LIMIT,
  AGENT_EXPLAIN_CHANGED_FILE_LIMIT,
  AGENT_EXPLAIN_DEFAULT_DEPENDENCY_LIMIT,
  AGENT_EXPLAIN_DEFAULT_SNIPPET_LIMIT,
  AGENT_EXPLAIN_DEFAULT_SYMBOL_LIMIT,
  AGENT_EXPLAIN_DEFAULT_DUPLICATE_LIMIT,
  AGENT_EXPLAIN_FILE_SYMBOL_REF_LIMIT,
  AGENT_EXPLAIN_FORMAT_FOLLOWUP_LIMIT,
  AGENT_EXPLAIN_FORMAT_SYMBOL_LIMIT,
  AGENT_EXPLAIN_MAX_DEPENDENCY_LIMIT,
  AGENT_EXPLAIN_MAX_SNIPPET_LIMIT,
  AGENT_EXPLAIN_MAX_DUPLICATE_LIMIT,
  AGENT_EXPLAIN_MAX_SYMBOL_LIMIT,
  AGENT_EXPLAIN_REVIEW_CONTEXT_CANDIDATE_LIMIT,
  AGENT_EXPLAIN_REVIEW_TASK_LIMIT,
} from "../presentation/bounds.js";
import { buildReviewReport } from "../review.js";
import { extractSqlFactsFromSource, sqlObjectBaseName } from "../sql/extractFacts.js";
import type { SqlStatementFact } from "../sql/types.js";
import type { Range } from "../types.js";
import { normalizePath } from "../util/paths.js";
import { mapLimit } from "../util/concurrency.js";
import { boundAgentList, defaultAgentLimit, emptyAgentBoundedList, type BoundedAgentList } from "./bounds.js";
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
import {
  collectDefinitionFollowUps,
  collectFileFollowUps as collectCommonFileFollowUps,
  isAgentSqlFile,
  isAgentSqlObjectNode,
  normalizeAgentFilePath,
  resolveAgentSnapshotFile,
} from "./normalize.js";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "./session.js";
import { buildSymbolLookup, type SymbolLookup } from "./symbolLookup.js";
import { quoteShellArg } from "./shell.js";

export type AgentExplainTarget = {
  root: string;
  target: string;
  buildOptions?: BuildOptions;
  includeChangedContext?: boolean;
  base?: string;
  head?: string;
  maxDependencies?: number;
  maxReferences?: number;
  maxRelatedSqlObjects?: number;
  maxSnippets?: number;
  maxSymbols?: number;
  maxDuplicates?: number;
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

export type AgentExplanationDuplicateSide = {
  file: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
  handle: string;
  fileHandle: string;
  chunkHandle: string;
  sqlHandle?: string;
  symbolHandle?: string;
  name?: string;
};

export type AgentExplanationDuplicate = {
  id: string;
  confidence: DuplicateGroup["confidence"];
  cloneType: DuplicateGroup["cloneType"];
  score: number;
  left: AgentExplanationDuplicateSide;
  right: AgentExplanationDuplicateSide;
  rawPairCount: number;
  reasons: string[];
  hint: string;
};

export type AgentExplanation = {
  schemaVersion: 1;
  root: string;
  analysis: AnalysisSummary;
  target: AgentExplanationTarget;
  summary: string[];
  symbols: AgentExplanationSymbol[];
  dependencies: AgentExplanationDependency[];
  reverseDependencies: AgentExplanationDependency[];
  references: AgentExplanationReference[];
  relatedSqlObjects: AgentExplanationSqlObject[];
  duplicates: AgentExplanationDuplicate[];
  snippets: AgentExplanationSnippet[];
  hotspots: Array<{ file: string; fanIn: number; fanOut: number; score: number }>;
  followUps: string[];
  limits: {
    symbols: number;
    dependencies: number;
    references: number;
    relatedSqlObjects: number;
    duplicates: number;
    snippets: number;
  };
  omittedCounts: {
    symbols: number;
    dependencies: number;
    reverseDependencies: number;
    references: number;
    relatedSqlObjects: number;
    duplicates: number;
    snippets: number;
  };
  changedContext?: AgentExplanationChangedContext;
};

type ReferenceContext = {
  references: BoundedAgentList<AgentExplanationReference>;
  snippets: BoundedAgentList<AgentExplanationSnippet>;
};

type ResolvedExplainTarget =
  | { kind: "file"; file: string }
  | { kind: "symbol"; def: SymbolDef; node?: SymbolNode }
  | { kind: "sql_object"; def: SymbolDef; node?: SymbolNode }
  | { kind: "not_found"; label: string };

const SQL_FACT_READ_CONCURRENCY = 32;
const AGENT_DUPLICATE_MAX_PAIRS = 20_000;
const AGENT_EXPLAIN_REFERENCE_COLLECTION_MULTIPLIER = 10;

export async function explainCodegraphTarget(request: AgentExplainTarget): Promise<AgentExplanation> {
  const session = createAgentSession({
    root: request.root,
    ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
  });
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
    `Analysis: ${explanation.analysis.label}`,
    ...explanation.summary.map((entry) => `- ${entry}`),
  ];
  if (explanation.symbols.length) {
    lines.push(
      `symbols: ${explanation.symbols
        .map((symbol) => symbol.name)
        .slice(0, AGENT_EXPLAIN_FORMAT_SYMBOL_LIMIT)
        .join(", ")}`,
    );
  }
  if (explanation.dependencies.length) {
    lines.push(`deps: ${explanation.dependencies.map((entry) => entry.file).join(", ")}`);
  }
  if (explanation.reverseDependencies.length) {
    lines.push(`rdeps: ${explanation.reverseDependencies.map((entry) => entry.file).join(", ")}`);
  }
  if (explanation.followUps.length) {
    lines.push(
      "follow-ups:",
      ...explanation.followUps.slice(0, AGENT_EXPLAIN_FORMAT_FOLLOWUP_LIMIT).map((command) => `  ${command}`),
    );
  }
  return lines.join("\n");
}

function resolveTarget(snapshot: AgentProjectSnapshot, lookup: SymbolLookup, target: string): ResolvedExplainTarget {
  const fileHandle = parseAgentFileHandle(target);
  const chunkHandle = parseAgentChunkHandle(target);
  const graphHandle = parseAgentGraphHandle(target);
  const fileTarget = fileHandle?.file ?? chunkHandle?.file ?? graphHandle?.file ?? target;
  const file = resolveAgentSnapshotFile(snapshot, fileTarget);
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
    const file = resolveAgentSnapshotFile(snapshot, parsed.file);
    if (!file) return null;
    for (const def of lookup.defById.values()) {
      if (isAgentSqlFile(def.file)) continue;
      if (normalizePath(def.file) !== file) continue;
      if (def.localName !== parsed.name) continue;
      if (def.range.start.line !== parsed.line || def.range.start.column !== parsed.column) continue;
      return symbolTarget(def, snapshot.symbolGraph.nodes.get(defNodeId(def)));
    }
    for (const node of snapshot.symbolGraph.nodes.values()) {
      const def = lookup.defById.get(node.id);
      if (!def || isAgentSqlObjectNode(node)) continue;
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

function resolveSqlHandle(
  snapshot: AgentProjectSnapshot,
  lookup: SymbolLookup,
  handle: string,
): Extract<ResolvedExplainTarget, { kind: "sql_object" }> | null {
  const parsed = parseAgentSqlHandle(handle);
  if (!parsed) return null;

  for (const node of snapshot.symbolGraph.nodes.values()) {
    const def = lookup.defById.get(node.id);
    if (!def || !isAgentSqlObjectNode(node)) continue;
    if (
      node.name === parsed.name &&
      normalizeAgentFilePath(snapshot.root, node.file) === parsed.file &&
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
    .filter((node) => !isAgentSqlObjectNode(node) && node.name === name)
    .sort(compareSymbolNodes);
  const node = matches[0];
  if (node) {
    const def = lookup.defById.get(node.id);
    if (def) return symbolTarget(def, node);
  }

  const defMatches = [...lookup.defById.values()]
    .filter((def) => !isAgentSqlFile(def.file) && def.localName === name)
    .sort(compareSymbolDefs);
  const def = defMatches[0];
  return def ? symbolTarget(def, snapshot.symbolGraph.nodes.get(defNodeId(def))) : null;
}

function findSqlObjectByName(
  snapshot: AgentProjectSnapshot,
  lookup: SymbolLookup,
  name: string,
): Extract<ResolvedExplainTarget, { kind: "sql_object" }> | null {
  const exactMatches = [...snapshot.symbolGraph.nodes.values()]
    .filter((node) => isAgentSqlObjectNode(node) && node.name === name)
    .sort(compareSymbolNodes);
  const exactNode = exactMatches[0];
  if (exactNode) {
    const def = lookup.defById.get(exactNode.id);
    return def ? { kind: "sql_object", def, node: exactNode } : null;
  }

  if (name.includes(".")) return null;

  const matches = [...snapshot.symbolGraph.nodes.values()]
    .filter((node) => isAgentSqlObjectNode(node) && basename(node.name) === name)
    .sort(compareSymbolNodes);
  if (matches.length !== 1) return null;
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
  const maxDependencies = defaultAgentLimit(
    request.maxDependencies,
    AGENT_EXPLAIN_DEFAULT_DEPENDENCY_LIMIT,
    AGENT_EXPLAIN_MAX_DEPENDENCY_LIMIT,
  );
  const maxReferences = defaultAgentLimit(
    request.maxReferences ?? request.maxDependencies,
    AGENT_EXPLAIN_DEFAULT_DEPENDENCY_LIMIT,
    AGENT_EXPLAIN_MAX_DEPENDENCY_LIMIT,
  );
  const maxRelatedSqlObjects = defaultAgentLimit(
    request.maxRelatedSqlObjects ?? request.maxDependencies,
    AGENT_EXPLAIN_DEFAULT_DEPENDENCY_LIMIT,
    AGENT_EXPLAIN_MAX_DEPENDENCY_LIMIT,
  );
  const maxSnippets = defaultAgentLimit(
    request.maxSnippets,
    AGENT_EXPLAIN_DEFAULT_SNIPPET_LIMIT,
    AGENT_EXPLAIN_MAX_SNIPPET_LIMIT,
  );
  const maxSymbols = defaultAgentLimit(
    request.maxSymbols,
    AGENT_EXPLAIN_DEFAULT_SYMBOL_LIMIT,
    AGENT_EXPLAIN_MAX_SYMBOL_LIMIT,
  );
  const maxDuplicates = defaultAgentLimit(
    request.maxDuplicates,
    AGENT_EXPLAIN_DEFAULT_DUPLICATE_LIMIT,
    AGENT_EXPLAIN_MAX_DUPLICATE_LIMIT,
  );

  if (resolved.kind === "not_found") {
    return emptyExplanation(snapshot, {
      kind: "not_found",
      label: resolved.label,
    });
  }

  const file = resolved.kind === "file" ? resolved.file : normalizePath(resolved.def.file);
  const relFile = normalizeAgentFilePath(snapshot.root, file);
  const allSymbols = collectFileSymbols(snapshot, lookup, file);
  const boundedSymbols = boundAgentList(allSymbols, maxSymbols);
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
  const duplicates = await collectDuplicateContext(snapshot, resolved, relFile, maxDuplicates);
  const followUps = collectFollowUps(snapshot, resolved, boundedSymbols.items, relFile, duplicates.items);
  const changedContext = await collectChangedContext(request);

  return {
    schemaVersion: 1,
    root: snapshot.root,
    analysis: snapshot.analysis,
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
    symbols: boundedSymbols.items,
    dependencies: dependencies.items,
    reverseDependencies: reverseDependencies.items,
    references: references.items,
    relatedSqlObjects: relatedSqlObjects.items,
    duplicates: duplicates.items,
    snippets: snippets.items,
    hotspots,
    followUps,
    limits: {
      symbols: maxSymbols,
      dependencies: maxDependencies,
      references: maxReferences,
      relatedSqlObjects: maxRelatedSqlObjects,
      duplicates: maxDuplicates,
      snippets: maxSnippets,
    },
    omittedCounts: {
      symbols: boundedSymbols.omitted,
      dependencies: dependencies.omitted,
      reverseDependencies: reverseDependencies.omitted,
      references: references.omitted,
      relatedSqlObjects: relatedSqlObjects.omitted,
      duplicates: duplicates.omitted,
      snippets: snippets.omitted,
    },
    ...(changedContext ? { changedContext } : {}),
  };
}

function emptyExplanation(snapshot: AgentProjectSnapshot, target: AgentExplanationTarget): AgentExplanation {
  return {
    schemaVersion: 1,
    root: snapshot.root,
    analysis: snapshot.analysis,
    target,
    summary: [`No indexed target resolved for ${target.label}.`],
    symbols: [],
    dependencies: [],
    reverseDependencies: [],
    references: [],
    relatedSqlObjects: [],
    duplicates: [],
    snippets: [],
    hotspots: [],
    followUps: [`codegraph search ${quoteShellArg(target.label)} --json`],
    limits: {
      symbols: AGENT_EXPLAIN_DEFAULT_SYMBOL_LIMIT,
      dependencies: AGENT_EXPLAIN_DEFAULT_DEPENDENCY_LIMIT,
      references: AGENT_EXPLAIN_DEFAULT_DEPENDENCY_LIMIT,
      relatedSqlObjects: AGENT_EXPLAIN_DEFAULT_DEPENDENCY_LIMIT,
      duplicates: AGENT_EXPLAIN_DEFAULT_DUPLICATE_LIMIT,
      snippets: AGENT_EXPLAIN_DEFAULT_SNIPPET_LIMIT,
    },
    omittedCounts: {
      symbols: 0,
      dependencies: 0,
      reverseDependencies: 0,
      references: 0,
      relatedSqlObjects: 0,
      duplicates: 0,
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
): BoundedAgentList<AgentExplanationDependency> {
  const startFile = normalizePath(file);
  const dependencies =
    direction === "forward"
      ? getDependencies(snapshot.fileGraph, startFile, { depth: 1 })
      : getReverseDependencies(snapshot.fileGraph, startFile, { depth: 1 });
  const sortedDependencies = dependencies
    .map((dependency) => ({
      file: normalizeAgentFilePath(snapshot.root, dependency.file),
      depth: dependency.depth,
    }))
    .sort(compareDependencies);
  return boundAgentList(sortedDependencies, limit);
}

function compareDependencies(left: AgentExplanationDependency, right: AgentExplanationDependency): number {
  const depthDelta = left.depth - right.depth;
  if (depthDelta !== 0) return depthDelta;
  return left.file.localeCompare(right.file);
}

async function collectDuplicateContext(
  snapshot: AgentProjectSnapshot,
  resolved: Exclude<ResolvedExplainTarget, { kind: "not_found" }>,
  relFile: string,
  limit: number,
): Promise<BoundedAgentList<AgentExplanationDuplicate>> {
  if (resolved.kind === "sql_object") return emptyAgentBoundedList();
  const target =
    resolved.kind === "file"
      ? { file: relFile }
      : {
          file: relFile,
          startLine: resolved.def.range.start.line,
          endLine: resolved.def.range.end.line,
        };
  const result = await findDuplicateContext(snapshot.index, target, {
    projectRoot: snapshot.root,
    minConfidence: "medium",
    includeSameFile: true,
    limit,
    maxPairs: AGENT_DUPLICATE_MAX_PAIRS,
  });
  return {
    items: result.groups.map((group) => summarizeDuplicateGroup(group, result.target)),
    omitted: result.omittedCounts.groups + result.omittedCounts.candidatePairs,
  };
}

function summarizeDuplicateSide(side: DuplicateGroup["primaryLeft"]): AgentExplanationDuplicateSide {
  return {
    file: side.file,
    startLine: side.startLine,
    endLine: side.endLine,
    tokenCount: side.tokenCount,
    handle: side.handle,
    fileHandle: side.fileHandle,
    chunkHandle: side.chunkHandle,
    ...(side.sqlHandle !== undefined ? { sqlHandle: side.sqlHandle } : {}),
    ...(side.symbolHandle !== undefined ? { symbolHandle: side.symbolHandle } : {}),
    ...(side.name !== undefined ? { name: side.name } : {}),
  };
}

function duplicateRepairHint(group: DuplicateGroup): string {
  if (group.cloneType === "exact" || group.cloneType === "renamed") {
    return "Possible extraction candidate; verify behavior before refactoring.";
  }
  return "Check related duplicate implementation for drift.";
}

function duplicateUnitTouchesTarget(side: DuplicateGroup["primaryLeft"], target: DuplicateTarget): boolean {
  if (side.file !== target.file) return false;
  if (target.startLine === undefined) return true;
  const targetEndLine = target.endLine ?? target.startLine;
  return side.startLine <= targetEndLine && target.startLine <= side.endLine;
}

function duplicatePairForTarget(
  group: DuplicateGroup,
  target: DuplicateTarget,
): Pick<DuplicateSuggestion, "left" | "right"> {
  if (duplicateUnitTouchesTarget(group.primaryLeft, target) || duplicateUnitTouchesTarget(group.primaryRight, target)) {
    return { left: group.primaryLeft, right: group.primaryRight };
  }
  return (
    group.variants.find(
      (variant) =>
        duplicateUnitTouchesTarget(variant.left, target) || duplicateUnitTouchesTarget(variant.right, target),
    ) ?? { left: group.primaryLeft, right: group.primaryRight }
  );
}

function summarizeDuplicateGroup(group: DuplicateGroup, target: DuplicateTarget): AgentExplanationDuplicate {
  const pair = duplicatePairForTarget(group, target);
  return {
    id: group.id,
    confidence: group.confidence,
    cloneType: group.cloneType,
    score: group.score,
    left: summarizeDuplicateSide(pair.left),
    right: summarizeDuplicateSide(pair.right),
    rawPairCount: group.rawPairCount,
    reasons: group.reasons,
    hint: duplicateRepairHint(group),
  };
}

function collectTargetHotspots(
  snapshot: AgentProjectSnapshot,
  file: string,
): Array<{ file: string; fanIn: number; fanOut: number; score: number }> {
  const normalizedFile = normalizePath(file);
  return getHotspots(snapshot.fileGraph, { limit: snapshot.files.length })
    .filter((hotspot) => normalizePath(hotspot.file) === normalizedFile)
    .map((hotspot) => ({
      file: normalizeAgentFilePath(snapshot.root, hotspot.file),
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
  const displayLimit = Math.max(referenceLimit, snippetLimit);
  if (displayLimit <= 0) {
    return emptyReferenceContext();
  }
  const collectionLimit = displayLimit * AGENT_EXPLAIN_REFERENCE_COLLECTION_MULTIPLIER;
  const result = await findReferences(snapshot.index, { def }, { context: "line", maxReferences: collectionLimit });
  if (result.status !== "ok") return emptyReferenceContext();

  const references = result.references
    .map((reference) => ({
      file: normalizeAgentFilePath(snapshot.root, reference.file),
      range: reference.range,
    }))
    .sort((left, right) => {
      const fileDelta = left.file.localeCompare(right.file);
      if (fileDelta !== 0) return fileDelta;
      return left.range.start.line - right.range.start.line;
    });
  const boundedReferences = boundAgentList(references, referenceLimit);

  const referencesWithContext = result.references.filter((reference) => reference.context !== undefined);
  const snippets = referencesWithContext
    .map((reference) => snippetFromReference(snapshot, reference))
    .sort((left, right) => {
      const fileDelta = left.file.localeCompare(right.file);
      if (fileDelta !== 0) return fileDelta;
      return left.line - right.line;
    });
  const boundedSnippets = boundAgentList(snippets, snippetLimit);

  return {
    references: boundedReferences,
    snippets: boundedSnippets,
  };
}

function snippetFromReference(snapshot: AgentProjectSnapshot, reference: Reference): AgentExplanationSnippet {
  return {
    file: normalizeAgentFilePath(snapshot.root, reference.file),
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
): Promise<BoundedAgentList<AgentExplanationSqlObject>> {
  if (resolved.kind !== "sql_object" && !isAgentSqlFile(file)) return emptyAgentBoundedList();

  const sqlObjects = collectSqlObjectNodes(snapshot, lookup);
  const targetName = resolved.kind === "sql_object" ? (resolved.node?.name ?? resolved.def.localName) : undefined;
  const related = new Map<string, AgentExplanationSqlObject>();
  const addRelated = (object: SqlObjectNodeInfo, relation: string): void => {
    const entry: AgentExplanationSqlObject = {
      name: object.name,
      kind: object.kind,
      file: normalizeAgentFilePath(snapshot.root, object.file),
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
    await addRelatedSqlObjectsFromFacts(snapshot, sqlObjects, targetName, addRelated);
  }

  const matches = [...related.values()].sort((left, right) => {
    const relationDelta = sqlRelationRank(left.relation) - sqlRelationRank(right.relation);
    if (relationDelta !== 0) return relationDelta;
    const fileDelta = left.file.localeCompare(right.file);
    if (fileDelta !== 0) return fileDelta;
    return left.name.localeCompare(right.name);
  });
  return boundAgentList(matches, limit);
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
    .filter((node) => isAgentSqlObjectNode(node))
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
  if (exact.length) return exact;
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

async function collectSqlFacts(snapshot: AgentProjectSnapshot): Promise<Map<string, SqlStatementFact[]>> {
  const sqlFiles = snapshot.files.filter(isAgentSqlFile).sort((left, right) => left.localeCompare(right));
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

function emptyReferenceContext(): ReferenceContext {
  return {
    references: emptyAgentBoundedList(),
    snippets: emptyAgentBoundedList(),
  };
}

function collectFollowUps(
  snapshot: AgentProjectSnapshot,
  resolved: Exclude<ResolvedExplainTarget, { kind: "not_found" }>,
  symbols: AgentExplanationSymbol[],
  relFile: string,
  duplicates: AgentExplanationDuplicate[],
): string[] {
  const followUps = new Set<string>(collectCommonFileFollowUps(relFile));

  if (resolved.kind === "file") {
    for (const symbol of symbols.slice(0, AGENT_EXPLAIN_FILE_SYMBOL_REF_LIMIT)) {
      followUps.add(
        `codegraph refs --file ${quoteShellArg(relFile)} --line ${symbol.range.start.line} --col ${symbol.range.start.column} --pretty`,
      );
    }
  } else {
    for (const command of collectDefinitionFollowUps(
      relFile,
      resolved.def.range.start.line,
      resolved.def.range.start.column,
    )) {
      followUps.add(command);
    }
    followUps.add(
      `codegraph search ${quoteShellArg(resolved.node?.name ?? resolved.def.localName)} --from ${quoteShellArg(relFile)} --json`,
    );
  }

  if (isAgentSqlFile(relFile)) {
    followUps.add(`codegraph search ${quoteShellArg(relFile)} --mode sql --json`);
  }

  if (duplicates.length) {
    followUps.add(formatDuplicateFollowUp(duplicates));
  }

  return [...followUps].sort();
}

function formatDuplicateFollowUp(duplicates: readonly AgentExplanationDuplicate[]): string {
  const files = new Set<string>();
  for (const duplicate of duplicates) {
    files.add(duplicate.left.file);
    files.add(duplicate.right.file);
  }
  const scope = [...files].sort().map(quoteShellArg).join(" ");
  return `codegraph duplicates --root . ${scope} --json --min-confidence medium --include-same-file`;
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
    maxCandidates: AGENT_EXPLAIN_REVIEW_CONTEXT_CANDIDATE_LIMIT,
  });
  return {
    filesChanged: report.summary.filesChanged,
    symbolsChanged: report.summary.symbolsChanged,
    risk: report.riskSummary.level,
    changedFiles: report.changedFiles.map((entry) => entry.file).slice(0, AGENT_EXPLAIN_CHANGED_FILE_LIMIT),
    reviewTasks: report.reviewTasks.slice(0, AGENT_EXPLAIN_REVIEW_TASK_LIMIT).map((task) => ({
      id: task.id,
      reason: task.reason,
      summary: task.description,
      priority: task.priority,
    })),
    candidateTests: report.candidateTests.slice(0, AGENT_EXPLAIN_CANDIDATE_TEST_LIMIT).map((candidate) => ({
      file: candidate.file,
      confidence: candidate.confidence,
      reason: candidate.reason,
    })),
  };
}
