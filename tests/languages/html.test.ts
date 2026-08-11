import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "html",
  samples: [
    {
      name: "chunks HTML structure",
      sourceFile: "html.sample.html",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 7 },
        { type: "script", startLine: 7, endLine: 7 },
        { type: "misc", startLine: 7, endLine: 10 },
        { type: "comment", startLine: 10, endLine: 11 },
        { type: "element", name: "app", startLine: 11, endLine: 16 },
        { type: "script", startLine: 16, endLine: 20 },
        { type: "style", startLine: 20, endLine: 24 },
        { type: "misc", startLine: 24, endLine: 26 },
      ],
    },
  ],
  parity: {
    sampleDir: "html",
    exact: {
      dependencyGraph: [
        {
          from: "index.html",
          to: { type: "external", name: "./missing.js" },
        },
        {
          from: "index.html",
          to: { type: "external", name: "cdn-intro" },
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
          to: { type: "external", name: "https://example.com/embed" },
        },
        {
          from: "index.html",
          to: { type: "external", name: "logo.svg" },
        },
        {
          from: "index.html",
          to: { type: "file", path: "about.html" },
        },
        {
          from: "index.html",
          to: { type: "file", path: "app.js" },
        },
        {
          from: "index.html",
          to: { type: "file", path: "inline-helper.js" },
        },
        {
          from: "index.html",
          to: { type: "file", path: "styles.css" },
        },
        {
          from: "index.html",
          to: { type: "file", path: "theme.css" },
        },
        {
          from: "modules.html",
          to: { type: "file", path: "about.html" },
        },
        {
          from: "modules.html",
          to: { type: "file", path: "app.js" },
        },
      ],
    },
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
