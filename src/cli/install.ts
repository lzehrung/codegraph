import {
  detectInstallTargets,
  installCodegraphTargets,
  listInstallTargets,
  parseInstallTargetId,
  parseInstallTargetIds,
  printInstallConfig,
  uninstallCodegraphTargets,
  InstallerCollisionError,
  type InstallChange,
  type InstallResult,
  type InstallTargetId,
  type TargetDetection,
  type UninstallResult,
} from "../installer/registry.js";
import { writeCliOutput } from "./pretty.js";

export type InstallerCommandContext = {
  command: "install" | "uninstall";
  positionals: string[];
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  interactive: () => boolean;
  promptLine: (question: string) => Promise<string>;
  exit: (code: number) => never;
};

type InstallerReason = "declined" | "no-targets-detected";

type InstallerHealth = {
  version: string;
  nativeAvailable: boolean;
};

type InstallerOutput = (InstallResult | UninstallResult) & {
  detected: InstallTargetId[];
  reason?: InstallerReason;
  checkedPaths?: string[];
  supportedTargets?: InstallTargetId[];
  health?: InstallerHealth;
  guidance?: string[];
};
function formatDetectedTargets(targetIds: InstallTargetId[], detections: TargetDetection[]): string {
  const lines = ["Install target detection:"];
  for (const [index, detection] of detections.entries()) {
    const targetId = targetIds[index] ?? `target-${index + 1}`;
    lines.push(`- ${targetId}: ${detection.detected ? "detected" : "not detected"} (${detection.reason})`);
  }
  return lines.join("\n");
}


export async function handleInstallerCommand(context: InstallerCommandContext): Promise<void> {
  const installingAll = context.command === "install" && context.hasFlag("--all");
  if (installingAll) assertAllIsExclusive(context);
  const printConfigTarget = context.getOpt("--print-config");
  if (printConfigTarget !== undefined) {
    assertPrintConfigIsExclusive(context);
    const targetId = parseInstallerTargetOrExit(context, printConfigTarget);
    context.writeStdoutLine(printInstallConfig({ targetId }).trimEnd());
    return;
  }

  const catalog = listInstallTargets();
  const requestedTargetIds = installingAll ? catalog.map((target) => target.id) : parseInstallerTargets(context);
  const baseOptions = requestedTargetIds ? { targetIds: requestedTargetIds } : {};
  if (context.hasFlag("--detect")) {
    const targets = await detectInstallTargets(baseOptions);
    if (context.hasFlag("--json")) {
      context.writeJSONLine({ targets });
    } else {
      context.writeStdoutLine(formatDetectedTargets(catalog.map((target) => target.id), targets));
    }
    return;
  }

  const detections = installingAll ? [] : await detectInstallTargets();
  const detected = installingAll
    ? []
    : catalog.filter((_, index) => detections[index]?.detected).map((target) => target.id);
  const targetIds = requestedTargetIds ?? detected;
  if (!targetIds.length) {
    const checkedPaths = detections.flatMap((detection) =>
      [detection.configPath, detection.skillTargetDir].filter((value): value is string => value !== undefined),
    );
    const dryRun = context.hasFlag("--dry-run");
    const result: InstallResult | UninstallResult =
      context.command === "install"
        ? { installed: false, verified: false, dryRun, targets: [], changes: [] }
        : { uninstalled: false, dryRun, targets: [], changes: [] };
    const output: InstallerOutput = {
      ...result,
      detected: [],
      reason: "no-targets-detected",
      checkedPaths,
      supportedTargets: catalog.map((target) => target.id),
      guidance:
        context.command === "install"
          ? ["codegraph install --all --dry-run", "codegraph install --all --yes"]
          : ["codegraph uninstall --target <name> --dry-run", "codegraph uninstall --target <name> --yes"],
    };
    writeCliOutput(context, output, formatInstallerOutput);
    return;
  }

  const dryRun = context.hasFlag("--dry-run");
  const yes = context.hasFlag("--yes");
  if (!dryRun && !yes && !context.interactive()) {
    const selection = installingAll ? "--all" : `--target ${targetIds.join(",")}`;
    const message = `Non-interactive ${context.command} requires --yes.`;
    const guidance = [
      `codegraph ${context.command} ${selection} --dry-run`,
      `codegraph ${context.command} ${selection} --yes`,
    ];
    if (context.hasFlag("--json")) {
      context.writeJSONLine({
        ok: false,
        command: context.command,
        error: { code: "confirmation-required", message },
        guidance,
      });
    } else {
      context.writeStderrLine(message);
      context.writeStderrLine(`Preview: ${guidance[0]}`);
      context.writeStderrLine(`Apply: ${guidance[1]}`);
    }
    context.exit(2);
  }

  if (!dryRun && !yes) {
    const preview = await runInstallerOperation(context, { targetIds, dryRun: true });
    writePreview(context, preview.changes);
    let answer = "";
    try {
      answer = await context.promptLine(
        `${context.command === "install" ? "Configure" : "Remove"} Codegraph for ${targetIds.length} target(s)? [y/N] `,
      );
    } catch {
      answer = "";
    }
    const confirmed = answer.trim().toLowerCase();
    if (confirmed !== "y" && confirmed !== "yes") {
      const output: InstallerOutput = {
        ...preview,
        ...(context.command === "install" ? { installed: false } : { uninstalled: false }),
        dryRun: false,
        detected,
        reason: "declined",
      };
      writeCliOutput(context, output, () => "No changes applied.");
      return;
    }
  }

  const result = await runInstallerOperation(context, { targetIds, yes: !dryRun, dryRun });
  const guidance = dryRun ? [] : completionGuidance(context.command, targetIds);
  const health = context.command === "install" && !dryRun ? await collectInstallerHealth() : undefined;
  const output: InstallerOutput = {
    ...result,
    detected,
    ...(health ? { health } : {}),
    ...(guidance.length ? { guidance } : {}),
  };
  writeCliOutput(context, output, formatInstallerOutput);
}

