import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_COMMAND_CATALOG, suggestCliCommands } from "../src/cli/commandCatalog.js";
import { CLI_DISPATCHABLE_COMMANDS } from "../src/cli.js";
import { captureCli } from "./helpers/cli.js";

describe("lightweight CLI entrance", () => {
  it("prints bounded task-oriented help with no arguments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-no-args-"));
    await fs.writeFile(path.join(root, "codegraph.config.json"), "{ invalid json", "utf8");

    const result = await captureCli([], { cwd: root });

    expect(result).toMatchObject({ stderr: "", exitCode: undefined });
    expect(result.stdout).toContain("Start here:");
    expect(result.stdout).toContain("codegraph orient --root . --budget small");
    expect(result.stdout).not.toContain("Commands:");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(1024);
    expect(result.stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(15);
  });

  it("groups core help and documents every command in advanced help", async () => {
    const core = await captureCli(["help"]);
    const advanced = await captureCli(["help", "advanced"]);

    expect(core).toMatchObject({ stderr: "", exitCode: undefined });
    expect(core.stdout).toContain("Core commands:");
    expect(core.stdout).toContain("codegraph help advanced");
    expect(core.stdout).not.toContain("  implementations");
    expect(advanced).toMatchObject({ stderr: "", exitCode: undefined });
    for (const command of CLI_COMMAND_CATALOG) {
      expect(advanced.stdout).toContain(`  ${command.name}`);
      expect(CLI_DISPATCHABLE_COMMANDS).toContain(command.name);
    }
  });

  it("supports help as an alias without project discovery", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-help-alias-"));
    await fs.writeFile(path.join(root, "codegraph.config.json"), "{ invalid json", "utf8");

    const topLevel = await captureCli(["help"], { cwd: root });
    const command = await captureCli(["help", "explore"], { cwd: root });

    expect(topLevel).toMatchObject({ stderr: "", exitCode: undefined });
    expect(topLevel.stdout.indexOf("Start here:")).toBeLessThan(topLevel.stdout.indexOf("Core commands:"));
    expect(command).toMatchObject({ stderr: "", exitCode: undefined });
    expect(command.stdout).toContain('Usage: codegraph explore "<query>"');
  });
  it("documents interactive and noninteractive installer consent", async () => {
    const result = await captureCli(["install", "--help"]);

    expect(result).toMatchObject({ stderr: "", exitCode: undefined });
    expect(result.stdout).toContain("Interactive terminals preview changes and ask for confirmation.");
    expect(result.stdout).toContain("Noninteractive writes require --yes");
  });

  it("prints deterministic typo suggestions without executing a command", async () => {
    const close = await captureCli(["serach"]);
    const distant = await captureCli(["completely-unrelated"]);

    expect(close).toMatchObject({ stdout: "", exitCode: 2 });
    expect(close.stderr).toBe('Unknown command "serach".\nDid you mean: search?\n');
    expect(distant).toMatchObject({ stdout: "", exitCode: 2 });
    expect(distant.stderr).toBe('Unknown command "completely-unrelated".\n');
    expect(suggestCliCommands("calers")).toEqual(["callers", "callees"]);
  });

  it("offers one task route for intent-like unknown commands", async () => {
    const result = await captureCli(["configure"]);

    expect(result).toMatchObject({ stdout: "", exitCode: 2 });
    expect(result.stderr).toContain("Try: codegraph install");
  });

  it("keeps command catalog and explicit dispatch in exact parity", () => {
    const catalogNames = CLI_COMMAND_CATALOG.map((command) => command.name);
    expect(new Set(catalogNames).size).toBe(catalogNames.length);
    expect([...catalogNames].sort()).toEqual([...CLI_DISPATCHABLE_COMMANDS].sort());
  });
});
