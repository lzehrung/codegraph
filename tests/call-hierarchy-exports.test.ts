import { describe, expect, it } from "vitest";
import * as agentApi from "../src/agent.js";
import * as agentToolsApi from "../src/agent-tools.js";
import * as rootApi from "../src/index.js";
import * as indexerApi from "../src/indexer.js";
import type {
  CallHierarchyEntry,
  CallHierarchyRequest,
  CallHierarchyResponse,
  ToolCallHierarchyRuntimeOptions,
} from "../src/agent.js";
import type {
  CallHierarchyDirection,
  CallHierarchyMatch,
  CallHierarchySite,
  IndexCallHierarchyResult,
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
    expect(agentApi.findCallers).toBeTypeOf("function");
    expect(agentApi.findCalleesWithSession).toBeTypeOf("function");
    expect(agentApi.tool_findCallers).toBe(agentToolsApi.tool_findCallers);
    expect(agentApi.tool_findCallees).toBe(agentToolsApi.tool_findCallees);
    expect("findCallHierarchy" in indexerApi).toBe(true);
    expect("queryCallHierarchy" in rootApi).toBe(true);
    expect("findCallers" in rootApi).toBe(false);
    expect("tool_findCallers" in rootApi).toBe(false);
  });
});
