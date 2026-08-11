import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "adoc",
  parity: {
    sampleDir: "adoc",
    dependencyGraph: [
      {
        from: "index.adoc",
        to: { type: "file", path: "guide.adoc" },
      },
      {
        from: "index.adoc",
        to: { type: "file", path: "summary.adoc" },
      },
      {
        from: "index.adoc",
        to: { type: "file", path: "partials/intro.adoc" },
      },
      {
        from: "index.adoc",
        to: { type: "file", path: "appendix.adoc" },
      },
      {
        from: "index.adoc",
        to: { type: "external", name: "https://example.com/adoc" },
      },
      {
        from: "index.asciidoc",
        to: { type: "file", path: "guide.asciidoc" },
      },
      {
        from: "index.adoc",
        to: { type: "file", path: "partials/live.adoc" },
      },
    ],
    absentDependencyGraph: [
      {
        from: "index.adoc",
        to: { type: "file", path: "partials/ignored.adoc" },
      },
    ],
    goToDefinition: [
      {
        name: "asciidoc remains graph-only for go-to-definition",
        file: "index.adoc",
        line: 3,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
    references: [
      {
        name: "asciidoc remains graph-only for references",
        file: "index.adoc",
        line: 3,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
  },
};

runLanguageTests(definition);
