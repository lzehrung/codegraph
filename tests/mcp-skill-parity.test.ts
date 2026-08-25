import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_COMMAND_CATALOG } from "../src/cli/commandCatalog.js";
import { listCodegraphMcpTools } from "../src/mcp/tools.js";

const LEGACY_ALIAS_NAMES = new Set(["callers", "callees", "supertypes", "subtypes", "deps", "rdeps"]);
const rootDir = process.cwd();

function listedCliCommands(document: string): Set<string> {
  const commands = new Set<string>();
  for (const match of document.matchAll(/`codegraph\s+([a-z][a-z-]*)(?=\s|`|$)/g)) {
    commands.add(match[1]!);
  }
  for (const block of document.matchAll(/^```(?:bash|sh|shell)?\r?\n([\s\S]*?)^```$/gm)) {
    for (const match of block[1]!.matchAll(/^\s*codegraph\s+([a-z][a-z-]*)(?=\s|$)/gm)) {
      commands.add(match[1]!);
    }
  }
  return commands;
}

describe("MCP / SKILL inventory parity", () => {
  it("lists every non-legacy MCP_TOOLS name in the SKILL inventory", async () => {
    const skillPath = path.join(process.cwd(), "codegraph-skill", "codegraph", "SKILL.md");
    const skill = await fsp.readFile(skillPath, "utf8");
    const inventoryLine = skill
      .split(/\r?\n/)
      .find((line) => line.includes("If MCP tools are available") && line.includes("`explore`"));
    expect(inventoryLine).toBeTruthy();

    const listed = new Set(
      [...(inventoryLine?.matchAll(/`([a-z][a-z0-9_]*)`/g) ?? [])].map((match) => match[1]!).filter(Boolean),
    );

    for (const tool of listCodegraphMcpTools()) {
      expect(LEGACY_ALIAS_NAMES.has(tool.name)).toBe(false);
      expect(listed.has(tool.name), `${tool.name} missing from SKILL MCP inventory`).toBe(true);
    }
  });

  it("documents every CLI command in exact CLI examples in the reference and skill", async () => {
    const [cli, skill] = await Promise.all([
      fsp.readFile(path.join(rootDir, "docs", "cli.md"), "utf8"),
      fsp.readFile(path.join(rootDir, "codegraph-skill", "codegraph", "SKILL.md"), "utf8"),
    ]);
    const cliCommands = listedCliCommands(cli);
    const skillCommands = listedCliCommands(skill);

    for (const command of CLI_COMMAND_CATALOG) {
      expect(cliCommands.has(command.name), `${command.name} missing from docs/cli.md CLI examples`).toBe(true);
      expect(
        skillCommands.has(command.name),
        `${command.name} missing from codegraph-skill/codegraph/SKILL.md CLI examples`,
      ).toBe(true);
    }
  });
});
