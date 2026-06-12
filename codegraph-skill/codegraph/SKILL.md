---
name: codegraph
description: "Use for repo structure, symbol navigation, dependency analysis, duplicate triage, and PR impact review when plain text search is too shallow."
---

# Codegraph

## When to use this skill

Use Codegraph for structure-aware repo questions:

- repo overview: architecture, hotspots, cycles, public API, where to start
- symbol navigation: definition, references, dependency path, reverse dependencies
- change analysis: what a diff or PR could break, what to test, review handoff
- duplicate triage: grouped clone candidates for extraction or cleanup
- bounded agent context: packets, explain, chunking

Prefer plain text search for raw strings, logs, config keys, and secrets.
Do not use Codegraph as the only evidence for runtime behavior; pair it with tests or execution.

## First move for agents

Start narrow and bounded.

```bash
codegraph doctor
codegraph orient --root . --budget small --json
```

Then pick the smallest useful follow-up:

- architecture summary: `codegraph inspect ./src --limit 20`
- packet follow-up: `codegraph packet get <handle> --json`
- hotspots: `codegraph hotspots ./src --limit 20`
- search anchors: `codegraph search "auth user"`
- explain a file/symbol/handle: `codegraph explain <target>`
- dependencies: `codegraph deps <file>`
- reverse dependencies: `codegraph rdeps <file>`
- dependency path: `codegraph path <from> <to>`
- cycles: `codegraph cycles --sort priority`
- goto: `codegraph goto <file> <line> <column>`
- refs: `codegraph refs --file <file> --line <line> --col <column> --pretty`
- duplicate triage: `codegraph duplicates --root . ./src --min-confidence medium`
- PR impact: `codegraph impact --provider git --base main --head HEAD --pretty`
- worktree impact: `codegraph impact --provider git --base HEAD --head WORKTREE --pretty`
- review handoff: `codegraph review --base HEAD --head WORKTREE --summary`
- full review JSON: `codegraph review --base origin/main --head HEAD`
- architecture drift: `codegraph drift ./src --base origin/main --head HEAD --pretty --graph-edges summary --public-api removals`
- chunk a file: `codegraph chunk <file>`

For `orient`, positional paths are always include roots. Use `--root` to set the project boundary.

## Output defaults

Use readable output when the next consumer is a human or agent reading the result.
Use JSON when the next step needs exact fields, handles, counts, or filtering.

Current defaults:

- readable by default: `duplicates`, `search`, `explain`, `hotspots`, `cycles`, `unresolved`
- JSON by default: `orient`, `inspect`, `impact`, `review`

Important command notes:

- `duplicates` defaults to pretty triage output.
- `duplicates --json` is the stable machine contract.
- `duplicates --raw-pairs` is JSON-only.
- `impact --pretty` and `review --summary` are the main human-facing surfaces.
- `orient --json` is best when you need packet handles and omission counts.

## Prefer MCP when available

If Codegraph MCP tools are already exposed, prefer them over spawning CLI commands repeatedly.
Use MCP `orient`, `search`, `packet_get`, `goto`, `refs`, `deps`, `rdeps`, `path`, `impact`, and `review` first.
Fall back to CLI when MCP is unavailable.

## Search, packets, and explain

- `packet get` retrieves bounded evidence from `orient`, `search`, and `explain` handles.
- `search` returns ranked anchors plus follow-up commands.
- `explain` expands a file, symbol, SQL object, or search handle into bounded context.
- For SQL objects, prefer search handles or schema-qualified names when basenames are ambiguous.

## Core command guidance

### Duplicate cleanup

Use:

```bash
codegraph duplicates --root . ./src --min-confidence medium
```

Notes:

- pretty output is the default triage surface
- use `--json` for grouped duplicate data
- use `--sort actionability` to rank likely cleanup wins
- use `--ignore-glob` repeatedly for noisy trees
- use `--include-same-file` for local clone cleanup
- use `--raw-pairs` only when debugging low-level JSON evidence

### Impact and review

Use `impact --pretty` to answer "what could this break?".
Use `review --summary` for compact reviewer handoff.
Use full JSON only when a downstream step needs stable fields.

Useful commands:

```bash
codegraph impact --provider git --base main --head HEAD --pretty
codegraph impact --provider git --base HEAD --head WORKTREE --pretty
codegraph review --base HEAD --head WORKTREE --summary
codegraph review --base origin/main --head HEAD
```

Notes:

- `WORKTREE` compares staged and unstaged tracked changes to the base
- `STAGED` / `INDEX` compares the current index to the base
- duplicate leads in pretty summaries are prompts, not proof of semantic equivalence

### Architecture and graph questions

Use these for structure, not runtime truth:

```bash
codegraph inspect ./src --limit 20
codegraph hotspots ./src --limit 20
codegraph cycles --sort priority
codegraph unresolved
codegraph apisurface
```

Notes:

- `inspect` is the bounded architecture summary
- `hotspots` is the fastest "where is complexity concentrated?" view
- `cycles` filters document-only link loops out of cycle warnings
- `unresolved` excludes known stdlibs and declared package/runtime externals

### Graph and SQL artifacts

Examples:

```bash
codegraph graph ./src
codegraph graph ./src --fast-graph
codegraph graph --root . ./src --json
codegraph graph --sqlite ./codegraph.sqlite
codegraph sql --db ./codegraph.sqlite --query "SELECT name, file FROM symbols LIMIT 5;"
```

Notes:

- use `--fast-graph` first on large repos, then rerun without it when accuracy matters
- `sql` is read-only
- SQL support is object-level; it does not claim global schema inference for arbitrary application strings

## Project boundary and discovery rules

`--root` defines the project boundary for config lookup, cache/manifests, path confinement, and output normalization.
Positional paths are include roots inside that project.

Examples:

- `codegraph inspect --root . ./src`
- `codegraph graph --root . ./packages/app ./packages/lib --json`

Discovery filters:

- `--include-glob`
- `--ignore-glob`
- `--no-gitignore`
- durable repo-local ignores belong in `codegraph.config.json`

## Installation and availability

Use the scoped package only:

- package: `@lzehrung/codegraph`
- CLI: `codegraph`
- native backend: `@lzehrung/codegraph-native`
- compatibility shim: `@lzehrung/codegraph-js-fallback`

Registry:

```bash
npm config set "@lzehrung:registry" "https://npm.pkg.github.com"
```

Install:

```bash
npm install -g @lzehrung/codegraph
# or
npm install --save-dev @lzehrung/codegraph
```

Do not suggest the unscoped `codegraph` package.
Codegraph requires Node.js 24.10 or newer.

## Agent-facing rules of thumb

- prefer bounded commands first
- prefer readable defaults unless you need exact fields
- use `--json` explicitly when you plan to parse or post-process
- use `--root` deliberately; it changes config lookup and cache scope
- for copied-code or refactor-risk questions, follow impact with `codegraph duplicates --json ...`
- if a command already has a good human surface, do not force JSON unless the next step needs it
