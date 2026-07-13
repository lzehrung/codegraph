import type { SymbolEdge, SymbolGraph, SymbolNode } from "../graphs/symbol-graph.js";
import { resolveSymbolId } from "./symbols.js";
import type { ProjectIndex } from "./types.js";

export type TypeHierarchyDirection = "super" | "sub";
export type TypeHierarchyRelationKind = "extends" | "implements" | "trait" | "mixin" | "unknown";

export type TypeHierarchyRelationMatch = {
  targetId: string;
  relation: TypeHierarchyRelationKind;
  depth: number;
  site?: SymbolEdge["site"];
};

export type TypeHierarchyResult =
  | {
      status: "ok";
      targetId: string;
      direction: TypeHierarchyDirection;
      relations: TypeHierarchyRelationMatch[];
      omitted: number;
      limit: number;
    }
  | { status: "not_found" | "invalid_target"; reason: string };

export type ImplementationMatch = {
  symbolId: string;
  implementingTypeId?: string;
  relation: TypeHierarchyRelationKind;
  site?: SymbolEdge["site"];
};
export type UnresolvedImplementationMatch = {
  symbolId: string;
  implementingTypeId: string;
  site?: SymbolEdge["site"];
};

export type ImplementationsResult =
  | {
      status: "ok";
      targetId: string;
      implementations: ImplementationMatch[];
      omitted: number;
      ambiguous: number;
      unresolved: UnresolvedImplementationMatch[];
      limit: number;
    }
  | { status: "not_found" | "invalid_target" | "unsupported_target"; reason: string };

type HierarchyEdge = {
  from: string;
  to: string;
  relation: TypeHierarchyRelationKind;
  site?: SymbolEdge["site"];
};

type TypeHierarchyIndex = {
  outgoing: Map<string, HierarchyEdge[]>;
  incoming: Map<string, HierarchyEdge[]>;
};

const TYPE_HIERARCHY_CACHE = new WeakMap<SymbolGraph, TypeHierarchyIndex>();
const DEFAULT_HIERARCHY_LIMIT = 100;
const MAX_HIERARCHY_LIMIT = 500;
const MAX_HIERARCHY_DEPTH = 10;

export function findTypeHierarchy(
  graph: SymbolGraph,
  targetId: string,
  direction: TypeHierarchyDirection,
  options?: { depth?: number; limit?: number },
): TypeHierarchyResult {
  const target = graph.nodes.get(targetId);
  if (!target) return { status: "not_found", reason: "No matching symbol for handle." };
  if (!isTypeNode(target)) {
    return { status: "invalid_target", reason: "Type hierarchy requires a class, interface, or type symbol." };
  }

  const depthLimit = normalizeDepth(options?.depth);
  const limit = normalizeLimit(options?.limit);
  const index = getTypeHierarchyIndex(graph);
  const adjacency = direction === "super" ? index.outgoing : index.incoming;
  const queue: Array<{ id: string; depth: number }> = [{ id: targetId, depth: 0 }];
  const visited = new Set<string>([targetId]);
  const relations: TypeHierarchyRelationMatch[] = [];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (current.depth >= depthLimit) continue;
    const edges = [...(adjacency.get(current.id) ?? [])].sort((left, right) =>
      compareHierarchyEdges(graph, left, right),
    );
    for (const edge of edges) {
      const nextId = direction === "super" ? edge.to : edge.from;
      if (visited.has(nextId)) continue;
      visited.add(nextId);
      const depth = current.depth + 1;
      relations.push({
        targetId: nextId,
        relation: edge.relation,
        depth,
        ...(edge.site ? { site: edge.site } : {}),
      });
      queue.push({ id: nextId, depth });
    }
  }

  relations.sort((left, right) => compareRelations(graph, left, right));
  return {
    status: "ok",
    targetId,
    direction,
    relations: relations.slice(0, limit),
    omitted: Math.max(0, relations.length - limit),
    limit,
  };
}

