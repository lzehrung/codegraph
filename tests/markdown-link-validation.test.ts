import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tryCreateDirectorySymlink } from "./helpers/filesystem.js";
import { checkMarkdownLinks } from "../src/documentLinks/check.js";

async function makeRoot(name: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), `cg-markdown-links-${name}-`));
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const file = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, "utf8");
}

describe("Markdown link validation", () => {
  it("accepts local files, directories, local anchors, duplicate anchors, and external links", async () => {
    const root = await makeRoot("valid");
    await fsp.mkdir(path.join(root, "docs"));
    await writeFile(
      root,
      "README.md",
      [
        "# Home",
        "[Docs](./docs)",
        "[Guide](./guide.md?view=full#guide)",
        "[Second guide](./guide.md#guide-1)",
        "[Home](#home)",
        "[External](https://example.com/docs)",
      ].join("\n"),
    );
    await writeFile(root, "guide.md", "# Guide\n\n# Guide\n");

    const result = await checkMarkdownLinks(root);

    expect(result.summary).toEqual({
      filesScanned: 2,
      linksChecked: 4,
      externalSkipped: 1,
      failures: 0,
    });
    expect(result.failures).toEqual([]);
  });

  it("accepts decoded Markdown paths and GitHub-style heading anchors", async () => {
    const root = await makeRoot("decoded-paths-and-anchors");
    await writeFile(
      root,
      "README.md",
      [
        "[Percent encoded](my%20file.md)",
        "[Escaped punctuation](guide\\(1\\).md)",
        "[Rendered heading](headings.md#install)",
        "[Underscore](headings.md#keep_this)",
        "[Duplicate heading](headings.md#foo-1)",
        "[Colliding heading](headings.md#foo-1-1)",
      ].join("\n"),
    );
    await writeFile(root, "my file.md", "# Percent encoded\n");
    await writeFile(root, "guide(1).md", "# Escaped punctuation\n");
    await writeFile(root, "guide.md", "# Guide\n");
    await writeFile(root, "headings.md", "# [Install](guide.md)\n# Keep_this\n# Foo\n# Foo\n# Foo-1\n");

    const result = await checkMarkdownLinks(root);

    expect(result.summary).toMatchObject({ linksChecked: 7, failures: 0 });
    expect(result.failures).toEqual([]);
  });

  it("uses the first Markdown reference definition", async () => {
    const root = await makeRoot("duplicate-reference-definitions");
    await writeFile(root, "README.md", "[Guide][guide]\n\n[guide]: ./guide.md\n[guide]: ./missing.md\n");
    await writeFile(root, "guide.md", "# Guide\n");

    const result = await checkMarkdownLinks(root);

    expect(result.summary).toMatchObject({ linksChecked: 1, failures: 0 });
    expect(result.failures).toEqual([]);
  });

  it("reports missing files, reference definitions, fragments, and outside-root targets", async () => {
    const parent = await makeRoot("failures");
    const root = path.join(parent, "project");
    await fsp.mkdir(root);
    await writeFile(
      root,
      "index.md",
      [
        "[Missing](./missing.md)",
        "[Missing reference][absent]",
        "[Missing fragment](./guide.md#does-not-exist)",
        "[Outside](../outside.md)",
      ].join("\n"),
    );
    await writeFile(root, "guide.md", "# Guide\n");
    await writeFile(parent, "outside.md", "# Outside\n");

    const result = await checkMarkdownLinks(root);

    expect(result.summary.failures).toBe(4);
    expect(result.failures.map((failure) => [failure.reason, failure.raw])).toEqual([
      ["missing_file", "./missing.md"],
      ["missing_reference", "absent"],
      ["missing_fragment", "./guide.md#does-not-exist"],
      ["outside_root", "../outside.md"],
    ]);
    expect(result.failures[0]?.range.start.line).toBe(1);
  });
  it("rejects targets whose symlinks escape the project root", async (context) => {
    const root = await makeRoot("symlink-escape-root");
    const outside = await makeRoot("symlink-escape-outside");
    try {
      await writeFile(outside, "guide.md", "# Outside\n");
      const linkedDirectory = path.join(root, "linked");
      if (!(await tryCreateDirectorySymlink(outside, linkedDirectory))) {
        context.skip();
        return;
      }
      await writeFile(root, "README.md", "[Outside](./linked/guide.md#outside)\n");

      const result = await checkMarkdownLinks(root);

      expect(result.failures).toEqual([
        expect.objectContaining({
          reason: "outside_root",
          raw: "./linked/guide.md#outside",
          target: "linked/guide.md",
        }),
      ]);
    } finally {
      await Promise.all([
        fsp.rm(root, { recursive: true, force: true }),
        fsp.rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});
