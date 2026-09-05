import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NATIVE_WORKER_AUTO_FILE_THRESHOLD } from "../src/indexer/build-workers.js";
import { isNativeTreeSitterAvailable } from "../src/native/treeSitterNative.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledCli = path.join(rootDir, "dist", "bin", "cli.js");
const bundledRawQueryWorker = path.join(rootDir, "dist", "bin", "rawQueryWorker.js");
const unbundledCli = path.join(rootDir, "dist", "cli.js");

function run(entry: string, args: string[], cwd: string = rootDir, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

describe("bundled CLI entry", () => {
  it("ships a split ESM bin entry that matches unbundled --version", () => {
    expect(fs.existsSync(bundledCli)).toBe(true);
    expect(fs.existsSync(bundledRawQueryWorker)).toBe(true);
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

  it("loads externalized installer dependencies from the bundled entry", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-bundle-install-"));
    try {
      const env = {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        XDG_CONFIG_HOME: path.join(homeDir, ".config"),
      };
      const bundled = run(bundledCli, ["install", "--target", "cursor", "--dry-run", "--json"], rootDir, env);

      expect(bundled.status, bundled.stderr).toBe(0);
      expect(JSON.parse(bundled.stdout)).toMatchObject({
        dryRun: true,
        targets: ["cursor"],
      });
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps the entry-to-worker chunk relationship instead of one monolithic file", () => {
    const binDir = path.dirname(bundledCli);
    const outputs = fs
      .readdirSync(binDir)
      .filter((name) => name.endsWith(".js"))
      .sort();
    // Bundle emits exactly three self-contained entrypoints (cli + queryIndexWorker + rawQueryWorker).
    expect(outputs).toEqual(["cli.js", "queryIndexWorker.js", "rawQueryWorker.js"]);
    const entry = fs.readFileSync(bundledCli, "utf8");
    expect(entry).toContain("queryIndexWorker.js");
    expect(fs.existsSync(path.join(binDir, "queryIndexWorker.js"))).toBe(true);
    expect(fs.existsSync(path.join(binDir, "rawQueryWorker.js"))).toBe(true);
  });

  it("keeps a leading shebang so package managers can exec the bin directly", () => {
    // `node entry.js` ignores a missing shebang; npm/pnpm bin links do not.
    // Guard against the createRequire banner (or future banners) displacing it.
    const firstLine = fs.readFileSync(bundledCli, "utf8").split(/\r?\n/, 1)[0] ?? "";
    expect(firstLine).toBe("#!/usr/bin/env node");
  });
  // Dist must exist before worker-pool assertions are trusted: resolveNativeWorkerPath falls
  // back to dist/worker/nativeExtractWorker.js, and a bare vitest run does not build it.
  it.runIf(isNativeTreeSitterAvailable() && fs.existsSync(bundledCli))(
    "starts a Piscina pool from the built bundle and submits native extract work",
    () => {
      expect(fs.existsSync(path.join(rootDir, "dist", "worker", "nativeExtractWorker.js"))).toBe(true);

      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-bundle-workers-"));
      const reportFile = path.join(fixtureRoot, "report.json");
      try {
        fs.writeFileSync(
          path.join(fixtureRoot, "package.json"),
          JSON.stringify({ name: "bundle-workers", type: "module" }),
        );
        for (let index = 0; index < NATIVE_WORKER_AUTO_FILE_THRESHOLD; index += 1) {
          fs.writeFileSync(path.join(fixtureRoot, `file-${index}.ts`), `export const value${index} = ${index};\n`);
        }

        const bundled = run(bundledCli, [
          "index",
          "--root",
          fixtureRoot,
          "--cache",
          "off",
          "--report-file",
          reportFile,
        ]);
        expect(bundled.status, bundled.stderr || bundled.stdout).toBe(0);

        const report = JSON.parse(fs.readFileSync(reportFile, "utf8")) as {
          index?: {
            workerPool?: {
              enabled?: boolean;
              threads?: number;
              tasksSubmitted?: number;
              startupError?: string;
            };
            timings?: { parseMs?: number };
          };
        };
        const workerPool = report.index?.workerPool;
        expect(workerPool?.startupError).toBeUndefined();
        expect(workerPool?.enabled).toBe(true);
        expect(workerPool?.threads ?? 0).toBeGreaterThanOrEqual(1);
        expect(workerPool?.tasksSubmitted ?? 0).toBeGreaterThan(0);
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
