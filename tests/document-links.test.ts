import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractAstroModuleSpecifiers,
  extractHandlebarsModuleSpecifiers,
  extractHtmlAttributeSpecifiers,
  extractHtmlInlineScriptSpecifiers,
  extractHtmlStyleSpecifiers,
} from "../src/document-links.js";
import { collectGraph } from "../src/index.js";
import { extractAsciidocModuleSpecifiers } from "../src/document-links/asciidoc.js";
import {
  DOCUMENT_HTML_FORMS,
  SHARED_HTML_TAG_ATTRS,
  type DocumentHtmlFormId,
} from "../src/document-links/html-forms.js";
import {
  extractMarkdownLinkOccurrences,
  extractMarkdownModuleSpecifiers,
  extractMdxModuleSpecifiers,
} from "../src/document-links/markdown.js";
import { extractRstModuleSpecifiers } from "../src/document-links/rst.js";

describe("document link graph extraction", () => {
  it("ignores hash-only anchors and markdown image links", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "markdown");
    const indexFile = path.join(root, "index.md").replace(/\\/g, "/");
    const guideFile = path.join(root, "guide.md").replace(/\\/g, "/");
    const imageFile = path.join(root, "images", "diagram.svg").replace(/\\/g, "/");
    const imageSpecifier = "./images/diagram.svg";
    const graph = await collectGraph(root, [indexFile, guideFile]);

    expect(
      graph.edges.some(
        (edge) => edge.from === indexFile && edge.to.type === "external" && edge.to.name === "#local-section",
      ),
    ).toBe(false);

    expect(
      graph.edges.some((edge) => edge.from === indexFile && edge.to.type === "file" && edge.to.path === imageFile),
    ).toBe(false);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === indexFile &&
          edge.to.type === "external" &&
          (edge.to.name === imageSpecifier || edge.raw === imageSpecifier),
      ),
    ).toBe(false);
  });

  it("deduplicates identical markdown and raw HTML document targets", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-"));
    const indexFile = path.join(root, "index.md");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(
      indexFile,
      ["[Guide](./guide.md)", '<a href="./guide.md">Guide</a>', "[Guide Again](./guide.md)"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const graph = await collectGraph(root, [indexFile.replace(/\\/g, "/"), guideFile.replace(/\\/g, "/")]);

    const edges = graph.edges.filter(
      (edge) =>
        edge.from === indexFile.replace(/\\/g, "/") &&
        edge.to.type === "file" &&
        edge.to.path === guideFile.replace(/\\/g, "/"),
    );

    expect(edges).toHaveLength(1);
  });

  it("uses the first definition for duplicate Markdown reference labels", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-first-reference-"));
    const indexFile = path.join(root, "index.md");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(indexFile, "[Guide][guide]\n\n[guide]: ./guide.md\n[guide]: ./missing.md\n", "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedIndex, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
  });

  it("ignores dynamic handlebars path expressions", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "hbs");
    const pageFile = path.join(root, "page.hbs").replace(/\\/g, "/");
    const guideFile = path.join(root, "guide.adoc").replace(/\\/g, "/");
    const partialFile = path.join(root, "partials", "card.hbs").replace(/\\/g, "/");
    const graph = await collectGraph(root, [pageFile, guideFile, partialFile]);

    expect(
      graph.edges.some(
        (edge) => edge.from === pageFile && edge.to.type === "external" && edge.to.name.includes("dynamicPath"),
      ),
    ).toBe(false);
  });

  it("resolves markdown destinations containing parentheses", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-"));
    const indexFile = path.join(root, "index.md");
    const guideFile = path.join(root, "guide(v2).md");

    await fsp.writeFile(indexFile, "[Guide](./guide(v2).md)\n", "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const graph = await collectGraph(root, [indexFile.replace(/\\/g, "/"), guideFile.replace(/\\/g, "/")]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === indexFile.replace(/\\/g, "/") &&
          edge.to.type === "file" &&
          edge.to.path === guideFile.replace(/\\/g, "/"),
      ),
    ).toBe(true);
  });

  it("handles unmatched markdown labels without rescanning the rest of the document", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-unmatched-"));
    const indexFile = path.join(root, "index.md");
    const guideFile = path.join(root, "guide.md");
    const unmatchedLabels = "[".repeat(5000);

    await fsp.writeFile(indexFile, `${unmatchedLabels}\n[Guide](./guide.md)\n`, "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedIndex, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
  });

  it("handles same-line stale markdown labels before valid links", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-stale-same-line-"));
    const indexFile = path.join(root, "index.md");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(
      indexFile,
      "[broken [Guide](./guide.md)\n[broken [Guide][guide]\n\n[guide]: ./guide.md\n",
      "utf8",
    );
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedIndex, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
  });

  it("keeps enclosing markdown links around nested image labels", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-image-label-"));
    const indexFile = path.join(root, "index.md");
    const guideFile = path.join(root, "guide.md");
    const imageFile = path.join(root, "image.png");

    await fsp.writeFile(indexFile, "[![Alt](./image.png)](./guide.md)\n", "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");
    await fsp.writeFile(imageFile, "png\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const normalizedImage = imageFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedIndex, normalizedGuide, normalizedImage]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedImage,
      ),
    ).toBe(false);
  });

  it("keeps enclosing markdown reference links around nested image labels", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-ref-image-label-"));
    const indexFile = path.join(root, "index.md");
    const guideFile = path.join(root, "guide.md");
    const imageFile = path.join(root, "image.png");

    await fsp.writeFile(
      indexFile,
      ["[![Alt][img]][guide]", "", "[img]: ./image.png", "[guide]: ./guide.md"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");
    await fsp.writeFile(imageFile, "png\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const normalizedImage = imageFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedIndex, normalizedGuide, normalizedImage]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedImage,
      ),
    ).toBe(false);
  });

  it("resolves markdown inline links with multiline labels", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-multiline-label-"));
    const indexFile = path.join(root, "index.md");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(indexFile, "[Guide\nlabel](./guide.md)\n", "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedIndex, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
  });

  it("ignores raw HTML and JSX tags in markdown-style autolinks", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-mdx-"));
    const pageFile = path.join(root, "page.mdx");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(pageFile, ["<Guide />", "<br>", "<./guide.md>"].join("\n"), "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedPage &&
          edge.to.type === "external" &&
          (edge.to.name === "Guide" || edge.to.name === "br"),
      ),
    ).toBe(false);
  });

  it("does not scan markdown inline destinations as reference links", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-inline-destination-ref-"));
    const indexFile = path.join(root, "index.md");
    const guideFile = path.join(root, "guide-[ref].md");
    const otherFile = path.join(root, "other.md");

    await fsp.writeFile(indexFile, ["[Guide](./guide-[ref].md)", "", "[ref]: ./other.md"].join("\n"), "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");
    await fsp.writeFile(otherFile, "# Other\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const normalizedOther = otherFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedIndex, normalizedGuide, normalizedOther]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedOther,
      ),
    ).toBe(false);
  });

  it("treats failed markdown inline destinations as shortcut references", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-failed-inline-shortcut-"));
    const pageFile = path.join(root, "page.md");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(pageFile, "[Guide](\n\n[Guide]: ./guide.md\n", "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
  });

  it("does not resolve whitespace-only empty markdown inline links as shortcuts", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-empty-inline-shortcut-"));
    const pageFile = path.join(root, "page.md");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(pageFile, "[Guide]( )\n\n[Guide]: ./guide.md\n", "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(false);
  });

  it("does not scan nested bracket text in markdown link labels as references", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-nested-label-ref-"));
    const indexFile = path.join(root, "index.md");
    const guideFile = path.join(root, "guide.md");
    const otherFile = path.join(root, "other.md");

    await fsp.writeFile(
      indexFile,
      [
        "[Text [Other] label](./guide.md)",
        "[Text [Other] label][guide]",
        "",
        "[Other]: ./other.md",
        "[guide]: ./guide.md",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");
    await fsp.writeFile(otherFile, "# Other\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const normalizedOther = otherFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedIndex, normalizedGuide, normalizedOther]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedOther,
      ),
    ).toBe(false);
  });

  it("ignores markdown email autolinks while keeping file autolinks", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-email-"));
    const pageFile = path.join(root, "page.md");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(pageFile, ["<user@example.com>", "<./guide.md>"].join("\n"), "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "external" && edge.to.name === "user@example.com",
      ),
    ).toBe(false);
  });

  it("keeps scheme-less domain paths external instead of forcing them relative", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-domain-"));
    const pageFile = path.join(root, "page.md");
    const shadowedLocalPath = path.join(root, "example.com", "docs");

    await fsp.mkdir(path.dirname(shadowedLocalPath), { recursive: true });
    await fsp.writeFile(shadowedLocalPath, "shadowed local path\n", "utf8");
    await fsp.writeFile(pageFile, "[Docs](example.com/docs)\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedShadowedLocalPath = shadowedLocalPath.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "external" && edge.to.name === "example.com/docs",
      ),
    ).toBe(true);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedShadowedLocalPath,
      ),
    ).toBe(false);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "external" && edge.to.name === "./example.com/docs",
      ),
    ).toBe(false);
  });

  it("ignores markdown links inside indented code blocks", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-indented-"));
    const pageFile = path.join(root, "page.md");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(pageFile, "    [Guide](./guide.md)\n", "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(false);
  });

  it("ignores standalone markdown reference image links", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-ref-image-"));
    const pageFile = path.join(root, "page.md");
    const imageFile = path.join(root, "image.png");

    await fsp.writeFile(pageFile, "![Alt][img]\n\n[img]: ./image.png\n", "utf8");
    await fsp.writeFile(imageFile, "png\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedImage = imageFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedImage]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedImage,
      ),
    ).toBe(false);
  });

  it("ignores shortcut markdown reference images with nested label text", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-shortcut-ref-image-"));
    const pageFile = path.join(root, "page.md");
    const otherFile = path.join(root, "other.md");

    await fsp.writeFile(pageFile, "![Alt [Other]]\n\n[Other]: ./other.md\n", "utf8");
    await fsp.writeFile(otherFile, "# Other\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedOther = otherFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedOther]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedOther,
      ),
    ).toBe(false);
  });

  it("ignores angle-bracket destinations in markdown images", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-angle-image-"));
    const pageFile = path.join(root, "page.md");
    const imageFile = path.join(root, "image.png");

    await fsp.writeFile(pageFile, "![Alt](<./image.png>)\n![Alt][img]\n\n[img]: <./image.png>\n", "utf8");
    await fsp.writeFile(imageFile, "png\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedImage = imageFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedImage]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedImage,
      ),
    ).toBe(false);
  });

  it("resolves long markdown labels and bounds stale reference suffix scans", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-long-label-"));
    const pageFile = path.join(root, "page.md");
    const guideFile = path.join(root, "guide.md");
    const longLabel = "a".repeat(300);
    const staleSuffixes = "[x][".repeat(1000);

    await fsp.writeFile(pageFile, `${staleSuffixes}\n[${longLabel}](./guide.md)\n`, "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
  });

  it("resolves maximum-length markdown reference suffix labels", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-max-ref-label-"));
    const pageFile = path.join(root, "page.md");
    const guideFile = path.join(root, "guide.md");
    const otherFile = path.join(root, "other.md");
    const label = "a".repeat(999);

    await fsp.writeFile(pageFile, `[x][${label}]\n\n[x]: ./other.md\n[${label}]: ./guide.md\n`, "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");
    await fsp.writeFile(otherFile, "# Other\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const normalizedOther = otherFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide, normalizedOther]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedOther,
      ),
    ).toBe(false);
  });
  it("ignores bracket text inside markdown reference definition destinations", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-def-bracket-destination-"));
    const pageFile = path.join(root, "page.md");
    const otherFile = path.join(root, "other.md");

    await fsp.writeFile(pageFile, "[foo]: ./guide-[bar].md\n[bar]: ./other.md\n", "utf8");
    await fsp.writeFile(otherFile, "# Other\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedOther = otherFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedOther]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedOther,
      ),
    ).toBe(false);
  });

  it("resolves balanced bracket markdown reference labels", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-balanced-ref-label-"));
    const pageFile = path.join(root, "page.md");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(pageFile, "[x][foo [bar]]\n\n[foo [bar]]: ./guide.md\n", "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
  });

  it("ignores malformed markdown reference definitions with invalid titles", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-invalid-ref-title-"));
    const pageFile = path.join(root, "page.md");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(pageFile, "[bad][bad]\n\n[bad]: ./guide.md invalid title\n", "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(false);
  });

  it("ignores balanced-label markdown reference definitions with angle destinations", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-balanced-angle-dest-"));
    const pageFile = path.join(root, "page.md");
    const imageFile = path.join(root, "image.png");

    await fsp.writeFile(pageFile, "[foo [bar]]: <./image.png>\n", "utf8");
    await fsp.writeFile(imageFile, "png\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedImage = imageFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedImage]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedImage,
      ),
    ).toBe(false);
  });

  it("parseFile still supports graph-only markdown inputs", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-parse-markdown-"));
    const pageFile = path.join(root, "page.md");
    await fsp.writeFile(pageFile, "[Guide](./guide.md)\n", "utf8");

    const parsed = await import("../src/indexer.js").then((mod) => mod.parseFile(pageFile));
    expect(parsed.sup.id).toBe("markdown");
    expect(parsed.source).toContain("[Guide]");
  });

  it("ignores markdown reference definitions with trailing title tokens", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-extra-ref-title-"));
    const pageFile = path.join(root, "page.md");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(pageFile, '[bad][bad]\n\n[bad]: ./guide.md "title" "extra"\n', "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(false);
  });

  it("ignores overlong markdown reference labels", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-overlong-ref-label-"));
    const pageFile = path.join(root, "page.md");
    const guideFile = path.join(root, "guide.md");
    const label = "a".repeat(1000);

    await fsp.writeFile(pageFile, `[x][${label}]\n\n[${label}]: ./guide.md\n`, "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(false);
  });

  it("skips long markdown inline destinations before reference scanning", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-md-long-inline-destination-"));
    const pageFile = path.join(root, "page.md");
    const guideFile = path.join(root, "guide-[ref].md");
    const otherFile = path.join(root, "other.md");
    const label = "a".repeat(1000);

    await fsp.writeFile(pageFile, `[${label}](./guide-[ref].md)\n\n[ref]: ./other.md\n`, "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");
    await fsp.writeFile(otherFile, "# Other\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const normalizedOther = otherFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide, normalizedOther]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedOther,
      ),
    ).toBe(false);
  });

  it("ignores anchor-only asciidoc xrefs while keeping file references", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-adoc-"));
    const indexFile = path.join(root, "index.asciidoc");
    const guideFile = path.join(root, "guide.asciidoc");

    await fsp.writeFile(
      indexFile,
      ["xref:guide.asciidoc[Guide]", "<<local-anchor,See below>>", "xref:local-anchor[]"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(guideFile, "= Guide\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedIndex, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "external" && edge.to.name === "local-anchor",
      ),
    ).toBe(false);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path.endsWith("/local-anchor"),
      ),
    ).toBe(false);
  });

  it("supports graph extraction for .handlebars aliases", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-hbs-"));
    const pageFile = path.join(root, "page.handlebars");
    const guideFile = path.join(root, "guide.asciidoc");
    const partialFile = path.join(root, "partials", "card.handlebars");

    await fsp.mkdir(path.dirname(partialFile), { recursive: true });
    await fsp.writeFile(
      pageFile,
      ['<a href="./guide.asciidoc">Guide</a>', "{{> ./partials/card.handlebars }}"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(guideFile, "= Guide\n", "utf8");
    await fsp.writeFile(partialFile, "<div>Card</div>\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const normalizedPartial = partialFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide, normalizedPartial]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedPartial,
      ),
    ).toBe(true);
  });

  it("ignores dynamic JSX-style html attribute expressions", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-astro-"));
    const pageFile = path.join(root, "page.astro");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(
      pageFile,
      ["<a href={dynamicPath}>Dynamic</a>", '<a href="./guide.md">Guide</a>'].join("\n"),
      "utf8",
    );
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedPage &&
          edge.to.type === "external" &&
          (edge.to.name === "{dynamicPath}" || edge.raw === "{dynamicPath}"),
      ),
    ).toBe(false);
  });

  it("ignores dynamic JSX-style html attribute expressions in mdx", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-mdx-dynamic-"));
    const pageFile = path.join(root, "page.mdx");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(
      pageFile,
      ["<a href={dynamicPath}>Dynamic</a>", '<a href="./guide.md">Guide</a>'].join("\n"),
      "utf8",
    );
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide,
      ),
    ).toBe(true);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedPage &&
          edge.to.type === "external" &&
          (edge.to.name === "{dynamicPath}" || edge.raw === "{dynamicPath}"),
      ),
    ).toBe(false);
  });

  it("captures Markdown link occurrences with locations and missing references", () => {
    const occurrences = extractMarkdownLinkOccurrences(
      [
        "[Direct](./guide.md#section)",
        "[Reference][guide]",
        "[Missing][absent]",
        "<https://example.com/docs>",
        '<a href="./raw.html">Raw</a>',
        "",
        "[guide]: ./reference.md",
      ].join("\n"),
    );

    expect(
      occurrences.map((occurrence) =>
        "missingReference" in occurrence
          ? { raw: occurrence.raw, missingReference: true, line: occurrence.range.start.line }
          : { raw: occurrence.raw, line: occurrence.range.start.line },
      ),
    ).toEqual([
      { raw: "./guide.md#section", line: 1 },
      { raw: "./reference.md", line: 2 },
      { raw: "absent", missingReference: true, line: 3 },
      { raw: "https://example.com/docs", line: 4 },
      { raw: "./raw.html", line: 5 },
    ]);
    expect(occurrences[0]?.range.start).toMatchObject({ line: 1, column: 10 });
  });
});

