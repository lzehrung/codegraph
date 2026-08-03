export interface ExistingMcpConfig {
  command: string;
  args: string[];
}

export interface InstallerChoice {
  preserveExisting: boolean;
  configuration: ExistingMcpConfig;
}

export function shouldPreserveExistingServer(
  existing: ExistingMcpConfig,
  requested: ExistingMcpConfig,
): boolean {
  return (
    existing.command === requested.command &&
    existing.args.length === requested.args.length &&
    existing.args.every((arg, index) => arg === requested.args[index])
  );
}

export function preserveExistingMcpConfig(
  existing: ExistingMcpConfig,
  requested: ExistingMcpConfig,
): InstallerChoice {
  if (shouldPreserveExistingServer(existing, requested)) {
    return { preserveExisting: true, configuration: existing };
  }
  return { preserveExisting: false, configuration: requested };
}
