---
name: codegraph
description: "Use for repo structure, symbol navigation, dependency analysis, duplicate triage, and PR impact review when plain text search is too shallow."
---

# codegraph

Use codegraph when a repository question depends on structure rather than exact text:

- architecture, hotspots, cycles, unresolved imports, and public API surface
- definitions, references, dependencies, reverse dependencies, and paths
- PR or worktree impact, candidate tests, affected test lists, and risk signals
- duplicate cleanup and refactor-risk triage
- local Markdown link validation with exact ranges and no network access
- bounded context for agents through explore, orientation, search, packets, explain, and MCP

Use plain text search for exact strings, logs, config keys, secrets, and prose. Do not treat codegraph as runtime proof; verify behavior with focused tests or execution.

## Choose the First Command

Bare `codegraph` prints five task-first routes without scanning the project. Use `codegraph --help` for the full command catalog and `codegraph help <command>` for command help; unknown commands suggest but never execute alternatives.

Exit `0` means completion without a failure condition. Exit `1` can mean findings, no matching target, or a runtime failure. Inspect its output before continuing; findings and no matching targets are actionable, while runtime or analysis failures need error handling.

Exit `2` means invalid usage or input. `links` uses `1` for broken local links; do not treat it as an invocation error.

| Task                                                      | Start here                                               |
| --------------------------------------------------------- | -------------------------------------------------------- |
| Review staged and unstaged work                           | `codegraph review`                                       |
| Review a branch against main                              | `codegraph review --base origin/main --head HEAD`        |
| Map the wider blast radius of a change                    | `codegraph impact --base HEAD --head WORKTREE`           |
| Select deterministic test paths for changed files         | `codegraph affected --base HEAD --head WORKTREE --quiet` |
| Answer a concrete question about an unfamiliar repo       | `codegraph explore "how does auth reach db?" --root .`   |
| Map a repo before you know the question                   | `codegraph orient --root . --budget small`               |
| Diagnose installation, native runtime, or artifact health | `codegraph doctor`                                       |

Prefer `review` before `impact`: review is the compact reviewer handoff; impact is the broader "what could this break?" map. Both are safe bounded accelerants for another agent's own review workflow (human-readable `impact`, `review --duplicates off`); they do not own reviewer lanes, packets, or finding ledgers. Prefer `explore` before `orient` when you already have a concrete question.

## Keep the Project Boundary Explicit

Use `--root` to define the boundary for config lookup, path confinement, and output normalization. Cache contents use project-relative paths and may live at the resolved repository anchor; override location with `--cache-dir` or `CODEGRAPH_CACHE_DIR`. An overridden anchor pointing at the home directory or a filesystem root is rejected with an error.

- Positional paths are include roots inside the project boundary for `orient`, `drift`, and positional graph commands.
- `codegraph.config.json` discovery globs are project-root-relative.
- `languages.extensions` maps literal suffixes such as `.tpl` to supported language IDs; longest suffix wins, while `.vue` and `.svelte` cannot be remapped.
- CLI `--include-glob` and `--ignore-glob` values are one-off filters relative to each active scan root.
- Use `--no-gitignore` only when ignored files are intentionally in scope.
- Commands that load the project index first report cache validation as `Checking project index`, then report build or update progress only when index work is required. Warm cache hits complete as `Checked project index` without claiming a rebuild. Use `--progress` for redirected logs or `--no-progress` to suppress feedback, and JSON stdout remains unchanged.

## Choose the Smallest Follow-up

### Understand

- answer a question with bounded evidence: `codegraph explore "how does auth reach db?" --root .`
- find a ranked anchor: `codegraph search "auth user" --json`
- resolve a known symbol identity: `codegraph symbols "CodeReviewSession" --root .`
- explain a known target: `codegraph explain <file|symbol|sql-object|handle>`
- retrieve bounded indexed context: `codegraph packet get <file|symbol|sql-object|handle>`
- read current disk content: `codegraph file <path> --offset 1 --limit 200`

`explore` returns ranked anchors, bounded packets, dependency paths, blast radius, candidate tests, explicit limits, omission counts, and copyable follow-ups. Human-readable output ends with `Recommended next:` using the first bounded follow-up; JSON keeps the stable `schemaVersion: 1` fields and `followUps` array as tool-call descriptors (`{tool, arguments, label?}`), not CLI strings. Hybrid search is code-first by default, and search, explain, explore, and review preserve analysis labels so reduced or mixed runs remain visible.

