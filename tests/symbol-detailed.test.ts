import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, buildSymbolGraphDetailed } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

describe("Detailed symbol graph (uses edges)", () => {
  it("TypeScript: function uses imported symbol inside body", async () => {
    const root = await mkTmpDir("dg-ts-");
    const utils = `export function utilFn(): string { return 'x'; }\n`;
    const main = `import { utilFn } from './utils';\nexport function uses(): string {\n  return utilFn();\n}\n`;
    await fsp.writeFile(path.join(root, "utils.ts"), utils, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));

    const utilDef = nodes.find((n) => n.file.endsWith("/utils.ts") && n.name === "utilFn");
    const usesDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "uses");
    expect(utilDef).toBeDefined();
    expect(usesDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === usesDef!.id && e.to === utilDef!.id && e.label === "uses");
    expect(edge).toBeDefined();
  });

  it("Python: function uses imported symbol inside body", async () => {
    const root = await mkTmpDir("dg-py-");
    const util = `def helper():\n    return 1\n`;
    const main = `from . import util\n\ndef inner():\n    return util.helper()\n`;
    await fsp.writeFile(path.join(root, "__init__.py"), "", "utf8");
    await fsp.writeFile(path.join(root, "util.py"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.py"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));

    const helperDef = nodes.find((n) => n.file.endsWith("/util.py") && n.name === "helper");
    const innerDef = nodes.find((n) => n.file.endsWith("/main.py") && n.name === "inner");
    expect(helperDef).toBeDefined();
    expect(innerDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === innerDef!.id && e.to === helperDef!.id && e.label === "uses");
    expect(edge).toBeDefined();
  });

  it("TypeScript: follows re-exports to resolve uses", async () => {
    const root = await mkTmpDir("dg-ts-reexp-");
    const util = `export function coreUtil(): number { return 1 }
`;
    const reexp = `export { coreUtil as utilFn } from './util'
`;
    const main = `import { utilFn } from './reexp'
export function uses(): number { return utilFn() }
`;
    await fsp.writeFile(path.join(root, "util.ts"), util, "utf8");
    await fsp.writeFile(path.join(root, "reexp.ts"), reexp, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));

    const targetDef = nodes.find((n) => n.file.endsWith("/util.ts") && n.name === "coreUtil");
    const usesDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "uses");
    expect(targetDef).toBeDefined();
    expect(usesDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === usesDef!.id && e.to === targetDef!.id && e.label === "uses");
    expect(edge).toBeDefined();
  });

  it("TypeScript: namespace import member usage produces uses edge", async () => {
    const root = await mkTmpDir("dg-ts-ns-");
    const util = `export function helper(): string { return 'x' }
`;
    const main = `import * as U from './util'\nexport function uses(): string { return U.helper() }\n`;
    await fsp.writeFile(path.join(root, "util.ts"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));

    const helperDef = nodes.find((n) => n.file.endsWith("/util.ts") && n.name === "helper");
    const usesDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "uses");
    expect(helperDef).toBeDefined();
    expect(usesDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === usesDef!.id && e.to === helperDef!.id && e.label === "uses");
    expect(edge).toBeDefined();
  });

  it("TypeScript: arrow function assigned to var uses named import", async () => {
    const root = await mkTmpDir("dg-ts-arrow-");
    const util = `export function helper(): number { return 1 }\n`;
    const main = `import { helper } from './util'\nexport const uses = () => helper();\n`;
    await fsp.writeFile(path.join(root, "util.ts"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));

    const helperDef = nodes.find((n) => n.file.endsWith("/util.ts") && n.name === "helper");
    const usesDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "uses");
    expect(helperDef).toBeDefined();
    expect(usesDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === usesDef!.id && e.to === helperDef!.id && e.label === "uses");
    expect(edge).toBeDefined();
  });

  it("TypeScript: optional and computed member usages produce uses edges", async () => {
    const root = await mkTmpDir("dg-ts-opt-");
    const util = `export function a(){return 1}; export function b(){return 2};\n`;
    const main = `import * as U from './util'\nconst key = 'b'\nexport function uses(){ return (U?.a?.(), U[key]()) }\n`;
    await fsp.writeFile(path.join(root, "util.ts"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));

    const aDef = nodes.find((n) => n.file.endsWith("/util.ts") && n.name === "a");
    const bDef = nodes.find((n) => n.file.endsWith("/util.ts") && n.name === "b");
    const usesDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "uses");
    expect(aDef).toBeDefined();
    expect(bDef).toBeDefined();
    expect(usesDef).toBeDefined();

    const aEdge = sg.edges.find((e) => e.from === usesDef!.id && e.to === aDef!.id && e.label === "uses");
    const bEdge = sg.edges.find((e) => e.from === usesDef!.id && e.to === bDef!.id && e.label === "uses");
    expect(aEdge).toBeDefined();
    expect(bEdge).toBeDefined();
  });

  it("JavaScript (CJS): require default as namespace, member use produces uses edge", async () => {
    const root = await mkTmpDir("dg-js-cjs-");
    const util = `exports.helper = function(){ return 1 }\n`;
    const main = `const u = require('./util')\nexports.uses = function(){ return u.helper() }\n`;
    await fsp.writeFile(path.join(root, "util.js"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.js"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));

    const helperDef = nodes.find((n) => n.file.endsWith("/util.js") && n.name === "helper");
    const usesDef = nodes.find((n) => n.file.endsWith("/main.js") && n.name === "uses");
    expect(helperDef).toBeDefined();
    expect(usesDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === usesDef!.id && e.to === helperDef!.id && e.label === "uses");
    expect(edge).toBeDefined();
  });

  it("Python: decorator use produces decorates edge", async () => {
    const root = await mkTmpDir("dg-py-deco-");
    const util = `def deco(f):\n    def wrap(*a, **k):\n        return f(*a, **k)\n    return wrap\n`;
    const main = `from . import util\n\n@util.deco\ndef fn():\n    return 1\n`;
    await fsp.writeFile(path.join(root, "__init__.py"), "", "utf8");
    await fsp.writeFile(path.join(root, "util.py"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.py"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));

    const decoDef = nodes.find((n) => n.file.endsWith("/util.py") && n.name === "deco");
    const fnDef = nodes.find((n) => n.file.endsWith("/main.py") && n.name === "fn");
    expect(decoDef).toBeDefined();
    expect(fnDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === fnDef!.id && e.to === decoDef!.id && e.label === "decorates");
    expect(edge).toBeDefined();
  });

  it("JavaScript (CJS): module.exports object-literal function produces uses edge", async () => {
    const root = await mkTmpDir("dg-js-cjs-obj-");
    const util = `module.exports = { helper: function(){ return 1 } }\n`;
    const main = `const u = require('./util')\nexports.uses = function(){ return u.helper() }\n`;
    await fsp.writeFile(path.join(root, "util.js"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.js"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));

    const helperDef = nodes.find((n) => n.file.endsWith("/util.js") && n.name === "helper");
    const usesDef = nodes.find((n) => n.file.endsWith("/main.js") && n.name === "uses");
    expect(helperDef).toBeDefined();
    expect(usesDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === usesDef!.id && e.to === helperDef!.id && e.label === "uses");
    expect(edge).toBeDefined();
  });

  it("TypeScript: nested namespace chain usage produces uses edge", async () => {
    const root = await mkTmpDir("dg-ts-ns-nested-");
    const utilSub = `export function helper(){ return 1 }\n`;
    const util = `export * as sub from './utilSub'\n`;
    const main = `import * as U from './util'\nexport function uses(){ return U.sub.helper() }\n`;
    await fsp.writeFile(path.join(root, "utilSub.ts"), utilSub, "utf8");
    await fsp.writeFile(path.join(root, "util.ts"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));

    const helperDef = nodes.find((n) => n.file.endsWith("/utilSub.ts") && n.name === "helper");
    const usesDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "uses");
    expect(helperDef).toBeDefined();
    expect(usesDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === usesDef!.id && e.to === helperDef!.id && e.label === "uses");
    expect(edge).toBeDefined();
  });

  it("TypeScript: named import of namespace re-export resolves to downstream symbol", async () => {
    const root = await mkTmpDir("dg-ts-ns-named-");
    const utilSub = `export function helper(){ return 1 }\n`;
    const util = `export * as sub from './utilSub'\n`;
    const main = `import { sub } from './util'\nexport function uses(){ return sub.helper() }\n`;
    await fsp.writeFile(path.join(root, "utilSub.ts"), utilSub, "utf8");
    await fsp.writeFile(path.join(root, "util.ts"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));

    const helperDef = nodes.find((n) => n.file.endsWith("/utilSub.ts") && n.name === "helper");
    const usesDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "uses");
    const fakeNamespaceNode = nodes.find((n) => n.file.endsWith("/utilSub.ts") && n.name === "sub");
    expect(helperDef).toBeDefined();
    expect(usesDef).toBeDefined();
    expect(fakeNamespaceNode).toBeUndefined();

    const edge = sg.edges.find((e) => e.from === usesDef!.id && e.to === helperDef!.id && e.label === "uses");
    expect(edge).toBeDefined();
  });
});
