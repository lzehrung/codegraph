import {
  detectInstallTargets,
  installCodegraphTargets,
  parseInstallTargetId,
  parseInstallTargetIds,
  printInstallConfig,
  uninstallCodegraphTargets,
  type InstallTargetId,
} from "../installer/registry.js";

export type InstallerCommandContext = {
  command: "install" | "uninstall";
  positionals: string[];
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

export async function handleInstallerCommand(context: InstallerCommandContext): Promise<void> {
  const printConfigTarget = context.getOpt("--print-config");

  if (printConfigTarget !== undefined) {
    assertPrintConfigIsExclusive(context);
    const targetId = parseInstallerTargetOrExit(context, printConfigTarget);
    context.writeStdoutLine(printInstallConfig({ targetId }).trimEnd());
    return;
  }

  const targetIds = parseInstallerTargets(context);
  const options = {
    ...(targetIds !== undefined ? { targetIds } : {}),
    yes: context.hasFlag("--yes"),
    dryRun: context.hasFlag("--dry-run"),
  };

  if (context.hasFlag("--detect")) {
    context.writeJSONLine({ targets: await detectInstallTargets(options) });
    return;
  }

  if (context.command === "install") {
    context.writeJSONLine(await installCodegraphTargets(options));
    return;
  }

  context.writeJSONLine(await uninstallCodegraphTargets(options));
}

function parseInstallerTargets(context: InstallerCommandContext): InstallTargetId[] | undefined {
  const targetOpt = context.getOpt("--target");
  const positionalTarget = context.positionals[0];
  if (context.positionals.length > 1) {
    context.writeStderrLine(`Unexpected positional argument for ${context.command}: ${context.positionals[1]!}`);
    context.exit(2);
  }
  if (targetOpt !== undefined && positionalTarget !== undefined) {
    failUsage(context, "Use either --target or a positional target, not both.");
  }
  return parseInstallerTargetIdsOrExit(context, targetOpt ?? positionalTarget);
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
  context.writeStderrLine(message);
  context.exit(2);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
