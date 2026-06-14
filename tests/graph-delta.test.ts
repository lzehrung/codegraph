import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { buildProjectIndex, buildGraphDelta } from "../src/index.js";
import type { IndexManifest } from "../src/indexer/build-cache.js";
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
  return path.join(root, ".codegraph-cache", "index-v1", "manifest.json");
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
