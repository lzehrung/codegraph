import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { collectGraph } from "../../src/index.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "astro",
  parity: {
    sampleDir: "astro",
    exact: {
      dependencyGraph: [
        {
          from: "page.astro",
          to: { type: "file", path: "docs/about.astro" },
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
          to: { type: "file", path: "Layout.astro" },
        },
        {
          from: "page.astro",
          to: { type: "file", path: "util.ts" },
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

it("extracts Astro scoped style imports and url references as document edges", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-astro-style-"));
  const pageFile = path.join(root, "page.astro");
  const themeFile = path.join(root, "theme.css");
  const backgroundFile = path.join(root, "bg.png");
  try {
    await fs.writeFile(
      pageFile,
      ["---", "---", "<style>", '  @import "./theme.css";', "  .hero { background: url(./bg.png); }", "</style>"].join(
        "\n",
      ),
      "utf8",
    );
    await fs.writeFile(themeFile, ".hero {}\n", "utf8");
    await fs.writeFile(backgroundFile, "", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedTheme = themeFile.replace(/\\/g, "/");
    const normalizedBackground = backgroundFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedTheme, normalizedBackground]);
    const edges = graph.edges.filter((edge) => edge.from === normalizedPage);

    expect(edges).toEqual([
      { from: normalizedPage, to: { type: "file", path: normalizedTheme }, raw: "./theme.css" },
      { from: normalizedPage, to: { type: "file", path: normalizedBackground }, raw: "./bg.png" },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