async function runInstallerOperation(
  context: InstallerCommandContext,
  options: { targetIds: InstallTargetId[]; yes?: boolean; dryRun?: boolean },
): Promise<InstallResult | UninstallResult> {
  try {
    if (context.command === "install") return await installCodegraphTargets(options);
    return await uninstallCodegraphTargets(options);
  } catch (error) {
    if (error instanceof InstallerCollisionError) {
      if (context.hasFlag("--json")) {
        context.writeJSONLine({
          ok: false,
          command: context.command,
          error: { code: error.code, message: error.message },
          targets: options.targetIds,
          conflicts: error.conflicts,
        });
      } else {
        context.writeStderrLine(error.message);
      }
      context.exit(1);
    }
    throw error;
  }
}

async function collectInstallerHealth(): Promise<InstallerHealth> {
  const { buildDoctorReport } = await import("./doctor.js");
  const report = buildDoctorReport();
  return { version: report.package.version, nativeAvailable: report.native.available };
}

function writePreview(context: InstallerCommandContext, changes: readonly InstallChange[]): void {
  context.writeStderrLine("Proposed changes:");
  for (const change of changes) {
    context.writeStderrLine(`  ${change.target.padEnd(10)} ${change.action.padEnd(9)} ${change.path}`);
  }
}

function completionGuidance(
  command: InstallerCommandContext["command"],
  targets: readonly InstallTargetId[],
): string[] {
  if (command === "uninstall") return ["Restart or reload affected agent clients."];
  const guidance: string[] = [];
  const mcpTargets = targets.filter((target) => target !== "agents");
  if (mcpTargets.length) {
    guidance.push(`Restart or reload ${mcpTargets.join(", ")}, then ask it to use Codegraph to map the repository.`);
  }
  if (targets.includes("agents")) {
    guidance.push(
      "The generic agent skill is installed. Configure MCP manually with: codegraph mcp serve --root . --stdio",
    );
  }
  guidance.push('Terminal first query: codegraph explore "Where should I start in this repository?" --root .');
  return guidance;
}

