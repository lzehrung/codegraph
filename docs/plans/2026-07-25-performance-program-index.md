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

| Layer                                         | Measured cost             | Plan                                           |
| --------------------------------------------- | ------------------------- | ---------------------------------------------- |
| Process start + ESM module graph              | 262 ms                    | Implemented                                    |
| Git subprocesses (7 spawns, serialized)       | ~200 ms                   | Safe reductions implemented                    |
| Bloom filter rebuild over 668 unchanged files | 404 ms                    | Implemented                                    |
| Detailed symbol-graph sidecar validation      | 215-240 ms                | Implemented                                    |
| Native fingerprint (forces addon load)        | 35 ms warm / ~300 ms cold | [native](2026-07-25-native-runtime-startup.md) |
| Project snapshot read + parse (8.97 MB)       | 42 ms, sometimes twice    | Implemented                                    |

Cold start, measured once on first touch after a build:

- First `import dist/cli.js`: 6119 ms
- Same import warm: 301 ms
- `dist/` contains 335 `.js` files totalling 7.2 MB

The cold penalty is per-file overhead multiplied across the module graph (open, stat, resolve,
read, and on Windows antivirus inspection). It is the single largest cold-start term.

## Remaining plan and completed work

The startup work shipped lazy dispatch, a bundled CLI entry, the V8 compile cache, and
eager-import trimming. Warm hydration now reuses persisted bloom filters and build signatures,
memoizes identity-validated snapshots, reuses prepared SQLite statements, and bounds cache
growth; five warm `inspect --root . --json --cache disk` runs measured a 1006.0 ms median after
the final correctness review.

Git availability is memoized per process, independent probes run concurrently, impact and review
reuse one parsed tree diff, and deleted review sources use one `git cat-file --batch` process.
The proposed mtime-only zero-Git pre-gate was rejected: tracked-file mtimes cannot prove that no
new file was created, while reusing a cached discovery plan in MCP freshness checks would miss
additions.

The remaining implementation plan is [native runtime and worker startup](2026-07-25-native-runtime-startup.md).
It avoids loading and hashing a 29 MB addon for commands that never parse a file.

## Recommended implementation order

1. Validate installed-user impact, then finish the remaining native runtime startup work.
2. Re-measure before adding more startup or hydration work.

## Program-level acceptance

Measured on this repository, warm, after the program:

- [x] `codegraph --version` at or under 100 ms (from 299 ms). Measured 83 ms - see the
      re-measurement below for the conditions.
- [ ] Warm `orient --budget small` at or under 450 ms (from 1256 ms). **Not met**: measured
      2530 ms.
- [ ] Warm `search --limit 3` at or under 700 ms (from 2664 ms). **Not met**: measured 4852 ms.
- [x] Redundant Git tree diffs and per-deleted-file subprocesses are removed.
- [ ] First-touch cold `import` of the CLI entry at or under 1500 ms (from 6119 ms). Not
      re-measured.
- [ ] `npm run check` green, with no reduction in output content for any command.

### Re-measurement after the native runtime startup work

Taken 2026-08-25 on Linux x64, Node v22.22.2, 4 cores, 811 indexed files, warm disk cache, from
a workspace build. Five runs each after one untimed warm-up; the figure is the median.

| Command                        | Original | Now  | Target | Met |
| ------------------------------ | -------- | ---- | ------ | --- |
| `--version`                    | 299      | 83   | 100    | yes |
| `orient --budget small --json` | 1256     | 2530 | 450    | no  |
| `search <symbol> --limit 3`    | 2664     | 4852 | 700    | no  |

**These are a new baseline, not a before-and-after.** Three things differ from the original
measurement and each moves these numbers on its own: a different OS and machine (Windows 11 on
Node v24.15.0 originally), a different core count, and a repository that has grown from 668
indexed files to 811. Nothing here should be read as a regression caused by the program, and
nothing here should be read as evidence the program helped either.

The one number that is close to comparable is `--version`, which does almost no work beyond
process start and the module graph. It is under target.

`orient` and `search` are both well over target and both slower than the original figure. Which
part of that is the machine and which is real is not established, and guessing would repeat the
mistake recorded in the F10 correction: measuring two configurations that were not what they
were labelled. Establishing it needs a profile on the current machine, which belongs to its own
change rather than being asserted here.

Priorities P0, P1, and P4 of the native runtime startup plan save work that only exists on the
Windows runtime cache path: the addon load inside the fingerprint, the two 29 MB SHA-256 passes,
and the entries that accumulated across versions. On Linux the addon is resolved directly with
no cache, so those savings are structurally invisible in the table above and cannot be
demonstrated from this machine at all. P2 and P3 are platform-independent and were each measured
where they apply - see their sections in the native plan.

## Non-goals

- No change to command output shape, ranking, or completeness. Every plan here is a pure
  latency change; any output difference is a defect.
- No new daemon or background service. Long-lived MCP already amortizes process cost and
  remains the recommended path for repeated operations.
- No storage-format rewrite of the project snapshot in this program. That option is recorded in
  the hydrate plan as a deferred item with a measured, and modest, upper bound.

## Supersedes

An earlier cold-start exploration proposed ranked follow-ups from partial data. Its basic symbol-graph slice shipped; its remaining ranks were replaced by the measured findings in this program.
