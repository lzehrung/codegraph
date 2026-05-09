import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { handleChunkCommand } from "../src/cli/chunk.js";
import { buildDoctorReport } from "../src/cli/doctor.js";
import { getCodegraphPackageIdentity, getCodegraphVersion } from "../src/cli/packageInfo.js";
import { handleSkillCommand } from "../src/cli/skill.js";
import { runCli } from "../src/cli.js";

function readJsonRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

async function captureCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;

  await runCli(args, {
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
