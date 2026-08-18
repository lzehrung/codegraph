# MCP Server

codegraph can run as a Model Context Protocol server so tool-capable agents can query repo structure without spawning a new CLI process for every follow-up.

Use MCP when an agent will make repeated explore, navigation, search, packet, review, or artifact queries. Use normal CLI commands for one-off local inspection or when your agent runtime does not expose MCP tools.

## Start the server

Stdio is the default transport and is the best fit when the MCP client launches the server:

```bash
codegraph mcp serve --root . --stdio
```

Streamable HTTP is useful when multiple IDE, terminal, or agent instances should share one repo-local server:

```bash
codegraph mcp serve --root /path/to/repo --port 7331 --warmup
```

Warm the server session when first-request latency matters:

```bash
codegraph mcp serve --root . --stdio --warmup
codegraph mcp serve --root . --port 7331 --warmup-symbols
```

`--warmup` builds the base session cache before serving requests. `--warmup-symbols` also builds the detailed symbol graph before serving requests.

The shared HTTP endpoint is `http://127.0.0.1:7331/mcp`. HTTP binds to `127.0.0.1` by default; pass `--host <host>` only when another machine or container must reach it.

Stdio servers exit when the client closes stdin, when an IPC parent disconnects, or after `--idle-timeout-ms` of inactivity (default 30 minutes; `0` disables the idle timer). That keeps orphaned `mcp serve --stdio` processes from lingering after an IDE or agent exits.

HTTP protocol sessions track last activity, cap concurrent legacy sessions (default 32), and evict idle sessions on a timer (default 30 minutes). Capacity and idle eviction skip sessions with in-flight requests or open SSE streams; when every slot is active, a new `initialize` receives an actionable JSON-RPC capacity error instead of evicting a working client. Request validation errors return a 4xx response while leaving the session usable; explicit `DELETE`, idle eviction, and an actual transport close remove the session.

Each MCP protocol session permits four concurrent tool calls by default; a saturated session returns a retryable busy error rather than queueing unbounded work. The programmatic server options `mcpToolConcurrency` and `httpBodyTimeoutMs` tune that cap and the 30-second HTTP request-body deadline; an HTTP body that misses its deadline receives `408 Request Timeout`. `httpBodyTimeoutMs` must be a whole number of milliseconds from `1` through `2_147_483_647`; HTTP server startup rejects other values.

Client cancellation returns promptly, but does not discard shared index or artifact work. A cancelled call continues to occupy its concurrency slot until its underlying operation settles, preventing a burst of abandoned requests from exceeding the configured resource bound. Shutdown rejects new calls and waits for active work before invalidating shared session resources.

Use stdio for a client-owned subprocess. Use HTTP for one long-running codegraph process per repository, then point every MCP-capable IDE, terminal, or agent client at the same local URL. Exact config keys vary by client, but the MCP settings should use HTTP/Streamable HTTP transport plus the `/mcp` URL instead of a `command`/`args` stdio launch.

codegraph uses the official MCP SDK v2 to serve current 2026-07-28 clients while retaining compatibility with 2025-era clients. MCP protocol connections and HTTP protocol sessions keep separate transport state, but all share the server's one warm codegraph analysis session for the configured root. Tool request schemas set `additionalProperties: false` and reject unknown fields with an actionable invalid-parameter error instead of silently ignoring typos.

HTTP enforces Host and Origin policies. A missing `Origin` is accepted for non-browser clients; unapproved, malformed, and opaque origins are rejected. This is not authentication: binding `--host` to a non-loopback address exposes an unauthenticated endpoint intended only for trusted networks or containers.

## Runtime identity and updates

The MCP initialize response advertises the codegraph package version captured when the server starts. The server checks its captured package metadata path at most once every 30 seconds during tool calls; a changed or temporarily unavailable installation produces a deduplicated stderr warning but does not fail the request or terminate the server.

On Windows, installed-package servers map the verified native addon from `%LOCALAPPDATA%\codegraph\native-cache\v1`, not from npm's package directory. An old server may therefore remain healthy after npm installs a new release, but it must be restarted to use the new JavaScript runtime and cache identity.

The published CLI and MCP runtime is a self-contained bundle rather than a set of lazy content-hashed chunks. This prevents an in-place package upgrade from deleting code that an already running server has not loaded yet; restart the client after an upgrade to select the new runtime.

