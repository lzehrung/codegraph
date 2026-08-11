import { describe, expect, it } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { collectGraph } from "../src/index.js";
import { extractJsTsSpecifiers } from "../src/util/specifiers.js";
import { resolveFromNodeModules } from "../src/util/resolution/node.js";
import { resolveSpecifier } from "../src/util/resolution.js";
import { mkTmpDir, normalizeTestPath } from "./helpers/filesystem.js";

describe("node package-exports resolution", () => {
  it("tags require() extractors with the require export condition", () => {
    const specs = extractJsTsSpecifiers(`
      import esm from "dual-pkg";
      const cjs = require("dual-pkg");
      const { named } = require("dual-pkg");
      import req = require("dual-pkg");
      void import("dual-pkg");
    `);
    const byForm = specs.filter((entry) => entry.spec === "dual-pkg");
    expect(byForm.some((entry) => entry.exportCondition === "require")).toBe(true);
    expect(byForm.some((entry) => entry.exportCondition !== "require")).toBe(true);
    expect(byForm.filter((entry) => entry.exportCondition === "require")).toHaveLength(3);
  });

  it("resolves require() to the require target and import to the import target", async () => {
    const root = await mkTmpDir("dg-nm-dual-");
    const nm = path.join(root, "node_modules", "dual-pkg");
    const importFile = path.join(root, "esm-consumer.mjs");
    const requireFile = path.join(root, "cjs-consumer.cjs");
    await fsp.mkdir(nm, { recursive: true });
    await fsp.writeFile(path.join(nm, "esm.mjs"), "export const value = 1;\n", "utf8");
    await fsp.writeFile(path.join(nm, "cjs.cjs"), "module.exports = { value: 2 };\n", "utf8");
    await fsp.writeFile(
      path.join(nm, "package.json"),
      JSON.stringify(
        {
          name: "dual-pkg",
          exports: {
            ".": {
              require: "./cjs.cjs",
              import: "./esm.mjs",
              default: "./default.js",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(importFile, 'import "dual-pkg";\n', "utf8");
    await fsp.writeFile(requireFile, 'require("dual-pkg");\n', "utf8");

    await expect(resolveFromNodeModules("dual-pkg", importFile, root, undefined, "import")).resolves.toBe(
      path.join(nm, "esm.mjs").replace(/\\/g, "/"),
    );
    await expect(resolveFromNodeModules("dual-pkg", requireFile, root, undefined, "require")).resolves.toBe(
      path.join(nm, "cjs.cjs").replace(/\\/g, "/"),
    );

    await expect(
      resolveSpecifier(importFile, "dual-pkg", root, undefined, undefined, {
        resolveNodeModules: true,
        exportCondition: "import",
      }),
    ).resolves.toBe(path.join(nm, "esm.mjs").replace(/\\/g, "/"));
    await expect(
      resolveSpecifier(requireFile, "dual-pkg", root, undefined, undefined, {
        resolveNodeModules: true,
        exportCondition: "require",
      }),
    ).resolves.toBe(path.join(nm, "cjs.cjs").replace(/\\/g, "/"));

    const graph = await collectGraph(root, [importFile, requireFile].map(normalizeTestPath), {
      resolveNodeModules: true,
    });
    expect(
      graph.edges.some(
        (edge) =>
          edge.from.replace(/\\/g, "/").endsWith("/esm-consumer.mjs") &&
          edge.to.type === "file" &&
          edge.to.path.replace(/\\/g, "/").endsWith("/node_modules/dual-pkg/esm.mjs"),
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from.replace(/\\/g, "/").endsWith("/cjs-consumer.cjs") &&
          edge.to.type === "file" &&
          edge.to.path.replace(/\\/g, "/").endsWith("/node_modules/dual-pkg/cjs.cjs"),
      ),
    ).toBe(true);
  });

  it("honors author key order for node vs import", async () => {
    const root = await mkTmpDir("dg-nm-order-");
    const nm = path.join(root, "node_modules", "ordered-pkg");
    const sourceFile = path.join(root, "main.mjs");
    await fsp.mkdir(nm, { recursive: true });
    await fsp.writeFile(path.join(nm, "node.js"), "export const kind = 'node';\n", "utf8");
    await fsp.writeFile(path.join(nm, "import.js"), "export const kind = 'import';\n", "utf8");
    await fsp.writeFile(sourceFile, 'import "ordered-pkg";\n', "utf8");
    await fsp.writeFile(
      path.join(nm, "package.json"),
      JSON.stringify(
        {
          name: "ordered-pkg",
          exports: {
            ".": {
              node: "./node.js",
              import: "./import.js",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(resolveFromNodeModules("ordered-pkg", sourceFile, root)).resolves.toBe(
      path.join(nm, "node.js").replace(/\\/g, "/"),
    );

    await fsp.writeFile(
      path.join(nm, "package.json"),
      JSON.stringify(
        {
          name: "ordered-pkg",
          exports: {
            ".": {
              import: "./import.js",
              node: "./node.js",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await expect(resolveFromNodeModules("ordered-pkg", sourceFile, root)).resolves.toBe(
      path.join(nm, "import.js").replace(/\\/g, "/"),
    );
  });
});
