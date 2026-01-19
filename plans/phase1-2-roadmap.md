# Phase 1-2 roadmap (agent/CI focus)

## Phase 1 — Agent-ready CI baseline
- **Deterministic outputs**: sort review bundles and graph deltas for stable CI diffs.
- **Review schema versioning**: add `schemaVersion` to `review.json`.
- **Build observability**: emit cache hit/miss summaries and per-phase timings for `index`, `graph`, and `review`.

## Phase 2 — Incremental correctness & reliability
- **Cache validation**: add a `--cache-verify` mode that detects manifest mismatches and reports recovery actions.
- **Strict incremental mode**: add `--incremental-strict` (or similar) to force full parsing for changed files while keeping incremental file selection.
- **Manifest compatibility metadata**: warn when manifest options differ from current run settings.
