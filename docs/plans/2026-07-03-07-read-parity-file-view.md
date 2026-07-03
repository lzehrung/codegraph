# Read-parity file view

## Goal

Make Codegraph's file-read surface a practical replacement for raw file reads in agent workflows, while adding graph context that normal reads cannot provide.

Target surfaces:

- MCP `get_file`
- CLI `codegraph file <path>` or `codegraph packet get <file>` enhancement
- `explore` file-path mode if implemented

## Design

Enhance `get_file` to return live file content from disk with predictable pagination and optional graph context.

Input:

```ts
type GetFileInput = {
  file: string;
  offset?: number;
  limit?: number;
  maxBytes?: number;
  includeGraphContext?: boolean;
};
```

Defaults:

- `offset`: 1
- `limit`: 2000 lines
- `maxBytes`: existing bounded default
- `includeGraphContext`: true for source files, false for non-source or sensitive formats

## Output

JSON:

```ts
type FileViewResponse = {
  schemaVersion: 1;
  file: string;
  offset: number;
  limit: number;
  totalLines: number;
  content: string;
  lineFormat: "number-tab-line";
  graphContext?: {
    usedBy: string[];
    imports: string[];
    symbols: Array<{ name: string; kind: string; line: number }>;
  };
  page?: { nextOffset?: number };
  freshness: FreshnessResult;
};
```

Text format should be stable and easy for agents to use:

```text
File: src/auth.ts
Used by 4 files: src/server.ts, src/routes.ts, ...
Lines 1-120 of 120
1	import ...
2	...
```

Line format must be exact and documented: no padding, number, tab, line.

## Safety

- Constrain paths to `--root` after realpath resolution.
- Respect existing binary/large-file guards.
- For known secret-prone config formats, default to structural summary unless caller explicitly passes an allow flag. Do not add broad secret scanning in this PR.
- Live file bytes should not require fresh index state.

## Files likely touched

- `src/mcp/tools.ts`
- `src/mcp/server.ts`
- `src/agent/packet.ts` if packet file output is aligned
- `docs/mcp.md`
- `docs/agent-workflows.md`
- tests under `tests/mcp-server.test.ts` or new `tests/file-view.test.ts`

## Tests

- line-number format is exactly `1\ttext`.
- `offset` and `limit` paginate correctly.
- trailing empty line behavior is stable and documented.
- large file returns next page guidance.
- file outside root is rejected.
- graph context includes direct importers for source files.
- file content reflects live disk changes even when session index is stale.

## Acceptance

- Agents can use `get_file` where they would normally read a source file.
- The response includes enough context to reduce follow-up graph queries.
- Output remains bounded and safe.

## Review pass

Checked scope: this plan improves the existing file tool instead of adding a redundant tool. It preserves root confinement and separates live file bytes from indexed graph freshness.
