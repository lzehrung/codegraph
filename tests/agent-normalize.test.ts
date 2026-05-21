import { describe, expect, it } from "vitest";
import path from "node:path";
import { createAgentFileLookup, resolveAgentSnapshotFile, type AgentFileSnapshot } from "../src/agent/normalize.js";

describe("agent normalize helpers", () => {
  it("resolves snapshot files through a precomputed lookup", () => {
    const root = path.resolve("agent-normalize-root");
    const included = path.join(root, "src", "included.ts");
    const omitted = path.join(root, "src", "omitted.ts");
    const snapshot: AgentFileSnapshot = {
      root,
      files: [included, omitted],
      fileLookup: createAgentFileLookup([included]),
    };

    expect(resolveAgentSnapshotFile(snapshot, "src/included.ts")).toBe(included.replace(/\\/g, "/"));
    expect(resolveAgentSnapshotFile(snapshot, "src/omitted.ts")).toBeNull();
  });
});