Use `search --no-snippets` when handles and paths are sufficient and source text will be fetched separately with `file`. Use `explain --changed-context` for bounded source context around changed ranges in changed-file or review workflows.

Use `symbols` instead of hybrid `search` when only declarations should compete. It supports `--kind <kind,...>`, `--exported`, `--include-imports`, project-relative `--file-glob`, and `--limit <0-500>`; imports default off, and only named/default aliases that resolve to concrete declarations are returned.
Use the portable callable handle from `symbols` with `codegraph callers <handle>` or `codegraph callees <handle>`. Depth defaults to 1 and caps at 5, the symbol limit defaults to 100 and caps at 500, pretty grouped callsites are the default, and `--json` returns the structured envelope.

Call hierarchy contains resolved semantic `calls` edges only. `--include-heuristic` is accepted but currently adds no guessed dynamic calls; use `refs` for all references and `deps` or `rdeps` for file relationships.

Use a portable handle, unique exact symbol name, single-definition file, or source location with `codegraph supertypes <target>`, `codegraph subtypes <target>`, or `codegraph implementations <target>`. Hierarchy depth defaults to 1 and caps at 10; all result limits default to 100 and cap at 500, and the default output is the concise human-readable form.

Hierarchy results contain only proven indexed `extends` and `implements` relationships. Implementation targets are interfaces, traits, abstract types, and members with proven implementation or override relationships; exact declarations are returned, while overloads, dynamic or structural conformance, unrelated same-name methods, and unresolved external bases are not guessed.

Use `codegraph rename-preview <target> <new-name> --json` to plan a semantic rename without changing files. Add `--include-comments`, `--include-strings`, or `--include-filenames` only when needed, and use `--max-edits <1-10000>` to bound the plan.

Treat `safe: false`, conflicts, unsafe sites, and omissions as blockers. Eligible exported class, interface, and type filename results are suggestions only; codegraph has no apply command or tool.

Use `codegraph refactor-plan <target>` to compose references, direct callers and callees, hierarchy, implementations, section issues, candidate tests, omissions, and copyable follow-ups from one snapshot. It accepts portable search or workspace-symbol handles and exact internal review or impact symbol handles; add `--rename <new-name>` only when the packet should include the authoritative nested rename preview.

The independent `--max-references`, `--max-callers`, and `--max-hierarchy` bounds accept 0 to 500, and `--include-source` opts reference context into output. Treat `sectionIssues`, omissions, and nested `rename.safe` as authoritative; the packet is read-only and has no apply action.

### Navigate

- dependencies: `codegraph deps <file|file::symbol|symbol:...>`
- reverse dependencies: `codegraph rdeps <file|file::symbol|symbol:...>`
- shortest path: `codegraph path <from> <to>`
- definition at a source location: `codegraph goto <file>:<line>:<column>`
- references at a source location: `codegraph refs <file>:<line>:<column>`
- definition or references without coordinates: `codegraph goto|refs <file>::<symbol>`
- references for every definition in a file: `codegraph refs <file>`

Use line and column coordinates when known; this is the primary navigation form. Use an exact project-relative `file::symbol` path when coordinates are unavailable; it cannot be combined with line or column input. `deps` and `rdeps` accept either form or a portable `symbol:` handle and resolve it to its defining file, while `callers` and `callees` expose symbol-level calls. Duplicate local names return declaration candidates; run `codegraph symbols` to get a portable handle.
Safe shorthand: `impact` and git-backed `drift` default to `HEAD..WORKTREE`; `artifact`, `packet`, and `mcp` infer `build`, `get`, and `serve`. `artifact --sqlite` is equivalent to `artifact build --sqlite`; `grep <regex>` and `sql <db> "SELECT ..."` accept positional forms. Explicit options remain valid. `grep --json` returns an envelope `{ items, limit, totalSeen, truncated, omitted }`, not a bare hit array: `limit` is the effective `--max-hits` cap for text greps (default 5000, capped at 200000) and `null` for uncapped `--query` AST greps. Check `truncated` before treating text results as complete, and raise `--max-hits` when it is true - `truncated` stays exact through that ceiling. `graph` output selectors are mutually exclusive.

