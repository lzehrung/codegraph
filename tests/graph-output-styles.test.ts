import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { collectGraph, graphToMermaid, graphToDOT } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Graph output styles", () => {
  it("Mermaid uses dotted arrows for type-only edges; DOT uses style=dotted", async () => {
    const root = await mkTmpDir("dg-styles-");
    const util = path.join(root, "util.ts");
    const main = path.join(root, "main.ts");
    await fsp.writeFile(util, "export type T = { n: number };\nexport const f = () => 1;\n", "utf8");
    await fsp.writeFile(
      main,
      'import type { T } from "./util";\nimport { f } from "./util";\nconst x: T = { n: f() };\n',
      "utf8",
    );
    const files = [util, main].map((f) => f.replace(/\\/g, "/"));
    const g = await collectGraph(root, files);
    const mer = graphToMermaid(g);
    const dot = graphToDOT(g);
    expect(mer.includes("-.->")).toBe(true);
    expect(dot.includes("style=dotted")).toBe(true);
  });
});
