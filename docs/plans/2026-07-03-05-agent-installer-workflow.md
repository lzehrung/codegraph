# Agent installer workflow

## Goal

Provide a top-level installer that configures Codegraph for common agent clients without requiring users to manually assemble MCP config or skill install commands.

Commands:

```bash
codegraph install
codegraph uninstall
codegraph install --target codex,claude --yes
codegraph install --print-config codex
```

## Design

Keep existing `skill install` as the lower-level primitive. Add `install` as an orchestration layer that can configure MCP and skills for supported clients.

Supported initial targets should match clients already documented or implemented locally:

- `claude`
- `codex`
- `cursor`
- `gemini`
- `opencode`
- `agents`

Do not add targets whose config format is not verified in this PR.

## Target interface

Create a registry:

```ts
type InstallTarget = {
  id: string;
  label: string;
  detect(): Promise<TargetDetection>;
  printConfig(options: InstallOptions): string;
  install(options: InstallOptions): Promise<InstallResult>;
  uninstall(options: UninstallOptions): Promise<UninstallResult>;
};
```

Each target owns its file paths, marker comments, merge strategy, and validation.

## Safety

- Use marker-fenced blocks for instruction files.
- Preserve user config formatting where practical.
- Never overwrite an unknown config object wholesale.
- Make every install idempotent.
- Make every uninstall idempotent.
- Support `--dry-run` and `--print-config`.
- Require `--yes` for non-interactive writes.

## CLI behavior

`codegraph install`:

- Detect available targets.
- In interactive mode, prompt for targets and location.
- In `--yes` mode, configure detected supported targets with safe defaults.
- Print exact files changed.

`codegraph uninstall`:

- Remove only marker-owned blocks or known MCP entries matching Codegraph.
- Leave project indexes, caches, and artifacts untouched unless a separate flag is introduced later.

## Files likely touched

- `src/cli/help.ts`
- `src/cli/options.ts`
- `src/cli.ts`
- new `src/installer/registry.ts`
- new `src/installer/targets/*.ts`
- existing skill installer integration
- `docs/installation.md`
- `docs/mcp.md`
- `docs/agent-workflows.md`
- `README.md`
- `codegraph-skill/codegraph/SKILL.md`
- tests under new `tests/installer.test.ts`

## Tests

- target detection handles present and missing config dirs.
- `--print-config codex` prints valid TOML snippet.
- install is idempotent for each target.
- uninstall removes only Codegraph-owned entries.
- malformed existing config fails with actionable error.
- `--dry-run` reports changes without writing.

## Acceptance

- A user can run one command to configure supported agents.
- Existing manual MCP setup remains documented.
- Existing `skill install` still works.

## Review pass

Checked scope: this plan avoids speculative agent targets and preserves the current skill installer. It adds ergonomic orchestration without weakening config safety.
