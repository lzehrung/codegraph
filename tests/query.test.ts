import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, buildSymbolGraphDetailed, parseSymbolQuery, querySymbols, querySymbolNeighbors } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

const normalizePath = (p: string): string => p.replace(/\\/g, "/");

describe("Agent query helpers", () => {
  it("parses and filters symbols by docstring and kind", async () => {
    const root = await mkTmpDir("dg-query-");
    const main = `/// Adds two numbers\nexport function add(a: number, b: number) { return a + b; }\nexport function call() { return add(1, 2); }\n`;
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const query = parseSymbolQuery('kind:function doc:"Adds two"');
    const result = querySymbols(sg, query);
    const names = result.map((n) => n.name);
    expect(names).toContain("add");
    expect(names).not.toContain("call");
  });

  it("returns neighbor symbols for calls edges", async () => {
    const root = await mkTmpDir("dg-query-neighbor-");
    const main = `export function add() { return 1; }\nexport function call() { return add(); }\n`;
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));
    const addDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "add");
    const callDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "call");
    expect(addDef).toBeDefined();
    expect(callDef).toBeDefined();

    const neighbors = querySymbolNeighbors(sg, {
      symbolId: callDef?.id ?? "",
      edgeLabels: ["calls"],
      direction: "out",
    });
    const neighborNames = neighbors.nodes.map((n) => n.name);
    expect(neighborNames).toContain("add");
  });
});
