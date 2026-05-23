import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { collectGraph } from "../src/index.js";
import { mkTmpDir, normalizeTestPath } from "./helpers/filesystem.js";
import { graphEdgeKey } from "./helpers/graph.js";

describe("Robust fast graph (strings/templates, dynamic import, CJS)", () => {
  it("ignores require inside string literal", async () => {
    const root = await mkTmpDir("dg-fast-strings-");
    const file = path.join(root, "a.ts");
    await fsp.writeFile(file, `const s = 'require("x")';\n`, "utf8");
    const g = await (await import("../src/graphs.js")).collectGraph(root, [normalizeTestPath(file)], { fast: true });
    expect(g.edges.length).toBe(0);
  });

  it("ignores import() inside template literal", async () => {
    const root = await mkTmpDir("dg-fast-templates-");
    const file = path.join(root, "a.ts");
    await fsp.writeFile(file, "const s = `import('x')`\n", "utf8");
    const g = await (await import("../src/graphs.js")).collectGraph(root, [normalizeTestPath(file)], { fast: true });
    expect(g.edges.length).toBe(0);
  });

  it("detects dynamic import edges", async () => {
    const root = await mkTmpDir("dg-dynamic-import-");
    const a = path.join(root, "a.js");
    const main = path.join(root, "main.js");
    await fsp.writeFile(a, "export const x = 1;\n", "utf8");
    await fsp.writeFile(main, "async function run(){ await import('./a.js'); }\n", "utf8");
    const files = [main, a].map(normalizeTestPath);
    const g = await collectGraph(root, files);
    const keys = new Set(g.edges.map(graphEdgeKey));
    expect([...keys].some((k) => k.includes("main.js") && k.includes("./a.js"))).toBe(true);
  });

  it("detects CommonJS named destructuring with alias", async () => {
    const root = await mkTmpDir("dg-cjs-destr-");
    const a = path.join(root, "a.js");
    const main = path.join(root, "main.js");
    await fsp.writeFile(a, "exports.helper = () => 1;\n", "utf8");
    await fsp.writeFile(main, "const { helper: h } = require('./a');\n", "utf8");
    const files = [main, a].map(normalizeTestPath);
    const g = await collectGraph(root, files);
    const keys = new Set(g.edges.map(graphEdgeKey));
    expect([...keys].some((k) => k.includes("main.js") && k.includes("./a"))).toBe(true);
  });
});
