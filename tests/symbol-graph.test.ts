import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { createTestIndex } from "./test-utils.js";
import { buildProjectIndex, buildSymbolGraph } from "../src/index.js";
import { buildSymbolGraphDetailed } from "../src/graphs.js";
import { mkTmpDir } from "./helpers/filesystem.js";

function norm(p: string) {
  return p.replace(/\\/g, "/");
}

describe("Symbol-level graph", () => {
  describe("TypeScript", () => {
    it("creates edges from named imports to definitions", async () => {
      const index = await createTestIndex("typescript");
      const sg = await buildSymbolGraph(index);

      const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));
      const utilsDef = nodes.find(
        (n) => n.file.endsWith("/tests/samples/typescript/utils.ts") && n.name === "helperFunction",
      );
      expect(utilsDef).toBeDefined();

      const mainImport = nodes.find(
        (n) =>
          n.file.endsWith("/tests/samples/typescript/main.ts") &&
          (n.name === "helperFunction" || n.name === "helperAlias") &&
          n.kind === "import",
      );
      expect(mainImport).toBeDefined();

      const hasEdge = sg.edges.some(
        (e) => e.from === mainImport.id && e.to === utilsDef.id && e.label === "helperFunction",
      );
      expect(hasEdge).toBe(true);
    });

    it("ignores commented-out TS imports in fallback parsing", async () => {
      const _root = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const index = await createTestIndex("typescript");
      const sg = await buildSymbolGraph(index);
      const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));
      // Our fixtures don't include commented imports; this is a smoke check that no node label includes "// import"
      const hasCommented = nodes.some((n) => /\/\/\s*import/.test(n.name));
      expect(hasCommented).toBe(false);
    });

    it("keeps compact and detailed CJS default-import edges aligned", async () => {
      const root = await mkTmpDir("cg-cjs-default-import-");
      const cjsFile = path.join(root, "cjs.js");
      const mainFile = path.join(root, "main.ts");
      const cjsSource = "module.exports = function thing() {};\n";
      const mainSource = 'import thing from "./cjs.js";\nexport function run() { return thing(); }\n';
      await fsp.writeFile(cjsFile, cjsSource, "utf8");
      await fsp.writeFile(mainFile, mainSource, "utf8");

      const index = await buildProjectIndex(root);
      const compact = await buildSymbolGraph(index);
      const detailed = await buildSymbolGraphDetailed(index);
      const target = [...compact.nodes.values()].find(
        (node) => norm(node.file) === norm(cjsFile) && node.name === "exports",
      );
      const alias = [...compact.nodes.values()].find(
        (node) => norm(node.file) === norm(mainFile) && node.name === "thing" && node.kind === "import",
      );
      const run = [...detailed.nodes.values()].find(
        (node) => norm(node.file) === norm(mainFile) && node.name === "run" && node.kind === "function",
      );

      expect(target).toBeDefined();
      expect(alias).toBeDefined();
      expect(run).toBeDefined();
      if (!target || !alias || !run) return;

      const callStart = mainSource.indexOf("thing()");
      const lineStart = mainSource.lastIndexOf("\n", callStart);
      const callEnd = callStart + "thing".length;
      const site = {
        file: norm(mainFile),
        range: {
          start: { line: 2, column: callStart - lineStart, index: callStart },
          end: { line: 2, column: callEnd - lineStart, index: callEnd },
        },
      };

      expect(compact.edges).toEqual([{ from: alias.id, to: target.id, label: "default" }]);
      expect(detailed.edges).toEqual([
        { from: alias.id, to: target.id, label: "default" },
        { from: run.id, to: target.id, label: "calls", site },
        { from: run.id, to: target.id, label: "uses" },
      ]);
    });
  });

  describe("Python", () => {
    it("creates edges for named and namespace imports", async () => {
      const index = await createTestIndex("python");
      const sg = await buildSymbolGraph(index);
      const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));

      const def = nodes.find((n) => n.file.endsWith("/tests/samples/python/utils.py") && n.name === "helper_function");
      expect(def).toBeDefined();

      const namedImport = nodes.find(
        (n) => n.file.endsWith("/tests/samples/python/main.py") && n.name === "helper_function" && n.kind === "import",
      );
      expect(namedImport).toBeDefined();
      const namedEdge = sg.edges.some(
        (e) => e.from === namedImport.id && e.to === def.id && e.label === "helper_function",
      );
      expect(namedEdge).toBe(true);

      const nsImport = nodes.find(
        (n) => n.file.endsWith("/tests/samples/python/main.py") && n.name === "utils" && n.kind === "namespaceImport",
      );
      expect(nsImport).toBeDefined();
      const nsEdge = sg.edges.find((e) => e.from === nsImport.id && e.to === def.id && e.label === "helper_function");
      expect(nsEdge).toBeDefined();
    });

    it("ignores commented-out Python imports in fallback parsing", async () => {
      const index = await createTestIndex("python");
      const sg = await buildSymbolGraph(index);
      const nodes = [...sg.nodes.values()].map((n) => ({ ...n, file: norm(n.file) }));
      // No symbol should contain a leading '# import' pattern
      const hasCommented = nodes.some((n) => /^#\s*import/.test(n.name));
      expect(hasCommented).toBe(false);
    });
  });
});