- compact review handoff: `codegraph review`
- broader change impact: `codegraph impact --base HEAD --head WORKTREE`
- impact with candidate tests: `codegraph impact --base HEAD --head WORKTREE --include-tests`
- affected test paths: `codegraph affected --base HEAD --head WORKTREE --quiet`
- architecture drift: `codegraph drift ./src --base origin/main --head HEAD --graph-edges summary --public-api removals`
- architecture summary: `codegraph inspect ./src --limit 20`
- prioritized cycles: `codegraph cycles --sort priority`
- duplicate cleanup: `codegraph duplicates --root . ./src --profile cleanup`
- full duplicate groups: `codegraph duplicates --root . ./src --json`
- local Markdown link check: `codegraph links --json`
- exported API summary: `codegraph apisurface --root . --json`
- embedding-ready file chunks: `codegraph chunk src/auth.ts --json`
- one indexed module: `codegraph dumpmod src/auth.ts --json`
- prewarm or repair disk state: `codegraph index --root .`
- inspect complex files: `codegraph hotspots --root . --limit 20`
- list unresolved source imports: `codegraph unresolved --root . --json`
- search text with a regex: `codegraph grep "TODO|FIXME" --glob "src/**/*.ts"`
- query an exported SQLite graph: `codegraph sql codegraph.sqlite "SELECT * FROM files LIMIT 20"`
- compare graph changes across revisions: `codegraph graph-delta --git-base origin/main --git-head HEAD --json`
- create a durable artifact: `codegraph artifact --root . --out codegraph-out --sqlite --graph-json`
- start a warm local tool server: `codegraph mcp --root . --stdio`

`links` checks root-confined local Markdown links and GitHub-style heading fragments, including raw HTML `a[href]` in `.md` files. It skips external URLs and unsupported formats; exit 1 reports broken links. Discovery honors `codegraph.config.json` discovery globs plus CLI `--include-glob` / `--ignore-glob` / `--no-gitignore`. `review` and non-empty `impact` include the same `markdownLinks` findings; `unresolved` excludes document edges.

`inspect --duplicates` adds the slower bounded duplicate summary. Treat duplicate matches, candidate tests, and call-compatibility hints as review leads, not proof.

Current-state commands validate the on-disk index automatically and default to the disk cache, so `index` and `sync` only prewarm or repair state and are never prerequisites for a query. `--cache off|memory|disk` stays explicit, `--cache-verify` and `--cache-strict` request stronger checks, and `drift`/`graph-delta` keep revision-range semantics instead. `review` and `impact` diff ranges select what to analyze independently from the complete current-project index, so repeated unchanged ranges reuse a warm manifest without narrowing graph, symbol, candidate-test, or duplicate context.

## Choose Output by Consumer

- Human or model reading one result: use the human-readable default with no output flag; `review` is already compact.
- Tool chaining, filtering, stable handles, exact ranges, or schema fields: use `--json`. If `--json` and `--pretty` are both present, `--json` wins. `viewer` and `mcp` reject `--json`/`--pretty` because they do not emit structured command output.
- Repeated agent queries over one repo snapshot: prefer MCP so the index stays warm. MCP inputs are flat JSON objects and the server root is fixed at startup; send only fields in the mounted tool schema, never CLI flags such as `--root` or `--json`. Unknown tool fields are rejected as invalid parameters. If the first MCP call fails at startup or loses its transport, do not retry the same server; run `codegraph doctor`, use the equivalent CLI command for this session, and restart the agent client after package upgrades.
- Durable graph handoff: use `codegraph graph --root . ./src --json --output codegraph.json` rather than parsing display text. `graph --json` and `index --json` payloads include an `analysis` object (`mode`, `backend`, `label`, fallback counts); when `mode` is `mixed` or `reduced` the run used regex/graph-only extraction for some or all files, so treat symbol accuracy accordingly. Degraded runs also print a `Backend:` warning on stderr even without `--progress`.
- Search and inspect performance diagnosis: add `--report` for JSON on stderr or `--report-file <path>` for a file while keeping normal command output unchanged.

### Human Graph Viewer

