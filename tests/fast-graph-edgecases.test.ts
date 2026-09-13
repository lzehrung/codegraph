import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { collectGraph } from "../src/index.js";
import { mkTmpDir, normalizeTestPath } from "./helpers/filesystem.js";
import { edgeFrom } from "./helpers/graph.js";

describe("Fast graph edge cases", () => {
  it("detects type-only import with typeOnly=true (TS)", async () => {
    const root = await mkTmpDir("dg-fast-typeonly-");
    const util = `export type T = { n: number };\nexport function f(){ return 1 }\n`;
    const main = `import type { T } from './util';\nimport { f } from './util';\nconst x: T = { n: f() };\n`;
    const utilPath = path.join(root, "util.ts");
    const mainPath = path.join(root, "main.ts");
    await fsp.writeFile(utilPath, util, "utf8");
    await fsp.writeFile(mainPath, main, "utf8");
    const files = [normalizeTestPath(mainPath), normalizeTestPath(utilPath)];

    const gNormal = await collectGraph(root, files);
    const gFast = await (await import("../src/graphs.js")).collectGraph(root, files, { fast: true });

    const fromMainNormal = gNormal.edges.filter(edgeFrom(mainPath));
    const fromMainFast = gFast.edges.filter(edgeFrom(mainPath));
    // At least one edge from main.ts should be marked typeOnly in both modes
    expect(fromMainNormal.some((e) => e.typeOnly === true)).toBe(true);
    expect(fromMainFast.some((e) => e.typeOnly === true)).toBe(true);
  });

  it("keeps both a runtime and a type-only edge to the same target (C3)", async () => {
    const root = await mkTmpDir("dg-fast-typeonly-both-");
    const util = `export type T = { n: number };\nexport function f(){ return 1 }\n`;
    const main = `import type { T } from './util';\nimport { f } from './util';\nconst x: T = { n: f() };\n`;
    const utilPath = path.join(root, "util.ts");
    const mainPath = path.join(root, "main.ts");
    await fsp.writeFile(utilPath, util, "utf8");
    await fsp.writeFile(mainPath, main, "utf8");
    const files = [normalizeTestPath(mainPath), normalizeTestPath(utilPath)];

    const graph = await collectGraph(root, files);
    const toUtil = graph.edges
      .filter(edgeFrom(mainPath))
      .filter((edge) => edge.to.type === "file" && edge.to.path === normalizeTestPath(utilPath));

    // A separate runtime import (`{ f }`) and type-only import (`type { T }`) to the same
    // target module must both survive dedup, not collapse onto one entry.
    expect(toUtil).toHaveLength(2);
    expect(toUtil.some((edge) => edge.typeOnly)).toBe(true);
    expect(toUtil.some((edge) => !edge.typeOnly)).toBe(true);
  });

  it("ignores commented-out imports in fast mode", async () => {
    const root = await mkTmpDir("dg-fast-comments-");
    const commented = `// import x from './x'\n/* import y from './y' */\n/*\nimport z from './z'\n*/\n`;
    const file = path.join(root, "commented.ts");
    await fsp.writeFile(file, commented, "utf8");
    const gFast = await (
      await import("../src/graphs.js")
    ).collectGraph(root, [file.replace(/\\/g, "/")], { fast: true });
    const edgesFrom = gFast.edges.filter(edgeFrom(file));
    expect(edgesFrom.length).toBe(0);
  });

  it("marks inline-only named type imports as typeOnly and mixed clauses as runtime", async () => {
    const rootDir = await mkTmpDir("dg-fast-inline-type-");
    const util = "export type T = { n: number };\nexport const v = 1;\n";
    const main = [
      'import { /* erased */ type T } from "./util";',
      'import { type T as Only, v } from "./util";',
      'import { type T as AllA, type T as AllB } from "./all";',
      'import "./side";',
      'import {} from "./empty";',
      'export{type T}from"./exp-only";',
      'export { type T, v as vv } from "./exp-mixed";',
      'export type { T as Whole } from "./exp-stmt";',
      'import type from "./side";',
    ].join("\n");
    await fsp.writeFile(path.join(rootDir, "util.ts"), util, "utf8");
    await fsp.writeFile(path.join(rootDir, "all.ts"), "export type T = number;\n", "utf8");
    await fsp.writeFile(path.join(rootDir, "side.ts"), "export const s = 1;\n", "utf8");
    await fsp.writeFile(path.join(rootDir, "empty.ts"), "export const e = 1;\n", "utf8");
    await fsp.writeFile(path.join(rootDir, "exp-only.ts"), "export type T = number;\n", "utf8");
    await fsp.writeFile(path.join(rootDir, "exp-mixed.ts"), "export type T = number;\nexport const v = 1;\n", "utf8");
    await fsp.writeFile(path.join(rootDir, "exp-stmt.ts"), "export type T = number;\n", "utf8");
    await fsp.writeFile(path.join(rootDir, "main.ts"), main, "utf8");
    const files = [
      "main.ts",
      "util.ts",
      "all.ts",
      "side.ts",
      "empty.ts",
      "exp-only.ts",
      "exp-mixed.ts",
      "exp-stmt.ts",
    ].map((fileName) => path.join(rootDir, fileName).replace(/\\/g, "/"));

    const graphs = [
      await collectGraph(rootDir, files),
      await (await import("../src/graphs.js")).collectGraph(rootDir, files, { fast: true }),
      await collectGraph(rootDir, files, { native: "off" }),
    ];
    const mainPath = path.join(rootDir, "main.ts").replace(/\\/g, "/");
    const typeOnlyOf = (graph: Awaited<ReturnType<typeof collectGraph>>, fileName: string) => {
      const target = path.join(rootDir, fileName).replace(/\\/g, "/");
      const edges = graph.edges.filter(
        (edge) => edge.from === mainPath && edge.to.type === "file" && edge.to.path === target,
      );
      return edges.map((edge) => Boolean(edge.typeOnly));
    };
    for (const graph of graphs) {
      expect(typeOnlyOf(graph, "util.ts").sort()).toEqual([false, true].sort());
      expect(typeOnlyOf(graph, "all.ts")).toEqual([true]);
      expect(typeOnlyOf(graph, "side.ts")).toEqual([false]);
      expect(typeOnlyOf(graph, "empty.ts")).toEqual([false]);
      expect(typeOnlyOf(graph, "exp-only.ts")).toEqual([true]);
      expect(typeOnlyOf(graph, "exp-mixed.ts")).toEqual([false]);
      expect(typeOnlyOf(graph, "exp-stmt.ts")).toEqual([true]);
    }
  });
});
