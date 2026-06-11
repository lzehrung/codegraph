# Duplicates Command Improvements Plan

This plan captures follow-up work for the `codegraph duplicates` command after a repo audit focused on business-logic duplication rather than acceptable repetition across tests, docs, fixtures, and language-parity definitions.

## Problems Observed

- `duplicates --help` does not document shared discovery flags such as `--ignore-glob`, `--include-glob`, or `--no-gitignore`.
- Positional include roots and exclusion globs are easy to confuse. A command like `--ignore-glob "tests/**" "docs/**"` silently treats later glob values as positional roots and fails later with an `ENOENT` on the glob string.
- The command is JSON-only, so exploratory duplicate triage requires post-processing even when the operator only needs a shortlist.
- High-confidence output is dominated by acceptable repetition unless the caller already knows which directories and file classes to exclude.

## Priority 1: Clarify Discovery and Exclusion Semantics

Why this matters:

- Duplicate cleanup is only useful when scan scope is easy to control.
- Confusing root-vs-glob behavior creates avoidable retries and mistrust.

Implementation outline:

- [ ] Document shared discovery flags directly in `duplicates --help`.
- [ ] Document that positional arguments are scan roots, not globs.
- [ ] Fail early with a targeted error when a positional include root looks like a glob pattern.
- [ ] Add CLI docs and skill examples that repeat `--ignore-glob` per pattern.

## Priority 2: Improve Human Triage Output

Why this matters:

- The command is often used interactively before a follow-up refactor.
- Large grouped JSON is correct but expensive to read by hand.

Implementation outline:

- [ ] Add `--pretty` or `--summary` output for one-line-per-group review.
- [ ] Include file paths, symbol or chunk names, confidence, clone type, score, and token span in the human summary.
- [ ] Keep JSON as the default machine contract.

## Priority 3: Make Actionable Duplicates Easier to Isolate

Why this matters:

- Repo audits care about utilities and business logic, not intentional parity files.
- Manual filtering currently happens outside the tool.

Implementation outline:

- [ ] Consider output annotations for common duplicate families such as language-parity definitions, declaration mirrors, and CLI boilerplate.
- [ ] Consider an actionability-oriented ranking mode that weighs copy count, token span, and subsystem distance instead of similarity alone.
- [ ] Keep exact grouped JSON available even when higher-level ranking or suppression is added.

## Validation Checklist

- [ ] `node ./dist/cli.js duplicates --help`
- [ ] `node ./dist/cli.js duplicates --root . ./src --min-confidence medium`
- [ ] `node ./dist/cli.js duplicates --root . ./src --ignore-glob "tests/**" --ignore-glob "docs/**"`
- [ ] A misuse case with a glob-looking positional root should fail with a targeted message.
