import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawn } from "node:child_process";

const tsxCliPath = path.resolve(
  process.cwd(),
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs",
);
const sampleRoot = path.resolve(process.cwd(), "tests", "samples", "typescript");
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

function runImpactCli(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, "src/cli.ts", ...args], {
      cwd: process.cwd(),
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
    child.stdin.write(impactDiff);
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
    const stdout = await runImpactCli([
      "impact",
      sampleRoot,
      "--provider",
      "raw",
    ]);
    const report = JSON.parse(stdout) as any;
    expect(report.changedFiles).toHaveLength(1);
    expect(report.changedFiles[0]?.file).toBe("utils.ts");
  });

  it("supports pretty summaries", async () => {
    const stdout = await runImpactCli([
      "impact",
      sampleRoot,
      "--provider",
      "raw",
      "--pretty",
    ]);
    expect(stdout).toContain("Impact Analysis Report");
    expect(stdout).toContain("Changed files: 1");
    expect(stdout).toContain("Changed symbols:");
  });

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
  });
});
