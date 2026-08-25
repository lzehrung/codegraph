import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions, mergeGraphOptions } from "../src/config.js";
import { searchCodegraph } from "../src/agent/search.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import type { BuildReport } from "../src/indexer/types.js";
import { diffBuildOptions, summarizeBuildOptions } from "../src/indexer/build-cache.js";
import { cacheRoot, projectCacheNamespace } from "../src/indexer/build-cache/location.js";
import { normalizeLanguageExtensions, supportForFile } from "../src/languages.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { runTsxScriptOrThrow } from "./helpers/cli.js";
import { decompactFileGraph, type CompactFileGraphPayload } from "./helpers/compactGraph.js";

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

async function buildWithProjectConfig(root: string) {
  const config = await loadCodegraphConfig(root);
  return await buildProjectIndex(root, {
    cache: "disk",
    ...(config.discovery ? { discovery: config.discovery } : {}),
    ...(config.languages?.extensions ? { languageExtensions: config.languages.extensions } : {}),
  });
}

function localExportNames(
  index: Awaited<ReturnType<typeof buildProjectIndex>>,
  root: string,
  relativePath: string,
): string[] {
  const moduleIndex = index.byFile.get(fileIdentityKey(path.join(root, relativePath)));
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

  it("preserves repository cache anchoring when project config has no cache location", async () => {
    const repositoryRoot = await mkRepo();
    const projectRoot = path.join(repositoryRoot, "packages", "app");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(repositoryRoot, ".git"), "gitdir: external\n", "utf8");
    await writeConfig(projectRoot, {});
    vi.stubEnv("APPDATA", path.join(repositoryRoot, "missing-appdata"));
    vi.stubEnv("XDG_CONFIG_HOME", path.join(repositoryRoot, "missing-xdg-config"));

    try {
      const config = await loadCodegraphConfig(projectRoot);
      const resolvedCacheRoot = cacheRoot(projectRoot, {
        cache: "disk",
        ...(config.cache ? { cacheLocation: config.cache.location } : {}),
      });

      expect(config.cache).toBeUndefined();
      expect(resolvedCacheRoot).not.toBe(path.join(projectRoot, ".codegraph-cache", "index-v1"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects relative cache locations and accepts absolute cache directories", async () => {
    const root = await mkRepo();
    await writeConfig(root, { cache: { location: "relative-cache" } });

    await expect(loadCodegraphConfig(root)).rejects.toThrow(/Invalid codegraph\.config\.json/);

    const absoluteCache = path.join(root, "cache");
    await writeConfig(root, { cache: { location: absoluteCache } });

    await expect(loadCodegraphConfig(root)).resolves.toEqual({ cache: { location: absoluteCache } });
  });

  it("preserves an explicit cache location before its directory exists", async () => {
    const root = await mkRepo();
    const location = path.join(root, "new-cache-anchor");

    expect(cacheRoot(root, { cache: "disk", cacheLocation: location })).toBe(
      path.join(location, ".codegraph-cache", "index-v1", projectCacheNamespace(root)),
    );
    await expect(fs.stat(location)).rejects.toThrow();
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

  it("loads and merges normalized graph resolution hints", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "codegraph.config.json"),
      JSON.stringify({
        graph: {
          resolutionHints: [" Source\\Gunship\\Private ", "Source/Gunship/Private"],
        },
      }),
      "utf8",
    );

    const config = await loadCodegraphConfig(root);
    expect(config.graph?.resolutionHints).toEqual(["Source/Gunship/Private"]);
    expect(
      mergeGraphOptions(config.graph, {
        fast: true,
        resolutionHints: ["Source/Gunship/Public", "Source\\Gunship\\Private"],
      }),
    ).toEqual({
      fast: true,
      resolutionHints: ["Source/Gunship/Private", "Source/Gunship/Public"],
    });
  });

  it("rejects unknown graph config properties", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "codegraph.config.json"),
      JSON.stringify({
        graph: {
          resolutionHints: ["src"],
          resolveNodeModules: true,
        },
      }),
      "utf8",
    );

    await expect(loadCodegraphConfig(root)).rejects.toThrow(/Invalid codegraph\.config\.json/);
  });

  it("applies configured resolution hints through the CLI graph build", async () => {
    const root = await mkRepo();
    const main = path.join(root, "src", "main.ts");
    const button = path.join(root, "src", "components", "button.ts");
    await fs.mkdir(path.dirname(button), { recursive: true });
    await fs.writeFile(main, 'import Button from "components/button";\nexport { Button };\n', "utf8");
    await fs.writeFile(button, "export default function Button() {}\n", "utf8");
    await fs.writeFile(
      path.join(root, "codegraph.config.json"),
      JSON.stringify({ graph: { resolutionHints: ["src"] } }),
      "utf8",
    );

    const result = await runTsxScriptOrThrow(
      path.resolve("src", "cli.ts"),
      ["graph", "--root", root, "--json", "--stdout"],
      { cwd: root },
      "codegraph CLI",
    );
    const rawGraph = JSON.parse(result.stdout) as {
      files: string[];
      fileEdges: CompactFileGraphPayload["fileEdges"];
    };
    const graph = decompactFileGraph(rawGraph);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        raw: "components/button",
        to: expect.objectContaining({ type: "file", path: button.replace(/\\/g, "/") }),
      }),
    );
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

  it("normalizes extension keys and language IDs from codegraph.config.json", async () => {
    const root = await mkRepo();
    await writeConfig(root, {
      languages: {
        extensions: {
          ".TPL": "PHP",
        },
      },
    });

    const config = await loadCodegraphConfig(root);

    expect(config.languages?.extensions).toEqual({ ".tpl": "php" });
  });

  it("discovers uppercase custom suffixes from normalized config mappings without narrowing built-ins", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "src", "template.TPL"),
      "<?php function mapped_template() { return 1; }\n",
      "utf8",
    );
    await writeConfig(root, {
      languages: {
        extensions: {
          ".TPL": "php",
        },
      },
    });

    const index = await buildWithProjectConfig(root);

    expect(localExportNames(index, root, "src/kept.ts")).toEqual(["keptAlpha"]);
    expect(localExportNames(index, root, "src/template.TPL")).toEqual(["mapped_template"]);
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

  it("does not invalidate the per-file module cache when languageExtensions has a redundant non-dot key", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "src", "cached.tpl"),
      "<?php function cached_template() { return 1; }\n",
      "utf8",
    );

    const firstReport: BuildReport = { timings: {} };
    await buildProjectIndex(root, {
      cache: "memory",
      languageExtensions: { ".tpl": "html" },
      report: firstReport,
    });

    const secondReport: BuildReport = { timings: {} };
    await buildProjectIndex(root, {
      cache: "memory",
      languageExtensions: { ".tpl": "html", tpl: "html" },
      report: secondReport,
    });

    expect(firstReport.files?.total).toBeGreaterThan(0);
    expect(secondReport.files?.total).toBe(firstReport.files?.total);
    expect(secondReport.files?.cached).toBe(secondReport.files?.total);
    expect(secondReport.cache?.hits).toBe(secondReport.files?.total);
    expect(secondReport.cache?.misses ?? 0).toBe(0);
  });

  it("invalidates extension-aware module cache entries when the native runtime changes", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "src", "cached.tpl"),
      "<?php function cached_template() { return 1; }\n",
      "utf8",
    );

    await buildProjectIndex(root, {
      cache: "memory",
      native: "off",
      languageExtensions: { ".tpl": "php" },
    });

    const report: BuildReport = { timings: {} };
    await buildProjectIndex(root, {
      cache: "memory",
      native: "auto",
      languageExtensions: { ".tpl": "php" },
      report,
    });

    expect(report.files?.total).toBeGreaterThan(0);
    expect(report.files?.cached ?? 0).toBe(0);
    expect(report.cache?.hits ?? 0).toBe(0);
    expect(report.cache?.misses).toBe(report.files?.total);
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

  it("ignores glob metacharacter suffixes in programmatic support and cache options", () => {
    const validMapping = { ".tpl": "html" };
    const withMetacharacter = { ...validMapping, ".foo[bar]": "php" };

    expect(supportForFile("widget.foo[bar]", withMetacharacter)).toBeUndefined();
    expect(summarizeBuildOptions({ languageExtensions: withMetacharacter })).toEqual(
      summarizeBuildOptions({ languageExtensions: validMapping }),
    );
  });

  it("keeps Vue and Svelte built-in support and cache options when programmatic remaps are attempted", () => {
    const validMapping = { ".tpl": "html" };
    const withSfcRemaps = { ...validMapping, ".vue": "php", ".svelte": "php" };

    expect(supportForFile("Component.vue", withSfcRemaps)?.id).toBe("vue");
    expect(supportForFile("Component.svelte", withSfcRemaps)?.id).toBe("svelte");
    expect(summarizeBuildOptions({ languageExtensions: withSfcRemaps })).toEqual(
      summarizeBuildOptions({ languageExtensions: validMapping }),
    );
  });

  it("drops unknown language IDs while trimming and lowercasing programmatic extension mappings", () => {
    const normalized = normalizeLanguageExtensions({
      ".TPL": " HTML ",
      ".unknown": "wat",
      ".PHP": " PHP ",
    });

    expect(Object.entries(normalized ?? {})).toEqual([
      [".php", "php"],
      [".tpl", "html"],
    ]);
  });

  it("uses an uppercase valid shorter mapping after ignoring an unknown language ID", () => {
    const support = supportForFile("widget.component.tpl", {
      ".component.tpl": "wat",
      ".tpl": "HTML",
    });

    expect(support?.id).toBe("html");
  });

  it("does not discover files solely because an unknown language ID maps their extension", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "src", "template.tpl"),
      "<?php function programmatic_template() { return 1; }\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, "src", "ignored.unknown"), "ignored contents\n", "utf8");

    const index = await buildProjectIndex(root, {
      cache: "off",
      languageExtensions: {
        ".unknown": "wat",
        ".tpl": "php",
      },
    });

    expect(localExportNames(index, root, "src/template.tpl")).toContain("programmatic_template");
    expect(index.byFile.has(fileIdentityKey(path.join(root, "src/ignored.unknown")))).toBe(false);
  });

  it("ignores unknown language IDs when comparing manifest build options", () => {
    const validOnly = summarizeBuildOptions({
      languageExtensions: { ".tpl": "html" },
    });
    const withUnknownLanguage = summarizeBuildOptions({
      languageExtensions: { ".tpl": "html", ".unknown": "wat" },
    });

    expect(withUnknownLanguage).toEqual(validOnly);
    expect(
      diffBuildOptions(
        { languageExtensions: { ".tpl": "html", ".unknown": "wat" } },
        { languageExtensions: { ".tpl": "html" } },
      ),
    ).not.toContain("languageExtensions");
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

  it("rejects glob metacharacters in configured extension suffixes", async () => {
    const root = await mkRepo();
    await writeConfig(root, {
      languages: {
        extensions: {
          ".foo[bar]": "php",
        },
      },
    });

    await expect(loadCodegraphConfig(root)).rejects.toThrow(
      'languages.extensions key ".foo[bar]" must be a literal suffix containing only letters, digits, ".", "_", "+", or "-"',
    );
  });

  it.each([".vue", ".svelte"])("rejects configured remapping of the built-in %s suffix", async (extension) => {
    const root = await mkRepo();
    await writeConfig(root, {
      languages: {
        extensions: {
          [extension]: "php",
        },
      },
    });

    await expect(loadCodegraphConfig(root)).rejects.toThrow(
      `languages.extensions key "${extension}" cannot be remapped`,
    );
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
