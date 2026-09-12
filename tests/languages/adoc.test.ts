import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractAsciidocModuleSpecifiers } from "../../src/document-links/asciidoc.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "adoc",
  parity: {
    sampleDir: "adoc",
    exact: {
      dependencyGraph: [
        {
          from: "index.adoc",
          to: { type: "external", name: "https://example.com/adoc" },
        },
        {
          from: "index.adoc",
          to: { type: "file", path: "appendix.adoc" },
        },
        {
          from: "index.adoc",
          to: { type: "file", path: "guide.adoc" },
        },
        {
          from: "index.adoc",
          to: { type: "file", path: "partials/intro.adoc" },
        },
        {
          from: "index.adoc",
          to: { type: "file", path: "partials/live.adoc" },
        },
        {
          from: "index.adoc",
          to: { type: "file", path: "summary.adoc" },
        },
        {
          from: "index.asciidoc",
          to: { type: "file", path: "guide.asciidoc" },
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
  },
};

runLanguageTests(definition);

describe("AsciiDoc conditional includes", () => {
  it("does not extract includes inside ifdef, ifndef, or ifeval regions", () => {
    const source = [
      "include::partials/live.adoc[]",
      "ifdef::never[]",
      "include::partials/ignored.adoc[]",
      "endif::[]",
      "ifndef::always[]",
      "include::partials/ignored2.adoc[]",
      "endif::[]",
      "ifeval::[1 == 0]",
      "include::partials/ignored3.adoc[]",
      "endif::[]",
      "include::partials/intro.adoc[]",
    ].join("\n");

    expect(extractAsciidocModuleSpecifiers(source).map((entry) => entry.spec)).toEqual([
      "./partials/live.adoc",
      "./partials/intro.adoc",
    ]);
  });

  it("does not drop the rest of the file when a conditional is unterminated", () => {
    const source = [
      "include::partials/live.adoc[]",
      "ifdef::never[]",
      "include::partials/ignored.adoc[]",
      "include::partials/after.adoc[]",
    ].join("\n");

    expect(extractAsciidocModuleSpecifiers(source).map((entry) => entry.spec)).toEqual([
      "./partials/live.adoc",
      "./partials/ignored.adoc",
      "./partials/after.adoc",
    ]);
  });

  it("still extracts unconditional includes from the adoc sample", async () => {
    const source = await readFile(path.resolve("tests/samples/adoc/index.adoc"), "utf8");
    expect(extractAsciidocModuleSpecifiers(source).map((entry) => entry.spec)).toEqual([
      "./guide.adoc",
      "./summary.adoc",
      "https://example.com/adoc",
      "./partials/intro.adoc",
      "./partials/live.adoc",
      "./appendix.adoc",
    ]);
  });
});
