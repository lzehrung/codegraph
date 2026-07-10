# Read-parity file view

## Goal

Make Codegraph's live file-read surface a practical replacement for raw file reads in agent workflows without making indexed graph access implicit.

Implemented surfaces:

- MCP `get_file`
- CLI `codegraph file <path>`
- exact file-path `explore` responses through `fileView`
- root and agent-subpath library exports

## Design

The shared reader returns current disk bytes with predictable line and byte pagination. Graph context and raw sensitive values are separate explicit choices.

```ts
type AgentFileViewRequest = {
  root: string;
  file: string;
  offset?: number;
  limit?: number;
  maxBytes?: number;
  includeGraphContext?: boolean;
  allowSensitive?: boolean;
  buildOptions?: BuildOptions;
};
```

Defaults and caps:

- `offset`: 1-based, default `1`
- `limit`: default `2000` lines, cap `10000`
- `maxBytes`: default `80000`, cap `500000`, applied to unnumbered raw page text including line separators
- `includeGraphContext`: `false`
- `allowSensitive`: `false`

The graph default is intentionally false. Ordinary reads should not pay for an index build, disclose dependency neighborhoods, or risk conflating stale indexed context with live file content; callers opt in when that extra context is useful.

## Output

```ts
type AgentFileViewResponse = {
  schemaVersion: 1;
  file: string;
  offset: number;
  limit: number;
  totalLines: number;
  content: string;
  lineFormat: "number-tab-line";
  text: string;
  truncated: boolean;
  freshness: AgentFreshnessResult;
  graphContext?: {
    usedBy: string[];
    imports: string[];
    symbols: Array<{ name: string; kind: string; line: number }>;
  };
  sensitive?: {
    kind: "environment" | "authentication-config" | "credential-config" | "key-material";
    redacted: boolean;
    allowSensitiveRequired: true;
  };
  page?: { nextOffset?: number };
};
```

`totalLines` is counted across the complete live file even when only one page is returned. `page.nextOffset` is present when another line remains, and a file-ending newline contributes a final empty line.

`content` is exact unpadded decimal line number, one tab, then source line; `text` is the same selected source without prefixes. For raw pages, the byte budget applies to `text`, so numbered `content` can be larger and a byte boundary can return fewer than `limit` lines.

```text
File: src/auth.ts
Lines 41-42 of 126
41	export function authenticate(request) {
42	  return verify(request);
Next page: codegraph file src/auth.ts --offset 43 --limit 2 --pretty
```

`graphContext` appears only when requested and available in the index. It contains at most 100 sorted direct importers, imports, and symbols; `freshness` describes that indexed context separately from the always-live file page.

An `explore` query consisting only of an indexed project-relative path, or a uniquely matching basename, adds the same response under `fileView`. Disabling source with `includeSource: false` or `--no-source` suppresses it; CLI and library callers pass graph/sensitive options through only when explicit.

## Safety

- Constrain paths to `root` or `--root` after final realpath resolution.
- Reject known binary extensions, NUL-containing input, and non-UTF-8 selected content.
- Return bounded structural key or key-material summaries for known secret-prone formats unless `allowSensitive: true` or `--allow-sensitive` is explicit; summary `truncated` reports an incomplete bounded scan.
- Read live bytes without requiring fresh index state; check freshness only for requested graph context.

## Implementation surface

- `src/agent/fileView.ts`
- `src/agent/explore.ts`
- `src/cli/file.ts` and CLI routing/help/options
- `src/mcp/server.ts` and `src/mcp/tools.ts`
- root and agent facade exports
- canonical CLI, workflow, MCP, library, and skill documentation

## Tests

- Exact `1\ttext` number-tab-line format and unnumbered `text`.
- 1-based offset, line limit, byte limit, exact whole-file `totalLines`, and `nextOffset` pagination beyond the former prefix.
- Stable trailing empty line for a file-ending newline.
- Root confinement, binary rejection, sensitive structural summaries, and explicit raw-sensitive override.
- Live disk changes remain visible independently of stale index state.
- Graph context is absent by default and bounded when explicitly requested.
- Exact file-path explore responses include `fileView`; broad queries and no-source mode do not.

## Acceptance

- Agents can use CLI `file`, MCP `get_file`, library helpers, or exact-path `explore` where they would normally read source.
- Every surface returns the same bounded line-page contract and clear continuation offset.
- Graph context remains explicit opt-in, and live-byte correctness remains separate from index freshness.
- Binary and sensitive formats remain safe by default.

## Review pass

The implementation adds one shared file-view contract rather than another packet format. It preserves root confinement, keeps live bytes independent of the index, and intentionally defaults graph context off for safety and predictable read cost.
