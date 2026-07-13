import type { SymbolEdge, SymbolGraph, SymbolNode } from "../graphs/symbol-graph.js";
import type { FileId, Range } from "../types.js";

export type CallHierarchyDirection = "incoming" | "outgoing";

export type CallHierarchySite = {
  file: FileId;
  range: Range;
};

export type CallHierarchyMatch = {
  symbolId: string;
  callsites: CallHierarchySite[];
  depth: number;
  omittedCallsites: number;
};

export type CallHierarchyResult =
  | {
      status: "ok";
      targetId: string;
      direction: CallHierarchyDirection;
      entries: CallHierarchyMatch[];
      omittedSymbols: number;
      omittedCallsites: number;
      unresolvedEdges: number;
      limit: number;
      callsiteLimit: number;
    }
  | { status: "not_found" | "invalid_target"; reason: string };

type CallRelationship = {
  caller: string;
  callee: string;
  sites: CallHierarchySite[];
  unresolvedSites: number;
};

type CallHierarchyIndex = {
  outgoingByCaller: Map<string, CallRelationship[]>;
  incomingByCallee: Map<string, CallRelationship[]>;
};

type PendingNode = {
  id: string;
  depth: number;
};

type MutableMatch = {
  symbolId: string;
  callsites: CallHierarchySite[];
  callsiteKeys: Set<string>;
  depth: number;
  totalCallsites: number;
};

const CALL_HIERARCHY_CACHE = new WeakMap<SymbolGraph, CallHierarchyIndex>();
const DEFAULT_CALL_HIERARCHY_LIMIT = 100;
const MAX_CALL_HIERARCHY_LIMIT = 500;
const DEFAULT_CALLSITE_LIMIT = 50;
const MAX_CALL_HIERARCHY_DEPTH = 5;

export function findCallHierarchy(
  graph: SymbolGraph,
  targetId: string,
  direction: CallHierarchyDirection,
  options?: { depth?: number; limit?: number; callsiteLimit?: number },
): CallHierarchyResult {
  const target = graph.nodes.get(targetId);
  if (!target) return { status: "not_found", reason: "No matching symbol for handle." };
  if (!isCallable(target)) {
    return { status: "invalid_target", reason: "Call hierarchy requires a function or callable member symbol." };
  }

  const depthLimit = normalizeDepth(options?.depth);
  const limit = normalizeLimit(options?.limit);
  const callsiteLimit = normalizeCallsiteLimit(options?.callsiteLimit);
  const index = getCallHierarchyIndex(graph);
  const adjacency = direction === "incoming" ? index.incomingByCallee : index.outgoingByCaller;
  const queue: PendingNode[] = [{ id: targetId, depth: 0 }];
  const visited = new Set<string>([targetId]);
  const reportedEdges = new Set<string>();
  const matches = new Map<string, MutableMatch>();
  let unresolvedEdges = 0;

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (current.depth >= depthLimit) continue;
    const relationships = adjacency.get(current.id) ?? [];
    for (const relationship of relationships) {
      const edgeKey = `${relationship.caller}->${relationship.callee}`;
      if (reportedEdges.has(edgeKey)) continue;
      reportedEdges.add(edgeKey);
      const symbolId = direction === "incoming" ? relationship.caller : relationship.callee;
      const depth = current.depth + 1;
      const match = matches.get(symbolId) ?? {
        symbolId,
        callsites: [],
        callsiteKeys: new Set<string>(),
        depth,
        totalCallsites: 0,
      };
      match.depth = Math.min(match.depth, depth);
      unresolvedEdges += relationship.unresolvedSites;
      for (const site of relationship.sites) {
        const siteKey = callsiteKey(site);
        if (match.callsiteKeys.has(siteKey)) continue;
        match.callsiteKeys.add(siteKey);
        match.totalCallsites += 1;
        if (match.callsites.length < callsiteLimit) match.callsites.push(site);
      }
      matches.set(symbolId, match);
      if (!visited.has(symbolId)) {
        visited.add(symbolId);
        queue.push({ id: symbolId, depth });
      }
    }
  }

  const allEntries = [...matches.values()].sort((left, right) => compareMatches(graph, left, right));
  const selected = allEntries.slice(0, limit);
  const entries = selected.map(
    (match): CallHierarchyMatch => ({
      symbolId: match.symbolId,
      callsites: match.callsites.sort(compareCallsites),
      depth: match.depth,
      omittedCallsites: Math.max(0, match.totalCallsites - match.callsites.length),
    }),
  );
  return {
    status: "ok",
    targetId,
    direction,
    entries,
    omittedSymbols: Math.max(0, allEntries.length - entries.length),
    omittedCallsites: entries.reduce((sum, entry) => sum + entry.omittedCallsites, 0),
    unresolvedEdges,
    limit,
    callsiteLimit,
  };
}

