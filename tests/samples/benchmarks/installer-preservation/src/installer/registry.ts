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
  return existing.command === requested.command && existing.args.join("\0") === requested.args.join("\0");
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
