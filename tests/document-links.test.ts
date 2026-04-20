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
    const graph = await collectGraph(root, [indexFile, guideFile]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === indexFile &&
          edge.to.type === "external" &&
          edge.to.name === "#local-section",
      ),
    ).toBe(false);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === indexFile &&
          edge.to.type === "file" &&
          edge.to.path === imageFile,
      ),
    ).toBe(false);
  });

  it("deduplicates identical markdown and raw HTML document targets", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-doc-links-"));
    const indexFile = path.join(root, "index.md");
    const guideFile = path.join(root, "guide.md");

    await fsp.writeFile(
      indexFile,
      [
        "[Guide](./guide.md)",
        "<a href=\"./guide.md\">Guide</a>",
        "[Guide Again](./guide.md)",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(guideFile, "# Guide\n", "utf8");

    const graph = await collectGraph(root, [
      indexFile.replace(/\\/g, "/"),
      guideFile.replace(/\\/g, "/"),
    ]);

    const edges = graph.edges.filter(
      (edge) =>
        edge.from === indexFile.replace(/\\/g, "/") &&
        edge.to.type === "file" &&
        edge.to.path === guideFile.replace(/\\/g, "/"),
    );

    expect(edges).toHaveLength(1);
  });

  it("ignores dynamic handlebars path expressions", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "hbs");
    const pageFile = path.join(root, "page.hbs").replace(/\\/g, "/");
    const guideFile = path.join(root, "guide.adoc").replace(/\\/g, "/");
    const partialFile = path.join(root, "partials", "card.hbs").replace(/\\/g, "/");
    const graph = await collectGraph(root, [pageFile, guideFile, partialFile]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === pageFile &&
          edge.to.type === "external" &&
          edge.to.name.includes("dynamicPath"),
      ),
    ).toBe(false);
  });
});
