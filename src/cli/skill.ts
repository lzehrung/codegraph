import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getCodegraphPackageRoot, normalizePathForDisplay, pathExists } from "../util/packageInfo.js";
import { writeCliOutput } from "./pretty.js";

export type SkillInstallAgent = "agents" | "claude" | "codex" | "cursor" | "gemini" | "opencode" | "omp" | "kilo";

type SkillDoctorReport = {
  packageRoot: string;
  bundledSkillDir: string | null;
  agent?: SkillInstallAgent;
  defaultTargetDir: string;
  requestedTargetDir?: string;
  installTargetDir: string;
  cliAvailableOnPath: boolean;
  installedSkill: {
    targetDirExists: boolean;
    skillFilePresent: boolean;
    skillFilePath: string;
  };
};

function getBundledSkillDir(packageRoot: string): string | null {
  const candidate = path.join(packageRoot, "codegraph-skill", "codegraph");
  return pathExists(path.join(candidate, "SKILL.md")) ? candidate : null;
}

export function getSkillTargetDirForAgent(
  agent: SkillInstallAgent,
  homeDir = os.homedir(),
  env: Record<string, string | undefined> = process.env,
): string {
  if (agent === "agents") {
    return path.join(homeDir, ".agents", "skills", "codegraph");
  }
  if (agent === "claude") {
    return path.join(homeDir, ".claude", "skills", "codegraph");
  }
  if (agent === "cursor") {
    return path.join(homeDir, ".cursor", "skills", "codegraph");
  }
  if (agent === "gemini") {
    return path.join(homeDir, ".gemini", "skills", "codegraph");
  }
  if (agent === "opencode") {
    const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
    return path.join(configHome, "opencode", "skills", "codegraph");
  }
  if (agent === "omp") {
    return path.join(homeDir, ".omp", "agent", "managed-skills", "codegraph");
  }
  if (agent === "kilo") {
    return path.join(homeDir, ".kilocode", "skills", "codegraph");
  }
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) {
    return path.join(codexHome, "skills", "codegraph");
  }
  return path.join(homeDir, ".codex", "skills", "codegraph");
}

function parseSkillInstallAgent(value: string | undefined): SkillInstallAgent | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "agents" || normalized === "universal") return "agents";
  if (normalized === "claude" || normalized === "claude-code") return "claude";
  if (normalized === "codex") return "codex";
  if (normalized === "cursor" || normalized === "cursor-cli") return "cursor";
  if (normalized === "gemini" || normalized === "gemini-cli") return "gemini";
  if (normalized === "opencode" || normalized === "open-code") return "opencode";
  if (normalized === "omp" || normalized === "oh-my-pi") return "omp";
  if (normalized === "kilo" || normalized === "kilo-code") return "kilo";
  throw new Error(
    `Invalid --agent value "${value}". Expected agents, claude, codex, cursor, gemini, opencode, omp, or kilo.`,
  );
}

