---
name: codegraph
description: "Use for repo structure, symbol navigation, dependency analysis, duplicate triage, and PR impact review when plain text search is too shallow."
---

# Codegraph

Use Codegraph when a repository question depends on structure rather than exact text:

- architecture, hotspots, cycles, unresolved imports, and public API surface
- definitions, references, dependencies, reverse dependencies, and paths
- PR or worktree impact, candidate tests, and risk signals
- duplicate cleanup and refactor-risk triage
- bounded context for agents through explore, orientation, search, packets, explain, and MCP

Use plain text search for exact strings, logs, config keys, secrets, and prose. Do not treat Codegraph as runtime proof; verify behavior with focused tests or execution.

## Choose the First Command

| Task                                                      | Start here                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| Review staged and unstaged work                           | `codegraph review --base HEAD --head WORKTREE --summary`        |
| Review a branch against main                              | `codegraph review --base origin/main --head HEAD --summary`     |
| Map the wider blast radius of a change                    | `codegraph impact --base HEAD --head WORKTREE --pretty`         |
| Answer a concrete question about an unfamiliar repo       | `codegraph explore "how does auth reach db?" --root . --pretty` |
| Map a repo before you know the question                   | `codegraph orient --root . --budget small --pretty`             |
| Diagnose installation, native runtime, or artifact health | `codegraph doctor`                                              |

Prefer `review` before `impact`: review is the compact reviewer handoff; impact is the broader "what could this break?" map. Prefer `explore` before `orient` when you already have a concrete question.

## Keep the Project Boundary Explicit

Use `--root` to define the boundary for config lookup, cache scope, path confinement, and output normalization.

- Positional paths are include roots inside the project boundary for `orient`, `drift`, and positional graph commands.
- `codegraph.config.json` discovery globs are project-root-relative.
- CLI `--include-glob` and `--ignore-glob` values are one-off filters relative to each active scan root.
- Use `--no-gitignore` only when ignored files are intentionally in scope.

## Choose the Smallest Follow-up

### Understand

- answer a question with bounded evidence: `codegraph explore "how does auth reach db?" --root . --pretty`
- find a ranked anchor: `codegraph search "auth user" --json`
- resolve a known symbol identity: `codegraph symbols "CodeReviewSession" --root . --pretty`
- explain a known target: `codegraph explain <file|symbol|sql-object|handle>`
- retrieve bounded indexed context: `codegraph packet get <file|symbol|sql-object|handle> --pretty`
- read current disk content: `codegraph file <path> --offset 1 --limit 200 --pretty`

`explore` returns ranked anchors, bounded packets, dependency paths, blast radius, candidate tests, explicit limits, omission counts, and copyable follow-ups. Hybrid search is code-first by default; search, explain, explore, and review output preserve analysis labels so reduced or mixed runs remain visible.

Use `symbols` instead of hybrid `search` when only declarations should compete. It supports `--kind <kind,...>`, `--exported`, `--include-imports`, project-relative `--file-glob`, and `--limit <0-500>`; imports default off and the default limit is 50.

Use the portable callable handle from `symbols` with `codegraph callers <handle>` or `codegraph callees <handle>`. Depth defaults to 1 and caps at 5, the symbol limit defaults to 100 and caps at 500, JSON is the default, and `--pretty` prints grouped exact callsites.

Call hierarchy contains resolved semantic `calls` edges only. `--include-heuristic` is accepted but currently adds no guessed dynamic calls; use `refs` for all references and `deps` or `rdeps` for file relationships.

Use the portable handle from `symbols` with `codegraph supertypes <handle>`, `codegraph subtypes <handle>`, or `codegraph implementations <handle>`. Hierarchy depth defaults to 1 and caps at 10; all result limits default to 100 and cap at 500, and `--pretty` is the concise human-readable form.

Hierarchy results contain only proven indexed `extends` and `implements` relationships. Member implementations require an interface or trait owner with proven implementers; Codegraph does not infer unrelated same-name methods, dynamic or structural conformance, or unresolved external bases.

### Navigate

