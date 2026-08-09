export { toolFollowUp } from "./agent/followUps.js";
export type { AgentFollowUp } from "./agent/followUps.js";
export {
  DEFAULT_FILE_VIEW_BYTES,
  DEFAULT_FILE_VIEW_LINES,
  FILE_VIEW_GRAPH_CONTEXT_LIMIT,
  formatAgentFileViewResponse,
  getCodegraphFileView,
  getCodegraphFileViewWithSession,
  MAX_FILE_VIEW_BYTES,
  MAX_FILE_VIEW_LINES,
} from "./agent/fileView.js";
export type {
  AgentFileGraphContext,
  AgentFileViewRequest,
  AgentFileViewResponse,
  AgentFileViewSensitiveInfo,
  AgentFileViewSensitiveKind,
} from "./agent/fileView.js";
export { createAgentSession } from "./agent/session.js";
export type {
  AgentFreshnessPolicy,
  AgentFreshnessResult,
  AgentProjectSnapshot,
  AgentSession,
  AgentSessionFreshnessOptions,
  AgentSessionOptions,
} from "./agent/session.js";
export { exploreCodegraph, exploreCodegraphWithSession, formatAgentExploreResponse } from "./agent/explore.js";
export type {
  AgentExploreBlastRadiusSummary,
  AgentExploreDependencyPathSummary,
  AgentExploreLimits,
  AgentExploreOmittedCounts,
  AgentExplorePacketSummary,
  AgentExploreRequest,
  AgentExploreResponse,
} from "./agent/explore.js";
export { orientCodegraph } from "./agent/orient.js";
export type {
  AgentOrientBudget,
  AgentOrientHealthMode,
  AgentOrientRequest,
  AgentOrientResponse,
  AgentOrientationFocus,
  AgentPacketCommand,
  AgentTreeEntry,
} from "./agent/orient.js";
export { getCodegraphPacket } from "./agent/packet.js";
export type { AgentPacketKind, AgentPacketPayload, AgentPacketRequest, AgentPacketResponse } from "./agent/packet.js";
export { formatAgentSearchResponse, searchCodegraph, searchCodegraphWithSession } from "./agent/search.js";
export type {
  AgentSearchEvidence,
  AgentSearchMode,
  AgentSearchRequest,
  AgentSearchResponse,
  AgentSearchResult,
  AgentSearchResultKind,
} from "./agent/search.js";
export { explainCodegraphTarget, explainCodegraphTargetWithSession, formatAgentExplanation } from "./agent/explain.js";
export type {
  AgentExplainTarget,
  AgentExplanation,
  AgentExplanationChangedContext,
  AgentExplanationDuplicate,
  AgentExplanationDuplicateSide,
  AgentExplanationDependency,
  AgentExplanationReference,
  AgentExplanationSnippet,
  AgentExplanationSqlObject,
  AgentExplanationSymbol,
  AgentExplanationTarget,
} from "./agent/explain.js";
export { buildCodegraphArtifact, buildCodegraphArtifactWithSession } from "./agent/artifact.js";
export type { CodegraphArtifactBuildRequest, CodegraphArtifactBuildResult } from "./agent/artifact.js";
export {
  formatWorkspaceSymbolsResponse,
  workspaceSymbols,
  workspaceSymbolsInSnapshot,
  workspaceSymbolsWithSession,
} from "./agent/workspaceSymbols.js";
export type { AgentWorkspaceSymbolsRequest, WorkspaceSymbolsResponse } from "./agent/workspaceSymbols.js";
export {
  findImplementations,
  findImplementationsWithSession,
  findSubtypes,
  findSubtypesWithSession,
  findSupertypes,
  findSupertypesWithSession,
} from "./agent/typeHierarchy.js";
export type {
  ImplementationEntry,
  ImplementationsResponse,
  TypeHierarchyRelation,
  TypeHierarchyRequest,
  TypeHierarchyResponse,
} from "./agent/typeHierarchy.js";
export { findCallees, findCalleesWithSession, findCallers, findCallersWithSession } from "./agent/callHierarchy.js";
export type { CallHierarchyEntry, CallHierarchyRequest, CallHierarchyResponse } from "./agent/callHierarchy.js";
export { previewRename, previewRenameInSnapshot, previewRenameWithSession } from "./agent/renamePreview.js";
export type {
  RenameCandidateTest,
  RenameConflict,
  RenameEdit,
  RenameEditKind,
  RenameFilenameSuggestion,
  RenamePreviewRequest,
  RenamePreviewResponse,
  RenameUnsafeSite,
} from "./agent/renamePreview.js";
export { buildRefactorPlan, buildRefactorPlanInSnapshot, buildRefactorPlanWithSession } from "./agent/refactorPlan.js";
export type { RefactorPlanRequest, RefactorPlanResponse, RefactorPlanSectionIssue } from "./agent/refactorPlan.js";

/** Resolve a portable handle, qualified path, location, or exact name for semantic agent queries. */
export { requireSemanticSymbol } from "./agent/semanticSymbols.js";
export type { ResolvedSemanticSymbol } from "./agent/semanticSymbols.js";

export type {
  SemanticLocation,
  SemanticOmittedCounts,
  SemanticProvenance,
  SemanticResponseEnvelope,
  SemanticSymbol,
} from "./agent/semantic.js";

/** Agent-oriented JSON tool wrappers around the core codegraph APIs. */
export {
  tool_impactJSON,
  tool_impactFromDiffText,
  tool_getFileOverview,
  tool_findSymbol,
  tool_listProjectFiles,
  tool_getGraph,
  tool_getDependencies,
  tool_getReverseDependencies,
  tool_getHotspots,
  tool_goToDefinition,
  tool_workspaceSymbols,
  tool_findImplementations,
  tool_findSubtypes,
  tool_findSupertypes,
  tool_findReferences,
  tool_findCallees,
  tool_findCallers,
  tool_previewRename,
  tool_buildRefactorPlan,
  type ToolFileOverview,
  type ToolFileOverviewImport,
  type ToolFileOverviewDefinition,
  type ToolFileOverviewResult,
  type ToolSymbolMatch,
  type ToolDependencyEntry,
  type ToolHotspotEntry,
  type ToolWorkspaceSymbolsRuntimeOptions,
  type ToolTypeHierarchyRuntimeOptions,
  type ToolCallHierarchyRuntimeOptions,
  type ToolRenamePreviewRuntimeOptions,
  type ToolRefactorPlanRuntimeOptions,
} from "./agent-tools.js";
