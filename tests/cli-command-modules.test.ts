import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { handleChunkCommand } from "../src/cli/chunk.js";
import { buildDoctorReport } from "../src/cli/doctor.js";
import { handleGraphDeltaCommand } from "../src/cli/graphDelta.js";
import { CLI_HELP_TEXT } from "../src/cli/help.js";
import { getCodegraphPackageIdentity, getCodegraphVersion } from "../src/cli/packageInfo.js";
import { handleSkillCommand } from "../src/cli/skill.js";
import { handleSqlCommand } from "../src/cli/sql.js";
import { runCli } from "../src/cli.js";

function readJsonRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

async function captureCli(
  args: string[],
  cwd = process.cwd(),
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;

  await runCli(args, {
    cwd: () => cwd,
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    exit: (code) => {
      exitCode = code;
      throw new Error(`cli exit ${code}`);
    },
  }).catch((error: unknown) => {
    if (error instanceof Error && exitCode !== undefined && error.message === `cli exit ${exitCode}`) {
      return;
    }
    throw error;
  });

  return { stdout, stderr, exitCode };
}

describe("CLI command modules", () => {
  test("builds package identity used by version and doctor commands", () => {
    const identity = getCodegraphPackageIdentity();

    expect(identity.name).toBe("@lzehrung/codegraph");
    expect(getCodegraphVersion()).toBe(identity.version);
    expect(fs.existsSync(path.join(identity.packageRoot, "package.json"))).toBeTruthy();
  });

  test("runs version command in process without exiting", async () => {
    const result = await captureCli(["version"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(getCodegraphVersion());
  });

  test("keeps build option help entries consistently indented", () => {
    const cacheStrictLine = CLI_HELP_TEXT.split("\n").find((line) => line.includes("--cache-strict"));
    const progressLine = CLI_HELP_TEXT.split("\n").find((line) => line.includes("--progress"));

    expect(cacheStrictLine?.startsWith("    --cache-strict")).toBe(true);
    expect(progressLine?.startsWith("    --progress")).toBe(true);
  });

  test("runs doctor command in process with captured JSON output", async () => {
    const result = await captureCli(["doctor"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    const report = readJsonRecord(JSON.parse(result.stdout));
    expect(report.package).toMatchObject({ name: "@lzehrung/codegraph" });
    expect(report.native).toBeTypeOf("object");
  });

  test("captures CLI usage exits in process", async () => {
    const result = await captureCli(["missing-command"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown command: missing-command");
  });

  test("keeps overlapping in-process CLI runs isolated by runtime context", async () => {
    const firstRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-runcli-first-"));
    const secondRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-runcli-second-"));
    await fsp.writeFile(path.join(firstRoot, "first.ts"), "export const first = 1;\n", "utf8");
    await fsp.writeFile(path.join(secondRoot, "second.ts"), "export const second = 2;\n", "utf8");

    try {
      await Promise.all([
        runCli(["graph"], {
          cwd: () => firstRoot,
          stdout: () => {
            throw new Error("unexpected first stdout");
          },
        }),
        runCli(["graph"], {
          cwd: () => secondRoot,
          stdout: () => {
            throw new Error("unexpected second stdout");
          },
        }),
      ]);

      const firstGraph = readJsonRecord(JSON.parse(await fsp.readFile(path.join(firstRoot, "codegraph.json"), "utf8")));
      const secondGraph = readJsonRecord(JSON.parse(await fsp.readFile(path.join(secondRoot, "codegraph.json"), "utf8")));
      expect(JSON.stringify(firstGraph)).toContain("first.ts");
      expect(JSON.stringify(firstGraph)).not.toContain("second.ts");
      expect(JSON.stringify(secondGraph)).toContain("second.ts");
      expect(JSON.stringify(secondGraph)).not.toContain("first.ts");
    } finally {
      await Promise.all([
        fsp.rm(firstRoot, { recursive: true, force: true }),
        fsp.rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("builds doctor reports for explicit index artifact paths", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-doctor-module-"));
    const artifactPath = path.join(tempDir, "codegraph.json");
    await fsp.writeFile(artifactPath, "{}", "utf8");

    try {
      const report = buildDoctorReport(artifactPath);

      expect(report.package.name).toBe("@lzehrung/codegraph");
      expect(report.native.supportedLanguageIds.length).toBeGreaterThan(0);
      expect(report.indexArtifact?.type).toBe("jsonGraph");
      expect(report.indexArtifact?.exists).toBeTruthy();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("runs SQL queries through the extracted sql command handler", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-sql-module-"));
    const dbPath = path.join(tempDir, "graph.sqlite");
    await fsp.writeFile(path.join(tempDir, "main.ts"), "export function helper() { return 1; }\n", "utf8");
    await captureCli(["graph", "--root", tempDir, "--sqlite", dbPath]);
    const jsonLines: unknown[] = [];

    try {
      await handleSqlCommand({
        getOpt: (name) => {
          if (name === "--db") return dbPath;
          if (name === "--query") return "SELECT name FROM symbols WHERE kind = 'function';";
          return undefined;
        },
        cwd: () => process.cwd(),
        writeJSONLine: (value) => jsonLines.push(value),
        writeStderrLine: () => {
          throw new Error("unexpected stderr");
        },
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      });

      const result = readJsonRecord(jsonLines[0]);
      expect(result.columns).toEqual(["name"]);
      expect(result.rows).toEqual([["helper"]]);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("writes graph delta output through the extracted graph-delta command handler", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-delta-module-"));
    const outputPath = path.join(tempDir, "delta.json");
    const sourcePath = path.join(tempDir, "main.ts");
    await fsp.writeFile(sourcePath, "import { helper } from './helper';\nhelper();\n", "utf8");
    await fsp.writeFile(path.join(tempDir, "helper.ts"), "export function helper() { return 1; }\n", "utf8");

    try {
      await handleGraphDeltaCommand({
        projectRootFs: tempDir,
        files: [sourcePath],
        getOpt: (name) => {
          if (name === "--output") return outputPath;
          return undefined;
        },
        hasFlag: () => false,
        cwd: () => process.cwd(),
        nativeMode: "auto",
        workerOpts: {},
        graphOptions: undefined,
        gitBase: undefined,
        gitHead: undefined,
        changedSince: undefined,
        writeJSONLine: () => {
          throw new Error("unexpected json stdout");
        },
      });

      const report = readJsonRecord(JSON.parse(await fsp.readFile(outputPath, "utf8")));
      expect(report.changedFiles).toEqual(["main.ts"]);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("uses shared cache-mode validation in the extracted graph-delta command handler", async () => {
    await expect(
      handleGraphDeltaCommand({
        projectRootFs: process.cwd(),
        files: [],
        getOpt: (name) => (name === "--cache" ? "banana" : undefined),
        hasFlag: () => false,
        cwd: () => process.cwd(),
        nativeMode: "auto",
        workerOpts: {},
        graphOptions: undefined,
        gitBase: undefined,
        gitHead: undefined,
        changedSince: undefined,
        writeJSONLine: () => {
          throw new Error("unexpected json stdout");
        },
      }),
    ).rejects.toThrow('Invalid --cache value "banana". Expected one of: off, memory, disk.');
  });

  test("chunks files through the extracted chunk command handler", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-chunk-module-"));
    const filePath = path.join(tempDir, "sample.ts");
    await fsp.writeFile(filePath, "export function alpha() {\n  return 1;\n}\n", "utf8");
    const jsonLines: unknown[] = [];
    const stderrLines: string[] = [];

    try {
      await handleChunkCommand({
        positionals: [filePath],
        getOpt: () => undefined,
        hasFlag: () => false,
        cwd: () => process.cwd(),
        writeJSONLine: (value) => jsonLines.push(value),
        writeStderrLine: (message) => stderrLines.push(message),
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      });

      expect(stderrLines).toEqual([]);
      expect(Array.isArray(jsonLines[0])).toBeTruthy();
      const chunks = jsonLines[0] as Array<Record<string, unknown>>;
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]?.filePath).toBe(filePath);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("runs chunk relative paths against the injected runtime cwd", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-chunk-cwd-"));
    const filePath = path.join(tempDir, "sample.ts");
    await fsp.writeFile(filePath, "export function beta() {\n  return 2;\n}\n", "utf8");

    try {
      const result = await captureCli(["chunk", "sample.ts", "--min-tokens", "1", "--max-tokens", "50"], tempDir);

      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      const chunks = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]?.filePath).toBe(filePath);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("defaults the extracted skill command to doctor output", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-skill-module-"));
    const targetDir = path.join(tempDir, "skills", "codegraph");
    await fsp.mkdir(path.dirname(targetDir), { recursive: true });
    const jsonLines: unknown[] = [];

    try {
      await handleSkillCommand({
        positionals: [],
        getOpt: (name) => (name === "--target" ? targetDir : undefined),
        hasFlag: () => false,
        writeJSONLine: (value) => jsonLines.push(value),
        writeStdoutLine: () => {
          throw new Error("unexpected stdout");
        },
        writeStderrLine: () => {
          throw new Error("unexpected stderr");
        },
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      });

      const report = readJsonRecord(jsonLines[0]);
      expect(report.installTargetDir).toBe(targetDir.replace(/\\/g, "/"));
      expect(report.installedSkill).toMatchObject({
        targetDirExists: false,
        skillFilePresent: false,
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
