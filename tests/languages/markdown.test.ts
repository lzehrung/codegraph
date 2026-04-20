import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "markdown",
  parity: {
    sampleDir: "markdown",
    dependencyGraph: [
      {
        from: "index.md",
        to: { type: "file", path: "guide.md" },
      },
      {
        from: "index.md",
        to: { type: "file", path: "guides/deep.md" },
      },
      {
        from: "index.md",
        to: { type: "file", path: "raw.html" },
      },
      {
        from: "index.md",
        to: { type: "file", path: "autolink.md" },
      },
      {
        from: "index.md",
        to: { type: "external", name: "https://example.com/docs" },
      },
    ],
    goToDefinition: [
      {
        name: "markdown remains graph-only for go-to-definition",
        file: "index.md",
        line: 3,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
    references: [
      {
        name: "markdown remains graph-only for references",
        file: "index.md",
        line: 3,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
  },
};

runLanguageTests(definition);