Run `codegraph doctor` in the installed release to inspect `native.origin`, `native.update`, and any stale npm retirement siblings. `updateSafeForCurrentProcess` describes only the process running doctor; it does not prove that no other process or filesystem service holds a package file.

## Tools

The server exposes the same bounded primitives as the CLI and library session layer:

- `explore`: recommended first tool for broad repo questions; returns bounded anchors, packets, paths, blast radius, candidate tests, and follow-ups.
- `orient`: compact first-turn repo context.
- `packet_get`: bounded evidence packet by file path, symbol name, SQL object name, or stable target.
- `search`: deterministic ranked search across paths, symbols, chunks, SQL objects, and graph context.
- `workspace_symbols`: deterministic symbol-identity lookup with exact locations and composable filters; use `search` for hybrid path, prose, SQL, snippet, or graph evidence.
- `rename_preview`: read-only semantic rename planning by portable symbol handle; filename results are suggestions only and no apply tool exists.
- `refactor_plan`: one-snapshot refactor evidence packet by search, workspace-symbol, review, or impact handle; optional rename evidence stays read-only and authoritative.
- `calls`: grouped semantic callers or callees plus exact callsites by portable symbol handle; pass `direction: "callers"` or `"callees"`. Use `refs` for all references and `file_deps` for file-level dependencies.
- `type_hierarchy`: proven supertype or subtype relationships by portable symbol handle; pass `direction: "supertypes"` or `"subtypes"`.
- `implementations`: proven type or supported interface/trait-member implementations without same-name inference.
- `get_file`: bounded project file read with `offset`/`limit` line pagination, exact `number<TAB>line` content, and optional direct graph context.
- `get_symbol`: resolve a stable search or explain handle.
- `goto`: definition lookup by portable handle, qualified `file::symbol` path, or file position.
- `refs`: references by portable handle, qualified `file::symbol` path, or file position. Collection `limit` defaults to 25 and caps at 500 (`DEFAULT_MCP_COLLECTION_LIMIT` / `MAX_MCP_COLLECTION_LIMIT` in `src/mcp/tools.ts`). The response pairs `references` with `limit`, `totalSeen`, `truncated`, and `omitted`; `truncated` is exact because the lookup probes one reference past the limit. When truncated, `totalSeen` and `omitted` are lower bounds from the bounded probe, not full corpus-wide counts.
- `file_deps`, `path`: dependency navigation; pass `direction: "deps"` or `"rdeps"` to `file_deps`. `file_deps` uses the same collection `limit` default 25 / max 500 as `refs`. `file_deps.file` accepts a portable symbol handle or qualified symbol path and traverses its declaring file. `dependencies`/`reverseDependencies` carry the same `limit`/`totalSeen`/`truncated`/`omitted` metadata as `refs`, so a capped prefix is always distinguishable from a complete result; when truncated, `totalSeen` and `omitted` are lower bounds from the bounded probe, not full graph-wide counts.
- `impact`: compact git-range impact analysis (`format: "compact"`, `impacted`, diagnostics). Bounded by default.
- `review`: git-range review report (`riskSummary`, `reviewTasks`, candidate tests). MCP is a bounded transport: `projectFiles`, `changedFiles` (including per-file `symbols`), `graphDelta`, and `candidateTests` are capped at the response's `limits` with exact per-collection `omittedCounts`, and `summary` totals stay accurate for the full report. Library callers that need the complete unbounded report call `buildReviewReport` directly instead of going through MCP.
- `query_sqlite`: bounded read-only SQLite artifact query with freshness metadata. Row `limit` defaults to 100 and caps at 500 (`src/sqlite/rowBounds.ts`).
- `refresh_index`: invalidate the in-memory session and optionally rebuild the base or symbol snapshot.
- `artifact_build`: artifact creation, available only with write access enabled.

## Per-tool schema summary

Compact contracts for high-traffic tools (`src/mcp/tools.ts`). Write gating: only `artifact_build` requires write access (`--allow-build`); all others are read-only.

