import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "rst",
  parity: {
    sampleDir: "rst",
    dependencyGraph: [
      {
        from: "index.rst",
        to: { type: "file", path: "guide.rst" },
      },
      {
        from: "index.rst",
        to: { type: "file", path: "summary.rst" },
      },
      {
        from: "index.rst",
        to: { type: "file", path: "includes/intro.rst" },
      },
      {
        from: "index.rst",
        to: { type: "file", path: "api.rst" },
      },
      {
        from: "index.rst",
        to: { type: "external", name: "https://example.com/rst" },
      },
      {
        from: "index.rst",
        to: { type: "file", path: "reference.rst" },
      },
    ],
    goToDefinition: [
      {
        name: "rst remains graph-only for go-to-definition",
        file: "index.rst",
        line: 4,
        column: 3,
        expectedStatus: "not_found",
      },
    ],
    references: [
      {
        name: "rst remains graph-only for references",
        file: "index.rst",
        line: 4,
        column: 3,
        expectedStatus: "not_found",
      },
    ],
  },
};

runLanguageTests(definition);
