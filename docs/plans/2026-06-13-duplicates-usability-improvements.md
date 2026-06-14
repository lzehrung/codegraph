# Duplicates Command Usability Improvements

**Status:** Completed  
**Goal:** Make `codegraph duplicates` answer refactoring-triage questions directly without requiring JSON post-processing or prior knowledge of duplicate-detector internals.

## Problem

`duplicates` is already readable by default, but cleanup triage still requires too much interpretation.
The recent duplicate audit needed custom JSON parsing to rank candidates by reduced lines, manual clustering across repeated pairs, and extra knowledge that `--ignore-glob` is relative to each scan root.

## Design principles

- Keep pretty output as the default for humans and agents.
- Keep `--json` as the stable machine contract.
- Prefer presets over long flag recipes for common workflows.
- Preserve raw similarity diagnostics, but add cleanup-oriented ranking and labels.
- Make surprising path and ignore behavior visible at the command line.

## Phase 1: Cleanup triage preset

- [x] Add `--profile cleanup` or `--profile refactor-roi` for duplicate cleanup audits.
- [x] Make the preset use action-oriented defaults:
  - [x] `--sort reduced-lines` or equivalent cleanup score.
  - [x] `--min-confidence medium`.
  - [x] Higher token floor than the broad default, likely `--min-tokens 80`.
  - [x] Suppress tiny import-only chunks where safe.
  - [x] Suppress obvious barrel export boilerplate where safe.
- [x] Document the preset in `docs/cli.md`.
- [x] Update `codegraph-skill/codegraph/SKILL.md` with the shortest recommended cleanup command.
- [x] Add CLI help text that explains when to use the preset instead of raw duplicate output.

## Phase 2: Reduced-line ranking

- [x] Add `reducedLines` to each JSON duplicate group.
- [x] Add `estimatedLinesSaved` for clustered groups.
- [x] Add `--sort reduced-lines`.
- [x] Show reduced lines in pretty output.
- [x] Add regression tests for stable ordering by reduced lines.
- [x] Update JSON schema/version docs or fixtures if the contract changes.

## Phase 3: Duplicate clustering

- [x] Group related pairwise matches into clusters when they share equivalent units or helper names.
- [x] Preserve representative pair evidence inside each cluster.
- [x] Show cluster summaries in pretty output:
  - [x] number of locations.
  - [x] estimated reducible lines.
  - [x] shared symbol or chunk label when available.
  - [x] top files involved.
- [x] Add JSON fields for clustered locations without removing `primaryLeft` / `primaryRight` compatibility.
- [x] Add tests for a helper duplicated across three or more test files.

## Phase 4: Ignore-glob usability

- [x] Detect ignore/include patterns that match zero files under at least one active scan root.
- [x] Emit a concise warning with the scan-root-relative interpretation.
- [x] Suggest likely alternatives when a root-prefixed pattern appears to target a scan-root child.
- [x] Add `--ignore-root-glob` and `--include-root-glob` for project-root-relative filters.
- [x] Document that CLI include/ignore globs are relative to each active scan root, while config globs are project-root-relative.
- [x] Add tests for `--root . ./tests --ignore-glob tests/languages/**` suggesting `languages/**`.

## Phase 5: Noise classification

- [x] Add cleanup labels separate from similarity reasons.
- [x] Initial labels to consider:
  - [x] `test-helper-extraction`.
  - [x] `production-helper-extraction`.
  - [x] `fixture-boilerplate`.
  - [x] `barrel-export-noise`.
  - [x] `type-shape-noise`.
  - [x] `import-list-noise`.
- [x] Use labels in pretty output to explain why a candidate is or is not actionable.
- [x] Expose labels in JSON for agent consumers.
- [x] Keep similarity reasons unchanged for auditability.

## Phase 6: Summary output

- [x] Add a compact summary footer to pretty output.
- [x] Include:
  - [x] total groups returned.
  - [x] omitted counts.
  - [x] top cleanup clusters.
  - [x] likely noise categories.
  - [x] suggested rerun commands.
- [x] Add `--no-summary` if the footer is too noisy for scripts reading pretty output.
- [x] Keep `--json` free of prose warnings except structured diagnostics.

## Phase 7: JSON ergonomics

- [x] Add a short JSON schema example to `docs/cli.md`.
- [x] Include flattened `locations` on each group or cluster while retaining `primaryLeft` and `primaryRight`.
- [x] Make field names match common triage questions: files, lines, confidence, clone type, reduced lines, labels, reasons.
- [x] Add contract tests for backwards-compatible fields.

## Phase 8: Validation workflow

- [x] Add or update focused duplicate-command tests for each new flag/output contract.
- [x] Run targeted tests for duplicate CLI behavior.
- [x] Run duplicate cleanup preset against `./src ./tests` and verify the top output matches manual expectations.
- [x] Run `npm run check` before closing the implementation story.
- [x] Update this plan with completed items and any deferred choices.

## Completion notes

- `duplicates --profile cleanup` is the shortest cleanup audit command.
- `--ignore-glob` and `--include-glob` remain scan-root-relative; `duplicates --ignore-root-glob` and `duplicates --include-root-glob` provide project-root-relative one-off filters.
- Pretty output now carries cleanup labels, cluster counts, reduced-line metrics, and a summary footer.
- JSON now carries `schemaVersion: 3`, `reducedLines`, `estimatedLinesSaved`, `cleanupLabels`, flattened `locations`, and optional `cluster`.

## Open decisions

- [x] Final preset name: `cleanup`, with `refactor-roi` as an alias.
- [x] `reducedLines` means the minimum visible pair span; `estimatedLinesSaved` carries the clustered cleanup estimate.
- [x] Zero-match scan-root glob diagnostics warn by default.
- [x] Clustering is the default grouped/pretty behavior.
