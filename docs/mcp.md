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
- `get_file`: bounded project file read.
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
Tool schemas are flat JSON objects for broad client compatibility; argument combinations such as `refs` handle-vs-position mode are validated by the server.

## Safety

- File and artifact paths are confined to `--root` after realpath resolution.
- Tool calls do not accept per-request root overrides.
- Tools are read-only by default.
- `artifact_build` requires `--allow-build` and a fresh or auto-refreshed MCP index.
- `query_sqlite` rejects mutating SQL, recursive queries, synthetic payload functions, and stale artifact queries it cannot refresh safely.
- SQLite responses are row- and byte-bounded.

## Installer

Use `codegraph install` to configure supported local clients without manually editing MCP config files:

```bash
codegraph install --target codex,claude --dry-run
codegraph install --target codex,claude --yes
codegraph install --print-config codex
```

The installer writes only Codegraph-owned marker blocks, marker files, or `codegraph` MCP entries. `codegraph uninstall --target <ids> --yes` removes only those owned entries.

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
3. Use `search` to find anchors and `packet_get`, `refs`, `goto`, `deps`, `rdeps`, or `path` for focused follow-up.
4. Check `freshness` on MCP responses after edits; `refreshed` means the answer used an updated snapshot, and `stale` includes a reason plus a bounded changed-file sample.
5. Use `impact` and `review` for git-range risk analysis.
6. Use `query_sqlite` only for read-only artifact inspection; rebuild the artifact when it reports stale state.
7. Use `refresh_index` when you need an explicit rebuild.
8. Use `artifact_build` only when write access was intentionally enabled.

Fall back to CLI commands when MCP tools are unavailable.
