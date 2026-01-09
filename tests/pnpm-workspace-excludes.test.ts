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

    await fsp.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "root", private: true }, null, 2),
      "utf8",
    );

    const pnpmYaml = [
      "# comment line should be ignored",
      "packages:",
      "  - 'packages/*'",
      "  - '!packages/excluded'",
      "",
    ].join("\n");
    await fsp.writeFile(path.join(root, "pnpm-workspace.yaml"), pnpmYaml, "utf8");

    const includedDir = path.join(root, "packages", "included");
    const excludedDir = path.join(root, "packages", "excluded");
    await fsp.mkdir(includedDir, { recursive: true });
    await fsp.mkdir(excludedDir, { recursive: true });

    await fsp.writeFile(
      path.join(includedDir, "package.json"),
      JSON.stringify({ name: "included" }, null, 2),
      "utf8",
    );
    await fsp.writeFile(
      path.join(excludedDir, "package.json"),
      JSON.stringify({ name: "excluded" }, null, 2),
      "utf8",
    );

    const cfg = await loadWorkspaceConfig(root);
    expect(cfg).toBeDefined();
    expect(cfg?.packages.has("included")).toBe(true);
    expect(cfg?.packages.has("excluded")).toBe(false);
  });
});

