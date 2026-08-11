import { expect, it } from "vitest";
import { collectModuleSpecifiersFromSource } from "../../src/graphs.js";
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
  const specifiers = collectModuleSpecifiersFromSource(support, undefined, '@import "./print.css" screen;', {
    native: "off",
  });

  expect(specifiers).toEqual([{ spec: "./print.css", resolutionKind: "stylesheet" }]);
});
