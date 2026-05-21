import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import fsp from "node:fs/promises";

const tsxCliPath = path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const codegraphCliPath = path.resolve(process.cwd(), "src", "cli.ts");
const sampleRoot = path.resolve(process.cwd(), "tests", "samples", "typescript");
const slowCliTimeoutMs = 30000;
const impactDiff = `diff --git a/utils.ts b/utils.ts
index 1234567..abcdef0 100644
--- a/utils.ts
+++ b/utils.ts
@@ -28,6 +28,12 @@
 
 // Default export
 export default function defaultExport(): string {
   return "default export";
 }
+
+export function impactHelper(): string {
+  return "impact helper";
+}
+
+export const IMPACT_FLAG = "impact";
`;

function runGit(root: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

function runImpactCli(args: string[], opts?: { cwd?: string; stdin?: string }) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, codegraphCliPath, ...args], {
      cwd: opts?.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    if (opts && Object.hasOwn(opts, "stdin")) {
      child.stdin.write(opts.stdin);
    } else {
      child.stdin.write(impactDiff);
    }
    child.stdin.end();
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`codegraph CLI failed (${code}). stderr:\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

describe("impact CLI output", () => {
  it("prints JSON by default", async () => {
    const stdout = await runImpactCli(["impact", sampleRoot, "--provider", "raw"]);
    const report = JSON.parse(stdout);
    expect(report.changedFiles).toHaveLength(1);
    expect(report.changedFiles[0]?.file).toBe("utils.ts");
  }, slowCliTimeoutMs);

  it("supports pretty summaries", async () => {
    const stdout = await runImpactCli(["impact", sampleRoot, "--provider", "raw", "--pretty"]);
    expect(stdout).toContain("Impact Analysis Report");
    expect(stdout).toContain("Changed files: 1");
    expect(stdout).toContain("Changed symbols:");
  }, slowCliTimeoutMs);

  it("prints reason labels in pretty impact output", async () => {
    const stdout = await runImpactCli(["impact", sampleRoot, "--provider", "raw", "--pretty"]);

    expect(stdout).toContain("Impact Analysis Report");
    expect(stdout).toContain("Changed files: 1");
    expect(stdout).toMatch(/utils\.ts: .*reason:/);
  }, slowCliTimeoutMs);

  it("accepts --compact-json as an alias for compact impact JSON", async () => {
    const stdout = await runImpactCli(["impact", sampleRoot, "--provider", "raw", "--compact-json"]);
    const report = JSON.parse(stdout) as { schemaVersion?: number; format?: string; files?: string[] };

    expect(report.schemaVersion).toBe(1);
    expect(report.format).toBe("compact");
    expect(Array.isArray(report.files)).toBe(true);
  }, slowCliTimeoutMs);

  it("rejects invalid numeric analysis options", async () => {
    await expect(runImpactCli(["impact", sampleRoot, "--provider", "raw", "--max-refs", "NaN"])).rejects.toThrow(
      /Invalid --max-refs value "NaN"/i,
    );
  }, slowCliTimeoutMs);

  it("renders Mermaid output and honors graph/cache flags", async () => {
    const stdout = await runImpactCli([
      "impact",
      sampleRoot,
      "--provider",
      "raw",
      "--mermaid",
      "--threads",
      "2",
      "--cache",
      "memory",
      "--cache-strict",
      "--fast-graph",
      "--resolve-node-modules",
    ]);
    expect(stdout).toContain("flowchart LR");
    expect(stdout).toContain("utils.ts");
    expect(stdout).not.toContain("helpers.ts");
  }, slowCliTimeoutMs);

  it("prints ASCII warnings in pretty mode for large git diffs", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-cli-warning-"));
    try {
      runGit(root, ["init"]);
      runGit(root, ["config", "user.email", "impact@test.local"]);
      runGit(root, ["config", "user.name", "Codegraph Bot"]);

      const filePath = path.join(root, "notes.txt");
      await fsp.writeFile(filePath, "seed\n", "utf8");
      runGit(root, ["add", "."]);
      runGit(root, ["commit", "-m", "initial"]);

      const largeBody = Array.from({ length: 50001 }, (_, i) => `line ${i}`).join("\n");
      await fsp.writeFile(filePath, `${largeBody}\n`, "utf8");
      runGit(root, ["add", "notes.txt"]);
      runGit(root, ["commit", "-m", "large"]);

      const base = runGit(root, ["rev-parse", "HEAD^"]);
      const head = runGit(root, ["rev-parse", "HEAD"]);

      const stdout = await runImpactCli(
        ["impact", "--root", root, "--provider", "git", "--base", base, "--head", head, "--pretty"],
        {
          cwd: root,
          stdin: "",
        },
      );

      expect(stdout).toContain("WARNING: Large diff detected");
      expect(stdout).not.toContain("⚠");
      expect(stdout).not.toContain("âš");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, slowCliTimeoutMs);
});
