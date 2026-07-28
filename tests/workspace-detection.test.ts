import { describe, expect, it } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { buildProjectIndex } from "../src/index.js";
import { clearWorkspaceCaches, loadWorkspaceConfig, resolveWorkspacePackage } from "../src/util/workspace.js";
import { readOnlySamplePath, withCopiedFixture } from "./helpers/filesystem.js";

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
});
