import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions } from "../src/config.js";
import { searchCodegraph } from "../src/agent/search.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import { diffBuildOptions, summarizeBuildOptions } from "../src/indexer/build-cache.js";
import { supportForFile } from "../src/languages.js";

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-config-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "tests", "samples"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "kept.ts"), "export const keptAlpha = true;\n", "utf8");
  await fs.writeFile(path.join(root, "tests", "samples", "ignored.ts"), "export const ignoredZebra = true;\n", "utf8");
  return root;
}

async function writeConfig(root: string, config: unknown): Promise<void> {
  await fs.writeFile(path.join(root, "codegraph.config.json"), JSON.stringify(config), "utf8");
}

function normalizedFile(root: string, relativePath: string): string {
  return path.join(root, relativePath).replace(/\\/g, "/");
}

async function buildWithProjectConfig(root: string) {
  const config = await loadCodegraphConfig(root);
  return await buildProjectIndex(root, {
    cache: "disk",
    ...(config.languages?.extensions ? { languageExtensions: config.languages.extensions } : {}),
  });
}

function localExportNames(
  index: Awaited<ReturnType<typeof buildProjectIndex>>,
  root: string,
  relativePath: string,
): string[] {
  const moduleIndex = index.byFile.get(normalizedFile(root, relativePath));
  return (
    moduleIndex?.exports
      .filter((entry) => entry.type === "local")
      .map((entry) => entry.exportedAs)
      .sort() ?? []
  );
}

