# Contributing

- Follow [AGENTS.md](AGENTS.md), including its Semantic Accuracy Bar and verification requirements.
- See [agent workflows](docs/agent-workflows.md) for Codegraph CLI and library-session guidance.
- Run `npm run answers:snapshot:check` (included in `npm run check`); regenerate with `npm run answers:snapshot` and classify every changed answer against base/head evidence before committing. `npm run answers:snapshot:corpora -- --help` describes scratch-only comparisons of pinned benchmark corpora.

## Inline language checks

`npm run language-checks:check` runs before tests in `npm run check` and in CI. It compares
non-exempt identity checks against `scripts/language-check-baseline.json`, using file, function,
and normalized condition/expression fingerprints rather than line numbers; duplicate sites are counted.
New checks fail, and removed checks require regeneration.

Move the language-specific operation into the existing language-owned data row or policy hook
instead of adding an identity wrapper, singleton-language flag, or baseline entry. After removing
sites, run `node scripts/language-check-inventory.mjs --write-baseline`; regeneration refuses
additions to an existing baseline. See the [migration plan](docs/plans/2026-11-24-language-checks-to-hooks.md)
for the narrow format, registry, and target-file grammar-safety exemptions.

## Change records

User-visible changes add one uniquely named Markdown file under `changes/unreleased/`, not an
edit to `CHANGELOG.md`. Slugs match `[a-z0-9]+(-[a-z0-9]+)*`. The fragment has one section and
one entry paragraph (without a bullet):

```markdown
---
section: Fixed
---

Describe the observable fix.
```

Sections are `Breaking`, `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`, in that release
order. Entries within a section sort by filename using code-unit order. `npm run changes:check`
rejects malformed fragments and nonempty `[Unreleased]` content, and runs in `npm run check`.
See [PUBLISHING.md](PUBLISHING.md) for non-mutating previews and fragment consumption.

Cache-changing work adds a uniquely named `.txt` file under
`src/indexer/build-cache/epochs/core/`; behavior-hook changes also add one under `epochs/language/`.
Epoch filenames use the same slug rule. Each record contains a one-line invalidation reason.
Entries are permanent and append-only: never
rename, delete, or reuse them, and never edit the immutable legacy seeds.

`npm run build` and `npm run typecheck` derive safe-integer equality tokens from each sorted filename
set and its legacy seed (core 175, language 30). The ignored `epochs.generated.ts` is compiled into
the library, core package, and bundled CLI; worker bundles do not consume epochs. Runtime code
never reads entry files.
No reservations or merge-order renumbering are needed; add a new record even after another branch
with a different record merges.

Run `npm run generate:cache-epochs` before a bare `npx vitest` command or an IDE typecheck in a
fresh checkout. The normal npm build, typecheck, and test commands already arrange generation.
Dotfiles such as `.DS_Store` and `.gitkeep` are ignored in fragment and epoch directories.
Dot-prefixed names ending in `.md` or `.txt` are rejected, like other invalid record names.

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

- Optional fix arg: `oracle` describes how to run the language reference implementation. Cache-changing fixes follow the additive epoch-entry rule above; numeric epoch reservations are no longer accepted.

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
