import { describe, expect, it } from "vitest";
import * as agentApi from "../src/agent.js";
import * as agentToolsApi from "../src/agent-tools.js";
import * as rootApi from "../src/index.js";
import type { RefactorPlanRequest, RefactorPlanResponse, ToolRefactorPlanRuntimeOptions } from "../src/agent.js";

type PublicRefactorPlanContracts = {
  request: RefactorPlanRequest;
  response: RefactorPlanResponse;
  runtime: ToolRefactorPlanRuntimeOptions;
};

describe("refactor plan public exports", () => {
  it("exposes core, snapshot, session, and agent-tool entrypoints", () => {
    const contract: PublicRefactorPlanContracts | undefined = undefined;

    expect(contract).toBeUndefined();
    expect(agentApi.buildRefactorPlan).toBeTypeOf("function");
    expect(agentApi.buildRefactorPlanWithSession).toBeTypeOf("function");
    expect(agentApi.buildRefactorPlanInSnapshot).toBeTypeOf("function");
    expect(agentApi.tool_buildRefactorPlan).toBe(agentToolsApi.tool_buildRefactorPlan);
    expect("buildRefactorPlan" in rootApi).toBe(false);
    expect("tool_buildRefactorPlan" in rootApi).toBe(false);
  });
});
