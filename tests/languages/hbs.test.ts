import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "hbs",
  parity: {
    sampleDir: "hbs",
    dependencyGraph: [
      {
        from: "page.hbs",
        to: { type: "file", path: "guide.adoc" },
      },
      {
        from: "page.hbs",
        to: { type: "file", path: "partials/card.hbs" },
      },
      {
        from: "page.hbs",
        to: { type: "external", name: "https://example.com/hbs" },
      },
      {
        from: "page.handlebars",
        to: { type: "file", path: "guide.asciidoc" },
      },
      {
        from: "page.handlebars",
        to: { type: "file", path: "partials/card.handlebars" },
      },
    ],
    goToDefinition: [
      {
        name: "handlebars remains graph-only for go-to-definition",
        file: "page.hbs",
        line: 1,
        column: 11,
        expectedStatus: "not_found",
      },
    ],
    references: [
      {
        name: "handlebars remains graph-only for references",
        file: "page.hbs",
        line: 1,
        column: 11,
        expectedStatus: "not_found",
      },
    ],
  },
};

runLanguageTests(definition);
