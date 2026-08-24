import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, goToDefinition } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function edgeSet(g: any): Set<string> {
  const toStr = (t: any) => (t.type === "file" ? t.path : t.name);
  return new Set(g.edges.map((e: any) => `${e.from}|${toStr(e.to)}|${e.raw}`));
}

describe("Threads parity and parsed-tree reuse", () => {
  it("collectGraph produces identical edges regardless of threads", async () => {
    const root = await mkTmpDir("dg-threads-");
    const a = path.join(root, "a.ts");
    const b = path.join(root, "b.ts");
    await fsp.writeFile(a, "export const n = 1;\n", "utf8");
    await fsp.writeFile(b, 'import { n } from "./a";\n', "utf8");
    const files = [a, b].map((f) => f.replace(/\\/g, "/"));
    const g1 = await (await import("../src/graphs.js")).collectGraph(root, files, { threads: 1 });
    const g2 = await (await import("../src/graphs.js")).collectGraph(root, files, { threads: 8 });
    expect(edgeSet(g2)).toEqual(edgeSet(g1));
  });

  it("navigation results are identical across runs (parsed-tree reuse)", async () => {
    const root = await mkTmpDir("dg-parsed-reuse-");
    const utils = path.join(root, "utils.ts");
    const main = path.join(root, "main.ts");
    await fsp.writeFile(utils, "export function f(){ return 1 }\n", "utf8");
    await fsp.writeFile(main, 'import { f } from "./utils";\nconst x = f();\n', "utf8");
    const index1 = await buildProjectIndex(root);
    const res1 = await goToDefinition(index1, { file: main.replace(/\\/g, "/"), line: 2, column: 12 });
    const index2 = await buildProjectIndex(root);
    const res2 = await goToDefinition(index2, { file: main.replace(/\\/g, "/"), line: 2, column: 12 });
    expect(res1).toEqual(res2);
  });
});
