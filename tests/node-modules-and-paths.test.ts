import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { collectGraph } from "../src/index.js";
import { resolveFromNodeModules } from "../src/util/resolution/node.js";
import { mkTmpDir, normalizeTestPath } from "./helpers/filesystem.js";

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
