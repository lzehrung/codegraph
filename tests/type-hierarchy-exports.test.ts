import { describe, expect, it } from "vitest";
import * as agentApi from "../src/agent.js";
import * as agentToolsApi from "../src/agent-tools.js";
import * as rootApi from "../src/index.js";
import * as indexerApi from "../src/indexer.js";
import type {
  ImplementationEntry,
  ImplementationsResponse,
  ToolTypeHierarchyRuntimeOptions,
  TypeHierarchyRelation,
  TypeHierarchyRequest,
  TypeHierarchyResponse,
} from "../src/agent.js";
import type {
  IndexImplementationsResult,
  IndexTypeHierarchyResult,
  TypeHierarchyDirection,
  TypeHierarchyRelationKind,
} from "../src/index.js";

type PublicHierarchyContracts = {
  direction: TypeHierarchyDirection;
  relationKind: TypeHierarchyRelationKind;
  request: TypeHierarchyRequest;
  relation: TypeHierarchyRelation;
  response: TypeHierarchyResponse;
  implementation: ImplementationEntry;
  implementationsResponse: ImplementationsResponse;
  coreHierarchyResult: IndexTypeHierarchyResult;
  coreImplementationsResult: IndexImplementationsResult;
  runtime: ToolTypeHierarchyRuntimeOptions;
};

describe("type hierarchy public exports", () => {
  it("exposes unambiguous core, agent, and tool entrypoints", () => {
    const contract: PublicHierarchyContracts | undefined = undefined;

    expect(contract).toBeUndefined();
    expect(rootApi.queryTypeHierarchy).toBe(indexerApi.findTypeHierarchy);
    expect(rootApi.queryImplementations).toBe(indexerApi.findImplementations);
    expect(agentApi.findSupertypes).toBeTypeOf("function");
    expect(agentApi.findSubtypesWithSession).toBeTypeOf("function");
    expect(agentApi.findImplementations).toBeTypeOf("function");
    expect(agentApi.tool_findSupertypes).toBe(agentToolsApi.tool_findSupertypes);
    expect(agentApi.tool_findSubtypes).toBe(agentToolsApi.tool_findSubtypes);
    expect(agentApi.tool_findImplementations).toBe(agentToolsApi.tool_findImplementations);
    expect("findTypeHierarchy" in indexerApi).toBe(true);
    expect("queryTypeHierarchy" in rootApi).toBe(true);
    expect("findSupertypes" in rootApi).toBe(false);
    expect("findImplementations" in rootApi).toBe(false);
    expect("tool_findImplementations" in rootApi).toBe(false);
  });
});
