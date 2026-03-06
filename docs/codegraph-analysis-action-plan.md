# Codegraph Dependency and Impact Analysis Action Plan

This document summarizes a deep logic and performance review of the codegraph indexing and impact pipeline, with a fix plan focused on correctness for multi-language dependency graphs and git-diff-driven change impact.

## High-priority correctness issues

- [x] **Fix renamed-file transitive seeding to use both old and new paths.**
  - **Issue:** `seedTransitiveFromFiles` currently queries dependents using `fileChange.path` for renamed files. For rename diffs, `path` is usually the new path, while `oldPath` is the one most existing import edges still reference.
  - **Risk:** Under-reporting impact when files are renamed or moved, especially in monorepos and refactors.
  - **Action:** For `kind === "renamed"`, seed dependents from both `oldPath` (when present) and `path`, merge results, and annotate explain hints accordingly.
  - **Tests:** Add regression tests where old imports are still present after rename, and where imports are updated to new path.

- [x] **Apply `maxRefs` after filtering ignored/test refs, not before.**
  - **Issue:** `analyzeImpact` slices `refs.references` before filtering test and ignored files.
  - **Risk:** If early refs are predominantly tests, production refs can be dropped and impact appears smaller than reality.
  - **Action:** Iterate refs in order, apply filters first, then cap at `maxRefs` counted refs.
  - **Tests:** Add a deterministic test where first N refs are tests and later refs are source files; ensure source refs are preserved.

- [x] **Persist computed confidence in impact items.**
  - **Issue:** `calculateSeverity` computes confidence, but `analyzeImpact` does not write it to direct impact items (only file-level fallback sets confidence today).
  - **Risk:** Downstream review agents lose reliability signal and cannot distinguish precise from heuristic impacts.
  - **Action:** Merge confidence into `ImpactItem` using max/weighted strategy and carry through transitive propagation rules.
  - **Tests:** Add assertions in impact analyzer tests that direct refs include confidence and that merged items preserve strongest confidence.

- [x] **Broaden file-level fallback beyond selected modified files.**
  - **Issue:** `seedTransitiveFromFiles` handles modified files only when `fileLevelFallbackPaths` contains them, and handles deleted/renamed files, but does not cover all fallback-worthy states (for example, zero-symbol files with structural import changes).
  - **Risk:** Missing impact when symbol mapping fails or parser support is partial.
  - **Action:** Introduce explicit fallback policy: seed when symbol mapping is empty for a changed file that has inbound deps, with guardrails for noise.
  - **Tests:** Add cases for parse-failure file, non-code extension in dependency chain, and large generated files.

## Medium-priority logic and signal quality issues

- [x] **Improve config-impact heuristics to include removals and key-level diffs.**
  - **Issue:** `classifyConfigImpact` heavily relies on added lines; removed lines can carry equally strong impact (dependency removals, path alias removals, script removals).
  - **Risk:** False negatives in CI/build and dependency impact suggestions.
  - **Action:** Use both added and removed lines for semantic triggers; track key transitions (added, removed, modified).
  - **Tests:** Extend config-impact tests for pure-removal diffs in `package.json`, `tsconfig`, and task-runner configs.

- [x] **Harden git diff parsing for edge metadata and binary changes.**
  - **Issue:** Parser handles core headers well but does not surface mode-only or binary-only change signals as first-class metadata.
  - **Risk:** Changed files with empty hunks can bypass symbol mapping and fallback paths.
  - **Action:** Track `isBinary`, `modeChanged`, and `similarityIndex` flags in parsed file changes and route them into fallback logic.
  - **Tests:** Add parser fixtures for binary diffs, chmod-only changes, and rename+mode updates.

- [x] **Revisit changed-line mapping for deletion-heavy hunks.**
  - **Issue:** deletion lines are mapped to current `newLine`, collapsing consecutive deletions to a narrow line set.
  - **Risk:** Weak overlap detection for breakage hints and symbol attribution around removed declarations.
  - **Action:** Preserve richer deletion span mapping (for example, virtual ranges anchored to surrounding context) and use that in breaking-change detection.
  - **Tests:** Add multi-line deletion cases where exported declarations are fully removed.

## Performance and scalability improvements

- [x] **Parallelize untested-change reference discovery with bounded concurrency.**
  - **Issue:** `collectUntestedChangeSuggestions` runs `findReferences` sequentially for each changed symbol.
  - **Risk:** Slow impact runs on large diffs with many changed symbols.
  - **Action:** Use `mapLimit`/semaphore for bounded parallelism and optional de-dup caching by symbol handle.
  - **Tests:** Add a performance guard test (or benchmark harness) verifying latency reduction with identical output.

- [x] **Reduce repeated graph scans for fan-in and pattern matching.**
  - **Issue:** Fan-in and matcher setup are recomputed in multiple paths; some routines still perform repeated scans.
  - **Risk:** Increased CPU on large monorepos.
  - **Action:** Build and pass shared dependency stats object through impact pipeline stages.
  - **Tests:** Add unit-level checks that stats reuse does not change results.

## Reliability and observability

- [x] **Add explicit impact diagnostics counters to reports.**
  - **Issue:** It is hard to explain why certain files were excluded (ignored, test-filtered, maxRefs-capped, parse-failed).
  - **Risk:** Low trust and difficult debugging for review-agent consumers.
  - **Action:** Emit counters in `ImpactReport` for filtered refs, fallback-triggered files, and parser fallbacks.
  - **Tests:** Snapshot/update report tests to validate diagnostics stability.

- [x] **Add rename/move and parser-fallback scenarios to the scenario catalog.**
  - **Issue:** Existing coverage is broad, but these high-risk paths should be explicitly documented and continuously validated.
  - **Action:** Extend `docs/scenario-catalog.md` and include expected impact outcomes.

## Recommended execution order

1. Fix rename/dependency seeding and `maxRefs` filtering order.
2. Wire confidence into `ImpactItem` and report outputs.
3. Improve fallback policy and binary/mode change handling.
4. Optimize untested-change reference pass with bounded concurrency.
5. Expand tests and scenario docs for regressions and operability.
