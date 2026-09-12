import { describe, expect, it } from "vitest";
import { HTML_SUPPORT } from "../../src/languages.js";
import { runQuery } from "@lzehrung/codegraph-native";
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
      references: [
        {
          name: "find references is not available",
          file: "index.html",
          line: 9,
          column: 14,
          expectedStatus: "not_found",
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition is not available",
        file: "index.html",
        line: 9,
        column: 14,
        expectedStatus: "not_found",
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

describe("HTML asset tag filtering", () => {
  it("restricts href to link and anchor tags and src to script and img tags", () => {
    const source = [
      '<div href="div.html"></div>',
      '<p src="paragraph.js"></p>',
      '<a href="anchor.html"></a>',
      '<link href="style.css">',
      '<img src="image.png">',
      '<video src="video.mp4"></video>',
      '<script src="app.js"></script>',
    ].join("\n");

    const captured = runQuery(source, "html", HTML_SUPPORT.queries.imports)
      .matches.flatMap((match) => match.captures.filter((capture) => capture.name === "mod").map((c) => c.text))
      .sort();

    // The tag predicates used to sit outside their patterns, so every element with an `href` or
    // `src` attribute was captured. The graph's own asset walker still reports media sources; this
    // asserts the query, which is what the predicates constrain.
    expect(captured).toEqual(["anchor.html", "app.js", "image.png", "style.css"]);
  });
});
