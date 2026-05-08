import path from "node:path";
import { expect, it } from "vitest";
import { collectGraph } from "../../src/index.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "scss",
  samples: [
    {
      name: "chunks SCSS structures",
      sourceFile: "scss.sample.scss",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "comment")).toBe(true);
        expect(chunks.some((c) => c.type === "rule")).toBe(true);
        expect(chunks.some((c) => c.type === "mixin")).toBe(true);
        expect(chunks.some((c) => c.type === "function")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "scss",
    dependencyGraph: [
      {
        from: "main.scss",
        to: { type: "file", path: "_variables.scss" },
      },
      {
        from: "main.scss",
        to: { type: "file", path: "_mixins.scss" },
      },
      {
        from: "main.scss",
        to: { type: "file", path: "_tokens.scss" },
      },
      {
        from: "main.scss",
        to: { type: "external", name: "./missing" },
      },
      {
        from: "use-partials.scss",
        to: { type: "file", path: "_variables.scss" },
      },
      {
        from: "use-partials.scss",
        to: { type: "file", path: "_mixins.scss" },
      },
      {
        from: "use-partials.scss",
        to: { type: "external", name: "cdn-texture" },
      },
      {
        from: "forward.scss",
        to: { type: "file", path: "_variables.scss" },
      },
      {
        from: "forward.scss",
        to: { type: "file", path: "_mixins.scss" },
      },
    ],
  },
};

runLanguageTests(definition);

it("does not resolve stylesheet url assets as Sass partials", async () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "scss");
  const mainFile = path.join(samplePath, "main.scss").replace(/\\/g, "/");
  const partialFile = path.join(samplePath, "_icons.scss").replace(/\\/g, "/");
  const graph = await collectGraph(samplePath, [mainFile, partialFile]);

  expect(
    graph.edges.some((edge) => edge.from === mainFile && edge.to.type === "file" && edge.to.path === partialFile),
  ).toBe(false);
  expect(
    graph.edges.some((edge) => edge.from === mainFile && edge.to.type === "external" && edge.to.name === "./icons"),
  ).toBe(true);
});

it("prefers SCSS partials over non-stylesheet files with the same partial basename", async () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "scss");
  const mainFile = path.join(samplePath, "main.scss").replace(/\\/g, "/");
  const scssPartialFile = path.join(samplePath, "_tokens.scss").replace(/\\/g, "/");
  const tsPartialFile = path.join(samplePath, "_tokens.ts").replace(/\\/g, "/");
  const graph = await collectGraph(samplePath, [mainFile, scssPartialFile, tsPartialFile]);

  expect(
    graph.edges.some((edge) => edge.from === mainFile && edge.to.type === "file" && edge.to.path === scssPartialFile),
  ).toBe(true);
  expect(
    graph.edges.some((edge) => edge.from === mainFile && edge.to.type === "file" && edge.to.path === tsPartialFile),
  ).toBe(false);
});
