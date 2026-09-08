import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  getCodegraphPacketWithSession,
  orientCodegraphWithSession,
  searchCodegraphWithSession,
} from "../src/agent.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const tempRoots = createTempRootRegistry();

describe("public agent session workflow", () => {
  afterEach(async () => {
    await tempRoots.cleanup();
  });

  it("uses discovered targets for packet retrieval and symbol search through public exports", async () => {
    const root = await tempRoots.create("cg-agent-session-exports-");
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser() { return true; }\n");
    const session = createAgentSession({ root, buildOptions: { cache: "off" } });
    try {
      const orientation = await orientCodegraphWithSession(session, { root, budget: "small" });
      const target = orientation.focus.find((entry) => entry.file === "auth.ts");
      if (!target?.file) throw new Error("Expected the auth.ts discovery target");

      const packet = await getCodegraphPacketWithSession(session, { root, target: target.file });
      expect(packet.packet).toMatchObject({
        target: { kind: "file", file: "auth.ts" },
        symbols: expect.arrayContaining([expect.objectContaining({ name: "validateUser", exported: true })]),
      });

      const search = await searchCodegraphWithSession(session, { root, query: "validateUser", mode: "symbol" });
      expect(search.results).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "symbol", file: "auth.ts", label: "validateUser" })]),
      );
    } finally {
      session.invalidate();
    }
  });
});
