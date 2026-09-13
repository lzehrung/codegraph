import { describe, expect, it } from "vitest";
import { extractMdxModuleSpecifiers } from "../../src/document-links/markdown.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "mdx",
  parity: {
    sampleDir: "mdx",
    exact: {
      dependencyGraph: [
        {
          from: "page.mdx",
          to: { type: "external", name: "https://example.com/mdx" },
        },
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
          to: { type: "file", path: "raw.html" },
        },
        {
          from: "page.mdx",
          to: { type: "file", path: "reference.md" },
        },
        {
          from: "page.mdx",
          to: { type: "file", path: "summary.md" },
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
    goToDefinition: [
      {
        name: "mdx remains graph-only for go-to-definition",
        file: "page.mdx",
        line: 6,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
  },
};

runLanguageTests(definition);

describe("MDX document-link masking", () => {
  it("masks comments and front matter while keeping markdown and JS specifiers", () => {
    const source = [
      "---",
      "see: [Front](front-target.md)",
      "---",
      'import Card from "./components/Card.tsx";',
      "<!-- [Commented](comment-target.md) -->",
      "[Guide](guide.md)",
    ].join("\n");

    expect(extractMdxModuleSpecifiers(source)).toEqual([
      { spec: "./guide.md", raw: "guide.md", resolutionKind: "document" },
      { spec: "./components/Card.tsx", resolutionKind: "source" },
    ]);
  });
});
