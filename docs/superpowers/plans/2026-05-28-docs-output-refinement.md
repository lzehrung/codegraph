# Documentation and Output Refinement Plan

## Goal

- Make call compatibility and duplicate detection easy to discover from the docs agents actually read.
- Keep README examples concise while pointing to canonical CLI and API docs for full contracts.

## Current State

- Call compatibility is available through impact and review outputs after callable signature changes.
- Duplicate detection is available through `codegraph duplicates` and compact `inspect` opportunities.
- `docs/cli.md`, `docs/library-api.md`, and `codegraph-skill/codegraph/SKILL.md` describe the individual features.
- `docs/agent-workflows.md` needs clearer guidance on when agents should run duplicate detection during review.
- README should eventually include short example CLI input/output blocks for the most common workflows.

## Principles

- Keep README as the landing page and docs index, not the canonical reference for every flag.
- Prefer bullets and short examples over long explanatory prose.
- Treat call compatibility and duplicate detection as review leads, not proof of defects.
- Keep output examples small, stable, and visibly bounded.
- Preserve cross-language claims by linking to parity docs when behavior depends on language support.

## Phase 1: Documentation Cleanup

- [x] Tighten call compatibility wording in:
  - `docs/cli.md`
  - `docs/library-api.md`
  - `docs/agent-workflows.md`
  - `docs/how-it-works.md`
  - `codegraph-skill/codegraph/SKILL.md`
- [x] Add duplicate-detection review guidance to `docs/agent-workflows.md`.
- [x] Add a concise duplicate-detection pointer to `codegraph-skill/codegraph/SKILL.md`.
- [x] Review the changed docs for discoverability, repetition, and unclear source paths.
- [x] Verify formatting with Prettier and whitespace checks.

## Phase 2: General Documentation Review

- [x] Review core documentation for stale or missing workflow guidance:
  - `README.md`
  - `docs/installation.md`
  - `docs/cli.md`
  - `docs/library-api.md`
  - `docs/agent-workflows.md`
  - `docs/how-it-works.md`
  - `docs/language-parity.md`
  - `docs/scenario-catalog.md`
  - `codegraph-skill/codegraph/SKILL.md`
- [x] Make feature discovery consistent across README, CLI docs, library docs, and the skill.
- [x] Keep detailed contracts in canonical docs and link to them from README.
- [x] Confirm README table of contents still matches any added or renamed sections.

## Phase 3: README CLI Examples

- [x] Add compact README examples with monospace command and output blocks.
- [x] Include representative inputs and bounded outputs for:
  - `codegraph impact --pretty`
  - call compatibility leads inside impact or review output
  - `codegraph review --summary`
  - `codegraph duplicates`
  - `codegraph orient`
- [x] Keep examples intentionally small and avoid fixture-specific noise.
- [x] Link each example to the canonical CLI section for full flags and JSON shape.

Example target shape:

```bash
codegraph impact --base main --head HEAD --pretty
```

```text
Changed symbols
- src/api/users.ts:createUser
  - likely impacted: src/routes/users.ts
  - call compatibility: 1 likely mismatch
```

## Phase 4: Default Output Refinement

- [x] Keep call compatibility enabled by default for `impact` and `review` when callable signatures changed.
- [x] Add duplicate leads by default only where they are scoped, high-confidence, and review-oriented:
  - `impact --pretty`: changed files only.
  - `review --summary`: changed plus impacted files.
  - `orient`: no duplicate detection by default.
  - Repository-level opportunities: explicit `inspect` or `duplicates` commands only.
- [x] Consider a small option surface instead of implicit broad scans:
  - `--duplicates off`
  - `--duplicates changed`
  - `--duplicates impacted`
  - `--duplicates all`
- [x] Preserve existing JSON contracts or add explicit schema fields with omission counts.
- [x] Ensure human summaries show only high-confidence exact or renamed duplicate leads.
- [x] Include omission counts when duplicate leads are hidden by confidence, scope, or budget.
- [x] Keep call compatibility default behavior focused on high-confidence `likely_mismatch` findings.
- [x] Add tests for any changed CLI or library output contract.

## Acceptance Criteria

- Documentation explains how agents get call compatibility and duplicate detection signals.
- README has concise CLI input/output examples after the follow-up implementation pass.
- Default output changes are backed by tests, budget limits, and documented JSON fields.
- No docs imply full static type checking or semantic-equivalence proof.
- Language parity claims remain aligned with `docs/language-parity.md` and `docs/scenario-catalog.md`.

## Verification

```bash
npx prettier --check README.md docs/installation.md docs/cli.md docs/library-api.md docs/agent-workflows.md docs/how-it-works.md docs/language-parity.md docs/scenario-catalog.md codegraph-skill/codegraph/SKILL.md
git diff --check
```
