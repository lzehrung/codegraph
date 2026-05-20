# Follow-up Review Analysis

Date: 2026-05-20
Branch analyzed: `complete-review-plan-items`

This file records a new review pass after the large decomposition branch. The
goal is to find follow-up opportunities to reduce surface area, simplify code,
correct behavior, and add focused regression coverage.

## Review Evidence

- `npx tsx src/cli.ts inspect ./src --limit 25`
- `npx tsx src/cli.ts hotspots ./src --limit 40 --json`
- `find src -name '*.ts' -not -path '*/dist/*' -print0 | xargs -0 wc -l | sort -nr`
- `npx tsx src/cli.ts explain src/cli.ts --json`
- `npx tsx src/cli.ts explain src/review.ts --json`
- `npx tsx src/cli.ts explain src/indexer/build-index.ts --json`
- `npx tsx src/cli.ts explain src/util/resolution.ts --json`
- `npx tsx src/cli.ts cycles --sort priority --json`
- `npx tsx src/cli.ts unresolved --json`
- Targeted `rg` searches for duplicated concurrency helpers, CLI option parsing,
  relative path formatting, barrel imports, and bounded-output patterns.

No dependency cycles were reported. The highest remaining concentration is in:

- `src/cli.ts` - 1825 lines, broad command dispatch and graph/index orchestration.
- `src/review.ts` - 1647 lines, review diff collection, indexing, summaries, risk, and assembly.
- `src/indexer/build-index.ts` - 1471 lines, index build pipeline and incremental/cache orchestration.
- `src/util/resolution.ts` - 1450 lines, mixed TS/PHP/Python/Node/general resolution plus generic concurrency.
- `src/agent/explain.ts`, `src/agent-tools.ts`, and `src/agent/search.ts` - agent-facing output, lookup, bounds, and formatting.

## Checklist

### Correctness And Behavior

- [x] Fix include-root discovery handling for `inspect --root . ./src`.
  - Finding: `npx tsx src/cli.ts inspect --root . ./src --limit 5` currently fails with a malformed gitignore root path containing mixed POSIX and Windows separators.
  - Likely area: `src/cli.ts` include-root discovery setup and `src/config.ts` discovery root normalization.
  - Also check recommended commands from `inspect`: `unresolved` and `cycles` recommendations currently omit the include-root target suffix, which can expand a scoped inspect into whole-repo follow-ups.
  - Add tests in `tests/cli-regressions.test.ts` for `inspect --root . ./src`, include-root recommendations, and config `ignoreGlobs` with include roots.

- [x] Standardize CLI numeric option parsing and validation.
  - Finding: several commands still use raw `Number(...)` for user input: `--threads`, `--symbols-detailed-max-edges`, `--max-hits`, `--max-callsites`, `--max-tests`, chunk token bounds, graph query depth, and impact options.
  - Risk: invalid values can silently become `NaN`, `0`, or undefined depending on downstream code.
  - Add shared helpers in `src/cli/options.ts` for positive integers, non-negative integers, optional integers, and bounded integers.
  - Cover invalid and boundary values in `tests/cli-regressions.test.ts`, `tests/cli-command-modules.test.ts`, and command-specific tests.

- [x] Add regression coverage for scoped cache behavior in `inspect` and `hotspots`.
  - Finding: `buildScopedReportGraph` combines disk cache reuse with include-root restriction. The flow is subtle and easy to regress.
  - Add tests proving file counts, hotspots, cycles, and unresolved summaries are scoped when include roots are passed, both with cold builds and warm disk cache.

### Decomposition And Surface Area

- [x] Extract the remaining command handlers from `src/cli.ts`.
  - Current shape: `runCliWithActiveRuntime` still owns command context creation, root/discovery resolution, changed-file resolution, graph output, index output, `dumpmod`, `goto`, `refs`, `grep`, `inspect`, and `hotspots`.
  - Target split:
    - `src/cli/context.ts` for parsed args, runtime writers, root/discovery/include-root resolution, progress setup, and shared stdin/report helpers.
    - `src/cli/graph.ts` for graph and SQLite export mode.
    - `src/cli/index.ts` for index output.
    - `src/cli/navigation.ts` for `dumpmod`, `goto`, and `refs`.
    - `src/cli/grep.ts` for AST/text grep.
    - `src/cli/inspect.ts` for inspect and hotspots.
  - Keep `src/cli.ts` as a thin dispatcher.
  - Verify with `tests/cli-regressions.test.ts`, `tests/cli-command-modules.test.ts`, and focused command tests.

- [x] Split `src/review.ts` into phase modules.
  - Current shape: review options, deleted-file reconstruction, graph delta, SQL context, candidate tests, symbol summaries, risk scoring, and final assembly live in one file.
  - Target split:
    - `src/review/changes.ts` for changed file and diff collection.
    - `src/review/deleted.ts` for deleted snapshots and deleted importer edges.
    - `src/review/summaries.ts` for changed symbol and file summaries.
    - `src/review/candidates.ts` for candidate test merging and ordering.
    - `src/review/risk.ts` for risk summary and review tasks.
    - `src/review/report.ts` for final assembly.
  - Add focused tests around deleted-file cases, missing explicit files, review presets, candidate ordering, and diagnostics.

- [x] Split `src/util/resolution.ts` into language/domain-specific modules.
  - Current shape: TS config paths, graph-only resolution, PHP Composer/class discovery, Python module resolution, Node package resolution, cache clearing, and generic `mapLimit` live together.
  - Target split:
    - `src/util/resolution/tsconfig.ts`
    - `src/util/resolution/php.ts`
    - `src/util/resolution/python.ts`
    - `src/util/resolution/node.ts`
    - Keep `src/util/resolution.ts` as a facade only.
  - Add tests for cache clearing and language-specific resolution parity after the split.

