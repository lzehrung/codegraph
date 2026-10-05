import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { collectGraph } from "../src/index.js";
import { extractDynamicImportSpecifiers } from "../src/util/specifiers.js";
import { mkTmpDir, normalizeTestPath, readOnlySamplePath } from "./helpers/filesystem.js";
import { edgeFrom } from "./helpers/graph.js";

describe("Native graph edge cases", () => {
  it("keeps both a runtime and a type-only edge to the same target (C3)", async () => {
    const root = await mkTmpDir("dg-typeonly-both-");
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

  it("ignores commented-out imports", async () => {
    const root = await mkTmpDir("dg-comments-");
    const commented = `// import x from './x'\n/* import y from './y' */\n/*\nimport z from './z'\n*/\n`;
    const file = path.join(root, "commented.ts");
    await fsp.writeFile(file, commented, "utf8");
    const graph = await collectGraph(root, [normalizeTestPath(file)]);
    expect(graph.edges.filter(edgeFrom(file))).toHaveLength(0);
  });

  it("marks inline-only named type imports as typeOnly and mixed clauses as runtime", async () => {
    const rootDir = await mkTmpDir("dg-inline-type-");
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

    const graph = await collectGraph(rootDir, files);
    const mainPath = normalizeTestPath(path.join(rootDir, "main.ts"));
    const typeOnlyOf = (fileName: string) => {
      const target = normalizeTestPath(path.join(rootDir, fileName));
      const edges = graph.edges.filter(
        (edge) => edge.from === mainPath && edge.to.type === "file" && edge.to.path === target,
      );
      return edges.map((edge) => Boolean(edge.typeOnly));
    };
    expect(typeOnlyOf("util.ts").sort()).toEqual([false, true]);
    expect(typeOnlyOf("all.ts")).toEqual([true]);
    expect(typeOnlyOf("side.ts")).toEqual([false]);
    expect(typeOnlyOf("empty.ts")).toEqual([false]);
    expect(typeOnlyOf("exp-only.ts")).toEqual([true]);
    expect(typeOnlyOf("exp-mixed.ts")).toEqual([false]);
    expect(typeOnlyOf("exp-stmt.ts")).toEqual([true]);
  });

  it("resolves multiline TypeScript imports", async () => {
    const root = await mkTmpDir("dg-multiline-import-");
    const entry = normalizeTestPath(path.join(root, "entry.ts"));
    const target = normalizeTestPath(path.join(root, "dep.ts"));
    await fsp.writeFile(entry, "import {\n  value\n} from './dep';\nconsole.log(value);\n", "utf8");
    await fsp.writeFile(target, "export const value = 42;\n", "utf8");
    const graph = await collectGraph(root, [entry, target]);
    expect(graph.edges.some((edge) => edge.from === entry && edge.to.type === "file" && edge.to.path === target)).toBe(
      true,
    );
  });

  it("ignores require() and import() inside strings and templates", async () => {
    const root = await mkTmpDir("dg-string-imports-");
    const file = normalizeTestPath(path.join(root, "entry.ts"));
    await fsp.writeFile(file, "const a = 'require(\"x\")';\nconst b = `import('y')`;\n", "utf8");
    const graph = await collectGraph(root, [file]);
    expect(graph.edges.filter(edgeFrom(file))).toHaveLength(0);
  });

  it("resolves CommonJS named destructuring with an alias", async () => {
    const root = await mkTmpDir("dg-cjs-import-");
    const dependency = normalizeTestPath(path.join(root, "a.js"));
    const main = normalizeTestPath(path.join(root, "main.js"));
    await fsp.writeFile(dependency, "exports.helper = () => 1;\n", "utf8");
    await fsp.writeFile(main, "const { helper: h } = require('./a');\n", "utf8");
    const graph = await collectGraph(root, [main, dependency]);
    expect(
      graph.edges.some(
        (edge) => edge.from === main && edge.raw === "./a" && edge.to.type === "file" && edge.to.path === dependency,
      ),
    ).toBe(true);
  });

  it("resolves dynamic import edges", async () => {
    const root = await mkTmpDir("dg-dynamic-import-");
    const dependency = normalizeTestPath(path.join(root, "a.js"));
    const main = normalizeTestPath(path.join(root, "main.js"));
    await fsp.writeFile(dependency, "export const x = 1;\n", "utf8");
    await fsp.writeFile(main, "async function run() { await import('./a.js'); }\n", "utf8");
    const graph = await collectGraph(root, [main, dependency]);
    expect(
      graph.edges.some(
        (edge) => edge.from === main && edge.raw === "./a.js" && edge.to.type === "file" && edge.to.path === dependency,
      ),
    ).toBe(true);
  });

  it("resolves workspace package imports", async () => {
    const root = readOnlySamplePath("monorepo");
    const files = [
      normalizeTestPath(path.join(root, "packages", "pkg-a", "src", "index.ts")),
      normalizeTestPath(path.join(root, "packages", "pkg-b", "src", "index.js")),
    ];
    const graph = await collectGraph(root, files);
    expect(graph.edges.some((edge) => edge.raw === "@acme/pkg-a" && edge.to.type === "file")).toBe(true);
  });
});

describe("Dynamic import heuristics across languages", () => {
  const projectRoot = path.join(process.cwd(), "fixture-root");

  it("folds Ruby require File.join(__dir__, ...) to a file-relative specifier", () => {
    const fromFile = path.join(projectRoot, "app", "models", "user.rb");
    const source = [
      'require File.join(__dir__, "lib", "user_repo")',
      "require File.join(File.dirname(__FILE__), 'unrelated')",
    ].join("\n");

    const specs = extractDynamicImportSpecifiers("ruby", source, fromFile, projectRoot);

    expect(specs).toEqual([{ spec: "./lib/user_repo", resolved: "heuristic", confidence: 0.7 }]);
  });

  it("ignores Ruby requires whose path needs runtime evaluation or a comment hides", () => {
    const fromFile = path.join(projectRoot, "app", "models", "user.rb");
    const source = [
      'require File.join(dir, "user_repo")',
      "require File.join(__dir__, name)",
      'require "user_repo"',
      '# require File.join(__dir__, "commented")',
      'require File.join(__dir__, "user_repo")',
    ].join("\n");

    const specs = extractDynamicImportSpecifiers("ruby", source, fromFile, projectRoot);

    expect(specs).toEqual([{ spec: "./user_repo", resolved: "heuristic", confidence: 0.7 }]);
  });

  it("folds PHP computed include and require chains rooted at __DIR__ or dirname(__FILE__)", () => {
    const fromFile = path.join(projectRoot, "public", "index.php");
    const source = [
      "require __DIR__ . '/config/database.php';",
      "include(dirname(__FILE__) . '/partials/menu.php');",
      "require_once __DIR__.'/boot.php';",
      "include_once __DIR__ . '/legacy/menu.php';",
    ].join("\n");

    const specs = extractDynamicImportSpecifiers("php", source, fromFile, projectRoot);

    expect(specs).toEqual([
      { spec: "./config/database.php", resolved: "heuristic", confidence: 0.7 },
      { spec: "./partials/menu.php", resolved: "heuristic", confidence: 0.7 },
      { spec: "./boot.php", resolved: "heuristic", confidence: 0.7 },
      { spec: "./legacy/menu.php", resolved: "heuristic", confidence: 0.7 },
    ]);
  });

  it("ignores PHP includes whose path needs runtime evaluation or stays static", () => {
    const fromFile = path.join(projectRoot, "public", "index.php");
    const source = [
      "require $module . '/routes.php';",
      "include 'partials/footer.php';",
      "require dirname(__FILE__) . '/' . $page . '.php';",
      "// require __DIR__ . '/commented.php';",
      "require __DIR__ . '/actual.php';",
    ].join("\n");

    const specs = extractDynamicImportSpecifiers("php", source, fromFile, projectRoot);

    expect(specs).toEqual([{ spec: "./actual.php", resolved: "heuristic", confidence: 0.7 }]);
  });
});
