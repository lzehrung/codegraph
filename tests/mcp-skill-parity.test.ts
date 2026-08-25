import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_COMMAND_CATALOG } from "../src/cli/commandCatalog.js";
import { listCodegraphMcpTools } from "../src/mcp/tools.js";

const LEGACY_ALIAS_NAMES = new Set(["callers", "callees", "supertypes", "subtypes", "deps", "rdeps"]);
const rootDir = process.cwd();

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

  it("documents every CLI command in the CLI reference and skill", async () => {
    const [cli, skill] = await Promise.all([
      fsp.readFile(path.join(rootDir, "docs", "cli.md"), "utf8"),
      fsp.readFile(path.join(rootDir, "codegraph-skill", "codegraph", "SKILL.md"), "utf8"),
    ]);

    for (const command of CLI_COMMAND_CATALOG) {
      expect(cli.includes(command.name), `${command.name} missing from docs/cli.md`).toBe(true);
      expect(skill.includes(command.name), `${command.name} missing from codegraph-skill/codegraph/SKILL.md`).toBe(
        true,
      );
    }
  });
});
