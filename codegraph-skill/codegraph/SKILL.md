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
- bounded agent context through orientation, search, packets, explain, and MCP

Prefer plain text search for raw strings, logs, config keys, secrets, and exact literals.
Do not use Codegraph as the only evidence for runtime behavior; pair it with tests or execution.

## First Move

Start bounded:

```bash
codegraph orient --root . --budget small --pretty
```

Use `doctor` only when install, native-runtime, or artifact health is the task.

For PR, worktree, or sweeping review tasks, start with `codegraph review --base HEAD --head WORKTREE --summary` or `codegraph impact --base HEAD --head WORKTREE --pretty` instead.

Then choose the smallest useful follow-up:

- packet: `codegraph packet get <file|handle> --pretty`
- search: `codegraph search "auth user" --json`
- explain: `codegraph explain <file|symbol|handle>`
- architecture: `codegraph inspect ./src --limit 20`
- dependencies: `codegraph deps <file>` or `codegraph rdeps <file>`
- path: `codegraph path <from> <to>`
- cycles: `codegraph cycles --sort priority`
- navigation: `codegraph goto <file> <line> <column>`
- references: `codegraph refs --file <file> --line <line> --col <column> --pretty`
- duplicates: `codegraph duplicates --root . ./src --profile cleanup`
- impact: `codegraph impact --base HEAD --head WORKTREE --pretty`
- review: `codegraph review --base HEAD --head WORKTREE --summary`
- drift: `codegraph drift ./src --base origin/main --head HEAD --pretty --graph-edges summary --public-api removals`

Use `--root` to define the project boundary for config lookup, cache scope, path confinement, and output normalization.
For `orient`, `drift`, and positional graph commands, positional paths are include roots inside that project.

## Output Choice

Use readable output when a human or model will read the result.
Use JSON when the next step needs exact fields, counts, or filtering.

Current high-value surfaces:

- `orient --pretty`: ranked first-turn focus targets with copyable follow-ups
- `impact --pretty`: ranked "what could this break?" map
- `review --summary`: compact reviewer handoff
- `duplicates --profile cleanup`: refactor ROI ordering
- `duplicates --json`: full grouped duplicate data

Treat duplicate leads and call-compatibility hints as review leads, not proof.

## MCP

If MCP tools are available, prefer them over repeated CLI invocations.
Use MCP `orient`, `search`, `packet_get`, `goto`, `refs`, `deps`, `rdeps`, `path`, `impact`, and `review` first.
Fall back to CLI when MCP is unavailable.

## Discovery

Durable repo-local ignores belong in `codegraph.config.json`.
One-off CLI filters use scan-root-relative `--include-glob` and `--ignore-glob`.
Use `--no-gitignore` only when ignored files are intentionally in scope.

## Installation Notes

Use the scoped packages only:

- package: `@lzehrung/codegraph`
- native backend: `@lzehrung/codegraph-native`
- compatibility shim: `@lzehrung/codegraph-js-fallback`

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
