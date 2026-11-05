import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { buildProjectIndex, buildGraphDelta } from "../src/index.js";
import type { IndexManifest } from "../src/indexer/build-cache.js";
import type { BuildOptions } from "../src/indexer/types.js";
import { runGit } from "./helpers/git.js";
import { createTempProjectRoot, mkTmpDir } from "./helpers/filesystem.js";

function hasFileEdge(
  edges: Array<{ from: string; to: { type: string; path?: string }; raw: string }>,
  from: string,
  toPath: string,
  raw: string,
): boolean {
  return edges.some(
    (edge) => edge.from === from && edge.to.type === "file" && edge.to.path === toPath && edge.raw === raw,
  );
}

function manifestPathFor(root: string): string {
  return path.join(root, ".codegraph", "cache", "index-v1", "manifest.json");
}

describe("Graph delta export", () => {
  it("reports added and removed edges for changed files", async () => {
    const root = await mkTmpDir("dg-graph-delta-");
    const aPath = path.join(root, "a.ts");
    const bPath = path.join(root, "b.ts");
    const cPath = path.join(root, "c.ts");

    await fsp.writeFile(aPath, `import './b';\n`, "utf8");
    await fsp.writeFile(bPath, `export const b = 1;\n`, "utf8");

    await buildProjectIndex(root, { cache: "disk", threads: 2 });

    await fsp.writeFile(aPath, `import './c';\n`, "utf8");
    await fsp.writeFile(cPath, `export const c = 2;\n`, "utf8");

    const delta = await buildGraphDelta(root, {
      cache: "disk",
      threads: 2,
      files: [aPath],
    });

    expect(delta.changedFiles).toContain("a.ts");
    expect(hasFileEdge(delta.added, "a.ts", "c.ts", "./c")).toBe(true);
    expect(hasFileEdge(delta.removed, "a.ts", "b.ts", "./b")).toBe(true);
  });

  it("reports removed edges for deleted manifest files when the manifest commit is stale", async () => {
    const root = await mkTmpDir("dg-graph-delta-stale-commit-deleted-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@example.com"]);
    runGit(root, ["config", "user.name", "Test User"]);

    const removedPath = path.join(root, "removed.ts");
    const dependencyPath = path.join(root, "dep.ts");
    await fsp.writeFile(removedPath, "import './dep';\nexport const removed = true;\n", "utf8");
    await fsp.writeFile(dependencyPath, "export const dep = true;\n", "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    await buildProjectIndex(root, { cache: "disk", logLevel: "silent", threads: 2 });
    const manifestPath = manifestPathFor(root);
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as IndexManifest;
    await fsp.writeFile(
      manifestPath,
      JSON.stringify(
        {
          ...manifest,
          lastCommit: "05a528dfce570141bfe11d066824d2bed9d72ce2",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.rm(removedPath);

    const delta = await buildGraphDelta(root, { cache: "disk", logLevel: "silent", threads: 2 });

    expect(delta.changedFiles).toContain("removed.ts");
    expect(hasFileEdge(delta.removed, "removed.ts", "dep.ts", "./dep")).toBe(true);
  });

  describe.each([false, true])("rename discovery parity (committed: %s)", (committed) => {
    it.each([
      { name: "default-ignored destination", destination: "dist/renamed.ts", discovery: undefined, included: false },
      {
        name: "configured-ignored destination",
        destination: "ignored/renamed.ts",
        discovery: { ignoreGlobs: ["ignored/**"] },
        included: false,
      },
      { name: "discovered destination", destination: "src/renamed.ts", discovery: undefined, included: true },
    ])("reports the source removal for a $name", async ({ destination, discovery, included }) => {
      const root = await mkTmpDir("dg-graph-delta-rename-discovery-");
      try {
        runGit(root, ["init"]);
        runGit(root, ["config", "user.email", "test@example.com"]);
        runGit(root, ["config", "user.name", "Test User"]);
        await fsp.writeFile(path.join(root, "a.ts"), 'import "external-package";\n');
        runGit(root, ["add", "."]);
        runGit(root, ["commit", "-m", "base"]);
        const options: BuildOptions = {
          cache: "disk",
          threads: 1,
          logLevel: "silent",
          ...(discovery ? { discovery } : {}),
        };
        const before = await buildProjectIndex(root, options);
        expect(before.byFile.size).toBe(1);
        expect(before.graph.edges).toHaveLength(1);
        await fsp.mkdir(path.dirname(path.join(root, destination)), { recursive: true });
        runGit(root, ["mv", "a.ts", destination]);
        if (committed) runGit(root, ["commit", "-m", "rename"]);
        const delta = await buildGraphDelta(root, {
          ...options,
          ...(!committed ? { gitBase: "HEAD", gitHead: "WORKTREE" } : {}),
        });
        const removed = { from: "a.ts", to: { type: "external", name: "external-package" }, raw: "external-package" };
        expect(delta.changedFiles).toEqual(["a.ts", ...(included ? [destination] : [])].sort());
        expect(delta.removed).toEqual([removed]);
        expect(delta.added).toEqual(included ? [{ ...removed, from: destination }] : []);
        const manifest = JSON.parse(await fsp.readFile(manifestPathFor(root), "utf8")) as IndexManifest;
        expect(Object.keys(manifest.files)).toEqual(included ? [destination] : []);
        const cold = await buildProjectIndex(root, { ...options, cache: "off" });
        expect(Array.from(cold.byFile.keys(), (file) => path.relative(root, file).replace(/\\/g, "/"))).toEqual(
          included ? [destination] : [],
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  it("reports exact edge changes when unchanged custom files gain or change mappings", async () => {
    const root = await mkTmpDir("dg-graph-delta-language-extensions-");
    const removedSourcePath = path.join(root, "removed.tpl");
    const addedSourcePath = path.join(root, "added.view");
    await fsp.writeFile(removedSourcePath, `import './removed-dependency';\n`, "utf8");
    await fsp.writeFile(addedSourcePath, `import './added-dependency';\n`, "utf8");
    await fsp.writeFile(path.join(root, "removed-dependency.ts"), "export const removed = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, "added-dependency.ts"), "export const added = 1;\n", "utf8");

    await buildProjectIndex(root, {
      cache: "disk",
      languageExtensions: { ".tpl": "ts" },
      logLevel: "silent",
      threads: 1,
    });

    const delta = await buildGraphDelta(root, {
      cache: "disk",
      languageExtensions: { ".tpl": "html", ".view": "ts" },
      logLevel: "silent",
      threads: 1,
    });

    expect(delta.changedFiles).toEqual(["added.view", "removed.tpl"]);
    expect(delta.added).toEqual([
      {
        from: "added.view",
        to: { type: "file", path: "added-dependency.ts" },
        raw: "./added-dependency",
      },
    ]);
    expect(delta.removed).toEqual([
      {
        from: "removed.tpl",
        to: { type: "file", path: "removed-dependency.ts" },
        raw: "./removed-dependency",
      },
    ]);
  });

  it("rejects changed files outside the project root", async () => {
    const root = await createTempProjectRoot("dg-graph-delta-root-", [
      { path: "a.ts", contents: "export const a = 1;\n" },
    ]);
    await buildProjectIndex(root, { cache: "disk", threads: 2 });

    await expect(
      buildGraphDelta(root, {
        cache: "disk",
        threads: 2,
        files: [path.resolve("README.md")],
      }),
    ).rejects.toThrow(/outside project root/);
  });
});
