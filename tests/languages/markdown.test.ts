import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractMarkdownLinkOccurrences, extractMarkdownModuleSpecifiers } from "../../src/document-links/markdown.js";
import { collectGraph } from "../../src/index.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "markdown",
  parity: {
    sampleDir: "markdown",
    exact: {
      dependencyGraph: [
        {
          from: "index.md",
          to: { type: "external", name: "https://example.com/docs" },
        },
        {
          from: "index.md",
          to: { type: "file", path: "autolink.md" },
        },
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
    goToDefinition: [
      {
        name: "markdown remains graph-only for go-to-definition",
        file: "index.md",
        line: 3,
        column: 2,
        expectedStatus: "not_found",
      },
    ],
  },
};

runLanguageTests(definition);

const maskedMarkdown = [
  "---",
  "see: [Front](front-target.md)",
  "---",
  "<!-- [Commented](comment-target.md) -->",
  "[Guide](guide.md)",
  "[Reference][guide-ref]",
  "<./autolink.md>",
  '<a href="./raw.html">Raw HTML</a>',
  "- top",
  "    - nested [FourOnly](four-only.md)",
  "  - nested [TwoSpace](two-space.md)",
  "    [CodeOnly](code-only.md)",
  "![Missing][missing]",
  "",
  "[guide-ref]: ./guide.md",
  "[missing]: ./no-such.svg",
].join("\n");

describe("Markdown document-link masking", () => {
  it("masks comments, front matter, and indented code without shifting surviving coordinates", () => {
    expect(extractMarkdownModuleSpecifiers(maskedMarkdown).map((entry) => entry.spec)).toEqual([
      "./guide.md",
      "./four-only.md",
      "./two-space.md",
      "./autolink.md",
      "./raw.html",
    ]);

    expect(
      extractMarkdownLinkOccurrences(maskedMarkdown).map((occurrence) => ({
        raw: occurrence.raw,
        line: occurrence.range.start.line,
        column: occurrence.range.start.column,
      })),
    ).toEqual([
      { raw: "guide.md", line: 5, column: 9 },
      { raw: "./guide.md", line: 6, column: 1 },
      { raw: "four-only.md", line: 10, column: 25 },
      { raw: "two-space.md", line: 11, column: 23 },
      { raw: "./autolink.md", line: 7, column: 2 },
      { raw: "./raw.html", line: 8, column: 10 },
    ]);
  });

  it("keeps four-space numbered and star nested list links", () => {
    expect(
      extractMarkdownModuleSpecifiers(
        "- top\n    1. nested [Num](num-only.md)\n    1) nested [Paren](paren-only.md)\n    * nested [Star](star-only.md)\n",
      ).map((entry) => entry.spec),
    ).toEqual(["./num-only.md", "./paren-only.md", "./star-only.md"]);
  });

  it("masks a leading TOML front-matter block", () => {
    expect(
      extractMarkdownModuleSpecifiers(
        ["+++", 'see = "[Toml](toml-target.md)"', "+++", "[Keep](keep.md)"].join("\n"),
      ).map((entry) => entry.spec),
    ).toEqual(["./keep.md"]);
  });

  it("does not record a reference-style image as a link occurrence", () => {
    expect(extractMarkdownLinkOccurrences("![Missing][missing]\n\n[missing]: ./no-such.svg\n")).toEqual([]);
  });

  it("creates file edges for nested list links and not for comments or front matter", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-md-mask-"));
    const files = {
      index: path.join(root, "index.md"),
      guide: path.join(root, "guide.md"),
      fourOnly: path.join(root, "four-only.md"),
      twoSpace: path.join(root, "two-space.md"),
      autolink: path.join(root, "autolink.md"),
      raw: path.join(root, "raw.html"),
    };
    try {
      await writeFile(files.index, maskedMarkdown, "utf8");
      await writeFile(files.guide, "# Guide\n", "utf8");
      await writeFile(files.fourOnly, "# Four\n", "utf8");
      await writeFile(files.twoSpace, "# Two\n", "utf8");
      await writeFile(files.autolink, "# Auto\n", "utf8");
      await writeFile(files.raw, "<p>raw</p>\n", "utf8");

      const graph = await collectGraph(
        root,
        Object.values(files).map((file) => file.replace(/\\/g, "/")),
      );
      const edgeNames = graph.edges
        .filter((edge) => edge.from.replace(/\\/g, "/").endsWith("/index.md"))
        .map((edge) => (edge.to.type === "file" ? path.basename(edge.to.path) : edge.to.name))
        .sort();

      expect(edgeNames).toEqual(["autolink.md", "four-only.md", "guide.md", "raw.html", "two-space.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
