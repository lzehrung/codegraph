import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledCli = path.join(rootDir, "dist", "bin", "cli.js");
const unbundledCli = path.join(rootDir, "dist", "cli.js");

function run(entry: string, args: string[], cwd: string = rootDir) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

describe("bundled CLI entry", () => {
  it("ships a split ESM bin entry that matches unbundled --version", () => {
    expect(fs.existsSync(bundledCli)).toBe(true);
    expect(fs.existsSync(unbundledCli)).toBe(true);

    const bundled = run(bundledCli, ["--version"]);
    const unbundled = run(unbundledCli, ["--version"]);

    expect(bundled.status).toBe(0);
    expect(unbundled.status).toBe(0);
    expect(bundled.stdout).toBe(unbundled.stdout);
  });

  it("produces identical orient --json output for a tiny fixture", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-bundle-test-"));
    try {
      fs.writeFileSync(path.join(fixtureRoot, "package.json"), JSON.stringify({ name: "bundle-test", type: "module" }));
      fs.mkdirSync(path.join(fixtureRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, "src", "main.ts"), "export const ok = true;\n");

      const bundled = run(bundledCli, ["orient", "--root", fixtureRoot, "--budget", "small", "--json"]);
      const unbundled = run(unbundledCli, ["orient", "--root", fixtureRoot, "--budget", "small", "--json"]);

      expect(bundled.status, bundled.stderr).toBe(0);
      expect(unbundled.status, unbundled.stderr).toBe(0);
      expect(bundled.stdout).toBe(unbundled.stdout);
      expect(bundled.stdout.length).toBeGreaterThan(20);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps dynamic import split points instead of one monolithic file", () => {
    const binDir = path.dirname(bundledCli);
    const outputs = fs.readdirSync(binDir).filter((name) => name.endsWith(".js"));
    // Splitting is the contract: one monolithic file would regress startup. Exact chunk
    // counts vary with the dependency graph / esbuild version, so only require >1 output.
    expect(outputs.length).toBeGreaterThan(1);
    expect(outputs).toContain("cli.js");
    const entry = fs.readFileSync(bundledCli, "utf8");
    expect(entry).toMatch(/import\(/);
  });

  it("keeps a leading shebang so package managers can exec the bin directly", () => {
    // `node entry.js` ignores a missing shebang; npm/pnpm bin links do not.
    // Guard against the createRequire banner (or future banners) displacing it.
    const firstLine = fs.readFileSync(bundledCli, "utf8").split(/\r?\n/, 1)[0] ?? "";
    expect(firstLine).toBe("#!/usr/bin/env node");
  });
});