`viewer` is for a human inspecting a graph, not an agent interface; use graph JSON, SQLite, MCP, or `--json` for structured agent work. Its contract is `codegraph viewer [--root <root>] [--graph <root-confined-json>] [--host <host>] [--port <0-65535>] [--open] [--print-url]`, with the current directory, `127.0.0.1`, and `4173` as the default root, host, and port. Do not pass `--json` to `viewer`.

```bash
codegraph viewer --root . --open
codegraph viewer --root . --graph codegraph-out/graph.json --open
codegraph viewer --root . --port 4173 --print-url
```

`--print-url` is preview-only: it prints the deterministic URL and exits without starting a server, rejects `--open`, and rejects port `0`. Without `--graph`, each load or reload builds the current project graph through the automatically validated disk cache; `init`, `index`, and exported JSON are not prerequisites. An explicit `--graph` is served through the same `/graph.json` route; manual upload remains available, and the viewer loads Sigma, Graphology, and ForceAtlas2 from bundled local vendor assets (no CDN).

Do not parse pretty output to recover fields already available in structured output.

## Live Reads and Sensitive Files

Use `codegraph file <path>` for current disk content. Readable numbered lines are the default; add `--json` for structured pagination fields.

```bash
codegraph file src/auth.ts --offset 201 --limit 200 --max-bytes 80000
codegraph file src/auth.ts --include-graph-context
```

Pagination and byte contracts:

- `--offset` is 1-based.
- `--limit` defaults to 2000 lines and is capped at 10000.
- `--max-bytes` defaults to 80000 unnumbered text bytes and is capped at 500000.
- A separate 16 MiB input limit rejects larger raw reads and structural text-config summaries before unbounded I/O.
- `content` is exact `number<TAB>line` text; `text` omits line-number prefixes.
- Follow `page.nextOffset`. Beyond EOF, JSON fields are empty and pretty output reports that no lines remain.

Live bytes and indexed context have different freshness rules:

- Plain file bytes come from disk and do not depend on index freshness.
- `--include-graph-context` opts into indexed `usedBy` paths, imports, and symbols.
- An exact project-relative query such as `codegraph explore src/auth.ts --json` adds `fileView` with the same live-read contract as `codegraph file`; `--no-source` suppresses it.

Sensitive-file rules:

- Recognized environment, authentication, and credential text configs return structural summaries by default.
- Key material defaults to metadata and may report file size without reading raw secret bytes.
- Use `--allow-sensitive` only for deliberate raw access.
- `--allow-sensitive` never bypasses input-size, binary, NUL, or UTF-8 guards; `.p12` and `.pfx` remain metadata-only in practice.

## MCP and Freshness

If MCP tools are available, prefer them over repeated CLI invocations. Use `explore`, `orient`, `workspace_symbols`, `search`, `get_file`, `get_symbol`, `packet_get`, `goto`, `refs`, `rename_preview`, `refactor_plan`, `calls`, `type_hierarchy`, `implementations`, `file_deps`, `path`, `impact`, `review`, `query_sqlite`, `refresh_index`, and `artifact_build`; fall back to the CLI when MCP is unavailable. Legacy `callers`/`callees`, `supertypes`/`subtypes`, and `deps`/`rdeps` names remain valid `tools/call` aliases.

codegraph uses the official MCP SDK v2 to serve current 2026-07-28 clients while retaining compatibility with 2025-era clients. MCP protocol connections and HTTP protocol sessions keep separate transport state, but all share the server's one warm codegraph analysis session for the configured root. Tool schemas reject unknown fields, each protocol session caps tool concurrency at 4 with a retryable busy error, HTTP request bodies time out after 30 seconds, and idle HTTP protocol sessions are evicted with a bounded session count. Cancellation responds to the caller promptly but retains the occupied slot until shared work settles, so abandoned calls cannot bypass that resource bound. Concurrent `refresh_index` calls serialize and honor each request's requested warmup.
On the first `tools/call`, codegraph can emit `notifications/message` and, when the request includes `_meta.progressToken`, `notifications/progress` before the final result. Stdio carries them inline, and modern Streamable HTTP clients that accept `text/event-stream` receive them as a stream until the terminal result frame.
HTTP enforces Host and Origin policies. A missing `Origin` is accepted for non-browser clients; unapproved, malformed, and opaque origins are rejected. This is not authentication: binding `--host` to a non-loopback address exposes an unauthenticated endpoint intended only for trusted networks or containers.
For a reusable local HTTP server, run `codegraph server start --root . --warmup`, inspect it with `codegraph server status --root . --json`, and shut it down with `codegraph server stop --root .`. The lifecycle wrapper serializes project changes, writes `.codegraph/server.json` only after `/health` matches the root, process, and startup time, defaults to `127.0.0.1:7331`, and accepts `--startup-timeout-ms <1-86400000>` for warmups longer than 15 seconds. Add `--json` to start for `status: "started"`, the registry fields, and update state; unreachable or identity-mismatched servers require verification and retain their registry.
For stdio lifecycle control, pass `--idle-timeout-ms <milliseconds>`; `0` disables the timer and the option is rejected with HTTP `--port` transport.

