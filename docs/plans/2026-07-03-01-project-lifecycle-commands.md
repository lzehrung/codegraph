# Project lifecycle commands

## Goal

Add a small project lifecycle surface so users can initialize, refresh, inspect, and remove Codegraph state for a repository without learning cache internals.

Commands:

- `codegraph init [path]`
- `codegraph status [path]`
- `codegraph sync [path]`
- `codegraph uninit [path]`

## Design

Use `--root` semantics as the source of truth. Positional `[path]` resolves to the project root unless `--root` is passed; if both are passed, `[path]` is an include root inside `--root` only where existing command semantics already allow it.

Create a project-local `.codegraph/manifest.json` with only metadata:

```json
{
  "schemaVersion": 1,
  "root": ".",
  "createdAt": "2026-07-03T00:00:00.000Z",
  "lastSyncAt": "2026-07-03T00:00:00.000Z",
  "configHash": "...",
  "buildOptionsHash": "...",
  "fileCount": 123,
  "analysis": { "label": "native semantic" }
}
```

Do not duplicate the full graph in `.codegraph/` in this PR. Reuse the existing disk cache and session/index builders. The manifest is a user-facing lifecycle marker and status source, not a second graph database.

## Command behavior

### init

- Ensure root is safe and inside the selected project boundary.
- Create `.codegraph/` if missing.
- Run the same index build path used by `index --cache disk`.
- Write `manifest.json` atomically through a temp file plus rename.
- Exit successfully if already initialized and current; print a short status.
- Support `--force` to rebuild and overwrite manifest.

### status

- Read `.codegraph/manifest.json`.
- Recompute current config/build option hash.
- Re-stat discovered files using current discovery settings.
- Print:
  - initialized or not initialized
  - last sync time
  - file count then/current
  - config changed yes/no
  - native/reduced analysis label
  - suggested next command
- Add `--json` with stable `schemaVersion: 1`.

### sync

- Require initialized project unless `--init` is passed.
- Reuse incremental index/cache build.
- Update manifest atomically.
- Print changed/removed/added counts when available; otherwise print file count and elapsed time.

### uninit

- Refuse to delete non-Codegraph directories.
- Remove `.codegraph/manifest.json` and known empty `.codegraph/` scaffolding.
- Preserve unrelated files in `.codegraph/` unless `--force` is passed and every entry is recognized.

## Files likely touched

- `src/cli/help.ts`
- `src/cli/options.ts`
- `src/cli.ts` command dispatch
- new `src/cli/lifecycle.ts`
- new `src/lifecycle/manifest.ts`
- `docs/cli.md`
- `README.md`
- `codegraph-skill/codegraph/SKILL.md`
- tests under `tests/cli-regressions.test.ts` or new `tests/lifecycle.test.ts`

## Tests

- `init` creates `.codegraph/manifest.json` and warms cache.
- `init` is idempotent.
- `init --force` rebuilds and updates `lastSyncAt`.
- `status --json` reports initialized project.
- `status` reports not initialized without throwing.
- `status` detects config hash changes.
- `sync` updates manifest after a file edit.
- `uninit` removes only recognized files.
- `uninit` refuses to delete unknown files without `--force`.

## Acceptance

- Users can run `init`, edit files, run `status`, then run `sync` and see state update.
- Existing commands continue working without `.codegraph/`.
- No existing cache format is made dependent on the lifecycle manifest.

## Review pass

Checked scope: this plan avoids introducing a second persistent graph database. It keeps the addition idiomatic for this project by reusing `--root`, disk cache, existing index builders, atomic file writes, and documented config hashing behavior.