function getCallHierarchyIndex(graph: SymbolGraph): CallHierarchyIndex {
  const cached = CALL_HIERARCHY_CACHE.get(graph);
  if (cached) return cached;
  const outgoingByCaller = new Map<string, CallRelationship[]>();
  const incomingByCallee = new Map<string, CallRelationship[]>();
  const relationshipByPair = new Map<string, CallRelationship>();
  const siteKeysByPair = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.label !== "calls") continue;
    const pairKey = `${edge.from}->${edge.to}`;
    const relationship = relationshipByPair.get(pairKey) ?? {
      caller: edge.from,
      callee: edge.to,
      sites: [],
      unresolvedSites: 0,
    };
    if (edge.site) {
      const siteKeys = siteKeysByPair.get(pairKey) ?? new Set<string>();
      const siteKey = callsiteKey(edge.site);
      if (!siteKeys.has(siteKey)) {
        siteKeys.add(siteKey);
        relationship.sites.push(edge.site);
      }
      siteKeysByPair.set(pairKey, siteKeys);
    } else {
      relationship.unresolvedSites += 1;
    }
    relationshipByPair.set(pairKey, relationship);
  }
  for (const relationship of relationshipByPair.values()) {
    relationship.sites.sort(compareCallsites);
    appendRelationship(outgoingByCaller, relationship.caller, relationship);
    appendRelationship(incomingByCallee, relationship.callee, relationship);
  }
  for (const relationships of outgoingByCaller.values()) {
    relationships.sort((left, right) => compareCallRelationships(graph, left, right));
  }
  for (const relationships of incomingByCallee.values()) {
    relationships.sort((left, right) => compareCallRelationships(graph, left, right));
  }
  const created = { outgoingByCaller, incomingByCallee };
  CALL_HIERARCHY_CACHE.set(graph, created);
  return created;
}

function appendRelationship(map: Map<string, CallRelationship[]>, key: string, relationship: CallRelationship): void {
  const relationships = map.get(key);
  if (relationships) relationships.push(relationship);
  else map.set(key, [relationship]);
}

function isCallable(node: SymbolNode): boolean {
  return node.kind === "function";
}

function compareCallRelationships(graph: SymbolGraph, left: CallRelationship, right: CallRelationship): number {
  const callerOrder = compareNodes(graph.nodes.get(left.caller), graph.nodes.get(right.caller));
  if (callerOrder) return callerOrder;
  return compareNodes(graph.nodes.get(left.callee), graph.nodes.get(right.callee));
}

function compareMatches(graph: SymbolGraph, left: MutableMatch, right: MutableMatch): number {
  return left.depth - right.depth || compareNodes(graph.nodes.get(left.symbolId), graph.nodes.get(right.symbolId));
}

function compareNodes(left: SymbolNode | undefined, right: SymbolNode | undefined): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return (
    compareCodeUnits(left.file, right.file) ||
    compareCodeUnits(left.name, right.name) ||
    compareCodeUnits(left.id, right.id)
  );
}

function compareCallsites(left: CallHierarchySite, right: CallHierarchySite): number {
  return (
    compareCodeUnits(left.file, right.file) ||
    left.range.start.line - right.range.start.line ||
    left.range.start.column - right.range.start.column ||
    (left.range.start.index ?? 0) - (right.range.start.index ?? 0)
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function callsiteKey(site: CallHierarchySite): string {
  return `${site.file}:${site.range.start.index ?? ""}:${site.range.end.index ?? ""}:${site.range.start.line}:${site.range.start.column}`;
}

function hierarchyOption(value: number | undefined, defaultValue: number, maximum: number, name: string): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return Math.min(value, maximum);
}

function normalizeDepth(depth: number | undefined): number {
  const normalized = hierarchyOption(depth, 1, MAX_CALL_HIERARCHY_DEPTH, "Call hierarchy depth");
  if (!normalized) throw new Error("Call hierarchy depth must be a positive integer.");
  return normalized;
}

function normalizeLimit(limit: number | undefined): number {
  return hierarchyOption(limit, DEFAULT_CALL_HIERARCHY_LIMIT, MAX_CALL_HIERARCHY_LIMIT, "Call hierarchy limit");
}

function normalizeCallsiteLimit(limit: number | undefined): number {
  return hierarchyOption(limit, DEFAULT_CALLSITE_LIMIT, MAX_CALL_HIERARCHY_LIMIT, "Callsite limit");
}
