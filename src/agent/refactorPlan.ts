import { findCallHierarchy, type CallHierarchyDirection, type CallHierarchyResult } from "../indexer/call-hierarchy.js";
import { findReferences } from "../indexer/navigation.js";
import {
  findImplementations as queryImplementations,
  findTypeHierarchy,
  type TypeHierarchyDirection,
  type TypeHierarchyResult,
} from "../indexer/type-hierarchy.js";
import type { BuildOptions } from "../indexer/types.js";
import { listCandidateTestFiles } from "../impact/context.js";
import { classifySensitiveFile } from "./fileView.js";
import { normalizeAgentFilePath } from "./normalize.js";
import { previewRenameInSnapshot, type RenameCandidateTest, type RenamePreviewResponse } from "./renamePreview.js";
import type { CallHierarchyEntry } from "./callHierarchy.js";
import type { ImplementationEntry, TypeHierarchyRelation } from "./typeHierarchy.js";
import type { SemanticLocation, SemanticProvenance, SemanticResponseEnvelope, SemanticSymbol } from "./semantic.js";
import { requireSemanticSymbol, semanticSymbolFromDef } from "./semanticSymbols.js";
import {
  createAgentSession,
  type AgentFreshnessResult,
  type AgentProjectSnapshot,
  type AgentSession,
} from "./session.js";
import { buildSymbolLookup, type SymbolLookup } from "./symbolLookup.js";
import { type AgentFollowUp, toolFollowUp } from "./followUps.js";

export type RefactorPlanRequest = {
  root: string;
  handle: string;
  renameTo?: string;
  maxReferences?: number;
  maxCallers?: number;
  maxHierarchy?: number;
  includeSource?: boolean;
  buildOptions?: BuildOptions;
};

export type RefactorPlanSectionIssue = {
  section: "implementations";
  status: "not_found" | "invalid_target" | "unsupported_target";
  reason: string;
};

export type RefactorPlanResponse = SemanticResponseEnvelope & {
  target: SemanticSymbol;
  definition: SemanticLocation;
  references: SemanticLocation[];
  callers: CallHierarchyEntry[];
  callees: CallHierarchyEntry[];
  supertypes: TypeHierarchyRelation[];
  subtypes: TypeHierarchyRelation[];
  implementations: ImplementationEntry[];
  sectionIssues: RefactorPlanSectionIssue[];
  rename?: RenamePreviewResponse;
  candidateTests: RenameCandidateTest[];
  followUps: AgentFollowUp[];
};

const DEFAULT_REFACTOR_REFERENCE_LIMIT = 200;
const DEFAULT_REFACTOR_RELATION_LIMIT = 100;
const MAX_REFACTOR_SECTION_LIMIT = 500;

export async function buildRefactorPlan(request: RefactorPlanRequest): Promise<RefactorPlanResponse> {
  const session = createAgentSession({
    root: request.root,
    ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
  });
  return await buildRefactorPlanWithSession(session, request);
}

export async function buildRefactorPlanWithSession(
  session: AgentSession,
  request: RefactorPlanRequest,
): Promise<RefactorPlanResponse> {
  const freshness = session.checkFreshness ? await session.checkFreshness() : { state: "fresh" as const };
  const snapshot = await session.loadProject();
  return await buildRefactorPlanInSnapshot(snapshot, request, freshness);
}

