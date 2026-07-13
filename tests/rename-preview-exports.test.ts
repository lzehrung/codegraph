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
} from "../src/index.js";

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
    expect(rootApi.previewRename).toBe(agentApi.previewRename);
    expect(rootApi.previewRenameWithSession).toBe(agentApi.previewRenameWithSession);
    expect(rootApi.previewRenameInSnapshot).toBe(agentApi.previewRenameInSnapshot);
    expect(rootApi.tool_previewRename).toBe(agentToolsApi.tool_previewRename);
  });
});