Use `refactor_plan` with flat `handle`, optional `renameTo`, independent optional `maxReferences`, `maxCallers`, and `maxHierarchy` bounds from 0 to 500, and optional `includeSource`. It reuses the configured server root and one session snapshot, returns portable targets and structured tool-call follow-ups even for exact internal review handles, exposes unsupported implementation sections in `sectionIssues`, preserves nested `rename.safe`, and never writes.
Use `workspace_symbols` for deterministic symbol identities and exact ranges; use `search` when paths, prose, SQL, snippets, or graph evidence should participate.
Use `type_hierarchy` with `direction: "supertypes" | "subtypes"` and `implementations` with portable symbol handles for repeated hierarchy queries; schemas are flat and use the same 10-depth and 500-result caps as the CLI.
`refs` and `file_deps` collection limits default to 25 and cap at 500. `query_sqlite` row limits default to 100 and cap at 500 (`src/sqlite/rowBounds.ts`); its 10-second deadline can reject a long-running query, and concurrent calls can temporarily fail while an expired native step completes its bounded cleanup.

Use `calls` with `direction: "callers" | "callees"` and portable callable handles for repeated call hierarchy queries. The flat schema accepts `handle`, `direction`, `depth`, `limit`, and `includeHeuristic`, reuses the MCP freshness gate, and caps depth at 5 and symbols at 500; current results remain semantic-only.
Use `file_deps` with `direction: "deps" | "rdeps"` for file-level dependency queries. Its `file` field accepts an exact `file::symbol` path or portable `symbol:` handle and resolves either to the declaring file; use `calls` for symbol-level relationships. `refs` and `file_deps` pair their collections with `limit`, `totalSeen`, `truncated`, and `omitted`; when `truncated` is true the result is a capped prefix, so rerun with a higher `limit` instead of treating it as complete. MCP `review` is bounded for transport: collections are capped at the response's `limits` with exact `omittedCounts`, while `summary` totals always describe the full report.
Use `rename_preview` with `handle`, `newName`, optional boolean inclusion fields, and optional `maxEdits`. It remains available in read-only mode, reuses the MCP session, never changes files, and has no apply counterpart.

Keep live and indexed evidence distinct:

- `get_file` returns bounded live bytes with `offset`, `limit`, and `maxBytes`; continue at `page.nextOffset`.
- Set `allowSensitive: true` only for intentional sensitive reads.
- Set `includeGraphContext: true` only when freshness-backed context is needed; importers, imports, and symbols are each capped at 100.
- Plain `get_file` freshness does not gate live bytes.
- After indexed calls, check `freshness` before trusting graph or semantic context. `refreshed` means codegraph rebuilt; `stale` includes a reason and bounded changed-file metadata.
- Run `refresh_index` before `artifact_build` when the index is stale. Artifact writes refuse stale snapshots.
- After an install or codegraph update, restart or reload the owning MCP client. `codegraph doctor --json` diagnoses package/native version identity; `refresh_index` refreshes repository state only and does not reload MCP code or tools.

## Agent Setup and Project Lifecycle

Run the guided installer interactively to detect clients, preview exact actions, and confirm once. Use `--all` to configure the complete current catalog without detection:

```bash
codegraph install
codegraph install --target codex,claude --dry-run
codegraph install --print-config codex
codegraph install --target codex,claude --yes
codegraph install --target codex --yes --force
codegraph install --all --dry-run
codegraph install --all --yes
codegraph uninstall --target codex --yes
```