export function findImplementations(
  index: ProjectIndex,
  graph: SymbolGraph,
  targetId: string,
  options?: { limit?: number },
): ImplementationsResult {
  const targetNode = graph.nodes.get(targetId);
  const targetDef = resolveSymbolId(index, targetId);
  if (!targetNode || !targetDef) return { status: "not_found", reason: "No matching symbol for handle." };
  const limit = normalizeLimit(options?.limit);
  const hierarchy = getTypeHierarchyIndex(graph);

  if (isTypeNode(targetNode)) {
    const rootRelations = implementationRootRelations(hierarchy, targetId, targetNode);
    if (!rootRelations.size) {
      return {
        status: "unsupported_target",
        reason: "Implementation lookup requires an interface, trait, or abstract type.",
      };
    }
    const matches = collectTypeImplementations(graph, hierarchy, targetId, rootRelations);
    return {
      status: "ok",
      targetId,
      implementations: matches.slice(0, limit),
      omitted: Math.max(0, matches.length - limit),
      ambiguous: 0,
      unresolved: [],
      limit,
    };
  }

  const ownerEdge = graph.edges.find((edge) => edge.from === targetId && edge.label === "member_of");
  const ownerId = ownerEdge?.to;
  const ownerNode = ownerId ? graph.nodes.get(ownerId) : undefined;
  const ownerDef = ownerId ? resolveSymbolId(index, ownerId) : null;
  if (!ownerId || !ownerNode || !ownerDef) {
    return {
      status: "unsupported_target",
      reason: "Implementation lookup requires an interface, trait, abstract type, or member owned by one.",
    };
  }
  const sameNameMembers = graph.edges
    .filter((edge) => edge.to === ownerId && edge.label === "member_of")
    .map((edge) => edge.from)
    .filter((id) => graph.nodes.get(id)?.name === targetDef.localName);
  const sameIdentityMembers =
    targetNode.memberArity === undefined
      ? sameNameMembers
      : sameNameMembers.filter((id) => graph.nodes.get(id)?.memberArity === targetNode.memberArity);
  if (sameIdentityMembers.length > 1) {
    return {
      status: "unsupported_target",
      reason: "Member implementation lookup is ambiguous because compatible overload identity is unavailable.",
    };
  }

  const rootRelations = implementationRootRelations(hierarchy, ownerId, ownerNode);
  if (targetNode.implementationTarget) rootRelations.add("extends");
  if (!rootRelations.size) {
    return {
      status: "unsupported_target",
      reason: "Member implementation lookup requires a proven interface, trait, or abstract override relationship.",
    };
  }

  const typeMatches = collectTypeImplementations(graph, hierarchy, ownerId, rootRelations);
  const proofEdges = graph.edges.filter(
    (edge) => edge.to === targetId && (edge.label === "implements_member" || edge.label === "overrides"),
  );
  const memberMatches = new Map<string, ImplementationMatch>();
  for (const proof of proofEdges) {
    const implementingTypeId = graph.edges.find((edge) => edge.from === proof.from && edge.label === "member_of")?.to;
    if (!implementingTypeId) continue;
    const relation =
      proof.label === "overrides"
        ? "extends"
        : (hierarchy.outgoing.get(implementingTypeId) ?? []).find((edge) => edge.to === ownerId)?.relation;
    if (!relation) continue;
    memberMatches.set(proof.from, {
      symbolId: proof.from,
      implementingTypeId,
      relation,
      ...(proof.site ? { site: proof.site } : {}),
    });
  }
  const unresolved: UnresolvedImplementationMatch[] = [];
  let ambiguous = 0;
  for (const typeMatch of typeMatches) {
    const unresolvedMembers = graph.edges
      .filter((edge) => edge.to === typeMatch.symbolId && edge.label === "member_of")
      .map((edge) => edge.from)
      .filter((id) => graph.nodes.get(id)?.name === targetDef.localName && !memberMatches.has(id));
    for (const symbolId of unresolvedMembers) {
      const unresolvedDef = resolveSymbolId(index, symbolId);
      unresolved.push({
        symbolId,
        implementingTypeId: typeMatch.symbolId,
        ...(unresolvedDef ? { site: { file: unresolvedDef.file, range: unresolvedDef.range } } : {}),
      });
    }
    ambiguous += unresolvedMembers.length;
  }
  const matches = [...memberMatches.values()].sort((left, right) => compareImplementationMatches(graph, left, right));
  const truncated = Math.max(0, matches.length - limit);
  return {
    status: "ok",
    targetId,
    implementations: matches.slice(0, limit),
    omitted: truncated + ambiguous,
    ambiguous,
    unresolved: unresolved.sort((left, right) => left.symbolId.localeCompare(right.symbolId)),
    limit,
  };
}

function getTypeHierarchyIndex(graph: SymbolGraph): TypeHierarchyIndex {
  const cached = TYPE_HIERARCHY_CACHE.get(graph);
  if (cached) return cached;
  const outgoing = new Map<string, HierarchyEdge[]>();
  const incoming = new Map<string, HierarchyEdge[]>();
  for (const edge of graph.edges) {
    const relation = hierarchyRelation(edge);
    if (!relation) continue;
    const hierarchyEdge = {
      from: edge.from,
      to: edge.to,
      relation,
      ...(edge.site ? { site: edge.site } : {}),
    };
    appendEdge(outgoing, edge.from, hierarchyEdge);
    appendEdge(incoming, edge.to, hierarchyEdge);
  }
  const created = { outgoing, incoming };
  TYPE_HIERARCHY_CACHE.set(graph, created);
  return created;
}

