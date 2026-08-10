import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { runCliOrThrow, runCliStdout, runTsxScriptOrThrow } from "./helpers/cli.js";
import os from "node:os";
import fsp from "node:fs/promises";
import { runGit } from "./helpers/git.js";
import { copyFixtureSubset, readOnlySamplePath } from "./helpers/filesystem.js";

let sampleRoot = "";
beforeAll(async () => {
  sampleRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-cli-sample-"));
  await copyFixtureSubset(readOnlySamplePath("typescript"), sampleRoot);
});
afterAll(async () => {
  if (process.env.CODEGRAPH_KEEP_FIXTURE_TEMP === "1") {
    console.error(`Retained fixture copy: ${sampleRoot}`);
  } else {
    await fsp.rm(sampleRoot, { recursive: true, force: true });
  }
});
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
  return await runCliStdout(args, {
    cwd: opts?.cwd,
    stdin: () => stdinForImpactCli(opts),
  });
}

async function runCodegraphCliResult(
  args: string[],
  opts?: { cwd?: string; stdin?: string },
): Promise<{ stdout: string; stderr: string }> {
  return await runCliOrThrow(args, {
    cwd: opts?.cwd,
    stdin: opts?.stdin,
  });
}

async function runCodegraphCli(args: string[], opts?: { cwd?: string; stdin?: string }): Promise<string> {
  const result = await runCodegraphCliResult(args, opts);
  return result.stdout;
}

async function runImpactCliSubprocess(args: string[], opts?: { cwd?: string; stdin?: string }): Promise<string> {
  const result = await runTsxScriptOrThrow(
    path.resolve(process.cwd(), "src", "cli.ts"),
    args,
    {
      cwd: opts?.cwd,
      stdin: stdinForImpactCli(opts),
    },
    "codegraph CLI",
  );
  return result.stdout;
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
    "prints JSON when requested",
    async () => {
      const stdout = await runImpactCliSubprocess(["impact", sampleRoot, "--provider", "raw", "--json"]);
      const report = JSON.parse(stdout);
      expect(report.analysis?.label).toBeTruthy();
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
      expect(stdout).toContain("Analysis:");
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
        const stdout = await runImpactCli(["impact", "--root", root, "--provider", "raw", "--json"], {
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
    "surfaces resolution confidence and member-resolution coverage in pretty output",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-cli-resolution-"));
      try {
        const srcDir = path.join(root, "src");
        await fsp.mkdir(srcDir, { recursive: true });
        const serviceFile = path.join(srcDir, "service.ts");
        const consumerFile = path.join(srcDir, "consumer.ts");
        const pyFile = path.join(root, "helper.py");
        await fsp.writeFile(
          serviceFile,
          ["export class Service {", "  run(value: number, extra: number): number { return value; }", "}", ""].join(
            "\n",
          ),
          "utf8",
        );
        await fsp.writeFile(
          consumerFile,
          [
            'import { Service } from "./service";',
            "const service = new Service();",
            "export const result = service.run(1);",
            "",
          ].join("\n"),
          "utf8",
        );
        await fsp.writeFile(pyFile, "def helper(a, b):\n    return a + b\n", "utf8");

        const diffText = [
          "diff --git a/src/service.ts b/src/service.ts",
          "index 1234567..abcdef0 100644",
          "--- a/src/service.ts",
          "+++ b/src/service.ts",
          "@@ -2,1 +2,1 @@",
          "-  run(value: number): number { return value; }",
          "+  run(value: number, extra: number): number { return value; }",
          "diff --git a/helper.py b/helper.py",
          "index 1234567..abcdef0 100644",
          "--- a/helper.py",
          "+++ b/helper.py",
          "@@ -1,2 +1,2 @@",
          "-def helper(a):",
          "-    return a",
          "+def helper(a, b):",
          "+    return a + b",
          "",
        ].join("\n");

        const stdout = await runImpactCli(["impact", "--root", root, "--provider", "raw", "--pretty"], {
          cwd: root,
          stdin: diffText,
        });

        expect(stdout).toContain("resolution confidence: medium");
        expect(stdout).toContain(
          "Note: limited receiver-call resolution for: python; consumers reached only through a receiver (e.g. obj.method()) may be missing from this report.",
        );
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

        const jsonStdout = await runImpactCli(["impact", "--root", root, "--provider", "raw", "--json"], {
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
          ["impact", "--root", root, "--provider", "raw", "--pretty", "--compact"],
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
    "emits compact impact JSON with --compact",
    async () => {
      const stdout = await runImpactCli(["impact", sampleRoot, "--provider", "raw", "--compact"]);
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
    "rejects malformed GitHub repos before impact analysis",
    async () => {
      await expect(
        runImpactCli(["impact", sampleRoot, "--provider", "github", "--repo", "owner/repo/extra", "--pr", "42"]),
      ).rejects.toThrow(/Invalid GitHub repo "owner\/repo\/extra"/);
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

        const result = await runCodegraphCliResult(["review", "--root", root, "--base", base, "--head", head], {
          cwd: root,
        });

        expect(result.stdout).toContain("Review Summary");
        expect(result.stderr).not.toContain("No files provided");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
    slowCliTimeoutMs,
  );

  it(
    "flags languages without receiver member-call resolution in diagnostics",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-review-cli-coverage-"));
      try {
        runGit(root, ["init"]);
        runGit(root, ["config", "user.email", "review@test.local"]);
        runGit(root, ["config", "user.name", "Codegraph Bot"]);
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        await fsp.writeFile(
          path.join(root, "src", "api.ts"),
          "export function helper(a: string) { return a; }\n",
          "utf8",
        );
        await fsp.writeFile(path.join(root, "src", "helper.py"), "def helper(a):\n    return a\n", "utf8");
        runGit(root, ["add", "."]);
        runGit(root, ["commit", "-m", "initial"]);
        const base = runGit(root, ["rev-parse", "HEAD"]);

        await fsp.writeFile(
          path.join(root, "src", "api.ts"),
          "export function helper(a: string, b: number) { return a; }\n",
          "utf8",
        );
        await fsp.writeFile(path.join(root, "src", "helper.py"), "def helper(a, b):\n    return a + b\n", "utf8");
        runGit(root, ["add", "."]);
        runGit(root, ["commit", "-m", "signature changes"]);
        const head = runGit(root, ["rev-parse", "HEAD"]);

        const result = await runCodegraphCliResult(["review", "--root", root, "--base", base, "--head", head], {
          cwd: root,
        });

        expect(result.stdout).toContain(
          "limited receiver-call resolution: python (consumers reached only through a receiver, e.g. obj.method(), may be missing)",
        );
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

        const stdout = await runCodegraphCli(["review", "--root", root, "--base", base, "--head", head], {
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
