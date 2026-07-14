# Upgrade command

## Goal

Add a user-facing command that checks for newer releases and prints safe upgrade instructions for the user's install channel.

Command:

```bash
codegraph upgrade --check
codegraph upgrade
codegraph upgrade 1.9.0
```

## Design

Start with a conservative implementation that detects install channel and prints exact commands. Do not self-modify global installs in the first PR unless the channel is a self-contained bundle installed by our own installer.

This command depends on the immutable Windows native runtime cache and runtime-version diagnostics in [`2026-07-12-windows-native-runtime-cache-updates.md`](./2026-07-12-windows-native-runtime-cache-updates.md). For npm installs it may report readiness and invoke npm only with explicit consent; it must not kill MCP hosts or replace npm as install authority.

Install channels:

- source checkout
- npm package
- release tarball/bundle
- unknown

## Behavior

### --check

- Read current version from package metadata.
- Query GitHub releases or package metadata with a short timeout.
- Print current/latest and whether update is available.
- In CI or offline, fail softly with actionable message unless `--json` requested.

### upgrade

For source checkout:

- Print: pull/build instructions.
- Do not run git commands.

For npm install:

- Print exact npm command using the documented scoped package and registry.
- Do not run package manager by default.
- Support `--apply` later if desired, but not in this PR.

For self-contained bundle:

- If the installer records install metadata, download and replace atomically.
- Otherwise print installer command.

## JSON output

```ts
type UpgradeReport = {
  schemaVersion: 1;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  channel: "source" | "npm" | "bundle" | "unknown";
  command?: string;
};
```

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
- Any auto-apply path is limited to install formats this project owns end to end.

## Review pass

Checked scope: this plan prioritizes safety over magic. It improves update discoverability without letting the CLI mutate arbitrary package-manager state.