| Tool             | Required | Key enums / fields                                                                | Defaults                                                      | Maxima                                  | Write gate            |
| ---------------- | -------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------- | --------------------- |
| `search`         | `query`  | `mode`: hybrid\|symbol\|path\|text\|graph\|sql; optional `from`, `depth`, `limit` | `depth` 1, `limit` 20                                         | `limit` 100                             | no                    |
| `explore`        | `query`  | optional `limit`, `maxPackets`, `maxPaths`, `includeSource`                       | `limit` 5, `maxPackets` 3, `maxPaths` 3, `includeSource` true | `limit` 50, packets/paths 10            | no                    |
| `packet_get`     | `target` | optional `maxSymbols`, `maxSnippets`, `maxDuplicates`                             | (unset uses server defaults)                                  | symbols 200, snippets 50, duplicates 20 | no                    |
| `query_sqlite`   | `query`  | optional `params[]`, `limit`                                                      | `limit` 100                                                   | `limit` 500                             | no                    |
| `refresh_index`  | (none)   | optional `warmup`: off\|base\|symbols                                             | (omit = invalidate only)                                      | -                                       | no                    |
| `artifact_build` | (none)   | optional `outDir`, `sqlite`, `graphJson`, `report`, `questions`, `force`          | -                                                             | -                                       | yes (`--allow-build`) |

`refs` / `file_deps` collection limits: default 25, maximum 500. Legacy alias tool names are accepted by `tools/call` but omitted from `tools/list`.

## Session lifecycle

MCP keeps one codegraph session warm for the configured root. That makes follow-up calls cheaper than separate CLI invocations. Startup is lazy unless `--warmup` or `--warmup-symbols` is passed.
On the first `tools/call`, codegraph can emit `notifications/message` and, when the request includes `_meta.progressToken`, `notifications/progress` before the final result. Stdio carries them inline, and modern Streamable HTTP clients that accept `text/event-stream` receive them as a stream.

Because startup is lazy, client startup timeouts only cover process boot and `initialize`, so the `startup_timeout_ms = 20000` examples below are sufficient even on large repositories. A cold full index runs inside the first `tools/call` and can exceed 20 seconds on a large tree; clients that enforce per-request timeouts should send `_meta.progressToken` (clients that observe progress notifications can keep the request alive) or allow a longer timeout for the first call after a fresh install or cache clear.

Text and hybrid searches reuse a prepared handle for `.codegraph-cache/index-v1/search-v1.sqlite` and cache identical responses by snapshot identity and request options. A detected refresh or explicit `refresh_index` closes the handle and clears cached responses before the next snapshot.

