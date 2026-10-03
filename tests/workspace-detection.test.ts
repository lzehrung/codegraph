import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { buildProjectIndex } from "../src/index.js";
import { clearWorkspaceCaches, loadWorkspaceConfig, resolveWorkspacePackage } from "../src/util/workspace.js";
import { globPaths } from "../src/util/glob.js";
import { isSymlinkUnavailable, readOnlySamplePath, withCopiedFixture } from "./helpers/filesystem.js";

const monorepoFixture = readOnlySamplePath("monorepo");

describe("Workspace detection modes", () => {
  it("detects workspace root from a relative subdirectory start path", async () => {
    await withCopiedFixture(
      monorepoFixture,
      async (root) => {
        const nestedDir = path.join(root, "packages", "pkg-b");
        const previousCwd = process.cwd();
        try {
          process.chdir(nestedDir);
          clearWorkspaceCaches();

          const workspaceConfig = await loadWorkspaceConfig(".");
          expect(workspaceConfig?.rootDir).toBe(root);
          expect(workspaceConfig?.packages.has("@acme/pkg-a")).toBe(true);
          await expect(resolveWorkspacePackage("@acme/pkg-a", workspaceConfig)).resolves.toBe(
            path.join(root, "packages", "pkg-a", "src", "index.ts"),
          );
        } finally {
          process.chdir(previousCwd);
          clearWorkspaceCaches();
        }
      },
      { prefix: "dg-ws-" },
    );
  });

  it("prefers package.json workspaces when multiple configs are present", async () => {
    await withCopiedFixture(
      monorepoFixture,
      async (root) => {
        const pnpmYaml = "packages:\n  - 'packages/*'\n";
        await fsp.writeFile(path.join(root, "pnpm-workspace.yaml"), pnpmYaml, "utf8");
        await fsp.writeFile(
          path.join(root, "lerna.json"),
          JSON.stringify({ packages: ["packages/*"] }, null, 2),
          "utf8",
        );

        const index = await buildProjectIndex(root);
        const files = [...index.byFile.keys()].map((file) => file.replace(/\\/g, "/"));
        expect(files.some((file) => file.includes("packages/pkg-a/src/index.ts"))).toBe(true);
        expect(files.some((file) => file.includes("packages/pkg-b/src/index.js"))).toBe(true);
      },
      { prefix: "dg-ws-" },
    );
  });

  it("detects pnpm-workspace.yaml when package.json workspaces are absent", async () => {
    await withCopiedFixture(
      monorepoFixture,
      async (root) => {
        const packagePath = path.join(root, "package.json");
        const packageJson = JSON.parse(await fsp.readFile(packagePath, "utf8")) as Record<string, unknown>;
        delete packageJson.workspaces;
        await fsp.writeFile(packagePath, JSON.stringify(packageJson, null, 2), "utf8");
        const pnpmYaml = "packages:\n  - 'packages/*'\n";
        await fsp.writeFile(path.join(root, "pnpm-workspace.yaml"), pnpmYaml, "utf8");

        const index = await buildProjectIndex(root);
        const files = [...index.byFile.keys()].map((file) => file.replace(/\\/g, "/"));
        expect(files.some((file) => file.includes("packages/pkg-a/src/index.ts"))).toBe(true);
        expect(files.some((file) => file.includes("packages/pkg-b/src/index.js"))).toBe(true);
      },
      { prefix: "dg-ws-" },
    );
  });

  it("detects lerna.json when package.json workspaces are absent", async () => {
    await withCopiedFixture(
      monorepoFixture,
      async (root) => {
        const packagePath = path.join(root, "package.json");
        const packageJson = JSON.parse(await fsp.readFile(packagePath, "utf8")) as Record<string, unknown>;
        delete packageJson.workspaces;
        await fsp.writeFile(packagePath, JSON.stringify(packageJson, null, 2), "utf8");
        await fsp.rm(path.join(root, "pnpm-workspace.yaml"), { force: true });
        await fsp.writeFile(
          path.join(root, "lerna.json"),
          JSON.stringify({ packages: ["packages/*"] }, null, 2),
          "utf8",
        );

        const index = await buildProjectIndex(root);
        const files = [...index.byFile.keys()].map((file) => file.replace(/\\/g, "/"));
        expect(files.some((file) => file.includes("packages/pkg-a/src/index.ts"))).toBe(true);
        expect(files.some((file) => file.includes("packages/pkg-b/src/index.js"))).toBe(true);
      },
      { prefix: "dg-ws-" },
    );
  });

  it("keeps each workspace package at its own path when a directory link forms a cycle", async () => {
    const root = (await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ws-cycle-")))).replace(/\\/g, "/");
    try {
      for (const name of ["a", "b"]) {
        await fsp.mkdir(path.join(root, "packages", name), { recursive: true });
        await fsp.writeFile(path.join(root, "packages", name, "package.json"), JSON.stringify({ name }));
      }
      await fsp.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["packages/**"] }),
      );
      try {
        await fsp.symlink(path.join(root, "packages"), path.join(root, "packages", "a", "loop"), "junction");
      } catch (error) {
        if (isSymlinkUnavailable(error)) return;
        throw error;
      }

      // The crawl stops at the cycle: one aliased level, not unbounded repetition.
      const found = await globPaths(["packages/**/package.json"], { cwd: root, dot: true });
      expect(found.map((file) => file.slice(root.length)).sort()).toEqual([
        "/packages/a/loop/a/package.json",
        "/packages/a/loop/b/package.json",
        "/packages/a/package.json",
        "/packages/b/package.json",
      ]);

      clearWorkspaceCaches();
      const workspace = await loadWorkspaceConfig(root);
      if (!workspace) throw new Error("expected a workspace config");
      const packagePaths = [...workspace.packages].map(([name, entry]) => [
        name,
        entry.path.replace(/\\/g, "/").slice(root.length),
      ]);
      expect(packagePaths.sort()).toEqual([
        ["a", "/packages/a"],
        ["b", "/packages/b"],
      ]);
    } finally {
      clearWorkspaceCaches();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
