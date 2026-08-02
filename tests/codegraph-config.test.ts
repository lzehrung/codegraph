import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions, mergeGraphOptions } from "../src/config.js";
import { searchCodegraph } from "../src/agent/search.js";
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
});