describe("document format HTML forms", () => {
  it("names a reason for every opt-out from the shared HTML forms", () => {
    for (const [formatId, form] of Object.entries(DOCUMENT_HTML_FORMS)) {
      const omitted: string[] = [];
      if (form.attributes === null) {
        omitted.push("attributes");
      } else {
        for (const tag of Object.keys(SHARED_HTML_TAG_ATTRS)) {
          if (!(tag in form.attributes)) omitted.push(tag);
        }
      }
      if (!form.inlineScript) omitted.push("inlineScript");
      if (!form.inlineStyle) omitted.push("inlineStyle");

      expect(Object.keys(form.optOuts).sort(), formatId).toEqual(omitted.sort());
      for (const [omittedName, reason] of Object.entries(form.optOuts)) {
        expect(reason.trim(), `${formatId}.${omittedName}`).not.toBe("");
      }
    }
  });

  it("runs every shared pass for HTML, Astro, and Handlebars", () => {
    const fullFormIds: DocumentHtmlFormId[] = ["html", "astro", "hbs"];
    for (const formatId of fullFormIds) {
      const form = DOCUMENT_HTML_FORMS[formatId];
      expect(form.attributes, formatId).toEqual(SHARED_HTML_TAG_ATTRS);
      expect(form.inlineScript, formatId).toBe(true);
      expect(form.inlineStyle, formatId).toBe(true);
    }
  });

  it("extracts Astro attributes, inline script, inline style, and frontmatter", () => {
    const source = [
      "---",
      'import Layout from "./Layout.astro";',
      "---",
      "<Layout>",
      '  <a href="./guide.md">Guide</a>',
      '  <link rel="stylesheet" href="./styles.css">',
      '  <script src="./app.js"></script>',
      '  <script>import "./inline.ts";</script>',
      '  <style>@import "./theme.css";</style>',
      "  <style>.hero { background: url(./bg.png); }</style>",
      '  <img src="./image.png">',
      "</Layout>",
    ].join("\n");

    expect(extractAstroModuleSpecifiers(source).map((entry) => entry.spec)).toEqual([
      "./guide.md",
      "./styles.css",
      "./app.js",
      "./image.png",
      "./inline.ts",
      "./theme.css",
      "./bg.png",
      "./Layout.astro",
    ]);
  });

  it("extracts Astro scoped style imports and url references", () => {
    const specs = extractAstroModuleSpecifiers(
      '<style>@import "./theme.css";</style>\n<style>.hero { background: url(./bg.png); }</style>',
    ).map((entry) => entry.spec);

    expect(specs).toEqual(["./theme.css", "./bg.png"]);
  });

  it("extracts static Handlebars markup and inline passes while ignoring interpolated paths", () => {
    const source = [
      '<a href="./guide.adoc">Guide</a>',
      "{{> ./partials/card}}",
      "{{#> ./partials/block}}body{{/partials/block}}",
      '<script src="./app.js"></script>',
      '<script>import "./inline.js";</script>',
      '<style>@import "./theme.css";</style>',
      '<img src="./image.png">',
      '<a href="{{dynamicPath}}">Dynamic</a>',
    ].join("\n");

    expect(extractHandlebarsModuleSpecifiers(source).map((entry) => entry.spec)).toEqual([
      "./guide.adoc",
      "./app.js",
      "./image.png",
      "./inline.js",
      "./theme.css",
      "./partials/card",
      "./partials/block",
    ]);
  });

  it("walks embedded HTML in Markdown except image sources, and keeps markdown exclusions", () => {
    const source = [
      "[Guide](./guide.md)",
      "![Diagram](./images/diagram.svg)",
      '<a href="./raw.html">Raw</a>',
      '<link rel="stylesheet" href="./styles.css">',
      '<script src="./app.js"></script>',
      '<script>import "./inline.ts";</script>',
      '<style>@import "./theme.css";</style>',
      '<img src="./image.png">',
      '<picture><source srcset="./wide.avif 1x"></picture>',
      '<!-- <a href="./commented.html">Commented</a> -->',
      "```html",
      '<a href="./fenced.html">Fenced</a>',
      "```",
      '    <a href="./indented.html">Indented</a>',
    ].join("\n");

    expect(extractMarkdownModuleSpecifiers(source).map((entry) => entry.spec)).toEqual([
      "./guide.md",
      "./raw.html",
      "./styles.css",
      "./app.js",
      "./inline.ts",
      "./theme.css",
    ]);
  });

  it("gives MDX the Markdown HTML form plus its JS specifiers", () => {
    const source = [
      'import Card from "./components/Card.tsx";',
      "[Guide](./guide.md)",
      '<script src="./app.js"></script>',
      '<img src="./image.png">',
    ].join("\n");

    expect(extractMdxModuleSpecifiers(source).map((entry) => entry.spec)).toEqual([
      "./guide.md",
      "./app.js",
      "./components/Card.tsx",
    ]);
  });

  it("gives AsciiDoc the same embedded-HTML walk as Markdown, with ifdef and listing blocks masked", () => {
    const source = [
      "include::partials/live.adoc[]",
      '<a href="./guide.adoc">Guide</a>',
      '<link rel="stylesheet" href="./styles.css">',
      '<script src="./app.js"></script>',
      '<img src="./image.png">',
      "----",
      '<a href="./listing.adoc">Listing</a>',
      "----",
      "ifdef::never[]",
      '<a href="./conditional.adoc">Conditional</a>',
      "endif::[]",
    ].join("\n");

    expect(extractAsciidocModuleSpecifiers(source).map((entry) => entry.spec)).toEqual([
      "./partials/live.adoc",
      "./guide.adoc",
      "./styles.css",
      "./app.js",
    ]);
  });

  it("keeps reStructuredText directive-based and ignores embedded HTML", () => {
    const source = [
      ".. include:: ./intro.rst",
      "See :doc:`guide`.",
      '<a href="./raw.html">Raw</a>',
      '<link rel="stylesheet" href="./styles.css">',
      '<script src="./app.js"></script>',
      '<style>@import "./theme.css";</style>',
      '<img src="./image.png">',
    ].join("\n");

    expect(extractRstModuleSpecifiers(source).map((entry) => entry.spec)).toEqual(["./guide", "./intro.rst"]);
  });
});