export async function buildRefactorPlanInSnapshot(
  snapshot: AgentProjectSnapshot,
  request: Omit<RefactorPlanRequest, "buildOptions">,
  freshness: AgentFreshnessResult = { state: "fresh" },
): Promise<RefactorPlanResponse> {
  const resolved = requireSemanticSymbol(snapshot, request.handle);
  const referenceLimit = boundedSectionLimit(request.maxReferences, DEFAULT_REFACTOR_REFERENCE_LIMIT, "maxReferences");
  const callerLimit = boundedSectionLimit(request.maxCallers, DEFAULT_REFACTOR_RELATION_LIMIT, "maxCallers");
  const hierarchyLimit = boundedSectionLimit(request.maxHierarchy, DEFAULT_REFACTOR_RELATION_LIMIT, "maxHierarchy");
  const provenance = relationshipProvenance(snapshot);
  const lookup = buildSymbolLookup(snapshot);

  const referenceResult = await findReferences(
    snapshot.index,
    { def: resolved.def },
    {
      maxReferences: referenceLimit + 1,
      ...(request.includeSource ? { context: "line" as const } : {}),
    },
  );
  if (referenceResult.status !== "ok") throw new Error(referenceResult.reason);
  const referenceOmitted = Math.max(0, referenceResult.references.length - referenceLimit);
  const references = referenceResult.references.slice(0, referenceLimit).map((reference): SemanticLocation => {
    const file = normalizeAgentFilePath(snapshot.root, reference.file);
    const includeContext =
      request.includeSource && !classifySensitiveFile(file) && !classifySensitiveFile(reference.file);
    return {
      file,
      range: reference.range,
      ...(includeContext && reference.context ? { context: reference.context } : {}),
    };
  });
  const callersResult = findCallHierarchy(snapshot.symbolGraph, resolved.id, "incoming", {
    depth: 1,
    limit: callerLimit,
  });
  const calleesResult = findCallHierarchy(snapshot.symbolGraph, resolved.id, "outgoing", {
    depth: 1,
    limit: callerLimit,
  });
  const callers = normalizeCallSection(snapshot, lookup, callersResult, "incoming", provenance);
  const callees = normalizeCallSection(snapshot, lookup, calleesResult, "outgoing", provenance);

  const supertypesResult = findTypeHierarchy(snapshot.symbolGraph, resolved.id, "super", {
    depth: 10,
    limit: hierarchyLimit,
  });
  const subtypesResult = findTypeHierarchy(snapshot.symbolGraph, resolved.id, "sub", {
    depth: 10,
    limit: hierarchyLimit,
  });
  const supertypes = normalizeHierarchySection(snapshot, lookup, supertypesResult, "super", provenance);
  const subtypes = normalizeHierarchySection(snapshot, lookup, subtypesResult, "sub", provenance);

  const implementationResult = queryImplementations(snapshot.index, snapshot.symbolGraph, resolved.id, {
    limit: hierarchyLimit,
  });
  const implementations: ImplementationEntry[] = [];
  const sectionIssues: RefactorPlanSectionIssue[] = [];
  if (implementationResult.status === "ok") {
    for (const entry of implementationResult.implementations) {
      const def = lookup.defById.get(entry.symbolId);
      if (!def) continue;
      implementations.push({
        symbol: semanticSymbolFromDef(snapshot, def),
        ...(entry.site
          ? {
              relationSite: {
                file: normalizeAgentFilePath(snapshot.root, entry.site.file),
                range: entry.site.range,
              },
            }
          : {}),
        provenance,
      });
    }
  } else {
    sectionIssues.push({
      section: "implementations",
      status: implementationResult.status,
      reason: implementationResult.reason,
    });
  }

  const allCandidateTests = listCandidateTestFiles(snapshot.index, [resolved.def.file], [resolved.id], {
    maxCandidates: 101,
    projectRoot: snapshot.root,
  });
  const omittedCandidateTests = Math.max(0, allCandidateTests.length - 100);
  const candidateTests = allCandidateTests.slice(0, 100).map(
    (candidate): RenameCandidateTest => ({
      file: normalizeAgentFilePath(snapshot.root, candidate.file),
      confidence: candidate.confidence,
      reason: candidate.reason,
    }),
  );
  const target = semanticSymbolFromDef(snapshot, resolved.def);
  const rename = request.renameTo
    ? await previewRenameInSnapshot(
        snapshot,
        {
          root: request.root,
          handle: target.handle,
          newName: request.renameTo,
        },
        freshness,
      )
    : undefined;
  const followUps: AgentFollowUp[] = [
    toolFollowUp("refs", {
      file: target.location.file,
      line: target.location.range.start.line,
      column: target.location.range.start.column,
    }),
    toolFollowUp("calls", { handle: target.handle, direction: "callers", depth: 1 }),
    toolFollowUp("calls", { handle: target.handle, direction: "callees", depth: 1 }),
    toolFollowUp("implementations", { handle: target.handle }),
  ];
  if (!request.renameTo) {
    followUps.push(toolFollowUp("rename_preview", { handle: target.handle, newName: "<new-name>" }));
  }

  return {
    schemaVersion: 1,
    root: snapshot.root,
    analysis: snapshot.analysis,
    freshness,
    limits: {
      references: referenceLimit,
      callers: callerLimit,
      callees: callerLimit,
      hierarchy: hierarchyLimit,
      candidateTests: 100,
    },
    omittedCounts: {
      references: referenceOmitted,
      callers: callOmitted(callersResult),
      callees: callOmitted(calleesResult),
      supertypes: hierarchyOmitted(supertypesResult),
      subtypes: hierarchyOmitted(subtypesResult),
      implementations: implementationResult.status === "ok" ? implementationResult.omitted : 1,
      candidateTests: omittedCandidateTests,
    },
    target,
    definition: target.location,
    references,
    callers,
    callees,
    supertypes,
    subtypes,
    implementations,
    sectionIssues,
    ...(rename ? { rename } : {}),
    candidateTests,
    followUps,
  };
}

function normalizeCallSection(
  snapshot: AgentProjectSnapshot,
  lookup: SymbolLookup,
  result: CallHierarchyResult,
  direction: CallHierarchyDirection,
  provenance: SemanticProvenance,
): CallHierarchyEntry[] {
  if (result.status !== "ok" || result.direction !== direction) return [];
  return result.entries.flatMap((entry): CallHierarchyEntry[] => {
    const def = lookup.defById.get(entry.symbolId);
    if (!def) return [];
    return [
      {
        symbol: semanticSymbolFromDef(snapshot, def),
        callsites: entry.callsites.map((site) => ({
          file: normalizeAgentFilePath(snapshot.root, site.file),
          range: site.range,
        })),
        depth: entry.depth,
        provenance,
      },
    ];
  });
}

function normalizeHierarchySection(
  snapshot: AgentProjectSnapshot,
  lookup: SymbolLookup,
  result: TypeHierarchyResult,
  direction: TypeHierarchyDirection,
  provenance: SemanticProvenance,
): TypeHierarchyRelation[] {
  if (result.status !== "ok" || result.direction !== direction) return [];
  return result.relations.flatMap((relation): TypeHierarchyRelation[] => {
    const def = lookup.defById.get(relation.targetId);
    if (!def) return [];
    return [
      {
        type: semanticSymbolFromDef(snapshot, def),
        relation: relation.relation,
        ...(relation.site
          ? {
              declarationSite: {
                file: normalizeAgentFilePath(snapshot.root, relation.site.file),
                range: relation.site.range,
              },
            }
          : {}),
        depth: relation.depth,
        provenance,
      },
    ];
  });
}

function callOmitted(result: CallHierarchyResult): number {
  return result.status === "ok" ? result.omittedSymbols : 0;
}

function hierarchyOmitted(result: TypeHierarchyResult): number {
  return result.status === "ok" ? result.omitted : 0;
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

function boundedSectionLimit(value: number | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return Math.min(value, MAX_REFACTOR_SECTION_LIMIT);
}
