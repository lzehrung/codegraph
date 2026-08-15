import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkMarkdownLinks } from "../src/documentLinks/check.js";
import { captureCli } from "./helpers/cli.js";

async function createMarkdownProject(files: Readonly<Record<string, string>>): Promise<string> {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-links-cli-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(projectRoot, relativePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, contents, "utf8");
  }
  return projectRoot;
}

describe("links CLI", () => {
  it("prints the exact success message", async () => {
    const projectRoot = await createMarkdownProject({
      "README.md": "[guide](guide.md)\n",
      "guide.md": "# Guide\n",
    });
    try {
      const result = await captureCli(["links", projectRoot, "--pretty"]);

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toBe("No broken Markdown links found.\n");
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses singular wording for one broken link", async () => {
    const projectRoot = await createMarkdownProject({
      "README.md": "[missing](missing.md)\n",
    });
    try {
      const result = await captureCli(["links", projectRoot, "--pretty"]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("1 broken Markdown link found:\nREADME.md:1:11 missing_file: missing.md\n");
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("prints sorted broken-link details and verbose scan counts", async () => {
    const projectRoot = await createMarkdownProject({
      "README.md": "[second](z.md)\n[first](a.md)\n[external](https://example.com)\n",
    });
    try {
      const expected = await checkMarkdownLinks(projectRoot);
      const result = await captureCli(["links", projectRoot, "--pretty", "--verbose"]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("2 broken Markdown links found:");
      expect(result.stdout).toMatch(/README\.md:\d+:\d+ missing_file: a\.md/);
      expect(result.stdout).toMatch(/README\.md:\d+:\d+ missing_file: z\.md/);
      expect(result.stdout.indexOf("missing_file: z.md")).toBeLessThan(result.stdout.indexOf("missing_file: a.md"));
      expect(result.stdout).toContain(
        `Scanned ${expected.summary.filesScanned} Markdown files; checked ${expected.summary.linksChecked} links; skipped ${expected.summary.externalSkipped} external links.`,
      );
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("writes the unmodified check result as JSON", async () => {
    const projectRoot = await createMarkdownProject({
      "README.md": "[missing](missing.md)\n",
    });
    try {
      const expected = await checkMarkdownLinks(projectRoot);
      const result = await captureCli(["links", "--root", projectRoot, "--json"]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual(expected);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("exits with status 1 for broken links without writing an error", async () => {
    const projectRoot = await createMarkdownProject({
      "README.md": "[missing](missing.md)\n",
    });
    try {
      const result = await captureCli(["links", "--root", projectRoot]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("honors config discovery.ignoreGlobs so ignored fixtures do not fail links", async () => {
    const projectRoot = await createMarkdownProject({
      "README.md": "[ok](guide.md)\n",
      "guide.md": "# Guide\n",
      "codegraph.config.json": JSON.stringify({ discovery: { ignoreGlobs: ["fixtures/**"] } }, null, 2),
      "fixtures/broken.md": "[missing](nowhere.md)\n",
    });
    try {
      const result = await captureCli(["links", "--root", projectRoot, "--pretty"]);
      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toBe("No broken Markdown links found.\n");
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("honors CLI --ignore-glob so ignored broken links do not fail", async () => {
    const projectRoot = await createMarkdownProject({
      "README.md": "[ok](guide.md)\n",
      "guide.md": "# Guide\n",
      "fixtures/broken.md": "[missing](nowhere.md)\n",
    });
    try {
      const withoutIgnore = await captureCli(["links", "--root", projectRoot, "--pretty"]);
      expect(withoutIgnore.exitCode).toBe(1);

      const withIgnore = await captureCli(["links", "--root", projectRoot, "--ignore-glob", "fixtures/**", "--pretty"]);
      expect(withIgnore.exitCode).toBeUndefined();
      expect(withIgnore.stdout).toBe("No broken Markdown links found.\n");
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
