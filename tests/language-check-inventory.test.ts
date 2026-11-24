import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/language-check-inventory.mjs");

type Inventory = {
  counts: { total: number; move: number; exempt: number; needsClassification: number };
  sites: Array<{ file: string; expression: string; syntax: string; status: string; category: string }>;
};

function inventory(root: string): Inventory {
  const result = spawnSync(process.execPath, [script, "--root", root], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Inventory;
}

describe("language check inventory", () => {
  it("finds language comparisons, aliases, memberships and switches without treating node IDs as languages", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-language-checks-"));
    try {
      const definitions = path.join(root, "src/languages/definitions");
      const indexer = path.join(root, "src/indexer");
      const resolution = path.join(root, "src/util/resolution");
      fs.mkdirSync(definitions, { recursive: true });
      fs.mkdirSync(indexer, { recursive: true });
      fs.mkdirSync(resolution, { recursive: true });
      fs.writeFileSync(path.join(definitions, "sample.ts"), 'const a = { id: "python" }; const b = { id: "ruby" };');
      const source = [
        'import { isJsTsLanguage } from "../languages/js-family.js";',
        'const PY = "python";',
        'const LANGS = new Set(["python", "ruby"]);',
        "function inspect(sup, support, node) {",
        "  const kind = sup.id;",
        "  const alias = kind;",
        "  const { id: extracted } = support;",
        '  if (sup.id === "python") return 1;',
        '  if ("ruby" !== support.id) return 2;',
        "  if (kind === PY) return 3;",
        '  if (alias === "python") return 4;',
        '  if (extracted === "ruby") return 5;',
        '  if (node.id === "python") return 6;',
        '  if (["python", "ruby"].includes(sup.id)) return 7;',
        "  if (LANGS.has(sup.id)) return 8;",
        '  switch (alias) { case "python": return 9; }',
        "  return isJsTsLanguage(sup.id);",
        "}",
      ].join("\n");
      const navigation = path.join(indexer, "navigation.ts");
      fs.writeFileSync(navigation, source);
      fs.writeFileSync(path.join(resolution, "php.ts"), 'function other(sup) { return sup.id === "ruby"; }');

      const first = inventory(root);
      expect(first.counts).toMatchObject({ total: 10, move: 9, exempt: 1, needsClassification: 1 });
      expect(first.sites.filter((site) => site.syntax === "comparison")).toHaveLength(6);
      expect(
        first.sites.filter((site) => site.syntax === "membership" || site.syntax === "named-membership"),
      ).toHaveLength(2);
      expect(first.sites.filter((site) => site.syntax === "switch-case")).toHaveLength(1);
      expect(first.sites.some((site) => site.expression.includes("node.id"))).toBe(false);
      expect(first.sites.find((site) => site.file === "src/util/resolution/php.ts")).toMatchObject({
        status: "move",
        category: "needs-classification",
      });

      fs.writeFileSync(navigation, source.replace('  if (alias === "python") return 4;\n', ""));
      const second = inventory(root);
      expect(second.counts.move).toBe(first.counts.move - 1);
      expect(second.counts.exempt).toBe(first.counts.exempt);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
