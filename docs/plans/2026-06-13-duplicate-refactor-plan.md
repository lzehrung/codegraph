# Duplicate Refactor Plan

**Status:** Completed
**Audit command:** `codegraph duplicates --root . ./src ./tests --json --sort actionability --limit 500 --min-confidence medium --min-tokens 80 --ignore-glob tests/languages/** --ignore-glob languages/** --ignore-glob tests/samples/** --ignore-glob samples/** --ignore-glob tests/graph-visualization/fixtures/** --ignore-glob graph-visualization/fixtures/**`

This plan covers duplicate groups worth removing after ignoring per-language fixtures and repetition that is clearer when kept near each feature.

## Working rules

- Extract only when the shared helper keeps call sites simpler than the duplicated code.
- Prefer `tests/helpers/*` for test-only setup and `src/util/*` for small production utilities.
- Keep per-language fixtures, language parity cases, barrel exports, and tiny command context types explicit.
- Migrate one cluster at a time with targeted tests before moving to the next cluster.
- Run `npm run check` after all accepted clusters are complete.

## Phase 1: Shared CLI test runner

Target duplicates:

- [x] `tests/cli-command-modules.test.ts:136-164` `captureCli`
- [x] `tests/cli-regressions.test.ts:59-86` `runCliInProcess`
- [x] `tests/duplicates.test.ts:31-57` `captureCli`
- [x] `tests/impact-cli.test.ts:71-128` `runCodegraphCliResult` and related wrappers
- [x] `tests/cli-regressions.test.ts:215-239` vs `tests/impact-cli.test.ts:105-128`

Plan:

- Add one reusable in-process CLI runner under `tests/helpers/cli.ts`.
- Support captured stdout/stderr, exit-code capture, and throw-on-exit modes without mocking process state differently per test file.
- Migrate the four CLI suites in one pass so helper semantics are proven across command modules, regressions, duplicates, and impact CLI.
- Keep command-specific fixture setup local to each suite.

Verification:

- [x] `npx vitest run tests/cli-command-modules.test.ts tests/cli-regressions.test.ts tests/duplicates.test.ts tests/impact-cli.test.ts`

## Phase 2: Test workspace and artifact helpers

Target duplicates:

- [x] `tests/cli-command-modules.test.ts:770-838` vs `tests/cli-regressions.test.ts:1582-1625`
- [x] `tests/artifact-build.test.ts:213-246` vs `tests/mcp-server.test.ts:871-904`
- [x] `tests/cache-invalidation.test.ts:769-800` vs `tests/graph-delta.test.ts:67-103`
- [x] `tests/java-import-resolution-regression.test.ts:1-50` vs `tests/kotlin-import-resolution-regression.test.ts:1-51` only for generic temp-directory setup; keep language-specific assertions local.

Plan:

- Extend `tests/helpers/filesystem.ts` or add focused helpers for temporary package roots, symlink-tolerant artifact assertions, and stale-output setup.
- Reuse existing `mkTmpDir` rather than adding local temp helpers.
- Do not hide the test scenario. Helper names should describe filesystem mechanics, not expected behavior.

Verification:

- [x] `npx vitest run tests/cli-command-modules.test.ts tests/cli-regressions.test.ts tests/artifact-build.test.ts tests/mcp-server.test.ts tests/cache-invalidation.test.ts tests/graph-delta.test.ts tests/java-import-resolution-regression.test.ts tests/kotlin-import-resolution-regression.test.ts`

## Phase 3: Native and fallback test harness consolidation

Target duplicates:

- [x] `tests/native-fallback-contract.test.ts:40-84` vs `tests/native-tree-sitter.test.ts:34-74`
- [x] `tests/native-query-ownership-parity.test.ts:15-53` vs `tests/native-semantic-parity.test.ts:165-183`
- [x] Repeated native-parser ownership assertions across `tests/detailed-symbol-native-only.test.ts`, `tests/native-parser-ownership.test.ts`, and `tests/native-semantic-parity.test.ts`

Plan:

