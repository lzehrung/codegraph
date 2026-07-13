# MCP Server

Codegraph can run as a Model Context Protocol server so tool-capable agents can query repo structure without spawning a new CLI process for every follow-up.

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

Use stdio for a client-owned subprocess. Use HTTP for one long-running Codegraph process per repository, then point every MCP-capable IDE, terminal, or agent client at the same local URL. Exact config keys vary by client, but the MCP settings should use HTTP/Streamable HTTP transport plus the `/mcp` URL instead of a `command`/`args` stdio launch.

## Tools

The server exposes the same bounded primitives as the CLI and library session layer:

- `explore`: recommended first tool for broad repo questions; returns bounded anchors, packets, paths, blast radius, candidate tests, and follow-ups.
- `orient`: compact first-turn repo context.
- `packet_get`: bounded evidence packet by file path, symbol name, SQL object name, or stable target.
- `search`: deterministic ranked search across paths, symbols, chunks, SQL objects, and graph context.
- `workspace_symbols`: deterministic symbol-identity lookup with exact locations and composable filters; use `search` for hybrid path, prose, SQL, snippet, or graph evidence.
- `rename_preview`: read-only semantic rename planning by portable symbol handle; filename results are suggestions only and no apply tool exists.
- `refactor_plan`: one-snapshot refactor evidence packet by search, workspace-symbol, review, or impact handle; optional rename evidence stays read-only and authoritative.
- `callers`, `callees`: grouped semantic callers or callees plus exact callsites by portable symbol handle; use `refs` for all references and `deps` for file dependencies.
- `supertypes`, `subtypes`: proven type relationships by portable symbol handle, with bounded traversal depth.
- `implementations`: proven type or supported interface/trait-member implementations without same-name inference.
- `get_file`: bounded project file read with `offset`/`limit` line pagination, exact `number<TAB>line` content, and optional direct graph context.
- `get_symbol`: resolve a stable search or explain handle.
- `goto`: definition lookup by file position.
- `refs`: references by handle or file position.
- `deps`, `rdeps`, `path`: dependency navigation.
- `impact`, `review`: git-range risk and review context.
- `query_sqlite`: bounded read-only SQLite artifact query with freshness metadata.
- `refresh_index`: invalidate the in-memory session and optionally rebuild the base or symbol snapshot.
- `artifact_build`: artifact creation, available only with write access enabled.

MCP keeps one Codegraph session warm for the configured root. That makes follow-up calls cheaper than separate CLI invocations. Startup is lazy unless `--warmup` or `--warmup-symbols` is passed.
Before index-backed tool calls, MCP checks whether discovered files changed since the warm snapshot. Small changes refresh the session automatically, and responses include `freshness.state` as `fresh`, `refreshed`, or `stale`; stale responses also include `changedFileCount`, `omittedChangedFileCount`, and a bounded changed-file sample.
Use `refresh_index` when you need to force a rebuild, reset SQLite artifact state, or refresh after a change burst that exceeds the automatic refresh limits. `query_sqlite` refreshes Codegraph-owned SQLite artifacts after small edits when write access is enabled; otherwise it refuses to serve stale artifact rows. `artifact_build` refuses to write outputs from a stale MCP index; run `refresh_index` first after large change bursts.
`get_file` reads live bytes from disk after path confinement. It does not require a fresh index; only an explicit `includeGraphContext: true` checks indexed freshness and adds direct graph context, so returned file bytes and `totalLines` remain live even when `freshness` reports stale context.
Tool schemas are flat JSON objects for broad client compatibility; argument combinations such as `refs` handle-vs-position mode are validated by the server.

### `workspace_symbols`

Call `workspace_symbols` with flat fields `query`, optional `kinds`, `exportedOnly`, `includeImports`, `fileGlob`, and `limit`. Imports are excluded by default; `fileGlob` matches project-relative paths, the default limit is 50, and both the schema and handler enforce a maximum of 500.

Exact qualified identities such as `src/session.ts::CodeReviewSession` rank before exact names, prefixes, identifier tokens, and substrings. Responses include deterministic portable symbols plus analysis, freshness, limits, and omissions; only named/default import aliases that resolve to a concrete declaration are returned, while namespace/star and unresolved aliases are counted as omissions.

