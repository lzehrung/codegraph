# Cross-cutting performance program: index and measured budget

Status: Planned. All measurements below were taken on `main` at `3024ed2b` (`v1.8.100`) on
2026-07-25, on Windows 11 / Node v24.15.0, against this repository (668 indexed files) and the
tiny fixture at `.tmp-tiny-ts-app`.

This document is the entry point for four implementation plans. It exists so the measured
baseline lives in one place and is not restated (and drifted) in each plan.

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

| Layer                                         | Measured cost             | Plan                                                             |
| --------------------------------------------- | ------------------------- | ---------------------------------------------------------------- |
| Process start + ESM module graph              | 262 ms                    | [startup](2026-07-25-startup-cost-bundling-and-lazy-dispatch.md) |
| Git subprocesses (7 spawns, serialized)       | ~200 ms                   | [git](2026-07-25-git-subprocess-elimination.md)                  |
| Bloom filter rebuild over 668 unchanged files | 404 ms                    | [hydrate](2026-07-25-warm-index-hydrate-costs.md)                |
| Detailed symbol-graph sidecar validation      | 215-240 ms                | [hydrate](2026-07-25-warm-index-hydrate-costs.md)                |
| Native fingerprint (forces addon load)        | 35 ms warm / ~300 ms cold | [native](2026-07-25-native-runtime-startup.md)                   |
| Project snapshot read + parse (8.97 MB)       | 42 ms, sometimes twice    | [hydrate](2026-07-25-warm-index-hydrate-costs.md)                |

Cold start, measured once on first touch after a build:

- First `import dist/cli.js`: 6119 ms
- Same import warm: 301 ms
- `dist/` contains 335 `.js` files totalling 7.2 MB

The cold penalty is per-file overhead multiplied across the module graph (open, stat, resolve,
read, and on Windows antivirus inspection). It is the single largest cold-start term.

## The four plans

1. [Startup cost: bundling, lazy dispatch, compile cache](2026-07-25-startup-cost-bundling-and-lazy-dispatch.md)
   - Removes a measured 185-210 ms from every invocation and is the primary cold-start fix.
2. [Warm index hydrate costs](2026-07-25-warm-index-hydrate-costs.md)
   - Removes recomputation of data that is already persisted. Largest warm win.
3. [Git subprocess elimination](2026-07-25-git-subprocess-elimination.md)
   - Takes warm read-only queries from 6-7 git spawns toward zero, and fixes a latent
     `ENAMETOOLONG` correctness bug.
4. [Native runtime and worker startup](2026-07-25-native-runtime-startup.md)
   - Stops loading and hashing a 29 MB addon for commands that never parse a file.

## Recommended implementation order

Order is chosen so that each step is independently shippable and independently measurable.

1. **Git plan, Priority 0** (`untrackedFiles` fast-path gate). One-line change that re-enables
   the existing snapshot fast path, which in turn skips most of the hydrate plan's costs on
   clean trees. Do this first because it changes which code paths the other plans run on.
2. **Hydrate plan, Priority 0 and 1** (bloom rehydrate, sidecar memoization). Largest warm win,
   contained blast radius.
3. **Startup plan** (lazy dispatch shipped in Priority 0; bundle shipped in Priority 1; compile
   cache still open). Largest cold win remaining is compile cache + native fingerprint avoidance. Priority 0 (lazy dispatch) is implemented;
   Priority 1+ still open.
4. **Native plan**. Depends on nothing, but its win is smaller on developer checkouts than on
   installed users, so it validates last.
5. **Git plan, Priority 1 and 2** (memoization, batching, zero-git fast path).

## Program-level acceptance

Measured on this repository, warm, after all four plans:

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

`2026-07-23-cold-start-explore-latency.md` proposed ranked follow-ups from partial data. Its
Slice 1 shipped (basic symbol graph for hybrid search and explore). Its remaining ranks are
replaced by the measured findings in these four plans.
