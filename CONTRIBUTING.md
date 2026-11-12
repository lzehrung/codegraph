# Contributing

- Follow [AGENTS.md](AGENTS.md), including its Semantic Accuracy Bar and verification requirements.
- See [agent workflows](docs/agent-workflows.md) for Codegraph CLI and library-session guidance.

## Agent workflows (ODW)

- Install Open Dynamic Workflows (ODW, 0.4.0 or later) and a tools-enabled agent adapter. For example, an `omp` adapter entry must allow shell/file tools; ODW's built-in tools-disabled `omp` entry is not sufficient. Pass your tools-enabled configuration with `--config <tools-config.json>` and choose `--adapter omp`, or use another tools-enabled adapter.
- Prepare a dedicated head worktree with `npm ci` and `npm run build`, plus a separate checkout of `base` with its own dependencies and built `dist/`. The workflows do not install dependencies or build the baseline. Start `codegraph-fix` on a clean, non-protected branch.
- `codegraph-fix` reproduces every task item on the baseline, triages scope, implements in place, builds and runs focused verification, creates one local commit, then amends it for confirmed introduced review blockers. `maxRounds` defaults to 3; `fullGate: true` adds the final `npm run check` and at most one extra real-failure correction.
- `codegraph-pre-merge` is read-only: it compares detailed-graph edges, goto and references (including coverage), checks test gaps and cache invalidation, measures applicable performance paths, then independently verifies P0/P1 candidates. Both head and baseline must already be built. An incomplete lane fails the review rather than reporting a clean result.
- Matching unsupported API outcomes remain explicit baseline limitations, not empty answers. Missing optional language interpreters are reported as limitations; missing built Codegraph/native prerequisites or unexecuted required comparisons fail the review.
- Supply absolute `baseline`, `corpora`, and `scratch` paths. Scratch defaults to a unique directory below the OS temporary directory's `codegraph-odw` folder and must be outside every indexed root. Agents use separate scratch copies for mutable probes; they never edit the baseline or extra projects.
- Use `mode: "refactor"` in either workflow to require identical base/head outputs, including graph snapshots. The fix workflow's default mode is `"fix"`; the review workflow's default is `"change"`. Review uses `git diff <base>...<head>` and defaults `head` to `"HEAD"`.
- Select models/adapters with `models` and `adapters`: fix accepts `implement` and `review`; pre-merge accepts `review`. Prefer a different model family for `review` than for `implement`. Unset roles use the configured adapter/model; model identifiers depend on that adapter.
- Keep local args/config files under `.odw/` outside `.odw/workflows/` so they remain ignored. The host still owns pushing, PRs, stacking, and merging. Follow-up issue drafts are returned, not published.

Run the fix workflow with an args file (paths in JSON below are portable examples to replace):

```sh
odw run codegraph-fix --wait --source <worktree> --args @args.json --adapter omp --config <tools-config.json>
```

```json
{
  "task": "Fix ordinary method calls resolving to a same-named decoy; pin inclusion, exclusion, and coverage through each consumer.",
  "base": "origin/main",
  "baseline": "/checkouts/codegraph-base",
  "mode": "fix",
  "maxRounds": 3,
  "fullGate": true,
  "corpora": ["/corpora/example-project"],
  "scratch": "/tmp/codegraph-odw"
}
```

- Optional fix args: `oracle` describes how to run the language reference implementation; `epochs` reserves `{ "core": 123, "language": 45 }` values only when the corresponding bump is needed. Replace example values with advancing reservations appropriate to the branch; omit reservations to follow normal repository epoch increments.

Run the read-only review separately:

```sh
odw run codegraph-pre-merge --wait --source <worktree> --args @review-args.json --adapter omp --config <tools-config.json>
```

```json
{
  "base": "origin/main",
  "head": "HEAD",
  "baseline": "/checkouts/codegraph-base",
  "goals": "Resolve ordinary method calls without selecting same-named decoys.",
  "mode": "change",
  "corpora": ["/corpora/example-project"],
  "scratch": "/tmp/codegraph-odw"
}
```
