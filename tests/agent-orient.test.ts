import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { orientCodegraph } from "../src/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("agent orient", () => {
  it("returns compact orientation with stable packet handles", async () => {
    const root = await mkTmpDir("cg-agent-orient-");
    await writeFile(root, "src/index.ts", "export { run } from './run';\n");
    await writeFile(root, "src/run.ts", "export function run() { return 1; }\n");

    const response = await orientCodegraph({ root, includeRoots: ["src"], budget: "small" });

    expect(response.schemaVersion).toBe(1);
    expect(response.summary.length).toBeGreaterThan(0);
    expect(response.tree.some((entry) => entry.path === "src/index.ts")).toBe(true);
    expect(response.handles.some((handle) => handle.handle.startsWith("file:"))).toBe(true);
    expect(response.recommendedNext.length).toBeGreaterThan(0);
  });
});
