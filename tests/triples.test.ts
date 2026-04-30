import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, buildSymbolGraphDetailed, graphToTriples } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

const normalizePath = (p: string): string => p.replace(/\\/g, "/");

describe("Graph triple export", () => {
  it("exports file and symbol triples with predicates", async () => {
    const root = await mkTmpDir("dg-triples-");
    const util = `export function helper(): number { return 1; }\n`;
    const main = `import { helper } from "./util";\nexport function uses(): number { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "util.ts"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const triples = graphToTriples(index.graph, sg);

    const mainPath = normalizePath(path.join(root, "main.ts"));
    const utilPath = normalizePath(path.join(root, "util.ts"));
    const fileTriple = triples.find(
      (t) =>
        t.predicate === "imports" &&
        t.subject.type === "file" &&
        t.subject.path === mainPath &&
        t.object.type === "file" &&
        t.object.path === utilPath,
    );
    expect(fileTriple).toBeDefined();

    const callTriple = triples.find(
      (t) =>
        t.predicate === "calls" &&
        t.subject.type === "symbol" &&
        t.subject.name === "uses" &&
        t.object.type === "symbol" &&
        t.object.name === "helper",
    );
    expect(callTriple).toBeDefined();
  });
});
