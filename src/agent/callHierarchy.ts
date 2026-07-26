import { findCallHierarchy, type CallHierarchyDirection } from "../indexer/call-hierarchy.js";
import type { BuildOptions } from "../indexer/types.js";
import { normalizeAgentFilePath } from "./normalize.js";
import type { SemanticLocation, SemanticProvenance, SemanticResponseEnvelope, SemanticSymbol } from "./semantic.js";
import { requireSemanticSymbol, semanticSymbolFromDef } from "./semanticSymbols.js";
import {
  createAgentSession,
  type AgentFreshnessResult,
  type AgentProjectSnapshot,
  type AgentSession,
} from "./session.js";
import { buildSymbolLookup } from "./symbolLookup.js";

export type CallHierarchyRequest = {
  root: string;
  handle: string;
  depth?: number;
  limit?: number;
  includeHeuristic?: boolean;
  buildOptions?: BuildOptions;
};

export type CallHierarchyEntry = {
  symbol: SemanticSymbol;
  callsites: SemanticLocation[];
  depth: number;
  provenance: SemanticProvenance;
};

export type CallHierarchyResponse = SemanticResponseEnvelope & {
  target: SemanticSymbol;
  direction: CallHierarchyDirection;
  entries: CallHierarchyEntry[];
};

export async function findCallers(request: CallHierarchyRequest): Promise<CallHierarchyResponse> {
  return await runCallHierarchy(createSession(request), request, "incoming");
}

export async function findCallees(request: CallHierarchyRequest): Promise<CallHierarchyResponse> {
  return await runCallHierarchy(createSession(request), request, "outgoing");
}

export async function findCallersWithSession(
  session: AgentSession,
  request: CallHierarchyRequest,
): Promise<CallHierarchyResponse> {
  return await runCallHierarchy(session, request, "incoming");
}

export async function findCalleesWithSession(
  session: AgentSession,
  request: CallHierarchyRequest,
): Promise<CallHierarchyResponse> {
  return await runCallHierarchy(session, request, "outgoing");
}

async function runCallHierarchy(
  session: AgentSession,
  request: CallHierarchyRequest,
  direction: CallHierarchyDirection,
): Promise<CallHierarchyResponse> {
  const freshness = session.checkFreshness ? await session.checkFreshness() : { state: "fresh" as const };
  const snapshot = await session.loadProject();
  const resolved = requireSemanticSymbol(snapshot, request.handle);
  const result = findCallHierarchy(snapshot.symbolGraph, resolved.id, direction, {
    ...(request.depth !== undefined ? { depth: request.depth } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  });
  if (result.status !== "ok") throw new Error(result.reason);

  const lookup = buildSymbolLookup(snapshot);
  const provenance = callProvenance(snapshot);
  const entries = result.entries.flatMap((match): CallHierarchyEntry[] => {
    const def = lookup.defById.get(match.symbolId);
    if (!def) return [];
    return [
      {
        symbol: semanticSymbolFromDef(snapshot, def),
        callsites: match.callsites.map((site) => ({
          file: normalizeAgentFilePath(snapshot.root, site.file),
          range: site.range,
        })),
        depth: match.depth,
        provenance,
      },
    ];
  });

  return {
    ...callResponseEnvelope(snapshot, freshness, result.limit, result.callsiteLimit, {
      symbols: result.omittedSymbols,
      callsites: result.omittedCallsites,
      unresolvedSites: result.unresolvedEdges,
    }),
    target: semanticSymbolFromDef(snapshot, resolved.def),
    direction,
    entries,
  };
}

function createSession(request: CallHierarchyRequest): AgentSession {
  return createAgentSession({
    root: request.root,
    ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
  });
}

function callProvenance(snapshot: AgentProjectSnapshot): SemanticProvenance {
  const reduced = snapshot.analysis.mode === "reduced";
  return {
    capability: reduced ? "graph" : "semantic",
    backend: snapshot.analysis.backend,
    confidence: reduced ? "medium" : "high",
    ...(reduced ? { reason: snapshot.analysis.label } : {}),
  };
}

function callResponseEnvelope(
  snapshot: AgentProjectSnapshot,
  freshness: AgentFreshnessResult,
  symbolLimit: number,
  callsiteLimit: number,
  omittedCounts: Record<string, number>,
): SemanticResponseEnvelope {
  return {
    schemaVersion: 1,
    root: snapshot.root,
    analysis: snapshot.analysis,
    freshness,
    limits: { symbols: symbolLimit, callsitesPerSymbol: callsiteLimit },
    omittedCounts,
  };
}
