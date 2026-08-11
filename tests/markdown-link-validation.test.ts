import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
});
