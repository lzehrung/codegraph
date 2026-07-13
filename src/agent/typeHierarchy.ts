import type { BuildOptions } from "../indexer/types.js";
import {
  findImplementations as queryImplementations,
  findTypeHierarchy,
  type TypeHierarchyDirection,
  type TypeHierarchyRelationKind,
} from "../indexer/type-hierarchy.js";
import type { SemanticLocation, SemanticProvenance, SemanticResponseEnvelope, SemanticSymbol } from "./semantic.js";
import { resolveSemanticSymbol, semanticSymbolFromDef } from "./semanticSymbols.js";
import { createAgentSession, type AgentFreshnessResult, type AgentProjectSnapshot, type AgentSession } from "./session.js";
import { buildSymbolLookup } from "./symbolLookup.js";

export type TypeHierarchyRequest = {
  root: string;
  handle: string;
  depth?: number;
  limit?: number;
  buildOptions?: BuildOptions;
};

export type TypeHierarchyRelation = {
  type: SemanticSymbol;
  relation: TypeHierarchyRelationKind;
  declarationSite?: SemanticLocation;
  depth: number;
  provenance: SemanticProvenance;
};

export type TypeHierarchyResponse = SemanticResponseEnvelope & {
  target: SemanticSymbol;
  direction: TypeHierarchyDirection;
  relations: TypeHierarchyRelation[];
};

export type ImplementationEntry = {
  symbol: SemanticSymbol;
  implementedMember?: SemanticSymbol;
  relationSite?: SemanticLocation;
  provenance: SemanticProvenance;
};

export type ImplementationsResponse = SemanticResponseEnvelope & {
  target: SemanticSymbol;
  implementations: ImplementationEntry[];
};

export async function findSupertypes(request: TypeHierarchyRequest): Promise<TypeHierarchyResponse> {
  return await runTypeHierarchy(createSession(request), request, "super");
}

export async function findSubtypes(request: TypeHierarchyRequest): Promise<TypeHierarchyResponse> {
  return await runTypeHierarchy(createSession(request), request, "sub");
}

export async function findSupertypesWithSession(
  session: AgentSession,
  request: TypeHierarchyRequest,
): Promise<TypeHierarchyResponse> {
  return await runTypeHierarchy(session, request, "super");
}

export async function findSubtypesWithSession(
  session: AgentSession,
  request: TypeHierarchyRequest,
): Promise<TypeHierarchyResponse> {
  return await runTypeHierarchy(session, request, "sub");
}

export async function findImplementations(request: TypeHierarchyRequest): Promise<ImplementationsResponse> {
  return await findImplementationsWithSession(createSession(request), request);
}

export async function findImplementationsWithSession(
  session: AgentSession,
  request: TypeHierarchyRequest,
): Promise<ImplementationsResponse> {
  const freshness = await checkFreshness(session);
  const snapshot = await session.loadProject();
  const resolved = requireSemanticTarget(snapshot, request.handle);
  const result = queryImplementations(snapshot.index, snapshot.symbolGraph, resolved.id, {
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  });
  if (result.status !== "ok") throw new Error(result.reason);
  const lookup = buildSymbolLookup(snapshot);
  const provenance = relationshipProvenance(snapshot);
  const implementations = result.implementations.flatMap((match): ImplementationEntry[] => {
    const def = lookup.defById.get(match.symbolId);
    if (!def) return [];
    const memberDef = match.implementedMemberId ? lookup.defById.get(match.implementedMemberId) : undefined;
    return [
      {
        symbol: semanticSymbolFromDef(snapshot, def),
        ...(memberDef ? { implementedMember: semanticSymbolFromDef(snapshot, memberDef) } : {}),
        provenance,
      },
    ];
  });
  return {
    ...responseEnvelope(snapshot, freshness, result.limit, result.omitted),
    target: semanticSymbolFromDef(snapshot, resolved.def),
    implementations,
  };
}

async function runTypeHierarchy(
  session: AgentSession,
  request: TypeHierarchyRequest,
  direction: TypeHierarchyDirection,
): Promise<TypeHierarchyResponse> {
  const freshness = await checkFreshness(session);
  const snapshot = await session.loadProject();
  const resolved = requireSemanticTarget(snapshot, request.handle);
  const result = findTypeHierarchy(snapshot.symbolGraph, resolved.id, direction, {
    ...(request.depth !== undefined ? { depth: request.depth } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  });
  if (result.status !== "ok") throw new Error(result.reason);
  const lookup = buildSymbolLookup(snapshot);
  const provenance = relationshipProvenance(snapshot);
  const relations = result.relations.flatMap((match): TypeHierarchyRelation[] => {
    const def = lookup.defById.get(match.targetId);
    if (!def) return [];
    return [
      {
        type: semanticSymbolFromDef(snapshot, def),
        relation: match.relation,
        depth: match.depth,
        provenance,
      },
    ];
  });
  return {
    ...responseEnvelope(snapshot, freshness, result.limit, result.omitted),
    target: semanticSymbolFromDef(snapshot, resolved.def),
    direction,
    relations,
  };
}

function createSession(request: TypeHierarchyRequest): AgentSession {
  return createAgentSession({
    root: request.root,
    ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
  });
}

function requireSemanticTarget(snapshot: AgentProjectSnapshot, handle: string) {
  const resolved = resolveSemanticSymbol(snapshot, handle);
  if (!resolved) throw new Error("Symbol handle is stale or missing. Run workspace symbol lookup to resolve it again.");
  return resolved;
}

async function checkFreshness(session: AgentSession): Promise<AgentFreshnessResult> {
  return session.checkFreshness ? await session.checkFreshness() : { state: "fresh" };
}

function relationshipProvenance(snapshot: AgentProjectSnapshot): SemanticProvenance {
  const reduced = snapshot.analysis.mode === "reduced";
  return {
    capability: reduced ? "graph" : "semantic",
    backend: snapshot.analysis.backend,
    confidence: reduced ? "medium" : "high",
    ...(reduced ? { reason: snapshot.analysis.label } : {}),
  };
}

function responseEnvelope(
  snapshot: AgentProjectSnapshot,
  freshness: AgentFreshnessResult,
  limit: number,
  omitted: number,
): SemanticResponseEnvelope {
  return {
    schemaVersion: 1,
    root: snapshot.root,
    analysis: snapshot.analysis,
    freshness,
    limits: { relations: limit },
    omittedCounts: { relations: omitted },
  };
}