describe("codegraph config", () => {
  it("loads discovery settings from codegraph.config.json", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "codegraph.config.json"),
      JSON.stringify({
        discovery: {
          ignoreGlobs: ["tests/samples/**"],
        },
      }),
      "utf8",
    );

    const config = await loadCodegraphConfig(root);

    expect(config.discovery?.ignoreGlobs).toEqual(["tests/samples/**"]);
  });

  it("merges config discovery with explicit discovery overrides", () => {
    const merged = mergeDiscoveryOptions(
      {
        ignoreGlobs: ["tests/samples/**"],
        includeGlobs: ["src/**/*.ts"],
        useGitignore: true,
      },
      {
        ignoreGlobs: ["dist/**"],
        globRoot: "repo-root",
        gitignoreRoot: "repo-root",
        useGitignore: false,
      },
    );

    expect(merged).toEqual({
      includeGlobs: ["src/**/*.ts"],
      ignoreGlobs: ["tests/samples/**", "dist/**"],
      globRoot: "repo-root",
      gitignoreRoot: "repo-root",
      useGitignore: false,
    });
  });

  it("normalizes glob separators before de-duping merged discovery options", () => {
    const merged = mergeDiscoveryOptions(
      {
        includeGlobs: ["src\\**\\*.ts", " src/**/*.ts "],
        ignoreGlobs: ["tests\\samples\\**"],
      },
      {
        includeGlobs: ["src/**/*.ts"],
        ignoreGlobs: ["tests/samples/**", "dist\\**"],
      },
    );

    expect(merged.includeGlobs).toEqual(["src/**/*.ts"]);
    expect(merged.ignoreGlobs).toEqual(["tests/samples/**", "dist/**"]);
  });

  it("normalizes discovery roots before merging and option detection", () => {
    expect(hasDiscoveryOptions({ globRoot: " " })).toBe(false);
    expect(hasDiscoveryOptions({ gitignoreRoot: "\t" })).toBe(false);
    expect(hasDiscoveryOptions({ globRoot: " repo-root " })).toBe(true);

    const merged = mergeDiscoveryOptions(
      {
        globRoot: " repo-root ",
        gitignoreRoot: " git-root ",
      },
      {
        globRoot: " ",
        gitignoreRoot: "",
      },
    );

    expect(merged).toEqual({
      globRoot: "repo-root",
      gitignoreRoot: "git-root",
    });
    expect(mergeDiscoveryOptions({ globRoot: "", gitignoreRoot: " " }, undefined)).toEqual({});
  });

  it("recognizes discovery root and logging options as meaningful options", () => {
    expect(hasDiscoveryOptions({ globRoot: "repo-root" })).toBe(true);
    expect(hasDiscoveryOptions({ gitignoreRoot: "repo-root" })).toBe(true);
    expect(hasDiscoveryOptions({ logLevel: "silent" })).toBe(true);
  });

  it("search honors configured discovery ignores", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "codegraph.config.json"),
      JSON.stringify({
        discovery: {
          ignoreGlobs: ["tests/samples/**"],
        },
      }),
      "utf8",
    );

    const kept = await searchCodegraph({ root, query: "kept alpha", mode: "text", limit: 10 });
    const ignored = await searchCodegraph({ root, query: "ignored zebra", mode: "text", limit: 10 });

    expect(kept.results.map((result) => result.file)).toContain("src/kept.ts");
    expect(ignored.results).toEqual([]);
  });

  it("loads language extension mappings from codegraph.config.json", async () => {
    const root = await mkRepo();
    await writeConfig(root, {
      languages: {
        extensions: {
          ".TPL": "php",
        },
      },
    });

    const config = await loadCodegraphConfig(root);

    expect(config.languages?.extensions).toEqual({ ".tpl": "php" });
    expect(config.discovery?.includeGlobs).toEqual(["**/*.tpl"]);
  });

  it("indexes configured nonstandard extensions with the mapped language", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "src", "template.tpl"),
      "<?php function mapped_template() { return 1; }\n",
      "utf8",
    );
    await writeConfig(root, {
      languages: {
        extensions: {
          ".tpl": "php",
        },
      },
    });

    const index = await buildWithProjectConfig(root);

    expect(localExportNames(index, root, "src/template.tpl")).toContain("mapped_template");
  });

  it("uses the longest configured extension match before shorter remaps", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "src", "view.inc.php"),
      "<?php function longest_extension() { return 1; }\n",
      "utf8",
    );
    await writeConfig(root, {
      languages: {
        extensions: {
          ".php": "html",
          ".inc.php": "php",
        },
      },
    });

    const index = await buildWithProjectConfig(root);

    expect(localExportNames(index, root, "src/view.inc.php")).toContain("longest_extension");
  });

  it("keeps built-in extensions unless a matching mapping overrides them", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "src", "builtin.ts"), "export const builtinValue = 1;\n", "utf8");
    await fs.writeFile(path.join(root, "src", "remapped.php"), "<?php function remapped_php() { return 1; }\n", "utf8");
    await writeConfig(root, {
      languages: {
        extensions: {
          ".tpl": "php",
          ".php": "html",
        },
      },
    });

    const index = await buildWithProjectConfig(root);

    expect(localExportNames(index, root, "src/builtin.ts")).toContain("builtinValue");
    expect(localExportNames(index, root, "src/remapped.php")).not.toContain("remapped_php");
  });

  it("invalidates disk cache entries when language extension mappings change", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "src", "cached.tpl"),
      "<?php function cached_template() { return 1; }\n",
      "utf8",
    );
    await writeConfig(root, {
      languages: {
        extensions: {
          ".tpl": "html",
        },
      },
    });

    const htmlIndex = await buildWithProjectConfig(root);
    expect(localExportNames(htmlIndex, root, "src/cached.tpl")).not.toContain("cached_template");

    await writeConfig(root, {
      languages: {
        extensions: {
          ".tpl": "php",
        },
      },
    });

    const phpIndex = await buildWithProjectConfig(root);

    expect(localExportNames(phpIndex, root, "src/cached.tpl")).toContain("cached_template");
  });

  it("ignores non-dot-prefixed extension keys passed directly to supportForFile", () => {
    expect(supportForFile("widget.tpl", { tpl: "html" })).toBeUndefined();
    expect(supportForFile("widget.tpl", { ".tpl": "html" })?.id).toBe("html");
  });

  it("ignores non-dot-prefixed languageExtensions keys when comparing manifest build options", () => {
    const dotOnly = summarizeBuildOptions({
      languageExtensions: { ".tpl": "html" },
    });
    const withNonDotKey = summarizeBuildOptions({
      languageExtensions: { ".tpl": "html", tpl: "html" },
    });

    expect(withNonDotKey).toEqual(dotOnly);
    expect(diffBuildOptions(dotOnly, { languageExtensions: { ".tpl": "html", tpl: "html" } })).not.toContain(
      "languageExtensions",
    );
  });

  it("rejects language extension keys that do not start with a dot", async () => {
    const root = await mkRepo();
    await writeConfig(root, {
      languages: {
        extensions: {
          tpl: "php",
        },
      },
    });

    await expect(loadCodegraphConfig(root)).rejects.toThrow('languages.extensions key "tpl" must start with "."');
  });

  it("rejects language extension mappings to unknown languages", async () => {
    const root = await mkRepo();
    await writeConfig(root, {
      languages: {
        extensions: {
          ".tpl": "wat",
        },
      },
    });

    await expect(loadCodegraphConfig(root)).rejects.toThrow(
      'languages.extensions[".tpl"] references unknown language "wat"',
    );
  });
});
