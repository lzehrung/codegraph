import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectGraph } from "../src/index.js";

describe("document link graph extraction", () => {
  it("ignores hash-only anchors and markdown image links", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "markdown");
    const indexFile = path.join(root, "index.md").replace(/\\/g, "/");
    const guideFile = path.join(root, "guide.md").replace(/\\/g, "/");
    const imageFile = path.join(root, "images", "diagram.svg").replace(/\\/g, "/");
    const imageSpecifier = "./images/diagram.svg";
    const graph = await collectGraph(root, [indexFile, guideFile]);

    expect(graph.edges.some((edge) => edge.from === indexFile && edge.to.type === "external" && edge.to.name === "#local-section")).toBe(
      false,
    );

    expect(graph.edges.some((edge) => edge.from === indexFile && edge.to.type === "file" && edge.to.path === imageFile)).toBe(false);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === indexFile && edge.to.type === "external" && (edge.to.name === imageSpecifier || edge.raw === imageSpecifier),
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
      (edge) => edge.from === indexFile.replace(/\\/g, "/") && edge.to.type === "file" && edge.to.path === guideFile.replace(/\\/g, "/"),
    );

    expect(edges).toHaveLength(1);
  });

  it("ignores dynamic handlebars path expressions", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "hbs");
    const pageFile = path.join(root, "page.hbs").replace(/\\/g, "/");
    const guideFile = path.join(root, "guide.adoc").replace(/\\/g, "/");
    const partialFile = path.join(root, "partials", "card.hbs").replace(/\\/g, "/");
    const graph = await collectGraph(root, [pageFile, guideFile, partialFile]);

    expect(graph.edges.some((edge) => edge.from === pageFile && edge.to.type === "external" && edge.to.name.includes("dynamicPath"))).toBe(
      false,
    );
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
        (edge) => edge.from === indexFile.replace(/\\/g, "/") && edge.to.type === "file" && edge.to.path === guideFile.replace(/\\/g, "/"),
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

    expect(graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide)).toBe(
      true,
    );

    expect(
      graph.edges.some(
        (edge) => edge.from === normalizedPage && edge.to.type === "external" && (edge.to.name === "Guide" || edge.to.name === "br"),
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

    expect(graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide)).toBe(
      true,
    );

    expect(
      graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "external" && edge.to.name === "user@example.com"),
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
      graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "external" && edge.to.name === "example.com/docs"),
    ).toBe(true);

    expect(
      graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedShadowedLocalPath),
    ).toBe(false);

    expect(
      graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "external" && edge.to.name === "./example.com/docs"),
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

    expect(graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide)).toBe(
      false,
    );
  });

  it("ignores anchor-only asciidoc xrefs while keeping file references", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-adoc-"));
    const indexFile = path.join(root, "index.asciidoc");
    const guideFile = path.join(root, "guide.asciidoc");

    await fsp.writeFile(indexFile, ["xref:guide.asciidoc[Guide]", "<<local-anchor,See below>>", "xref:local-anchor[]"].join("\n"), "utf8");
    await fsp.writeFile(guideFile, "= Guide\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedIndex, normalizedGuide]);

    expect(graph.edges.some((edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedGuide)).toBe(
      true,
    );

    expect(
      graph.edges.some((edge) => edge.from === normalizedIndex && edge.to.type === "external" && edge.to.name === "local-anchor"),
    ).toBe(false);

    expect(
      graph.edges.some((edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path.endsWith("/local-anchor")),
    ).toBe(false);
  });

  it("supports graph extraction for .handlebars aliases", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-hbs-"));
    const pageFile = path.join(root, "page.handlebars");
    const guideFile = path.join(root, "guide.asciidoc");
    const partialFile = path.join(root, "partials", "card.handlebars");

    await fsp.mkdir(path.dirname(partialFile), { recursive: true });
    await fsp.writeFile(pageFile, ['<a href="./guide.asciidoc">Guide</a>', "{{> ./partials/card.handlebars }}"].join("\n"), "utf8");
    await fsp.writeFile(guideFile, "= Guide\n", "utf8");
    await fsp.writeFile(partialFile, "<div>Card</div>\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const normalizedPartial = partialFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide, normalizedPartial]);

    expect(graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide)).toBe(
      true,
    );

    expect(graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedPartial)).toBe(
      true,
    );
  });

  it("ignores dynamic JSX-style html attribute expressions", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-astro-"));
    const pageFile = path.join(root, "page.astro");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(pageFile, ["<a href={dynamicPath}>Dynamic</a>", '<a href="./guide.md">Guide</a>'].join("\n"), "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide)).toBe(
      true,
    );

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedPage && edge.to.type === "external" && (edge.to.name === "{dynamicPath}" || edge.raw === "{dynamicPath}"),
      ),
    ).toBe(false);
  });

  it("ignores dynamic JSX-style html attribute expressions in mdx", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-mdx-dynamic-"));
    const pageFile = path.join(root, "page.mdx");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(pageFile, ["<a href={dynamicPath}>Dynamic</a>", '<a href="./guide.md">Guide</a>'].join("\n"), "utf8");
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedGuide = guideFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedGuide]);

    expect(graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedGuide)).toBe(
      true,
    );

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedPage && edge.to.type === "external" && (edge.to.name === "{dynamicPath}" || edge.raw === "{dynamicPath}"),
      ),
    ).toBe(false);
  });
});
