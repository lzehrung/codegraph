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
      exactChunks: [
        { type: "comment", startLine: 1, endLine: 1 },
        { type: "misc", startLine: 1, endLine: 5 },
        { type: "mixin", startLine: 6, endLine: 12 },
        { type: "rule", startLine: 13, endLine: 20 },
        { type: "rule", startLine: 17, endLine: 19 },
        { type: "misc", startLine: 20, endLine: 21 },
        { type: "function", startLine: 22, endLine: 24 },
      ],
    },
  ],
  parity: {
    sampleDir: "scss",
    exact: {
      dependencyGraph: [
        {
          from: "extensionless-forward.scss",
          to: { type: "file", path: "_tokens.scss" },
        },
        {
          from: "extensionless-import.scss",
          to: { type: "file", path: "_tokens.scss" },
        },
        {
          from: "forward.scss",
          to: { type: "file", path: "_mixins.scss" },
        },
        {
          from: "forward.scss",
          to: { type: "file", path: "_variables.scss" },
        },
        {
          from: "main.scss",
          to: { type: "external", name: "./icons" },
        },
        {
          from: "main.scss",
          to: { type: "external", name: "./missing" },
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
          to: { type: "file", path: "_variables.scss" },
        },
        {
          from: "main.scss",
          to: { type: "file", path: "theme.scss" },
        },
        {
          from: "uppercase-extension-import.scss",
          to: { type: "file", path: "_tokens.scss" },
        },
        {
          from: "use-partials.scss",
          to: { type: "external", name: "cdn-texture" },
        },
        {
          from: "use-partials.scss",
          to: { type: "file", path: "_mixins.scss" },
        },
        {
          from: "use-partials.scss",
          to: { type: "file", path: "_variables.scss" },
        },
      ],
    },
    absentDependencyGraph: [
      {
        from: "extensionless-forward.scss",
        to: { type: "file", path: "_tokens.ts" },
      },
      {
        from: "extensionless-import.scss",
        to: { type: "file", path: "_tokens.ts" },
      },
      {
        from: "main.scss",
        to: { type: "file", path: "_icons.scss" },
      },
      {
        from: "main.scss",
        to: { type: "file", path: "_tokens.ts" },
      },
      {
        from: "main.scss",
        to: { type: "file", path: "theme.ts" },
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
