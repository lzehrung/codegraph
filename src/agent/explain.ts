import path from "node:path";
import { findReferences } from "../indexer.js";
import type { Reference, SymbolDef } from "../indexer/types.js";
import { getDependencies, getHotspots, getReverseDependencies } from "../graphs.js";
import { defNodeId } from "../graphs/symbol-graph.js";
import type { SymbolNode } from "../graphs.js";
import { buildReviewReport } from "../review.js";
import type { Range } from "../types.js";
import { normalizePath, toProjectRelativePath } from "../util.js";
import { formatAgentSqlHandle, formatAgentSymbolHandle, parseAgentSqlHandle, parseAgentSymbolHandle } from "./handles.js";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "./session.js";

export type AgentExplainTarget = {
  root: string;
  target: string;
  includeChangedContext?: boolean;
  base?: string;
  head?: string;
  maxDependencies?: number;
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
    lines.push(`symbols: ${explanation.symbols.map((symbol) => symbol.name).slice(0, 8).join(", ")}`);
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
  const fileTarget = target.startsWith("file:") ? target.slice("file:".length) : target;
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
  const absoluteCandidate = path.isAbsolute(candidate) ? normalizePath(candidate) : normalizePath(path.resolve(snapshot.root, candidate));
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

function symbolTarget(def: SymbolDef, node: SymbolNode | undefined): Extract<ResolvedExplainTarget, { kind: "symbol" }> {
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
  const references = resolved.kind === "file" ? emptyBoundedList<AgentExplanationReference>() : await collectReferences(snapshot, resolved.def, maxDependencies);
  const snippets = resolved.kind === "file" ? emptyBoundedList<AgentExplanationSnippet>() : await collectSnippets(snapshot, resolved, maxSnippets);
  const relatedSqlObjects = collectRelatedSqlObjects(snapshot, lookup, resolved, file, maxDependencies);
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
      handle: `file:${relFile}`,
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
      ? getDependencies(snapshot.fileGraph, startFile, { depth: 1, limit: limit + 1 })
      : getReverseDependencies(snapshot.fileGraph, startFile, { depth: 1, limit: limit + 1 });
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

async function collectReferences(
  snapshot: AgentProjectSnapshot,
  def: SymbolDef,
  limit: number,
): Promise<BoundedList<AgentExplanationReference>> {
  const result = await findReferences(snapshot.index, { def }, { maxReferences: limit + 1 });
  if (result.status !== "ok") return emptyBoundedList();
  const items = result.references
    .map((reference) => ({
      file: relativeFile(snapshot.root, reference.file),
      range: reference.range,
    }))
    .sort((left, right) => {
      const fileDelta = left.file.localeCompare(right.file);
      if (fileDelta !== 0) return fileDelta;
      return left.range.start.line - right.range.start.line;
    })
    .slice(0, limit);
  return {
    items,
    omitted: Math.max(0, result.references.length - items.length),
  };
}

async function collectSnippets(
  snapshot: AgentProjectSnapshot,
  resolved: Exclude<ResolvedExplainTarget, { kind: "not_found" | "file" }>,
  limit: number,
): Promise<BoundedList<AgentExplanationSnippet>> {
  const result = await findReferences(snapshot.index, { def: resolved.def }, { context: "line", maxReferences: limit + 1 });
  if (result.status !== "ok") return emptyBoundedList();
  const referencesWithContext = result.references.filter((reference) => reference.context !== undefined);
  const items = referencesWithContext
    .filter((reference) => reference.context !== undefined)
    .map((reference) => snippetFromReference(snapshot, reference))
    .sort((left, right) => {
      const fileDelta = left.file.localeCompare(right.file);
      if (fileDelta !== 0) return fileDelta;
      return left.line - right.line;
    })
    .slice(0, limit);
  return {
    items,
    omitted: Math.max(0, referencesWithContext.length - items.length),
  };
}

function snippetFromReference(snapshot: AgentProjectSnapshot, reference: Reference): AgentExplanationSnippet {
  return {
    file: relativeFile(snapshot.root, reference.file),
    line: reference.range.start.line,
    text: reference.context ?? "",
  };
}

function collectRelatedSqlObjects(
  snapshot: AgentProjectSnapshot,
  lookup: SymbolLookup,
  resolved: Exclude<ResolvedExplainTarget, { kind: "not_found" }>,
  file: string,
  limit: number,
): BoundedList<AgentExplanationSqlObject> {
  if (resolved.kind !== "sql_object" && !isSqlFile(file)) return emptyBoundedList();

  const targetName = resolved.kind === "sql_object" ? (resolved.node?.name ?? resolved.def.localName) : undefined;
  const matches = [...snapshot.symbolGraph.nodes.values()]
    .filter((node) => isSqlObjectNode(node))
    .filter((node) => normalizePath(node.file) === normalizePath(file) || node.name === targetName)
    .map((node) => {
      const def = lookup.defById.get(node.id);
      return {
        name: node.name,
        kind: node.kind,
        file: relativeFile(snapshot.root, node.file),
        ...(def ? { range: def.range } : {}),
      };
    })
    .sort((left, right) => {
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

function emptyBoundedList<T>(): BoundedList<T> {
  return {
    items: [],
    omitted: 0,
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
    followUps.add(`codegraph goto ${quoteArg(relFile)} ${resolved.def.range.start.line} ${resolved.def.range.start.column}`);
    followUps.add(
      `codegraph refs --file ${quoteArg(relFile)} --line ${resolved.def.range.start.line} --col ${resolved.def.range.start.column} --pretty`,
    );
    followUps.add(`codegraph search ${quoteArg(resolved.node?.name ?? resolved.def.localName)} --from ${quoteArg(relFile)} --json`);
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
      `Codegraph reports extracted SQL facts and object references from indexed .sql files only.`,
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
