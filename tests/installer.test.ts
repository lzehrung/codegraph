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

  it("requires --yes for writes", async () => {
    const homeDir = await mkTmpDir("cg-install-yes-");

    await expect(installCodegraphTargets({ homeDir, targetIds: ["codex"] })).rejects.toThrow(/--yes/);
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
