import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "html",
  samples: [
    {
      name: "chunks HTML structure",
      sourceFile: "html.sample.html",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "comment")).toBe(true);
        expect(chunks.some((c) => c.type === "element" && c.name === "app")).toBe(true);
        expect(chunks.some((c) => c.type === "script")).toBe(true);
        expect(chunks.some((c) => c.type === "style")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "html",
    dependencyGraph: [
      {
        from: "index.html",
        to: { type: "file", path: "styles.css" },
      },
      {
        from: "index.html",
        to: { type: "file", path: "app.js" },
      },
      {
        from: "index.html",
        to: { type: "file", path: "about.html" },
      },
      {
        from: "index.html",
        to: { type: "external", name: "logo.svg" },
      },
      {
        from: "index.html",
        to: { type: "file", path: "inline-helper.js" },
      },
      {
        from: "index.html",
        to: { type: "external", name: "cdn-logo@1x" },
      },
      {
        from: "index.html",
        to: { type: "external", name: "cdn-logo@2x" },
      },
      {
        from: "index.html",
        to: { type: "external", name: "cdn-intro" },
      },
      {
        from: "index.html",
        to: { type: "external", name: "https://example.com/embed" },
      },
      {
        from: "modules.html",
        to: { type: "file", path: "app.js" },
      },
      {
        from: "modules.html",
        to: { type: "file", path: "about.html" },
      },
      {
        from: "index.html",
        to: { type: "file", path: "theme.css" },
      },
    ],
    absentDependencyGraph: [
      {
        from: "index.html",
        to: { type: "file", path: "commented.js" },
      },
      {
        from: "index.html",
        to: { type: "file", path: "literal.html" },
      },
    ],
  },
};

runLanguageTests(definition);
