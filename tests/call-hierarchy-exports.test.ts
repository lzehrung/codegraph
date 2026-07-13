import { describe, expect, it } from "vitest";
import * as agentApi from "../src/agent.js";
import * as agentToolsApi from "../src/agent-tools.js";
import * as rootApi from "../src/index.js";
import * as indexerApi from "../src/indexer.js";
import type {
  CallHierarchyDirection,
  CallHierarchyEntry,
  CallHierarchyMatch,
  CallHierarchyRequest,
  CallHierarchyResponse,
  CallHierarchySite,
  IndexCallHierarchyResult,
  ToolCallHierarchyRuntimeOptions,
} from "../src/index.js";

type PublicCallHierarchyContracts = {
  direction: CallHierarchyDirection;
  request: CallHierarchyRequest;
  entry: CallHierarchyEntry;
  response: CallHierarchyResponse;
  coreMatch: CallHierarchyMatch;
  coreSite: CallHierarchySite;
  coreResult: IndexCallHierarchyResult;
  runtime: ToolCallHierarchyRuntimeOptions;
};

describe("call hierarchy public exports", () => {
  it("exposes unambiguous core, agent, and tool entrypoints", () => {
    const contract: PublicCallHierarchyContracts | undefined = undefined;

    expect(contract).toBeUndefined();
    expect(rootApi.queryCallHierarchy).toBe(indexerApi.findCallHierarchy);
    expect(rootApi.findCallers).toBe(agentApi.findCallers);
    expect(rootApi.findCalleesWithSession).toBe(agentApi.findCalleesWithSession);
    expect(rootApi.tool_findCallers).toBe(agentToolsApi.tool_findCallers);
    expect(rootApi.tool_findCallees).toBe(agentToolsApi.tool_findCallees);
    expect("findCallHierarchy" in indexerApi).toBe(true);
    expect("queryCallHierarchy" in rootApi).toBe(true);
  });
});