If the sidecar is busy or unavailable, MCP uses the same exact in-memory matcher. [How it works](./how-it-works.md#cache-and-session-behavior) explains the search cache.

Use `refresh_index` to rebuild the snapshot, reset SQLite artifact state, or recover after a change burst exceeds automatic limits. Concurrent refresh requests serialize; each request runs its own requested `warmup` (`off`, `base`, or `symbols`) after an active refresh completes. With write access, `query_sqlite` refreshes codegraph SQLite artifacts after small edits; otherwise it refuses stale rows. `artifact_build` refuses stale indexes, so run `refresh_index` after large change bursts.
`get_file` reads live bytes from disk after path confinement. It does not require a fresh index; only an explicit `includeGraphContext: true` checks indexed freshness and adds direct graph context, so returned file bytes and `totalLines` remain live even when `freshness` reports stale context.
Tool schemas are flat JSON objects for broad client compatibility; argument combinations such as `refs` handle-vs-position mode are validated by the server. Legacy paired names (`callers`, `callees`, `supertypes`, `subtypes`, `deps`, and `rdeps`) remain accepted by `tools/call` as aliases, but only the unified tools appear in `tools/list`.

### `workspace_symbols`

Call `workspace_symbols` with flat fields `query`, optional `kinds`, `exportedOnly`, `includeImports`, `fileGlob`, and `limit`. Imports are excluded by default; `fileGlob` matches project-relative paths, the default limit is 50, and both the schema and handler enforce a maximum of 500.

Exact qualified identities such as `src/session.ts::CodeReviewSession` rank before exact names, prefixes, identifier tokens, and substrings. Responses include deterministic portable symbols plus analysis, freshness, limits, and omissions; only named/default import aliases that resolve to a concrete declaration are returned, while namespace/star and unresolved aliases are counted as omissions.

Portable handle grammar used across `search`, `get_symbol`, `packet_get`, `explain`, `refs`, `rename_preview`, `refactor_plan`, `calls`, `type_hierarchy`, and `implementations`:

- `file:<url-encoded project-relative path>`
- `symbol:<url-encoded path>:<url-encoded local-name>:<line>:<column>`
- `chunk:<url-encoded path>:<line>`
- `sql:<url-encoded object-name>:<url-encoded path>:<line>`
- `graph:<url-encoded project-relative path>`
- review packet targets are separate quoted strings, not portable handles: `review:base=<encoded-ref>;head=<encoded-ref>`

Positions use 1-based lines and 0-based UTF-16 columns, matching the rest of codegraph's range and navigation APIs.

Position-based `goto` and `refs` requests (`file`, `line`, `column`) remain the primary navigation form. Alternatively, `goto.handle` and `refs.handle` accept an exact qualified identity, `<project-relative-file>::<local-symbol>`, without coordinates; each tool rejects mixed modes. `file_deps.file` accepts that identity or a portable `symbol:` handle, resolves its declaration, and returns file-graph dependencies; use `calls` for symbol-level callers and callees. Duplicate local names return an ambiguity error rather than selecting one.

MCP tool name <-> CLI command mapping for the common handle-driven follow-ups:

- `workspace_symbols` <-> `codegraph symbols`
- `search` <-> `codegraph search`
- `packet_get` <-> `codegraph packet get`
- `get_symbol` <-> `codegraph explain`
- `calls` <-> `codegraph callers` / `codegraph callees`
- `type_hierarchy` <-> `codegraph supertypes` / `codegraph subtypes`

### Rename preview

Call `rename_preview` with flat fields `handle`, `newName`, and optional `includeComments`, `includeStrings`, `includeFilenames`, and `maxEdits`. The edit limit defaults to 5000 and caps at 10000; comment and string candidates are opt-in, while filename suggestions require an eligible exported class, interface, or type whose filename matches its name.

Responses contain exact project-relative edits, conflicts, unsafe sites, filename suggestions, candidate tests, provenance, freshness, and omissions. The tool reuses the server session, remains available in read-only mode, never changes files, and has no apply counterpart.

### Refactor plan

Call `refactor_plan` with flat fields `handle`, optional `renameTo`, independent optional `maxReferences`, `maxCallers`, and `maxHierarchy` values from 0 to 500, and optional `includeSource`. The configured MCP root is reused and cannot be overridden per request.

The tool composes references, direct callers and callees, type relationships, implementations, section issues, candidate tests, omissions, and follow-ups from one session snapshot. Unsupported implementation sections contribute an omission and appear in `sectionIssues`; exact internal review or impact symbol handles are accepted, returned targets and commands use portable handles, and nested `rename.safe` remains authoritative when `renameTo` is present.

### Call hierarchy

Call `calls` with flat fields `direction` (`"callers"` or `"callees"`), `handle`, optional `depth`, optional `limit`, and optional `includeHeuristic`. Depth defaults to 1 and caps at 5; the symbol limit defaults to 25 and caps at 500.

Both directions reuse the server session and freshness gate. Responses group exact project-relative callsites under each related symbol, sort deterministically, and report separate symbol, callsite, and unresolved-site omissions.

Only resolved semantic `calls` edges are currently returned. `includeHeuristic` is accepted for forward compatibility but does not enable guessed dynamic dispatch; imports, arbitrary references, and file dependency edges remain outside call hierarchy.

### Type hierarchy and implementations

Call `type_hierarchy` with flat fields `direction` (`"supertypes"` or `"subtypes"`), `handle`, optional `depth`, and optional `limit`. Depth defaults to 1 and caps at 10; the result limit defaults to 25 and caps at 500.

Call `implementations` with `handle` and optional `limit`; it has no depth field and the result limit defaults to 25, capped at 500. Both tools reuse the server's one session and freshness gate, return exact project-relative symbol locations plus provenance and omissions, and reject stale handles, non-type hierarchy targets, or unsupported targets with actionable errors.

Only resolved, indexed `extends` and `implements` relationships are returned. Implementation targets are limited to interfaces, traits, abstract types, and members with proven implementation or override relationships; exact implementing declarations are returned, inherited declarations are deduplicated, and overloads, dynamic or structural conformance, and unresolved external bases are not guessed.

### `get_file`

Call `get_file` with a project-relative `file`. `offset` is the 1-based first line, `limit` is the maximum returned lines, and `maxBytes` bounds unnumbered raw page text including its line separators; defaults are `1`, `2000`, and `80000`, with output-page caps of `10000` lines and `500000` bytes. A separate 16 MiB hard input-size limit rejects larger raw reads and structural text-config summaries before unbounded I/O, bounding complete-stream binary/UTF-8 validation and total-line counting rather than returned page size.

```json
{
  "file": "src/auth.ts",
  "offset": 41,
  "limit": 2,
  "maxBytes": 80000,
  "includeGraphContext": false,
  "allowSensitive": false
}
```

The response always has `schemaVersion`, `file`, effective `offset` and `limit`, exact whole-file `totalLines`, numbered `content`, `lineFormat`, unnumbered `text`, `truncated`, and `freshness`. It adds `page: { nextOffset }` when more lines remain, `graphContext: { usedBy, imports, symbols }` when requested and indexed, and `sensitive: { kind, redacted, allowSensitiveRequired }` for recognized sensitive paths.

```json
{
  "schemaVersion": 1,
  "file": "src/auth.ts",
  "offset": 41,
  "limit": 2,
  "totalLines": 126,
  "content": "41\texport function authenticate(request) {\n42\t  return verify(request);",
  "lineFormat": "number-tab-line",
  "text": "export function authenticate(request) {\n  return verify(request);",
  "truncated": false,
  "freshness": { "state": "fresh" },
  "page": { "nextOffset": 43 }
}
```

Each `content` row is an unpadded decimal line number, one tab, and the source line. A file-ending newline is a final numbered empty line, `totalLines` counts it, and clients should continue at `page.nextOffset` rather than deriving the next page from byte length.

For raw pages, `maxBytes` can end a page before `limit`; `truncated` is true when the byte boundary cuts the selected line. Number prefixes are not part of that raw-text byte budget, so bounded `text` and formatted `content` have different byte sizes.

`includeGraphContext` defaults to `false` to avoid an index build, unnecessary repository disclosure, and stale graph data on ordinary reads. When true, `graphContext` contains at most 100 sorted direct `usedBy` paths, resolved or external `imports`, and `{ name, kind, line }` symbols; `freshness` applies to this context, never to the live file page.

Within the 16 MiB input limit, ordinary reads and structural summaries for recognized environment, authentication-config, and credential-config text files validate the full raw stream before returning bounded content or extracting bounded keys; known binary extensions, NUL bytes, and malformed or incomplete UTF-8 are rejected. Default key-material summaries use file metadata, may report size, and do not read raw secret bytes while marking `sensitive.redacted: true`; `allowSensitive: true` requests raw values but does not bypass the input-size, binary, NUL, or UTF-8 guards, so `.p12` and `.pfx` bundles summarize by default and reject raw access. For text-config summaries, `truncated` reports an incomplete bounded structural scan.

### Exact-path `explore`

An MCP `explore` request whose entire query resolves to an indexed project-relative file path, or one uniquely matching basename, includes the same live response under `fileView`. Set `includeSource: false` to suppress it; use `get_file` when pagination, graph context, or an intentional raw sensitive read needs explicit controls.

```json
{ "query": "src/auth.ts", "includeSource": true }
```

## Safety

- File and artifact paths are confined to `--root` after realpath resolution.
- Tool calls do not accept per-request root overrides.
- Tools are read-only by default.
- `artifact_build` requires `--allow-build` and a fresh or auto-refreshed MCP index.
- `query_sqlite` rejects mutating SQL, recursive queries, synthetic payload functions, and stale artifact queries it cannot refresh safely. Each query has a 10-second execution deadline.
- `get_file` rejects raw reads and structural text-config summaries over the 16 MiB input limit. Accepted reads use separate output-page bounds from `maxBytes`, `offset`, and `limit`; binary input is rejected, and sensitive formats require `allowSensitive: true` for raw values.
- SQLite responses are row- and byte-bounded.

## Installer

Run `codegraph install` interactively to detect supported local clients, preview exact proposed changes, and confirm once:

```bash
codegraph install
codegraph install --target codex,claude --dry-run
codegraph install --target codex,claude --yes
codegraph install --target codex --yes --force
codegraph install --print-config codex
```

Interactive confirmation defaults to no, and noninteractive writes require `--yes`. The installer writes only codegraph-owned marker blocks, marker files, bundled skill payloads, or exact installer-owned MCP entries; `codegraph uninstall --target <ids> --yes` removes only those owned entries. A pre-existing `SKILL.md` is overwritten only when a Codegraph ownership marker and known payload match, or when `--force` is passed.

Restart or reload configured clients after applying changes. The installer prints restart and first-query guidance but does not claim an MCP connection until a handshake occurs.

## Client Configuration Examples

Use `command: "codegraph"` when the CLI is on `PATH`. Use the full executable path when the client runs with a narrower environment.

### Generic stdio JSON

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["mcp", "serve", "--root", ".", "--stdio"]
    }
  }
}
```

### Generic Streamable HTTP

Start one codegraph process per repository:

```bash
codegraph mcp serve --root /path/to/repo --port 7331 --warmup
```

Point each MCP client at the shared endpoint:

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "http",
      "url": "http://127.0.0.1:7331/mcp"
    }
  }
}
```

