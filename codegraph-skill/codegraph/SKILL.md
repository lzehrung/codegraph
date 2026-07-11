---
name: codegraph
description: "Use for repo structure, symbol navigation, dependency analysis, duplicate triage, and PR impact review when plain text search is too shallow."
---

# Codegraph

Use Codegraph for structure-aware repo questions:

- repo overview, hotspots, cycles, unresolved imports, and public API surface
- symbol navigation with definitions, references, dependencies, and paths
- PR or worktree impact review with candidate tests and risk signals
- duplicate cleanup and refactor-risk triage
- bounded agent context through explore, orientation, search, packets, explain, and MCP

Prefer plain text search for raw strings, logs, config keys, secrets, and exact literals.
Do not use Codegraph as the only evidence for runtime behavior; pair it with tests or execution.

## First Move

For PR, worktree, or sweeping review tasks, start with the compact reviewer handoff:

```bash
codegraph review --base HEAD --head WORKTREE --summary
```

Use `codegraph impact --base HEAD --head WORKTREE --pretty` when you need the broader blast-radius map. For unfamiliar repos without a diff, start bounded with `codegraph explore "how does auth reach db?" --root . --pretty` or `codegraph orient --root . --budget small --pretty` when no concrete question exists.
Use `doctor` only when install, native-runtime, or artifact health is the task.
Then choose the smallest useful follow-up:

- explore: `codegraph explore "how does auth reach db?" --pretty`
- live file: `codegraph file <path> --offset 1 --limit 200 --pretty`
- packet: `codegraph packet get <file|symbol|sql-object|handle> --pretty`
- search: `codegraph search "auth user" --json`
- explain: `codegraph explain <file|symbol|sql-object|handle>`
- architecture: `codegraph inspect ./src --limit 20` (`--duplicates` adds the slower duplicate summary)
- dependencies: `codegraph deps <file>` or `codegraph rdeps <file>`
- path: `codegraph path <from> <to>`
- cycles: `codegraph cycles --sort priority`
- navigation: `codegraph goto <file> <line> <column>`
- references: `codegraph refs --file <file> --line <line> --col <column> --pretty`
- duplicates: `codegraph duplicates --root . ./src --profile cleanup`
- impact: `codegraph impact --base HEAD --head WORKTREE --pretty`
- review: `codegraph review --base HEAD --head WORKTREE --summary`
- drift: `codegraph drift ./src --base origin/main --head HEAD --pretty --graph-edges summary --public-api removals`
- installer: `codegraph install --target codex,claude --dry-run`
- lifecycle: `codegraph init --root .`, `codegraph status --root . --json`, `codegraph sync --root .`

Use `--root` to define the project boundary for config lookup, cache scope, path confinement, and output normalization.
For `orient`, `drift`, and positional graph commands, positional paths are include roots inside that project.
Use `codegraph install --target <ids> --yes` to configure supported local agent clients with MCP entries, bundled skill payloads, and marker files. Use `--dry-run` or `--print-config <target>` first; uninstall removes only Codegraph-owned marker blocks, marker files, exact bundled skill payloads, or exact installer-owned MCP entries.
Lifecycle commands own only `.codegraph/manifest.json` metadata. `init` and `sync` may warm or update `.codegraph-cache/index-v1/`; other commands do not depend on the manifest. Use `uninit` to remove recognized lifecycle state.
Lifecycle commands accept either a positional project path or `--root <path>`; never combine both.

## Output Choice

Use readable output when a human or model will read the result.
Use JSON when the next step needs exact fields, counts, or filtering.

Hybrid search is code-first by default, and search/explain packets include analysis labels plus per-result provenance so reduced or mixed runs stay visible.

Current high-value surfaces:

- `explore --pretty`: one-call question answer with anchors, packets, paths, blast radius with omitted lower bounds, candidate tests, limits, lower-bound omissions, and follow-ups
- `orient --pretty`: ranked first-turn focus targets with copyable follow-ups
- `impact --pretty`: ranked "what could this break?" map
- `review --summary`: compact reviewer handoff
- `duplicates --profile cleanup`: refactor ROI ordering
- `duplicates --json`: full grouped duplicate data
- `file`: live bounded file bytes with JSON default, exact numbered lines, and explicit pagination

Treat duplicate leads and call-compatibility hints as review leads, not proof.

## Live File Views

Use `codegraph file <path>` for current disk content; use `--pretty` for a readable view or the default JSON for exact fields. Returned pages use a 1-based `--offset`, a `--limit` default/cap of 2000/10000 lines, and a `--max-bytes` default/cap of 80000/500000 unnumbered text bytes. A separate 16 MiB hard input-size limit rejects larger raw reads and structural text-config summaries before unbounded I/O, bounding complete-stream binary/UTF-8 validation and total-line counting.

```bash
codegraph file src/auth.ts --offset 201 --limit 200 --max-bytes 80000
codegraph file src/auth.ts --include-graph-context --pretty
```

`content` is exact `number<TAB>line` text with no line-number padding, while `text` omits number prefixes. A trailing newline becomes a final numbered empty line. Follow `page.nextOffset`; beyond EOF, JSON `content` and `text` are empty and pretty output says `Lines: none at offset <offset> of <totalLines>`.

Graph context is never automatic. Add `--include-graph-context` only when direct `usedBy` paths, imports, and symbols are worth an index/freshness check; ordinary file bytes stay live and independent of index freshness.

Within the 16 MiB input limit, recognized environment, authentication, and credential text configs return structural summaries after the full raw stream is validated. Default key-material summaries use metadata, may report size, and do not read raw secret bytes. Use `--allow-sensitive` only for deliberate raw access; it does not bypass the input-size, binary, NUL, or UTF-8 guards, so `.p12` and `.pfx` bundles summarize by default and reject raw access.

An exact project-relative file-path query such as `codegraph explore src/auth.ts --json` adds the same response as `fileView`; `--no-source` suppresses it. `--include-graph-context` and `--allow-sensitive` pass through only when explicitly present.

## MCP

If MCP tools are available, prefer them over repeated CLI invocations.
Use MCP `explore`, `orient`, `search`, `get_file`, `packet_get`, `goto`, `refs`, `deps`, `rdeps`, `path`, `impact`, `review`, and `query_sqlite` first.
Use `get_file` for bounded live reads with `offset`, `limit`, and `maxBytes`; continue at `page.nextOffset`, and set `allowSensitive: true` only for intentional raw sensitive reads. Set `includeGraphContext: true` to opt into freshness-backed direct context capped at 100 importers, imports, and symbols each.
For plain `get_file` reads, `freshness` does not gate the live bytes. After indexed calls or graph-context reads, check it before trusting indexed data: `refreshed` means Codegraph rebuilt, and `stale` includes a reason plus bounded changed-file metadata.
Run `refresh_index` before `artifact_build` when MCP reports a stale index; artifact writes refuse stale snapshots.
Fall back to CLI when MCP is unavailable.

## Discovery

Durable repo-local ignores belong in `codegraph.config.json`.
One-off CLI filters use scan-root-relative `--include-glob` and `--ignore-glob`.
Use `--no-gitignore` only when ignored files are intentionally in scope.

## Installation Notes

Use the scoped packages only:

- package: `@lzehrung/codegraph`
- native backend: `@lzehrung/codegraph-native`

Registry:

```bash
npm config set "@lzehrung:registry" "https://npm.pkg.github.com"
```

Install:

```bash
npm install -g @lzehrung/codegraph
```

Do not suggest the unscoped `codegraph` package.
Codegraph requires Node.js 24.10 or newer.
