# Duplicates Command Usability Improvements

**Status:** Proposed  
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

- [ ] Add `--profile cleanup` or `--profile refactor-roi` for duplicate cleanup audits.
- [ ] Make the preset use action-oriented defaults:
  - [ ] `--sort reduced-lines` or equivalent cleanup score.
  - [ ] `--min-confidence medium`.
  - [ ] Higher token floor than the broad default, likely `--min-tokens 80`.
  - [ ] Suppress tiny import-only chunks where safe.
  - [ ] Suppress obvious barrel export boilerplate where safe.
- [ ] Document the preset in `docs/cli.md`.
- [ ] Update `codegraph-skill/codegraph/SKILL.md` with the shortest recommended cleanup command.
- [ ] Add CLI help text that explains when to use the preset instead of raw duplicate output.

## Phase 2: Reduced-line ranking

- [ ] Add `reducedLines` to each JSON duplicate group.
- [ ] Consider `estimatedLinesSaved` for clustered groups once clustering exists.
- [ ] Add `--sort reduced-lines`.
- [ ] Show reduced lines in pretty output.
- [ ] Add regression tests for stable ordering by reduced lines.
- [ ] Update JSON schema/version docs or fixtures if the contract changes.

## Phase 3: Duplicate clustering

- [ ] Group related pairwise matches into clusters when they share equivalent units or helper names.
- [ ] Preserve representative pair evidence inside each cluster.
- [ ] Show cluster summaries in pretty output:
  - [ ] number of locations.
  - [ ] estimated reducible lines.
  - [ ] shared symbol or chunk label when available.
  - [ ] top files involved.
- [ ] Add JSON fields for clustered locations without removing `primaryLeft` / `primaryRight` compatibility.
- [ ] Add tests for a helper duplicated across three or more test files.

## Phase 4: Ignore-glob usability

- [ ] Detect ignore/include patterns that match zero files under at least one active scan root.
- [ ] Emit a concise warning with the scan-root-relative interpretation.
- [ ] Suggest likely alternatives when a root-prefixed pattern appears to target a scan-root child.
- [ ] Consider adding `--ignore-root-glob` and `--include-root-glob` for project-root-relative filters.
- [ ] Document that CLI include/ignore globs are relative to each active scan root, while config globs are project-root-relative.
- [ ] Add tests for `--root . ./tests --ignore-glob tests/languages/**` suggesting `languages/**`.

## Phase 5: Noise classification

- [ ] Add cleanup labels separate from similarity reasons.
- [ ] Initial labels to consider:
  - [ ] `test-helper-extraction`.
  - [ ] `production-helper-extraction`.
  - [ ] `fixture-boilerplate`.
  - [ ] `barrel-export-noise`.
  - [ ] `type-shape-noise`.
  - [ ] `import-list-noise`.
- [ ] Use labels in pretty output to explain why a candidate is or is not actionable.
- [ ] Expose labels in JSON for agent consumers.
- [ ] Keep similarity reasons unchanged for auditability.

## Phase 6: Summary output

- [ ] Add a compact summary footer to pretty output.
- [ ] Include:
  - [ ] total groups returned.
  - [ ] omitted counts.
  - [ ] top cleanup clusters.
  - [ ] likely noise categories.
  - [ ] suggested rerun commands.
- [ ] Add `--no-summary` if the footer is too noisy for scripts reading pretty output.
- [ ] Keep `--json` free of prose warnings except structured diagnostics.

## Phase 7: JSON ergonomics

- [ ] Add a short JSON schema example to `docs/cli.md`.
- [ ] Include flattened `locations` on each group or cluster while retaining `primaryLeft` and `primaryRight`.
- [ ] Make field names match common triage questions: files, lines, confidence, clone type, reduced lines, labels, reasons.
- [ ] Add contract tests for backwards-compatible fields.

## Phase 8: Validation workflow

- [ ] Add or update focused duplicate-command tests for each new flag/output contract.
- [ ] Run targeted tests for duplicate CLI behavior.
- [ ] Run duplicate cleanup preset against `./src ./tests` and verify the top output matches manual expectations.
- [ ] Run `npm run check` before closing the implementation story.
- [ ] Update this plan with completed items and any deferred choices.

## Open decisions

- [ ] Choose final preset name: `cleanup`, `refactor-roi`, or both with one alias.
- [ ] Decide whether `reducedLines` should mean minimum pair span or estimated lines removable after clustering.
- [ ] Decide whether zero-match glob diagnostics should warn by default or only with a verbose/debug flag.
- [ ] Decide whether clustering should be default pretty behavior or gated behind a flag until stable.
