import { describe, expect, it } from "vitest";
import * as agentApi from "../src/agent.js";
import * as agentToolsApi from "../src/agent-tools.js";
import * as rootApi from "../src/index.js";
import * as indexerApi from "../src/indexer.js";
import type {
  AgentWorkspaceSymbolsRequest,
  SemanticLocation,
  SemanticOmittedCounts,
  SemanticProvenance,
  SemanticResponseEnvelope,
  SemanticSymbol,
  ToolWorkspaceSymbolsRuntimeOptions,
  WorkspaceSymbolMatch,
  WorkspaceSymbolsRequest,
  WorkspaceSymbolsResponse,
  WorkspaceSymbolsResult,
} from "../src/index.js";

type PublicWorkspaceSymbolContracts = {
  agentRequest: AgentWorkspaceSymbolsRequest;
  coreRequest: WorkspaceSymbolsRequest;
  coreMatch: WorkspaceSymbolMatch;
  coreResult: WorkspaceSymbolsResult;
  response: WorkspaceSymbolsResponse;
  location: SemanticLocation;
  omittedCounts: SemanticOmittedCounts;
  provenance: SemanticProvenance;
  envelope: SemanticResponseEnvelope;
  symbol: SemanticSymbol;
  runtime: ToolWorkspaceSymbolsRuntimeOptions;
};

describe("workspace symbol public exports", () => {
  it("exposes unambiguous root, indexer, agent, and tool entrypoints", () => {
    const contract: PublicWorkspaceSymbolContracts | undefined = undefined;

    expect(contract).toBeUndefined();
    expect(rootApi.queryWorkspaceSymbols).toBe(indexerApi.workspaceSymbols);
    expect(rootApi.workspaceSymbols).toBe(agentApi.workspaceSymbols);
    expect(rootApi.workspaceSymbolsWithSession).toBe(agentApi.workspaceSymbolsWithSession);
    expect(rootApi.formatWorkspaceSymbolsResponse).toBe(agentApi.formatWorkspaceSymbolsResponse);
    expect(rootApi.tool_workspaceSymbols).toBe(agentToolsApi.tool_workspaceSymbols);
    expect(rootApi.DEFAULT_WORKSPACE_SYMBOL_LIMIT).toBe(50);
    expect(rootApi.MAX_WORKSPACE_SYMBOL_LIMIT).toBe(500);
    expect("workspaceSymbols" in indexerApi).toBe(true);
    expect("queryWorkspaceSymbols" in rootApi).toBe(true);
  });
});