- dependencies: `codegraph deps <file>`
- reverse dependencies: `codegraph rdeps <file>`
- shortest path: `codegraph path <from> <to>`
- definition: `codegraph goto <file> <line> <column>`
- references: `codegraph refs --file <file> --line <line> --col <column> --pretty`

### Review and Inspect

- compact review handoff: `codegraph review --base HEAD --head WORKTREE --summary`
- broader change impact: `codegraph impact --base HEAD --head WORKTREE --pretty`
- architecture drift: `codegraph drift ./src --base origin/main --head HEAD --pretty --graph-edges summary --public-api removals`
- architecture summary: `codegraph inspect ./src --limit 20`
- prioritized cycles: `codegraph cycles --sort priority`
- duplicate cleanup: `codegraph duplicates --root . ./src --profile cleanup`
- full duplicate groups: `codegraph duplicates --root . ./src --json`

`inspect --duplicates` adds the slower bounded duplicate summary. Treat duplicate matches, candidate tests, and call-compatibility hints as review leads, not proof.

## Choose Output by Consumer

- Human or model reading one result: use `--pretty` or `--summary`.
- Tool chaining, filtering, stable handles, exact ranges, or schema fields: use `--json`.
- Repeated agent queries over one repo snapshot: prefer MCP so the index stays warm.
- Durable graph handoff: use `codegraph graph --root . ./src --compact-json --output codegraph.json` rather than parsing display text.

Do not parse pretty output to recover fields already available in structured output.

## Live Reads and Sensitive Files

Use `codegraph file <path>` for current disk content. The default is JSON; add `--pretty` for readable numbered lines.

```bash
codegraph file src/auth.ts --offset 201 --limit 200 --max-bytes 80000
codegraph file src/auth.ts --include-graph-context --pretty
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

If MCP tools are available, prefer them over repeated CLI invocations. Use `explore`, `orient`, `workspace_symbols`, `search`, `get_file`, `packet_get`, `goto`, `refs`, `callers`, `callees`, `deps`, `rdeps`, `path`, `impact`, `review`, and `query_sqlite`; fall back to the CLI when MCP is unavailable.
Use `workspace_symbols` for deterministic symbol identities and exact ranges; use `search` when paths, prose, SQL, snippets, or graph evidence should participate.
Use `supertypes`, `subtypes`, and `implementations` with portable symbol handles for repeated hierarchy queries; their schemas are flat and use the same 10-depth and 500-result caps as the CLI.
Use `callers` and `callees` with portable callable handles for repeated call hierarchy queries. Their flat schemas accept `handle`, `depth`, `limit`, and `includeHeuristic`, reuse the MCP freshness gate, and cap depth at 5 and symbols at 500; current results remain semantic-only.

Keep live and indexed evidence distinct:

- `get_file` returns bounded live bytes with `offset`, `limit`, and `maxBytes`; continue at `page.nextOffset`.
- Set `allowSensitive: true` only for intentional sensitive reads.
- Set `includeGraphContext: true` only when freshness-backed context is needed; importers, imports, and symbols are each capped at 100.
- Plain `get_file` freshness does not gate live bytes.
- After indexed calls, check `freshness` before trusting graph or semantic context. `refreshed` means Codegraph rebuilt; `stale` includes a reason and bounded changed-file metadata.
- Run `refresh_index` before `artifact_build` when the index is stale. Artifact writes refuse stale snapshots.

## Agent Setup and Project Lifecycle

Preview agent-client setup before writing configuration:

```bash
codegraph install --target codex,claude --dry-run
codegraph install --print-config codex
codegraph install --target codex,claude --yes
```

The installer manages Codegraph-owned MCP entries, skill payloads, and marker files. Uninstall removes only recognized Codegraph-owned content.

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

Codegraph requires Node.js 22.16 or newer. Use only the scoped packages:

- CLI and library: `@lzehrung/codegraph`
- optional native runtime: `@lzehrung/codegraph-native`

```bash
npm config set "@lzehrung:registry" "https://npm.pkg.github.com"
npm install -g @lzehrung/codegraph
codegraph doctor
```

Do not suggest the unscoped `codegraph` package. Published installs resolve the optional native runtime when a compatible artifact exists; otherwise Codegraph reports reduced graph-only and regex recovery behavior rather than semantic parity.
