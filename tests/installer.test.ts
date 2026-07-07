import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectInstallTargets,
  installCodegraphTargets,
  printInstallConfig,
  uninstallCodegraphTargets,
} from "../src/installer/registry.js";
import { captureCli } from "./helpers/cli.js";
import { mkTmpDir } from "./helpers/filesystem.js";

async function readFile(filePath: string): Promise<string> {
  return await fsp.readFile(filePath, "utf8");
}

describe("agent installer workflow", () => {
  it("detects present and missing target directories", async () => {
    const homeDir = await mkTmpDir("cg-install-detect-");
    await fsp.mkdir(path.join(homeDir, ".codex"), { recursive: true });

    const detections = await detectInstallTargets({ homeDir });
    const codex = detections.find((target) => target.configPath?.endsWith(".codex/config.toml"));
    const gemini = detections.find((target) => target.configPath?.endsWith(".gemini/settings.json"));

    expect(codex?.detected).toBeTruthy();
    expect(codex?.reason).toContain("config directory exists");
    expect(gemini?.detected).toBeFalsy();
  });

  it("auto-detect installs detected Cursor target without shifting past missing Claude", async () => {
    const homeDir = await mkTmpDir("cg-install-detect-cursor-");
    await fsp.mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await fsp.mkdir(path.join(homeDir, ".cursor"), { recursive: true });

    const result = await installCodegraphTargets({ homeDir, yes: true });

    expect(result.targets).toEqual(["codex", "cursor"]);
    const cursorConfig = JSON.parse(await readFile(path.join(homeDir, ".cursor", "mcp.json"))) as {
      mcpServers?: { codegraph?: { command?: string } };
    };
    expect(cursorConfig.mcpServers?.codegraph?.command).toBe("codegraph");
    await expect(fsp.stat(path.join(homeDir, ".claude", "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints a Codex MCP TOML snippet from the CLI", async () => {
    const result = await captureCli(["install", "--print-config", "codex"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[mcp_servers.codegraph]");
    expect(result.stdout).toContain('command = "codegraph"');
    expect(result.stdout).toContain('["mcp", "serve", "--root", ".", "--stdio"]');
  });

  it("previews install changes without writing files", async () => {
    const homeDir = await mkTmpDir("cg-install-dry-run-");
    const configPath = path.join(homeDir, ".codex", "config.toml");

    const result = await installCodegraphTargets({ homeDir, targetIds: ["codex"], dryRun: true });

    expect(result.dryRun).toBeTruthy();
    expect(result.changes.some((change) => change.path.endsWith(".codex/config.toml"))).toBeTruthy();
    await expect(fsp.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs idempotently for TOML and JSON targets", async () => {
    const homeDir = await mkTmpDir("cg-install-idempotent-");

    const first = await installCodegraphTargets({ homeDir, targetIds: ["codex", "cursor"], yes: true });
    const second = await installCodegraphTargets({ homeDir, targetIds: ["codex", "cursor"], yes: true });

    expect(first.installed).toBeTruthy();
    expect(second.changes.every((change) => change.action === "unchanged")).toBeTruthy();
    expect(await readFile(path.join(homeDir, ".codex", "config.toml"))).toContain("# >>> codegraph mcp >>>");
    const cursorConfig = JSON.parse(await readFile(path.join(homeDir, ".cursor", "mcp.json"))) as {
      mcpServers?: { codegraph?: { command?: string } };
    };
    expect(cursorConfig.mcpServers?.codegraph?.command).toBe("codegraph");
  });

  it("uses XDG_CONFIG_HOME for OpenCode config and installed marker on install and uninstall", async () => {
    const homeDir = await mkTmpDir("cg-install-opencode-home-");
    const xdgConfigHome = await mkTmpDir("cg-install-opencode-xdg-");
    const env = { XDG_CONFIG_HOME: xdgConfigHome };
    const configPath = path.join(xdgConfigHome, "opencode", "opencode.json");
    const markerPath = path.join(xdgConfigHome, "opencode", "skills", "codegraph", "CODEGRAPH_INSTALLED");
    const homeMarkerPath = path.join(homeDir, ".config", "opencode", "skills", "codegraph", "CODEGRAPH_INSTALLED");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(
      configPath,
      `${JSON.stringify({ mcp: { other: { type: "local", enabled: true, command: ["other-tool"] } } }, null, 2)}\n`,
      "utf8",
    );

    await installCodegraphTargets({ homeDir, env, targetIds: ["opencode"], yes: true });

    const installedConfig = JSON.parse(await readFile(configPath)) as {
      mcp?: { codegraph?: { command?: string[] }; other?: { command?: string[] } };
    };
    expect(installedConfig.mcp?.codegraph?.command).toEqual(["codegraph", "mcp", "serve", "--root", ".", "--stdio"]);
    expect(installedConfig.mcp?.other?.command).toEqual(["other-tool"]);
    expect(await readFile(markerPath)).toContain("OpenCode");
    await expect(fsp.stat(homeMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });

    await uninstallCodegraphTargets({ homeDir, env, targetIds: ["opencode"], yes: true });

    const remainingConfig = JSON.parse(await readFile(configPath)) as {
      mcp?: { codegraph?: { command?: string[] }; other?: { command?: string[] } };
    };
    expect(remainingConfig.mcp?.other?.command).toEqual(["other-tool"]);
    expect(remainingConfig.mcp?.codegraph).toBeUndefined();
    await expect(fsp.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.stat(homeMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a blank XDG_CONFIG_HOME as unset for OpenCode config writes", async () => {
    const homeDir = await mkTmpDir("cg-install-opencode-blank-xdg-");
    const env = { XDG_CONFIG_HOME: "" };
    const expectedConfigPath = path.join(homeDir, ".config", "opencode", "opencode.json");
    const previousCwd = process.cwd();
    const sandboxCwd = path.join(homeDir, "cwd");
    const relativeConfigDir = path.join(sandboxCwd, "opencode");

    await fsp.mkdir(sandboxCwd, { recursive: true });
    process.chdir(sandboxCwd);
    try {
      await installCodegraphTargets({ homeDir, env, targetIds: ["opencode"], yes: true });

      const installedConfig = JSON.parse(await readFile(expectedConfigPath)) as {
        mcp?: { codegraph?: { command?: string[] } };
      };
      expect(installedConfig.mcp?.codegraph?.command).toEqual(["codegraph", "mcp", "serve", "--root", ".", "--stdio"]);
      await expect(fsp.stat(path.join(relativeConfigDir, "opencode.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("uninstalls only Codegraph-owned config entries", async () => {
    const homeDir = await mkTmpDir("cg-install-uninstall-");
    const cursorConfigPath = path.join(homeDir, ".cursor", "mcp.json");
    await fsp.mkdir(path.dirname(cursorConfigPath), { recursive: true });
    await fsp.writeFile(
      cursorConfigPath,
      `${JSON.stringify({ mcpServers: { other: { command: "other-tool" } } }, null, 2)}\n`,
      "utf8",
    );

    await installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true });
    await uninstallCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true });

    const cursorConfig = JSON.parse(await readFile(cursorConfigPath)) as {
      mcpServers?: { other?: { command?: string } };
    };
    expect(cursorConfig.mcpServers?.other?.command).toBe("other-tool");
    expect(JSON.stringify(cursorConfig)).not.toContain("codegraph");
  });

  it("preserves JSON codegraph entries on uninstall unless they exactly match the installer-owned shape", async () => {
    const homeDir = await mkTmpDir("cg-install-uninstall-owned-shape-");
    const cursorConfigPath = path.join(homeDir, ".cursor", "mcp.json");
    const customCodegraphEntry = {
      type: "stdio",
      command: "codegraph",
      args: ["mcp", "serve", "--root", "/custom-project", "--stdio"],
      env: { CODEGRAPH_CONTEXT: "keep" },
      note: "user-owned",
    };
    await fsp.mkdir(path.dirname(cursorConfigPath), { recursive: true });
    await fsp.writeFile(
      cursorConfigPath,
      `${JSON.stringify(
        { mcpServers: { codegraph: customCodegraphEntry, other: { command: "other-tool" } } },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await uninstallCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true });

    const cursorConfig = JSON.parse(await readFile(cursorConfigPath)) as {
      mcpServers?: { codegraph?: typeof customCodegraphEntry; other?: { command?: string } };
    };
    expect(cursorConfig.mcpServers?.codegraph).toEqual(customCodegraphEntry);
    expect(cursorConfig.mcpServers?.other?.command).toBe("other-tool");
  });

  it("preserves a pre-existing non-Codegraph-owned mcpServers.codegraph entry on JSON install", async () => {
    const homeDir = await mkTmpDir("cg-install-json-owned-");
    const cursorConfigPath = path.join(homeDir, ".cursor", "mcp.json");
    const existingCodegraphEntry = {
      type: "stdio",
      command: "other-codegraph",
      args: ["serve"],
      env: { TOKEN: "keep" },
    };
    await fsp.mkdir(path.dirname(cursorConfigPath), { recursive: true });
    await fsp.writeFile(
      cursorConfigPath,
      `${JSON.stringify(
        { mcpServers: { codegraph: existingCodegraphEntry, other: { command: "other-tool" } } },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true });

    const cursorConfig = JSON.parse(await readFile(cursorConfigPath)) as {
      mcpServers?: { codegraph?: typeof existingCodegraphEntry; other?: { command?: string } };
    };
    expect(cursorConfig.mcpServers?.codegraph).toEqual(existingCodegraphEntry);
    expect(cursorConfig.mcpServers?.other?.command).toBe("other-tool");
  });

  it("deletes a JSON config file when uninstall removes its only Codegraph entry", async () => {
    const homeDir = await mkTmpDir("cg-install-json-delete-");
    const cursorConfigPath = path.join(homeDir, ".cursor", "mcp.json");

    await installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true });
    const installedConfig = JSON.parse(await readFile(cursorConfigPath)) as {
      mcpServers?: { codegraph?: { command?: string } };
    };
    expect(installedConfig.mcpServers?.codegraph?.command).toBe("codegraph");

    await uninstallCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true });

    await expect(fsp.stat(cursorConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires --yes for writes", async () => {
    const homeDir = await mkTmpDir("cg-install-yes-");

    await expect(installCodegraphTargets({ homeDir, targetIds: ["codex"] })).rejects.toThrow(/--yes/);
  });

  it("requires --yes for uninstall writes without an install-only message", async () => {
    const homeDir = await mkTmpDir("cg-uninstall-yes-");
    let message = "";

    try {
      await uninstallCodegraphTargets({ homeDir, targetIds: ["codex"] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/--yes/);
    expect(message).toMatch(/write/i);
    expect(message).not.toMatch(/^Install writes require --yes/);
  });

  it("fails malformed existing JSON with an actionable error", async () => {
    const homeDir = await mkTmpDir("cg-install-malformed-");
    const configPath = path.join(homeDir, ".cursor", "mcp.json");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, "{ not json", "utf8");

    await expect(installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true })).rejects.toThrow(
      /Unable to parse .*mcp\.json as JSON/,
    );
  });

  it("prints direct config snippets through the library helper", async () => {
    expect(printInstallConfig({ targetId: "codex" })).toContain("startup_timeout_ms");
    expect(printInstallConfig({ targetId: "opencode" })).toContain('"type": "local"');
  });
});
