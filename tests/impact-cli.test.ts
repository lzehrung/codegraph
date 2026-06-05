import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import fsp from "node:fs/promises";
import { runCli } from "../src/cli.js";
import { runGit } from "./helpers/git.js";

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

function stdinForImpactCli(opts?: { stdin?: string }): string {
  if (opts && Object.hasOwn(opts, "stdin")) return opts.stdin ?? "";
  return impactDiff;
}

async function runImpactCli(args: string[], opts?: { cwd?: string; stdin?: string }): Promise<string> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;

  try {
    await runCli(args, {
      cwd: () => opts?.cwd ?? process.cwd(),
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
      readStdin: async () => stdinForImpactCli(opts),
      exit: (code) => {
        exitCode = code;
        throw new Error(`codegraph CLI exited ${code}`);
      },
    });
  } catch (error) {
    if (exitCode !== undefined) {
      throw new Error(`codegraph CLI failed (${exitCode}). stderr:\n${stderr}`);
    }
    throw error;
  }

  return stdout;
}

async function runCodegraphCli(args: string[], opts?: { cwd?: string; stdin?: string }): Promise<string> {
  const result = await runCodegraphCliResult(args, opts);
  return result.stdout;
}

async function runCodegraphCliResult(
  args: string[],
  opts?: { cwd?: string; stdin?: string },
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;

  try {
    await runCli(args, {
      cwd: () => opts?.cwd ?? process.cwd(),
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
      readStdin: async () => opts?.stdin ?? "",
      exit: (code) => {
        exitCode = code;
        throw new Error(`codegraph CLI exited ${code}`);
      },
    });
  } catch (error) {
    if (exitCode !== undefined) {
      throw new Error(`codegraph CLI failed (${exitCode}). stderr:\n${stderr}`);
    }
    throw error;
  }

  return { stdout, stderr };
}

