# ROI Implementation Progress

This file tracks implementation progress for the ROI-sorted improvement plan without modifying the original attached plan file. It is intended to be safe session handoff context.

## Current status

- [x] `review-default` Center the default workflow on review-first daily change analysis and align docs/help accordingly.
- [x] `search-relevance` Retune search ranking to prefer implementation code and symbols over docs by default.
- [x] `confidence-signals` Expose confidence, provenance, and capability-mode markers across search, navigation, impact, and review outputs.
- [x] `session-canonical` Consolidate and document one canonical warm-session reuse model for library and agent integrations.
- [x] `stale-detection` Add lightweight stale-session detection and refresh signaling for long-lived local sessions.
- [x] `warm-cache` Reduce warm-run latency by persisting and reusing more ready-to-query cache state.
- [x] `surface-narrowing` Simplify the product story around a small set of flagship workflows while retaining advanced features.

All ROI plan checklist items are complete.

## What has landed

### Review-first workflow and surface narrowing

- Updated the primary workflow messaging in:
  - `README.md`
  - `docs/cli.md`
  - `docs/agent-workflows.md`
  - `docs/library-api.md`
  - `codegraph-skill/codegraph/SKILL.md`
  - `src/cli/help.ts`
- Repositioned `review --base HEAD --head WORKTREE --summary` as the daily default.
- Kept `impact` as the broader blast-radius map and `orient -> search -> explain` as the unfamiliar-repo path.

### Search relevance and visible provenance

- Added shared analysis summary support in `src/analysisSummary.ts`.
- Extended agent search responses in `src/agent/search.ts` with:
  - top-level `analysis`
  - per-result `provenance`
  - code-first hybrid ranking behavior
- Extended explain responses in `src/agent/explain.ts` with top-level `analysis`.
- Updated tests in `tests/agent-search.test.ts`.
- Added top-level `analysis` metadata to impact batch, compact, CLI pretty, and streaming summary outputs.
- Updated impact coverage in:
  - `tests/impact-cli.test.ts`
  - `tests/impact-streaming.test.ts`
  - `tests/impact.test.ts`

### Review analysis labeling

- Added optional `analysis` to review output types in:
  - `src/review/types.ts`
  - `src/review/report.ts`
  - `src/review.ts`
  - `src/cli/review.ts`

### Session freshness and cache reuse

- Added stale-session detection and auto-refresh behavior to `src/session.ts`.
- Added session stats fields for stale state and refresh reasons.
- Updated agent/tool-side warm index usage in `src/agent-tools.ts` to use incremental builds with disk cache defaults.
- Persisted bloom filters inside the on-disk project snapshot and reused them on unchanged incremental loads instead of rebuilding them from source files.
- Added snapshot-schema fallback coverage so older snapshot versions rebuild cleanly and rewrite the current format.
- Added session coverage in `tests/session.test.ts`.

## Validation status

### Passed targeted tests

- `tests/agent-search.test.ts`
- `tests/agent-explain.test.ts`
- `tests/session.test.ts`
- targeted CLI help tests from `tests/cli-command-modules.test.ts`
- targeted CLI search regression from `tests/cli-regressions.test.ts`
- `tests/impact-cli.test.ts`
- `tests/impact-streaming.test.ts`
- `tests/impact.test.ts`
- `tests/cache-invalidation.test.ts`
- `tests/parsed-cache-reuse.test.ts`
- `tests/bloom-filter-integration.test.ts`
- `tests/sqlite.test.ts`
- `tests/cli-command-modules.test.ts`
- `tests/cli-regressions.test.ts`

### Repo-wide validation

- `npm run check` passed in the implementation checkout; rerun it in the target native-build environment before merge.

## Working tree notes

- `tests/cli-regressions.test.ts` changed during formatting.
- The observed diff is formatter-only wrapping, not logic changes.

## Recommended next resume point

1. If needed, trim or summarize the implementation notes into release notes or a PR description.
2. If follow-on work is desired, evaluate whether the ROI workflow changes should be split into smaller thematic PRs for easier review.
