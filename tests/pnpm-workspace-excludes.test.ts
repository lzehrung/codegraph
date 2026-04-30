import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";

import { loadWorkspaceConfig } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("pnpm-workspace.yaml parsing", () => {
  it("supports ! exclude globs for workspace members", async () => {
    const root = await mkTmpDir("dg-pnpm-ws-");

    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "root", private: true }, null, 2), "utf8");

    const pnpmYaml = ["# comment line should be ignored", "packages:", "  - 'packages/*'", "  - '!packages/excluded'", ""].join("\n");
    await fsp.writeFile(path.join(root, "pnpm-workspace.yaml"), pnpmYaml, "utf8");

    const includedDir = path.join(root, "packages", "included");
    const excludedDir = path.join(root, "packages", "excluded");
    await fsp.mkdir(includedDir, { recursive: true });
    await fsp.mkdir(excludedDir, { recursive: true });

    await fsp.writeFile(path.join(includedDir, "package.json"), JSON.stringify({ name: "included" }, null, 2), "utf8");
    await fsp.writeFile(path.join(excludedDir, "package.json"), JSON.stringify({ name: "excluded" }, null, 2), "utf8");

    const cfg = await loadWorkspaceConfig(root);
    expect(cfg).toBeDefined();
    expect(cfg?.packages.has("included")).toBe(true);
    expect(cfg?.packages.has("excluded")).toBe(false);
  });

  it("handles negated and overlapping pnpm patterns", async () => {
    const root = await mkTmpDir("dg-pnpm-overlap-");

    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "root", private: true }, null, 2), "utf8");

    const pnpmYaml = ["packages:", "  - 'packages/*'", "  - 'packages/public-*'", "  - '!packages/private-*'", ""].join("\n");
    await fsp.writeFile(path.join(root, "pnpm-workspace.yaml"), pnpmYaml, "utf8");

    const publicDir = path.join(root, "packages", "public-a");
    const privateExcludedDir = path.join(root, "packages", "private-secret");
    const publicOverlapDir = path.join(root, "packages", "public-b");
    await fsp.mkdir(publicDir, { recursive: true });
    await fsp.mkdir(privateExcludedDir, { recursive: true });
    await fsp.mkdir(publicOverlapDir, { recursive: true });

    await fsp.writeFile(path.join(publicDir, "package.json"), JSON.stringify({ name: "public-a" }, null, 2), "utf8");
    await fsp.writeFile(path.join(privateExcludedDir, "package.json"), JSON.stringify({ name: "private-secret" }, null, 2), "utf8");
    await fsp.writeFile(path.join(publicOverlapDir, "package.json"), JSON.stringify({ name: "public-b" }, null, 2), "utf8");

    const cfg = await loadWorkspaceConfig(root);
    expect(cfg).toBeDefined();
    expect(cfg?.packages.has("public-a")).toBe(true);
    expect(cfg?.packages.has("private-secret")).toBe(false);
    expect(cfg?.packages.has("public-b")).toBe(true);
  });

  it("ignores malformed entries after packages block ends", async () => {
    const root = await mkTmpDir("dg-pnpm-malformed-");

    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "root", private: true }, null, 2), "utf8");

    const pnpmYaml = ["packages:", "  - 'packages/*'", "onlyBuiltDependencies:", "  - esbuild", ""].join("\n");
    await fsp.writeFile(path.join(root, "pnpm-workspace.yaml"), pnpmYaml, "utf8");

    const includedDir = path.join(root, "packages", "included");
    await fsp.mkdir(includedDir, { recursive: true });
    await fsp.writeFile(path.join(includedDir, "package.json"), JSON.stringify({ name: "included" }, null, 2), "utf8");

    const cfg = await loadWorkspaceConfig(root);
    expect(cfg).toBeDefined();
    expect(cfg?.packages.has("included")).toBe(true);
    expect(cfg?.packages.has("esbuild")).toBe(false);
  });
});