For TOML-based clients, the same setup is usually expressed as a URL-backed server:

```toml
[mcp_servers.codegraph]
transport = "http"
url = "http://127.0.0.1:7331/mcp"
```

### Codex

Codex uses TOML under `[mcp_servers]`:

```toml
[mcp_servers.codegraph]
command = "codegraph"
args = ["mcp", "serve", "--root", ".", "--stdio"]
startup_timeout_ms = 20000
```

### Claude Code

Claude Code can add a stdio server from JSON:

```bash
claude mcp add-json codegraph '{"type":"stdio","command":"codegraph","args":["mcp","serve","--root",".","--stdio"]}'
```

Project-scoped `.mcp.json` uses the same server shape:

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["mcp", "serve", "--root", ".", "--stdio"]
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["mcp", "serve", "--root", "${workspaceFolder}", "--stdio"]
    }
  }
}
```

### Gemini CLI

Gemini CLI uses `mcpServers` in `settings.json`:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["mcp", "serve", "--root", ".", "--stdio"]
    }
  }
}
```

### OpenCode

OpenCode uses the `mcp` object in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codegraph": {
      "type": "local",
      "enabled": true,
      "command": ["codegraph", "mcp", "serve", "--root", ".", "--stdio"]
    }
  }
}
```

## Troubleshooting

1. After `codegraph install` or an update, restart or reload the owning MCP client. A running server keeps the package version and tool catalog captured at startup.
2. Run `codegraph doctor --json` through the same executable path and environment the client uses. Inspect package identity, `native.origin`, and `native.update`; an installed-versus-running mismatch requires a server restart, not `refresh_index`.
3. If indexed responses report `stale`, call MCP `refresh_index`. This refreshes the repository snapshot and SQLite state, but it does not reload the CLI package or MCP tool definitions.
4. If a stdio client cannot start codegraph, verify that its configured `command` resolves in the client's environment or use an absolute executable path. `codegraph install --print-config <target>` prints the current manual snippet without writing.
5. For HTTP, verify the client uses Streamable HTTP at `http://127.0.0.1:7331/mcp`. A non-loopback host requires an explicit server `--host`.

Do not delete native cache entries or npm retirement paths while codegraph or an owning IDE may still use them. Stop the processes first; `doctor` reports state but never performs cleanup.

## Operating Pattern

When codegraph MCP tools are available to an agent:

1. Start with `explore` for a broad question.
2. Use `orient` when you need a compact first-turn map rather than a question answer.
3. Use `search` to find anchors and `get_file`, `packet_get`, `refs`, `goto`, `file_deps`, or `path` for focused follow-up.
4. Check `freshness` on MCP responses after edits; `refreshed` means the answer used an updated snapshot, and `stale` includes a reason plus a bounded changed-file sample.
5. Use `impact` and `review` for git-range risk analysis.
6. Use `query_sqlite` only for read-only artifact inspection; rebuild the artifact when it reports stale state.
7. Use `refresh_index` when you need an explicit rebuild.
8. Use `artifact_build` only when write access was intentionally enabled.

If the first MCP call fails at startup or loses its transport, do not keep retrying that server. Run `codegraph doctor`, fall back to the equivalent CLI command for the current session, and restart the agent client after package upgrades.
