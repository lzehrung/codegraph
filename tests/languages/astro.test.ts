import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "astro",
  parity: {
    sampleDir: "astro",
    dependencyGraph: [
      {
        from: "page.astro",
        to: { type: "file", path: "Layout.astro" },
      },
      {
        from: "page.astro",
        to: { type: "file", path: "guide.md" },
      },
      {
        from: "page.astro",
        to: { type: "file", path: "inline.ts" },
      },
      {
        from: "page.astro",
        to: { type: "file", path: "docs/about.astro" },
      },
    ],
    goToDefinition: [
      {
        name: "astro remains graph-only for go-to-definition",
        file: "page.astro",
        line: 6,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
    references: [
      {
        name: "astro remains graph-only for references",
        file: "page.astro",
        line: 6,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
  },
};

runLanguageTests(definition);
