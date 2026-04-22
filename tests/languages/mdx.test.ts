import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "mdx",
  parity: {
    sampleDir: "mdx",
    dependencyGraph: [
      {
        from: "page.mdx",
        to: { type: "file", path: "components/Card.tsx" },
      },
      {
        from: "page.mdx",
        to: { type: "file", path: "guide.md" },
      },
      {
        from: "page.mdx",
        to: { type: "file", path: "summary.md" },
      },
      {
        from: "page.mdx",
        to: { type: "file", path: "reference.md" },
      },
      {
        from: "page.mdx",
        to: { type: "file", path: "raw.html" },
      },
      {
        from: "page.mdx",
        to: { type: "external", name: "https://example.com/mdx" },
      },
    ],
    goToDefinition: [
      {
        name: "mdx remains graph-only for go-to-definition",
        file: "page.mdx",
        line: 6,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
    references: [
      {
        name: "mdx remains graph-only for references",
        file: "page.mdx",
        line: 6,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
  },
};

runLanguageTests(definition);
