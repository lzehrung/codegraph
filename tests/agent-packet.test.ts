import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCodegraphPacket, orientCodegraph } from "../src/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("agent packet", () => {
  it("retrieves a file packet from an orientation handle", async () => {
    const root = await mkTmpDir("cg-agent-packet-");
    await writeFile(root, "src/run.ts", "export function run() { return 1; }\n");

    const orient = await orientCodegraph({ root, includeRoots: ["src"], budget: "small" });
    const fileHandle = orient.handles.find((handle) => handle.kind === "file");
    if (!fileHandle) {
      throw new Error("expected file handle");
    }

    const packet = await getCodegraphPacket({ root, handle: fileHandle.handle });

    expect(packet.schemaVersion).toBe(1);
    expect(packet.kind).toBe("file");
    expect(packet.followUps.length).toBeGreaterThan(0);
  });
});