function runImpactCliSubprocess(args: string[], opts?: { cwd?: string; stdin?: string }) {
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
    child.stdin.write(stdinForImpactCli(opts));
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
  async function createCallCompatibilityFixture(restSignature = false): Promise<{ root: string; diffText: string }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-cli-call-"));
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    const apiFile = path.join(root, "src", "api.ts");
    const mainFile = path.join(root, "src", "main.ts");
    const newSignature = restSignature
      ? "export function helper(a: string, ...rest: string[]) { return rest.join(a); }\n"
      : "export function helper(a: string, b: number) { return a + b; }\n";
    const call = restSignature ? 'helper("x", "y", "z")' : 'helper("x")';
    await fsp.writeFile(apiFile, newSignature, "utf8");
    await fsp.writeFile(mainFile, `import { helper } from "./api";\nexport const value = ${call};\n`, "utf8");

    const addedLine = newSignature.trimEnd();
    const removedLine = "export function helper(a: string) { return a; }";
    const diffText = [
      "diff --git a/src/api.ts b/src/api.ts",
      "index 1234567..abcdef0 100644",
      "--- a/src/api.ts",
      "+++ b/src/api.ts",
      "@@ -1,1 +1,1 @@",
      `-${removedLine}`,
      `+${addedLine}`,
      "",
    ].join("\n");

    return { root, diffText };
  }

  it(
    "prints JSON by default",
    async () => {
      const stdout = await runImpactCliSubprocess(["impact", sampleRoot, "--provider", "raw"]);
      const report = JSON.parse(stdout);
      expect(report.changedFiles).toHaveLength(1);
      expect(report.changedFiles[0]?.file).toBe("utils.ts");
    },
    slowCliTimeoutMs,
  );

  it(
    "supports pretty summaries",
    async () => {
      const stdout = await runImpactCli(["impact", sampleRoot, "--provider", "raw", "--pretty"]);
      expect(stdout).toContain("Impact Analysis Report");
      expect(stdout).toContain("Changed files: 1");
      expect(stdout).toContain("Changed symbols:");
    },
    slowCliTimeoutMs,
  );

  it(
    "prints reason labels in pretty impact output",
    async () => {
      const stdout = await runImpactCli(["impact", sampleRoot, "--provider", "raw", "--pretty"]);

      expect(stdout).toContain("Impact Analysis Report");
      expect(stdout).toContain("Changed files: 1");
      expect(stdout).toMatch(/utils\.ts: .*reason:/);
    },
    slowCliTimeoutMs,
  );

  it(
    "includes call compatibility in JSON output",
    async () => {
      const { root, diffText } = await createCallCompatibilityFixture();
      try {
        const stdout = await runImpactCli(["impact", "--root", root, "--provider", "raw"], {
          cwd: root,
          stdin: diffText,
        });
        const report = JSON.parse(stdout);
        const helper = report.changedSymbols.find((symbol: { name?: string }) => symbol.name === "helper");
        expect(helper.callCompatibility).toContainEqual(
          expect.objectContaining({
            status: "likely_mismatch",
            reason: "argument_count_below_minimum",
            callsiteFile: "src/main.ts",
          }),
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
    slowCliTimeoutMs,
  );

  it(
    "prints call compatibility only for likely mismatches in pretty output",
    async () => {
      const mismatch = await createCallCompatibilityFixture();
      const compatible = await createCallCompatibilityFixture(true);
      try {
        const mismatchStdout = await runImpactCli(
          ["impact", "--root", mismatch.root, "--provider", "raw", "--pretty"],
          {
            cwd: mismatch.root,
            stdin: mismatch.diffText,
          },
        );
        expect(mismatchStdout).toContain("Call compatibility:");
        expect(mismatchStdout).toContain("helper: src/main.ts:2 passes 1 argument; new signature requires 2.");

        const compatibleStdout = await runImpactCli(
          ["impact", "--root", compatible.root, "--provider", "raw", "--pretty"],
          {
            cwd: compatible.root,
            stdin: compatible.diffText,
          },
        );
        expect(compatibleStdout).not.toContain("Call compatibility:");
        expect(compatibleStdout).not.toContain("compatible_argument_count");
        expect(compatibleStdout).not.toContain("signature_or_callsite_unknown");
      } finally {
        await fsp.rm(mismatch.root, { recursive: true, force: true });
        await fsp.rm(compatible.root, { recursive: true, force: true });
      }
    },
    slowCliTimeoutMs,
  );

  it(
    "prints scoped duplicate leads in pretty output by default",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-cli-duplicates-"));
      const source = `
export function summarizeOrders(rows: Array<{ amount: number; tax: number }>) {
  const output: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    output.push(label + ":" + rounded.toFixed(2));
  }
  return output.filter((value) => value.includes(":")).join(",");
}
`;
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        await fsp.writeFile(path.join(root, "src", "orders-a.ts"), source, "utf8");
        await fsp.writeFile(path.join(root, "src", "orders-b.ts"), source, "utf8");
        const diffText = [
          "diff --git a/src/orders-a.ts b/src/orders-a.ts",
          "index 1234567..abcdef0 100644",
          "--- a/src/orders-a.ts",
          "+++ b/src/orders-a.ts",
          "@@ -1,1 +1,1 @@",
          "-export function oldA() { return 1; }",
          "+export function summarizeOrders(rows: Array<{ amount: number; tax: number }>) {",
          "diff --git a/src/orders-b.ts b/src/orders-b.ts",
          "index 1234567..abcdef0 100644",
          "--- a/src/orders-b.ts",
          "+++ b/src/orders-b.ts",
          "@@ -1,1 +1,1 @@",
          "-export function oldB() { return 2; }",
          "+export function summarizeOrders(rows: Array<{ amount: number; tax: number }>) {",
          "",
        ].join("\n");

        const stdout = await runImpactCli(["impact", "--root", root, "--provider", "raw", "--pretty"], {
          cwd: root,
          stdin: diffText,
        });
        const disabledStdout = await runImpactCli(
          ["impact", "--root", root, "--provider", "raw", "--pretty", "--duplicates", "off"],
          {
            cwd: root,
            stdin: diffText,
          },
        );

        expect(stdout).toContain("Duplicate leads:");
        expect(stdout).toContain("src/orders-a.ts:");
        expect(stdout).toContain("matches src/orders-b.ts:");
        expect(stdout).toContain("(exact, score 100)");
        expect(disabledStdout).not.toContain("Duplicate leads:");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
    slowCliTimeoutMs,
  );

  it(
    "uses raw diff copy similarity metadata for scoped duplicate leads",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-cli-copy-duplicates-"));
      const source = `
export function summarizeSourceOrders(rows: Array<{ amount: number; tax: number }>) {
  const output: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    output.push(label + ":" + rounded.toFixed(2));
  }
  return output.filter((value) => value.includes(":")).join(",");
}
`;
      const copied = source.replace("summarizeSourceOrders", "summarizeCopiedOrders");
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        await fsp.writeFile(path.join(root, "src", "source.ts"), source, "utf8");
        await fsp.writeFile(path.join(root, "src", "copied.ts"), copied, "utf8");
        const diffText = [
          "diff --git a/src/source.ts b/src/copied.ts",
          "similarity index 92%",
          "copy from src/source.ts",
          "copy to src/copied.ts",
          "--- a/src/source.ts",
          "+++ b/src/copied.ts",
          "@@ -1,1 +1,1 @@",
          "-export function summarizeSourceOrders(rows: Array<{ amount: number; tax: number }>) {",
          "+export function summarizeCopiedOrders(rows: Array<{ amount: number; tax: number }>) {",
          "",
        ].join("\n");

        const jsonStdout = await runImpactCli(["impact", "--root", root, "--provider", "raw"], {
          cwd: root,
          stdin: diffText,
        });
        const report = JSON.parse(jsonStdout) as {
          changedFiles: Array<{ file: string; oldFile?: string; similarityIndex?: number }>;
        };
        expect(report.changedFiles[0]).toMatchObject({
          file: "src/copied.ts",
          oldFile: "src/source.ts",
          similarityIndex: 92,
        });

        const prettyStdout = await runImpactCli(["impact", "--root", root, "--provider", "raw", "--pretty"], {
          cwd: root,
          stdin: diffText,
        });

        expect(prettyStdout).toContain("Duplicate leads:");
        expect(prettyStdout).toContain("src/copied.ts:");
        expect(prettyStdout).toContain("matches src/source.ts:");

        const prettyCompactStdout = await runImpactCli(
          ["impact", "--root", root, "--provider", "raw", "--pretty", "--compact-json"],
          {
            cwd: root,
            stdin: diffText,
          },
        );

        expect(prettyCompactStdout).toContain("Duplicate leads:");
        expect(prettyCompactStdout).toContain("src/copied.ts:");
        expect(prettyCompactStdout).toContain("matches src/source.ts:");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
    slowCliTimeoutMs,
  );

  it(
    "accepts --compact-json as an alias for compact impact JSON",
    async () => {
      const stdout = await runImpactCli(["impact", sampleRoot, "--provider", "raw", "--compact-json"]);
      const report = JSON.parse(stdout) as { schemaVersion?: number; format?: string; files?: string[] };

      expect(report.schemaVersion).toBe(1);
      expect(report.format).toBe("compact");
      expect(Array.isArray(report.files)).toBe(true);
    },
    slowCliTimeoutMs,
  );

  it(
    "rejects invalid numeric analysis options",
    async () => {
      await expect(runImpactCli(["impact", sampleRoot, "--provider", "raw", "--max-refs", "NaN"])).rejects.toThrow(
        /Invalid --max-refs value "NaN"/i,
      );
    },
    slowCliTimeoutMs,
  );

  it(
    "renders Mermaid output and honors graph/cache flags",
    async () => {
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
    },
    slowCliTimeoutMs,
  );

  it(
    "prints ASCII warnings in pretty mode for large git diffs",
    async () => {
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
    },
    slowCliTimeoutMs,
  );
});

describe("review CLI output", () => {
  it(
    "does not warn when duplicate scope includes deleted files",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-review-cli-deleted-"));
      try {
        runGit(root, ["init"]);
        runGit(root, ["config", "user.email", "review@test.local"]);
        runGit(root, ["config", "user.name", "Codegraph Bot"]);
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        await fsp.writeFile(path.join(root, "src", "removed.ts"), "export function removed() { return 1; }\n", "utf8");
        await fsp.writeFile(path.join(root, "src", "kept.ts"), "export function kept() { return 2; }\n", "utf8");
        runGit(root, ["add", "."]);
        runGit(root, ["commit", "-m", "initial"]);
        const base = runGit(root, ["rev-parse", "HEAD"]);

        await fsp.rm(path.join(root, "src", "removed.ts"));
        await fsp.writeFile(path.join(root, "src", "kept.ts"), "export function kept() { return 3; }\n", "utf8");
        runGit(root, ["add", "."]);
        runGit(root, ["commit", "-m", "delete one file"]);
        const head = runGit(root, ["rev-parse", "HEAD"]);

        const result = await runCodegraphCliResult(
          ["review", "--root", root, "--base", base, "--head", head, "--summary"],
          {
            cwd: root,
          },
        );

        expect(result.stdout).toContain("Review Summary");
        expect(result.stderr).not.toContain("No files provided");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
    slowCliTimeoutMs,
  );

  it(
    "prints duplicate leads in summary output by default",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-review-cli-duplicates-"));
      const source = `
export function summarizeOrders(rows: Array<{ amount: number; tax: number }>) {
  const output: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    output.push(label + ":" + rounded.toFixed(2));
  }
  return output.filter((value) => value.includes(":")).join(",");
}
`;
      try {
        runGit(root, ["init"]);
        runGit(root, ["config", "user.email", "review@test.local"]);
        runGit(root, ["config", "user.name", "Codegraph Bot"]);
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        await fsp.writeFile(path.join(root, "src", "orders-a.ts"), "export function oldA() { return 1; }\n", "utf8");
        await fsp.writeFile(path.join(root, "src", "orders-b.ts"), "export function oldB() { return 2; }\n", "utf8");
        runGit(root, ["add", "."]);
        runGit(root, ["commit", "-m", "initial"]);
        const base = runGit(root, ["rev-parse", "HEAD"]);

        await fsp.writeFile(path.join(root, "src", "orders-a.ts"), source, "utf8");
        await fsp.writeFile(path.join(root, "src", "orders-b.ts"), source, "utf8");
        runGit(root, ["add", "."]);
        runGit(root, ["commit", "-m", "make duplicates"]);
        const head = runGit(root, ["rev-parse", "HEAD"]);

        const stdout = await runCodegraphCli(["review", "--root", root, "--base", base, "--head", head, "--summary"], {
          cwd: root,
        });

        expect(stdout).toContain("Review Summary");
        expect(stdout).toContain("Duplicate leads:");
        expect(stdout).toContain("src/orders-a.ts:");
        expect(stdout).toContain("matches src/orders-b.ts:");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
    slowCliTimeoutMs,
  );
});
