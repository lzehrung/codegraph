import { expect, it } from "vitest";
import { collectModuleSpecifiersFromSource } from "../../src/graphs.js";
import { supportById } from "../../src/languages.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "less",
  samples: [
    {
      name: "chunks LESS structures",
      sourceFile: "less.sample.less",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "comment")).toBe(true);
        expect(chunks.some((c) => c.type === "rule")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "less",
    dependencyGraph: [
      {
        from: "main.less",
        to: { type: "file", path: "variables.less" },
      },
      {
        from: "main.less",
        to: { type: "file", path: "theme.less" },
      },
      {
        from: "main.less",
        to: { type: "file", path: "reference.less" },
      },
      {
        from: "main.less",
        to: { type: "file", path: "css-mode.less" },
      },
      {
        from: "main.less",
        to: { type: "external", name: "cdn-noise" },
      },
      {
        from: "secondary.less",
        to: { type: "file", path: "variables.less" },
      },
      {
        from: "secondary.less",
        to: { type: "file", path: "theme.less" },
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
    undefined,
    '@import (reference) "./reference";\n@import (css) "./css-mode";',
    { native: "off" },
  );

  expect(specifiers).toEqual([
    { spec: "./reference", resolutionKind: "stylesheet" },
    { spec: "./css-mode", resolutionKind: "stylesheet" },
  ]);
});
