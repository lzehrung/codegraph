import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions } from "../src/config.js";
import { searchCodegraph } from "../src/agent/search.js";

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-config-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "tests", "samples"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "kept.ts"), "export const keptAlpha = true;\n", "utf8");
  await fs.writeFile(
    path.join(root, "tests", "samples", "ignored.ts"),
    "export const ignoredZebra = true;\n",
    "utf8",
  );
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
});