- Move module-index simplification and runtime-mode env swapping into a native test helper.
- Keep test cases and expected language behavior in their owning suites.
- Extract repeated parser-ownership assertions only if the helper name preserves the invariant being tested.

Verification:

- [x] `npx vitest run tests/native-fallback-contract.test.ts tests/native-tree-sitter.test.ts tests/native-query-ownership-parity.test.ts tests/native-semantic-parity.test.ts tests/detailed-symbol-native-only.test.ts tests/native-parser-ownership.test.ts`

## Phase 4: Small production utility extractions

Target duplicates:

- [x] `src/util/projectFiles/parsers.ts:20-35`, `src/util/projectFiles/parsers.ts:112-127`, and `src/util/workspace.ts:108-123`
- [x] `src/graph-builder.ts:133-149` vs `src/indexer/build-index.ts:644-662` - deferred; the option values come from different graph contexts, logging/reporting paths, and cache inputs, so a shared builder would hide call-site differences.
- [x] `src/cli/graph.ts:318-339` vs `src/cli/index.ts:46-75` - deferred; the graph command has incremental changed-file/index-report behavior that would make a shared option builder obscure command-specific flags.

Plan:

- [x] Add a shared inline-comment stripping helper with explicit trim behavior for project-file parsing and workspace config parsing.
- [x] Consider a small `collectEdgesForFile` option builder only if it removes duplicated defaults without obscuring call-site differences; deferred with rationale above.
- [x] Consider a shared index-option builder for `graph` and `index` commands only if command-specific flags remain visible; deferred with rationale above.

Verification:

- [x] Targeted tests for project-file parsing and workspace parsing.
- [x] Targeted CLI/indexing tests covering graph and index option behavior if option builders change; not applicable because option builders were deferred.

## Deferred candidates

These have lower ROI or are likely clearer when left explicit:

- [x] `src/graphs.ts:1-34` vs `src/util.ts:1-72`: barrel export boilerplate; deferred.
- [x] `src/cli/graph.ts:62-92` vs `src/cli/index.ts:21-41`: command-context aliases with command-specific fields; deferred.
- [x] `src/impact/types.ts:132-158` vs `src/native/contracts.ts:27-52`: unrelated type-shape similarity; deferred.
- [x] Import-list chunks across `src/duplicates.ts`, `src/graphs/specifiers.ts`, `src/indexer/navigation.ts`, `src/impact/report.ts`, and `src/sql/navigation.ts`: top-of-file coincidence, not behavioral duplication; deferred.
- [x] Per-feature resolution fixtures in `tests/resolution.test.ts`, `tests/ts-paths-workspace.test.ts`, and `tests/document-links.test.ts` unless a later feature needs shared setup; deferred.

## Post-refactor audit

Reran the audit command after the refactors. It reported 299 groups with zero omitted groups.

Remaining high-line candidates are intentionally deferred or separate stories:

- `tests/resolution.test.ts` / `tests/ts-paths-workspace.test.ts` / `tests/document-links.test.ts`: per-feature resolution fixtures.
- `src/graphs.ts` / `src/util.ts`: barrel export boilerplate.
- `tests/java-import-resolution-regression.test.ts` / `tests/kotlin-import-resolution-regression.test.ts`: per-language assertion parity after generic temp setup moved to helpers.
- `src/sqlite/schema.ts` / `tests/sql-fact-extraction.test.ts`: schema expectation mirror.
- `tests/cache-invalidation.test.ts` / `tests/graph-delta.test.ts`: separate cache and delta scenarios with similar out-of-root rejection setup.
- `tests/impact-analyzer.test.ts` / `tests/review.test.ts`: separate feature fixtures.
- Top-of-file import/type-shape coincidences across source modules remain noise.

## Completion checklist

- [x] All accepted clusters are either refactored or explicitly moved to deferred with rationale.
- [x] No helper accepts opaque option bags when named arguments or focused helpers are clearer.
- [x] Targeted tests pass after each phase.
- [x] `npm run check` passes before closing the story.
- [x] Run duplicate detection again with the audit command and update this file with remaining actionable candidates.
