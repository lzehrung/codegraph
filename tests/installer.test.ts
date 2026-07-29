import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

function findDeadProcessId(): number {
  for (let pid = Math.max(process.pid + 10_000, 100_000); pid < 2_147_483_647; pid += 9_973) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && String(error.code) === "ESRCH") return pid;
      throw error;
    }
  }
  throw new Error("Unable to find an unused process ID for the stale-lock test.");
}

async function withCliHome<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  const previous = {
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CODEX_HOME;
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

  it("detects the base Agents directory without a contradictory reason", async () => {
    const homeDir = await mkTmpDir("cg-install-detect-agents-base-");
    await fsp.mkdir(path.join(homeDir, ".agents"), { recursive: true });

    const detections = await detectInstallTargets({ homeDir });
    const agentsSkillDir = normalizeExpectedPath(path.join(homeDir, ".agents", "skills", "codegraph"));
    const agents = detections.find((target) => target.skillTargetDir === agentsSkillDir);

    expect(agents?.detected).toBe(true);
    expect(agents?.reason).toContain("base directory exists");
    expect(agents?.reason).not.toMatch(/not detected/i);
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

  it("prints a non-conflicting Agents skill install command from the CLI", async () => {
    const result = await captureCli(["install", "--print-config", "agents"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toMatch(/^codegraph skill install\b/);
    expect(result.stdout).toContain("--agent agents");
    expect(result.stdout).not.toContain("--target");
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

  it("includes --detect in install and uninstall positional usage errors", async () => {
    const cases = [
      { name: "install", args: ["install", "codex", "cursor"], usage: "Usage: codegraph install" },
      { name: "uninstall", args: ["uninstall", "codex", "cursor"], usage: "Usage: codegraph uninstall" },
    ];

    for (const testCase of cases) {
      const result = await captureCli(testCase.args);

      expect(result.exitCode, testCase.name).toBe(2);
      expect(result.stdout, testCase.name).toBe("");
      expect(result.stderr, testCase.name).toContain(testCase.usage);
      expect(result.stderr, testCase.name).toContain("--detect");
    }
  });

  it("makes no-target detection explicit and actionable", async () => {
    const homeDir = await mkTmpDir("cg-install-no-targets-");
    const result = await withCliHome(homeDir, async () => await captureCli(["install", "--json"]));
    const output = JSON.parse(result.stdout) as {
      detected?: unknown[];
      installed?: boolean;
      reason?: string;
      supportedTargets?: string[];
      guidance?: string[];
    };

    expect(result).toMatchObject({ stderr: "", exitCode: undefined });
    expect(output).toMatchObject({ detected: [], installed: false, reason: "no-targets-detected" });
    expect(output.supportedTargets).toContain("cursor");
    expect(output.guidance).toContain("codegraph install --target <name> --dry-run");
  });

  it("uses the uninstall result shape and commands when no targets are detected", async () => {
    const homeDir = await mkTmpDir("cg-uninstall-no-targets-");
    const result = await withCliHome(homeDir, async () => await captureCli(["uninstall", "--json"]));
    const output = JSON.parse(result.stdout) as {
      installed?: boolean;
      uninstalled?: boolean;
      guidance?: string[];
    };

    expect(result).toMatchObject({ stderr: "", exitCode: undefined });
    expect(output.uninstalled).toBe(false);
    expect(output).not.toHaveProperty("installed");
    expect(output.guidance).toContain("codegraph uninstall --target <name> --dry-run");
    expect(output.guidance).toContain("codegraph uninstall --target <name> --yes");
  });

  it("requires --yes for noninteractive writes and prints copyable commands", async () => {
    const homeDir = await mkTmpDir("cg-install-noninteractive-");
    const result = await withCliHome(homeDir, async () => await captureCli(["install", "--target", "cursor"]));

    expect(result).toMatchObject({ stdout: "", exitCode: 2 });
    expect(result.stderr).toContain("Non-interactive install requires --yes.");
    expect(result.stderr).toContain("codegraph install --target cursor --dry-run");
    expect(result.stderr).toContain("codegraph install --target cursor --yes");
    await expect(fsp.stat(path.join(homeDir, ".cursor", "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { name: "no", input: "n\n" },
    { name: "blank", input: "\n" },
    { name: "EOF", input: "" },
  ])("previews and declines interactive install on $name", async ({ input }) => {
    const homeDir = await mkTmpDir("cg-install-decline-");
    const result = await withCliHome(
      homeDir,
      async () =>
        await captureCli(["install", "--target", "cursor"], {
          stdin: input,
          stdinIsTTY: true,
          stderrIsTTY: true,
        }),
    );

    expect(result).toMatchObject({ stdout: "No changes applied.\n", exitCode: undefined });
    expect(result.stderr).toContain("Proposed changes:");
    expect(result.stderr).toContain("Configure Codegraph for 1 target(s)? [y/N]");
    await expect(fsp.stat(path.join(homeDir, ".cursor", "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["install", "uninstall"] as const)("keeps declined %s JSON command-specific", async (command) => {
    const homeDir = await mkTmpDir(`cg-${command}-decline-json-`);
    const result = await withCliHome(
      homeDir,
      async () =>
        await captureCli([command, "--target", "cursor", "--json"], {
          stdin: "n\n",
          stdinIsTTY: true,
          stderrIsTTY: true,
        }),
    );
    const output = JSON.parse(result.stdout) as { installed?: boolean; uninstalled?: boolean };

    expect(output[command === "install" ? "installed" : "uninstalled"]).toBe(false);
    expect(output).not.toHaveProperty(command === "install" ? "uninstalled" : "installed");
  });

  it("treats an interrupted interactive prompt as decline", async () => {
    const homeDir = await mkTmpDir("cg-install-interrupt-");
    const result = await withCliHome(
      homeDir,
      async () =>
        await captureCli(["install", "--target", "cursor"], {
          stdin: () => {
            throw new Error("interrupt");
          },
          stdinIsTTY: true,
          stderrIsTTY: true,
        }),
    );

    expect(result).toMatchObject({ stdout: "No changes applied.\n", exitCode: undefined });
    await expect(fsp.stat(path.join(homeDir, ".cursor", "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("confirms, verifies, and reports bounded health and completion guidance", async () => {
    const homeDir = await mkTmpDir("cg-install-confirm-");
    const result = await withCliHome(
      homeDir,
      async () =>
        await captureCli(["install", "--target", "cursor", "--json"], {
          stdin: "YES\n",
          stdinIsTTY: true,
          stderrIsTTY: true,
        }),
    );
    const output = JSON.parse(result.stdout) as {
      installed?: boolean;
      verified?: boolean;
      health?: { version?: string; nativeAvailable?: boolean };
      guidance?: string[];
    };

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toContain("Proposed changes:");
    expect(output).toMatchObject({ installed: true, verified: true });
    expect(output.health?.version).toMatch(/^\d+\.\d+\.\d+/u);
    expect(output.guidance?.join("\n")).toContain("Restart or reload cursor");
    expect(output.guidance?.join("\n")).not.toContain("connected");
    expect(JSON.parse(await readFile(path.join(homeDir, ".cursor", "mcp.json")))).toMatchObject({
      mcpServers: { codegraph: CURSOR_INSTALLER_SERVER },
    });
  });

  it("preserves explicit --yes and --dry-run automation", async () => {
    const homeDir = await mkTmpDir("cg-install-automation-");
    const preview = await withCliHome(
      homeDir,
      async () => await captureCli(["install", "--target", "cursor", "--dry-run", "--json"]),
    );
    const previewOutput = JSON.parse(preview.stdout) as {
      dryRun?: boolean;
      guidance?: string[];
      verified?: boolean;
    };
    expect(previewOutput).toMatchObject({ dryRun: true, verified: false });
    expect(previewOutput.guidance).toBeUndefined();
    await expect(fsp.stat(path.join(homeDir, ".cursor", "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const applied = await withCliHome(
      homeDir,
      async () => await captureCli(["install", "--target", "cursor", "--yes", "--json"]),
    );
    expect(JSON.parse(applied.stdout)).toMatchObject({ dryRun: false, verified: true });
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
    expect(first.verified).toBe(true);
    expect(second.verified).toBe(true);
    expect(await readFile(path.join(homeDir, ".codex", "config.toml"))).toContain("# >>> codegraph mcp >>>");
    const cursorConfig = JSON.parse(await readFile(path.join(homeDir, ".cursor", "mcp.json"))) as {
      mcpServers?: { codegraph?: { command?: string } };
    };
    expect(cursorConfig.mcpServers?.codegraph?.command).toBe("codegraph");
  });

  it("rejects an unowned Codex table without writing installer files", async () => {
    const homeDir = await mkTmpDir("cg-install-codex-unowned-");
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const original = Buffer.from(
      '[mcp_servers.codegraph]\r\ncommand = "user-codegraph"\r\nargs = ["mcp", "serve"]\r\n',
      "utf8",
    );
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, original);

    await expect(installCodegraphTargets({ homeDir, targetIds: ["codex"], yes: true })).rejects.toThrow(
      /User-owned Codegraph MCP table already exists/u,
    );

    await expect(fsp.readFile(configPath)).resolves.toEqual(original);
    await expect(fsp.stat(path.join(homeDir, ".codex", "skills", "codegraph", "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["a missing end marker", "# >>> codegraph mcp >>>\n[mcp_servers.codegraph]\n"],
    ["a missing begin marker", "[mcp_servers.codegraph]\n# <<< codegraph mcp <<<\n"],
    [
      "duplicate owned marker blocks",
      "# >>> codegraph mcp >>>\n[mcp_servers.codegraph]\n# <<< codegraph mcp <<<\n# >>> codegraph mcp >>>\n[mcp_servers.codegraph]\n# <<< codegraph mcp <<<\n",
    ],
  ])("rejects Codex configs with %s before writing", async (_description, original) => {
    const homeDir = await mkTmpDir("cg-install-codex-marker-");
    const configPath = path.join(homeDir, ".codex", "config.toml");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, original, "utf8");

    await expect(installCodegraphTargets({ homeDir, targetIds: ["codex"], yes: true })).rejects.toThrow(
      /incomplete or malformed Codegraph installer marker block/u,
    );

    await expect(readFile(configPath)).resolves.toBe(original);
    await expect(fsp.stat(path.join(homeDir, ".codex", "skills", "codegraph", "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preflights a later collision before changing an earlier target", async () => {
    const homeDir = await mkTmpDir("cg-install-preflight-all-");
    const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
    const originalCodexConfig = Buffer.from("# Preserve exact Codex bytes\r\n", "utf8");
    const cursorConfigPath = path.join(homeDir, ".cursor", "mcp.json");
    await fsp.mkdir(path.dirname(codexConfigPath), { recursive: true });
    await fsp.writeFile(codexConfigPath, originalCodexConfig);
    await fsp.mkdir(path.dirname(cursorConfigPath), { recursive: true });
    await fsp.writeFile(
      cursorConfigPath,
      `${JSON.stringify({ mcpServers: { codegraph: { command: "user-codegraph" } } }, null, 2)}\n`,
      "utf8",
    );

    await expect(installCodegraphTargets({ homeDir, targetIds: ["codex", "cursor"], yes: true })).rejects.toThrow(
      /User-owned Codegraph MCP entry already exists/u,
    );

    await expect(fsp.readFile(codexConfigPath)).resolves.toEqual(originalCodexConfig);
    await expect(fsp.stat(path.join(homeDir, ".codex", "skills", "codegraph", "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fsp.stat(path.join(homeDir, ".codex", "skills", "codegraph", "CODEGRAPH_INSTALLED")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rolls back every earlier target after an injected later write failure", async () => {
    const homeDir = await mkTmpDir("cg-install-rollback-write-");
    const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
    const cursorConfigPath = path.join(homeDir, ".cursor", "mcp.json");
    const originalCodexConfig = Buffer.from("# Preserve exact Codex bytes\r\n", "utf8");
    await fsp.mkdir(path.dirname(codexConfigPath), { recursive: true });
    await fsp.writeFile(codexConfigPath, originalCodexConfig, { mode: 0o640 });

    const originalRename = fsp.rename.bind(fsp);
    const rename = vi.spyOn(fsp, "rename").mockImplementation(async (source, target) => {
      if (path.resolve(String(target)) === path.resolve(cursorConfigPath)) {
        throw Object.assign(new Error("injected later-target failure"), { code: "EIO" });
      }
      await originalRename(source, target);
    });
    try {
      await expect(installCodegraphTargets({ homeDir, targetIds: ["codex", "cursor"], yes: true })).rejects.toThrow(
        /injected later-target failure/u,
      );
    } finally {
      rename.mockRestore();
    }

    await expect(fsp.readFile(codexConfigPath)).resolves.toEqual(originalCodexConfig);
    if (process.platform !== "win32") {
      expect((await fsp.stat(codexConfigPath)).mode & 0o777).toBe(0o640);
    }
    for (const targetPath of [
      path.join(homeDir, ".codex", "skills", "codegraph", "SKILL.md"),
      path.join(homeDir, ".codex", "skills", "codegraph", "CODEGRAPH_INSTALLED"),
      path.join(homeDir, ".cursor", "skills", "codegraph", "SKILL.md"),
      path.join(homeDir, ".cursor", "skills", "codegraph", "CODEGRAPH_INSTALLED"),
      cursorConfigPath,
    ]) {
      await expect(fsp.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each([
    { name: "config", destinationForHome: (homeDir: string) => path.join(homeDir, ".cursor", "mcp.json") },
    {
      name: "skill",
      destinationForHome: (homeDir: string) => path.join(homeDir, ".cursor", "skills", "codegraph", "SKILL.md"),
    },
    {
      name: "marker",
      destinationForHome: (homeDir: string) =>
        path.join(homeDir, ".cursor", "skills", "codegraph", "CODEGRAPH_INSTALLED"),
    },
  ])("rejects a symlinked Cursor $name path", async ({ destinationForHome }) => {
    const homeDir = await mkTmpDir("cg-install-symlink-");
    const linkedPath = destinationForHome(homeDir);
    const linkedTarget = path.join(homeDir, "linked-target");
    await fsp.writeFile(linkedTarget, "user-owned target\n", "utf8");
    await fsp.mkdir(path.dirname(linkedPath), { recursive: true });
    try {
      await fsp.symlink(linkedTarget, linkedPath, "file");
    } catch (error) {
      if (error instanceof Error && "code" in error && String(error.code) === "EPERM") return;
      throw error;
    }

    await expect(installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true })).rejects.toThrow(
      normalizeExpectedPath(linkedPath),
    );

    expect((await fsp.lstat(linkedPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(linkedTarget)).resolves.toBe("user-owned target\n");
  });

  it("reclaims an abandoned transaction lock held by a dead PID", async () => {
    const homeDir = await mkTmpDir("cg-install-stale-lock-");
    const scope = path.resolve(homeDir);
    const lockPath = path.join(
      os.tmpdir(),
      `codegraph-installer-${createHash("sha256").update(scope).digest("hex")}.lock`,
    );
    await fsp.mkdir(lockPath);
    await fsp.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        owner: "abandoned-owner",
        pid: findDeadProcessId(),
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      })}\n`,
      "utf8",
    );
    try {
      await expect(installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true })).resolves.toMatchObject({
        installed: true,
        verified: true,
      });
    } finally {
      await fsp.rm(lockPath, { recursive: true, force: true });
    }
    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims a legacy abandoned file lease", async () => {
    const homeDir = await mkTmpDir("cg-install-legacy-lock-");
    const scope = path.resolve(homeDir);
    const lockPath = path.join(
      os.tmpdir(),
      `codegraph-installer-${createHash("sha256").update(scope).digest("hex")}.lock`,
    );
    await fsp.writeFile(
      lockPath,
      `${JSON.stringify({
        owner: "legacy-abandoned-owner",
        pid: findDeadProcessId(),
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      })}\n`,
      "utf8",
    );
    try {
      await expect(installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true })).resolves.toMatchObject({
        installed: true,
        verified: true,
      });
    } finally {
      await fsp.rm(lockPath, { recursive: true, force: true });
    }
    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent installers while reclaiming an abandoned lease", async () => {
    const homeDir = await mkTmpDir("cg-install-stale-lock-concurrent-");
    const scope = path.resolve(homeDir);
    const lockPath = path.join(
      os.tmpdir(),
      `codegraph-installer-${createHash("sha256").update(scope).digest("hex")}.lock`,
    );
    await fsp.mkdir(lockPath);
    await fsp.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        owner: "abandoned-owner",
        pid: findDeadProcessId(),
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      })}\n`,
      "utf8",
    );

    try {
      const results = await Promise.all([
        installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true }),
        installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true }),
      ]);
      expect(results.every((result) => result.verified)).toBe(true);
    } finally {
      await fsp.rm(lockPath, { recursive: true, force: true });
    }
    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records owner, PID, and lease metadata while an install holds transaction and file locks", async () => {
    const homeDir = await mkTmpDir("cg-install-lock-metadata-");
    const scope = path.resolve(homeDir);
    const transactionLockPath = path.join(
      os.tmpdir(),
      `codegraph-installer-${createHash("sha256").update(scope).digest("hex")}.lock`,
    );
    const skillPath = path.join(homeDir, ".cursor", "skills", "codegraph", "SKILL.md");
    const fileLockPath = `${skillPath}.codegraph-lock`;
    const originalRename = fsp.rename.bind(fsp);
    let observedTransactionLock = "";
    let observedFileLock = "";
    const rename = vi.spyOn(fsp, "rename").mockImplementation(async (source, target) => {
      if (path.resolve(String(target)) === path.resolve(skillPath)) {
        observedTransactionLock = await readFile(path.join(transactionLockPath, "owner.json"));
        observedFileLock = await readFile(path.join(fileLockPath, "owner.json"));
      }
      await originalRename(source, target);
    });
    try {
      await installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true });
    } finally {
      rename.mockRestore();
    }

    for (const lock of [observedTransactionLock, observedFileLock]) {
      expect(lock).toContain('"owner"');
      expect(lock).toContain(`"pid":${process.pid}`);
      expect(lock).toContain('"leaseExpiresAt"');
    }
    await expect(fsp.stat(transactionLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.stat(fileLockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps concurrent installer attempts atomic and verified", async () => {
    const homeDir = await mkTmpDir("cg-install-concurrent-");

    const [left, right] = await Promise.all([
      installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true }),
      installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true }),
    ]);

    expect(left.verified).toBe(true);
    expect(right.verified).toBe(true);
    const configDir = path.join(homeDir, ".cursor");
    const config = JSON.parse(await readFile(path.join(configDir, "mcp.json"))) as {
      mcpServers?: { codegraph?: { command?: string } };
    };
    expect(config.mcpServers?.codegraph?.command).toBe("codegraph");
    expect((await fsp.readdir(configDir)).filter((entry) => entry.includes(".codegraph-tmp-"))).toEqual([]);
  });
  it("keeps an existing config path present until atomic replacement", async () => {
    const homeDir = await mkTmpDir("cg-install-atomic-existing-");
    const configPath = path.join(homeDir, ".cursor", "mcp.json");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, '{"mcpServers":{"other":{"command":"other-tool"}}}\n', "utf8");
    const originalRename = fsp.rename.bind(fsp);
    const rename = vi.spyOn(fsp, "rename").mockImplementation(async (source, target) => {
      if (path.resolve(String(target)) === path.resolve(configPath)) {
        expect((await fsp.stat(configPath)).isFile()).toBe(true);
      }
      await originalRename(source, target);
    });
    try {
      await installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true });
    } finally {
      rename.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")("preserves restrictive existing config permissions", async () => {
    const homeDir = await mkTmpDir("cg-install-mode-");
    const configPath = path.join(homeDir, ".cursor", "mcp.json");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, '{"mcpServers":{"other":{"command":"other-tool"}}}\n', { mode: 0o600 });

    await installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true });

    expect((await fsp.stat(configPath)).mode & 0o777).toBe(0o600);
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

    await installCodegraphTargets({ homeDir, env: {}, targetIds: ["codex"], yes: true });
    await fsp.writeFile(userFilePath, userFile, "utf8");

    expect(await readFile(installedSkillPath)).toBe(await readFile(BUNDLED_SKILL_PATH));
    expect(await readFile(markerPath)).toContain("Codex CLI");

    const result = await uninstallCodegraphTargets({ homeDir, env: {}, targetIds: ["codex"], yes: true });

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

  it("rejects a pre-existing non-Codegraph-owned mcpServers.codegraph entry before writing", async () => {
    const homeDir = await mkTmpDir("cg-install-json-owned-");
    const cursorConfigPath = path.join(homeDir, ".cursor", "mcp.json");
    const existingCodegraphEntry = {
      type: "stdio",
      command: "other-codegraph",
      args: ["serve"],
      env: { TOKEN: "keep" },
    };
    const originalConfig = `${JSON.stringify(
      { mcpServers: { codegraph: existingCodegraphEntry, other: { command: "other-tool" } } },
      null,
      2,
    )}\n`;
    await fsp.mkdir(path.dirname(cursorConfigPath), { recursive: true });
    await fsp.writeFile(cursorConfigPath, originalConfig, "utf8");

    await expect(installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true })).rejects.toThrow(
      /User-owned Codegraph MCP entry already exists/u,
    );

    await expect(readFile(cursorConfigPath)).resolves.toBe(originalConfig);
    await expect(fsp.stat(path.join(homeDir, ".cursor", "skills", "codegraph", "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  it("preflights every uninstall target before mutating earlier targets", async () => {
    const homeDir = await mkTmpDir("cg-uninstall-transaction-");
    await installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true });
    const cursorConfigPath = path.join(homeDir, ".cursor", "mcp.json");
    const cursorSkillPath = path.join(homeDir, ".cursor", "skills", "codegraph", "SKILL.md");
    const cursorConfigBefore = await fsp.readFile(cursorConfigPath);
    const cursorSkillBefore = await fsp.readFile(cursorSkillPath);
    const claudeConfigPath = path.join(homeDir, ".claude", "mcp.json");
    await fsp.mkdir(path.dirname(claudeConfigPath), { recursive: true });
    await fsp.writeFile(claudeConfigPath, "{ not json", "utf8");

    await expect(uninstallCodegraphTargets({ homeDir, targetIds: ["cursor", "claude"], yes: true })).rejects.toThrow(
      /Unable to parse .*\.claude.*mcp\.json as JSON/,
    );

    expect(await fsp.readFile(cursorConfigPath)).toEqual(cursorConfigBefore);
    expect(await fsp.readFile(cursorSkillPath)).toEqual(cursorSkillBefore);
  });

  it("reports permission failures with the exact user-owned path", async () => {
    const homeDir = await mkTmpDir("cg-install-permission-");
    const skillPath = path.join(homeDir, ".cursor", "skills", "codegraph", "SKILL.md");
    const originalRename = fsp.rename.bind(fsp);
    const rename = vi.spyOn(fsp, "rename").mockImplementation(async (source, target) => {
      if (path.resolve(String(target)) === path.resolve(skillPath)) {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      await originalRename(source, target);
    });
    try {
      await expect(installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true })).rejects.toThrow(
        normalizeExpectedPath(path.join(homeDir, ".cursor", "skills", "codegraph", "SKILL.md")),
      );
    } finally {
      rename.mockRestore();
    }
  });
  it("retries a transient atomic replace failure", async () => {
    const homeDir = await mkTmpDir("cg-install-transient-rename-");
    const skillPath = path.join(homeDir, ".cursor", "skills", "codegraph", "SKILL.md");
    const originalRename = fsp.rename.bind(fsp);
    let rejected = false;
    const rename = vi.spyOn(fsp, "rename").mockImplementation(async (source, target) => {
      if (!rejected && path.resolve(String(target)) === path.resolve(skillPath)) {
        rejected = true;
        throw Object.assign(new Error("busy"), { code: "EPERM" });
      }
      await originalRename(source, target);
    });
    try {
      await expect(installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true })).resolves.toMatchObject({
        installed: true,
        verified: true,
      });
    } finally {
      rename.mockRestore();
    }
  });

  it("fails when post-write owned-state verification detects drift", async () => {
    const homeDir = await mkTmpDir("cg-install-verify-failure-");
    const configPath = path.join(homeDir, ".cursor", "mcp.json");
    const originalConfig = Buffer.from('{"mcpServers":{"other":{"command":"other-tool"}}}\r\n', "utf8");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, originalConfig);
    const originalRename = fsp.rename.bind(fsp);
    let injectedDrift = false;
    const rename = vi.spyOn(fsp, "rename").mockImplementation(async (source, target) => {
      await originalRename(source, target);
      if (!injectedDrift && path.resolve(String(target)) === path.resolve(configPath)) {
        injectedDrift = true;
        await fsp.writeFile(configPath, "{}\n", "utf8");
      }
    });
    try {
      await expect(installCodegraphTargets({ homeDir, targetIds: ["cursor"], yes: true })).rejects.toThrow(
        /installer config verification failed/u,
      );
    } finally {
      rename.mockRestore();
    }
    await expect(fsp.readFile(configPath)).resolves.toEqual(originalConfig);
    for (const targetPath of [
      path.join(homeDir, ".cursor", "skills", "codegraph", "SKILL.md"),
      path.join(homeDir, ".cursor", "skills", "codegraph", "CODEGRAPH_INSTALLED"),
    ]) {
      await expect(fsp.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("prints direct config snippets through the library helper", async () => {
    expect(printInstallConfig({ targetId: "codex" })).toContain("startup_timeout_ms");
    expect(printInstallConfig({ targetId: "opencode" })).toContain('"type": "local"');
  });
});
