# MCP freshness-on-query

## Goal

Prevent long-running MCP sessions from returning silently stale answers after files change. Prefer cheap request-time freshness checks over a mandatory background watcher.

## Design

Add a freshness gate inside the MCP/session request path. Before serving tools that depend on indexed state, compare the current project signature against the session snapshot signature.

If no relevant changes exist, answer from the warm snapshot. If changes are small, rebuild incrementally before answering. If changes are large or still pending, return an explicit staleness banner instead of an unqualified answer.

## Policy

Add a session option:

```ts
type FreshnessPolicy = "manual" | "check" | "auto";
```

Defaults:

- CLI one-shot commands: unchanged.
- MCP stdio/HTTP: `auto`.
- Library `createAgentSession`: default `check`, overridable.

Behavior:

- `manual`: current behavior; user calls `refresh_index`.
- `check`: detect changes and include stale metadata, but do not rebuild automatically.
- `auto`: detect changes and rebuild incrementally when below thresholds.

Thresholds should be conservative and configurable through session options, not global environment variables first:

```ts
{
  maxAutoRefreshFiles: 50,
  maxAutoRefreshBytes: 2_000_000,
  staleBanner: true
}
```

## Implementation

Add a lightweight session manifest:

```ts
type SessionFileSignature = {
  path: string;
  size: number;
  mtimeMs: number;
};
```

Use current discovery options and include roots. Compare discovered file signatures to the signature stored on the active session snapshot.

Freshness result:

```ts
type FreshnessResult =
  | { state: "fresh" }
  | { state: "refreshed"; changedFiles: string[] }
  | { state: "stale"; changedFiles: string[]; reason: string }
  | { state: "uninitialized" };
```

Thread this into MCP tool responses as metadata and, for text responses, a short prefix:

```text
Freshness: refreshed 3 changed files before answering.
```

or

```text
Freshness warning: 82 files changed since this session snapshot. Run refresh_index or narrow the query. Files include src/a.ts, src/b.ts, ...
```

For `get_file`, always read live file bytes from disk and include freshness metadata separately. File reads must not depend on stale index state.

## Files likely touched

- `src/agent/session.ts`
- `src/mcp/server.ts`
- `src/mcp/tools.ts`
- `src/cli/help.ts` for `refresh_index` docs if needed
- `docs/mcp.md`
- `docs/library-api.md`
- tests under `tests/mcp-server.test.ts` or new `tests/mcp-freshness.test.ts`

## Tests

- Start a session, search for a symbol, edit file, search again, and observe refreshed result.
- Delete a file and verify subsequent search/packet output no longer returns it after auto refresh.
- Large edit burst returns stale warning and does not rebuild automatically.
- `manual` policy preserves current behavior.
- `get_file` returns live bytes even when index is stale.
- Config/include-glob changes produce stale reason requiring explicit refresh or rebuild.

## Acceptance

- MCP users do not need to call `refresh_index` for normal small edits.
- No silent stale answers when changed files are detected.
- One-shot CLI behavior remains deterministic and unchanged.
- Freshness metadata is visible in JSON and human-readable responses.

## Review pass

Checked scope: this plan intentionally avoids an always-on watcher and daemon. It uses existing session/index/cache mechanics and adds a bounded freshness gate at the point where stale answers matter.
