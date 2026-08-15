[E:/git repos/codegraph-pr-contracts/docs/mcp.md#5CA0]
1:# MCP Server
2:
3:codegraph can run as a Model Context Protocol server so tool-capable agents can query repo structure without spawning a new CLI process for every follow-up.
4:
5:Use MCP when an agent will make repeated explore, navigation, search, packet, review, or artifact queries. Use normal CLI commands for one-off local inspection or when your agent runtime does not expose MCP tools.
6:
7:## Start the server
8:
9:Stdio is the default transport and is the best fit when the MCP client launches the server:
10:
11:```bash
12:codegraph mcp serve --root . --stdio
13:```
14:
15:Streamable HTTP is useful when multiple IDE, terminal, or agent instances should share one repo-local server:
16:
17:```bash
18:codegraph mcp serve --root /path/to/repo --port 7331 --warmup
19:```
20:
21:Warm the server session when first-request latency matters:
22:
23:```bash
24:codegraph mcp serve --root . --stdio --warmup
25:codegraph mcp serve --root . --port 7331 --warmup-symbols
26:```
27:
28:`--warmup` builds the base session cache before serving requests. `--warmup-symbols` also builds the detailed symbol graph before serving requests.
29:
30:The shared HTTP endpoint is `http://127.0.0.1:7331/mcp`. HTTP binds to `127.0.0.1` by default; pass `--host <host>` only when another machine or container must reach it.
31:
32:Stdio servers exit when the client closes stdin, when an IPC parent disconnects, or after `--idle-timeout-ms` of inactivity (default 30 minutes; `0` disables the idle timer). That keeps orphaned `mcp serve --stdio` processes from lingering after an IDE or agent exits.
33:
34:HTTP protocol sessions track last activity, cap concurrent legacy sessions (default 32), and evict idle sessions on a timer (default 30 minutes). Capacity and idle eviction skip sessions with in-flight requests or open SSE streams; when every slot is active, a new `initialize` receives an actionable JSON-RPC capacity error instead of evicting a working client. Transport errors and protocol session closes also remove the session.
35:
36:`CodegraphMcpServerOptions.httpBodyTimeoutMs` defaults to `30_000` (`DEFAULT_MCP_HTTP_BODY_TIMEOUT_MS`) and applies while receiving the HTTP request body. On timeout, the server destroys the timed-out stream and returns an RPC timeout response when possible.
37:
38:Use stdio for a client-owned subprocess. Use HTTP for one long-running codegraph process per repository, then point every MCP-capable IDE, terminal, or agent client at the same local URL. Exact config keys vary by client, but the MCP settings should use HTTP/Streamable HTTP transport plus the `/mcp` URL instead of a `command`/`args` stdio launch.
39:
40:codegraph uses the official MCP SDK v2 to serve current 2026-07-28 clients while retaining compatibility with 2025-era clients. MCP protocol connections and HTTP protocol sessions keep separate transport state, but all share the server's one warm codegraph analysis session for the configured root. Tool request schemas set `additionalProperties: false` and reject unknown fields with an actionable invalid-parameter error instead of silently ignoring typos.
41:
42:HTTP enforces Host and Origin policies. A missing `Origin` is accepted for non-browser clients; unapproved, malformed, and opaque origins are rejected. This is not authentication: binding `--host` to a non-loopback address exposes an unauthenticated endpoint intended only for trusted networks or containers.
43:
44:## Runtime identity and updates
45:
46:The MCP initialize response advertises the codegraph package version captured when the server starts. The server checks its captured package metadata path at most once every 30 seconds during tool calls; a changed or temporarily unavailable installation produces a deduplicated stderr warning but does not fail the request or terminate the server.
47:
48:On Windows, installed-package servers map the verified native addon from `%LOCALAPPDATA%\codegraph\native-cache\v1`, not from npm's package directory. An old server may therefore remain healthy after npm installs a new release, but it must be restarted to use the new JavaScript runtime and cache identity.
49:
50:The published CLI and MCP runtime is a self-contained bundle rather than a set of lazy content-hashed chunks. This prevents an in-place package upgrade from deleting code that an already running server has not loaded yet; restart the client after an upgrade to select the new runtime.
51:
52:Run `codegraph doctor` in the installed release to inspect `native.origin`, `native.update`, and any stale npm retirement siblings. `updateSafeForCurrentProcess` describes only the process running doctor; it does not prove that no other process or filesystem service holds a package file.
53:
54:## Tools
55:
56:The server exposes the same bounded primitives as the CLI and library session layer:
57:
58:- `explore`: recommended first tool for broad repo questions; returns bounded anchors, packets, paths, blast radius, candidate tests, and follow-ups.
59:- `orient`: compact first-turn repo context.
60:- `packet_get`: bounded evidence packet by file path, symbol name, SQL object name, or stable target.
61:- `search`: deterministic ranked search across paths, symbols, chunks, SQL objects, and graph context.
62:- `workspace_symbols`: deterministic symbol-identity lookup with exact locations and composable filters; use `search` for hybrid path, prose, SQL, snippet, or graph evidence.
63:- `rename_preview`: read-only semantic rename planning by portable symbol handle; filename results are suggestions only and no apply tool exists.
64:- `refactor_plan`: one-snapshot refactor evidence packet by search, workspace-symbol, review, or impact handle; optional rename evidence stays read-only and authoritative.
65:- `calls`: grouped semantic callers or callees plus exact callsites by portable symbol handle; pass `direction: "callers"` or `"callees"`. Use `refs` for all references and `file_deps` for file-level dependencies.
66:- `type_hierarchy`: proven supertype or subtype relationships by portable symbol handle; pass `direction: "supertypes"` or `"subtypes"`.
67:- `implementations`: proven type or supported interface/trait-member implementations without same-name inference.
68:- `get_file`: bounded project file read with `offset`/`limit` line pagination, exact `number<TAB>line` content, and optional direct graph context.
69:- `get_symbol`: resolve a stable search or explain handle.
70:- `goto`: definition lookup by portable handle, qualified `file::symbol` path, or file position.
71:- `refs`: references by portable handle, qualified `file::symbol` path, or file position. Collection `limit` defaults to 25 and caps at 500 (`DEFAULT_MCP_COLLECTION_LIMIT` / `MAX_MCP_COLLECTION_LIMIT` in `src/mcp/tools.ts`). The response pairs `references` with `limit`, `totalSeen`, `truncated`, and `omitted`; `truncated` is exact because the lookup probes one reference past the limit. When truncated, `totalSeen` and `omitted` are lower bounds from the bounded probe, not full corpus-wide counts.
72:- `file_deps`, `path`: dependency navigation; pass `direction: "deps"` or `"rdeps"` to `file_deps`. `file_deps` uses the same collection `limit` default 25 / max 500 as `refs`. `file_deps.file` accepts a portable symbol handle or qualified symbol path and traverses its declaring file. `dependencies`/`reverseDependencies` carry the same `limit`/`totalSeen`/`truncated`/`omitted` metadata as `refs`, so a capped prefix is always distinguishable from a complete result; when truncated, `totalSeen` and `omitted` are lower bounds from the bounded probe, not full graph-wide counts.
73:- `impact`: compact git-range impact analysis (`format: "compact"`, `impacted`, diagnostics). Bounded by default.
74:- `review`: git-range review report (`riskSummary`, `reviewTasks`, candidate tests). MCP is a bounded transport: `projectFiles`, `changedFiles` (including per-file `symbols`), `graphDelta`, and `candidateTests` are capped at the response's `limits` with exact per-collection `omittedCounts`, and `summary` totals stay accurate for the full report. Library callers that need the complete unbounded report call `buildReviewReport` directly instead of going through MCP.
75:- `query_sqlite`: bounded read-only SQLite artifact query with freshness metadata. Row `limit` defaults to 100 and caps at 500 (`src/sqlite/rowBounds.ts`).
76:- `refresh_index`: invalidate the in-memory session and optionally rebuild the base or symbol snapshot.
77:- `artifact_build`: artifact creation, available only with write access enabled.
78:
79:## Per-tool schema summary
80:
81:Compact contracts for high-traffic tools (`src/mcp/tools.ts`). Write gating: only `artifact_build` requires write access (`--allow-build`); all others are read-only.
82:
83:| Tool             | Required | Key enums / fields                                                                | Defaults                                                      | Maxima                                  | Write gate            |
84:| ---------------- | -------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------- | --------------------- |
85:| `search`         | `query`  | `mode`: hybrid\|symbol\|path\|text\|graph\|sql; optional `from`, `depth`, `limit` | `depth` 1, `limit` 20                                         | `limit` 100                             | no                    |
86:| `explore`        | `query`  | optional `limit`, `maxPackets`, `maxPaths`, `includeSource`                       | `limit` 5, `maxPackets` 3, `maxPaths` 3, `includeSource` true | `limit` 50, packets/paths 10            | no                    |
87:| `packet_get`     | `target` | optional `maxSymbols`, `maxSnippets`, `maxDuplicates`                             | (unset uses server defaults)                                  | symbols 200, snippets 50, duplicates 20 | no                    |
88:| `query_sqlite`   | `query`  | optional `params[]`, `limit`                                                      | `limit` 100                                                   | `limit` 500                             | no                    |
89:| `refresh_index`  | (none)   | optional `warmup`: off\|base\|symbols                                             | (omit = invalidate only)                                      | -                                       | no                    |
90:| `artifact_build` | (none)   | optional `outDir`, `sqlite`, `graphJson`, `report`, `questions`, `force`          | -                                                             | -                                       | yes (`--allow-build`) |
91:
92:`refs` / `file_deps` collection limits: default 25, maximum 500. Legacy alias tool names are accepted by `tools/call` but omitted from `tools/list`.
93:
94:## Session lifecycle
95:
96:MCP keeps one codegraph session warm for the configured root. That makes follow-up calls cheaper than separate CLI invocations. Startup is lazy unless `--warmup` or `--warmup-symbols` is passed.
97:On the first `tools/call`, codegraph can emit `notifications/message` and, when the request includes `_meta.progressToken`, `notifications/progress` before the final result. Stdio carries them inline, and modern Streamable HTTP clients that accept `text/event-stream` receive them as a stream.
98:
99:Because startup is lazy, client startup timeouts only cover process boot and `initialize`, so the `startup_timeout_ms = 20000` examples below are sufficient even on large repositories. A cold full index runs inside the first `tools/call` and can exceed 20 seconds on a large tree; clients that enforce per-request timeouts should send `_meta.progressToken` (clients that observe progress notifications can keep the request alive) or allow a longer timeout for the first call after a fresh install or cache clear.
100:
101:Text and hybrid searches reuse a prepared handle for `.codegraph-cache/index-v1/search-v1.sqlite` and cache identical responses by snapshot identity and request options. A detected refresh or explicit `refresh_index` closes the handle and clears cached responses before the next snapshot.
102:
103:If the sidecar is busy or unavailable, MCP uses the same exact in-memory matcher. [How it works](./how-it-works.md#cache-and-session-behavior) explains the search cache.
104:
105:Use `refresh_index` to rebuild the snapshot, reset SQLite artifact state, or recover after a change burst exceeds automatic limits. With write access, `query_sqlite` refreshes codegraph SQLite artifacts after small edits; otherwise it refuses stale rows. `artifact_build` refuses stale indexes, so run `refresh_index` after large change bursts.
106:`get_file` reads live bytes from disk after path confinement. It does not require a fresh index; only an explicit `includeGraphContext: true` checks indexed freshness and adds direct graph context, so returned file bytes and `totalLines` remain live even when `freshness` reports stale context.
107:Tool schemas are flat JSON objects for broad client compatibility; argument combinations such as `refs` handle-vs-position mode are validated by the server. Legacy paired names (`callers`, `callees`, `supertypes`, `subtypes`, `deps`, and `rdeps`) remain accepted by `tools/call` as aliases, but only the unified tools appear in `tools/list`.
108:
109:### `workspace_symbols`
110:
111:Call `workspace_symbols` with flat fields `query`, optional `kinds`, `exportedOnly`, `includeImports`, `fileGlob`, and `limit`. Imports are excluded by default; `fileGlob` matches project-relative paths, the default limit is 50, and both the schema and handler enforce a maximum of 500.
112:
113:Exact qualified identities such as `src/session.ts::CodeReviewSession` rank before exact names, prefixes, identifier tokens, and substrings. Responses include deterministic portable symbols plus analysis, freshness, limits, and omissions; only named/default import aliases that resolve to a concrete declaration are returned, while namespace/star and unresolved aliases are counted as omissions.
114:
115:Portable handle grammar used across `search`, `get_symbol`, `packet_get`, `explain`, `refs`, `rename_preview`, `refactor_plan`, `calls`, `type_hierarchy`, and `implementations`:
116:
117:- `file:<url-encoded project-relative path>`
118:- `symbol:<url-encoded path>:<url-encoded local-name>:<line>:<column>`
119:- `chunk:<url-encoded path>:<line>`
120:- `sql:<url-encoded object-name>:<url-encoded path>:<line>`
121:- `graph:<url-encoded project-relative path>`
122:- review packet targets are separate quoted strings, not portable handles: `review:base=<encoded-ref>;head=<encoded-ref>`
123:
124:Positions use 1-based lines and 0-based UTF-16 columns, matching the rest of codegraph's range and navigation APIs.
125:
126:Position-based `goto` and `refs` requests (`file`, `line`, `column`) remain the primary navigation form. Alternatively, `goto.handle` and `refs.handle` accept an exact qualified identity, `<project-relative-file>::<local-symbol>`, without coordinates; each tool rejects mixed modes. `file_deps.file` accepts that identity or a portable `symbol:` handle, resolves its declaration, and returns file-graph dependencies; use `calls` for symbol-level callers and callees. Duplicate local names return an ambiguity error rather than selecting one.
127:
128:MCP tool name <-> CLI command mapping for the common handle-driven follow-ups:
129:
130:- `workspace_symbols` <-> `codegraph symbols`
131:- `search` <-> `codegraph search`
132:- `packet_get` <-> `codegraph packet get`
133:- `get_symbol` <-> `codegraph explain`
134:- `calls` <-> `codegraph callers` / `codegraph callees`
135:- `type_hierarchy` <-> `codegraph supertypes` / `codegraph subtypes`
136:
137:### Rename preview
138:
139:Call `rename_preview` with flat fields `handle`, `newName`, and optional `includeComments`, `includeStrings`, `includeFilenames`, and `maxEdits`. The edit limit defaults to 5000 and caps at 10000; comment and string candidates are opt-in, while filename suggestions require an eligible exported class, interface, or type whose filename matches its name.
140:
141:Responses contain exact project-relative edits, conflicts, unsafe sites, filename suggestions, candidate tests, provenance, freshness, and omissions. The tool reuses the server session, remains available in read-only mode, never changes files, and has no apply counterpart.
142:
143:### Refactor plan
144:
145:Call `refactor_plan` with flat fields `handle`, optional `renameTo`, independent optional `maxReferences`, `maxCallers`, and `maxHierarchy` values from 0 to 500, and optional `includeSource`. The configured MCP root is reused and cannot be overridden per request.
146:
147:The tool composes references, direct callers and callees, type relationships, implementations, section issues, candidate tests, omissions, and follow-ups from one session snapshot. Unsupported implementation sections contribute an omission and appear in `sectionIssues`; exact internal review or impact symbol handles are accepted, returned targets and commands use portable handles, and nested `rename.safe` remains authoritative when `renameTo` is present.
148:
149:### Call hierarchy
150:
151:Call `calls` with flat fields `direction` (`"callers"` or `"callees"`), `handle`, optional `depth`, optional `limit`, and optional `includeHeuristic`. Depth defaults to 1 and caps at 5; the symbol limit defaults to 25 and caps at 500.
152:
153:Both directions reuse the server session and freshness gate. Responses group exact project-relative callsites under each related symbol, sort deterministically, and report separate symbol, callsite, and unresolved-site omissions.
154:
155:Only resolved semantic `calls` edges are currently returned. `includeHeuristic` is accepted for forward compatibility but does not enable guessed dynamic dispatch; imports, arbitrary references, and file dependency edges remain outside call hierarchy.
156:
157:### Type hierarchy and implementations
158:
159:Call `type_hierarchy` with flat fields `direction` (`"supertypes"` or `"subtypes"`), `handle`, optional `depth`, and optional `limit`. Depth defaults to 1 and caps at 10; the result limit defaults to 25 and caps at 500.
160:
161:Call `implementations` with `handle` and optional `limit`; it has no depth field and the result limit defaults to 25, capped at 500. Both tools reuse the server's one session and freshness gate, return exact project-relative symbol locations plus provenance and omissions, and reject stale handles, non-type hierarchy targets, or unsupported targets with actionable errors.
162:
163:Only resolved, indexed `extends` and `implements` relationships are returned. Implementation targets are limited to interfaces, traits, abstract types, and members with proven implementation or override relationships; exact implementing declarations are returned, inherited declarations are deduplicated, and overloads, dynamic or structural conformance, and unresolved external bases are not guessed.
164:
165:### `get_file`
166:
167:Call `get_file` with a project-relative `file`. `offset` is the 1-based first line, `limit` is the maximum returned lines, and `maxBytes` bounds unnumbered raw page text including its line separators; defaults are `1`, `2000`, and `80000`, with output-page caps of `10000` lines and `500000` bytes. A separate 16 MiB hard input-size limit rejects larger raw reads and structural text-config summaries before unbounded I/O, bounding complete-stream binary/UTF-8 validation and total-line counting rather than returned page size.
168:
169:```json
170:{
171:  "file": "src/auth.ts",
172:  "offset": 41,
173:  "limit": 2,
174:  "maxBytes": 80000,
175:  "includeGraphContext": false,
176:  "allowSensitive": false
177:}
178:```
179:
180:The response always has `schemaVersion`, `file`, effective `offset` and `limit`, exact whole-file `totalLines`, numbered `content`, `lineFormat`, unnumbered `text`, `truncated`, and `freshness`. It adds `page: { nextOffset }` when more lines remain, `graphContext: { usedBy, imports, symbols }` when requested and indexed, and `sensitive: { kind, redacted, allowSensitiveRequired }` for recognized sensitive paths.
181:
182:```json
183:{
184:  "schemaVersion": 1,
185:  "file": "src/auth.ts",
186:  "offset": 41,
187:  "limit": 2,
188:  "totalLines": 126,
189:  "content": "41\texport function authenticate(request) {\n42\t  return verify(request);",
190:  "lineFormat": "number-tab-line",
191:  "text": "export function authenticate(request) {\n  return verify(request);",
192:  "truncated": false,
193:  "freshness": { "state": "fresh" },
194:  "page": { "nextOffset": 43 }
195:}
196:```
197:
198:Each `content` row is an unpadded decimal line number, one tab, and the source line. A file-ending newline is a final numbered empty line, `totalLines` counts it, and clients should continue at `page.nextOffset` rather than deriving the next page from byte length.
199:
200:For raw pages, `maxBytes` can end a page before `limit`; `truncated` is true when the byte boundary cuts the selected line. Number prefixes are not part of that raw-text byte budget, so bounded `text` and formatted `content` have different byte sizes.
201:
202:`includeGraphContext` defaults to `false` to avoid an index build, unnecessary repository disclosure, and stale graph data on ordinary reads. When true, `graphContext` contains at most 100 sorted direct `usedBy` paths, resolved or external `imports`, and `{ name, kind, line }` symbols; `freshness` applies to this context, never to the live file page.
203:
204:Within the 16 MiB input limit, ordinary reads and structural summaries for recognized environment, authentication-config, and credential-config text files validate the full raw stream before returning bounded content or extracting bounded keys; known binary extensions, NUL bytes, and malformed or incomplete UTF-8 are rejected. Default key-material summaries use file metadata, may report size, and do not read raw secret bytes while marking `sensitive.redacted: true`; `allowSensitive: true` requests raw values but does not bypass the input-size, binary, NUL, or UTF-8 guards, so `.p12` and `.pfx` bundles summarize by default and reject raw access. For text-config summaries, `truncated` reports an incomplete bounded structural scan.
205:
206:### Exact-path `explore`
207:
208:An MCP `explore` request whose entire query resolves to an indexed project-relative file path, or one uniquely matching basename, includes the same live response under `fileView`. Set `includeSource: false` to suppress it; use `get_file` when pagination, graph context, or an intentional raw sensitive read needs explicit controls.
209:
210:```json
211:{ "query": "src/auth.ts", "includeSource": true }
212:```
213:
214:## Safety
215:
216:- File and artifact paths are confined to `--root` after realpath resolution.
217:- Tool calls do not accept per-request root overrides.
218:- Tools are read-only by default.
219:- `artifact_build` requires `--allow-build` and a fresh or auto-refreshed MCP index.
220:- `query_sqlite` rejects mutating SQL, recursive queries, synthetic payload functions, and stale artifact queries it cannot refresh safely.
221:- `get_file` rejects raw reads and structural text-config summaries over the 16 MiB input limit. Accepted reads use separate output-page bounds from `maxBytes`, `offset`, and `limit`; binary input is rejected, and sensitive formats require `allowSensitive: true` for raw values.
222:- SQLite responses are row- and byte-bounded.
223:
224:## Installer
225:
226:Run `codegraph install` interactively to detect supported local clients, preview exact proposed changes, and confirm once:
227:
228:```bash
229:codegraph install
230:codegraph install --target codex,claude --dry-run
231:codegraph install --target codex,claude --yes
232:codegraph install --target codex --yes --force
233:codegraph install --print-config codex
234:```
235:
236:Interactive confirmation defaults to no, and noninteractive writes require `--yes`. The installer writes only codegraph-owned marker blocks, marker files, bundled skill payloads, or exact installer-owned MCP entries; `codegraph uninstall --target <ids> --yes` removes only those owned entries. A pre-existing `SKILL.md` is overwritten only when a Codegraph ownership marker and known payload match, or when `--force` is passed.
237:
238:Restart or reload configured clients after applying changes. The installer prints restart and first-query guidance but does not claim an MCP connection until a handshake occurs.
239:
240:## Client Configuration Examples
241:
242:Use `command: "codegraph"` when the CLI is on `PATH`. Use the full executable path when the client runs with a narrower environment.
243:
244:### Generic stdio JSON
245:
246:```json
247:{
248:  "mcpServers": {
249:    "codegraph": {
250:      "command": "codegraph",
251:      "args": ["mcp", "serve", "--root", ".", "--stdio"]
252:    }
253:  }
254:}
255:```
256:
257:### Generic Streamable HTTP
258:
259:Start one codegraph process per repository:
260:
261:```bash
262:codegraph mcp serve --root /path/to/repo --port 7331 --warmup
263:```
264:
265:Point each MCP client at the shared endpoint:
266:
267:```json
268:{
269:  "mcpServers": {
270:    "codegraph": {
271:      "type": "http",
272:      "url": "http://127.0.0.1:7331/mcp"
273:    }
274:  }
275:}
276:```
277:
278:For TOML-based clients, the same setup is usually expressed as a URL-backed server:
279:
280:```toml
281:[mcp_servers.codegraph]
282:transport = "http"
283:url = "http://127.0.0.1:7331/mcp"
284:```
285:
286:### Codex
287:
288:Codex uses TOML under `[mcp_servers]`:
289:
290:```toml
291:[mcp_servers.codegraph]
292:command = "codegraph"
293:args = ["mcp", "serve", "--root", ".", "--stdio"]
294:startup_timeout_ms = 20000
295:```
296:
297:### Claude Code
298:
299:Claude Code can add a stdio server from JSON:
300:
…
318:
…
366:
…
390:If the first MCP call fails at startup or loses its transport, do not keep retrying that server. Run `codegraph doctor`, fall back to the equivalent CLI command for the current session, and restart the agent client after package upgrades.

[Showing lines 1-300 of 390. Use :301 to continue]