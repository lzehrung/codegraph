import { describe, expect, it } from "vitest";
import * as agentApi from "../src/agent.js";
import * as agentToolsApi from "../src/agent-tools.js";
import * as rootApi from "../src/index.js";
import type {
  RenameCandidateTest,
  RenameConflict,
  RenameEdit,
  RenameEditKind,
  RenameFilenameSuggestion,
  RenamePreviewRequest,
  RenamePreviewResponse,
  RenameUnsafeSite,
  ToolRenamePreviewRuntimeOptions,
} from "../src/agent.js";

type PublicRenameContracts = {
  request: RenamePreviewRequest;
  response: RenamePreviewResponse;
  edit: RenameEdit;
  editKind: RenameEditKind;
  conflict: RenameConflict;
  unsafeSite: RenameUnsafeSite;
  filenameSuggestion: RenameFilenameSuggestion;
  candidateTest: RenameCandidateTest;
  runtime: ToolRenamePreviewRuntimeOptions;
};

describe("rename preview public exports", () => {
  it("exposes core, snapshot, session, and agent-tool entrypoints", () => {
    const contract: PublicRenameContracts | undefined = undefined;

    expect(contract).toBeUndefined();
    expect(agentApi.previewRename).toBeTypeOf("function");
    expect(agentApi.previewRenameWithSession).toBeTypeOf("function");
    expect(agentApi.previewRenameInSnapshot).toBeTypeOf("function");
    expect(agentApi.tool_previewRename).toBe(agentToolsApi.tool_previewRename);
    expect("previewRename" in rootApi).toBe(false);
    expect("tool_previewRename" in rootApi).toBe(false);
  });
});
