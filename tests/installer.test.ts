import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectInstallTargets,
  installCodegraphTargets,
  printInstallConfig,
  uninstallCodegraphTargets,
  type InstallChange,
} from "../src/installer/registry.js";
import { captureCli } from "./helpers/cli.js";
import { mkTmpDir } from "./helpers/filesystem.js";

async function readFile(filePath: string): Promise<string> {
  return await fsp.readFile(filePath, "utf8");
}

const BUNDLED_SKILL_PATH = path.join(process.cwd(), "codegraph-skill", "codegraph", "SKILL.md");

function expectInstallerChange(changes: InstallChange[], expected: InstallChange): void {
  expect(changes).toContainEqual({ ...expected, path: normalizeExpectedPath(expected.path) });
}

function normalizeExpectedPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

const CURSOR_INSTALLER_SERVER = {
  type: "stdio",
  command: "codegraph",
  args: ["mcp", "serve", "--root", ".", "--stdio"],
};

const OPENCODE_INSTALLER_SERVER = {
  type: "local",
  enabled: true,
  command: ["codegraph", "mcp", "serve", "--root", ".", "--stdio"],
};

const JSON_UNINSTALL_PRESERVE_CASES = [
  {
    name: "Cursor mcpServers.codegraph with custom args",
    targetId: "cursor" as const,
    property: "mcpServers" as const,
    configPath: (homeDir: string) => path.join(homeDir, ".cursor", "mcp.json"),
    codegraphEntry: {
      ...CURSOR_INSTALLER_SERVER,
      args: ["mcp", "serve", "--root", "/custom-project", "--stdio"],
    },
  },
  {
    name: "Cursor mcpServers.codegraph with added env",
    targetId: "cursor" as const,
    property: "mcpServers" as const,
    configPath: (homeDir: string) => path.join(homeDir, ".cursor", "mcp.json"),
    codegraphEntry: {
      ...CURSOR_INSTALLER_SERVER,
      env: { CODEGRAPH_CONTEXT: "keep" },
    },
  },
  {
    name: "Cursor mcpServers.codegraph with an added extra key",
    targetId: "cursor" as const,
    property: "mcpServers" as const,
    configPath: (homeDir: string) => path.join(homeDir, ".cursor", "mcp.json"),
    codegraphEntry: {
      ...CURSOR_INSTALLER_SERVER,
      note: "user-owned",
    },
  },
  {
    name: "OpenCode mcp.codegraph with custom command args",
    targetId: "opencode" as const,
    property: "mcp" as const,
    configPath: (homeDir: string) => path.join(homeDir, ".config", "opencode", "opencode.json"),
    codegraphEntry: {
      ...OPENCODE_INSTALLER_SERVER,
      command: ["codegraph", "mcp", "serve", "--root", "/custom-project", "--stdio"],
    },
  },
  {
    name: "OpenCode mcp.codegraph with added env",
    targetId: "opencode" as const,
    property: "mcp" as const,
    configPath: (homeDir: string) => path.join(homeDir, ".config", "opencode", "opencode.json"),
    codegraphEntry: {
      ...OPENCODE_INSTALLER_SERVER,
      env: { CODEGRAPH_CONTEXT: "keep" },
    },
  },
  {
    name: "OpenCode mcp.codegraph with an added extra key",
    targetId: "opencode" as const,
    property: "mcp" as const,
    configPath: (homeDir: string) => path.join(homeDir, ".config", "opencode", "opencode.json"),
    codegraphEntry: {
      ...OPENCODE_INSTALLER_SERVER,
      note: "user-owned",
    },
  },
];

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

  it("rejects --print-config combined with target selection or action flags", async () => {
    const cases = [
      {
        name: "--target",
        args: ["install", "--print-config", "codex", "--target", "cursor"],
        conflict: "--target",
      },
      {
        name: "positional target after the print-config value",
        args: ["install", "--print-config", "codex", "cursor"],
        conflict: "positional targets",
      },
      {
        name: "--detect",
        args: ["install", "--print-config", "codex", "--detect"],
        conflict: "--detect",
      },
      {
        name: "--yes",
        args: ["install", "--print-config", "codex", "--yes"],
        conflict: "--yes",
      },
      {
        name: "--dry-run",
        args: ["install", "--print-config", "codex", "--dry-run"],
        conflict: "--dry-run",
      },
    ];

    for (const testCase of cases) {
      const result = await captureCli(testCase.args);

      expect(result.exitCode, testCase.name).toBe(2);
      expect(result.stdout, testCase.name).toBe("");
      expect(result.stderr, testCase.name).toContain("--print-config cannot be combined");
      expect(result.stderr, testCase.name).toContain(testCase.conflict);
      expect(result.stderr, testCase.name).not.toContain("Error:");
    }
  });

  it("rejects installer commands that combine --target with a positional target", async () => {
    const cases = [
      { name: "install", args: ["install", "--target", "codex", "cursor", "--yes"] },
      { name: "uninstall", args: ["uninstall", "--target", "codex", "cursor", "--yes"] },
    ];

    for (const testCase of cases) {
      const result = await captureCli(testCase.args);

      expect(result.exitCode, testCase.name).toBe(2);
      expect(result.stdout, testCase.name).toBe("");
      expect(result.stderr, testCase.name).toContain("Use either --target or a positional target");
      expect(result.stderr, testCase.name).not.toContain("Error:");
    }
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

  it("treats a blank XDG_CONFIG_HOME as unset for OpenCode install and uninstall", async () => {
    const homeDir = await mkTmpDir("cg-install-opencode-blank-xdg-");
    const env = { XDG_CONFIG_HOME: "   " };
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

      await uninstallCodegraphTargets({ homeDir, env, targetIds: ["opencode"], yes: true });

      await expect(fsp.stat(expectedConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fsp.stat(path.join(relativeConfigDir, "opencode.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("dry-run uninstall reports separate skill payload and marker deletes without removing installer-owned files", async () => {
    const homeDir = await mkTmpDir("cg-uninstall-skill-dry-run-");
    const skillDir = path.join(homeDir, ".agents", "skills", "codegraph");
    const installedSkillPath = path.join(skillDir, "SKILL.md");
    const markerPath = path.join(skillDir, "CODEGRAPH_INSTALLED");
    const bundledSkill = await readFile(BUNDLED_SKILL_PATH);

    await installCodegraphTargets({ homeDir, targetIds: ["agents"], yes: true });

    const result = await uninstallCodegraphTargets({ homeDir, targetIds: ["agents"], dryRun: true });

    expect(result.dryRun).toBe(true);
    expectInstallerChange(result.changes, {
      target: "agents",
      action: "delete",
      path: installedSkillPath,
      dryRun: true,
    });
    expectInstallerChange(result.changes, {
      target: "agents",
      action: "delete",
      path: markerPath,
      dryRun: true,
    });
    expect(await readFile(installedSkillPath)).toBe(bundledSkill);
    expect(await readFile(markerPath)).toContain("Agents skill directory");
  });

  it("installs the bundled skill payload and removes marker-owned payload on uninstall", async () => {
    const homeDir = await mkTmpDir("cg-install-skill-payload-");
    const skillDir = path.join(homeDir, ".agents", "skills", "codegraph");
    const installedSkillPath = path.join(skillDir, "SKILL.md");

    await installCodegraphTargets({ homeDir, targetIds: ["agents"], yes: true });

    expect(await readFile(installedSkillPath)).toBe(await readFile(BUNDLED_SKILL_PATH));
    expect(await readFile(path.join(skillDir, "CODEGRAPH_INSTALLED"))).toContain("Agents skill directory");

    const result = await uninstallCodegraphTargets({ homeDir, targetIds: ["agents"], yes: true });

    expectInstallerChange(result.changes, {
      target: "agents",
      action: "delete",
      path: installedSkillPath,
      dryRun: false,
    });
    expectInstallerChange(result.changes, {
      target: "agents",
      action: "delete",
      path: path.join(skillDir, "CODEGRAPH_INSTALLED"),
      dryRun: false,
    });
    await expect(fsp.stat(installedSkillPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.stat(path.join(skillDir, "CODEGRAPH_INSTALLED"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs and removes the bundled skill payload for a Codex MCP target without deleting user files", async () => {
    const homeDir = await mkTmpDir("cg-install-codex-skill-payload-");
    const skillDir = path.join(homeDir, ".codex", "skills", "codegraph");
    const installedSkillPath = path.join(skillDir, "SKILL.md");
    const markerPath = path.join(skillDir, "CODEGRAPH_INSTALLED");
    const userFilePath = path.join(skillDir, "notes.md");
    const userFile = "# Keep my Codex notes\n";

    await installCodegraphTargets({ homeDir, targetIds: ["codex"], yes: true });
    await fsp.writeFile(userFilePath, userFile, "utf8");

    expect(await readFile(installedSkillPath)).toBe(await readFile(BUNDLED_SKILL_PATH));
    expect(await readFile(markerPath)).toContain("Codex CLI");

    const result = await uninstallCodegraphTargets({ homeDir, targetIds: ["codex"], yes: true });

    expectInstallerChange(result.changes, {
      target: "codex",
      action: "delete",
      path: installedSkillPath,
      dryRun: false,
    });
    expectInstallerChange(result.changes, {
      target: "codex",
      action: "delete",
      path: markerPath,
      dryRun: false,
    });
    await expect(fsp.stat(installedSkillPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(userFilePath)).toBe(userFile);
  });

  it("preserves user files under installer-owned skill directory on uninstall", async () => {
    const homeDir = await mkTmpDir("cg-uninstall-skill-extra-file-");
    const skillDir = path.join(homeDir, ".agents", "skills", "codegraph");
    const installedSkillPath = path.join(skillDir, "SKILL.md");
    const markerPath = path.join(skillDir, "CODEGRAPH_INSTALLED");
    const extraDir = path.join(skillDir, "notes");
    const extraFilePath = path.join(extraDir, "README.md");
    const extraFile = "# User notes\n";

    await installCodegraphTargets({ homeDir, targetIds: ["agents"], yes: true });
    await fsp.mkdir(extraDir, { recursive: true });
    await fsp.writeFile(extraFilePath, extraFile, "utf8");

    await uninstallCodegraphTargets({ homeDir, targetIds: ["agents"], yes: true });

    await expect(fsp.stat(installedSkillPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(extraFilePath)).toBe(extraFile);
  });

  it("preserves modified installer-owned SKILL.md on uninstall", async () => {
    const homeDir = await mkTmpDir("cg-uninstall-skill-modified-");
    const skillDir = path.join(homeDir, ".agents", "skills", "codegraph");
    const installedSkillPath = path.join(skillDir, "SKILL.md");
    const markerPath = path.join(skillDir, "CODEGRAPH_INSTALLED");
    const modifiedSkill = `${await readFile(BUNDLED_SKILL_PATH)}\n# User customization\n`;

    await installCodegraphTargets({ homeDir, targetIds: ["agents"], yes: true });
    await fsp.writeFile(installedSkillPath, modifiedSkill, "utf8");

    await uninstallCodegraphTargets({ homeDir, targetIds: ["agents"], yes: true });

    expect(await readFile(installedSkillPath)).toBe(modifiedSkill);
    await expect(fsp.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an unmarked user-owned skill payload on uninstall", async () => {
    const homeDir = await mkTmpDir("cg-uninstall-user-skill-payload-");
    const skillDir = path.join(homeDir, ".agents", "skills", "codegraph");
    const installedSkillPath = path.join(skillDir, "SKILL.md");
    const userSkill = "# User maintained Codegraph skill\n";

    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(installedSkillPath, userSkill, "utf8");

    await uninstallCodegraphTargets({ homeDir, targetIds: ["agents"], yes: true });

    expect(await readFile(installedSkillPath)).toBe(userSkill);
  });

  it("surfaces non-missing installer marker access errors during uninstall", async () => {
    const homeDir = await mkTmpDir("cg-uninstall-marker-access-");
    const skillsPath = path.join(homeDir, ".cursor", "skills");

    await fsp.mkdir(path.dirname(skillsPath), { recursive: true });
    await fsp.writeFile(skillsPath, "not a directory", "utf8");

    await expect(uninstallCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true })).rejects.toThrow(
      /CODEGRAPH_INSTALLED|marker|ENOTDIR|not a directory/i,
    );
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

  it.each(JSON_UNINSTALL_PRESERVE_CASES)(
    "preserves user-owned $name on uninstall when only one dimension differs from the installer shape",
    async ({ targetId, property, configPath, codegraphEntry }) => {
      const homeDir = await mkTmpDir(`cg-install-uninstall-owned-shape-${targetId}-`);
      const targetConfigPath = configPath(homeDir);
      const otherEntry = { command: "other-tool" };

      await fsp.mkdir(path.dirname(targetConfigPath), { recursive: true });
      await fsp.writeFile(
        targetConfigPath,
        `${JSON.stringify({ [property]: { codegraph: codegraphEntry, other: otherEntry } }, null, 2)}\n`,
        "utf8",
      );

      await uninstallCodegraphTargets({ homeDir, targetIds: [targetId], yes: true });

      const parsedConfig = JSON.parse(await readFile(targetConfigPath)) as {
        mcpServers?: { codegraph?: typeof codegraphEntry; other?: typeof otherEntry };
        mcp?: { codegraph?: typeof codegraphEntry; other?: typeof otherEntry };
      };
      const servers = parsedConfig[property];
      expect(servers?.codegraph).toEqual(codegraphEntry);
      expect(servers?.other).toEqual(otherEntry);
    },
  );

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

  it("reports malformed JSON during uninstall without install-only remediation wording", async () => {
    const homeDir = await mkTmpDir("cg-uninstall-malformed-");
    const configPath = path.join(homeDir, ".cursor", "mcp.json");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, "{ not json", "utf8");

    let message = "";
    try {
      await uninstallCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/Unable to parse .*mcp\.json as JSON/);
    expect(message).not.toMatch(/before running codegraph install\b/);
  });

  it("prints direct config snippets through the library helper", async () => {
    expect(printInstallConfig({ targetId: "codex" })).toContain("startup_timeout_ms");
    expect(printInstallConfig({ targetId: "opencode" })).toContain('"type": "local"');
  });
});
