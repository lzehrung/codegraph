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
- bounded context for agents through explore, orientation, search, packets, explain, and MCP

Use plain text search for exact strings, logs, config keys, secrets, and prose. Do not treat codegraph as runtime proof; verify behavior with focused tests or execution.

## Choose the First Command

Bare `codegraph` prints five task-first routes without scanning the project. Use `codegraph --help` for the full command catalog and `codegraph help <command>` for command help; unknown commands suggest but never execute alternatives.

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

Use `--root` to define the boundary for config lookup, cache scope, path confinement, and output normalization.

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

### Review and Inspect

Safe shorthand: `impact` and git-backed `drift` default to `HEAD..WORKTREE`; `artifact`, `packet`, and `mcp` infer `build`, `get`, and `serve`. `grep <regex>` and `sql <db> "SELECT ..."` accept positional forms. Explicit options remain valid.

- compact review handoff: `codegraph review`
- broader change impact: `codegraph impact --base HEAD --head WORKTREE`
- affected test paths: `codegraph affected --base HEAD --head WORKTREE --quiet`
- architecture drift: `codegraph drift ./src --base origin/main --head HEAD --graph-edges summary --public-api removals`
- architecture summary: `codegraph inspect ./src --limit 20`
- prioritized cycles: `codegraph cycles --sort priority`
- duplicate cleanup: `codegraph duplicates --root . ./src --profile cleanup`
- full duplicate groups: `codegraph duplicates --root . ./src --json`

`inspect --duplicates` adds the slower bounded duplicate summary. Treat duplicate matches, candidate tests, and call-compatibility hints as review leads, not proof.

Current-state commands validate the on-disk index automatically and default to the disk cache, so `index` and `sync` only prewarm or repair state and are never prerequisites for a query. `--cache off|memory|disk` stays explicit, `--cache-verify` and `--cache-strict` request stronger checks, and `drift`/`graph-delta` keep revision-range semantics instead. `review` and `impact` diff ranges select what to analyze independently from the complete current-project index, so repeated unchanged ranges reuse a warm manifest without narrowing graph, symbol, candidate-test, or duplicate context.

## Choose Output by Consumer

- Human or model reading one result: use the human-readable default with no output flag; `review` is already compact.
- Tool chaining, filtering, stable handles, exact ranges, or schema fields: use `--json`. If `--json` and `--pretty` are both present, `--json` wins.
- Repeated agent queries over one repo snapshot: prefer MCP so the index stays warm. MCP inputs are flat JSON objects and the server root is fixed at startup; send only fields in the mounted tool schema, never CLI flags such as `--root` or `--json`. If the first MCP call fails at startup or loses its transport, do not retry the same server; run `codegraph doctor`, use the equivalent CLI command for this session, and restart the agent client after package upgrades.
- Durable graph handoff: use `codegraph graph --root . ./src --json --output codegraph.json` rather than parsing display text.
- Search and inspect performance diagnosis: add `--report` for JSON on stderr or `--report-file <path>` for a file while keeping normal command output unchanged.

### Human Graph Viewer

`viewer` is for a human inspecting a graph, not an agent interface; use graph JSON, SQLite, MCP, or `--json` for structured agent work. Its contract is `codegraph viewer [--root <root>] [--graph <root-confined-json>] [--host <host>] [--port <0-65535>] [--open] [--print-url]`, with the current directory, `127.0.0.1`, and `4173` as the default root, host, and port.

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

If MCP tools are available, prefer them over repeated CLI invocations. Use `explore`, `orient`, `workspace_symbols`, `search`, `get_file`, `packet_get`, `goto`, `refs`, `rename_preview`, `refactor_plan`, `calls`, `type_hierarchy`, `file_deps`, `path`, `impact`, `review`, and `query_sqlite`; fall back to the CLI when MCP is unavailable. Legacy `callers`/`callees`, `supertypes`/`subtypes`, and `deps`/`rdeps` names remain valid `tools/call` aliases.

codegraph uses the official MCP SDK v2 to serve current 2026-07-28 clients while retaining compatibility with 2025-era clients. MCP protocol connections and HTTP protocol sessions keep separate transport state, but all share the server's one warm codegraph analysis session for the configured root.
On the first `tools/call`, codegraph can emit `notifications/message` and, when the request includes `_meta.progressToken`, `notifications/progress` before the final result. Stdio carries them inline, and modern Streamable HTTP clients that accept `text/event-stream` receive them as a stream until the terminal result frame.
HTTP enforces Host and Origin policies. A missing `Origin` is accepted for non-browser clients; unapproved, malformed, and opaque origins are rejected. This is not authentication: binding `--host` to a non-loopback address exposes an unauthenticated endpoint intended only for trusted networks or containers.

