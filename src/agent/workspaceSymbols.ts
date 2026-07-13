import type { BuildOptions } from "../indexer/types.js";
import {
  workspaceSymbols as queryWorkspaceSymbols,
  type WorkspaceSymbolsRequest,
} from "../indexer/workspace-symbols.js";
import { defaultAgentLimit } from "./bounds.js";
import { formatAgentSymbolHandle } from "./handles.js";
import { normalizeAgentFilePath } from "./normalize.js";
import {
  createAgentSession,
  type AgentFreshnessResult,
  type AgentProjectSnapshot,
  type AgentSession,
} from "./session.js";
import type { SemanticResponseEnvelope, SemanticSymbol } from "./semantic.js";

export type AgentWorkspaceSymbolsRequest = WorkspaceSymbolsRequest & {
  root: string;
  buildOptions?: BuildOptions;
};

export type WorkspaceSymbolsResponse = SemanticResponseEnvelope & {
  query: string;
  symbols: SemanticSymbol[];
  totalCandidates: number;
};

export async function workspaceSymbols(request: AgentWorkspaceSymbolsRequest): Promise<WorkspaceSymbolsResponse> {
  const session = createAgentSession({
    root: request.root,
    ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
  });
  return await workspaceSymbolsWithSession(session, request);
}

export async function workspaceSymbolsWithSession(
  session: AgentSession,
  request: AgentWorkspaceSymbolsRequest,
): Promise<WorkspaceSymbolsResponse> {
  const freshness = session.checkFreshness ? await session.checkFreshness() : { state: "fresh" as const };
  const snapshot = await session.loadProject({ symbolGraph: "skip" });
  return await workspaceSymbolsInSnapshot(snapshot, request, freshness);
}

export async function workspaceSymbolsInSnapshot(
  snapshot: AgentProjectSnapshot,
  request: WorkspaceSymbolsRequest,
  freshness: AgentFreshnessResult = { state: "fresh" },
): Promise<WorkspaceSymbolsResponse> {
  const requestedLimit = defaultAgentLimit(request.limit, 50, 500);
  const result = await queryWorkspaceSymbols(snapshot.index, { ...request, limit: requestedLimit });
  const symbols = result.symbols.map((symbol): SemanticSymbol => {
    const file = normalizeAgentFilePath(snapshot.root, symbol.file);
    const range = symbol.range;
    const handleFile = normalizeAgentFilePath(snapshot.root, symbol.def.file);
    const handleRange = symbol.def.range;
    return {
      handle: formatAgentSymbolHandle({
        file: handleFile,
        name: symbol.def.localName,
        line: handleRange.start.line,
        column: handleRange.start.column,
      }),
      name: symbol.name,
      localName: symbol.localName,
      ...(symbol.qualifiedName ? { qualifiedName: `${file}::${symbol.name}` } : {}),
      kind: symbol.kind,
      location: { file, range },
      exported: symbol.exported,
      provenance: {
        capability: snapshot.analysis.mode === "reduced" ? "graph" : "semantic",
        backend: snapshot.analysis.backend,
        confidence: snapshot.analysis.mode === "reduced" ? "medium" : "high",
        ...(snapshot.analysis.mode === "reduced" ? { reason: snapshot.analysis.label } : {}),
      },
    };
  });

  return {
    schemaVersion: 1,
    root: snapshot.root,
    analysis: snapshot.analysis,
    freshness,
    limits: { symbols: result.limit },
    omittedCounts: {
      symbols: result.omitted,
      imports: result.omittedImports,
      importScanFailures: result.importScanFailures,
    },
    query: result.query,
    symbols,
    totalCandidates: result.totalCandidates,
  };
}

export function formatWorkspaceSymbolsResponse(response: WorkspaceSymbolsResponse): string {
  if (!response.symbols.length) return `No workspace symbols matched "${response.query}".`;
  const lines = [`Analysis: ${response.analysis.label}`, `Symbols: ${response.symbols.length}`];
  for (const symbol of response.symbols) {
    const { file, range } = symbol.location;
    lines.push(`${symbol.name} [${symbol.kind}] ${file}:${range.start.line}:${range.start.column}`);
  }
  if (response.omittedCounts.symbols) lines.push(`Omitted: ${response.omittedCounts.symbols}`);
  return lines.join("\n");
}
