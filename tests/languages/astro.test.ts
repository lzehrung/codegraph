import path from "node:path";
import { expect, it } from "vitest";
import { collectGraph } from "../../src/index.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "astro",
  parity: {
    sampleDir: "astro",
    dependencyGraph: [
      {
        from: "page.astro",
        to: { type: "file", path: "Layout.astro" },
      },
      {
        from: "page.astro",
        to: { type: "file", path: "guide.md" },
      },
      {
        from: "page.astro",
        to: { type: "file", path: "inline.ts" },
      },
      {
        from: "page.astro",
        to: { type: "file", path: "docs/about.astro" },
      },
      {
        from: "page.astro",
        to: { type: "file", path: "util.ts" },
      },
    ],
    absentDependencyGraph: [
      {
        from: "page.astro",
        to: { type: "file", path: "util.astro" },
      },
    ],
    goToDefinition: [
      {
        name: "astro remains graph-only for go-to-definition",
        file: "page.astro",
        line: 7,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
    references: [
      {
        name: "astro remains graph-only for references",
        file: "page.astro",
        line: 7,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
  },
};

runLanguageTests(definition);

it("prioritizes script candidates for extensionless Astro frontmatter imports", async () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "astro");
  const pageFile = path.join(samplePath, "page.astro").replace(/\\/g, "/");
  const scriptFile = path.join(samplePath, "util.ts").replace(/\\/g, "/");
  const pageFileCandidate = path.join(samplePath, "util.astro").replace(/\\/g, "/");
  const graph = await collectGraph(samplePath, [pageFile, scriptFile, pageFileCandidate]);
  const utilEdges = graph.edges.filter((edge) => edge.from === pageFile && edge.raw === "./util");

  expect(utilEdges).toEqual([{ from: pageFile, to: { type: "file", path: scriptFile }, raw: "./util" }]);
});
