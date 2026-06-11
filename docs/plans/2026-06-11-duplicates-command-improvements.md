# Duplicates Command Improvements Plan

This plan captures follow-up work for the `codegraph duplicates` command after a repo audit focused on business-logic duplication rather than acceptable repetition across tests, docs, fixtures, and language-parity definitions.

## Problems Observed

- `duplicates --help` does not document shared discovery flags such as `--ignore-glob`, `--include-glob`, or `--no-gitignore`.
- Positional include roots and exclusion globs are easy to confuse. A command like `--ignore-glob "tests/**" "docs/**"` silently treats later glob values as positional roots and fails later with an `ENOENT` on the glob string.
- The command is JSON-only, so exploratory duplicate triage requires post-processing even when the operator only needs a shortlist.
- High-confidence output is dominated by acceptable repetition unless the caller already knows which directories and file classes to exclude.

## Completed in PR #125: Clarify Discovery and Exclusion Semantics

Why this mattered:

- Duplicate cleanup is only useful when scan scope is easy to control.
- Confusing root-vs-glob behavior created avoidable retries and mistrust.

Delivered:

- [x] Documented shared discovery flags directly in `duplicates --help`.
- [x] Documented that positional arguments are scan roots, not globs.
- [x] Added an early targeted error when a positional include root looks like a glob pattern.
- [x] Added CLI docs and skill examples that repeat `--ignore-glob` per pattern.

## Completed in this branch: Improve Human Triage Output

Why this mattered:

- The command is often used interactively before a follow-up refactor.
- Large grouped JSON is correct but expensive to read by hand.

Delivered:

- [x] Added `--pretty` output for one-line-per-group review.
- [x] Included file paths, symbol or chunk names, confidence, clone type, score, and token counts in the human summary.
- [x] Kept JSON as the default machine contract.

## Completed in this branch: Make Actionable Duplicates Easier to Isolate

Why this mattered:

- Repo audits care about utilities and business logic, not intentional parity files.
- Manual filtering previously happened outside the tool.

Delivered:

- [x] Added heuristic family annotations for common duplicate families: language-parity definitions, declaration mirrors, and small CLI boilerplate.
- [x] Added an actionability-oriented ranking mode with `--sort actionability`, and made `--pretty` default to actionability ordering.
- [x] Kept exact grouped JSON available as the default output while allowing explicit sort control.

## Validation Checklist

- [x] `node ./dist/cli.js duplicates --help`
- [x] `node ./dist/cli.js duplicates --root . ./src --min-confidence medium`
- [x] `node ./dist/cli.js duplicates --root . ./src --ignore-glob "tests/**" --ignore-glob "docs/**"`
- [x] `node ./dist/cli.js duplicates --root . ./src --pretty --include-small`
- [x] `node ./dist/cli.js duplicates --root . --sort actionability --include-small`
- [x] A misuse case with a glob-looking positional root fails with a targeted message.