Use `refactor_plan` with flat `handle`, optional `renameTo`, independent optional `maxReferences`, `maxCallers`, and `maxHierarchy` bounds from 0 to 500, and optional `includeSource`. It reuses the configured server root and one session snapshot, returns portable targets and structured tool-call follow-ups even for exact internal review handles, exposes unsupported implementation sections in `sectionIssues`, preserves nested `rename.safe`, and never writes.
Use `workspace_symbols` for deterministic symbol identities and exact ranges; use `search` when paths, prose, SQL, snippets, or graph evidence should participate.
Use `type_hierarchy` with `direction: "supertypes" | "subtypes"` and `implementations` with portable symbol handles for repeated hierarchy queries; schemas are flat and use the same 10-depth and 500-result caps as the CLI.
Use `calls` with `direction: "callers" | "callees"` and portable callable handles for repeated call hierarchy queries. The flat schema accepts `handle`, `direction`, `depth`, `limit`, and `includeHeuristic`, reuses the MCP freshness gate, and caps depth at 5 and symbols at 500; current results remain semantic-only.
Use `file_deps` with `direction: "deps" | "rdeps"` for file-level dependency queries. Its `file` field accepts an exact `file::symbol` path or portable `symbol:` handle and resolves either to the declaring file; use `calls` for symbol-level relationships.
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
codegraph install --all --dry-run
codegraph install --all --yes
```

Interactive confirmation accepts only `y` or `yes` and defaults to no. Noninteractive writes require `--yes`. `--all` is install-only, configures `codex`, `claude`, `cursor`, `gemini`, `opencode`, `omp`, `kilo`, and `agents`, and cannot be combined with target selection, `--detect`, or `--print-config`.

Compatible JSON MCP entries and equivalent unmarked Codex tables are preserved byte-for-byte. Kilo JSONC comments and unrelated settings remain intact. Divergent codegraph entries are collision-reported without exposing configuration values.

The installer manages codegraph-owned MCP entries, skill payloads, and marker files; uninstall removes only recognized codegraph-owned content.

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

Package and source installs require Node.js 22.16 or newer; standalone archives bundle Node.js.

For the preview standalone channel, use the release bootstrap appropriate to the host:

```powershell
irm https://github.com/lzehrung/codegraph/releases/latest/download/install.ps1 | iex
```

```bash
curl -fsSL https://github.com/lzehrung/codegraph/releases/latest/download/install.sh | sh
```

The standalone Linux archives require glibc. On musl Linux, use the package or source installation path instead.

The bootstrap previews its target and paths, then confirms interactively or requires `-Yes`/`--yes` for noninteractive writes. It verifies the selected archive against release `SHA256SUMS`, rejects unsafe entries, installs under a versioned user-owned root, and records the prior version; pin or roll back with `./install.ps1 -Version VERSION` or `sh ./install.sh --version VERSION`. This channel is checksummed preview content, not a signed release claim.

For package installs, use only the scoped packages:

- product package (CLI/MCP/viewer): `@lzehrung/codegraph`
- slim library install: `@lzehrung/codegraph-core`
- agent-shaped APIs: `@lzehrung/codegraph/agent` or `@lzehrung/codegraph-core/agent`
- MCP handlers/server: `@lzehrung/codegraph/mcp`
- optional native runtime: `@lzehrung/codegraph-native`

```bash
npm login --scope=@lzehrung --auth-type=legacy --registry=https://npm.pkg.github.com
npm config set "@lzehrung:registry" "https://npm.pkg.github.com"
npm install -g @lzehrung/codegraph
codegraph doctor
codegraph install --all --dry-run
codegraph install --all --yes
```

GitHub Packages requires a classic token with `read:packages`, including for public packages. Use the GitHub username and token during `npm login`.

Do not suggest the unscoped `codegraph` package. Published installs resolve the optional native runtime when a compatible artifact exists; otherwise codegraph reports reduced graph-only and regex recovery behavior rather than semantic parity.

On Windows, installed releases load native code from `%LOCALAPPDATA%\codegraph\native-cache\v1`. The first upgrade from an older direct-loading release requires closing codegraph MCP clients once, running `npm install -g @lzehrung/codegraph@latest`, and restarting the clients.

Use `codegraph doctor` to inspect `native.origin`, cache fallback errors, stale `.codegraph-*` npm retirement siblings, and installed-versus-running version drift. Do not delete reported paths or kill Node/IDE processes automatically; restart the owning client explicitly, and only clean obsolete cache entries after every process using them has stopped.
