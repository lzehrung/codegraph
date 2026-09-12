import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { expect, it } from "vitest";
import { collectGraph, collectModuleSpecifiersFromSource } from "../../src/graphs.js";
import { supportById } from "../../src/languages.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "css",
  samples: [
    {
      name: "chunks CSS rules",
      sourceFile: "css.sample.css",
      exactChunks: [
        { type: "comment", startLine: 1, endLine: 1 },
        { type: "misc", startLine: 1, endLine: 3 },
        { type: "rule", startLine: 4, endLine: 8 },
        { type: "rule", startLine: 9, endLine: 13 },
        { type: "media", startLine: 14, endLine: 18 },
        { type: "rule", startLine: 15, endLine: 17 },
        { type: "misc", startLine: 18, endLine: 19 },
        { type: "keyframes", startLine: 20, endLine: 27 },
      ],
    },
  ],
  parity: {
    sampleDir: "css",
    exact: {
      dependencyGraph: [
        {
          from: "main.css",
          to: { type: "external", name: "./missing.css" },
        },
        {
          from: "main.css",
          to: { type: "external", name: "cdn-bg" },
        },
        {
          from: "main.css",
          to: { type: "file", path: "base.css" },
        },
        {
          from: "main.css",
          to: { type: "file", path: "composed.css" },
        },
        {
          from: "main.css",
          to: { type: "file", path: "print.css" },
        },
        {
          from: "main.css",
          to: { type: "file", path: "theme.css" },
        },
        {
          from: "main.css",
          to: { type: "file", path: "tokens.css" },
        },
      ],
      references: [
        {
          name: "find references is not available",
          file: "base.css",
          line: 1,
          column: 2,
          expectedStatus: "not_found",
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition is not available",
        file: "base.css",
        line: 1,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
    absentDependencyGraph: [
      {
        from: "main.css",
        to: { type: "file", path: "theme.ts" },
      },
    ],
  },
};

runLanguageTests(definition);

it("recovers media-qualified CSS imports in reduced mode", () => {
  const support = supportById("css")!;
  const specifiers = collectModuleSpecifiersFromSource(support, '@import "./print.css" screen;', {
    native: "off",
  });

  expect(specifiers).toEqual([{ spec: "./print.css", resolutionKind: "stylesheet" }]);
});

it("resolves bare stylesheet imports relative to their importing file", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-css-bare-import-"));
  const mainFile = path.join(root, "main.css").replace(/\\/g, "/");
  const themeFile = path.join(root, "theme.css").replace(/\\/g, "/");
  await Promise.all([
    fsp.writeFile(mainFile, '@import "theme.css";\n', "utf8"),
    fsp.writeFile(themeFile, ".theme {}\n", "utf8"),
  ]);
  try {
    const graph = await collectGraph(root, [mainFile, themeFile]);
    expect(
      graph.edges.some((edge) => edge.from === mainFile && edge.to.type === "file" && edge.to.path === themeFile),
    ).toBe(true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
