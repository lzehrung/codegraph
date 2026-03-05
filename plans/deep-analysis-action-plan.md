# Deep Analysis Action Plan: Codegraph Core + Impact Pipeline

Goal: harden dependency graph accuracy and change-impact reliability for multi-language repos and git-diff-driven review automation.

## Summary of high-value findings

- [ ] Add a file-level fallback impact path for changed files that produce zero changed symbols.
  - Why: current impact propagation is driven by `changedSymbols`; for non-symbol edits (module side effects, top-level runtime logic, config-like source files), direct impact can be under-reported.
  - Action:
    - Add an option-controlled fallback that marks reverse dependents of modified files as impacted with lower confidence when symbol mapping returns empty.
    - Keep existing symbol-first behavior, but add an explicit fallback reason (for example `fileLevelChange`).
  - Tests:
    - Add fixtures where a module exports nothing but has side effects used by importers.
    - Verify importer files are surfaced even with no symbol definitions.

- [ ] Fix copy/rename classification in unified diff parsing.
  - Why: parser currently infers rename when `a/path` and `b/path` differ, which can misclassify copied files as renamed.
  - Action:
    - Parse `rename from`, `rename to`, `copy from`, `copy to`, and similarity headers explicitly.
    - Extend `FileChange.kind` to represent copied files or normalize copy to added without triggering rename semantics.
  - Tests:
    - Add parser tests for pure rename, pure copy, rename-with-edits, and copy-with-edits.

- [ ] Make test pattern handling resilient to invalid user regex strings.
  - Why: constructing `new RegExp(pattern)` directly can throw and abort impact analysis.
  - Action:
    - Validate each pattern in a guarded helper and skip invalid entries with a warning callback.
  - Tests:
    - Add tests with malformed regex patterns; ensure analysis still succeeds.

- [ ] Reduce false exclusion of non-test files by tightening default test-file detection.
  - Why: default `/test/i` and `/spec/i` matching can classify regular source files incorrectly (for example `latest.ts`, `aspectRatio.ts`).
  - Action:
    - Replace broad substring patterns with path-segment and suffix-aware patterns.
    - Keep user-provided patterns additive.
  - Tests:
    - Add positive and negative path classification cases.

## Performance and scalability plan

- [ ] Parallelize `locateChangedSymbols` across changed files with bounded concurrency.
  - Why: current sequential loop can dominate end-to-end latency on large diffs.
  - Action:
    - Reuse existing semaphore/mapLimit strategy from indexing path.
    - Preserve deterministic output order after aggregation.
  - Tests:
    - Add a stress test with many changed files to ensure stable output and no race regressions.

- [ ] Cut AST traversal cost when mapping changed lines to nodes.
  - Why: current traversal collects all overlapping nodes, including many ancestor/descendant duplicates.
  - Action:
    - Introduce a mode to collect nearest declaration-relevant nodes first (or prune descendants once a declaration-level match is found).
    - Benchmark before/after on large source files.
  - Tests:
    - Add micro-benchmark or parser-efficiency regression test validating reduced runtime for large hunks.

## Diff provider robustness plan

- [ ] Remove shell-interpolated git command construction in provider preflight.
  - Why: `execSync` with string interpolation is brittle and can break on unusual refs or shell metacharacters.
  - Action:
    - Use `spawn`/`execFile` argument arrays for shortstat preflight too.
    - Keep stderr handling and warning behavior unchanged.
  - Tests:
    - Add unit tests for refs containing slashes and unusual characters.

- [ ] Improve path normalization for quoted/escaped git paths.
  - Why: diff headers can contain quoted C-style escaped paths when names contain spaces or special chars.
  - Action:
    - Decode git-quoted paths in parser headers before normalization.
    - Validate behavior on Windows-style separators too.
  - Tests:
    - Add parser fixtures with spaced names, unicode escapes, and renamed quoted paths.

## Reliability and verification plan

- [ ] Clarify and test `changedSince` semantics.
  - Why: behavior differs depending on whether callers expect `git diff <rev>` vs `<rev>..HEAD`; ambiguity can cause missed or extra changed files.
  - Action:
    - Document the exact semantics in README and API comments.
    - Add explicit tests for working-tree vs commit-range usage.

- [ ] Expand end-to-end regression matrix for impact correctness.
  - Why: this library is used by review automation and requires stable output under real-world repo states.
  - Action:
    - Add scenario tests covering: rename+delete combinations, binary files in diff, parse failures, partial clones, and mixed-language monorepo edges.
    - Add invariant checks (no duplicate impacted file rows, stable severity ordering ties).

## Execution order

1. Correctness-critical parsing and fallback impact behavior.
2. Test-pattern hardening and classification precision.
3. Concurrency + AST traversal performance improvements.
4. Provider robustness and path-escaping coverage.
5. Semantics documentation and full regression expansion.

## Definition of done

- [ ] New and updated tests pass in CI.
- [ ] No regression in existing impact and graph test suites.
- [ ] README/docs updated for any behavior changes.
- [ ] Changelog/release note entry added for impact-model behavior changes.
