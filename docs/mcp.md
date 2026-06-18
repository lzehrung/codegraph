# MCP Server

Codegraph can run as a Model Context Protocol server so tool-capable agents can query repo structure without spawning a new CLI process for every follow-up.

Use MCP when an agent will make repeated navigation, search, packet, review, or artifact queries. Use normal CLI commands for one-off local inspection or when your agent runtime does not expose MCP tools.

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

- `orient`: compact first-turn repo context.
- `packet_get`: bounded evidence packet by file path or stable target.
- `search`: deterministic ranked search across paths, symbols, chunks, SQL objects, and graph context.
- `get_file`: bounded project file read.
- `get_symbol`: resolve a stable search or explain handle.
- `goto`: definition lookup by file position.
- `refs`: references by handle or file position.
- `deps`, `rdeps`, `path`: dependency navigation.
- `impact`, `review`: git-range risk and review context.
- `query_sqlite`: bounded read-only SQLite artifact query.
- `refresh_index`: invalidate the in-memory session and optionally rebuild the base or symbol snapshot.
- `artifact_build`: artifact creation, available only with write access enabled.

MCP keeps one Codegraph session warm for the configured root. That makes follow-up calls cheaper than separate CLI invocations. Startup is lazy unless `--warmup` or `--warmup-symbols` is passed.
Use `refresh_index` after changing files while the server is running, or when you need a fresh cache-backed snapshot without restarting the MCP process.
Tool schemas are flat JSON objects for broad client compatibility; argument combinations such as `refs` handle-vs-position mode are validated by the server.

## Safety

- File and artifact paths are confined to `--root` after realpath resolution.
- Tool calls do not accept per-request root overrides.
- Tools are read-only by default.
- `artifact_build` requires `--allow-build`.
- `query_sqlite` rejects mutating SQL, recursive queries, and synthetic payload functions.
- SQLite responses are row- and byte-bounded.

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

1. Start with `orient`.
2. Use `search` to find anchors.
3. Use `packet_get`, `refs`, `goto`, `deps`, `rdeps`, or `path` for focused follow-up.
4. Use `impact` and `review` for git-range risk analysis.
5. Use `query_sqlite` only for read-only artifact inspection.
6. Use `refresh_index` after changing files while a long-running server is active.
7. Use `artifact_build` only when write access was intentionally enabled.

Fall back to CLI commands when MCP tools are unavailable.