- [x] Move generic concurrency helpers out of resolution code and consolidate duplicates.
  - Finding: `src/util/resolution.ts` exports `mapLimit`, `src/review.ts` has a local `runWithConcurrency`, and `src/util/semaphore.ts` has `mapLimitSemaphore`.
  - Target: a single `src/util/concurrency.ts` with documented behavior for order preservation, invalid limits, and rejection handling.
  - Update users in `graph-builder`, `indexer/build-index`, impact modules, SQL modules, review, and agent explain.
  - Keep `tests/map-limit.test.ts`, and add rejection/concurrency-order coverage if missing.

- [x] Reduce internal dependence on broad barrels.
  - Finding: many implementation modules import from `../util.js`, `../graphs.js`, and `../indexer.js`, increasing fan-in on broad facade files and making public/internal boundaries blurry.
  - Target: implementation modules import direct leaf modules unless they are intentionally using a stable domain facade.
  - Add or extend package metadata/source-structure tests to prevent imports through the root public API and to limit broad internal barrel usage where practical.

- [ ] Audit the public root API in `src/index.ts`.
  - Finding: package exports only `"."`, while `src/index.ts` reexports a very broad surface of build, graph, impact, session, agent, MCP, SQLite, chunking, language, and utility APIs.
  - Target: classify exports as public-stable, public-legacy, or internal-only. Deprecate or move internal-only exports behind narrower subpath exports in a planned major/minor-compatible way.
  - Update `docs/library-api.md`, `README.md`, and package metadata tests when the public contract changes.

### Duplication And Shared Helpers

- [ ] Unify agent file/path/follow-up helpers.
  - Finding: `relativeFile` wrappers remain in `src/agent/search.ts`, `src/agent/explain.ts`, and `src/agent/artifact.ts`; search/explain also duplicate symbol/file target resolution patterns.
  - Target: expand `src/agent/normalize.ts` or add `src/agent/targets.ts` for file resolution, SQL-object detection, handle resolution, and common follow-up construction.
  - Verify with `tests/agent-search.test.ts`, `tests/agent-explain.test.ts`, and `tests/artifact-build.test.ts`.

- [ ] Centralize presentation bounds for CLI/review/agent output.
  - Finding: bounded-output logic is partly shared for agent APIs, but CLI/review still have hard-coded slices such as changed files, review tasks, impact pretty refs, and candidate tests.
  - Target: named constants and a small presentation-bound helper for CLI summaries, review summaries, agent changed context, and impact pretty output.
  - Add tests that assert omission/truncation behavior and avoid silently changing output volume.

- [ ] Consolidate relative path display helpers.
  - Finding: many modules directly call `path.relative(...).replace(/\\/g, "/")` or local wrappers instead of `toProjectRelativePath` or a display helper.
  - Target: use one project-relative display helper for CLI, review, graph rendering, agent output, and index/cache reporting.
  - Add path-normalization regression coverage for POSIX, Windows-style absolute paths, and out-of-root paths.

### Performance And Accuracy

- [ ] Review `buildProjectIndex` phase boundaries for cache/incremental complexity.
  - Current shape: `src/indexer/build-index.ts` still handles worker setup, parsed cache retention, file signatures, manifest snapshots, graph finalization, and incremental entry points.
  - Target split:
    - worker setup/teardown
    - parsed cache retention
    - manifest write/read orchestration
    - index finalization
    - incremental changed-file planning
  - Add focused tests around cache strictness, changed/deleted files, worker usage, and report timings.

- [ ] Improve PHP resolution maintainability and coverage.
  - Finding: PHP Composer parsing, token scanning, package symbol indexing, PSR-0/PSR-4 resolution, classmap exclusion, and implicit files are concentrated in `src/util/resolution.ts`.
  - Target: split into a PHP resolver module with fixtures for Composer `autoload`, `autoload-dev`, `files`, PSR-0, PSR-4, classmap, and `exclude-from-classmap`.
  - Add tests in `tests/languages/php.test.ts`, `tests/goto.test.ts`, and `tests/references.test.ts` for each Composer branch.

- [ ] Review unresolved-import classification for non-source artifacts.
  - Finding: whole-repo `unresolved` reports include script command names, `.cursor` plan links, graph-visualization DOM IDs, Rust crate-relative imports, and sample fixture imports.
  - Target: decide whether `unresolved` should be source-code-only by default, scope-aware by command, or classifier-aware for scripts/docs/test fixtures.
  - Add docs and tests for intentional unresolved behavior so users can trust the signal.

### Documentation

- [ ] Document the intended CLI scoping model.
  - Explain `--root`, positional include roots, config `ignoreGlobs`, `--include-glob`, `--ignore-glob`, gitignore handling, and cache reuse.
  - Update `docs/cli.md` and `codegraph-skill/codegraph/SKILL.md` if command behavior or examples change.

- [ ] Document public API boundaries before shrinking exports.
  - Add a short public/internal API section to `docs/library-api.md`.
  - Note which barrels are stable entry points and which modules are implementation details.

## Suggested Order

1. Fix the scoped `inspect --root . ./src` behavior and add regression tests.
2. Centralize CLI numeric parsing because it reduces future command-handler churn.
3. Extract CLI context/inspect/hotspots/graph handlers.
4. Move concurrency helpers to a neutral utility module.
5. Split `util/resolution.ts`, starting with PHP because it is the largest isolated domain.
6. Split `review.ts` by pipeline phase.
7. Reduce internal barrel imports and audit the public API surface.