function isCommandAvailableOnPath(command: string): boolean {
  const pathValue = process.env.PATH;
  if (!pathValue) return false;
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const executableNames =
    process.platform === "win32" ? [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`] : [command];
  return pathEntries.some((entry) => executableNames.some((name) => pathExists(path.join(entry, name))));
}

async function copyDirectoryRecursive(sourceDir: string, targetDir: string, overwrite: boolean): Promise<void> {
  if (overwrite && pathExists(targetDir)) {
    await fsp.rm(targetDir, { recursive: true, force: true });
  }
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, targetPath, overwrite);
      continue;
    }
    if (!overwrite && pathExists(targetPath)) {
      throw new Error(
        `Target file already exists: ${normalizePathForDisplay(targetPath)}. Re-run with --force to overwrite.`,
      );
    }
    await fsp.copyFile(sourcePath, targetPath);
  }
}

function normalizePathSegmentForComparison(segment: string): string {
  return process.platform === "win32" ? segment.toLowerCase() : segment;
}

function assertSafeSkillInstallTarget(targetDir: string, agent?: SkillInstallAgent): string {
  const resolvedTarget = path.resolve(targetDir);
  const targetName = normalizePathSegmentForComparison(path.basename(resolvedTarget));
  const parentName = normalizePathSegmentForComparison(path.basename(path.dirname(resolvedTarget)));
  let allowedParents: string[];
  if (!agent) {
    allowedParents = ["skills", "managed-skills"];
  } else if (agent === "omp") {
    allowedParents = ["managed-skills"];
  } else {
    allowedParents = ["skills"];
  }
  const normalizedAllowedParents = allowedParents.map(normalizePathSegmentForComparison);
  if (targetName !== "codegraph" || !normalizedAllowedParents.includes(parentName)) {
    const expectedSuffixes = allowedParents.map((parent) => `"${path.join(parent, "codegraph")}"`).join(" or ");
    throw new Error(
      `Skill install target directory must end with ${expectedSuffixes}. ` +
        `Received: ${normalizePathForDisplay(resolvedTarget)}`,
    );
  }
  return resolvedTarget;
}

function resolveSkillInstallTarget(requestedTargetDir: string | undefined, requestedAgent: string | undefined) {
  const agent = parseSkillInstallAgent(requestedAgent);
  if (requestedTargetDir && agent) {
    throw new Error("Use either --target or --agent for skill install, not both.");
  }
  const targetDir = requestedTargetDir ? requestedTargetDir : getSkillTargetDirForAgent(agent ?? "codex");
  return {
    agent,
    targetDir: assertSafeSkillInstallTarget(targetDir, agent),
  };
}

function buildSkillDoctorReport(requestedTargetDir?: string, requestedAgent?: string): SkillDoctorReport {
  const packageRoot = getCodegraphPackageRoot();
  const bundledSkillDir = getBundledSkillDir(packageRoot);
  const resolvedTarget = resolveSkillInstallTarget(requestedTargetDir, requestedAgent);
  const defaultTargetDir = getSkillTargetDirForAgent(resolvedTarget.agent ?? "codex");
  const installTargetDir = resolvedTarget.targetDir;
  const skillFilePath = path.join(installTargetDir, "SKILL.md");
  const targetDirExists = pathExists(installTargetDir);
  return {
    packageRoot: normalizePathForDisplay(packageRoot),
    bundledSkillDir: bundledSkillDir ? normalizePathForDisplay(bundledSkillDir) : null,
    ...(resolvedTarget.agent
      ? {
          agent: resolvedTarget.agent,
        }
      : {}),
    defaultTargetDir: normalizePathForDisplay(defaultTargetDir),
    ...(requestedTargetDir
      ? {
          requestedTargetDir: normalizePathForDisplay(resolvedTarget.targetDir),
        }
      : {}),
    installTargetDir: normalizePathForDisplay(installTargetDir),
    cliAvailableOnPath: isCommandAvailableOnPath("codegraph"),
    installedSkill: {
      targetDirExists,
      skillFilePresent: pathExists(skillFilePath),
      skillFilePath: normalizePathForDisplay(skillFilePath),
    },
  };
}
function formatSkillDoctorSummary(report: SkillDoctorReport): string {
  const lines = [
    `Package root: ${report.packageRoot}`,
    `Bundled skill: ${report.bundledSkillDir ?? "missing"}`,
    `Install target: ${report.installTargetDir}`,
    `CLI on PATH: ${report.cliAvailableOnPath ? "yes" : "no"}`,
    `Installed skill dir: ${report.installedSkill.targetDirExists ? "present" : "missing"}`,
    `Installed SKILL.md: ${report.installedSkill.skillFilePresent ? report.installedSkill.skillFilePath : "missing"}`,
  ];
  if (report.agent) {
    lines.splice(2, 0, `Agent: ${report.agent}`);
  }
  if (report.requestedTargetDir) {
    lines.splice(3, 0, `Requested target: ${report.requestedTargetDir}`);
  }
  return lines.join("\n");
}

function formatSkillInstallSummary(output: {
  installed: boolean;
  agent?: SkillInstallAgent;
  targetDir: string;
  skillFilePath: string;
  sourceDir: string;
}): string {
  const lines = [
    "Installed Codegraph skill.",
    `Target: ${output.targetDir}`,
    `Skill file: ${output.skillFilePath}`,
    `Source: ${output.sourceDir}`,
  ];
  if (output.agent) {
    lines.splice(1, 0, `Agent: ${output.agent}`);
  }
  return lines.join("\n");
}

export type SkillCommandContext = {
  positionals: string[];
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

export async function handleSkillCommand(context: SkillCommandContext): Promise<void> {
  const subcommand = context.positionals[0] ?? "doctor";
  const agentOpt = context.getOpt("--agent");
  const targetOpt = context.getOpt("--target");
  const overwrite = context.hasFlag("--force");

  if (subcommand === "print-path") {
    const packageRoot = getCodegraphPackageRoot();
    const bundledSkillDir = getBundledSkillDir(packageRoot);
    if (!bundledSkillDir) {
      throw new Error("Bundled codegraph skill assets were not found.");
    }
    context.writeStdoutLine(normalizePathForDisplay(bundledSkillDir));
    return;
  }

  if (subcommand === "doctor") {
    writeCliOutput(context, buildSkillDoctorReport(targetOpt, agentOpt), formatSkillDoctorSummary);
    return;
  }

  if (subcommand === "install") {
    const packageRoot = getCodegraphPackageRoot();
    const bundledSkillDir = getBundledSkillDir(packageRoot);
    if (!bundledSkillDir) {
      throw new Error("Bundled codegraph skill assets were not found.");
    }
    const resolvedTarget = resolveSkillInstallTarget(targetOpt, agentOpt);
    const targetDir = resolvedTarget.targetDir;
    await copyDirectoryRecursive(bundledSkillDir, targetDir, overwrite);
    writeCliOutput(
      context,
      {
        ...(resolvedTarget.agent
          ? {
              agent: resolvedTarget.agent,
            }
          : {}),
        installed: true,
        targetDir: normalizePathForDisplay(targetDir),
        skillFilePath: normalizePathForDisplay(path.join(targetDir, "SKILL.md")),
        sourceDir: normalizePathForDisplay(bundledSkillDir),
      },
      formatSkillInstallSummary,
    );
    return;
  }

  context.writeStderrLine(
    "Usage: codegraph skill <install|print-path|doctor> [--agent <name> | --target <dir>] [--force] [--json | --pretty]",
  );
  context.exit(2);
}
