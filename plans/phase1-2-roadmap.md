# Phase 1-2 roadmap (agent/CI focus)

## Phase 1 — Agent-ready CI baseline
- [x] **Deterministic outputs**: sort review bundles and graph deltas for stable CI diffs.
- [x] **Review schema versioning**: add `schemaVersion` to `review.json`.
- [x] **Build observability**: emit cache hit/miss summaries and per-phase timings for `index`, `graph`, and `review`.

## Phase 2 — Incremental correctness & reliability
- [x] **Cache validation**: add a `--cache-verify` mode that detects manifest mismatches and reports recovery actions.
- [x] **Strict incremental mode**: add `--incremental-strict` (or similar) to force full parsing for changed files while keeping incremental file selection.
- [x] **Manifest compatibility metadata**: warn when manifest options differ from current run settings.

## Phase 3 — Agent workflow enhancements
- [x] **Review task templates**: include structured review tasks in review output.
- [x] **Risk classification**: add a structured risk summary for review bundles.