describe("html scanner quote and context awareness", () => {
  it("keeps attribute edges when an attribute value contains an HTML comment opener", () => {
    const specs = extractHtmlAttributeSpecifiers('<a title="<!--" href="./dep.js">x</a>');
    expect(specs.some((entry) => entry.spec === "./dep.js")).toBe(true);
  });

  it("still ignores genuinely commented-out tags while keeping later real edges", () => {
    const specs = extractHtmlAttributeSpecifiers(
      '<!-- <script src="./commented.js"></script> -->\n<script src="./real.js"></script>',
    );
    expect(specs.some((entry) => entry.spec === "./real.js")).toBe(true);
    expect(specs.some((entry) => entry.spec === "./commented.js")).toBe(false);
  });

  it("keeps attribute edges when an attribute value contains a literal-block opener", () => {
    const specs = extractHtmlAttributeSpecifiers('<a data="<pre>" href="./dep.js">x</a>');
    expect(specs.some((entry) => entry.spec === "./dep.js")).toBe(true);
  });

  it("still ignores pre literal blocks while keeping later real edges", () => {
    const specs = extractHtmlAttributeSpecifiers(
      '<pre><a href="./literal.html">example</a></pre>\n<a href="./real.html">real</a>',
    );
    expect(specs.some((entry) => entry.spec === "./real.html")).toBe(true);
    expect(specs.some((entry) => entry.spec === "./literal.html")).toBe(false);
  });

  it("keeps inline style imports when a quoted attribute contains an angle bracket", () => {
    const specs = extractHtmlStyleSpecifiers(`<style data=" > ">@import './dep.css';</style>`);
    expect(specs.some((entry) => entry.spec === "./dep.css")).toBe(true);
  });

  it("keeps inline script imports when a script string contains an HTML comment opener", () => {
    const specs = extractHtmlInlineScriptSpecifiers(`<script>const marker = "<!--"; import('./dep.js')</script>`);
    expect(specs.some((entry) => entry.spec === "./dep.js")).toBe(true);
  });

  it("keeps markup after a self-closing literal-block tag", () => {
    const specs = extractHtmlAttributeSpecifiers('<pre/>\n<a href="./real.html">real</a>');
    expect(specs.some((entry) => entry.spec === "./real.html")).toBe(true);
  });

  it("keeps scanning later markup after an unclosed raw-text tag in a malformed document", () => {
    const specs = extractHtmlAttributeSpecifiers('<script src="./a.js"><a href="./b.html">');
    expect(specs.some((entry) => entry.spec === "./a.js")).toBe(true);
    expect(specs.some((entry) => entry.spec === "./b.html")).toBe(true);
  });
});
