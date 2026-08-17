import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { buildProjectIndex, buildProjectIndexIncremental, type BuildReport } from "../src/index.js";
import { resolveFromNodeModules } from "../src/util/resolution/node.js";
import { collectGraph } from "../src/index.js";
import { mkTmpDir, normalizeTestPath } from "./helpers/filesystem.js";
import { fileIdentityKey } from "../src/util/paths.js";

describe("Node modules resolution (opt-in) and path normalization", () => {
  it("treats packages as external by default; resolves to file with flag", async () => {
    const root = await mkTmpDir("dg-nm-");
    const nm = path.join(root, "node_modules", "my-pkg");
    await fsp.mkdir(nm, { recursive: true });
    await fsp.writeFile(path.join(nm, "index.js"), "module.exports = 1;\n", "utf8");
    await fsp.writeFile(path.join(nm, "package.json"), '{"name":"my-pkg","main":"index.js"}', "utf8");
    const main = path.join(root, "main.js");
    await fsp.writeFile(main, 'import "my-pkg";\n', "utf8");
    const files = [main].map(normalizeTestPath);
    const g1 = await collectGraph(root, files);
    expect(g1.edges.some((e) => e.raw === "my-pkg" && e.to.type === "external")).toBe(true);
    const g2 = await (await import("../src/graphs.js")).collectGraph(root, files, { resolveNodeModules: true });
    expect(
      g2.edges.some(
        (e) =>
          e.raw === "my-pkg" &&
          e.to.type === "file" &&
          e.to.path.replace(/\\/g, "/").endsWith("/node_modules/my-pkg/index.js"),
      ),
    ).toBe(true);
  });

  it("resolves package exports maps with condition fallback", async () => {
    const root = await mkTmpDir("dg-nm-exports-");
    const nm = path.join(root, "node_modules", "my-pkg");
    const sourceFile = path.join(root, "src", "main.ts");
    await fsp.mkdir(path.dirname(sourceFile), { recursive: true });
    await fsp.mkdir(nm, { recursive: true });
    await fsp.writeFile(sourceFile, 'import "my-pkg";\nimport "my-pkg/feature";\n', "utf8");
    await fsp.writeFile(path.join(nm, "esm.js"), "export const value = 1;\n", "utf8");
    await fsp.writeFile(path.join(nm, "feature.cjs"), "module.exports = 2;\n", "utf8");
    await fsp.writeFile(path.join(nm, "feature.mjs"), "export const value = 2;\n", "utf8");
    await fsp.writeFile(
      path.join(nm, "package.json"),
      JSON.stringify(
        {
          name: "my-pkg",
          exports: {
            ".": {
              require: "./cjs.cjs",
              import: "./esm.js",
            },
            "./feature": {
              import: "./feature.mjs",
              require: "./feature.cjs",
              module: "./feature.module.js",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(resolveFromNodeModules("my-pkg", sourceFile, root)).resolves.toBe(
      path.join(nm, "esm.js").replace(/\\/g, "/"),
    );
    await expect(resolveFromNodeModules("my-pkg/feature", sourceFile, root)).resolves.toBe(
      path.join(nm, "feature.mjs").replace(/\\/g, "/"),
    );
  });

  it("refreshes cached node-module edges when package targets change", async () => {
    const root = await mkTmpDir("dg-nm-incremental-");
    const nm = path.join(root, "node_modules", "my-pkg");
    const main = path.join(root, "main.js");
    await fsp.mkdir(nm, { recursive: true });
    await fsp.writeFile(main, 'import "my-pkg";\n', "utf8");
    await fsp.writeFile(path.join(nm, "first.js"), "module.exports = 1;\n", "utf8");
    await fsp.writeFile(path.join(nm, "second.js"), "module.exports = 2;\n", "utf8");
    const packagePath = path.join(nm, "package.json");
    await fsp.writeFile(packagePath, JSON.stringify({ name: "my-pkg", main: "first.js" }), "utf8");

    const first = await buildProjectIndex(root, {
      cache: "disk",
      graph: { resolveNodeModules: true },
      threads: 1,
    });
    expect(first.graph.edges.some((edge) => edge.to.type === "file" && edge.to.path.endsWith("/first.js"))).toBe(true);

    await fsp.writeFile(packagePath, JSON.stringify({ name: "my-pkg", main: "second.js" }), "utf8");
    const report: BuildReport = { timings: {} };
    const second = await buildProjectIndexIncremental(root, {
      cache: "disk",
      graph: { resolveNodeModules: true },
      threads: 1,
      report,
    });
    expect(second.graph.edges.map((edge) => (edge.to.type === "file" ? edge.to.path : edge.to.name))).toEqual([
      expect.stringContaining("second.js"),
    ]);
    expect(second.graph.edges.some((edge) => edge.to.type === "file" && edge.to.path.endsWith("/first.js"))).toBe(
      false,
    );
  });

  it("does not reuse a stale per-file module cache entry when resolveNodeModules turns on for a warm non-incremental build", async () => {
    const root = await mkTmpDir("dg-nm-warm-toggle-");
    const nm = path.join(root, "node_modules", "my-pkg");
    const main = path.join(root, "main.js");
    await fsp.mkdir(nm, { recursive: true });
    await fsp.writeFile(main, 'import { thing } from "my-pkg";\nexport const used = thing;\n', "utf8");
    await fsp.writeFile(path.join(nm, "index.js"), "module.exports = 1;\n", "utf8");
    await fsp.writeFile(path.join(nm, "package.json"), JSON.stringify({ name: "my-pkg", main: "index.js" }), "utf8");

    const cold = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const coldModule = cold.byFile.get(fileIdentityKey(main));
    const coldResolved = coldModule?.imports[0]?.resolved;
    expect(typeof coldResolved === "string" && coldResolved.includes("node_modules")).toBe(false);

    const warm = await buildProjectIndex(root, {
      cache: "disk",
      graph: { resolveNodeModules: true },
      threads: 1,
    });
    const warmModule = warm.byFile.get(fileIdentityKey(main));
    const warmResolved = warmModule?.imports[0]?.resolved;
    expect(
      typeof warmResolved === "string" && warmResolved.replace(/\\/g, "/").includes("node_modules/my-pkg/index.js"),
    ).toBe(true);
  });
  it("normalizes paths to forward slashes in nodes and edges", async () => {
    const root = await mkTmpDir("dg-paths-");
    const a = path.join(root, "a.ts");
    const b = path.join(root, "b.ts");
    await fsp.writeFile(a, "export const x = 1;\n", "utf8");
    await fsp.writeFile(b, 'import { x } from "./a";\n', "utf8");
    const files = [a, b].map((f) => f.replace(/\\/g, "/"));
    const g = await collectGraph(root, files);
    expect([...g.nodes].every((n) => !/\\/.test(n))).toBe(true);
    expect(g.edges.every((e) => !/\\/.test(e.from) && (e.to.type === "external" || !/\\/.test(e.to.path)))).toBe(true);
  });
});