### Rename preview

Call `rename_preview` with flat fields `handle`, `newName`, and optional `includeComments`, `includeStrings`, `includeFilenames`, and `maxEdits`. The edit limit defaults to 5000 and caps at 10000; comment and string candidates are opt-in, while filename suggestions require an eligible exported class, interface, or type whose filename matches its name.

Responses contain exact project-relative edits, conflicts, unsafe sites, filename suggestions, candidate tests, provenance, freshness, and omissions. The tool reuses the server session, remains available in read-only mode, never changes files, and has no apply counterpart.

### Refactor plan

Call `refactor_plan` with flat fields `handle`, optional `renameTo`, independent optional `maxReferences`, `maxCallers`, and `maxHierarchy` values from 0 to 500, and optional `includeSource`. The configured MCP root is reused and cannot be overridden per request.

The tool composes references, direct callers and callees, type relationships, implementations, section issues, candidate tests, omissions, and follow-ups from one session snapshot. Unsupported implementation sections contribute an omission and appear in `sectionIssues`; exact internal review or impact symbol handles are accepted, returned targets and commands use portable handles, and nested `rename.safe` remains authoritative when `renameTo` is present.

### Call hierarchy

Call `callers` or `callees` with flat fields `handle`, optional `depth`, optional `limit`, and optional `includeHeuristic`. Depth defaults to 1 and caps at 5; the symbol limit defaults to 100 and caps at 500.

Both tools reuse the server session and freshness gate. Responses group exact project-relative callsites under each related symbol, sort deterministically, and report separate symbol, callsite, and unresolved-site omissions.

Only resolved semantic `calls` edges are currently returned. `includeHeuristic` is accepted for forward compatibility but does not enable guessed dynamic dispatch; imports, arbitrary references, and file dependency edges remain outside call hierarchy.

### Type hierarchy and implementations

Call `supertypes` or `subtypes` with flat fields `handle`, optional `depth`, and optional `limit`. Depth defaults to 1 and caps at 10; the result limit defaults to 100 and caps at 500.

Call `implementations` with `handle` and optional `limit`; it has no depth field. All three tools reuse the server's one session and freshness gate, return exact project-relative symbol locations plus provenance and omissions, and reject stale handles, non-type hierarchy targets, or unsupported targets with actionable errors.

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
- `query_sqlite` rejects mutating SQL, recursive queries, synthetic payload functions, and stale artifact queries it cannot refresh safely.
- `get_file` rejects raw reads and structural text-config summaries over the 16 MiB input limit. Accepted reads use separate output-page bounds from `maxBytes`, `offset`, and `limit`; binary input is rejected, and sensitive formats require `allowSensitive: true` for raw values.
- SQLite responses are row- and byte-bounded.

## Installer

Use `codegraph install` to configure supported local clients without manually editing MCP config files:

```bash
codegraph install --target codex,claude --dry-run
codegraph install --target codex,claude --yes
codegraph install --print-config codex
```

The installer writes only Codegraph-owned marker blocks, marker files, bundled skill payloads, or exact installer-owned MCP entries. `codegraph uninstall --target <ids> --yes` removes only those owned entries.

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

Start one Codegraph process per repository:

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

## Operating Pattern

When Codegraph MCP tools are available to an agent:

1. Start with `explore` for a broad question.
2. Use `orient` when you need a compact first-turn map rather than a question answer.
3. Use `search` to find anchors and `get_file`, `packet_get`, `refs`, `goto`, `deps`, `rdeps`, or `path` for focused follow-up.
4. Check `freshness` on MCP responses after edits; `refreshed` means the answer used an updated snapshot, and `stale` includes a reason plus a bounded changed-file sample.
5. Use `impact` and `review` for git-range risk analysis.
6. Use `query_sqlite` only for read-only artifact inspection; rebuild the artifact when it reports stale state.
7. Use `refresh_index` when you need an explicit rebuild.
8. Use `artifact_build` only when write access was intentionally enabled.

Fall back to CLI commands when MCP tools are unavailable.