Use `codegraph version` to inspect package identity and `codegraph skill doctor` to inspect bundled skill targets.

Interactive confirmation accepts only `y` or `yes` and defaults to no. Noninteractive writes require `--yes`. `--all` is install-only, configures `codex`, `claude`, `cursor`, `gemini`, `opencode`, `omp`, `kilo`, and `agents`, and cannot be combined with target selection, `--detect`, or `--print-config`.

Compatible JSON MCP entries and equivalent unmarked Codex tables are preserved byte-for-byte. Kilo JSONC comments and unrelated settings remain intact. Divergent codegraph entries are collision-reported without exposing configuration values.

The installer manages codegraph-owned MCP entries, skill payloads, and marker files; uninstall removes only recognized codegraph-owned content. Existing user-owned `SKILL.md` files are preserved unless an ownership marker and known payload match, or `--force` is passed.

Lifecycle commands manage `.codegraph/manifest.json`; other commands do not require that manifest:

```bash
codegraph init --root .
codegraph status --root . --json
codegraph sync --root .
codegraph uninit --root .
# Opt out only when initializing
codegraph init --root . --no-update-gitignore
codegraph sync --root . --init --no-update-gitignore
```

`init` and `sync --init` use Git's effective ignore semantics before lifecycle hashing. When the untracked manifest is not already ignored, they append exactly `.codegraph/` to the resolved root's `.gitignore`; effective parent/global/info excludes are honored, tracked manifests are left unchanged with a warning, and non-Git roots are not modified.

Use `--no-update-gitignore` to opt out during `init` or `sync --init`; ordinary `sync` never updates ignore policy. `uninit` removes lifecycle state but leaves the root rule, while `init` and `sync` may warm or update `.codegraph-cache/index-v1/`.

Lifecycle commands accept either one positional project path or `--root <path>`, never both. Automatic ignore updates are bound to that same resolved project root.

## Installation

For normal CLI and MCP use, install from public npm with Node.js 22.16 or newer:

```bash
npm install -g @lzehrung/codegraph
codegraph doctor
codegraph install --all --dry-run
codegraph install --all --yes
```

Public npm installs need no GitHub token or `@lzehrung` registry mapping. Do not suggest the unscoped `codegraph` package. If `.npmrc` still maps `@lzehrung` to `https://npm.pkg.github.com`, remove or replace that legacy mapping; npm otherwise selects GitHub Packages instead of current public releases.

Published installs resolve the optional native runtime when a compatible artifact exists; otherwise codegraph reports reduced graph-only and regex recovery behavior rather than semantic parity.

For library or API consumers, use only the scoped packages:

- slim library install: `@lzehrung/codegraph-core`
- agent-shaped APIs: `@lzehrung/codegraph/agent` or `@lzehrung/codegraph-core/agent`
- MCP handlers/server: `@lzehrung/codegraph/mcp`
- optional native runtime: `@lzehrung/codegraph-native`

No Node.js or npm? The preview standalone archive is self-contained: it bundles Node.js, production dependencies, the matching native runtime, and the codegraph skill.

```powershell
irm https://github.com/lzehrung/codegraph/releases/latest/download/install.ps1 | iex
```

```bash
curl -fsSL https://github.com/lzehrung/codegraph/releases/latest/download/install.sh | sh
```

The standalone Linux archives require glibc. On musl Linux, use the package or source installation path instead. The bootstrap previews its target and paths, then confirms interactively or requires `-Yes`/`--yes` for noninteractive writes. It verifies the selected archive against release `SHA256SUMS`, rejects unsafe entries, installs under a versioned user-owned root, and records the prior version; pin or roll back with `./install.ps1 -Version VERSION` or `sh ./install.sh --version VERSION`. This channel is checksummed preview content, not a signed release claim.

On Windows, installed releases load native code from `%LOCALAPPDATA%\codegraph\native-cache\v1`. The first upgrade from an older direct-loading release requires closing codegraph MCP clients once, running `npm install -g @lzehrung/codegraph@latest`, and restarting the clients.

Use `codegraph doctor` to inspect `native.origin`, cache fallback errors, stale `.codegraph-*` npm retirement siblings, and installed-versus-running version drift. Do not delete reported paths or kill Node/IDE processes automatically; restart the owning client explicitly, and only clean obsolete cache entries after every process using them has stopped.