function hierarchyRelation(edge: SymbolEdge): TypeHierarchyRelationKind | null {
  if (edge.label === "extends") return "extends";
  if (edge.label === "implements") return "implements";
  if (edge.label === "trait") return "trait";
  if (edge.label === "mixin") return "mixin";
  return null;
}

function appendEdge(map: Map<string, HierarchyEdge[]>, key: string, edge: HierarchyEdge): void {
  const edges = map.get(key);
  if (!edges) {
    map.set(key, [edge]);
    return;
  }
  const existingIndex = edges.findIndex(
    (candidate) => candidate.from === edge.from && candidate.to === edge.to && candidate.relation === edge.relation,
  );
  if (existingIndex < 0) {
    edges.push(edge);
    return;
  }
  const existing = edges[existingIndex]!;
  if (!existing.site && edge.site) edges[existingIndex] = edge;
}

function collectTypeImplementations(
  graph: SymbolGraph,
  hierarchy: TypeHierarchyIndex,
  targetId: string,
  acceptedRootRelations: ReadonlySet<TypeHierarchyRelationKind>,
): ImplementationMatch[] {
  const direct = hierarchy.incoming.get(targetId) ?? [];
  const implementationRoots = direct.filter((edge) => acceptedRootRelations.has(edge.relation));
  const matches = new Map<string, ImplementationMatch>();
  const queue: string[] = [];
  for (const edge of implementationRoots) {
    matches.set(edge.from, {
      symbolId: edge.from,
      relation: edge.relation,
      ...(edge.site ? { site: edge.site } : {}),
    });
    queue.push(edge.from);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    for (const edge of hierarchy.incoming.get(current) ?? []) {
      if (matches.has(edge.from)) continue;
      matches.set(edge.from, {
        symbolId: edge.from,
        relation: edge.relation,
        ...(edge.site ? { site: edge.site } : {}),
      });
      queue.push(edge.from);
    }
  }
  return [...matches.values()].sort((left, right) => compareImplementationMatches(graph, left, right));
}

function implementationRootRelations(
  hierarchy: TypeHierarchyIndex,
  targetId: string,
  targetNode: SymbolNode,
): Set<TypeHierarchyRelationKind> {
  const incoming = hierarchy.incoming.get(targetId) ?? [];
  const relations = new Set<TypeHierarchyRelationKind>();
  if (targetNode.kind === "interface" || incoming.some((edge) => edge.relation === "implements")) {
    relations.add("implements");
  }
  if (targetNode.kind === "type" || incoming.some((edge) => edge.relation === "trait")) {
    relations.add("trait");
  }
  if (targetNode.implementationTarget) relations.add("extends");
  return relations;
}

function isTypeNode(node: SymbolNode): boolean {
  return node.kind === "class" || node.kind === "interface" || node.kind === "type";
}

function compareHierarchyEdges(graph: SymbolGraph, left: HierarchyEdge, right: HierarchyEdge): number {
  const leftNode = graph.nodes.get(left.to) ?? graph.nodes.get(left.from);
  const rightNode = graph.nodes.get(right.to) ?? graph.nodes.get(right.from);
  return compareNodes(leftNode, rightNode) || left.relation.localeCompare(right.relation);
}

function compareRelations(
  graph: SymbolGraph,
  left: TypeHierarchyRelationMatch,
  right: TypeHierarchyRelationMatch,
): number {
  return left.depth - right.depth || compareNodes(graph.nodes.get(left.targetId), graph.nodes.get(right.targetId));
}

function compareImplementationMatches(
  graph: SymbolGraph,
  left: ImplementationMatch,
  right: ImplementationMatch,
): number {
  return compareNodes(graph.nodes.get(left.symbolId), graph.nodes.get(right.symbolId));
}

function compareNodes(left: SymbolNode | undefined, right: SymbolNode | undefined): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.file.localeCompare(right.file) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function normalizeDepth(depth: number | undefined): number {
  if (depth === undefined) return 1;
  if (!Number.isInteger(depth) || depth < 1) throw new Error("Hierarchy depth must be a positive integer.");
  return Math.min(depth, MAX_HIERARCHY_DEPTH);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_HIERARCHY_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Hierarchy limit must be a non-negative integer.");
  return Math.min(limit, MAX_HIERARCHY_LIMIT);
}
