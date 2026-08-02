# Cross-cutting performance program: index and measured budget

Status: Active. The original measurements below were taken on `main` at `3024ed2b` (`v1.8.100`)
on 2026-07-25, on Windows 11 / Node v24.15.0, against this repository (668 indexed files) and
the tiny fixture at `.tmp-tiny-ts-app`.

This document coordinates the remaining performance plans and preserves their shared measured
baseline without restating it in each plan.

## Why this program exists

Prior performance work bounded specific commands: PR #164 (warm command caches) and PR #165
(bounded impact/review). Neither addressed the costs every command pays before it does any
useful work. Those fixed costs now dominate short agent queries.

## Measured baseline

Warm, this repository:

| Command                        | Warm wall time |
| ------------------------------ | -------------- |
| `orient --budget small --json` | 1256 ms        |
| `search <symbol> --limit 3`    | 2664 ms        |
| `--version`                    | 299 ms         |
| `node -e 0` (floor)            | 36 ms          |

Where a warm command spends time:

| Layer                                         | Measured cost             | Plan                                            |
| --------------------------------------------- | ------------------------- | ----------------------------------------------- |
| Process start + ESM module graph              | 262 ms                    | Implemented                                     |
| Git subprocesses (7 spawns, serialized)       | ~200 ms                   | [git](2026-07-25-git-subprocess-elimination.md) |
| Bloom filter rebuild over 668 unchanged files | 404 ms                    | Implemented                                     |
| Detailed symbol-graph sidecar validation      | 215-240 ms                | Implemented                                     |
| Native fingerprint (forces addon load)        | 35 ms warm / ~300 ms cold | [native](2026-07-25-native-runtime-startup.md)  |
| Project snapshot read + parse (8.97 MB)       | 42 ms, sometimes twice    | Implemented                                     |

Cold start, measured once on first touch after a build:

- First `import dist/cli.js`: 6119 ms
- Same import warm: 301 ms
- `dist/` contains 335 `.js` files totalling 7.2 MB

The cold penalty is per-file overhead multiplied across the module graph (open, stat, resolve,
read, and on Windows antivirus inspection). It is the single largest cold-start term.

## Remaining plans and completed work

The startup work shipped lazy dispatch, a bundled CLI entry, the V8 compile cache, and
eager-import trimming. Warm hydration now reuses persisted bloom filters and build signatures,
memoizes identity-validated snapshots, reuses prepared SQLite statements, and bounds cache
growth; five warm `inspect --root . --json --cache disk` runs measured a 1006.0 ms median after
the final correctness review.

1. [Git subprocess elimination](2026-07-25-git-subprocess-elimination.md)
   - Takes warm read-only queries from 6-7 Git spawns toward zero and removes dead per-file
     subprocess paths.
2. [Native runtime and worker startup](2026-07-25-native-runtime-startup.md)
   - Stops loading and hashing a 29 MB addon for commands that never parse a file.

## Recommended implementation order

1. Finish the remaining Git subprocess priorities, preserving the snapshot fast path and
   concurrent query behavior.
2. Validate installed-user impact, then finish the remaining native runtime startup work.
3. Re-measure before adding more startup or hydration work.

## Program-level acceptance

Measured on this repository, warm, after the program:

- [ ] `codegraph --version` at or under 100 ms (from 299 ms).
- [ ] Warm `orient --budget small` at or under 450 ms (from 1256 ms).
- [ ] Warm `search --limit 3` at or under 700 ms (from 2664 ms).
- [ ] Warm read-only agent commands issue zero git subprocesses on a clean, unchanged tree.
- [ ] First-touch cold `import` of the CLI entry at or under 1500 ms (from 6119 ms).
- [ ] `npm run check` green, with no reduction in output content for any command.

## Non-goals

- No change to command output shape, ranking, or completeness. Every plan here is a pure
  latency change; any output difference is a defect.
- No new daemon or background service. Long-lived MCP already amortizes process cost and
  remains the recommended path for repeated operations.
- No storage-format rewrite of the project snapshot in this program. That option is recorded in
  the hydrate plan as a deferred item with a measured, and modest, upper bound.

## Supersedes

An earlier cold-start exploration proposed ranked follow-ups from partial data. Its basic symbol-graph slice shipped; its remaining ranks were replaced by the measured findings in this program.
