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
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "comment")).toBe(true);
        expect(chunks.some((c) => c.type === "rule")).toBe(true);
        expect(chunks.some((c) => c.type === "media")).toBe(true);
        expect(chunks.some((c) => c.type === "keyframes")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "css",
    dependencyGraph: [
      {
        from: "main.css",
        to: { type: "file", path: "base.css" },
      },
      {
        from: "main.css",
        to: { type: "file", path: "theme.css" },
      },
      {
        from: "main.css",
        to: { type: "file", path: "print.css" },
      },
      {
        from: "main.css",
        to: { type: "external", name: "cdn-bg" },
      },
      {
        from: "main.css",
        to: { type: "file", path: "tokens.css" },
      },
      {
        from: "main.css",
        to: { type: "file", path: "composed.css" },
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
