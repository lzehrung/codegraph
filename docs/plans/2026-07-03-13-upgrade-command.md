# Upgrade command

Status: Implemented

## Goal

Add a user-facing command that checks for newer releases and prints safe upgrade instructions for the user's install channel.

Command:

```bash
codegraph upgrade --check
codegraph upgrade
codegraph upgrade 1.9.0
```

## Design

The implementation is conservative: it detects the install channel and prints exact commands without modifying installs.

This command depends on the immutable Windows native runtime cache and runtime-version diagnostics in [`2026-07-12-windows-native-runtime-cache-updates.md`](./2026-07-12-windows-native-runtime-cache-updates.md). For npm installs it prints the scoped registry and exact global install command, but does not kill MCP hosts or replace npm as install authority.

Install channels:

- source checkout
- npm package
- unknown

## Behavior

### --check

- Read current version from package metadata.
- Query the latest GitHub release with a three-second timeout.
- After a successful lookup, print current/latest and whether update is available.
- In CI or offline, return a non-crashing actionable error in text or JSON; text reports current/channel/error without establishing release availability.

### upgrade

For source checkout:

- Print: pull/build instructions.
- Do not run git commands.

For npm install:

- Print exact npm command using the documented scoped package and registry.
- Do not run package manager commands.

## JSON output

```ts
type UpgradeReport = {
  schemaVersion: 1;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  channel: "source" | "npm" | "bundle" | "unknown";
  command?: string;
  error?: string;
};
```

`bundle` is reserved in schema v1. It is never detected until an owned installer records bundle metadata, and this implementation provides no bundle instructions.

## Files likely touched

- `src/cli/help.ts`
- `src/cli/options.ts`
- `src/cli.ts`
- new `src/cli/upgrade.ts`
- `src/cli/packageInfo.ts`
- `docs/installation.md`
- `docs/cli.md`
- `PUBLISHING.md`
- tests under new `tests/upgrade-command.test.ts`

## Tests

- source checkout channel detected from package root.
- npm channel detected when installed package metadata indicates npm path.
- unknown channel prints safe fallback.
- `--check --json` returns stable schema.
- network failure returns clear non-crashing result.
- version argument validates semver.

## Acceptance

- Users can discover whether they are outdated.
- The command never corrupts source checkouts or package-manager installs.

## Review pass

Checked scope: this plan prioritizes safety over magic. It improves update discoverability without letting the CLI mutate arbitrary package-manager state.
