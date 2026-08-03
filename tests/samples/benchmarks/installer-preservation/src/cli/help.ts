export const installHelp = `
Install Codegraph for an agent client.

The install command can detect existing MCP configuration, show how the server is configured,
and explain what the installer does before it writes client settings. Use --dry-run to inspect
changes and preserve the current configuration when no update is required.
`;

export function renderInstallHelp(): string {
  return installHelp.trim();
}