function formatInstallerOutput(output: InstallerOutput): string {
  if (output.reason === "no-targets-detected") {
    const command = "uninstalled" in output ? "uninstall" : "install";
    let preview = `codegraph uninstall --target <name> --dry-run`;
    let apply = `codegraph uninstall --target <name> --yes`;
    if (command === "install") {
      preview = "codegraph install --all --dry-run";
      apply = "codegraph install --all --yes";
    }
    return [
      "No supported agent target was detected.",
      `Supported targets: ${output.supportedTargets?.join(", ") ?? "(none)"}`,
      `Preview: ${preview}`,
      `Apply: ${apply}`,
      ...(output.checkedPaths?.length ? ["Checked paths:", ...output.checkedPaths.map((value) => `  ${value}`)] : []),
    ].join("\n");
  }
  const lines = [
    `${output.dryRun ? "Previewed" : "Completed"} ${output.targets.length} target(s).`,
    ...output.changes.map((change) => `${change.target}: ${change.action} ${change.path}`),
  ];
  if ("verified" in output && output.verified) lines.push("Owned configuration verified.");
  if (output.health) {
    lines.push(
      `Doctor: Codegraph ${output.health.version}; native ${output.health.nativeAvailable ? "available" : "unavailable"}.`,
    );
  }
  if (output.guidance?.length) lines.push(...output.guidance);
  return lines.join("\n");
}

function parseInstallerTargets(context: InstallerCommandContext): InstallTargetId[] | undefined {
  const targetOpt = context.getOpt("--target");
  const positionalTarget = context.positionals[0];
  if (context.positionals.length > 1) {
    failUsage(context, `Unexpected positional argument for ${context.command}: ${context.positionals[1]!}`);
  }
  if (targetOpt !== undefined && positionalTarget !== undefined) {
    failUsage(context, "Use either --target or a positional target, not both.");
  }
  return parseInstallerTargetIdsOrExit(context, targetOpt ?? positionalTarget);
}

function assertAllIsExclusive(context: InstallerCommandContext): void {
  const conflicts: string[] = [];
  if (context.getOpt("--target") !== undefined) conflicts.push("--target");
  if (context.positionals.length) conflicts.push("positional targets");
  if (context.hasFlag("--detect")) conflicts.push("--detect");
  if (context.getOpt("--print-config") !== undefined) conflicts.push("--print-config");
  if (!conflicts.length) return;
  failUsage(context, `--all cannot be combined with ${conflicts.join(", ")}.`);
}

function assertPrintConfigIsExclusive(context: InstallerCommandContext): void {
  const conflicts: string[] = [];
  if (context.getOpt("--target") !== undefined) conflicts.push("--target");
  if (context.positionals.length) conflicts.push("positional targets");
  if (context.hasFlag("--detect")) conflicts.push("--detect");
  if (context.hasFlag("--yes")) conflicts.push("--yes");
  if (context.hasFlag("--dry-run")) conflicts.push("--dry-run");
  if (!conflicts.length) return;
  failUsage(context, `--print-config cannot be combined with ${conflicts.join(", ")}.`);
}

function parseInstallerTargetOrExit(context: InstallerCommandContext, value: string): InstallTargetId {
  try {
    return parseInstallTargetId(value);
  } catch (error) {
    failUsage(context, errorMessage(error));
  }
}

function parseInstallerTargetIdsOrExit(
  context: InstallerCommandContext,
  value: string | undefined,
): InstallTargetId[] | undefined {
  try {
    return parseInstallTargetIds(value);
  } catch (error) {
    failUsage(context, errorMessage(error));
  }
}

function failUsage(context: InstallerCommandContext, message: string): never {
  if (context.hasFlag("--json")) {
    context.writeJSONLine({
      ok: false,
      command: context.command,
      error: { code: "invalid-installer-arguments", message },
    });
  } else {
    context.writeStderrLine(message);
  }
  context.exit(2);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
