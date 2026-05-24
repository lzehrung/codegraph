import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { collectGraph } from "../src/index.js";
import { mkTmpDir, normalizeTestPath } from "./helpers/filesystem.js";

describe("Dynamic resolution heuristics", () => {
  it("resolves path.join(__dirname, ...) when enabled", async () => {
    const root = await mkTmpDir("dg-dynamic-join-");
    const mainPath = path.join(root, "main.js");
    const utilPath = path.join(root, "utils.js");
    const source = `
      const path = require("path");
      const utils = require(path.join(__dirname, "utils"));
      module.exports = utils;
    `;
    await fsp.writeFile(mainPath, source, "utf8");
    await fsp.writeFile(utilPath, "module.exports = {};", "utf8");

    const graph = await collectGraph(root, [normalizeTestPath(mainPath), normalizeTestPath(utilPath)], {
      dynamicImportHeuristics: true,
    });

    const hasEdge = graph.edges.some(
      (edge) =>
        edge.from.endsWith("/main.js") &&
        edge.to.type === "file" &&
        edge.to.path.endsWith("/utils.js") &&
        edge.resolved === "heuristic" &&
        edge.confidence === 0.7,
    );
    expect(hasEdge).toBe(true);
  });

  it("resolves bare specifiers using resolution hints", async () => {
    const root = await mkTmpDir("dg-resolution-hints-");
    const mainPath = path.join(root, "src", "main.ts");
    const buttonPath = path.join(root, "src", "components", "button.ts");
    await fsp.mkdir(path.dirname(buttonPath), { recursive: true });
    await fsp.writeFile(mainPath, `import Button from "components/button";\nconsole.log(Button);\n`, "utf8");
    await fsp.writeFile(buttonPath, "export default function Button() {}", "utf8");

    const graph = await collectGraph(root, [normalizeTestPath(mainPath), normalizeTestPath(buttonPath)], {
      resolutionHints: ["src"],
    });

    const hasEdge = graph.edges.some(
      (edge) =>
        edge.raw === "components/button" &&
        edge.to.type === "file" &&
        edge.to.path.endsWith("/src/components/button.ts"),
    );
    expect(hasEdge).toBe(true);
  });
});
