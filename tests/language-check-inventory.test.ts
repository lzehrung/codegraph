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

function runMode(root: string, mode: "--check" | "--write-baseline") {
  return spawnSync(process.execPath, [script, "--root", root, mode], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

function withBaseline(test: (root: string, source: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-language-ratchet-"));
  const source = path.join(root, "src/indexer/navigation.ts");
  try {
    fs.mkdirSync(path.join(root, "src/languages/definitions"), { recursive: true });
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/languages/definitions/sample.ts"),
      'const python = { id: "python" }; const rust = { id: "rust" };',
    );
    fs.writeFileSync(
      source,
      [
        'function first(sup) { if (sup.id === "python") return 1; }',
        'function second(sup) { return sup.id !== "python"; }',
      ].join("\n"),
    );
    const generated = runMode(root, "--write-baseline");
    expect(generated.status, generated.stderr).toBe(0);
    test(root, source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

  it("rejects a new shared check and refuses to regenerate it into the baseline", () => {
    withBaseline((root, source) => {
      fs.appendFileSync(source, '\nfunction added(sup) { if (sup.id === "rust") return 3; }');
      for (const mode of ["--check", "--write-baseline"] as const) {
        const result = runMode(root, mode);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("New non-exempt inline language checks:");
        expect(result.stderr).toContain("src/indexer/navigation.ts:3");
        expect(result.stderr).toContain('sup . id === "rust"');
        expect(result.stderr).toContain("do not baseline new checks");
      }
    });
  });

  it("preserves identities across reordering, line moves, comments, whitespace and quote changes", () => {
    withBaseline((root, source) => {
      fs.writeFileSync(
        source,
        [
          "// Unrelated lines and reordered functions do not change site identity.",
          "",
          "function second(sup) { return sup.id !== 'python'; }",
          "",
          "function first(sup) {",
          "  if (sup.id /* grammar */ ===",
          "      'python') return 1;",
          "}",
        ].join("\n"),
      );
      const result = runMode(root, "--check");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("2 sites, 2 fingerprints");
    });
  });

  it("requires regeneration for removed sites and writes only the remaining sites", () => {
    withBaseline((root, source) => {
      fs.writeFileSync(source, 'function first(sup) { if (sup.id === "python") return 1; }');
      const stale = runMode(root, "--check");
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("Retired language-check baseline entries:");
      expect(stale.stderr).toContain("node scripts/language-check-inventory.mjs --write-baseline");
      expect(runMode(root, "--write-baseline").status).toBe(0);
      const result = runMode(root, "--check");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("1 sites, 1 fingerprints");
    });
  });

  it("allows exempt family calls and exact parser guards, not unrelated checks in exempt files", () => {
    withBaseline((root, source) => {
      fs.appendFileSync(
        source,
        '\nimport { isJsTsLanguage } from "../languages/js-family.js";\nfunction family(sup) { return isJsTsLanguage(sup.id); }',
      );
      const policy = path.join(root, "src/indexer/member-lookup-policies/cpp-receiver.ts");
      fs.mkdirSync(path.dirname(policy), { recursive: true });
      fs.writeFileSync(policy, 'function cppOutOfLineOwnerPath(support) { if (support.id !== "cpp") return null; }');
      const definitions = path.join(root, "src/languages/definitions/sample.ts");
      fs.appendFileSync(definitions, 'const cpp = { id: "cpp" };');
      const result = runMode(root, "--check");
      expect(result.status, result.stderr).toBe(0);
      fs.appendFileSync(policy, '\nfunction other(sup) { return sup.id === "rust"; }');
      const unrelated = runMode(root, "--check");
      expect(unrelated.status).toBe(1);
      expect(unrelated.stderr).toContain("src/indexer/member-lookup-policies/cpp-receiver.ts:2");
    });
  });

  it("counts identical occurrences instead of allowing duplicate checks through a set", () => {
    withBaseline((root, source) => {
      const original = fs.readFileSync(source, "utf8");
      fs.writeFileSync(
        source,
        original.replace(
          'if (sup.id === "python") return 1;',
          'if (sup.id === "python") return 1; if (sup.id === "python") return 2;',
        ),
      );
      const result = runMode(root, "--check");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("1 new site(s)");
    });
  });

  it("fingerprints the whole enclosing condition without the inventory display truncation", () => {
    withBaseline((root, source) => {
      // Start a separate initial baseline for a deliberately long condition.
      fs.rmSync(path.join(root, "scripts/language-check-baseline.json"));
      const prefix = Array.from({ length: 100 }, (_, i) => `guard${i}`).join(" && ");
      fs.writeFileSync(source, `function first(sup) { if (${prefix} && sup.id === "python") return 1; }`);
      expect(runMode(root, "--write-baseline").status).toBe(0);
      fs.writeFileSync(source, `function first(sup) { if (${prefix} && sup.id === "rust") return 1; }`);
      const result = runMode(root, "--check");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('sup . id === "rust"');
    });
  });
});
