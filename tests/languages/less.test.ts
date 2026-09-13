import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { expect, it } from "vitest";
import { collectGraph, collectModuleSpecifiersFromSource } from "../../src/graphs.js";
import { supportById } from "../../src/languages.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "less",
  samples: [
    {
      name: "chunks LESS structures",
      sourceFile: "less.sample.less",
      exactChunks: [
        { type: "comment", startLine: 1, endLine: 1 },
        { type: "misc", startLine: 1, endLine: 5 },
        { type: "rule", startLine: 6, endLine: 12 },
        { type: "rule", startLine: 9, endLine: 11 },
        { type: "misc", startLine: 12, endLine: 12 },
      ],
    },
  ],
  parity: {
    sampleDir: "less",
    exact: {
      dependencyGraph: [
        {
          from: "main.less",
          to: { type: "external", name: "./missing.less" },
        },
        {
          from: "main.less",
          to: { type: "external", name: "cdn-noise" },
        },
        {
          from: "main.less",
          to: { type: "file", path: "css-mode.less" },
        },
        {
          from: "main.less",
          to: { type: "file", path: "reference.less" },
        },
        {
          from: "main.less",
          to: { type: "file", path: "theme.less" },
        },
        {
          from: "main.less",
          to: { type: "file", path: "variables.less" },
        },
        {
          from: "secondary.less",
          to: { type: "file", path: "theme.less" },
        },
        {
          from: "secondary.less",
          to: { type: "file", path: "variables.less" },
        },
      ],
      references: [
        {
          name: "find references is not available",
          file: "variables.less",
          line: 3,
          column: 2,
          expectedStatus: "not_found",
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition is not available",
        file: "variables.less",
        line: 3,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
    absentDependencyGraph: [
      {
        from: "main.less",
        to: { type: "file", path: "theme.ts" },
      },
    ],
  },
};

runLanguageTests(definition);

it("recovers Less option imports in reduced mode", () => {
  const support = supportById("less")!;
  const specifiers = collectModuleSpecifiersFromSource(
    support,
    '@import (reference) "./reference";\n@import (css) "./css-mode";',
    { native: "off" },
  );

  expect(specifiers).toEqual([
    { spec: "./reference", resolutionKind: "stylesheet" },
    { spec: "./css-mode", resolutionKind: "stylesheet" },
  ]);
});

it("resolves bare Less imports relative to their importing file", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-less-bare-import-"));
  const mainFile = path.join(root, "main.less").replace(/\\/g, "/");
  const themeFile = path.join(root, "theme.less").replace(/\\/g, "/");
  await Promise.all([
    fsp.writeFile(mainFile, '@import "theme";\n', "utf8"),
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
