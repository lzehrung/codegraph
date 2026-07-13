import { describe, expect, it } from "vitest";
import * as agentApi from "../src/agent.js";
import * as agentToolsApi from "../src/agent-tools.js";
import * as rootApi from "../src/index.js";
import type { RefactorPlanRequest, RefactorPlanResponse, ToolRefactorPlanRuntimeOptions } from "../src/index.js";

type PublicRefactorPlanContracts = {
  request: RefactorPlanRequest;
  response: RefactorPlanResponse;
  runtime: ToolRefactorPlanRuntimeOptions;
};

describe("refactor plan public exports", () => {
  it("exposes core, snapshot, session, and agent-tool entrypoints", () => {
    const contract: PublicRefactorPlanContracts | undefined = undefined;

    expect(contract).toBeUndefined();
    expect(rootApi.buildRefactorPlan).toBe(agentApi.buildRefactorPlan);
    expect(rootApi.buildRefactorPlanWithSession).toBe(agentApi.buildRefactorPlanWithSession);
    expect(rootApi.buildRefactorPlanInSnapshot).toBe(agentApi.buildRefactorPlanInSnapshot);
    expect(rootApi.tool_buildRefactorPlan).toBe(agentToolsApi.tool_buildRefactorPlan);
  });
});
