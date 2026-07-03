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
  const targetIds = parseInstallerTargets(context);
  const options = {
    ...(targetIds !== undefined ? { targetIds } : {}),
    yes: context.hasFlag("--yes"),
    dryRun: context.hasFlag("--dry-run"),
  };

  if (printConfigTarget !== undefined) {
    const targetId = parseInstallTargetId(printConfigTarget);
    context.writeStdoutLine(printInstallConfig({ targetId }).trimEnd());
    return;
  }

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
    throw new Error("Use either --target or a positional target, not both.");
  }
  return parseInstallTargetIds(targetOpt ?? positionalTarget);
}
