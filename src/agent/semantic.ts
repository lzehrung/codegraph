import type { AnalysisBackend, AnalysisSummary } from "../analysisSummary.js";
import type { SymbolKind } from "../indexer/types.js";
import type { Range } from "../types.js";
import type { AgentFreshnessResult } from "./session.js";

export type SemanticLocation = {
  file: string;
  range: Range;
  context?: string;
};

export type SemanticProvenance = {
  capability: "semantic" | "graph" | "heuristic";
  backend: AnalysisBackend;
  confidence: "high" | "medium" | "low";
  reason?: string;
};

export type SemanticOmittedCounts = Record<string, number>;

export type SemanticResponseEnvelope = {
  schemaVersion: 1;
  root: string;
  analysis: AnalysisSummary;
  freshness: AgentFreshnessResult;
  limits: Record<string, number>;
  omittedCounts: SemanticOmittedCounts;
};

export type SemanticSymbol = {
  handle: string;
  name: string;
  localName: string;
  qualifiedName?: string;
  kind: SymbolKind | "import" | "namespaceImport";
  location: SemanticLocation;
  exported: boolean;
  provenance: SemanticProvenance;
};
