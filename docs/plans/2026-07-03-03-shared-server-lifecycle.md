# Shared server lifecycle

Status: Implemented

## Goal

Make long-running MCP HTTP servers easier to start, inspect, and stop without introducing a mandatory background daemon for every user.

## Design

Build on the existing Streamable HTTP server. Add an explicit project-local server registry under `.codegraph/server.json` when a server is started through a new lifecycle command.

Commands:

```bash
codegraph server start --root . --port 7331 --warmup
codegraph server status --root .
codegraph server stop --root .
```

Keep `codegraph mcp serve` as the low-level primitive. `server start` is a convenience wrapper around it.

Shared servers must use the current immutable Windows native cache. Their registry and health output must preserve the version captured at server start, surface installed-version drift, and require an explicit restart rather than replacing mapped runtime files or terminating clients automatically.

## Server registry

Store only process metadata:

```json
{
  "schemaVersion": 1,
  "pid": 12345,
  "url": "http://127.0.0.1:7331/mcp",
  "root": ".",
  "startedAt": "2026-07-03T00:00:00.000Z",
  "version": "1.8.91"
}
```

Validate liveness with an HTTP health request, not only `pid` existence. PIDs can be reused.

## Behavior

### start

- Refuse to start if a live server is already registered for the root unless `--replace` is passed.
- Default host remains `127.0.0.1`.
- Default port is `7331`; a busy port fails with startup diagnostics.
- Write the registry only after health identifies the requested root, child PID, and startup time.
- Forward `--warmup`, `--warmup-symbols`, `--cache`, `--native`, `--workers`, and discovery flags.

### status

- Print URL, pid, status, root, startup time, version, and update state.
- Add `--json` and `--pretty`.
- Report stale registries with a safe remedy. Retain unreachable and identity-mismatched registries for operator verification.

### stop

- Only stop a process whose health response matches the Codegraph root, PID, and startup time in the registry.
- Send a termination signal and wait for the process to stop.
- Remove only confirmed stale registry files safely.

## Non-goals

- Do not make server start implicit in unrelated commands.
- Do not add a detached daemon manager in this PR.
- Do not bind publicly by default.

## Files likely touched

- `src/cli/help.ts`
- `src/cli/options.ts`
- `src/cli.ts`
- new `src/cli/server.ts`
- `src/mcp/server.ts` for optional health/shutdown endpoint
- `docs/mcp.md`
- `docs/cli.md`
- tests under new `tests/mcp-server-lifecycle.test.ts`

## Tests

- `server start` writes registry after server is reachable.
- `server status --json` reports live server.
- stale registry is detected.
- `server stop` removes registry and stops server.
- root mismatch is rejected.
- public host requires explicit `--host`.

## Acceptance

- A user can start one reusable repo-local HTTP MCP server and point several clients at it.
- Stale registry files do not block normal use.
- Existing `mcp serve` behavior remains unchanged.

## Review pass

Checked scope: this plan keeps the project idiom of explicit commands and root confinement. It gives shared-server ergonomics without hiding background processes behind every command.
